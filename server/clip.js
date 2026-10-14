// Clip pipeline: download source → ffmpeg cut → scaffold HyperFrames project
// → caption data. Also handles caption edits, Whisper re-transcription, render.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run } from "./jobs.js";
import { db, DATA_DIR, DOWNLOADS_DIR, CLIPS_DIR, RENDERS_DIR, readJSON, writeJSON } from "./db.js";
import { loadTranscript, whisperWords } from "./transcript.js";
import {
  defaultSettings,
  wordsToCues,
  cuesToSrt,
  clipDataJs,
  indexHtml,
} from "./composition.js";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Node is always present, so let yt-dlp use it for YouTube's JS challenges.
const YT = (args) => ["--no-update", "--js-runtimes", "node", ...args];
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const TEMPLATE_DIR = path.join(DATA_DIR, ".hf-template");

export const clipDir = (id) => path.join(CLIPS_DIR, id);
const clipJsonPath = (id) => path.join(clipDir(id), "clip.json");

export function loadClipData(id) {
  return readJSON(clipJsonPath(id));
}

/** Download the full source video once (cached), or just the needed section. */
async function ensureSource(video, clip, log) {
  const full = path.join(DOWNLOADS_DIR, `${video.id}.mp4`);
  if (fs.existsSync(full)) {
    log("Using cached source video");
    return { file: full, offset: 0 };
  }
  const format = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b";
  if ((process.env.DOWNLOAD_MODE || "full") === "section") {
    // Grab only the clip window (plus padding) — much faster for long episodes.
    const pad = 5;
    const from = Math.max(0, clip.start - pad);
    const to = clip.end + pad;
    const out = path.join(DOWNLOADS_DIR, `${video.id}.${Math.floor(from)}-${Math.ceil(to)}.mp4`);
    if (!fs.existsSync(out)) {
      log(`Downloading section ${from.toFixed(1)}s–${to.toFixed(1)}s…`);
      await run(YTDLP, YT(["-f", format, "--merge-output-format", "mp4", "--download-sections", `*${from}-${to}`, "--force-keyframes-at-cuts", "-o", out, video.url]), { log });
    }
    return { file: out, offset: from };
  }
  log("Downloading full source video (cached for future clips)…");
  await run(YTDLP, YT(["-f", format, "--merge-output-format", "mp4", "--newline", "-o", full, video.url]), { log });
  return { file: full, offset: 0 };
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ]);
  const j = JSON.parse(stdout);
  return {
    width: j.streams?.[0]?.width || 1920,
    height: j.streams?.[0]?.height || 1080,
    duration: Number(j.format?.duration) || 0,
  };
}

/** Create HyperFrames project scaffolding once via `hyperframes init`, then copy. */
async function ensureTemplate(log) {
  if (fs.existsSync(path.join(TEMPLATE_DIR, "hyperframes.json"))) return;
  log("Scaffolding HyperFrames template (one-time)…");
  fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  await run("npx", ["--yes", "hyperframes", "init", path.basename(TEMPLATE_DIR), "--non-interactive", "--example", "blank", "--resolution", "portrait"], {
    cwd: DATA_DIR,
    log,
  });
}

function scaffoldProject(id, log) {
  const dir = clipDir(id);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const f of fs.readdirSync(TEMPLATE_DIR)) {
    if (f === "index.html" || f === "node_modules") continue;
    fs.cpSync(path.join(TEMPLATE_DIR, f), path.join(dir, f), { recursive: true });
  }
  const pkgPath = path.join(dir, "package.json");
  const pkg = readJSON(pkgPath, {});
  pkg.name = id;
  writeJSON(pkgPath, pkg);
  const metaPath = path.join(dir, "meta.json");
  writeJSON(metaPath, { ...readJSON(metaPath, {}), id, name: id, createdAt: new Date().toISOString() });
  log(`Project created at ${dir}`);
}

/** Write clip-data.js + captions.srt from clip.json. */
export function writeClipOutputs(clip, data) {
  const dir = clipDir(clip.id);
  writeJSON(clipJsonPath(clip.id), data);
  fs.writeFileSync(path.join(dir, "clip-data.js"), clipDataJs(clip, data));
  fs.writeFileSync(path.join(dir, "captions.srt"), cuesToSrt(data.cues));
}

function clipWords(videoId, start, end) {
  const t = loadTranscript(videoId);
  if (!t) return [];
  return t.words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({
      start: Math.max(0, w.start - start),
      end: Math.min(end - start, w.end - start),
      text: w.text,
    }));
}

export async function buildClip({ clipId, video, log }) {
  const clip = db.get("clips", clipId);
  const { file, offset } = await ensureSource(video, clip, log);
  const dir = clipDir(clip.id);
  await ensureTemplate(log);
  scaffoldProject(clip.id, log);

  const out = path.join(dir, "assets", "clip.mp4");
  const ss = (clip.start - offset).toFixed(3);
  log(`Cutting ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s with ffmpeg…`);
  await run(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    "-ss", ss, "-i", file, "-t", clip.duration.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    out,
  ], { log });

  // Low-res copy for the blurred background fill (cheap to decode and blur).
  await run(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", out,
    "-vf", "scale=-2:360", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    path.join(dir, "assets", "clip-bg.mp4"),
  ], { log });

  const source = await probe(out);
  const duration = Math.min(clip.duration, source.duration || clip.duration);
  db.update("clips", clip.id, { duration });
  clip.duration = duration;

  const settings = defaultSettings({ hook: clip.hook });
  const words = clipWords(video.id, clip.start, clip.end);
  const cues = wordsToCues(words, settings.captions.maxWordsPerCue);
  log(`Built ${cues.length} caption cues from ${words.length} transcript words`);

  const data = { source: { width: source.width, height: source.height }, settings, cues, words };
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml(clip));
  writeClipOutputs(clip, data);

  try {
    const { stdout } = await run("npm", ["run", "--silent", "check", "--", "--json"], { cwd: dir });
    const res = JSON.parse(stdout.slice(stdout.indexOf("{")));
    log(`hyperframes check: ${res.ok === false ? "findings reported" : "ok"}`);
  } catch (e) {
    log(`hyperframes check reported issues (non-fatal): ${e.message.split("\n").slice(-3).join(" ")}`);
  }
}

/** Save edited settings and cues from the app. */
export function saveClipEdits(clip, { settings, cues }) {
  const data = loadClipData(clip.id);
  if (!data) throw new Error("Clip project not built yet");
  if (settings) data.settings = { ...data.settings, ...settings, captions: { ...data.settings.captions, ...settings.captions }, hook: { ...data.settings.hook, ...settings.hook } };
  if (cues) {
    data.cues = cues
      .map((c) => ({
        start: Number(c.start),
        end: Number(c.end),
        text: String(c.text || "").trim(),
        ...(c.words ? { words: c.words } : {}),
      }))
      .filter((c) => c.text && c.end > c.start)
      .sort((a, b) => a.start - b.start);
  }
  writeClipOutputs(clip, data);
  return data;
}

/** Rebuild cues from stored words (e.g. after changing max words per cue). */
export function regroupCues(clip, maxWords) {
  const data = loadClipData(clip.id);
  data.settings.captions.maxWordsPerCue = maxWords;
  data.cues = wordsToCues(data.words || [], maxWords);
  writeClipOutputs(clip, data);
  return data;
}

export async function retranscribeClip({ clip, lang, model, log }) {
  const dir = clipDir(clip.id);
  const work = path.join(dir, ".transcribe");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const words = await whisperWords(path.join(dir, "assets", "clip.mp4"), { lang, model, log, cwd: work });
  fs.rmSync(work, { recursive: true, force: true });
  const data = loadClipData(clip.id);
  data.words = words;
  data.cues = wordsToCues(words, data.settings.captions.maxWordsPerCue || 4);
  writeClipOutputs(clip, data);
  log(`Rebuilt ${data.cues.length} cues from Whisper`);
}

export async function renderClip({ clip, quality, log }) {
  const dir = clipDir(clip.id);
  const safe = clip.title.replace(/[^\w-]+/g, "_").slice(0, 50);
  const file = path.join(RENDERS_DIR, `${safe}_${clip.id.slice(-6)}_${Date.now()}.mp4`);
  await run("npm", ["run", "render", "--", "--quality", quality || "high", "--output", file], { cwd: dir, log });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error("Render produced no file");
  const renders = [...(db.get("clips", clip.id).renders || []), { file: path.basename(file), quality, at: new Date().toISOString() }];
  db.update("clips", clip.id, { renders });
  log(`Rendered → ${file}`);
}

export function newClipRecord({ video, suggestion, start, end, title, hook }) {
  const id = `clip-${video.id}-${crypto.randomBytes(3).toString("hex")}`;
  return {
    id,
    videoId: video.id,
    suggestionId: suggestion?.id || null,
    title: title || suggestion?.title || "Untitled clip",
    hook: hook ?? suggestion?.hook ?? "",
    start,
    end,
    duration: Math.round((end - start) * 1000) / 1000,
    status: "building",
    createdAt: new Date().toISOString(),
    renders: [],
  };
}
