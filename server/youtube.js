// YouTube Data API v3: resolve a video URL, playlist URL, or channel
// (@handle / channel URL / channel id) into a list of videos.
import { run } from "./jobs.js";

const API = "https://www.googleapis.com/youtube/v3";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Node is always present, so let yt-dlp use it for YouTube's JS challenges.
const YT = (args) => ["--no-update", "--js-runtimes", "node", ...args];

function key() {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error("YOUTUBE_API_KEY is missing from .env.local");
  return k;
}

async function api(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: key() })) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `YouTube API ${res.status}`);
  return body;
}

export function parseVideoId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {}
  return null;
}

function parsePlaylistId(input) {
  try {
    return new URL(input.trim()).searchParams.get("list");
  } catch {
    return /^(PL|UU|OL|FL)[\w-]+$/.test(input.trim()) ? input.trim() : null;
  }
}

function parseChannel(input) {
  const s = input.trim();
  if (/^@[\w.-]+$/.test(s)) return { handle: s };
  if (/^UC[\w-]{22}$/.test(s)) return { id: s };
  try {
    const u = new URL(s);
    const m = u.pathname.match(/^\/(@[\w.-]+)/);
    if (m) return { handle: m[1] };
    const c = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (c) return { id: c[1] };
  } catch {}
  return null;
}

function isoDurationToSeconds(iso = "") {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const body = await api("videos", {
      part: "snippet,contentDetails",
      id: ids.slice(i, i + 50).join(","),
    });
    for (const v of body.items) {
      out.push({
        id: v.id,
        title: v.snippet.title,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        channel: v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        thumbnail:
          v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
        duration: isoDurationToSeconds(v.contentDetails?.duration),
        language: v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || null,
      });
    }
  }
  return out;
}

async function playlistVideoIds(playlistId, max) {
  const ids = [];
  let pageToken;
  do {
    const body = await api("playlistItems", {
      part: "contentDetails",
      playlistId,
      maxResults: 50,
      pageToken,
    });
    ids.push(...body.items.map((i) => i.contentDetails.videoId));
    pageToken = body.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

/** Resolve any supported input into video records. */
export async function resolveInput(input, opts = {}) {
  try {
    return await resolveWithApi(input, opts);
  } catch (err) {
    if (err.userInput) throw err;
    console.warn(`YouTube API failed (${err.message}); falling back to yt-dlp`);
    return resolveWithYtDlp(input, opts);
  }
}

// Fallback when the API key is missing/restricted: yt-dlp can read the same metadata.
async function resolveWithYtDlp(input, { max = 50 } = {}) {
  const s = input.trim();
  const videoId = parseVideoId(s);
  const isList = parsePlaylistId(s) || parseChannel(s);
  let target = s;
  if (/^@[\w.-]+$/.test(s)) target = `https://www.youtube.com/${s}/videos`;
  else if (/^UC[\w-]{22}$/.test(s)) target = `https://www.youtube.com/channel/${s}/videos`;
  else if (isList && parseChannel(s) && !/\/(videos|streams|shorts)$/.test(s)) target = s.replace(/\/$/, "") + "/videos";
  if (videoId && !parsePlaylistId(s)) target = `https://www.youtube.com/watch?v=${videoId}`;

  if (!isList || (videoId && !parsePlaylistId(s))) {
    const { stdout } = await run(YTDLP, YT(["-J", "--skip-download", "--no-warnings", target]));
    return [fromYtDlp(JSON.parse(stdout))];
  }
  const { stdout } = await run(YTDLP, YT(["-J", "--flat-playlist", "--playlist-end", String(max), "--no-warnings", target]));
  const list = JSON.parse(stdout);
  return (list.entries || []).filter((e) => e.id && e.id.length === 11).map((e) => fromYtDlp({ ...e, channel: e.channel || list.channel || list.uploader }));
}

function fromYtDlp(v) {
  const d = v.upload_date;
  return {
    id: v.id,
    title: v.title,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    channel: v.channel || v.uploader || null,
    publishedAt: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z` : v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null,
    thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    duration: Math.round(v.duration || 0),
    language: v.language || null,
  };
}

async function resolveWithApi(input, { max = 50 } = {}) {
  const playlistId = parsePlaylistId(input);
  const videoId = parseVideoId(input);
  if (videoId && !playlistId) return videoDetails([videoId]);
  if (playlistId) return videoDetails(await playlistVideoIds(playlistId, max));

  const channel = parseChannel(input);
  if (channel) {
    const body = await api("channels", {
      part: "contentDetails",
      ...(channel.id ? { id: channel.id } : { forHandle: channel.handle }),
    });
    const uploads = body.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error("Channel not found");
    return videoDetails(await playlistVideoIds(uploads, max));
  }
  const err = new Error("Paste a YouTube video URL, playlist URL, or channel (@handle)");
  err.userInput = true;
  throw err;
}
