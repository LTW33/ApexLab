import { api } from "../api.js";
import { store } from "../store.js";
import {
  esc, fmtTime, fmtShort, fmtKm, fmtDate, fmtClock, fmtDateTime,
  icon, scoreRing, scoreColor, scoreLabel, avg, sum, plural, tagMeta,
} from "../util.js";
import { TrackMap } from "../charts.js";
import {
  life, setTopbar, observe, emptyState, toast, confirmDialog, openModal, printPage,
} from "../ui.js";
import { openImport } from "../importmodal.js";

const packCache = new Map();

function kpi(iconName, label, value, sub) {
  return `<div class="kpi">
    <div class="kpi-label">${icon(iconName, 12)}${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

function lapSummary(s) {
  const rep = s.report || {};
  const clean = !!rep.clean && Number(s.clean_laps) > 0;
  const ev = rep.events || {};
  const mistakes = (ev.lock?.count || 0) + (ev.spin?.count || 0);
  return { rep, clean, mistakes };
}

function cardHTML(s) {
  const { rep, clean, mistakes } = lapSummary(s);
  const score = clean ? rep.score : null;
  const best = s.best_time;
  const trackTag = s.laps.length;
  const cleanTag = Number(s.clean_laps || 0);
  const tags = [];
  if (clean) tags.push(`<span class="badge lime">${cleanTag} ${plural(cleanTag, "чистый", "чистых", "чистых")}</span>`);
  else tags.push(`<span class="badge orange">нет чистых кругов</span>`);
  if (s.laps.length) tags.push(`<span class="badge grey">${trackTag} ${plural(trackTag, "круг", "круга", "кругов")}</span>`);

  const avgText = clean && rep.average ? fmtShort(rep.average) : "—";
  const consistency = clean && rep.consistency != null ? `${Math.round(rep.consistency)}%` : "—";

  return `<a class="card session-card" href="#/session/${s.id}/analysis" data-id="${s.id}">
    <div class="sc-top">
      <div class="grow">
        <div class="sc-track"><span class="flag"></span>${esc(s.track)}</div>
        <div class="sc-car">${esc(s.car)}</div>
        <div class="sc-meta">
          ${tags.join("")}
          <span class="badge outline">${fmtDate(s.date)}${fmtClock(s.time) ? ` · ${fmtClock(s.time)}` : ""}</span>
        </div>
      </div>
      ${scoreRing(score, "sm")}
    </div>
    <div class="sc-map"><canvas class="map"></canvas></div>
    <div class="sc-stats">
      <div class="sc-stat"><div class="k">Лучший круг</div><div class="v">${clean ? fmtTime(best) : fmtTime(best) + " <small>предв.</small>"}</div></div>
      <div class="sc-stat"><div class="k">Средний</div><div class="v">${avgText}</div></div>
      <div class="sc-stat"><div class="k">Стабильность</div><div class="v">${consistency}</div></div>
      <div class="sc-stat"><div class="k">Ошибки</div><div class="v">${mistakes} <small>лок./букс.</small></div></div>
    </div>
    <div class="sc-foot">
      <span class="sc-hint">${icon("user", 12)}${esc(s.driver || "Пилот")}</span>
      <span class="sc-hint">Открыть ${icon("right", 12)}</span>
    </div>
  </a>`;
}

function emptyLibrary(container) {
  container.innerHTML = `<div class="page">
    <div class="session-hero">
      <div class="hero-main">
        <div class="eyebrow">APEXLAB · ACC TELEMETRY</div>
        <div class="hero-title">Разбор телеметрии, который понятно читать</div>
        <div class="hero-meta" style="max-width:720px;line-height:1.65">
          Загрузи логи MoTeC из Assetto Corsa Competizione — приложение найдёт круги,
          ошибки пилота, потери времени по поворотам и подскажет, что менять в сете.
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" id="empty-import">${icon("upload", 16)}Импортировать логи</button>
          <a class="btn ghost" href="#/settings">${icon("settings", 16)}Указать папку</a>
        </div>
      </div>
      ${scoreRing(96, "lg")}
    </div>
    <div class="kpi-grid">
      ${kpi("clock", "Круги", "—", "появятся после импорта")}
      ${kpi("gauge", "Скорость", "—", "максимальная и средняя")}
      ${kpi("trend", "Потери", "—", "по поворотам и секторам")}
      ${kpi("wrench", "Сет", "—", "рекомендации по настройкам")}
    </div>
    <div class="equal-col">
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("upload", 16)}1. Импорт</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">Приложение само найдёт папку <span class="mono">MoTeC</span> в документах ACC. Можно импортировать все логи сразу — дубликаты и обрывки отсеются.</div></div>
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("target", 16)}2. Разбор</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">Блокировки, пробуксовки, пробои, перегрев тормозов, накат. Для каждого — поворот, скорость и величина ошибки.</div></div>
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("wrench", 16)}3. Сет</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">Давления, воздуховоды, баланс тормозов, стабилизаторы. Рекомендации опираются на твои логи и выбранный сет.</div></div>
    </div>
  </div>`;
  container.querySelector("#empty-import").addEventListener("click", () => openImport());
}

export async function renderGarage(root) {
  await store.load();
  const sessions = store.sorted();

  if (!sessions.length) {
    setTopbar({
      crumb: "ApexLab",
      title: "Гараж",
      sub: "Локальная телеметрия Assetto Corsa Competizione",
      actions: `<button class="btn primary" id="top-import">${icon("upload", 16)}<span>Импорт</span></button>`,
    });
    const top = document.getElementById("topbar");
    top.querySelector("#top-import").addEventListener("click", () => openImport());
    emptyLibrary(root);
    return;
  }

  const tracks = store.tracks();
  const totalLaps = sum(sessions.map((s) => s.laps.length));
  const cleanLaps = sum(sessions.map((s) => s.clean_laps || 0));
  const totalKm = sum(sessions.map((s) => s.report?.km || 0));
  const scored = sessions.filter((s) => s.report?.clean && s.report?.score);
  const avgScore = scored.length ? avg(scored.map((s) => s.report.score)) : 0;
  const bestScore = scored.length ? Math.max(...scored.map((s) => s.report.score)) : 0;
  const cars = store.cars();

  setTopbar({
    crumb: "ApexLab",
    title: "Гараж",
    sub: `${sessions.length} ${plural(sessions.length, "сессия", "сессии", "сессий")} · ${tracks.length} ${plural(tracks.length, "трасса", "трассы", "трасс")} · ${cars.length} ${plural(cars.length, "машина", "машины", "машин")}`,
    actions: `<button class="btn ghost icon" id="top-refresh" title="Перечитать библиотеку">${icon("refresh", 16)}</button>
      <button class="btn primary" id="top-import">${icon("upload", 16)}<span>Импорт</span></button>`,
  });

  const state = { track: "all", q: "", sort: "date" };

  root.innerHTML = `<div class="page">
    <div class="kpi-grid">
      ${kpi("car", "Сессии", String(sessions.length), `${tracks.length} ${plural(tracks.length, "трасса", "трассы", "трасс")} · ${esc(cars[0] || "")}${cars.length > 1 ? " и др." : ""}`)}
      ${kpi("clock", "Чистые круги", String(cleanLaps), `из ${totalLaps} ${plural(totalLaps, "круга", "кругов", "кругов")} в логах`)}
      ${kpi("gauge", "Дистанция", `${Math.round(totalKm)} <small>км</small>`, "пройдено по телеметрии")}
      ${kpi("trophy", "Средний счёт", avgScore ? avgScore.toFixed(1) : "—", bestScore ? `лучшая сессия — ${Math.round(bestScore)}` : "нет чистых сессий")}
    </div>

    <div class="section-head">
      <div class="chips" id="track-chips"></div>
      <div class="row">
        <div class="input-group" style="width:230px">
          ${icon("search", 15)}
          <input class="input" id="search" placeholder="Трасса, машина, пилот" autocomplete="off">
        </div>
        <select class="select" id="sort" style="width:170px">
          <option value="date">Сначала новые</option>
          <option value="score">По оценке</option>
          <option value="best">По лучшему кругу</option>
          <option value="errors">По числу ошибок</option>
        </select>
      </div>
    </div>

    <div class="sessions-grid" id="cards"></div>
    <div id="no-match" class="hidden"></div>
  </div>`;

  const cards = root.querySelector("#cards");
  const noMatch = root.querySelector("#no-match");
  const chips = root.querySelector("#track-chips");
  let observers = [];

  const cleanupMaps = () => {
    observers.forEach((o) => o.disconnect());
    observers = [];
  };
  life.add(cleanupMaps);

  function renderChips() {
    chips.innerHTML = `<button class="chip${state.track === "all" ? " active" : ""}" data-track="all">Все трассы <span class="n">${sessions.length}</span></button>`
      + tracks.map((t) => `<button class="chip${state.track === t.key ? " active" : ""}" data-track="${esc(t.key)}">${esc(t.name)} <span class="n">${t.count}</span></button>`).join("");
    chips.querySelectorAll("[data-track]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.track = btn.dataset.track;
        renderChips();
        renderCards();
      });
    });
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let list = sessions.filter((s) => {
      if (state.track !== "all" && (s.track_id || s.track) !== state.track) return false;
      if (!q) return true;
      return `${s.track} ${s.car} ${s.driver} ${s.name}`.toLowerCase().includes(q);
    });
    if (state.sort === "score") {
      list.sort((a, b) => (b.report?.clean ? b.report.score : -1) - (a.report?.clean ? a.report.score : -1));
    } else if (state.sort === "best") {
      list.sort((a, b) => (a.best_time || 9e9) - (b.best_time || 9e9));
    } else if (state.sort === "errors") {
      list.sort((a, b) => {
        const ea = (a.report?.events?.lock?.count || 0) + (a.report?.events?.spin?.count || 0);
        const eb = (b.report?.events?.lock?.count || 0) + (b.report?.events?.spin?.count || 0);
        return eb - ea;
      });
    }
    return list;
  }

  async function paintMaps() {
    const nodes = [...cards.querySelectorAll(".session-card")];
    await Promise.all(nodes.map(async (card) => {
      const sid = card.dataset.id;
      const s = store.session(sid);
      const canvas = card.querySelector("canvas.map");
      if (!s || !canvas) return;
      let pack = packCache.get(sid);
      if (!pack) {
        try {
          pack = await api.lap(sid, s.best_index);
          packCache.set(sid, pack);
        } catch {
          return;
        }
      }
      if (!canvas.isConnected) return;
      const map = new TrackMap(canvas, { compact: true, corners: false, events: false });
      map.setData({ pack });
      const parent = canvas.parentElement;
      if (parent && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => map.draw());
        ro.observe(parent);
        observers.push(ro);
      }
    }));
  }

  function renderCards() {
    cleanupMaps();
    const list = filtered();
    if (!list.length) {
      cards.innerHTML = "";
      noMatch.innerHTML = emptyState({
        iconName: "search",
        title: "Ничего не найдено",
        text: "Попробуй другой запрос или сбрось фильтр по трассе.",
        action: `<button class="btn" id="reset-filter">Сбросить фильтры</button>`,
      });
      noMatch.querySelector("#reset-filter").addEventListener("click", () => {
        state.track = "all";
        state.q = "";
        root.querySelector("#search").value = "";
        renderChips();
        renderCards();
      });
      return;
    }
    noMatch.innerHTML = "";
    cards.innerHTML = list.map(cardHTML).join("");
    paintMaps();
  }

  renderChips();
  renderCards();

  const search = root.querySelector("#search");
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = search.value;
      renderCards();
    }, 140);
  });
  root.querySelector("#sort").addEventListener("change", (ev) => {
    state.sort = ev.target.value;
    renderCards();
  });

  const top = document.getElementById("topbar");
  top.querySelector("#top-import").addEventListener("click", () => openImport({
    onDone: () => { packCache.clear(); store.load(true).then(() => routeRefresh()); },
  }));
  top.querySelector("#top-refresh").addEventListener("click", async () => {
    store.invalidate();
    await store.load(true);
    packCache.clear();
    routeRefresh();
    toast("Библиотека перечитана");
  });
}

function routeRefresh() {
  window.dispatchEvent(new CustomEvent("apex:refresh"));
}
