// Ask the Claude Code CLI (headless, no tools) to pick viral clip moments
// from a timestamped transcript. Returns clips snapped to word boundaries.
import { askClaude } from "./claude.js";

const SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short punchy title for the clip (max ~8 words)" },
          hook: { type: "string", description: "On-screen hook text shown in the first seconds (max ~10 words)" },
          start: { type: "number", description: "Start time in seconds" },
          end: { type: "number", description: "End time in seconds" },
          reason: { type: "string", description: "Why this will perform well as a short" },
          score: { type: "number", description: "Virality score 1-10" },
        },
        required: ["title", "hook", "start", "end", "reason", "score"],
      },
    },
  },
  required: ["clips"],
};

const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

function buildPrompt(video, transcript, { count, minSeconds, maxSeconds, guidance }) {
  const lines = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)} | ${fmt(s.start)}] ${s.text}`)
    .join("\n");
  return `You are an expert short-form video editor for podcasts (TikTok, YouTube Shorts, Instagram Reels).

Podcast episode: "${video.title}"

Pick the ${count} most engaging, shareable moments from the transcript below to cut as standalone vertical shorts.

Rules:
- Each clip must be between ${minSeconds} and ${maxSeconds} seconds long. Never exceed ${maxSeconds} seconds.
- A clip must make sense on its own with no prior context. Start at the beginning of a thought, ideally on a strong hook line in the first 3 seconds (a bold claim, question, surprising fact, emotional beat, or conflict).
- End on a satisfying payoff, punchline, or natural sentence end — never mid-sentence.
- Use the numeric second timestamps in brackets. start should be the start of the first line you include; end should be the end of the last line you include.
- Clips must not overlap. Prefer variety of topics.
- The transcript may contain auto-caption errors or mixed languages; judge meaning, not spelling.
- "hook" is on-screen text for the first seconds; write it in the language of the clip.
${guidance ? `\nExtra direction from the creator: ${guidance}\n` : ""}
Transcript (each line: [startSec-endSec | mm:ss] text):
${lines}`;
}

export async function suggestClips(video, transcript, opts, log) {
  const count = Math.max(1, Math.min(20, Number(opts.count) || 5));
  const maxSeconds = Math.min(120, Number(opts.maxSeconds) || 90);
  const minSeconds = Math.min(maxSeconds - 5, Number(opts.minSeconds) || 30);
  const prompt = buildPrompt(video, transcript, { count, minSeconds, maxSeconds, guidance: opts.guidance });

  log(`Asking Claude for ${count} clips (${minSeconds}-${maxSeconds}s) from ${transcript.segments.length} transcript lines…`);
  const data = await askClaude(prompt, SCHEMA, { model: opts.model, log });
  if (!data?.clips) throw new Error("Claude did not return clips");

  return data.clips
    .map((c) => snapToWords(c, transcript.words, maxSeconds))
    .filter((c) => c.end - c.start >= 5)
    .sort((a, b) => a.start - b.start);
}

/** Snap clip boundaries to actual word starts/ends and enforce the max length. */
function snapToWords(clip, words, maxSeconds) {
  let start = Number(clip.start);
  let end = Number(clip.end);
  const first = words.find((w) => w.end > start) || words[0];
  start = Math.max(0, first.start - 0.15);
  let last = [...words].reverse().find((w) => w.start < end) || words[words.length - 1];
  end = last.end + 0.35;
  if (end - start > maxSeconds) {
    // Trim to the last sentence-ish word boundary inside the limit.
    const inRange = words.filter((w) => w.start >= start && w.end <= start + maxSeconds);
    last = [...inRange].reverse().find((w) => /[.?!]$/.test(w.text)) || inRange[inRange.length - 1];
    end = Math.min(start + maxSeconds, last.end + 0.35);
  }
  return {
    ...clip,
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
  };
}
