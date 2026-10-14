// Fetch a timestamped transcript for a YouTube video with yt-dlp (json3
// captions carry per-word offsets for auto-generated tracks), or fall back to
// local Whisper transcription via `hyperframes transcribe`.
import fs from "node:fs";
import path from "node:path";
import { run } from "./jobs.js";
import { TRANSCRIPTS_DIR, DOWNLOADS_DIR, readJSON, writeJSON } from "./db.js";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Node is always present, so let yt-dlp use it for YouTube's JS challenges.
const YT = (args) => ["--no-update", "--js-runtimes", "node", ...args];

export function transcriptPath(videoId) {
  return path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
}

export function loadTranscript(videoId) {
  return readJSON(transcriptPath(videoId));
}

/** List the caption tracks YouTube offers for a video. */
export async function listCaptionTracks(url, log) {
  const { stdout } = await run(YTDLP, YT(["-J", "--skip-download", "--no-warnings", url]), { log: null });
  const info = JSON.parse(stdout);
  return {
    language: info.language || null,
    manual: Object.keys(info.subtitles || {}).filter((k) => k !== "live_chat"),
    auto: Object.keys(info.automatic_captions || {}),
  };
}

function pickTrack(tracks, preferred) {
  const base = (l) => l.split("-")[0].toLowerCase();
  const pref = (preferred || tracks.language || "en").toLowerCase();
  const manualHit = tracks.manual.find((l) => l.toLowerCase() === pref) ||
    tracks.manual.find((l) => base(l) === base(pref));
  if (manualHit) return { lang: manualHit, auto: false };
  const autoOrig = tracks.auto.find((l) => l.toLowerCase() === `${base(pref)}-orig`);
  if (autoOrig) return { lang: autoOrig, auto: true };
  const autoHit = tracks.auto.find((l) => l.toLowerCase() === pref) ||
    tracks.auto.find((l) => base(l) === base(pref) && !l.includes("-", 3));
  if (autoHit) return { lang: autoHit, auto: true };
  // Nothing in the preferred language: take the original-language auto track.
  const anyOrig = tracks.auto.find((l) => l.endsWith("-orig"));
  if (anyOrig) return { lang: anyOrig, auto: true };
  if (tracks.manual[0]) return { lang: tracks.manual[0], auto: false };
  return null;
}

function parseJson3(json) {
  const words = [];
  for (const ev of json.events || []) {
    if (!ev.segs) continue;
    const evStart = (ev.tStartMs || 0) / 1000;
    const evEnd = evStart + (ev.dDurationMs || 0) / 1000;
    const segs = ev.segs.filter((s) => s.utf8 && s.utf8.trim());
    if (!segs.length) continue;
    const hasOffsets = segs.length > 1 || segs[0].tOffsetMs != null;
    if (hasOffsets) {
      segs.forEach((s, i) => {
        const start = evStart + (s.tOffsetMs || 0) / 1000;
        const next = segs[i + 1];
        const end = next ? evStart + (next.tOffsetMs || 0) / 1000 : Math.min(evEnd, start + 1.2);
        for (const w of s.utf8.trim().split(/\s+/)) words.push({ start, end, text: w });
      });
    } else {
      // Manual caption line: spread words across the cue by character length.
      const tokens = segs.map((s) => s.utf8).join(" ").replace(/\s+/g, " ").trim().split(" ");
      const total = tokens.reduce((n, t) => n + t.length + 1, 0);
      let t = evStart;
      for (const tok of tokens) {
        const d = ((evEnd - evStart) * (tok.length + 1)) / total;
        words.push({ start: t, end: t + d, text: tok });
        t += d;
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  // Fix overlaps / zero-length words and drop bracketed sound cues like [Music].
  const clean = words.filter((w) => !/^\[.*\]$/.test(w.text));
  for (let i = 0; i < clean.length; i++) {
    const next = clean[i + 1];
    if (next && clean[i].end > next.start) clean[i].end = next.start;
    if (clean[i].end <= clean[i].start) clean[i].end = clean[i].start + 0.2;
  }
  return clean.map((w) => ({ start: round(w.start), end: round(w.end), text: w.text }));
}

const round = (n) => Math.round(n * 1000) / 1000;

/** Group words into readable segments (used for the transcript view + Claude prompt). */
export function segmentWords(words) {
  const segments = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? w.start - cur.end : 0;
    if (!cur || gap > 1.2 || cur.words >= 22 || (/[.?!]$/.test(cur.text) && cur.words >= 6)) {
      if (cur) segments.push(cur);
      cur = { start: w.start, end: w.end, text: w.text, words: 1 };
    } else {
      cur.end = w.end;
      cur.text += " " + w.text;
      cur.words++;
    }
  }
  if (cur) segments.push(cur);
  return segments.map(({ words, ...s }) => s);
}

export async function fetchYoutubeTranscript(video, { lang, log }) {
  log(`Listing caption tracks for ${video.url}`);
  const tracks = await listCaptionTracks(video.url);
  log(`Manual: ${tracks.manual.join(", ") || "none"} | Auto: ${tracks.auto.length} tracks | Video language: ${tracks.language || "unknown"}`);
  const pick = pickTrack(tracks, lang || video.language);
  if (!pick) throw new Error("No captions available on YouTube. Try the Whisper option.");
  log(`Using ${pick.auto ? "auto-generated" : "manual"} track: ${pick.lang}`);

  const outBase = path.join(TRANSCRIPTS_DIR, `${video.id}.raw`);
  for (const f of fs.readdirSync(TRANSCRIPTS_DIR)) {
    if (f.startsWith(`${video.id}.raw`)) fs.rmSync(path.join(TRANSCRIPTS_DIR, f));
  }
  await run(
    YTDLP,
    YT([
      "--skip-download",
      pick.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", pick.lang,
      "--sub-format", "json3",
      "-o", outBase + ".%(ext)s",
      video.url,
    ]),
    { log },
  );
  const file = fs.readdirSync(TRANSCRIPTS_DIR).find((f) => f.startsWith(`${video.id}.raw`) && f.endsWith(".json3"));
  if (!file) throw new Error("yt-dlp did not produce a caption file");
  const words = parseJson3(readJSON(path.join(TRANSCRIPTS_DIR, file)));
  if (!words.length) throw new Error("Caption track was empty");
  return save(video.id, {
    source: pick.auto ? "youtube-auto" : "youtube-manual",
    lang: pick.lang,
    availableLangs: { manual: tracks.manual, auto: tracks.auto.filter((l) => l.endsWith("-orig") || !l.includes("-")) },
    words,
  });
}

/** Whisper fallback: download audio and transcribe locally. */
export async function fetchWhisperTranscript(video, { lang, model, log }) {
  const audio = path.join(DOWNLOADS_DIR, `${video.id}.audio.m4a`);
  if (!fs.existsSync(audio)) {
    log("Downloading audio…");
    await run(YTDLP, YT(["-f", "bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a", "-o", audio, video.url]), { log });
  }
  const words = await whisperWords(audio, { lang, model, log });
  return save(video.id, { source: "whisper", lang: lang || "auto", words });
}

/** Run `hyperframes transcribe` on a media file and return [{start,end,text}]. */
export async function whisperWords(file, { lang, model, log, cwd }) {
  const tmpDir = cwd || fs.mkdtempSync(path.join(DOWNLOADS_DIR, "whisper-"));
  const args = ["--yes", "hyperframes", "transcribe", file, "--dir", tmpDir, "--json"];
  if (lang) args.push("--language", lang.split("-")[0]);
  const isEnglish = !lang || lang.startsWith("en");
  args.push("--model", model || process.env.WHISPER_MODEL || (isEnglish ? "small.en" : "large-v3"));
  log?.(`Transcribing with Whisper (${args.slice(-1)[0]})… this can take a while`);
  const { stdout } = await run("npx", args, { log, cwd: tmpDir });
  return normalizeWhisperOutput(stdout, tmpDir);
}

function normalizeWhisperOutput(stdout, dir) {
  let data = null;
  try {
    data = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {}
  // The CLI writes transcript.json into the project dir; prefer that.
  const candidates = [path.join(dir, "transcript.json"), data?.transcriptPath, data?.output, data?.path]
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? p : path.join(dir, p)));
  for (const c of candidates) {
    const t = readJSON(c);
    if (t) {
      data = t;
      break;
    }
  }
  const arr = Array.isArray(data) ? data : data?.words || data?.transcript?.words || data?.segments || [];
  const words = [];
  for (const w of arr) {
    const text = (w.text ?? w.word ?? "").trim();
    if (!text) continue;
    words.push({ start: round(Number(w.start)), end: round(Number(w.end)), text });
  }
  if (!words.length) throw new Error("Whisper returned no words");
  return words;
}

function save(videoId, t) {
  const transcript = {
    videoId,
    fetchedAt: new Date().toISOString(),
    ...t,
    segments: segmentWords(t.words),
  };
  writeJSON(transcriptPath(videoId), transcript);
  return transcript;
}
