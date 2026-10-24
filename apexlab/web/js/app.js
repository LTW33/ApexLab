import { store } from "./store.js";
import { icon } from "./util.js";
import { life, loadingState, setTopbar, closeModals } from "./ui.js";
import { initTheme } from "./theme.js";
import { initShell } from "./shell.js";
import { initPalette } from "./palette.js";
import { channel } from "./channel.js";
import { redrawAll } from "./charts.js";
import { renderGarage } from "./views/garage.js";
import { renderDrivers } from "./views/drivers.js";
import { renderSession } from "./views/session.js";
import { renderCompare } from "./views/compare.js";
import { renderSettings } from "./views/settings.js";
import { renderCoach } from "./views/coach.js";

const NAV = [
  { key: "garage", label: "Гараж", icon: "car", href: "#/garage" },
  { key: "drivers", label: "Пилоты", icon: "users", href: "#/drivers" },
  { key: "compare", label: "Сравнение", icon: "compare", href: "#/compare" },
  { key: "settings", label: "Настройки", icon: "settings", href: "#/settings" },
];

function navItems() {
  if (!channel.isBeta()) return NAV;
  return [
    NAV[0], NAV[1],
    { key: "coach", label: "Эталоны", icon: "target", href: "#/coach" },
    NAV[2], NAV[3],
  ];
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { parts, params: new URLSearchParams(query || "") };
}

function navFor(parts) {
  const first = parts[0] || "garage";
  if (first === "session" || first === "setup") return "garage";
  return navItems().some((n) => n.key === first) ? first : "garage";
}

function renderNav(active) {
  const nav = document.getElementById("nav");
  nav.innerHTML = navItems().map((item) => `
    <a class="nav-item${item.key === active ? " active" : ""}" href="${item.href}">
      ${icon(item.icon, 18)}
      <span>${item.label}</span>
      <span class="nav-count" data-count="${item.key}"></span>
    </a>`).join("");
  updateCounts();
}

function updateCounts() {
  const counts = {
    garage: store.sessions.length || "",
    drivers: store.drivers.length || "",
    coach: store.references?.length || "",
  };
  for (const [key, value] of Object.entries(counts)) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = value;
  }
}

function renderSidebarFoot() {
  const el = document.getElementById("sidebar-foot");
  if (!el) return;
  const stats = store.stats || {};
  const tag = channel.isBeta() ? " · beta" : "";
  const refs = stats.references ? ` · <b>${stats.references}</b> эталонов` : "";
  el.innerHTML = `
    <div class="source"><span class="source-dot"></span><span class="txt">Локальная телеметрия</span></div>
    <div class="db-info"><b>${stats.sessions || 0}</b> сессий · <b>${stats.clean_laps || 0}</b> чистых кругов${refs}<br>
    ${stats.laps || 0} кругов · ${(stats.km || 0).toFixed(0)} км · v${store.appVersion}${tag}</div>`;
}

function notFound(view, message) {
  setTopbar({ crumb: `<a href="#/garage">Гараж</a>`, title: "Не найдено" });
  view.innerHTML = `<div class="page"><div class="empty">
    <div class="empty-icon">${icon("alert", 26)}</div>
    <h3>Сессия недоступна</h3>
    <p>${message}</p>
    <a class="btn primary" href="#/garage">Вернуться в гараж</a>
  </div></div>`;
}

async function route() {
  life.run();
  closeModals();
  const { parts, params } = parseRoute();
  const view = document.getElementById("view");
  const active = navFor(parts);
  renderNav(active);
  if (view) {
    view.innerHTML = loadingState();
    view.scrollTop = 0;
  }
  try {
    if (!store.loaded) await store.load();
    if (!channelReady) {
      channelReady = true;
      channel.init(store.channel === "beta");
    }
    renderSidebarFoot();
    updateCounts();
    if (active === "garage" && parts[0] === "session") {
      if (!parts[1]) return notFound(view, "В адресе нет идентификатора сессии.");
      return await renderSession(view, parts[1], parts[2] || "analysis", params);
    }
    if (active === "garage") return await renderGarage(view, params);
    if (active === "coach") return await renderCoach(view, params);
    if (active === "drivers") return await renderDrivers(view, params);
    if (active === "compare") return await renderCompare(view, params);
    if (active === "settings") return await renderSettings(view, params);
  } catch (err) {
    console.error(err);
    setTopbar({ crumb: "Ошибка", title: "Что-то пошло не так" });
    view.innerHTML = `<div class="page"><div class="empty">
      <div class="empty-icon">${icon("alert", 26)}</div>
      <h3>Не удалось загрузить данные</h3>
      <p>${String(err?.message || err)}</p>
      <button class="btn" onclick="location.reload()">Обновить страницу</button>
    </div></div>`;
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("apex:refresh", route);
window.addEventListener("apex:theme", () => redrawAll());
let booted = false;
let channelReady = false;
function boot() {
  if (booted) return;
  booted = true;
  initTheme();
  initShell();
  initPalette();
  route();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
