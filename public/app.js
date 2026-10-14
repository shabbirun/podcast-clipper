const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${err ? " err" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), err ? 6000 : 2500);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmt(s) {
  s = Math.max(0, Number(s) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
function parseTime(v) {
  const parts = String(v).trim().split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------- jobs ----------
const polling = new Map();
function watchJob(job, { logEl, statusEl, onDone } = {}) {
  if (!job || polling.has(job.id)) return;
  const tick = async () => {
    let j;
    try {
      j = await api(`/jobs/${job.id}`);
    } catch {
      polling.delete(job.id);
      return;
    }
    const logNode = typeof logEl === "function" ? logEl() : logEl;
    const statusNode = typeof statusEl === "function" ? statusEl() : statusEl;
    if (logNode) {
      logNode.hidden = false;
      logNode.textContent = j.log.slice(-200).join("\n");
      logNode.scrollTop = logNode.scrollHeight;
    }
    if (statusNode) statusNode.innerHTML = jobStatus(j);
    if (j.status === "running") polling.set(job.id, setTimeout(tick, 1000));
    else {
      polling.delete(job.id);
      if (j.status === "error") toast(j.error.split("\n")[0], true);
      onDone?.(j);
    }
  };
  polling.set(job.id, setTimeout(tick, 300));
}
function jobStatus(j) {
  if (!j) return "";
  if (j.status === "running") return `<span class="status"><span class="spinner"></span> ${esc(j.kind)} running…</span>`;
  if (j.status === "error") return `<span class="status badge err">${esc(j.kind)} failed</span>`;
  return `<span class="status badge ok">${esc(j.kind)} done</span>`;
}

// ---------- sidebar ----------
let videos = [];
async function loadVideos() {
  videos = await api("/videos");
  renderSidebar();
}
// Sort state shared by the sidebar and the list view; remembered per browser.
let sort = { key: "publishedAt", dir: "desc" };
try {
  sort = JSON.parse(localStorage.getItem("pc.sort")) || sort;
} catch {}
function setSort(key, dir) {
  sort = { key, dir };
  try {
    localStorage.setItem("pc.sort", JSON.stringify(sort));
  } catch {}
  syncSortSelect();
  renderSidebar();
  if (!location.hash.split("/")[1]) renderHome();
}
function syncSortSelect() {
  const sel = $("#sort");
  const val = `${sort.key}:${sort.dir}`;
  if (![...sel.options].some((o) => o.value === val)) sel.add(new Option(`Custom (${sort.key})`, val));
  sel.value = val;
}
$("#sort").addEventListener("change", (e) => setSort(...e.target.value.split(":")));

const SORT_VALUE = {
  title: (v) => v.title.toLowerCase(),
  publishedAt: (v) => v.publishedAt || "",
  duration: (v) => v.duration || 0,
  hasTranscript: (v) => (v.hasTranscript ? 1 : 0),
  suggestionCount: (v) => v.suggestionCount || 0,
  clipCount: (v) => v.clipCount || 0,
};
function sortedVideos(q = "") {
  const get = SORT_VALUE[sort.key] || SORT_VALUE.publishedAt;
  const m = sort.dir === "asc" ? 1 : -1;
  return videos
    .filter((v) => v.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      const x = get(a), y = get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * m || (b.publishedAt || "").localeCompare(a.publishedAt || "");
    });
}

function renderSidebar() {
  const q = $("#filter").value;
  const current = location.hash.match(/#\/video\/([\w-]+)/)?.[1] || currentVideoId;
  $("#video-list").innerHTML = sortedVideos(q)
    .map(
      (v) => `<li><a href="#/video/${v.id}" class="${v.id === current ? "active" : ""}">
        <img src="${esc(v.thumbnail || "")}" alt="" loading="lazy" />
        <div><div class="t">${esc(v.title)}</div>
        <div class="badges">
          <span class="badge">${dur(v.duration || 0)}</span>
          ${v.hasTranscript ? '<span class="badge ok">transcript</span>' : ""}
          ${v.suggestionCount ? `<span class="badge on">${v.suggestionCount} ideas</span>` : ""}
          ${v.clipCount ? `<span class="badge on">${v.clipCount} clips</span>` : ""}
        </div></div></a></li>`,
    )
    .join("") || `<li class="muted small" style="padding:8px">No videos yet. Paste a URL above.</li>`;
}
$("#filter").addEventListener("input", () => {
  renderSidebar();
  if (!location.hash.split("/")[1]) renderHome();
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#add-input").value.trim();
  if (!input) return;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { added, skippedShorts } = await api("/videos", { method: "POST", body: { input } });
    toast(`Added ${added} video${added === 1 ? "" : "s"}${skippedShorts ? ` · skipped ${skippedShorts} short${skippedShorts === 1 ? "" : "s"}` : ""}`);
    $("#add-input").value = "";
    await loadVideos();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- router ----------
let currentVideoId = null;
async function route() {
  const [, kind, id] = location.hash.split("/");
  for (const t of polling.values()) clearTimeout(t);
  polling.clear();
  try {
    if (kind === "video" && id) await renderVideo(id);
    else if (kind === "clip" && id) await renderClip(id);
    else if (kind === "planner") await renderPlanner();
    else renderHome();
  } catch (e) {
    main.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
  renderSidebar();
}
window.addEventListener("hashchange", route);

const COLUMNS = [
  { key: "title", label: "Title" },
  { key: "publishedAt", label: "Published" },
  { key: "duration", label: "Length" },
  { key: "hasTranscript", label: "Transcript" },
  { key: "suggestionCount", label: "Ideas" },
  { key: "clipCount", label: "Clips" },
];

function renderHome() {
  currentVideoId = null;
  if (!videos.length) {
    main.innerHTML = `<div class="empty">
      <h2>Add your episodes</h2>
      <p>Paste a video URL, a playlist URL, or your channel handle (e.g. <span class="mono">@yourpodcast</span>) above.<br/>
      Then: fetch transcript → get Claude's clip suggestions → build a clip → edit captions → preview → render.</p></div>`;
    return;
  }
  const list = sortedVideos($("#filter").value);
  const arrow = (k) => (sort.key === k ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  main.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0">All videos <span class="muted small">${list.length} of ${videos.length}</span></h2>
    </div>
    <table class="vtable">
      <thead><tr><th></th>${COLUMNS.map((c) => `<th data-key="${c.key}" class="${sort.key === c.key ? "sorted" : ""}">${c.label}${arrow(c.key)}</th>`).join("")}</tr></thead>
      <tbody>${list
        .map(
          (v) => `<tr data-id="${v.id}">
          <td><img src="${esc(v.thumbnail || "")}" alt="" loading="lazy" /></td>
          <td class="title"><a href="#/video/${v.id}">${esc(v.title)}</a></td>
          <td class="mono">${v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : "—"}</td>
          <td class="mono">${dur(v.duration || 0)}</td>
          <td>${v.hasTranscript ? '<span class="badge ok">yes</span>' : '<span class="muted">—</span>'}</td>
          <td class="mono">${v.suggestionCount || "—"}</td>
          <td class="mono">${v.clipCount || "—"}</td>
        </tr>`,
        )
        .join("")}</tbody>
    </table>`;
  main.querySelectorAll("th[data-key]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.key;
      const defaultDir = k === "title" ? "asc" : "desc";
      setSort(k, sort.key === k ? (sort.dir === "asc" ? "desc" : "asc") : defaultDir);
    };
  });
  main.querySelectorAll("tbody tr").forEach((tr) => {
    tr.onclick = (e) => {
      if (!e.target.closest("a")) location.hash = `#/video/${tr.dataset.id}`;
    };
  });
}

// ---------- planner view ----------
// Month calendar of when each clip goes out. Days are local "YYYY-MM-DD" strings.
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let plannerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

async function renderPlanner() {
  currentVideoId = null;
  const clips = await api("/planner");
  const today = dayKey(new Date());
  const byDay = new Map();
  for (const c of clips) if (c.scheduledFor) byDay.set(c.scheduledFor, [...(byDay.get(c.scheduledFor) || []), c]);
  const unscheduled = clips.filter((c) => !c.scheduledFor).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const upcoming = clips.filter((c) => c.scheduledFor >= today && !c.postedAt).length;
  const overdue = clips.filter((c) => c.scheduledFor && c.scheduledFor < today && !c.postedAt).length;

  const card = (c) => {
    const state = c.postedAt ? "posted" : c.scheduledFor && c.scheduledFor < today ? "overdue" : "";
    const rendered = c.renders?.length > 0;
    return `<div class="pcard ${state}" draggable="true" data-id="${c.id}" title="${esc(c.title)}${c.video ? ` — ${esc(c.video.title)}` : ""}">
      <button class="pcheck" data-posted="${c.postedAt ? 1 : 0}" title="${c.postedAt ? "Posted — click to undo" : "Mark as posted"}">${c.postedAt ? "✓" : ""}</button>
      <a href="#/clip/${c.id}" class="pt">${esc(c.title)}</a>
      ${rendered ? "" : `<span class="badge ${c.status === "error" ? "err" : ""}" title="No MP4 rendered yet">${c.status === "ready" ? "not rendered" : esc(c.status)}</span>`}
    </div>`;
  };

  // 6-week grid starting on the Monday on/before the 1st.
  const first = new Date(plannerMonth);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));

  main.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0">Planner <span class="muted small">${upcoming} upcoming${overdue ? ` · <span style="color:var(--danger)">${overdue} overdue</span>` : ""}</span></h2>
      <div class="row">
        <button class="btn small" id="pm-prev">←</button>
        <strong style="min-width:140px;text-align:center">${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
        <button class="btn small" id="pm-next">→</button>
        <button class="btn small" id="pm-today">Today</button>
      </div>
    </div>
    <div class="planner">
      <div class="ptray pdrop" data-day="">
        <div class="ptray-h">Unscheduled <span class="muted">${unscheduled.length}</span></div>
        ${unscheduled.map(card).join("") || `<div class="muted small">${clips.length ? "Everything is scheduled." : "No clips yet. Create one from a video's suggestions."}</div>`}
        <div class="muted small" style="margin-top:auto;padding-top:10px">Drag clips onto a day. Drag back here to unschedule.</div>
      </div>
      <div class="pcal">
        ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="pdow">${d}</div>`).join("")}
        ${days
          .map((d) => {
            const k = dayKey(d);
            const cls = [d.getMonth() !== first.getMonth() && "other", k === today && "today", k < today && "past"].filter(Boolean).join(" ");
            return `<div class="pday pdrop ${cls}" data-day="${k}"><div class="pnum">${d.getDate()}</div>${(byDay.get(k) || []).map(card).join("")}</div>`;
          })
          .join("")}
      </div>
    </div>`;

  const shift = (n) => {
    plannerMonth = new Date(plannerMonth.getFullYear(), plannerMonth.getMonth() + n, 1);
    renderPlanner();
  };
  $("#pm-prev").onclick = () => shift(-1);
  $("#pm-next").onclick = () => shift(1);
  $("#pm-today").onclick = () => {
    plannerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderPlanner();
  };

  const schedule = async (id, body) => {
    try {
      await api(`/clips/${id}/schedule`, { method: "PUT", body });
    } catch (e) {
      toast(e.message, true);
    }
    renderPlanner();
  };
  main.querySelectorAll(".pcard").forEach((el) => {
    el.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", el.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    };
    el.ondragend = () => el.classList.remove("dragging");
    $(".pcheck", el).onclick = () => schedule(el.dataset.id, { posted: $(".pcheck", el).dataset.posted !== "1" });
  });
  main.querySelectorAll(".pdrop").forEach((zone) => {
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add("over");
    };
    zone.ondragleave = (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("over");
    };
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const id = e.dataTransfer.getData("text/plain");
      if (id) schedule(id, { scheduledFor: zone.dataset.day || null });
    };
  });
}

// ---------- video view ----------
async function renderVideo(id) {
  currentVideoId = id;
  const d = await api(`/videos/${id}`);
  const { video, transcript, suggestions, clips, jobs } = d;
  const ytAt = (t) => `${video.url}&t=${Math.floor(t)}s`;

  main.innerHTML = "";
  main.append(
    h(`<div class="video-head">
      <img src="${esc(video.thumbnail || "")}" alt="" />
      <div>
        <h1>${esc(video.title)}</h1>
        <div class="muted">${esc(video.channel || "")} · ${dur(video.duration || 0)} · ${video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : ""}</div>
        <div class="row" style="margin-top:10px">
          <a class="btn small" href="${esc(video.url)}" target="_blank" rel="noopener">Open on YouTube ↗</a>
          <button class="btn small danger" id="del-video">Remove from library</button>
        </div>
      </div>
    </div>`),
  );
  $("#del-video").onclick = async () => {
    if (!confirm("Remove this video and its suggestions from the library? Built clips are kept.")) return;
    await api(`/videos/${id}`, { method: "DELETE" });
    await loadVideos();
    location.hash = "#/";
  };

  // Transcript card
  const tCard = h(`<div class="card">
    <h3>1 · Transcript <span id="t-status"></span><span class="spacer"></span></h3>
    <div class="row">
      ${transcript
        ? `<span class="badge ok">${esc(transcript.source)}</span><span class="badge">${esc(transcript.lang)}</span><span class="muted small">${transcript.wordCount.toLocaleString()} words · fetched ${new Date(transcript.fetchedAt).toLocaleString()}</span>`
        : `<span class="muted">No transcript yet.</span>`}
    </div>
    <div class="row">
      <label class="field">Source
        <select id="t-method"><option value="youtube">YouTube captions (fast)</option><option value="whisper">Whisper (local, slow, more accurate)</option></select>
      </label>
      <label class="field">Language
        <input id="t-lang" list="t-langs" placeholder="auto (e.g. en, ur, hi)" value="${esc(transcript?.lang?.replace("-orig", "") || video.language || "")}" style="width:170px" />
        <datalist id="t-langs"></datalist>
      </label>
      <button class="btn small" id="t-tracks" style="align-self:flex-end">List YouTube tracks</button>
      <button class="btn ${transcript ? "" : "primary"}" id="t-fetch" style="align-self:flex-end">${transcript ? "Re-fetch transcript" : "Fetch transcript"}</button>
    </div>
    <pre class="log" id="t-log" hidden></pre>
    ${transcript ? `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Show timestamped transcript (${transcript.segments.length} lines)</summary>
      <div class="transcript" id="transcript">${transcript.segments
        .map((s) => `<div class="seg" data-start="${s.start}" data-end="${s.end}"><a href="${esc(ytAt(s.start))}" target="_blank">${fmt(s.start)}</a><span>${esc(s.text)}</span></div>`)
        .join("")}</div></details>` : ""}
  </div>`);
  main.append(tCard);
  $("#t-tracks", tCard).onclick = async (e) => {
    e.target.disabled = true;
    try {
      const t = await api(`/videos/${id}/caption-tracks`);
      const langs = [...t.manual.map((l) => [l, "manual"]), ...t.auto.filter((l) => l.endsWith("-orig") || !l.includes("-")).map((l) => [l, "auto"])];
      $("#t-langs").innerHTML = langs.map(([l, k]) => `<option value="${esc(l)}">${k}</option>`).join("");
      toast(`Video language: ${t.language || "unknown"} · manual: ${t.manual.join(", ") || "none"} · ${t.auto.length} auto tracks`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  };
  const tJobOpts = { logEl: () => $("#t-log"), statusEl: () => $("#t-status"), onDone: (j) => j.status === "done" && (loadVideos(), renderVideo(id)) };
  $("#t-fetch", tCard).onclick = async () => {
    try {
      const job = await api(`/videos/${id}/transcript`, { method: "POST", body: { method: $("#t-method").value, lang: $("#t-lang").value.trim() || undefined } });
      watchJob(job, tJobOpts);
    } catch (err) {
      toast(err.message, true);
    }
  };

  // Suggest card
  const sCard = h(`<div class="card ${transcript ? "" : "disabled-block"}">
    <h3>2 · Viral clip suggestions <span id="s-status"></span><span class="spacer"></span></h3>
    <div class="row">
      <label class="field">Clips<input id="s-count" type="number" min="1" max="20" value="5" style="width:70px" /></label>
      <label class="field">Min sec<input id="s-min" type="number" min="10" max="115" value="30" style="width:80px" /></label>
      <label class="field">Max sec<input id="s-max" type="number" min="15" max="120" value="90" style="width:80px" /></label>
      <label class="field" style="flex:1;min-width:220px">Direction for Claude (optional)<input id="s-guide" placeholder="e.g. focus on money advice, avoid intros and ads" /></label>
      <label class="inline small muted" style="align-self:flex-end;padding-bottom:8px"><input type="checkbox" id="s-replace" ${suggestions.length ? "" : "checked"} /> replace existing</label>
      <button class="btn primary" id="s-go" style="align-self:flex-end">Suggest clips with Claude</button>
    </div>
    <pre class="log" id="s-log" hidden></pre>
    <div class="suggestions" id="suggestions" style="margin-top:14px"></div>
  </div>`);
  main.append(sCard);
  const sJobOpts = { logEl: () => $("#s-log"), statusEl: () => $("#s-status"), onDone: (j) => j.status === "done" && (loadVideos(), renderVideo(id)) };
  $("#s-go", sCard).onclick = async () => {
    try {
      const job = await api(`/videos/${id}/suggest`, {
        method: "POST",
        body: {
          count: +$("#s-count").value,
          minSeconds: +$("#s-min").value,
          maxSeconds: Math.min(120, +$("#s-max").value),
          guidance: $("#s-guide").value.trim(),
          replace: $("#s-replace").checked,
        },
      });
      watchJob(job, sJobOpts);
    } catch (err) {
      toast(err.message, true);
    }
  };

  const segs = transcript?.segments || [];
  const excerpt = (a, b) => segs.filter((s) => s.end > a && s.start < b).map((s) => s.text).join(" ");
  const sWrap = $("#suggestions", sCard);
  if (!suggestions.length) sWrap.innerHTML = `<div class="muted small">No suggestions yet.</div>`;
  for (const s of suggestions) {
    const madeClips = clips.filter((c) => c.suggestionId === s.id);
    const el = h(`<div class="sugg">
      <div class="row" style="justify-content:space-between"><div class="title">${esc(s.title)}</div><div class="score">★ ${Number(s.score).toFixed(0)}/10</div></div>
      <div class="hook">${esc(s.hook)}</div>
      <div class="time-edit">
        <input class="st" value="${fmt(s.start)}" title="start" /> → <input class="en" value="${fmt(s.end)}" title="end" />
        <span class="d muted">${dur(s.end - s.start)}</span>
        <a href="${esc(ytAt(s.start))}" target="_blank" class="muted" title="Watch on YouTube">▶</a>
      </div>
      <div class="reason">${esc(s.reason)}</div>
      <div class="excerpt">${esc(excerpt(s.start, s.end))}</div>
      <div class="row">
        <button class="btn primary small make">✂ Create clip</button>
        ${madeClips.map((c) => `<a class="btn small" href="#/clip/${c.id}">Open clip ${c.status !== "ready" ? `(${esc(c.status)})` : ""}</a>`).join("")}
        <span style="flex:1"></span>
        <button class="btn small danger del" title="Discard suggestion">✕</button>
      </div>
    </div>`);
    const upd = () => {
      const a = parseTime($(".st", el).value), b = parseTime($(".en", el).value);
      $(".d", el).textContent = b > a ? dur(b - a) : "invalid";
      $(".d", el).style.color = b - a > 120 ? "var(--danger)" : "";
    };
    $(".st", el).oninput = upd;
    $(".en", el).oninput = upd;
    $(".make", el).onclick = async (e) => {
      const start = parseTime($(".st", el).value), end = parseTime($(".en", el).value);
      if (!(end > start)) return toast("Invalid start/end", true);
      e.target.disabled = true;
      try {
        const { clip } = await api("/clips", { method: "POST", body: { suggestionId: s.id, start, end } });
        await loadVideos();
        location.hash = `#/clip/${clip.id}`;
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    };
    $(".del", el).onclick = async () => {
      await api(`/suggestions/${s.id}`, { method: "DELETE" });
      el.remove();
      loadVideos();
    };
    sWrap.append(el);
  }

  // Clips card
  if (clips.length) {
    main.append(
      h(`<div class="card"><h3>3 · Clips</h3><div class="row">${clips
        .map((c) => `<a class="btn" href="#/clip/${c.id}">${esc(c.title)} <span class="badge ${c.status === "ready" ? "ok" : c.status === "error" ? "err" : "on"}">${esc(c.status)}</span></a>`)
        .join("")}</div></div>`),
    );
  }

  for (const j of jobs.filter((j) => j.status === "running")) {
    if (j.kind === "transcript") watchJob(j, tJobOpts);
    if (j.kind === "suggest") watchJob(j, sJobOpts);
  }
}

// ---------- clip view ----------
let clipState = null; // { clip, data, dirty }

async function renderClip(id) {
  const d = await api(`/clips/${id}`);
  const { clip, video, data, captionStyles, jobs, studio, projectDir } = d;
  currentVideoId = clip.videoId;
  clipState = { clip, data, dirty: false, tab: clipState?.clip.id === id ? clipState.tab : "cues" };

  main.innerHTML = "";
  main.append(
    h(`<div class="row" style="margin-bottom:16px">
      <a href="#/video/${clip.videoId}" class="btn small">← ${esc(video?.title?.slice(0, 50) || "Back")}</a>
      <input id="c-title" value="${esc(clip.title)}" style="flex:1;font-size:18px;font-weight:600;background:none;border-color:transparent" />
      <span class="muted mono">${fmt(clip.start)} → ${fmt(clip.end)} · ${dur(clip.duration)}</span>
      <button class="btn small danger" id="c-del">Delete clip</button>
    </div>`),
    h(`<div class="row small" style="margin:-6px 0 16px">
      <label class="inline muted">Post on <input type="date" id="c-sched" value="${esc(clip.scheduledFor || "")}" style="padding:3px 6px" /></label>
      <label class="inline muted"><input type="checkbox" id="c-posted" ${clip.postedAt ? "checked" : ""} /> Posted</label>
      <a href="#/planner" class="muted">Open planner →</a>
    </div>`),
  );
  $("#c-sched").onchange = (e) =>
    api(`/clips/${id}/schedule`, { method: "PUT", body: { scheduledFor: e.target.value || null } }).then(() => toast(e.target.value ? "Scheduled" : "Unscheduled"), (err) => toast(err.message, true));
  $("#c-posted").onchange = (e) =>
    api(`/clips/${id}/schedule`, { method: "PUT", body: { posted: e.target.checked } }).then(() => toast(e.target.checked ? "Marked as posted" : "Marked as not posted"), (err) => toast(err.message, true));
  $("#c-del").onclick = async () => {
    if (!confirm("Delete this clip and its HyperFrames project?")) return;
    await api(`/clips/${id}`, { method: "DELETE" });
    await loadVideos();
    location.hash = `#/video/${clip.videoId}`;
  };
  $("#c-title").onchange = (e) => api(`/clips/${id}`, { method: "PUT", body: { title: e.target.value } }).then(() => toast("Title saved"));

  if (clip.status !== "ready" || !data) {
    const build = jobs.find((j) => j.kind === "build");
    main.append(
      h(`<div class="card"><h3>Building clip <span id="b-status">${build ? jobStatus(build) : `<span class="badge ${clip.status === "error" ? "err" : ""}">${esc(clip.status)}</span>`}</span></h3>
        <div class="muted small">Download source → ffmpeg cut → HyperFrames project → captions from transcript.</div>
        ${clip.error ? `<pre class="log">${esc(clip.error)}</pre><div class="row" style="margin-top:10px"><button class="btn primary small" id="b-retry">Retry build</button></div>` : ""}
        <pre class="log" id="b-log" ${build ? "" : "hidden"}>${esc((build?.tail || []).join("\n"))}</pre></div>`),
    );
    const bOpts = { logEl: () => $("#b-log"), statusEl: () => $("#b-status"), onDone: () => (loadVideos(), renderClip(id)) };
    if (build?.status === "running") watchJob(build, bOpts);
    const retry = $("#b-retry");
    if (retry) retry.onclick = async () => {
      retry.disabled = true;
      watchJob(await api(`/clips/${id}/rebuild`, { method: "POST" }), bOpts);
    };
    return;
  }

  const grid = h(`<div class="clip-grid"><div id="col-left"></div><div id="col-right"></div></div>`);
  main.append(grid);
  const left = $("#col-left", grid);
  const right = $("#col-right", grid);
  const s = data.settings;

  // ---- Captions editor ----
  const capCard = h(`<div class="card">
    <h3>Captions <span class="dirty" id="dirty"></span><span class="spacer"></span>
      <label class="inline small"><input type="checkbox" id="cap-on" ${s.captions.enabled ? "checked" : ""}/> Show captions</label>
      <button class="btn primary small" id="save">Save</button>
    </h3>
    <video class="source-player" id="src-player" src="/clip-assets/${clip.id}/clip.mp4" controls preload="metadata"></video>
    <div class="row small muted" style="margin:8px 0">Click a row number to play from that cue. Fix wording directly — edits are saved to <span class="mono">captions.srt</span> and <span class="mono">clip-data.js</span> in the project.</div>
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <div class="tabs"><button data-tab="cues">Cues</button><button data-tab="srt">SRT file</button></div>
      <div class="row">
        <label class="inline small muted">Words/cue <input type="number" id="regroup-n" min="1" max="12" value="${s.captions.maxWordsPerCue || 4}" style="width:56px;padding:4px 6px" /></label>
        <button class="btn small" id="regroup" ${data.hasWords ? "" : "disabled"} title="Rebuild cues from word timings (discards text edits)">Regroup</button>
        <button class="btn small" id="translit" title="Rewrite non-Latin script in English letters with Claude (timings unchanged)">Transliterate to English</button>
      </div>
    </div>
    <div id="cap-body"></div>
    <div class="row" style="margin-top:12px">
      <label class="field">Re-transcribe this clip with Whisper — language
        <input id="wh-lang" placeholder="e.g. en, ur, hi" style="width:140px" /></label>
      <label class="field">Model
        <select id="wh-model"><option value="">auto</option><option>small.en</option><option>medium.en</option><option>large-v3</option></select></label>
      <button class="btn small" id="wh-go" style="align-self:flex-end">Re-transcribe</button>
      <span id="wh-status" style="align-self:flex-end"></span>
    </div>
    <pre class="log" id="wh-log" hidden></pre>
  </div>`);
  left.append(capCard);

  const markDirty = () => {
    clipState.dirty = true;
    $("#dirty").textContent = "● unsaved";
  };
  const player = $("#src-player", capCard);

  function renderCues() {
    const body = $("#cap-body", capCard);
    for (const b of capCard.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === clipState.tab);
    if (clipState.tab === "srt") {
      body.innerHTML = `<textarea class="srt" id="srt" spellcheck="false"></textarea>`;
      $("#srt").value = toSrt(clipState.data.cues);
      $("#srt").oninput = markDirty;
      return;
    }
    body.innerHTML = `<div class="cues" id="cues"></div><div class="row" style="margin-top:8px"><button class="btn small" id="add-cue">+ Add cue at playhead</button></div>`;
    const list = $("#cues", body);
    clipState.data.cues.forEach((c, i) => {
      const row = h(`<div class="cue-row" data-i="${i}">
        <span class="idx" title="Play from here">${i + 1}</span>
        <input class="t st" value="${c.start.toFixed(2)}" />
        <input class="t en" value="${c.end.toFixed(2)}" />
        <input class="tx" value="${esc(c.text)}" />
        <span class="acts">
          <button class="merge" title="Merge with next">⤓</button>
          <button class="split" title="Split in half">✂</button>
          <button class="del" title="Delete">✕</button>
        </span>
      </div>`);
      $(".idx", row).onclick = () => {
        player.currentTime = c.start;
        player.play();
      };
      $(".st", row).onchange = (e) => ((c.start = Number(e.target.value) || 0), markDirty());
      $(".en", row).onchange = (e) => ((c.end = Number(e.target.value) || 0), markDirty());
      $(".tx", row).oninput = (e) => {
        c.text = e.target.value;
        delete c.words; // word timings no longer match; composition spreads words evenly
        markDirty();
      };
      $(".del", row).onclick = () => {
        clipState.data.cues.splice(i, 1);
        markDirty();
        renderCues();
      };
      $(".merge", row).onclick = () => {
        const n = clipState.data.cues[i + 1];
        if (!n) return;
        c.end = n.end;
        c.text = `${c.text} ${n.text}`;
        c.words = c.words && n.words ? [...c.words, ...n.words] : undefined;
        clipState.data.cues.splice(i + 1, 1);
        markDirty();
        renderCues();
      };
      $(".split", row).onclick = () => {
        const words = c.text.split(/\s+/);
        if (words.length < 2) return;
        const k = Math.ceil(words.length / 2);
        const mid = c.words?.[k]?.start ?? c.start + ((c.end - c.start) * k) / words.length;
        const second = { start: mid, end: c.end, text: words.slice(k).join(" "), words: c.words?.slice(k) };
        c.end = mid;
        c.text = words.slice(0, k).join(" ");
        c.words = c.words?.slice(0, k);
        clipState.data.cues.splice(i + 1, 0, second);
        markDirty();
        renderCues();
      };
      list.append(row);
    });
    $("#add-cue", body).onclick = () => {
      const t = player.currentTime || 0;
      clipState.data.cues.push({ start: +t.toFixed(2), end: +(t + 1.5).toFixed(2), text: "new caption" });
      clipState.data.cues.sort((a, b) => a.start - b.start);
      markDirty();
      renderCues();
    };
  }
  renderCues();

  for (const b of capCard.querySelectorAll(".tabs button")) {
    b.onclick = () => {
      if (clipState.tab === "srt") syncFromSrt();
      clipState.tab = b.dataset.tab;
      renderCues();
    };
  }
  function syncFromSrt() {
    const ta = $("#srt");
    if (ta) clipState.data.cues = fromSrt(ta.value);
  }

  player.ontimeupdate = () => {
    const t = player.currentTime;
    capCard.querySelectorAll(".cue-row").forEach((r) => {
      const c = clipState.data.cues[+r.dataset.i];
      r.classList.toggle("playing", !!c && t >= c.start && t < c.end);
    });
  };

  $("#regroup", capCard).onclick = async () => {
    if (!confirm("Rebuild cues from the transcript word timings? Manual text edits will be lost.")) return;
    const r = await api(`/clips/${id}/regroup`, { method: "POST", body: { maxWords: +$("#regroup-n").value } });
    clipState.data.cues = r.cues;
    clipState.data.settings = r.settings;
    clipState.dirty = false;
    $("#dirty").textContent = "";
    renderCues();
    toast("Cues regrouped");
  };

  $("#translit", capCard).onclick = async (e) => {
    if (clipState.tab === "srt") syncFromSrt();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Transliterating…`;
    try {
      const r = await api(`/clips/${id}/transliterate`, { method: "POST", body: { cues: clipState.data.cues } });
      const changed = r.cues.filter((c, i) => c.text !== clipState.data.cues[i]?.text).length;
      clipState.data.cues = r.cues;
      renderCues();
      if (changed) {
        markDirty();
        toast(`Transliterated ${changed} cue${changed === 1 ? "" : "s"} — review, then Save`);
      } else toast("Nothing to transliterate — captions are already in English letters");
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Transliterate to English";
    }
  };

  $("#wh-go", capCard).onclick = async () => {
    if (clipState.dirty && !confirm("Unsaved caption edits will be replaced. Continue?")) return;
    const job = await api(`/clips/${id}/retranscribe`, { method: "POST", body: { lang: $("#wh-lang").value.trim() || undefined, model: $("#wh-model").value || undefined } });
    watchJob(job, { logEl: () => $("#wh-log"), statusEl: () => $("#wh-status"), onDone: (j) => j.status === "done" && renderClip(id) });
  };

  // ---- Style & layout ----
  const styleCard = h(`<div class="card">
    <h3>Style &amp; layout</h3>
    <div class="settings-grid">
      <label class="field">Framing
        <select id="layout"><option value="crop">Crop to fill 9:16</option><option value="fit">Full frame + blurred fill</option></select></label>
      <label class="field">Horizontal focus <input type="range" id="focusX" min="0" max="1" step="0.01" value="${s.focusX}" /></label>
      <label class="field">Zoom <input type="range" id="zoom" min="1" max="2" step="0.01" value="${s.zoom}" /></label>
      <label class="field">Caption style
        <select id="cap-style">${Object.entries(captionStyles).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
      <label class="field">Vertical position (%) <input type="range" id="cap-y" min="10" max="92" value="${s.captions.positionY}" /></label>
      <label class="field">Font size (px) <input type="number" id="cap-size" min="30" max="160" value="${s.captions.fontSize}" /></label>
      <label class="field">Highlight colour <input type="color" id="cap-hi" value="${s.captions.highlight}" /></label>
      <label class="field">Uppercase <input type="checkbox" id="cap-upper" ${s.captions.uppercase ? "checked" : ""} /></label>
    </div>
    <div class="row" style="margin-top:14px">
      <label class="inline small"><input type="checkbox" id="hook-on" ${s.hook.enabled ? "checked" : ""} /> Hook text</label>
      <input id="hook-text" value="${esc(s.hook.text)}" style="flex:1" placeholder="On-screen hook for the first seconds" />
      <label class="inline small muted">for <input type="number" id="hook-dur" min="1" max="15" step="0.5" value="${s.hook.duration}" style="width:64px" /> s</label>
    </div>
  </div>`);
  left.append(styleCard);
  $("#layout", styleCard).value = s.layout;
  $("#cap-style", styleCard).value = s.captions.style;
  styleCard.addEventListener("input", markDirty);
  $("#cap-on", capCard).onchange = markDirty;

  function collectSettings() {
    return {
      layout: $("#layout").value,
      focusX: +$("#focusX").value,
      zoom: +$("#zoom").value,
      captions: {
        enabled: $("#cap-on").checked,
        style: $("#cap-style").value,
        positionY: +$("#cap-y").value,
        fontSize: +$("#cap-size").value,
        highlight: $("#cap-hi").value,
        uppercase: $("#cap-upper").checked,
      },
      hook: { enabled: $("#hook-on").checked, text: $("#hook-text").value, duration: +$("#hook-dur").value },
    };
  }

  async function save() {
    if (clipState.tab === "srt") syncFromSrt();
    try {
      const r = await api(`/clips/${id}`, { method: "PUT", body: { settings: collectSettings(), cues: clipState.data.cues } });
      clipState.data.cues = r.cues;
      clipState.data.settings = r.settings;
      clipState.dirty = false;
      $("#dirty").textContent = "";
      renderCues();
      toast("Saved — Studio preview reloads automatically");
    } catch (err) {
      toast(err.message, true);
    }
  }
  $("#save", capCard).onclick = save;
  document.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s" && location.hash.startsWith("#/clip/")) {
      e.preventDefault();
      save();
    }
  };

  // ---- Edit commands (Claude Code + HyperFrames skills) ----
  const cmdJob = jobs.filter((j) => j.kind === "command").pop();
  const history = clip.agentHistory || [];
  const cmdCard = h(`<div class="card">
    <h3>Edit with HyperFrames <span id="cmd-status">${cmdJob?.status === "running" ? jobStatus(cmdJob) : ""}</span><span class="spacer"></span>
      ${clip.agentSessionId ? `<button class="btn small" id="cmd-reset" title="Start a fresh Claude session for this clip">New session</button>` : ""}
    </h3>
    <div class="cmd-history" id="cmd-history">${history
      .slice(-6)
      .map((e) => `<div class="cmd-item"><div class="cmd-prompt">» ${esc(e.prompt)}</div>${e.summary ? `<div class="cmd-summary ${e.ok ? "" : "err"}">${esc(e.summary)}</div>` : ""}</div>`)
      .join("")}</div>
    <form id="cmd-form" class="cmd-form">
      <textarea id="cmd-input" rows="2" placeholder="e.g. add a progress bar at the top · make captions pop in with a bounce · zoom in slowly during the first 5 seconds · change hook colour to gold"></textarea>
      <div class="row" style="justify-content:space-between">
        <span class="muted small">Claude Code edits this clip's HyperFrames project. The preview reloads when it's done. ⌘↵ to send</span>
        <div class="row">
          <button type="button" class="btn small danger" id="cmd-cancel" hidden>Stop</button>
          <button type="submit" class="btn primary small" id="cmd-send">Send</button>
        </div>
      </div>
    </form>
    <pre class="log" id="cmd-log" ${cmdJob?.status === "running" ? "" : "hidden"}></pre>
  </div>`);
  right.append(cmdCard);
  let activeCmd = null;
  const cmdOpts = {
    logEl: () => $("#cmd-log"),
    statusEl: () => $("#cmd-status"),
    onDone: (j) => {
      activeCmd = null;
      if (clipState.dirty) {
        toast("Edit applied. You have unsaved caption edits, so reload the clip to see caption/setting changes.");
        $("#cmd-send").disabled = false;
        $("#cmd-cancel").hidden = true;
      } else renderClip(id);
    },
  };
  const startCmd = (job) => {
    activeCmd = job;
    $("#cmd-send").disabled = true;
    $("#cmd-cancel").hidden = false;
    watchJob(job, cmdOpts);
  };
  $("#cmd-form", cmdCard).onsubmit = async (e) => {
    e.preventDefault();
    const prompt = $("#cmd-input").value.trim();
    if (!prompt) return;
    if (clipState.dirty) await save();
    try {
      const job = await api(`/clips/${id}/command`, { method: "POST", body: { prompt } });
      $("#cmd-input").value = "";
      $("#cmd-history").insertAdjacentHTML("beforeend", `<div class="cmd-item"><div class="cmd-prompt">» ${esc(prompt)}</div></div>`);
      startCmd(job);
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#cmd-input", cmdCard).onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") $("#cmd-form").requestSubmit();
  };
  $("#cmd-cancel", cmdCard).onclick = () => activeCmd && api(`/jobs/${activeCmd.id}/cancel`, { method: "POST" });
  const resetBtn = $("#cmd-reset", cmdCard);
  if (resetBtn) resetBtn.onclick = async () => {
    await api(`/clips/${id}/command/reset`, { method: "POST" });
    toast("Next command starts a fresh session");
    resetBtn.remove();
  };
  if (cmdJob?.status === "running") startCmd(cmdJob);

  // ---- Preview (HyperFrames Studio) ----
  const studioUrl = studio.running && studio.clipId === clip.id ? studio.url : null;
  const pCard = h(`<div class="card">
    <h3>Preview <span class="spacer"></span>
      <button class="btn small primary" id="studio-go">${studioUrl ? "Reload preview" : "Open HyperFrames preview"}</button>
      <a class="btn small" id="studio-tab" target="_blank" rel="noopener" ${studioUrl ? `href="${studioUrl}"` : "hidden"}>New tab ↗</a>
    </h3>
    <div id="studio-body" class="muted small">Starts HyperFrames Studio for this clip. Caption edits hot-reload after you Save. You can also fine-tune anything in Studio's timeline.</div>
    <div class="muted small mono" style="margin-top:8px">${esc(projectDir)}</div>
  </div>`);
  right.append(pCard);
  const showStudio = (url) => {
    $("#studio-body").innerHTML = `<iframe class="studio-frame" src="${url}" allow="autoplay; fullscreen"></iframe>`;
    $("#studio-tab").href = url;
    $("#studio-tab").hidden = false;
  };
  if (studioUrl) showStudio(studioUrl);
  $("#studio-go", pCard).onclick = async (e) => {
    if (clipState.dirty) await save();
    e.target.disabled = true;
    $("#studio-body").innerHTML = `<span class="status"><span class="spinner"></span> Starting HyperFrames Studio…</span>`;
    try {
      const st = await api(`/clips/${id}/studio`, { method: "POST" });
      if (!st.ready) throw new Error(`Studio did not start:\n${(st.tail || []).join("\n")}`);
      showStudio(st.url + (studioUrl ? "" : ""));
    } catch (err) {
      $("#studio-body").innerHTML = `<pre class="log">${esc(err.message)}</pre>`;
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Reload preview";
    }
  };

  // ---- Render ----
  const renderJob = jobs.filter((j) => j.kind === "render").pop();
  const rCard = h(`<div class="card">
    <h3>Render <span id="r-status">${renderJob ? jobStatus(renderJob) : ""}</span><span class="spacer"></span>
      <select id="r-quality" style="padding:5px 8px"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high" selected>High</option></select>
      <button class="btn primary small" id="r-go">Render MP4</button>
    </h3>
    <pre class="log" id="r-log" ${renderJob ? "" : "hidden"}>${esc((renderJob?.tail || []).join("\n"))}</pre>
    <div class="renders" id="renders">${(clip.renders || [])
      .slice()
      .reverse()
      .map((r, i) => `<div>${i === 0 ? `<video src="/renders/${encodeURIComponent(r.file)}" controls preload="metadata"></video>` : ""}
        <div class="row small"><a href="/renders/${encodeURIComponent(r.file)}" download>⬇ ${esc(r.file)}</a><span class="muted">${esc(r.quality)} · ${new Date(r.at).toLocaleString()}</span></div></div>`)
      .join("") || `<div class="muted small">No renders yet.</div>`}</div>
  </div>`);
  right.append(rCard);
  const rOpts = { logEl: () => $("#r-log"), statusEl: () => $("#r-status"), onDone: (j) => j.status === "done" && (toast("Render complete"), renderClip(id)) };
  $("#r-go", rCard).onclick = async () => {
    if (clipState.dirty) await save();
    const job = await api(`/clips/${id}/render`, { method: "POST", body: { quality: $("#r-quality").value } });
    watchJob(job, rOpts);
  };
  for (const j of jobs.filter((j) => j.status === "running")) {
    if (j.kind === "render") watchJob(j, rOpts);
    if (j.kind === "retranscribe") watchJob(j, { logEl: () => $("#wh-log"), statusEl: () => $("#wh-status"), onDone: () => renderClip(id) });
  }
}

// SRT conversion (mirrors server/composition.js)
function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}
function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}
function fromSrt(srt) {
  const toSec = (t) => {
    const [hh, mm, rest] = t.trim().replace(".", ",").split(":");
    const [ss, ms] = rest.split(",");
    return +hh * 3600 + +mm * 60 + +ss + +(ms || 0) / 1000;
  };
  const prev = clipState?.data?.cues || [];
  const out = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const text = lines.slice(ti + 1).join(" ").trim();
    if (!text) continue;
    const cue = { start: toSec(a), end: toSec(b), text };
    // Keep word timings when a cue is unchanged.
    const same = prev.find((p) => p.text === text && Math.abs(p.start - cue.start) < 0.01 && p.words);
    if (same) cue.words = same.words;
    out.push(cue);
  }
  return out;
}

window.addEventListener("beforeunload", (e) => {
  if (clipState?.dirty) e.preventDefault();
});

syncSortSelect();
await loadVideos();
route();
