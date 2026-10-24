/* Shared UI primitives: lifecycle, topbar, modals, toasts, empty states. */
import { icon } from "./util.js";

export const life = {
  fns: [],
  add(fn) { this.fns.push(fn); },
  run() {
    for (const fn of this.fns) {
      try { fn(); } catch { /* ignore */ }
    }
    this.fns = [];
  },
};

export function setTopbar({ crumb = "", title = "", sub = "", actions = "" }) {
  const el = document.getElementById("topbar");
  if (!el) return el;
  el.innerHTML = `
    <div class="topbar-left">
      ${crumb ? `<div class="crumb">${crumb}</div>` : ""}
      <div class="page-title">${title}</div>
      ${sub ? `<div class="page-sub">${sub}</div>` : ""}
    </div>
    <div class="topbar-right">${actions}</div>`;
  return el;
}

export function observe(el, callback) {
  if (!el || typeof ResizeObserver === "undefined") return;
  let lastWidth = el.clientWidth;
  let frame = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - lastWidth) < 2) return;
    lastWidth = el.clientWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(callback);
  });
  ro.observe(el);
  life.add(() => { cancelAnimationFrame(frame); ro.disconnect(); });
}

let toastId = 0;
export function toast(message, type = "ok") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const id = ++toastId;
  const icons = { ok: "check", err: "alert", info: "info" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.dataset.id = id;
  el.innerHTML = `${icon(icons[type] || "info", 16)}<span>${message}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 280);
  }, 4200);
}

export function openModal({ title, sub = "", body, footer = "", narrow = false, onMount, onClose }) {
  const root = document.getElementById("modal-root");
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `
    <div class="modal-card${narrow ? " narrow" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <div class="modal-title">${title}</div>
          ${sub ? `<div class="modal-sub">${sub}</div>` : ""}
        </div>
        <button class="btn ghost icon sm" data-close aria-label="Закрыть">${icon("x", 16)}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
    </div>`;
  root.appendChild(wrap);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    wrap.remove();
    modalClosers.delete(close);
    onClose?.();
  };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  modalClosers.add(close);
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });
  wrap.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));
  setTimeout(() => wrap.querySelector("input,select,button.primary")?.focus(), 40);
  onMount?.(wrap, close);
  return { el: wrap, close };
}

const modalClosers = new Set();

export function closeModals() {
  for (const close of [...modalClosers]) close();
}

export function confirmDialog(title, text, okLabel = "Удалить", danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const { close } = openModal({
      title,
      narrow: true,
      body: `<p class="muted" style="font-size:13px;line-height:1.6">${text}</p>`,
      footer: `<span class="hint">Действие нельзя отменить</span>
        <div class="row">
          <button class="btn ghost" data-cancel>Отмена</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-ok>${okLabel}</button>
        </div>`,
      onMount(wrap) {
        wrap.querySelector("[data-cancel]").addEventListener("click", () => { done = true; resolve(false); close(); });
        wrap.querySelector("[data-ok]").addEventListener("click", () => { done = true; resolve(true); close(); });
      },
      onClose() { if (!done) resolve(false); },
    });
  });
}

export function emptyState({ iconName = "folder", title, text, action = "" }) {
  return `<div class="empty">
    <div class="empty-icon">${icon(iconName, 26)}</div>
    <h3>${title}</h3>
    <p>${text}</p>
    ${action}
  </div>`;
}

export function loadingState(text = "Загружаю телеметрию…") {
  return `<div class="loading"><div class="spinner"></div><span>${text}</span></div>`;
}

export function go(hash) {
  location.hash = hash;
}

export function printPage() {
  window.print();
}
