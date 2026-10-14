// Tiny JSON-file database. Everything lives in data/db.json; large blobs
// (transcripts, media, HyperFrames projects) live next to it under data/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
export const CLIPS_DIR = path.join(DATA_DIR, "clips");
export const RENDERS_DIR = path.join(DATA_DIR, "renders");
const DB_FILE = path.join(DATA_DIR, "db.json");

for (const d of [DATA_DIR, TRANSCRIPTS_DIR, DOWNLOADS_DIR, CLIPS_DIR, RENDERS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const EMPTY = { videos: [], suggestions: [], clips: [] };

function load() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

let state = load();

function persist() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const db = {
  all(table) {
    return state[table];
  },
  get(table, id) {
    return state[table].find((r) => r.id === id);
  },
  where(table, pred) {
    return state[table].filter(pred);
  },
  insert(table, row) {
    state[table].push(row);
    persist();
    return row;
  },
  upsert(table, row) {
    const i = state[table].findIndex((r) => r.id === row.id);
    if (i >= 0) state[table][i] = { ...state[table][i], ...row };
    else state[table].push(row);
    persist();
    return this.get(table, row.id);
  },
  update(table, id, patch) {
    const row = this.get(table, id);
    if (!row) return null;
    Object.assign(row, patch);
    persist();
    return row;
  },
  remove(table, pred) {
    state[table] = state[table].filter((r) => !pred(r));
    persist();
  },
};

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
