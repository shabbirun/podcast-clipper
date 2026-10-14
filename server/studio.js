// Runs one HyperFrames Studio preview at a time for the clip being edited.
//
// `hyperframes preview` daemonizes its server, so killing the launcher does not
// stop it. We use the CLI's own lifecycle (--background / --status / --stop) and
// always hand out the URL the CLI reports, since it may pick a different port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./jobs.js";
import { db, DATA_DIR, CLIPS_DIR } from "./db.js";
import { clipDir } from "./clip.js";

const PORT = Number(process.env.STUDIO_PORT || 3017);
const STATE_FILE = path.join(DATA_DIR, ".studio.json");

let current = readState(); // { clipId, url, port } | null

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(s) {
  current = s;
  if (s) fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  else fs.rmSync(STATE_FILE, { force: true });
}

/** Run the project's pinned `hyperframes preview` with lifecycle flags. */
async function preview(clipId, flags) {
  const dir = clipDir(clipId);
  if (!fs.existsSync(path.join(dir, "package.json"))) return null;
  const { stdout } = await run("npm", ["run", "--silent", "dev", "--", ...flags, "--json"], { cwd: dir });
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  const res = line ? JSON.parse(line) : null;
  if (res && res.ok === false) throw new Error(res.error?.message || `preview ${flags[0]} failed`);
  return res?.result || null;
}

// The CLI records each background preview in its state dir. We only read it to
// find which clip previews are up; stopping still goes through `--stop`.
const PREVIEW_REGISTRY = path.join(os.homedir(), ".local", "state", "hyperframes", "previews");

function runningClipPreviews() {
  const all = db.all("clips").map((c) => c.id);
  let files;
  try {
    files = fs.readdirSync(PREVIEW_REGISTRY).filter((f) => f.endsWith(".json"));
  } catch {
    return all; // registry unavailable: stop everything to be safe
  }
  const ids = new Set();
  for (const f of files) {
    try {
      const dir = JSON.parse(fs.readFileSync(path.join(PREVIEW_REGISTRY, f), "utf8")).projectDir;
      if (dir && path.dirname(dir) === CLIPS_DIR) ids.add(path.basename(dir));
    } catch {}
  }
  return [...ids].filter((id) => all.includes(id));
}

const toLocalhost = (url) => url.replace("//127.0.0.1:", "//localhost:");

export function studioStatus() {
  if (!current) return { running: false };
  return { running: true, ready: true, clipId: current.clipId, port: current.port, url: current.url };
}

async function stopClip(clipId) {
  try {
    await preview(clipId, ["--stop"]);
  } catch {}
}

export async function stopStudio() {
  if (current) await stopClip(current.clipId);
  writeState(null);
}

export async function startStudio(clipId) {
  // Stop every other clip's preview so the port is free and nothing stale answers.
  await Promise.all(runningClipPreviews().filter((id) => id !== clipId).map(stopClip));

  // Reuse a running preview for this clip.
  const status = await preview(clipId, ["--status"]).catch(() => null);
  if (status?.state === "running" && status.studioUrl) {
    writeState({ clipId, port: status.port, url: toLocalhost(status.studioUrl) });
    return { ...studioStatus(), ready: status.ready !== false };
  }

  const res = await preview(clipId, ["--background", "--no-open", "--port", String(PORT)]);
  if (!res?.studioUrl) throw new Error("HyperFrames preview did not report a Studio URL");
  writeState({ clipId, port: res.port, url: toLocalhost(res.studioUrl) });
  return { ...studioStatus(), ready: res.ready !== false };
}
