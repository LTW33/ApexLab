/* Command palette (Ctrl+K) plus global keyboard shortcuts. */
import { api } from "./api.js";
import { store } from "./store.js";
import { esc, fmtShort, fmtDate, icon, plural } from "./util.js";
import { applyTheme, THEMES } from "./theme.js";
import { toast, closeModals } from "./ui.js";
import { openImport } from "./importmodal.js";
import { exportSessionReport, sessionReportText } from "./report.js";
import { toggleSidebar, cycleWithToast } from "./shell.js";

const TABS = ["analysis", "line", "laps", "errors", "setup"];

let state = null;

function go(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new CustomEvent("apex:refresh"));
  } else {
    location.hash = hash;
  }
}

function currentSessionId() {
  const match = location.hash.match(/^#\/session\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function withSession(fn) {
  const id = currentSessionId();
  if (!id) {
    toast("Сначала открой сессию", "info");
    return Promise.resolve();
  }
  return api.session(id).then(fn).catch((err) => toast(err.message, "err"));
}

async function copyReport() {
  await withSession(async (meta) => {
    const text = sessionReportText(meta);
    try {
      await navigator.clipboard.writeText(text);
      toast("Отчёт скопирован в буфер обмена", "ok");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        toast("Отчёт скопирован в буфер обмена", "ok");
      } catch {
        toast("Не удалось скопировать отчёт", "err");
      }
      area.remove();
    }
  });
}

function navCommands() {
  return [
    { group: "Навигация", label: "Гараж", hint: `${store.sessions.length} сессий`, icon: "car", run: () => go("#/garage") },
    { group: "Навигация", label: "Пилоты", hint: `${store.drivers.length}`, icon: "users", run: () => go("#/drivers") },
    { group: "Навигация", label: "Сравнение", hint: "траектории", icon: "compare", run: () => go("#/compare") },
    { group: "Навигация", label: "Настройки", hint: "папки и темы", icon: "settings", run: () => go("#/settings") },
  ];
}

function actionCommands() {
  const native = typeof window.pywebview?.api?.window_state === "function";
  const list = [
    { group: "Действия", label: "Импортировать логи", hint: "MoTeC .ld", icon: "upload", run: () => openImport({
      onDone: () => {
        store.invalidate();
        store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
      },
    }) },
    { group: "Действия", label: "Экспорт отчёта сессии", hint: "Ctrl E", icon: "download",
      run: () => withSession((meta) => exportSessionReport(meta)) },
    { group: "Действия", label: "Скопировать отчёт", hint: "в буфер", icon: "layers", run: copyReport },
    { group: "Действия", label: "Печать страницы", hint: "Ctrl P", icon: "printer", run: () => window.print() },
    { group: "Действия", label: "Свернуть / развернуть панель", hint: "Ctrl B", icon: "panelLeft", run: toggleSidebar },
    { group: "Действия", label: "Сменить тему", hint: "Ctrl Shift T", icon: "palette", run: () => { closePalette(); cycleWithToast(); } },
  ];
  if (store.settings?.motec_path) {
    list.push({
      group: "Действия",
      label: "Открыть папку логов",
      hint: "проводник",
      icon: "folder",
      run: () => api.reveal(store.settings.motec_path).catch((err) => toast(err.message, "err")),
    });
  }
  if (native) {
    list.push(
      { group: "Окно", label: "Поверх всех окон", hint: "закрепить", icon: "pin",
        run: () => document.getElementById("ab-pin")?.click() },
      { group: "Окно", label: "Развернуть / восстановить окно", hint: "двойной клик", icon: "maximize",
        run: () => document.querySelector('[data-win="max"]')?.click() },
      { group: "Окно", label: "Свернуть окно", hint: "в панель задач", icon: "minimize",
        run: () => document.querySelector('[data-win="min"]')?.click() },
      { group: "Окно", label: "Закрыть ApexLab", hint: "Alt F4", icon: "x",
        run: () => document.querySelector('[data-win="close"]')?.click() },
    );
  }
  return list;
}

function sessionCommands() {
  return store.sorted().slice(0, 12).map((s) => ({
    group: "Сессии",
    label: `${s.track || "Сессия"} · ${fmtShort(s.best_time)}`,
    hint: `${fmtDate(s.date)}${s.driver ? ` · ${s.driver}` : ""}`,
    icon: "flag",
    run: () => go(`#/session/${encodeURIComponent(s.id)}/analysis`),
  }));
}

function driverCommands() {
  return store.drivers.map((d) => ({
    group: "Пилоты",
    label: d.name,
    hint: `${d.sessions.length} ${plural(d.sessions.length, "сессия", "сессии", "сессий")}`,
    icon: "user",
    run: () => go(`#/drivers?driver=${encodeURIComponent(d.name)}`),
  }));
}

function themeCommands() {
  const active = document.documentElement.getAttribute("data-theme");
  return THEMES.map((t) => ({
    group: "Темы",
    label: `Тема: ${t.name}`,
    hint: t.id === active ? "сейчас" : t.hint,
    icon: "palette",
    run: () => {
      applyTheme(t.id);
      toast(`Тема: ${t.name}`, "info");
    },
  }));
}

function allCommands() {
  return [
    ...navCommands(),
    ...actionCommands(),
    ...sessionCommands(),
    ...driverCommands(),
    ...themeCommands(),
  ];
}

function closePalette() {
  if (!state) return;
  const current = state;
  state = null;
  document.removeEventListener("keydown", current.onKey);
  current.veil.remove();
  current.restoreFocus?.focus?.();
}

function selectedItem() {
  return state ? state.items[state.selected] : null;
}

async function runItem(item) {
  if (!item) return;
  closePalette();
  try {
    await item.run();
  } catch (err) {
    toast(String(err?.message || err), "err");
  }
}

function renderList() {
  if (!state) return;
  const q = state.input.value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const filtered = allCommands().filter((item) => {
    if (!tokens.length) return true;
    const haystack = `${item.group} ${item.label} ${item.hint || ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  state.items = filtered;
  state.selected = Math.min(state.selected, Math.max(0, filtered.length - 1));

  if (!filtered.length) {
    state.list.innerHTML = `<div class="palette-empty">Ничего не нашлось. Попробуй «Спа», «тема» или «экспорт».</div>`;
    return;
  }

  const groups = [];
  for (const item of filtered) {
    if (!groups.includes(item.group)) groups.push(item.group);
  }
  state.list.innerHTML = groups.map((group) => {
    const rows = filtered.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.group === group)
      .map(({ item, index }) => `<button class="palette-item${index === state.selected ? " sel" : ""}" type="button"
          role="option" data-index="${index}" aria-selected="${index === state.selected}">
        ${icon(item.icon || "command", 16)}
        <span class="pl-label">${esc(item.label)}</span>
        ${item.hint ? `<span class="pl-hint">${esc(item.hint)}</span>` : ""}
      </button>`).join("");
    return `<div class="palette-group">${esc(group)}</div>${rows}`;
  }).join("");
  scrollSelected();
}

function scrollSelected() {
  const el = state?.list.querySelector(`.palette-item[data-index="${state.selected}"]`);
  el?.scrollIntoView({ block: "nearest" });
}

function moveSelection(delta) {
  if (!state || !state.items.length) return;
  state.selected = (state.selected + delta + state.items.length) % state.items.length;
  state.list.querySelectorAll(".palette-item").forEach((el) => {
    const on = Number(el.dataset.index) === state.selected;
    el.classList.toggle("sel", on);
    el.setAttribute("aria-selected", String(on));
  });
  scrollSelected();
}

export function openPalette() {
  if (state) {
    closePalette();
    return;
  }
  closeModals();
  const restoreFocus = document.activeElement;
  const veil = document.createElement("div");
  veil.className = "palette-veil";
  veil.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Поиск и команды">
    <div class="palette-head">
      ${icon("search", 17)}
      <input class="palette-input" type="text" placeholder="Сессия, трасса, пилот, тема или команда…"
             spellcheck="false" autocomplete="off" aria-controls="palette-list">
      <kbd>Esc</kbd>
    </div>
    <div class="palette-list" id="palette-list" role="listbox"></div>
    <div class="palette-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> выбор</span>
      <span><kbd>Enter</kbd> открыть</span>
      <span><kbd>Ctrl K</kbd> закрыть</span>
    </div>
  </div>`;
  document.body.appendChild(veil);

  const input = veil.querySelector(".palette-input");
  const list = veil.querySelector(".palette-list");
  const onKey = (ev) => {
    if (!state) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePalette();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      moveSelection(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      moveSelection(-1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      runItem(selectedItem());
    }
  };

  state = { veil, input, list, items: [], selected: 0, onKey, restoreFocus };
  input.addEventListener("input", () => {
    state.selected = 0;
    renderList();
  });
  list.addEventListener("click", (ev) => {
    const row = ev.target.closest(".palette-item");
    if (row) runItem(state?.items[Number(row.dataset.index)]);
  });
  list.addEventListener("mousemove", (ev) => {
    const row = ev.target.closest(".palette-item");
    if (!row || !state) return;
    const index = Number(row.dataset.index);
    if (index !== state.selected) {
      state.selected = index;
      list.querySelectorAll(".palette-item").forEach((el) => {
        const on = Number(el.dataset.index) === index;
        el.classList.toggle("sel", on);
        el.setAttribute("aria-selected", String(on));
      });
    }
  });
  veil.addEventListener("mousedown", (ev) => {
    if (ev.target === veil) closePalette();
  });
  document.addEventListener("keydown", onKey);
  renderList();
  input.focus();
  veil.querySelector(".palette")?.addEventListener("mousedown", (ev) => ev.stopPropagation());
}

function isTyping(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
}

function onGlobalKey(ev) {
  const mod = ev.ctrlKey || ev.metaKey;
  const key = String(ev.key || "").toLowerCase();

  if (mod && !ev.shiftKey && !ev.altKey && key === "k") {
    ev.preventDefault();
    openPalette();
    return;
  }
  if (state) return;

  if (mod && ev.shiftKey && !ev.altKey && key === "t") {
    ev.preventDefault();
    cycleWithToast();
    return;
  }
  if (mod && !ev.shiftKey && !ev.altKey && key === "e") {
    ev.preventDefault();
    withSession((meta) => exportSessionReport(meta));
    return;
  }
  if (mod && !ev.shiftKey && !ev.altKey && key === "p") {
    ev.preventDefault();
    window.print();
    return;
  }
  if (mod && !ev.shiftKey && !ev.altKey && key === "b") {
    ev.preventDefault();
    toggleSidebar();
    return;
  }
  if (ev.altKey && !mod && !ev.shiftKey && /^[1-5]$/.test(ev.key)) {
    const id = currentSessionId();
    if (!id) return;
    ev.preventDefault();
    const query = location.hash.split("?")[1];
    location.hash = `#/session/${encodeURIComponent(id)}/${TABS[Number(ev.key) - 1]}${query ? `?${query}` : ""}`;
    return;
  }
  if (ev.key === "F1" && !isTyping(ev.target)) {
    ev.preventDefault();
    go("#/settings");
    setTimeout(() => {
      document.querySelector(".kbd-row")?.closest(".panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 260);
  }
}

export function initPalette() {
  window.addEventListener("apex:palette", openPalette);
  document.addEventListener("keydown", onGlobalKey);
}
