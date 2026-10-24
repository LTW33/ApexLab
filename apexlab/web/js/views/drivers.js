import { api } from "../api.js";
import { store } from "../store.js";
import {
  esc, fmtTime, fmtShort, fmtDate, initials, icon, scoreRing, scoreLabel,
  plural, avg,
} from "../util.js";
import { drawRadar } from "../charts.js";
import {
  life, setTopbar, observe, emptyState, toast, openModal,
} from "../ui.js";
import { openImport } from "../importmodal.js";

const AXES = [
  { key: "technique", label: "Техника" },
  { key: "consistency", label: "Стабильность" },
  { key: "braking", label: "Торможение" },
  { key: "traction", label: "Тяга" },
  { key: "balance_score", label: "Баланс" },
  { key: "smooth", label: "Плавность" },
];

function driverSessions(name) {
  return store.sessions
    .filter((s) => (s.driver || "Пилот") === name)
    .sort((a, b) => (b.built || 0) - (a.built || 0));
}

function scoreText(d) {
  if (!d.clean_sessions) return "нет чистых заездов";
  return `${scoreLabel(d.score)} · ${d.clean_sessions} ${plural(d.clean_sessions, "чистая сессия", "чистые сессии", "чистых сессий")}`;
}

function cardHTML(d) {
  const sessions = driverSessions(d.name);
  const latest = sessions[0];
  const score = d.clean_sessions ? d.score : null;
  const events = d.events || {};
  const locks = events.lock || 0;
  const spins = events.spin || 0;
  const tracks = (d.tracks || []).map((t) => `<span class="track-pill">${esc(t.track)}${t.best ? `<b>${fmtShort(t.best)}</b>` : ""}</span>`).join("");

  return `<div class="card driver-card" data-driver="${esc(d.name)}">
    <div class="driver-head">
      <div class="avatar">${esc(initials(d.name))}</div>
      <div class="grow">
        <div class="driver-name">${esc(d.name)}</div>
        <div class="driver-sub">${d.sessions.length} ${plural(d.sessions.length, "сессия", "сессии", "сессий")} · ${d.laps} ${plural(d.laps, "круг", "круга", "кругов")} · ${d.clean_laps} чистых</div>
        <div class="driver-sub" style="color:${d.clean_sessions ? "var(--muted)" : "var(--orange)"}">${scoreText(d)}</div>
      </div>
      ${scoreRing(score, "sm")}
    </div>

    <div class="radar-wrap">
      <div class="radar-box"><canvas data-radar="${esc(d.name)}"></canvas></div>
      <div class="driver-scores">
        ${AXES.map((a) => {
          const value = Number(d[a.key]) || 0;
          return `<div class="driver-score-row"><span>${a.label}</span><b>${d.clean_sessions ? Math.round(value) : "—"}</b></div>
            <div class="bar" style="width:100%"><i style="width:${Math.max(d.clean_sessions ? 3 : 0, value)}%"></i></div>`;
        }).join("")}
      </div>
    </div>

    <div class="driver-tracks">${tracks || `<span class="dim" style="font-size:11.5px">Нет размеченных трасс</span>`}</div>

    <div class="inline-stats">
      <div class="inline-stat"><div class="k">Лучший круг</div><div class="v">${fmtTime(d.best)}</div></div>
      <div class="inline-stat"><div class="k">Ср. счёт</div><div class="v">${d.clean_sessions ? Math.round(d.score) : "—"}</div></div>
      <div class="inline-stat"><div class="k">Блокировки</div><div class="v">${locks}</div></div>
      <div class="inline-stat"><div class="k">Пробуксовки</div><div class="v">${spins}</div></div>
      <div class="inline-stat"><div class="k">Горячее давление</div><div class="v">${d.pressures?.some(Boolean) ? `${avg(d.pressures).toFixed(1)}` : "—"} <small>psi</small></div></div>
    </div>

    <div class="driver-footer">
      <span class="sc-hint">${latest ? `${fmtDate(latest.date)} · ${esc(latest.track)}` : "нет сессий"}</span>
      <div class="row" style="gap:6px">
        <button class="btn ghost sm" data-rename="${esc(d.name)}">${icon("pencil", 14)}Имя</button>
        ${latest ? `<a class="btn sm" href="#/session/${encodeURIComponent(latest.id)}/analysis">${icon("right", 14)}Открыть</a>` : ""}
      </div>
    </div>
  </div>`;
}

function openRename(d) {
  const count = d.sessions.length;
  openModal({
    title: "Переименовать пилота",
    sub: `${count} ${plural(count, "сессия", "сессии", "сессий")} получат новое имя`,
    narrow: true,
    body: `<div class="field"><label for="drv-name">Имя пилота</label>
      <input class="input" id="drv-name" maxlength="40" value="${esc(d.name)}" placeholder="Например, Иван">
      <div class="hint">Имя — это метка в библиотеке. Логи ACC его не содержат.</div></div>`,
    footer: `<span class="hint">Применится ко всем сессиям этого пилота</span>
      <div class="row"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="drv-ok">Сохранить</button></div>`,
    onMount(wrap, close) {
      const input = wrap.querySelector("#drv-name");
      const save = async () => {
        const to = input.value.trim();
        if (!to) { toast("Введи имя", "info"); return; }
        if (to === d.name) { close(); return; }
        try {
          const res = await api.renameDriver(d.name, to);
          store.invalidate();
          await store.load(true);
          toast(`Обновлено ${res.renamed} ${plural(res.renamed, "сессия", "сессии", "сессий")}`);
          close();
          window.dispatchEvent(new CustomEvent("apex:refresh"));
        } catch (err) {
          toast(err.message, "err");
        }
      };
      wrap.querySelector("#drv-ok").addEventListener("click", save);
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") save(); });
    },
  });
}

function paintRadars(root) {
  root.querySelectorAll("[data-radar]").forEach((canvas) => {
    const name = canvas.dataset.radar;
    const d = store.drivers.find((x) => x.name === name);
    if (!d) return;
    const axes = AXES.map((a) => ({ label: a.label, value: d.clean_sessions ? Number(d[a.key]) || 0 : 0 }));
    const draw = () => drawRadar(canvas, axes);
    draw();
    observe(canvas.parentElement, draw);
  });
}

export async function renderDrivers(root, params) {
  await store.load();
  const drivers = store.drivers || [];

  if (!drivers.length) {
    setTopbar({
      crumb: "ApexLab",
      title: "Пилоты",
      sub: "Ошибки и почерк каждого пилота",
      actions: `<button class="btn primary" id="top-import">${icon("upload", 16)}<span>Импорт</span></button>`,
    });
    document.getElementById("topbar")?.querySelector("#top-import")?.addEventListener("click", () => openImport());
    root.innerHTML = `<div class="page">${emptyState({
      iconName: "users",
      title: "Пилотов пока нет",
      text: "Импортируй логи ACC — приложение сгруппирует круги по пилотам и покажет ошибки каждого.",
      action: `<button class="btn primary" id="empty-import">${icon("upload", 16)}Импортировать логи</button>`,
    })}</div>`;
    root.querySelector("#empty-import")?.addEventListener("click", () => openImport());
    return;
  }

  const cleanDrivers = drivers.filter((d) => d.clean_sessions);
  const totalLaps = drivers.reduce((a, d) => a + (d.laps || 0), 0);
  const totalClean = drivers.reduce((a, d) => a + (d.clean_laps || 0), 0);
  const totalEvents = drivers.reduce((a, d) => a + ((d.events?.lock || 0) + (d.events?.spin || 0)), 0);
  const score = cleanDrivers.length ? avg(cleanDrivers.map((d) => d.score)) : 0;

  setTopbar({
    crumb: "ApexLab",
    title: "Пилоты",
    sub: `${drivers.length} ${plural(drivers.length, "пилот", "пилота", "пилотов")} · ${totalLaps} ${plural(totalLaps, "круг", "круга", "кругов")} · ${totalClean} чистых`,
    actions: `<button class="btn ghost icon" id="top-refresh" title="Перечитать библиотеку">${icon("refresh", 16)}</button>
      <button class="btn primary" id="top-import">${icon("upload", 16)}<span>Импорт</span></button>`,
  });

  root.innerHTML = `<div class="page">
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">${icon("users", 12)}Пилоты</div><div class="kpi-value">${drivers.length}</div><div class="kpi-sub">${cleanDrivers.length} с чистыми заездами</div></div>
      <div class="kpi"><div class="kpi-label">${icon("clock", 12)}Круги</div><div class="kpi-value">${totalLaps}</div><div class="kpi-sub">${totalClean} чистых</div></div>
      <div class="kpi"><div class="kpi-label">${icon("alert", 12)}Ошибки</div><div class="kpi-value">${totalEvents}</div><div class="kpi-sub">блокировки и пробуксовки</div></div>
      <div class="kpi"><div class="kpi-label">${icon("trophy", 12)}Средний счёт</div><div class="kpi-value">${score ? score.toFixed(0) : "—"}</div><div class="kpi-sub">${score ? scoreLabel(score) : "нужны чистые круги"}</div></div>
    </div>

    <div class="section-head" style="margin-top:22px">
      <div>
        <div class="section-title">${icon("users", 16)}Почерк пилотов</div>
        <div class="section-sub">Средние оценки по чистым сессиям; нажми «Имя», чтобы подписать логи</div>
      </div>
    </div>

    <div class="grid drivers-grid" id="driver-cards" style="margin-top:14px">
      ${drivers.map(cardHTML).join("")}
    </div>

    <div class="hint-box" style="margin-top:18px">${icon("info", 16)}<span>
      ACC не пишет имя пилота в MoTeC-лог. Импортируй логи по одному пилоту за раз или переименуй сессии —
      отчёты, ошибки и рекомендации по сету пересчитаются автоматически.
    </span></div>
  </div>`;

  paintRadars(root);

  const focusName = params?.get("driver");
  if (focusName) {
    const card = [...root.querySelectorAll("[data-driver]")]
      .find((el) => el.dataset.driver === focusName);
    if (card) {
      card.classList.add("focus");
      setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
      setTimeout(() => card.classList.remove("focus"), 4200);
    }
  }

  root.querySelectorAll("[data-rename]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = drivers.find((x) => x.name === btn.dataset.rename);
      if (d) openRename(d);
    });
  });

  const top = document.getElementById("topbar");
  top?.querySelector("#top-import")?.addEventListener("click", () => openImport({
    onDone: () => {
      store.invalidate();
      store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
    },
  }));
  top?.querySelector("#top-refresh")?.addEventListener("click", async () => {
    store.invalidate();
    await store.load(true);
    toast("Библиотека перечитана");
    window.dispatchEvent(new CustomEvent("apex:refresh"));
  });
}
