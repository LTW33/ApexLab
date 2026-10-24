/* Frameless window shell: drag, resize, window buttons, pin, sidebar, themes. */
import { icon } from "./util.js";
import { cycleTheme } from "./theme.js";
import { toast } from "./ui.js";

const api = () => window.pywebview?.api;
const native = () => typeof api()?.window_state === "function";

let pinned = false;

function setMaximized(on) {
  document.body.classList.toggle("maximized", !!on);
  const btn = document.querySelector('[data-win="max"]');
  if (btn) btn.title = on ? "Восстановить" : "Развернуть";
}

function setPinned(on) {
  pinned = !!on;
  const btn = document.getElementById("ab-pin");
  if (!btn) return;
  btn.classList.toggle("active", pinned);
  btn.setAttribute("aria-pressed", String(pinned));
  btn.title = pinned ? "Не поверх окон" : "Поверх всех окон";
}

function markNative() {
  if (native()) document.body.classList.add("native");
}

async function syncWindowState() {
  if (!native()) return;
  try {
    const state = await api().window_state();
    if (!state) return;
    setMaximized(state.maximized);
    setPinned(state.topmost);
    markNative();
  } catch { /* window may be closing */ }
}

async function togglePin() {
  if (!native()) return;
  try {
    const res = await api().set_topmost(!pinned);
    if (res && res.ok) {
      setPinned(res.topmost);
      toast(pinned ? "Окно закреплено поверх остальных" : "Закрепление снято", "info");
    }
  } catch { /* ignore */ }
}

async function toggleMaximize() {
  if (!native()) return;
  try {
    const res = await api().window_toggle_maximize();
    if (res && res.ok) setMaximized(res.maximized);
  } catch { /* ignore */ }
}

function buildHandles() {
  const edges = {
    n: "top", s: "bottom", w: "left", e: "right",
    nw: "topleft", ne: "topright", sw: "bottomleft", se: "bottomright",
  };
  for (const [short, edge] of Object.entries(edges)) {
    const el = document.createElement("div");
    el.className = `resize-handle rh-${short}`;
    el.dataset.edge = edge;
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || !native()) return;
      ev.preventDefault();
      api().window_resize(edge).catch(() => {});
    });
    document.body.appendChild(el);
  }
}

function bindChrome() {
  document.getElementById("ab-sidebar")?.addEventListener("click", () => toggleSidebar());
  document.getElementById("ab-search")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("apex:palette"));
  });
  document.getElementById("ab-theme")?.addEventListener("click", () => cycleWithToast());
  document.getElementById("ab-pin")?.addEventListener("click", () => togglePin());

  document.querySelector('[data-win="min"]')?.addEventListener("click", () => {
    if (native()) api().window_minimize().catch(() => {});
  });
  document.querySelector('[data-win="max"]')?.addEventListener("click", () => toggleMaximize());
  document.querySelector('[data-win="close"]')?.addEventListener("click", () => {
    if (native()) api().window_close().catch(() => {});
  });

  const drag = document.getElementById("appbar-drag");
  if (drag) {
    let lastPress = 0;
    drag.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || !native()) return;
      // The first press starts a native caption drag; the second press of a
      // double click must stay in the web view so the dblclick can maximize.
      const now = performance.now();
      if (ev.detail > 1 || (now - lastPress < 420)) {
        lastPress = 0;
        return;
      }
      lastPress = now;
      ev.preventDefault();
      api().window_drag().catch(() => {});
    });
    drag.addEventListener("dblclick", (ev) => {
      if (!native()) return;
      ev.preventDefault();
      toggleMaximize();
    });
  }
}

export function cycleWithToast() {
  const theme = cycleTheme();
  toast(`Тема: ${theme.name}`, "info");
}

export function toggleSidebar() {
  const root = document.documentElement;
  const collapsed = !root.classList.contains("side-collapsed");
  root.classList.toggle("side-collapsed", collapsed);
  try {
    localStorage.setItem("apex.sidebar", collapsed ? "collapsed" : "open");
  } catch { /* ignore */ }
  const btn = document.getElementById("ab-sidebar");
  if (btn) {
    btn.classList.toggle("active", collapsed);
    btn.title = collapsed ? "Развернуть панель · Ctrl+B" : "Свернуть панель · Ctrl+B";
  }
}

export function initShell() {
  markNative();
  buildHandles();
  bindChrome();

  const root = document.documentElement;
  const collapsed = root.classList.contains("side-collapsed");
  const sideBtn = document.getElementById("ab-sidebar");
  if (sideBtn) {
    sideBtn.classList.toggle("active", collapsed);
    sideBtn.innerHTML = icon("panelLeft", 15);
  }

  window.__apexShell = {
    setMaximized,
    setPinned,
    refresh: syncWindowState,
  };

  window.addEventListener("pywebviewready", () => {
    markNative();
    syncWindowState();
  });
  if (native()) {
    syncWindowState();
  } else {
    // The bridge is injected asynchronously; the event above does the real work.
    setTimeout(syncWindowState, 600);
  }

  // Keep the maximize glyph honest when Windows changes state by itself.
  window.addEventListener("focus", syncWindowState);
}

