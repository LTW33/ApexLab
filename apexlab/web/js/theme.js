/* Theme registry: storage, native window sync, sidebar picker, settings cards. */
import { icon } from "./util.js";

export const THEMES = [
  {
    id: "carbon",
    name: "Карбон",
    hint: "ночной лайм",
    dots: ["#c8ff3d", "#3fe0cf", "#ff7a1a"],
    preview: { bg: "#07090c", panel: "#10141a", line: "#202733", accent: "#c8ff3d", text: "#e9eff6" },
  },
  {
    id: "midnight",
    name: "Полночь",
    hint: "глубокий синий",
    dots: ["#35e0ff", "#5b9dff", "#ff8b3d"],
    preview: { bg: "#05070f", panel: "#0b1220", line: "#1a2840", accent: "#35e0ff", text: "#e7efff" },
  },
  {
    id: "ember",
    name: "Янтарь",
    hint: "тёплый закат",
    dots: ["#ffb340", "#ff8a3d", "#6fa8ff"],
    preview: { bg: "#0b0806", panel: "#17110c", line: "#332519", accent: "#ffb340", text: "#f7eee2" },
  },
  {
    id: "violet",
    name: "Фиалка",
    hint: "ночной фиолет",
    dots: ["#b98cff", "#5ee6d8", "#ff8f5a"],
    preview: { bg: "#08060f", panel: "#120e1e", line: "#251c3c", accent: "#b98cff", text: "#f0eaff" },
  },
  {
    id: "daylight",
    name: "День",
    hint: "светлая тема",
    dots: ["#2358e6", "#0f9b8e", "#d97706"],
    preview: { bg: "#eef1f6", panel: "#ffffff", line: "#dde3ec", accent: "#2358e6", text: "#101725" },
  },
  {
    id: "mono",
    name: "Моно",
    hint: "чёрное и белое",
    dots: ["#111111", "#8a8a8a", "#d6d6d6"],
    preview: { bg: "#ffffff", panel: "#fafafa", line: "#dcdcdc", accent: "#111111", text: "#0a0a0a" },
  },
  {
    id: "graphite",
    name: "Графит",
    hint: "серый металл",
    dots: ["#e4e7ea", "#8a9199", "#3c4147"],
    preview: { bg: "#141517", panel: "#1d1f22", line: "#2e3237", accent: "#e4e7ea", text: "#f0f2f4" },
  },
];

const STORAGE = "apex.theme";
const BG = {
  carbon: "#07090c",
  midnight: "#05070f",
  ember: "#0b0806",
  violet: "#08060f",
  daylight: "#eef1f6",
  mono: "#ffffff",
  graphite: "#141517",
};

function meta(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  return THEMES.some((t) => t.id === attr) ? attr : THEMES[0].id;
}

export function currentThemeMeta() {
  return meta(currentTheme());
}

export function cycleTheme() {
  const index = THEMES.findIndex((t) => t.id === currentTheme());
  const next = THEMES[(index + 1) % THEMES.length];
  applyTheme(next.id);
  return next;
}

function updateMeta(id) {
  const tag = document.querySelector('meta[name="theme-color"]');
  if (tag) tag.setAttribute("content", BG[id] || BG.carbon);
}

function syncNative(id) {
  const api = window.pywebview?.api;
  if (!api || typeof api.set_theme !== "function") return;
  try {
    const res = api.set_theme(id);
    if (res && typeof res.catch === "function") res.catch(() => {});
  } catch { /* browser mode: no native shell */ }
}

export function applyTheme(id, { persist = true, announce = true } = {}) {
  if (!THEMES.some((t) => t.id === id)) id = THEMES[0].id;
  const root = document.documentElement;
  if (root.getAttribute("data-theme") !== id) root.setAttribute("data-theme", id);
  updateMeta(id);
  if (persist) {
    try { localStorage.setItem(STORAGE, id); } catch { /* ignore */ }
  }
  syncNative(id);
  refreshThemePicker();
  if (announce) window.dispatchEvent(new CustomEvent("apex:theme", { detail: { theme: id } }));
}

function pickerMarkup() {
  const active = currentThemeMeta();
  return `
    <button class="theme-btn" type="button" aria-haspopup="true" aria-expanded="false"
            title="Оформление: ${active.name}">
      ${icon("palette", 15)}
      <span class="nm">${active.name}</span>
      <span class="pip"></span>
      ${icon("chevronDown", 14)}
    </button>
    <div class="theme-menu" hidden role="menu">
      ${THEMES.map((t) => `
        <button class="theme-opt${t.id === active.id ? " active" : ""}" type="button"
                role="menuitem" data-theme-id="${t.id}">
          <span>${t.name}</span>
          <span class="dots">${t.dots.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
        </button>`).join("")}
    </div>`;
}

function bindPicker(host) {
  const btn = host.querySelector(".theme-btn");
  const menu = host.querySelector(".theme-menu");
  if (!btn || !menu) return;
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", (ev) => {
    const opt = ev.target.closest("[data-theme-id]");
    if (!opt) return;
    setOpen(false);
    applyTheme(opt.dataset.themeId);
  });
  host.__closeThemeMenu = () => setOpen(false);
  host.querySelector(".theme-menu .theme-opt.active")?.scrollIntoView({ block: "nearest" });
}

export function refreshThemePicker() {
  const host = document.getElementById("theme-picker");
  if (!host) return;
  host.innerHTML = pickerMarkup();
  bindPicker(host);
}

export function mountThemePicker() {
  refreshThemePicker();
  const host = document.getElementById("theme-picker");
  if (host) host.__closeThemeMenu?.();
  document.addEventListener("click", (ev) => {
    const picker = document.getElementById("theme-picker");
    if (picker && !picker.contains(ev.target)) picker.__closeThemeMenu?.();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") document.getElementById("theme-picker")?.__closeThemeMenu?.();
  });
}

export function themeCardsHTML() {
  const active = currentTheme();
  return `<div class="theme-cards">${THEMES.map((t) => {
    const p = t.preview;
    return `<button class="theme-card${t.id === active ? " active" : ""}" type="button"
        data-theme-id="${t.id}" aria-pressed="${t.id === active}">
      <span class="theme-shot">
        <span class="win" style="background:${p.bg};border-color:${p.line}">
          <span class="side" style="background:${p.panel};border-color:${p.line}">
            <i style="background:${p.accent};width:68%"></i>
            <i style="background:${p.line};width:92%"></i>
            <i style="background:${p.line};width:78%"></i>
            <i style="background:${p.line};width:86%"></i>
          </span>
          <span class="body">
            <span class="ts-bar w70" style="background:${p.text};opacity:.26"></span>
            <span class="ts-bar w40" style="background:${p.accent}"></span>
            <span class="ts-row">
              <span class="ts-cell" style="background:${p.panel};border:1px solid ${p.line}"></span>
              <span class="ts-cell" style="background:${p.panel};border:1px solid ${p.line}"></span>
              <span class="ts-cell" style="background:${p.accent};opacity:.85"></span>
            </span>
          </span>
        </span>
      </span>
      <span class="meta"><b>${t.name}</b><span>${t.hint}</span></span>
    </button>`;
  }).join("")}</div>`;
}

export function bindThemeCards(root) {
  root.querySelectorAll(".theme-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.themeId;
      applyTheme(id);
      root.querySelectorAll(".theme-card").forEach((c) => {
        const on = c.dataset.themeId === id;
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", String(on));
      });
    });
  });
}

export function initTheme() {
  const id = currentTheme();
  document.documentElement.setAttribute("data-theme", id);
  updateMeta(id);
  mountThemePicker();
  window.addEventListener("pywebviewready", () => syncNative(currentTheme()));
  syncNative(id);
}
