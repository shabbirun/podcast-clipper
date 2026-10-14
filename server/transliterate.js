// Transliterate caption cues into Latin (Roman) script with the Claude CLI.
// Timing is untouched; only the text of each cue changes.
import { askClaude } from "./claude.js";

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "Index of the input line" },
          text: { type: "string", description: "The line written in Latin script" },
        },
        required: ["i", "text"],
      },
    },
  },
  required: ["lines"],
};

export async function transliterateCues(cues, { log } = {}) {
  if (!cues.length) return cues;
  const numbered = cues.map((c, i) => `${i}\t${c.text}`).join("\n");
  const prompt = `These are caption lines from a podcast clip. Some words may be in a non-Latin script (e.g. Urdu, Hindi, Arabic, Punjabi, Bengali) or mixed with English.

Transliterate every line into English (Latin) letters, the way people naturally write the language in Roman script on social media (e.g. Roman Urdu / Hinglish).

Rules:
- Transliterate, do NOT translate. Keep the original words and meaning; only change the script.
- Leave words that are already in Latin script exactly as they are.
- If a word is clearly an English word written in another script, write it in normal English spelling.
- If a line is in Hindi or Gujarati (Devanagari or Gujarati script), transliterate it into English letters with a flavor of Lisan ud Dawat: use the Roman spellings the Dawoodi Bohra community naturally uses (e.g. for Arabic/Persian-origin words and honorifics), while staying as accurate as possible to exactly what was said. Do not substitute different words.
- Keep punctuation. Do not merge, split, add, or drop lines.
- Return exactly one entry per input line, with the same index i.

Lines (index<TAB>text):
${numbered}`;

  log?.(`Transliterating ${cues.length} cues with Claude…`);
  const data = await askClaude(prompt, SCHEMA, { log });
  const byIndex = new Map(data.lines.map((l) => [l.i, String(l.text ?? "").trim()]));

  return cues.map((c, i) => {
    const text = byIndex.get(i);
    if (!text || text === c.text) return c;
    const { words, ...rest } = c;
    // Keep per-word timings when the word count survived, relabelled with the new words.
    const tokens = text.split(/\s+/);
    if (words && words.length === tokens.length) {
      return { ...rest, text, words: words.map((w, j) => ({ ...w, text: tokens[j] })) };
    }
    return { ...rest, text };
  });
}
