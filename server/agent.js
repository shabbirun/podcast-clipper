// Free-text edit commands for a clip's HyperFrames project, carried out by the
// Claude Code CLI running inside the project directory with the HyperFrames
// skills. One Claude session per clip, so follow-up commands keep context.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { clipDir, loadClipData, writeClipOutputs } from "./clip.js";

const CLAUDE = process.env.CLAUDE_PATH || "claude";

const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill",
  "Bash(npx hyperframes:*)", "Bash(npx --yes hyperframes:*)",
  "Bash(npm run check:*)", "Bash(npm run --silent check:*)",
  "Bash(ffprobe:*)", "Bash(ffmpeg:*)", "Bash(ls:*)", "Bash(cat:*)",
];

const SYSTEM = `You are editing a HyperFrames short-form video project (a vertical 1080x1920 podcast clip) in the current directory, on behalf of the creator using the Podcast Clipper app.

Project layout:
- index.html — the composition. Put visual/motion/design changes here. Follow the HyperFrames skills (/hyperframes-core, /hyperframes-animation, /media-use) for the composition contract.
- clip.json — the app's source of truth for caption cues ("cues": [{start,end,text,words?}]), layout, caption style and hook text ("settings"). Edit THIS file for caption wording/timing, caption style, hook text, or crop/fit layout changes. If you change a cue's text, delete its "words" array unless the word count is unchanged.
- clip-data.js and captions.srt are GENERATED from clip.json by the app after you finish. Never edit them directly.
- assets/clip.mp4 is the footage (with audio); assets/clip-bg.mp4 is a low-res copy for the blurred fill. Do not re-encode or replace them unless explicitly asked.

Rules:
- Keep the root data-duration, the <video>/<audio> elements, and the window.CLIP_DATA-driven caption/hook code working.
- After editing index.html, run \`npx hyperframes lint\` and fix any errors you introduced.
- Lint does not catch invisible or mis-placed elements. After any visual change, run \`npx hyperframes snapshot --at <t1>,<t2>\` at times where the change should be visible, then Read the PNGs in snapshots/ and confirm it actually looks right. Iterate until it does.
- Do not render. Do not start a preview server (one is already running and hot-reloads).
- Finish with a one or two sentence summary of what you changed.`;

/** Turn one stream-json event into readable log lines. */
function describe(ev) {
  if (ev.type === "assistant") {
    const out = [];
    for (const c of ev.message?.content || []) {
      if (c.type === "text" && c.text.trim()) out.push(c.text.trim());
      if (c.type === "tool_use") {
        const i = c.input || {};
        const arg = i.command || i.file_path || i.pattern || i.skill || i.path || "";
        out.push(`→ ${c.name}${arg ? ` ${String(arg).split("\n")[0].slice(0, 160)}` : ""}`);
      }
    }
    return out;
  }
  if (ev.type === "result") {
    const cost = ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(4)}` : "";
    return [`— ${ev.is_error ? "failed" : "done"} in ${Math.round((ev.duration_ms || 0) / 1000)}s${cost}`];
  }
  return [];
}

export function runEditCommand({ clip, prompt, log, job }) {
  const fresh = !clip.agentSessionId;
  const sessionId = clip.agentSessionId || crypto.randomUUID();
  const before = JSON.stringify(loadClipData(clip.id));

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--append-system-prompt", SYSTEM,
    ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
  ];
  if (process.env.CLAUDE_EDIT_MODEL) args.push("--model", process.env.CLAUDE_EDIT_MODEL);

  log(`» ${prompt}`);
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: clipDir(clip.id), stdio: ["pipe", "pipe", "pipe"] });
    job.cancel = () => child.kill("SIGTERM");
    let buf = "";
    let result = null;
    let stderr = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result") result = ev;
          for (const l of describe(ev)) log(l);
        } catch {
          log(line);
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      // Record the session even on failure so the next command can resume it.
      db.update("clips", clip.id, { agentSessionId: sessionId });
      const history = [...(db.get("clips", clip.id).agentHistory || [])];
      const ok = code === 0 && result && !result.is_error;
      history.push({ prompt, at: new Date().toISOString(), ok, summary: result?.result?.slice(0, 600) || null });
      db.update("clips", clip.id, { agentHistory: history.slice(-50) });

      fs.rmSync(path.join(clipDir(clip.id), "snapshots"), { recursive: true, force: true });

      // Regenerate clip-data.js / captions.srt if Claude touched clip.json.
      const after = loadClipData(clip.id);
      if (after && JSON.stringify(after) !== before) {
        writeClipOutputs(db.get("clips", clip.id), after);
        log("clip.json changed → regenerated clip-data.js and captions.srt");
      }
      if (ok) resolve();
      else reject(new Error(result?.result || stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`));
    });
    child.stdin.end(prompt);
  });
}
