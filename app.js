const COLORS = [
  ["#6366f1", "#a855f7"],
  ["#f97316", "#ef4444"],
  ["#06b6d4", "#3b82f6"],
  ["#22c55e", "#14b8a6"],
  ["#ec4899", "#f43f5e"],
  ["#eab308", "#f97316"],
  ["#0f172a", "#475569"],
];

const $ = (sel) => document.querySelector(sel);

const state = {
  mode: "demo",
  ai: false,
  whisper: null,
  spaces: [],
  projects: [],
  currentSpace: null,
  filter: "all",
  query: "",
  selectedColor: 0,
};

// ---------------------------------------------------------------------------
// API: the real server when it is running, otherwise a browser-only demo.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Noe gikk galt (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch (e) {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

const serverApi = {
  listSpaces: () => request("GET", "/api/spaces"),
  createSpace: (name, color) => request("POST", "/api/spaces", { name, color }),
  deleteSpace: (id) => request("DELETE", `/api/spaces/${id}`),
  listProjects: (spaceId) => request("GET", `/api/spaces/${spaceId}/projects`),
  createFromLink: (spaceId, url) => request("POST", "/api/projects", { space_id: spaceId, url }),
  deleteProject: (id) => request("DELETE", `/api/projects/${id}`),
  upload(spaceId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("space_id", spaceId);
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/projects/upload");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        let message = `Opplastingen feilet (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).detail || message;
        } catch (e) {}
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error("Mistet kontakten med serveren under opplastingen"));
      xhr.send(form);
    });
  },
};

const DEMO_KEY = "olliviero.demo.v3";
const DEMO_MESSAGE =
  "Dette er bare en forhåndsvisning med eksempler, så videoen ble ikke hentet. For å lage ekte klipp må serveren kjøre (se README), og du må åpne siden via den.";
const DEMO_TITLES = [
  "Ingen snakker om dette",
  "Det største feilgrepet jeg gjorde",
  "Slik vokste kanalen på 30 dager",
  "Dette rådet endret alt",
  "Hvorfor de fleste gir opp for tidlig",
  "Den ærligste praten vi har hatt",
  "Tre ting jeg skulle ønske jeg visste",
];

function demoClips(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `clip${i + 1}`,
    title: DEMO_TITLES[(i + Math.floor(Math.random() * 7)) % DEMO_TITLES.length],
    caption: "Eksempelklipp fra demomodus. Start serveren for å lage ekte klipp fra videoene dine.",
    hashtags: ["podkast", "tips", "shorts"],
    score: 60 + Math.floor(Math.random() * 36),
    duration: 20 + Math.floor(Math.random() * 40),
    video: null,
    thumb: null,
  }));
}

function demoSeed() {
  const now = Date.now();
  const spaces = [
    { id: "podkast", name: "Podkast", color: 0, created: now - 30 * 86400e3 },
    { id: "youtube", name: "YouTube-kanal", color: 2, created: now - 40 * 86400e3 },
    { id: "webinar", name: "Webinarer", color: 3, created: now - 50 * 86400e3 },
  ];
  const project = (id, spaceId, title, clips, ago) => ({
    id, space_id: spaceId, source: title, kind: "url", title, status: "ready", stage: "Ferdig",
    progress: 100, error: null, duration: 1800 + clips * 120, picked_by: "demo",
    clips: demoClips(clips), created: now - ago, updated: now - ago,
  });
  return {
    spaces,
    projects: [
      project("p1", "podkast", "Episode 12: Å starte for seg selv", 5, 2 * 3600e3),
      project("p2", "podkast", "Episode 11: Penger og motivasjon", 4, 3 * 86400e3),
      project("p3", "youtube", "Vlogg fra Lofoten", 6, 26 * 3600e3),
      project("p4", "webinar", "Webinar: Kom i gang med video", 3, 5 * 86400e3),
    ],
  };
}

function demoLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
    if (saved && Array.isArray(saved.spaces)) return saved;
  } catch (e) {}
  return demoSeed();
}

const demo = demoLoad();
function demoSave() {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(demo));
  } catch (e) {}
}

const demoApi = {
  async listSpaces() {
    return demo.spaces.map((s) => {
      const projects = demo.projects.filter((p) => p.space_id === s.id);
      const active = projects.filter((p) => p.status !== "ready" && p.status !== "failed");
      return {
        ...s,
        videos: projects.length,
        clips: projects.reduce((n, p) => n + p.clips.length, 0),
        status: active.length ? "processing" : "ready",
        progress: Math.max(0, ...active.map((p) => p.progress)),
        updated: Math.max(s.created, ...projects.map((p) => p.updated)),
        thumbs: [],
      };
    });
  },
  async createSpace(name, color) {
    const space = { id: Math.random().toString(36).slice(2, 10), name, color, created: Date.now() };
    demo.spaces.unshift(space);
    demoSave();
    return space;
  },
  async deleteSpace(id) {
    demo.spaces = demo.spaces.filter((s) => s.id !== id);
    demo.projects = demo.projects.filter((p) => p.space_id !== id);
    demoSave();
  },
  async listProjects(spaceId) {
    return demo.projects.filter((p) => p.space_id === spaceId);
  },
  async createFromLink() {
    throw new Error(DEMO_MESSAGE);
  },
  async upload() {
    throw new Error(DEMO_MESSAGE);
  },
  async deleteProject(id) {
    demo.projects = demo.projects.filter((p) => p.id !== id);
    demoSave();
  },
};

let api = demoApi;

// ---------------------------------------------------------------------------
// Helpers

function timeAgo(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "akkurat nå";
  if (minutes < 60) return `${minutes} min siden`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} t siden`;
  const days = Math.round(hours / 24);
  return days === 1 ? "i går" : `${days} dager siden`;
}

function clock(seconds) {
  seconds = Math.round(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function gradient(index) {
  const [a, b] = COLORS[index % COLORS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function isActive(item) {
  return !["ready", "failed"].includes(item.status);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

// Deleting asks for a second click instead of a confirm() dialog.
function confirmClick(button, message) {
  if (button.dataset.armed === "1") return true;
  button.dataset.armed = "1";
  toast(message);
  setTimeout(() => delete button.dataset.armed, 3000);
  return false;
}

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

// ---------------------------------------------------------------------------
// Rendering

function renderSidebar() {
  $("#spaceLinks").innerHTML = state.spaces
    .map((s) => `<li><a href="#space-${escapeHtml(s.id)}" class="${state.currentSpace === s.id ? "current" : ""}"><span class="dot" style="background:${gradient(s.color)}"></span>${escapeHtml(s.name)}</a></li>`)
    .join("");

  const target = $("#targetSpace");
  const current = state.currentSpace || target.value;
  target.innerHTML = state.spaces.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
  if (state.spaces.some((s) => s.id === current)) target.value = current;
  target.hidden = Boolean(state.currentSpace);

  document.querySelectorAll(".nav-item").forEach((a, i) => a.classList.toggle("active", i === 0 && !state.currentSpace));

  let engine;
  if (state.mode === "demo") {
    engine = `<div class="engine-title"><span class="status-dot off"></span>Demomodus</div><div class="engine-text">Start serveren for å lage ekte klipp.</div>`;
  } else {
    engine = `<div class="engine-title"><span class="status-dot ${state.ai ? "on" : "warn"}"></span>${state.ai ? "Claude velger klipp" : "Uten AI-utvalg"}</div><div class="engine-text">Transkripsjon med Whisper (${escapeHtml(state.whisper)})</div>`;
  }
  $("#engine").innerHTML = engine;
}

function renderNotice() {
  const notice = $("#notice");
  if (state.mode === "demo") {
    notice.textContent = "Forhåndsvisning: klippene her er bare eksempler, og lenker du limer inn blir ikke hentet. Ekte klipp krever at serveren kjører (se README).";
  } else if (!state.ai) {
    notice.textContent = "Klippene velges nå uten AI. Sett ANTHROPIC_API_KEY på serveren for å la Claude finne de beste øyeblikkene, skrive titler og gi poengsum.";
  }
  notice.hidden = state.mode === "server" && state.ai;
}

function spaceThumb(s) {
  if (s.thumbs && s.thumbs.length) {
    return s.thumbs.map((t) => `<img class="thumb-clip" src="${escapeHtml(t)}" alt="" loading="lazy">`).join("");
  }
  return '<span class="thumb-clip"></span><span class="thumb-clip"></span><span class="thumb-clip"></span>';
}

function renderHome() {
  const visible = state.spaces.filter((s) => {
    if (state.filter !== "all" && s.status !== state.filter) return false;
    return s.name.toLowerCase().includes(state.query);
  });

  const cards = visible.map((s) => {
    const processing = s.status === "processing";
    return `
      <article class="card" data-id="${escapeHtml(s.id)}">
        <div class="thumb" style="background:${gradient(s.color)}">
          ${spaceThumb(s)}
          <span class="badge ${s.status}">${processing ? `Behandler ${s.progress}%` : plural(s.clips, "klipp", "klipp")}</span>
          ${processing ? `<div class="progress"><span style="width:${s.progress}%"></span></div>` : ""}
        </div>
        <div class="card-body">
          <div>
            <h3 class="card-title">${escapeHtml(s.name)}</h3>
            <div class="card-meta">${plural(s.videos, "video", "videoer")} · ${timeAgo(s.updated)}</div>
          </div>
          <button class="card-menu" data-delete-space="${escapeHtml(s.id)}" aria-label="Slett ${escapeHtml(s.name)}" title="Slett">${TRASH}</button>
        </div>
      </article>`;
  });

  const showNewCard = state.filter === "all" && !state.query;
  if (showNewCard) {
    cards.push(`
      <button class="card new" id="newCard">
        <span class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
        Nytt space
      </button>`);
  }

  $("#grid").innerHTML = cards.join("");
  $("#empty").hidden = visible.length > 0 || showNewCard;
  $("#count").textContent = plural(visible.length, "space", "spaces");
}

function scoreClass(score) {
  return score >= 80 ? "high" : score >= 60 ? "mid" : "low";
}

function renderClip(project, clip) {
  const tags = (clip.hashtags || []).map((h) => `#${h}`).join(" ");
  const media = clip.thumb
    ? `<img src="${escapeHtml(clip.thumb)}" alt="" loading="lazy">`
    : `<div class="clip-placeholder" style="background:${gradient(project.title.length)}"><span>Eksempel</span></div>`;
  const download = clip.video
    ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(clip.video)}" download="${escapeHtml(clip.title)}.mp4">Last ned</a>`
    : `<button class="btn btn-outline btn-sm" disabled title="Ikke tilgjengelig i demomodus">Last ned</button>`;
  return `
    <article class="clip">
      <div class="clip-media" ${clip.video ? `data-play="${escapeHtml(clip.video)}"` : ""}>
        ${media}
        <span class="score ${scoreClass(clip.score)}" title="Anslått viralitet">${clip.score}</span>
        <span class="duration">${clock(clip.duration)}</span>
        ${clip.video ? '<span class="play"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg></span>' : ""}
      </div>
      <div class="clip-body">
        <h4 class="clip-title">${escapeHtml(clip.title)}</h4>
        <p class="clip-caption">${escapeHtml(clip.caption)} <span class="tags">${escapeHtml(tags)}</span></p>
        <div class="clip-actions">
          ${download}
          <button class="btn btn-ghost btn-sm" data-copy="${escapeHtml(`${clip.caption}\n\n${tags}`.trim())}">Kopier tekst</button>
        </div>
      </div>
    </article>`;
}

const PICKED_BY = { claude: "Valgt av Claude", heuristic: "Valgt uten AI", demo: "Demo" };

function renderProject(p) {
  const meta = [];
  if (p.kind === "url") {
    try {
      meta.push(new URL(p.source).hostname.replace(/^www\./, ""));
    } catch (e) {}
  } else {
    meta.push("Opplastet fil");
  }
  if (p.duration) meta.push(clock(p.duration));
  if (p.clips.length) meta.push(plural(p.clips.length, "klipp", "klipp"));
  if (p.picked_by && p.status === "ready") meta.push(PICKED_BY[p.picked_by] || "");
  meta.push(timeAgo(p.created));

  let status = "";
  if (isActive(p)) {
    status = `
      <div class="project-progress">
        <div class="progress-row"><span class="spinner"></span>${escapeHtml(p.stage)}<span class="muted">${p.progress}%</span></div>
        <div class="bar"><span style="width:${p.progress}%"></span></div>
      </div>`;
  } else if (p.status === "failed") {
    status = `<div class="project-error">${escapeHtml(p.error || "Noe gikk galt")}</div>`;
  }

  const clips = [...p.clips].sort((a, b) => b.score - a.score);
  return `
    <section class="project" data-project="${escapeHtml(p.id)}">
      <div class="project-head">
        <div class="project-info">
          <h3 class="project-title">${escapeHtml(p.title)}</h3>
          <div class="card-meta">${meta.filter(Boolean).map(escapeHtml).join(" · ")}</div>
        </div>
        <button class="card-menu" data-delete-project="${escapeHtml(p.id)}" aria-label="Slett video" title="Slett">${TRASH}</button>
      </div>
      ${status}
      ${clips.length ? `<div class="clips">${clips.map((c) => renderClip(p, c)).join("")}</div>` : ""}
    </section>`;
}

function renderSpace() {
  const space = state.spaces.find((s) => s.id === state.currentSpace);
  if (!space) return;
  const projects = state.projects.filter((p) => p.title.toLowerCase().includes(state.query) || p.clips.some((c) => c.title.toLowerCase().includes(state.query)));
  $("#pageTitle").textContent = space.name;
  $("#pageLead").textContent = `${plural(space.videos, "video", "videoer")} · ${plural(space.clips, "klipp", "klipp")}`;
  // Keep any playing video alive by only re-rendering when something changed.
  const html = projects.map(renderProject).join("");
  if ($("#projects").dataset.html !== html) {
    $("#projects").innerHTML = html;
    $("#projects").dataset.html = html;
  }
  $("#spaceEmpty").hidden = state.projects.length > 0;
}

function render() {
  renderSidebar();
  renderNotice();
  const inSpace = Boolean(state.currentSpace);
  $("#homeView").hidden = inSpace;
  $("#spaceView").hidden = !inSpace;
  $("#backBtn").hidden = !inSpace;
  if (inSpace) {
    renderSpace();
  } else {
    $("#pageTitle").textContent = "Spaces";
    $("#pageLead").textContent = "Samle videoene dine i spaces – én for hver kanal, kunde eller serie.";
    renderHome();
  }
}

// ---------------------------------------------------------------------------
// Data flow

async function refresh() {
  try {
    state.spaces = await api.listSpaces();
    if (state.currentSpace && !state.spaces.some((s) => s.id === state.currentSpace)) {
      state.currentSpace = null;
      history.replaceState(null, "", location.pathname);
    }
    state.projects = state.currentSpace ? await api.listProjects(state.currentSpace) : [];
  } catch (e) {
    toast(e.message);
  }
  render();
}

// The server is polled while anything is processing.
setInterval(() => {
  if (state.mode !== "server") return;
  const busy = state.currentSpace ? state.projects.some(isActive) : state.spaces.some((s) => s.status === "processing");
  if (busy) refresh();
}, 2000);

function route() {
  const match = location.hash.match(/^#space-(.+)$/);
  state.currentSpace = match ? decodeURIComponent(match[1]) : null;
  $("#projects").dataset.html = "";
  toggleSidebar(false);
  refresh();
}

function goHome() {
  if (location.hash) location.hash = "";
  else route();
}

window.addEventListener("hashchange", route);

// ---------------------------------------------------------------------------
// Events

let pendingFile = null;

$("#generateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const link = $("#linkInput").value.trim();
  const spaceId = state.currentSpace || $("#targetSpace").value;
  if (!spaceId) {
    toast("Lag et space først");
    return;
  }
  if (!link && !pendingFile) {
    toast("Lim inn en lenke eller last opp en fil først");
    $("#linkInput").focus();
    return;
  }

  if (state.mode === "demo") {
    const notice = $("#notice");
    notice.textContent = DEMO_MESSAGE;
    notice.hidden = false;
    notice.classList.remove("flash");
    void notice.offsetWidth;
    notice.classList.add("flash");
    return;
  }

  const button = $("#generateBtn");
  button.disabled = true;
  try {
    if (pendingFile && link === pendingFile.name) {
      await api.upload(spaceId, pendingFile, (f) => toast(`Laster opp ${Math.round(f * 100)} %`));
    } else {
      if (!/^https?:\/\//i.test(link)) throw new Error("Lenken må starte med http:// eller https://");
      await api.createFromLink(spaceId, link);
    }
    toast("Videoen er lagt i kø");
    $("#linkInput").value = "";
    pendingFile = null;
    if (state.currentSpace !== spaceId) location.hash = `space-${spaceId}`;
    else refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

function pickFile(file) {
  if (!file) return;
  pendingFile = file;
  $("#linkInput").value = file.name;
}

$("#fileInput").addEventListener("change", (e) => pickFile(e.target.files[0]));

const generate = $("#generateForm");
["dragenter", "dragover"].forEach((type) =>
  generate.addEventListener(type, (e) => {
    e.preventDefault();
    generate.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((type) =>
  generate.addEventListener(type, (e) => {
    e.preventDefault();
    generate.classList.remove("dragging");
  })
);
generate.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value.trim().toLowerCase();
  render();
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  state.filter = tab.dataset.filter;
  render();
});

$("#grid").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-delete-space]");
  if (del) {
    const space = state.spaces.find((s) => s.id === del.dataset.deleteSpace);
    if (!space || !confirmClick(del, `Klikk igjen for å slette «${space.name}» og alle klippene`)) return;
    try {
      await api.deleteSpace(space.id);
      toast("Space slettet");
    } catch (err) {
      toast(err.message);
    }
    refresh();
    return;
  }
  if (e.target.closest("#newCard")) {
    openDialog();
    return;
  }
  const card = e.target.closest(".card[data-id]");
  if (card) location.hash = `space-${card.dataset.id}`;
});

$("#projects").addEventListener("click", async (e) => {
  const play = e.target.closest("[data-play]");
  if (play) {
    play.innerHTML = `<video src="${escapeHtml(play.dataset.play)}" controls autoplay playsinline></video>`;
    play.removeAttribute("data-play");
    return;
  }

  const copy = e.target.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast("Teksten er kopiert");
    } catch (err) {
      toast("Kunne ikke kopiere. Marker teksten og kopier den selv.");
    }
    return;
  }

  const del = e.target.closest("[data-delete-project]");
  if (del && confirmClick(del, "Klikk igjen for å slette videoen og klippene")) {
    try {
      await api.deleteProject(del.dataset.deleteProject);
      toast("Videoen er slettet");
    } catch (err) {
      toast(err.message);
    }
    refresh();
  }
});

document.querySelectorAll("[data-home]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    goHome();
  })
);
$("#backBtn").addEventListener("click", goHome);

// New space dialog
const dialog = $("#spaceDialog");

$("#swatches").innerHTML = COLORS.map(
  (_, i) => `<button type="button" class="swatch" data-color="${i}" style="background:${gradient(i)}" aria-label="Farge ${i + 1}"></button>`
).join("");

function selectColor(i) {
  state.selectedColor = i;
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("selected", Number(s.dataset.color) === i));
}

$("#swatches").addEventListener("click", (e) => {
  const swatch = e.target.closest(".swatch");
  if (swatch) selectColor(Number(swatch.dataset.color));
});

function openDialog() {
  $("#spaceName").value = "";
  selectColor(state.spaces.length % COLORS.length);
  dialog.showModal();
  $("#spaceName").focus();
}

$("#newSpaceBtn").addEventListener("click", openDialog);

dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "create") return;
  const name = $("#spaceName").value.trim();
  if (!name) return;
  try {
    const space = await api.createSpace(name, state.selectedColor);
    toast(`«${name}» er opprettet`);
    location.hash = `space-${space.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// Mobile sidebar
const sidebar = $("#sidebar");
const backdrop = $("#backdrop");

function toggleSidebar(open) {
  sidebar.classList.toggle("open", open);
  backdrop.classList.toggle("show", open);
}

$("#menuBtn").addEventListener("click", () => toggleSidebar(true));
backdrop.addEventListener("click", () => toggleSidebar(false));

// Start: use the server when it answers, otherwise run the demo.
(async () => {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const health = await res.json();
    if (health.ok) {
      api = serverApi;
      Object.assign(state, { mode: "server", ai: health.ai, whisper: health.whisper_model });
    }
  } catch (e) {}
  route();
})();
