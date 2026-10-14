# Podcast Clipper

A local web app that turns long-form podcast episodes on YouTube into vertical (9:16) short-form clips with editable captions.

```
Add episodes ─► Fetch transcript ─► Claude suggests viral clips ─► Create clip ─► Edit captions / style ─► Preview in Studio ─► Render MP4
 (YouTube API)    (yt-dlp / Whisper)     (Claude Code CLI)          (yt-dlp + ffmpeg    (in-app editor +       (HyperFrames)       (HyperFrames)
                                                                     + HyperFrames)      Claude edit commands)
```

Everything runs on your machine. Data is kept in plain files under `data/`, and each clip is a standalone [HyperFrames](https://hyperframes.heygen.com) project you can also open and edit outside the app.

---

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Running](#running)
- [Walkthrough](#walkthrough)
  - [1. Library](#1-library)
  - [2. Transcript](#2-transcript)
  - [3. Clip suggestions](#3-clip-suggestions)
  - [4. Creating a clip](#4-creating-a-clip)
  - [5. Captions](#5-captions)
  - [6. Style & layout](#6-style--layout)
  - [7. Edit with HyperFrames (free-text commands)](#7-edit-with-hyperframes-free-text-commands)
  - [8. Preview](#8-preview)
  - [9. Render](#9-render)
  - [10. Planner](#10-planner)
- [Configuration](#configuration)
- [Data & files](#data--files)
- [The clip project (HyperFrames)](#the-clip-project-hyperframes)
- [How Claude is used](#how-claude-is-used)
- [Costs & timings](#costs--timings)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Limitations](#limitations)

---

## Requirements

| Tool | Why | Install / check |
| --- | --- | --- |
| **Node.js 22+** | App server; HyperFrames requires 22+ | `node -v` |
| **ffmpeg + ffprobe** | Cutting clips, probing media, rendering | `brew install ffmpeg` |
| **yt-dlp** (recent) | Captions, video downloads, metadata fallback | `pip install -U yt-dlp` — **keep it updated**, YouTube breaks old versions |
| **Claude Code CLI** (`claude`), logged in | Clip suggestions, transliteration, edit commands | `claude --version` |
| **YouTube Data API v3 key** | Titles, playlists, channel uploads | Google Cloud Console → Credentials |

HyperFrames doesn't need installing. Each clip project runs its own pinned version through `npx` (currently `hyperframes@0.8.75`), and the first run downloads it along with a headless Chrome for rendering.

Whisper (optional, for local transcription) is run through `hyperframes transcribe`, which downloads its models the first time they're used.

## Setup

```bash
git clone <this repo> podcast-clipper   # or copy the folder
cd podcast-clipper
npm install
cp .env.example .env.local              # then add your YOUTUBE_API_KEY
```

**YouTube API key:** in Google Cloud Console, enable **YouTube Data API v3** for your project and make sure the key's *API restrictions* allow it. If requests fail with *"Requests to this API … are blocked"*, the key is restricted to other APIs. The app still works without a working key by falling back to yt-dlp for metadata, just more slowly.

## Running

```bash
npm start        # http://localhost:4400
npm run dev      # same, but auto-restarts when files in server/ change
```

Open **http://localhost:4400**. Keep the terminal open: background work (downloads, renders, Claude calls) runs inside this process.

---

## Walkthrough

### 1. Library

Paste one of these into the top bar and click **Add**:

| Input | Example | Result |
| --- | --- | --- |
| Video URL | `https://www.youtube.com/watch?v=K8WA9EgaZZ4` | That video |
| Playlist URL | `https://www.youtube.com/playlist?list=PL…` | Every video in the playlist (up to 500) |
| Channel handle | `@yourchannel` | The channel's uploads (up to 500) |
| Channel ID / URL | `UCuaonRC4jvPYR56TerGiIAg`, `youtube.com/@x`, `youtube.com/channel/UC…` | The channel's uploads |

- **Long-form only:** videos of 3 minutes or less are treated as Shorts and skipped. The confirmation message says how many were skipped. You can change this with `MIN_VIDEO_SECONDS`.
- Adding the same channel again is safe. Existing videos are updated in place and only new ones are added.
- **List view** (click the logo, or *All videos (list view)*): a sortable table with Title, Published, Length, Transcript, Ideas and Clips columns. Click a column header to sort by it, and click again to reverse.
- **Sidebar:** filter by title and pick a sort order. The sort is shared with the list view and remembered in your browser.
- **Remove from library** on a video's page deletes the video and its suggestions. Clips you've already built are kept.

### 2. Transcript

On a video's page, card **1 · Transcript**:

- **YouTube captions (fast):** downloads the caption track with yt-dlp in YouTube's `json3` format, which includes per-word timings for auto-generated captions. Track choice, in order:
  1. manual captions in the requested language
  2. the auto-generated *original-language* track (`<lang>-orig`)
  3. auto captions in that language
  4. any original-language auto track
  5. any manual track
- **Whisper (local, slow, more accurate):** downloads the audio and transcribes it on your machine. Use this when YouTube's captions are missing or wrong.
- **Language:** leave empty to use the video's own language, or enter a code (`en`, `ur`, `hi`, `gu`, …). **List YouTube tracks** shows which tracks exist.
- The whole transcript is saved with a timestamp for every word, in `data/transcripts/<videoId>.json`. Expand *Show timestamped transcript* to read it; each timestamp links to that moment on YouTube.

### 3. Clip suggestions

Card **2 · Viral clip suggestions**:

| Field | Meaning |
| --- | --- |
| Clips | How many suggestions to ask for (1–20) |
| Min / Max sec | Clip length range; the maximum is capped at 120 s |
| Direction for Claude | Optional steer, e.g. *"focus on personal stories, skip the intro"* |
| Replace existing | Clear previous suggestions first, or add to them |

Claude reads the full timestamped transcript and returns clips, each with a **title**, an on-screen **hook**, **start/end**, a **reason** it should perform well, and a **score** out of 10. The app then snaps each boundary to real word timings (a small lead-in before the first word, a small tail after the last), so clips never start or end mid-word, and trims any clip over the maximum back to a sentence end.

Each suggestion card shows the transcript excerpt and has editable **start → end** fields (`m:ss.s`), so you can nudge the boundaries before building. ▶ opens that moment on YouTube.

### 4. Creating a clip

**✂ Create clip** starts a build job. You're taken to the clip page, which shows a live log. The steps:

1. **Download** the source with yt-dlp (up to 1080p). With the default `DOWNLOAD_MODE=full` the whole episode is downloaded once to `data/downloads/`, and later clips from the same episode reuse it instantly.
2. **Cut** the clip with ffmpeg (H.264, CRF 18, AAC 192k), frame-accurate, plus a 360p copy used for the blurred background.
3. **Scaffold** a HyperFrames project in `data/clips/<clipId>/`.
4. **Build captions** from the transcript's word timings: short cues of up to 4 words, split at pauses and punctuation.
5. **Check** the composition with `hyperframes check`.

If the build fails (a download error, say), fix the cause and click **Retry build**.

### 5. Captions

The **Captions** card is the caption editor. The captions are stored separately from the video design, so you can fix wording (for example when the language gets mixed up) without touching anything else.

- **Source player:** the raw clip. Click a row number to play from that cue; the row being spoken is highlighted.
- **Cues tab:** edit each cue's start, end and text. Row actions: **⤓** merge with the next cue, **✂** split in half, **✕** delete. **+ Add cue at playhead** adds a new one.
- **SRT file tab:** edit the whole caption file as plain SRT text. Switching tabs converts between the two views.
- **Show captions:** a checkbox that turns captions off completely.
- **Words/cue + Regroup:** rebuilds the cues from the stored word timings with a different grouping. This discards text edits.
- **Transliterate to English:** sends the current cues to Claude, which rewrites any non-Latin script in English letters (Roman Urdu / Hinglish style) without translating. Hindi and Gujarati are written with a Lisan ud Dawat flavor, staying as close as possible to what was said. Timings don't change. The result is **not saved** until you click Save, so you can review it first.
- **Re-transcribe:** runs Whisper on just this clip, with a language and model you choose, and rebuilds the cues.
- **Save** (or ⌘S / Ctrl+S) writes `clip.json`, `clip-data.js` and `captions.srt`. The Studio preview reloads automatically. "● unsaved" means you have edits that haven't been saved.

**Word highlighting:** while a cue's text is unchanged, each word lights up exactly when it's spoken. Once you edit a cue's text, its word timings are dropped and the highlight is spread across the cue in proportion to each word's length.

### 6. Style & layout

| Setting | Options |
| --- | --- |
| Framing | **Crop to fill 9:16** (with a *Horizontal focus* slider to keep the speaker in frame) or **Full frame + blurred fill** (the whole 16:9 frame centred over a blurred copy) |
| Zoom | 1×–2× |
| Caption style | **Bold** (white, black outline, yellow active word) · **Box** (white on a dark pill) · **Minimal** (clean white) · **Karaoke** (dim words brighten as they're spoken) |
| Vertical position | % from the top |
| Font size / Uppercase / Highlight colour | — |
| Hook text | On/off, the text, and how many seconds it stays on screen (it animates in at 0.15 s) |

Changes take effect when you **Save**.

### 7. Edit with HyperFrames (free-text commands)

For anything the settings don't cover, type an instruction and press **Send** (⌘↵). For example:

> add a thin progress bar at the top · make captions bounce in · slow zoom in for the first 5 seconds · put the episode title in the bottom corner · change the hook box to gold

What happens:

- The **Claude Code CLI** runs inside the clip's project folder with the HyperFrames skills loaded.
- **Allowed tools:** reading and editing files, plus shell commands limited to `npx hyperframes`, `npm run check`, `ffmpeg`, `ffprobe`, `ls` and `cat`. Claude isn't allowed to render or start servers.
- It puts design and motion changes in `index.html`. Caption text, caption style, hook and layout changes go in `clip.json`, and the app regenerates `clip-data.js` and `captions.srt` from it afterwards.
- It checks its work by running `hyperframes lint`, then taking **snapshots** of the frames and looking at them, because lint can't see elements that end up invisible.
- **One Claude session per clip**, so follow-ups ("make it thicker") have context. **New session** starts fresh. **Stop** cancels a running command.
- The last few commands and Claude's summaries are listed in the card. The full history is stored on the clip in `db.json`.

Any unsaved caption edits are saved automatically before a command runs. Avoid editing the same clip in Studio while a command is running, because the two sets of changes can collide.

### 8. Preview

**Open HyperFrames preview** starts **HyperFrames Studio** for this clip and embeds it in the page (**New tab ↗** opens it full size). In Studio you can scrub, play, and edit anything on the timeline by hand.

- Only **one** preview runs at a time. Opening another clip stops the previous clip's server first.
- The app always uses the URL the HyperFrames CLI reports, so it still works if Studio picks a port other than `3017`.
- Saving captions or running an edit command reloads the preview.

### 9. Render

Choose **Draft**, **Standard** or **High** and click **Render MP4**. Output goes to `data/renders/<title>_<id>_<timestamp>.mp4`, at 1080×1920 and 30 fps with audio. The newest render plays inline and every render has a download link. Unsaved edits are saved before rendering.

### 10. Planner

**▦ Planner** in the sidebar (or `#/planner`) opens a month calendar showing when each clip goes out. Clips without a date sit in the **Unscheduled** tray. Drag one onto a day to schedule it, or drag it back to the tray to unschedule it. Tick the box on a card once the clip is posted. Each card's left edge shows its state: yellow is scheduled, red is overdue (the day has passed and it isn't posted) and green is posted. Cards marked *not rendered* have no MP4 yet. You can also set the date and posted flag from the strip under a clip's title.

---

## Configuration

Set in `.env.local` (or `.env`). Restart the app after changing it.

| Variable | Default | Description |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | — | YouTube Data API v3 key. If missing or rejected, the app uses yt-dlp for metadata instead. |
| `MIN_VIDEO_SECONDS` | `180` | Videos this long or shorter count as Shorts and are skipped on import. |
| `DOWNLOAD_MODE` | `full` | `full`: download each episode once and cache it (best when making several clips per episode). `section`: download only the clip window plus 5 s either side (faster for one-off clips from long episodes). |
| `CLAUDE_MODEL` | CLI default | Model for clip suggestions and transliteration, e.g. `sonnet`. |
| `CLAUDE_EDIT_MODEL` | CLI default | Model for *Edit with HyperFrames* commands. |
| `WHISPER_MODEL` | `small.en` for English, `large-v3` otherwise | Whisper model for transcript and clip re-transcription. |
| `STUDIO_PORT` | `3017` | Preferred port for the Studio preview. |
| `PORT` | `4400` | App port. |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary. |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg (`ffprobe` is always taken from `PATH`). |
| `CLAUDE_PATH` | `claude` | Path to the Claude Code CLI. |

---

## Data & files

Everything lives in `data/`, which is git-ignored. Back it up to keep your work.

```
data/
├── db.json                     # the library (see below)
├── .studio.json                # which clip's Studio preview is running
├── .hf-template/               # HyperFrames scaffold, created once with `hyperframes init`
├── transcripts/
│   ├── <videoId>.json          # word-level transcript: { source, lang, words[], segments[] }
│   └── <videoId>.raw.*.json3   # raw YouTube caption download
├── downloads/
│   ├── <videoId>.mp4           # cached full episode (DOWNLOAD_MODE=full)
│   └── <videoId>.audio.m4a     # audio for Whisper
├── clips/<clipId>/             # one HyperFrames project per clip (next section)
└── renders/*.mp4               # finished videos
```

**`db.json`** holds three tables:

- `videos`: `id, title, url, channel, publishedAt, thumbnail, duration, language, addedAt`
- `suggestions`: `id, videoId, batch, title, hook, start, end, reason, score`
- `clips`: `id, videoId, suggestionId, title, hook, start, end, duration, status, error, renders[], agentSessionId, agentHistory[], scheduledFor, postedAt`

Deleting a clip in the app deletes its project folder. Its renders in `data/renders/` are kept. Removing a video doesn't delete its cached download or transcript; delete those files by hand to free space.

---

## The clip project (HyperFrames)

`data/clips/<clipId>/` is a normal HyperFrames project:

| File | Role | Who edits it |
| --- | --- | --- |
| `index.html` | The composition: a 1080×1920 root, background, blurred fill video, main video, audio, hook layer and caption layer, plus a GSAP timeline that builds the hook and captions from `window.CLIP_DATA` | Written once at creation, and **never overwritten** by the app. Edit it freely in Studio, or with edit commands. |
| `clip.json` | Source of truth: `source` (video size), `settings` (layout, captions, hook), `cues[]`, `words[]` | The app (Captions and Style cards) and edit commands |
| `clip-data.js` | `window.CLIP_DATA = …`, generated from `clip.json` and loaded by `index.html` | Generated. Don't edit it. |
| `captions.srt` | Caption export | Generated (edit it through the SRT tab) |
| `assets/clip.mp4` | The cut footage, with audio | Build step |
| `assets/clip-bg.mp4` | 360p silent copy for the blurred fill | Build step |
| `package.json`, `hyperframes.json`, `meta.json`, `CLAUDE.md` | HyperFrames scaffolding, with the CLI version pinned | — |

Working with a project outside the app:

```bash
cd data/clips/<clipId>
npm run check            # lint + runtime/layout checks
npm run dev              # Studio preview (foreground)
npm run render -- --quality high --output out.mp4
```

Because captions and settings are loaded from `clip-data.js`, caption edits in the app never overwrite design changes made in Studio, and the other way round.

---

## How Claude is used

All Claude calls go through the local **Claude Code CLI**, so they use your existing login. No separate API key is needed.

| Feature | Mode | Tools | Output |
| --- | --- | --- | --- |
| Clip suggestions (`server/suggest.js`) | `claude -p`, no tools, `--json-schema` | none | `{ clips: [{ title, hook, start, end, reason, score }] }` |
| Transliteration (`server/transliterate.js`) | `claude -p`, no tools, `--json-schema` | none | `{ lines: [{ i, text }] }`, one per cue |
| Edit commands (`server/agent.js`) | `claude -p --output-format stream-json`, `--permission-mode acceptEdits`, run in the clip folder | Read/Edit/Write/Glob/Grep/Skill + limited shell commands | File edits and a summary; progress streams into the log |

The prompts live in those files if you want to tune them: the rules for what counts as a good clip, the transliteration style, and the instructions for edit commands. The shared headless helper is `server/claude.js`.

---

## Costs & timings

Figures measured on a 20-minute episode and a ~60 s clip, on an Apple Silicon Mac:

| Step | Typical time | Claude cost |
| --- | --- | --- |
| Import a channel (API) | ~2–5 s | — |
| YouTube transcript | ~10–15 s | — |
| Clip suggestions (3–5 clips) | ~30–60 s | ~$0.10–0.20 per run (more for long episodes) |
| Full-episode download (1080p) | depends on your connection and the episode length (a 60 min episode is roughly 1–2 GB) | — |
| Cut + build a clip | ~5–10 s once the source is downloaded | — |
| Transliterate a clip | ~10–30 s | a few cents |
| Edit command | ~30–90 s | ~$0.20–0.40 per command |
| Studio start / switch | ~5–25 s | — |
| Render (draft, 60 s clip) | ~2 min | — |

Set `CLAUDE_MODEL=sonnet` (and/or `CLAUDE_EDIT_MODEL`) to lower Claude costs.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `HTTP Error 403: Forbidden` when downloading | yt-dlp is out of date: `pip install -U yt-dlp`, then click **Retry build** |
| *"Requests to this API … are blocked"* in the server log | The API key isn't allowed to use YouTube Data API v3 (see [Setup](#setup)). The app falls back to yt-dlp in the meantime. |
| *"No captions available on YouTube"* | Switch the transcript source to **Whisper** |
| Captions are in the wrong language or script | Re-fetch with a different language or track, **Re-transcribe** the clip with Whisper, or use **Transliterate to English**, then correct by hand |
| Preview shows the wrong clip or won't load | Click **Open HyperFrames preview** again (it stops other clip previews first). To stop one by hand: `cd data/clips/<id> && npm run dev -- --stop` |
| Preview doesn't show a change | Make sure you clicked **Save**; reload the Studio tab |
| A render or build seemed to vanish | Jobs are held in memory, so restarting the server loses running jobs. Start them again. |
| An edit command made things worse | Tell it what's wrong in a follow-up, click **New session** for a clean start, or edit `index.html` in Studio. There's no automatic undo, so keep a copy of the folder before experimenting heavily. |
| Suggestions are too long or short | Adjust **Min/Max sec**, or edit start/end on the card before building |
| Disk filling up | Delete old files in `data/downloads/` (re-downloaded on demand) and `data/renders/` |

The server log (the terminal running `npm start`) and each card's log panel show the full output of every command.

---

## Architecture

```
public/                 Single-page UI (vanilla JS, hash routing: #/, #/video/:id, #/clip/:id)
  index.html  app.js  style.css
server/
  index.js        Express app + REST API, serves public/ and media
  db.js           JSON-file database (data/db.json), atomic writes, data/ paths
  jobs.js         In-memory background jobs with logs; process runner
  youtube.js      YouTube Data API (videos / playlists / channels) + yt-dlp fallback
  transcript.js   YouTube json3 captions → word timings; Whisper via `hyperframes transcribe`
  claude.js       Headless Claude CLI helper (no tools, JSON-schema output)
  suggest.js      Clip suggestion prompt + word-boundary snapping
  transliterate.js  Transliteration prompt
  clip.js         Download → ffmpeg cut → project scaffold → captions; save/regroup/re-transcribe/render
  composition.js  index.html template, cue grouping, SRT conversion, caption styles
  agent.js        Free-text edit commands (Claude Code in the clip folder, stream-json)
  studio.js       HyperFrames Studio lifecycle (--background / --status / --stop)
```

Long-running operations (transcript, suggest, build, re-transcribe, render, command) are **jobs**. The API returns a job right away, and the UI polls `/api/jobs/:id` every second for status and log lines.

---

## API reference

All endpoints are JSON under `/api`. Endpoints marked *job* return a job object `{ id, kind, status, tail }`; poll `GET /api/jobs/:id` until `status` is `done` or `error`.

| Method & path | Body | Description |
| --- | --- | --- |
| `GET /videos` | — | Library, with `hasTranscript`, `suggestionCount`, `clipCount` |
| `POST /videos` | `{ input, max? }` | Add video / playlist / channel → `{ added, skippedShorts }` |
| `GET /videos/:id` | — | Video, transcript summary and segments, suggestions, clips, jobs |
| `DELETE /videos/:id` | — | Remove a video and its suggestions |
| `GET /videos/:id/caption-tracks` | — | Available YouTube caption tracks |
| `POST /videos/:id/transcript` | `{ method: "youtube"\|"whisper", lang?, model? }` | *job*: fetch the transcript |
| `POST /videos/:id/suggest` | `{ count, minSeconds, maxSeconds, guidance?, replace? }` | *job*: Claude clip suggestions |
| `DELETE /suggestions/:id` | — | Discard a suggestion |
| `POST /clips` | `{ suggestionId } \| { videoId, start, end, title?, hook? }` | Create a clip → `{ clip, job }` |
| `GET /clips/:id` | — | Clip, settings, cues, caption styles, jobs, Studio status |
| `GET /planner` | — | All clips with their video's `title`/`thumbnail`, for the posting calendar |
| `PUT /clips/:id/schedule` | `{ scheduledFor?: "YYYY-MM-DD"\|null, posted?: bool }` | Set or clear a clip's posting day, or mark it as posted |
| `PUT /clips/:id` | `{ title?, settings?, cues? \| srt? }` | Save edits (regenerates clip-data.js and captions.srt) |
| `POST /clips/:id/rebuild` | — | *job*: re-run the build |
| `POST /clips/:id/regroup` | `{ maxWords }` | Rebuild cues from word timings |
| `POST /clips/:id/transliterate` | `{ cues? }` | Transliterated cues (**not saved**) |
| `POST /clips/:id/retranscribe` | `{ lang?, model? }` | *job*: Whisper on the clip |
| `POST /clips/:id/command` | `{ prompt }` | *job*: free-text edit command |
| `POST /clips/:id/command/reset` | — | Start a new Claude session for the clip |
| `POST /clips/:id/render` | `{ quality: "draft"\|"standard"\|"high" }` | *job*: render the MP4 |
| `POST /clips/:id/studio` | — | Start or reuse Studio → `{ url, port, ready }` |
| `DELETE /studio` | — | Stop the running Studio preview |
| `DELETE /clips/:id` | — | Delete the clip and its project folder |
| `GET /jobs/:id` | — | Job status and full log |
| `POST /jobs/:id/cancel` | — | Cancel a running edit command |

Static routes: `/renders/<file>` (rendered MP4s) and `/clip-assets/<clipId>/clip.mp4` (the source player).

---

## Limitations

- **Single user, local only.** There's no authentication, so don't expose the port to a network.
- **Jobs are in memory.** Restarting the server loses running jobs and their logs. Saved data (`db.json`, transcripts, clips, renders) is kept.
- **One Studio preview at a time.**
- **Clip boundaries are fixed once a clip is built.** To change a clip's start or end, create a new clip from the suggestion with adjusted times.
- **Shorts detection is by length** (`MIN_VIDEO_SECONDS`), not by YouTube's own Shorts flag.
- **Edit commands have no undo.** Copy the clip folder before making big changes.
- Downloading YouTube content is subject to YouTube's Terms of Service. Use this with content you own or have rights to.
