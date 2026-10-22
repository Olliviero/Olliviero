const STORAGE_KEY = "olliviero.spaces";

const COLORS = [
  ["#6366f1", "#a855f7"],
  ["#f97316", "#ef4444"],
  ["#06b6d4", "#3b82f6"],
  ["#22c55e", "#14b8a6"],
  ["#ec4899", "#f43f5e"],
  ["#eab308", "#f97316"],
  ["#0f172a", "#475569"],
];

const DEFAULT_SPACES = [
  { id: 1, name: "Podkast", color: 0, videos: 8, clips: 46, status: "ready", updated: Date.now() - 2 * 3600e3 },
  { id: 2, name: "YouTube-kanal", color: 2, videos: 14, clips: 71, status: "ready", updated: Date.now() - 26 * 3600e3 },
  { id: 3, name: "Webinarer", color: 3, videos: 3, clips: 12, status: "ready", updated: Date.now() - 5 * 86400e3 },
  { id: 4, name: "Gaming-strømmer", color: 1, videos: 5, clips: 19, status: "ready", updated: Date.now() - 9 * 86400e3 },
];

const $ = (sel) => document.querySelector(sel);

let spaces = load();
let filter = "all";
let query = "";
let selectedColor = 0;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (e) {}
  return DEFAULT_SPACES.map((s) => ({ ...s }));
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spaces));
  } catch (e) {}
}

function timeAgo(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "akkurat nå";
  if (minutes < 60) return `${minutes} min siden`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} t siden`;
  const days = Math.round(hours / 24);
  return days === 1 ? "i går" : `${days} dager siden`;
}

function gradient(index) {
  const [a, b] = COLORS[index % COLORS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function render() {
  const visible = spaces.filter((s) => {
    if (filter !== "all" && s.status !== filter) return false;
    return s.name.toLowerCase().includes(query);
  });

  const cards = visible.map((s) => {
    const processing = s.status === "processing";
    return `
      <article class="card" data-id="${s.id}">
        <div class="thumb" style="background:${gradient(s.color)}">
          <span class="thumb-clip"></span><span class="thumb-clip"></span><span class="thumb-clip"></span>
          <span class="badge ${s.status}">${processing ? `Behandler ${s.progress}%` : `${s.clips} klipp`}</span>
          ${processing ? `<div class="progress"><span style="width:${s.progress}%"></span></div>` : ""}
        </div>
        <div class="card-body">
          <div>
            <h3 class="card-title">${escapeHtml(s.name)}</h3>
            <div class="card-meta">${s.videos} ${s.videos === 1 ? "video" : "videoer"} · ${timeAgo(s.updated)}</div>
          </div>
          <button class="card-menu" data-delete="${s.id}" aria-label="Slett ${escapeHtml(s.name)}" title="Slett">
            <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          </button>
        </div>
      </article>`;
  });

  const showNewCard = filter === "all" && !query;
  if (showNewCard) {
    cards.push(`
      <button class="card new" id="newCard">
        <span class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
        Nytt space
      </button>`);
  }

  $("#grid").innerHTML = cards.join("");
  $("#empty").hidden = visible.length > 0 || showNewCard;
  $("#count").textContent = `${visible.length} ${visible.length === 1 ? "space" : "spaces"}`;

  $("#spaceLinks").innerHTML = spaces
    .map((s) => `<li><a href="#" data-id="${s.id}"><span class="dot" style="background:${gradient(s.color)}"></span>${escapeHtml(s.name)}</a></li>`)
    .join("");

  const target = $("#targetSpace");
  const current = target.value;
  target.innerHTML = spaces.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  if (spaces.some((s) => String(s.id) === current)) target.value = current;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
}

function startProcessing(space, source) {
  space.status = "processing";
  space.progress = 0;
  space.videos += 1;
  space.updated = Date.now();
  save();
  render();
  toast(`Lager klipp fra «${source}»`);

  const tick = setInterval(() => {
    space.progress = Math.min(100, space.progress + 8 + Math.round(Math.random() * 10));
    if (space.progress >= 100) {
      clearInterval(tick);
      space.status = "ready";
      space.clips += 3 + Math.floor(Math.random() * 6);
      space.updated = Date.now();
      delete space.progress;
      toast(`Klippene i «${space.name}» er klare`);
    }
    save();
    render();
  }, 600);
}

// Resume anything that was mid-processing when the page was closed.
spaces.forEach((s) => {
  if (s.status === "processing") {
    s.status = "ready";
    delete s.progress;
  }
});

// Generate form
$("#generateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const link = $("#linkInput").value.trim();
  if (!link) {
    toast("Lim inn en lenke eller last opp en fil først");
    $("#linkInput").focus();
    return;
  }
  const space = spaces.find((s) => String(s.id) === $("#targetSpace").value);
  if (!space) return;
  if (space.status === "processing") {
    toast("Dette spacet behandler allerede en video");
    return;
  }
  startProcessing(space, link.length > 40 ? link.slice(0, 40) + "…" : link);
  $("#linkInput").value = "";
});

$("#fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) $("#linkInput").value = file.name;
});

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
generate.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) $("#linkInput").value = file.name;
});

// Search & tabs
$("#search").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  render();
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  filter = tab.dataset.filter;
  render();
});

// Cards
$("#grid").addEventListener("click", (e) => {
  const del = e.target.closest("[data-delete]");
  if (del) {
    const space = spaces.find((s) => String(s.id) === del.dataset.delete);
    if (space && confirm(`Slette «${space.name}»?`)) {
      spaces = spaces.filter((s) => s !== space);
      save();
      render();
      toast("Space slettet");
    }
    return;
  }
  if (e.target.closest("#newCard")) {
    openDialog();
    return;
  }
  const card = e.target.closest(".card[data-id]");
  if (card) {
    $("#targetSpace").value = card.dataset.id;
    $("#linkInput").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

// New space dialog
const dialog = $("#spaceDialog");

$("#swatches").innerHTML = COLORS.map(
  (_, i) => `<button type="button" class="swatch" data-color="${i}" style="background:${gradient(i)}" aria-label="Farge ${i + 1}"></button>`
).join("");

function selectColor(i) {
  selectedColor = i;
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("selected", Number(s.dataset.color) === i));
}

$("#swatches").addEventListener("click", (e) => {
  const swatch = e.target.closest(".swatch");
  if (swatch) selectColor(Number(swatch.dataset.color));
});

function openDialog() {
  $("#spaceName").value = "";
  selectColor(spaces.length % COLORS.length);
  dialog.showModal();
  $("#spaceName").focus();
}

$("#newSpaceBtn").addEventListener("click", openDialog);

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "create") return;
  const name = $("#spaceName").value.trim();
  if (!name) return;
  const space = {
    id: Math.max(0, ...spaces.map((s) => s.id)) + 1,
    name,
    color: selectedColor,
    videos: 0,
    clips: 0,
    status: "ready",
    updated: Date.now(),
  };
  spaces.unshift(space);
  save();
  render();
  $("#targetSpace").value = space.id;
  toast(`«${name}» er opprettet`);
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

$("#spaceLinks").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-id]");
  if (!link) return;
  e.preventDefault();
  $("#targetSpace").value = link.dataset.id;
  toggleSidebar(false);
  $("#linkInput").focus();
});

render();
