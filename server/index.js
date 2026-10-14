import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import { db, ROOT, RENDERS_DIR } from "./db.js";

dotenv.config({ path: path.join(ROOT, ".env.local") });
dotenv.config({ path: path.join(ROOT, ".env") });

const { resolveInput } = await import("./youtube.js");
const { fetchYoutubeTranscript, fetchWhisperTranscript, loadTranscript, listCaptionTracks } = await import("./transcript.js");
const { suggestClips } = await import("./suggest.js");
const { transliterateCues } = await import("./transliterate.js");
const { runEditCommand } = await import("./agent.js");
const clipLib = await import("./clip.js");
const { CAPTION_STYLES, srtToCues } = await import("./composition.js");
const { createJob, getJob, activeJob, listJobs, summary } = await import("./jobs.js");
const { startStudio, stopStudio, studioStatus } = await import("./studio.js");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/renders", express.static(RENDERS_DIR));
app.use("/clip-assets/:id", (req, res, next) =>
  express.static(path.join(clipLib.clipDir(req.params.id), "assets"))(req, res, next),
);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });

// ---------- Videos ----------
app.get("/api/videos", (req, res) => {
  const videos = [...db.all("videos")].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  res.json(
    videos.map((v) => ({
      ...v,
      hasTranscript: Boolean(loadTranscript(v.id)),
      suggestionCount: db.where("suggestions", (s) => s.videoId === v.id).length,
      clipCount: db.where("clips", (c) => c.videoId === v.id).length,
    })),
  );
});

// Long-form only: anything at or under this length is treated as a Short.
const MIN_VIDEO_SECONDS = Number(process.env.MIN_VIDEO_SECONDS || 180);
const isLongForm = (v) => !v.duration || v.duration > MIN_VIDEO_SECONDS; // unknown length: keep

app.post("/api/videos", wrap(async (req, res) => {
  const found = await resolveInput(req.body.input || "", { max: Math.min(1000, Number(req.body.max) || 500) });
  const longForm = found.filter(isLongForm);
  const added = longForm.map((v) => db.upsert("videos", { ...v, addedAt: db.get("videos", v.id)?.addedAt || new Date().toISOString() }));
  res.json({ added: added.length, skippedShorts: found.length - longForm.length });
}));

app.delete("/api/videos/:id", (req, res) => {
  db.remove("videos", (v) => v.id === req.params.id);
  db.remove("suggestions", (s) => s.videoId === req.params.id);
  res.json({ ok: true });
});

app.get("/api/videos/:id", (req, res) => {
  const video = db.get("videos", req.params.id);
  if (!video) return notFound(res, "Video");
  const transcript = loadTranscript(video.id);
  res.json({
    video,
    transcript: transcript && {
      source: transcript.source,
      lang: transcript.lang,
      availableLangs: transcript.availableLangs,
      fetchedAt: transcript.fetchedAt,
      wordCount: transcript.words.length,
      segments: transcript.segments,
    },
    suggestions: db.where("suggestions", (s) => s.videoId === video.id).sort((a, b) => a.start - b.start),
    clips: db.where("clips", (c) => c.videoId === video.id),
    jobs: listJobs((j) => j.ref.videoId === video.id),
  });
});

app.get("/api/videos/:id/caption-tracks", wrap(async (req, res) => {
  const video = db.get("videos", req.params.id);
  if (!video) return notFound(res, "Video");
  res.json(await listCaptionTracks(video.url));
}));

app.post("/api/videos/:id/transcript", (req, res) => {
  const video = db.get("videos", req.params.id);
  if (!video) return notFound(res, "Video");
  const existing = activeJob("transcript", (r) => r.videoId === video.id);
  if (existing) return res.json(summary(existing));
  const { method = "youtube", lang, model } = req.body || {};
  const job = createJob("transcript", { videoId: video.id }, (log) =>
    method === "whisper"
      ? fetchWhisperTranscript(video, { lang, model, log })
      : fetchYoutubeTranscript(video, { lang, log }),
  );
  res.json(summary(job));
});

app.post("/api/videos/:id/suggest", (req, res) => {
  const video = db.get("videos", req.params.id);
  if (!video) return notFound(res, "Video");
  const transcript = loadTranscript(video.id);
  if (!transcript) return res.status(400).json({ error: "Fetch the transcript first" });
  const existing = activeJob("suggest", (r) => r.videoId === video.id);
  if (existing) return res.json(summary(existing));
  const opts = req.body || {};
  const job = createJob("suggest", { videoId: video.id }, async (log) => {
    const clips = await suggestClips(video, transcript, opts, log);
    if (opts.replace) db.remove("suggestions", (s) => s.videoId === video.id);
    const batch = new Date().toISOString();
    for (const c of clips) {
      db.insert("suggestions", { id: crypto.randomUUID(), videoId: video.id, batch, ...c });
    }
    log(`Saved ${clips.length} suggestions`);
  });
  res.json(summary(job));
});

app.delete("/api/suggestions/:id", (req, res) => {
  db.remove("suggestions", (s) => s.id === req.params.id);
  res.json({ ok: true });
});

// ---------- Clips ----------
app.post("/api/clips", (req, res) => {
  const { suggestionId, videoId } = req.body;
  const suggestion = suggestionId ? db.get("suggestions", suggestionId) : null;
  const video = db.get("videos", suggestion?.videoId || videoId);
  if (!video) return notFound(res, "Video");
  const start = Number(req.body.start ?? suggestion?.start);
  const end = Number(req.body.end ?? suggestion?.end);
  if (!(end > start)) return res.status(400).json({ error: "Invalid start/end" });
  if (end - start > 180) return res.status(400).json({ error: "Clips are limited to 3 minutes" });
  const clip = db.insert("clips", clipLib.newClipRecord({ video, suggestion, start, end, title: req.body.title, hook: req.body.hook }));
  res.json({ clip, job: summary(startBuild(clip, video)) });
});

function startBuild(clip, video) {
  db.update("clips", clip.id, { status: "building", error: null });
  return createJob("build", { clipId: clip.id, videoId: video.id }, async (log) => {
    try {
      await clipLib.buildClip({ clipId: clip.id, video, log });
      db.update("clips", clip.id, { status: "ready" });
    } catch (e) {
      db.update("clips", clip.id, { status: "error", error: e.message });
      throw e;
    }
  });
}

app.post("/api/clips/:id/rebuild", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const video = db.get("videos", clip.videoId);
  if (!video) return notFound(res, "Video");
  const existing = activeJob("build", (r) => r.clipId === clip.id);
  res.json(summary(existing || startBuild(clip, video)));
});

app.get("/api/clips/:id", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const data = clipLib.loadClipData(clip.id);
  res.json({
    clip,
    video: db.get("videos", clip.videoId),
    data: data && { source: data.source, settings: data.settings, cues: data.cues, hasWords: Boolean(data.words?.length) },
    captionStyles: CAPTION_STYLES,
    projectDir: clipLib.clipDir(clip.id),
    jobs: listJobs((j) => j.ref.clipId === clip.id),
    studio: studioStatus(),
  });
});

app.put("/api/clips/:id", wrap(async (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  if (req.body.title) db.update("clips", clip.id, { title: req.body.title });
  let cues = req.body.cues;
  if (typeof req.body.srt === "string") cues = srtToCues(req.body.srt);
  const data = clipLib.saveClipEdits(clip, { settings: req.body.settings, cues });
  res.json({ settings: data.settings, cues: data.cues });
}));

app.post("/api/clips/:id/command", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Type an edit command" });
  if (activeJob("command", (r) => r.clipId === clip.id)) return res.status(409).json({ error: "An edit command is already running for this clip" });
  const job = createJob("command", { clipId: clip.id, videoId: clip.videoId }, (log, job) =>
    runEditCommand({ clip: db.get("clips", clip.id), prompt, log, job }),
  );
  res.json(summary(job));
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return notFound(res, "Job");
  job.cancel?.();
  res.json({ ok: true });
});

app.post("/api/clips/:id/command/reset", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  db.update("clips", clip.id, { agentSessionId: null });
  res.json({ ok: true });
});

// Returns transliterated cues without saving, so they can be reviewed first.
app.post("/api/clips/:id/transliterate", wrap(async (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const cues = Array.isArray(req.body.cues) ? req.body.cues : clipLib.loadClipData(clip.id)?.cues || [];
  res.json({ cues: await transliterateCues(cues) });
}));

app.post("/api/clips/:id/regroup", wrap(async (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const data = clipLib.regroupCues(clip, Math.max(1, Math.min(12, Number(req.body.maxWords) || 4)));
  res.json({ settings: data.settings, cues: data.cues });
}));

app.post("/api/clips/:id/retranscribe", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const job = createJob("retranscribe", { clipId: clip.id, videoId: clip.videoId }, (log) =>
    clipLib.retranscribeClip({ clip, lang: req.body.lang, model: req.body.model, log }),
  );
  res.json(summary(job));
});

app.post("/api/clips/:id/render", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const existing = activeJob("render", (r) => r.clipId === clip.id);
  if (existing) return res.json(summary(existing));
  const job = createJob("render", { clipId: clip.id, videoId: clip.videoId }, (log) =>
    clipLib.renderClip({ clip, quality: req.body.quality, log }),
  );
  res.json(summary(job));
});

app.delete("/api/clips/:id", wrap(async (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  if (studioStatus().clipId === clip.id) await stopStudio();
  fs.rmSync(clipLib.clipDir(clip.id), { recursive: true, force: true });
  db.remove("clips", (c) => c.id === clip.id);
  res.json({ ok: true });
}));

// ---------- Planner ----------
app.get("/api/planner", (req, res) => {
  const videos = new Map(db.all("videos").map((v) => [v.id, v]));
  res.json(
    db.all("clips").map((c) => {
      const v = videos.get(c.videoId);
      return { ...c, video: v ? { id: v.id, title: v.title, thumbnail: v.thumbnail } : null };
    }),
  );
});

// scheduledFor is a local calendar day ("YYYY-MM-DD"), or null to unschedule.
app.put("/api/clips/:id/schedule", (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  const patch = {};
  if ("scheduledFor" in req.body) {
    const d = req.body.scheduledFor;
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: "scheduledFor must be YYYY-MM-DD or null" });
    patch.scheduledFor = d;
  }
  if ("posted" in req.body) patch.postedAt = req.body.posted ? clip.postedAt || new Date().toISOString() : null;
  res.json(db.update("clips", clip.id, patch));
});

app.post("/api/clips/:id/studio", wrap(async (req, res) => {
  const clip = db.get("clips", req.params.id);
  if (!clip) return notFound(res, "Clip");
  res.json(await startStudio(clip.id));
}));

app.delete("/api/studio", wrap(async (req, res) => {
  await stopStudio();
  res.json({ ok: true });
}));

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return notFound(res, "Job");
  res.json({ ...summary(job), log: job.log });
});

const PORT = Number(process.env.PORT || 4400);
app.listen(PORT, () => {
  console.log(`Podcast Clipper → http://localhost:${PORT}`);
});
