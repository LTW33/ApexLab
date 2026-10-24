import { api } from "../api.js";
import { store } from "../store.js";
import {
  esc, fmtTime, fmtShort, fmtDelta, deltaClass, fmtKm, fmtDate, fmtClock,
  icon, scoreRing, scoreLabel, balanceText, sum, plural, tagMeta, sampleAt, avg,
} from "../util.js";
import { TraceChart, TrackMap, DeltaChart, TrajectoryMap, LineDevChart, computeDelta } from "../charts.js";
import {
  life, setTopbar, observe, toast, confirmDialog, openModal, emptyState,
} from "../ui.js";
import { openImport } from "../importmodal.js";
import { exportSessionReport } from "../report.js";

const TABS = [
  { key: "analysis", label: "Обзор", icon: "gauge" },
  { key: "line", label: "Траектория", icon: "route" },
  { key: "laps", label: "Круги", icon: "clock" },
  { key: "errors", label: "Ошибки", icon: "alert" },
  { key: "setup", label: "Сет", icon: "wrench" },
];

const TAB_TITLES = {
  analysis: "Разбор сессии",
  line: "Траектория",
  laps: "Круги",
  errors: "Ошибки пилота",
  setup: "Сет и рекомендации",
};

const EVENT_ORDER = ["lock", "spin", "bottom", "brake_temp", "coast"];

const EVENT_TIPS = {
  lock: {
    title: "Блокировки передних",
    text: "Тормози чуть раньше и плавнее отпускай педаль на входе. В сете поможет баланс тормозов назад на 0.5–1% и ABS +1.",
  },
  spin: {
    title: "Пробуксовка на выходе",
    text: "Не открывай газ до распрямления руля. В сете: TC1 +1, мягче преднатяг, стабильнее задняя ось.",
  },
  bottom: {
    title: "Пробои подвески",
    text: "Машина цепляет отбойники на поребриках и в компрессии. Подними клиренс или пружины — иначе теряется предсказуемость.",
  },
  brake_temp: {
    title: "Перегрев тормозов",
    text: "Открой воздуховоды на 1 клик и проверь стиль торможения: длинные серии с малым замедлением греют диски сильнее коротких.",
  },
  coast: {
    title: "Движение накатом",
    text: "Между газом и тормозом теряется время. Держи педаль тормоза до апекса или раньше открывай газ — но не оба сразу.",
  },
};

function pct(value) {
  const v = Number(value);
  return Number.isFinite(v) ? `${Math.round(v)}%` : "—";
}

function sevBadge(severity) {
  if (severity === "high") return `<span class="badge red">важно</span>`;
  if (severity === "mid") return `<span class="badge orange">стоит</span>`;
  return `<span class="badge blue">на заметку</span>`;
}

function eventName(type) {
  return {
    lock: "Блокировки", spin: "Пробуксовки", bottom: "Пробои",
    brake_temp: "Перегрев тормозов", coast: "Накат",
  }[type] || type;
}

function eventColor(type) {
  return {
    lock: "var(--red)", spin: "var(--yellow)", bottom: "var(--purple)",
    brake_temp: "var(--orange)", coast: "var(--muted)",
  }[type] || "var(--muted)";
}

function goSession(sid, tab, lap) {
  const q = lap != null ? `?lap=${lap}` : "";
  location.hash = `#/session/${sid}/${tab}${q}`;
}

/* ------------------------------------------------------------------ hero */

function heroHTML(meta, rep, lapIndex) {
  const id = encodeURIComponent(meta.id);
  const clean = !!rep.clean;
  const score = clean ? rep.score : null;
  const tags = [];
  tags.push(`<span class="badge ${meta.clean_laps ? "lime" : "orange"}">${meta.clean_laps || 0} ${plural(meta.clean_laps || 0, "чистый круг", "чистых круга", "чистых кругов")}</span>`);
  if (!clean) tags.push(`<span class="badge orange">оценка предварительная</span>`);
  if (meta.rates?.speed) tags.push(`<span class="badge grey">${Math.round(meta.rates.speed)} Гц</span>`);

  return `<div class="session-hero">
    <div class="hero-main">
      <div class="eyebrow">APEXLAB · SESSION</div>
      <div class="hero-title">${esc(meta.track)}</div>
      <div class="hero-meta">
        <span class="hero-driver">${icon("user", 14)}${esc(meta.driver || "Пилот")}</span>
        <span class="dot"></span>
        <span>${esc(meta.car)}</span>
        <span class="dot"></span>
        <span>${fmtDate(meta.date)}${fmtClock(meta.time) ? ` · ${fmtClock(meta.time)}` : ""}</span>
        <span class="dot"></span>
        <span>${meta.laps.length} ${plural(meta.laps.length, "круг", "круга", "кругов")} в разборе</span>
      </div>
      <div class="sc-meta" style="margin-top:2px">${tags.join("")}</div>
      <div class="hero-actions" style="margin-top:8px">
        <button class="btn sm" id="rename-driver">${icon("pencil", 14)}Переименовать</button>
        <button class="btn sm" id="export-report" title="Сохранить отчёт в файл · Ctrl+E">${icon("download", 14)}Отчёт</button>
        <a class="btn sm ghost" href="#/compare?track=${encodeURIComponent(meta.track_id || meta.track)}&a=${id}:${lapIndex}">${icon("compare", 14)}Сравнить</a>
        <button class="btn sm danger" id="delete-session">${icon("trash", 14)}Удалить</button>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:9px">
      ${scoreRing(score, "lg")}
      <span class="badge ${clean ? "lime" : "grey"}">${scoreLabel(score)}</span>
    </div>
  </div>`;
}

function statsHTML(meta, rep) {
  const laps = rep.laps || 0;
  return `<div class="hero-stats" style="margin:0;border:1px solid var(--line);border-radius:16px;overflow:hidden">
    <div class="hero-stat">
      <div class="k">Лучший круг</div>
      <div class="v">${fmtTime(meta.best_time)}</div>
      <div class="s">круг #${meta.best_index}</div>
    </div>
    <div class="hero-stat">
      <div class="k">Средний</div>
      <div class="v">${laps ? fmtShort(rep.average) : "—"}</div>
      <div class="s">по ${laps || 0} ${plural(laps || 0, "кругу", "кругам", "кругам")}</div>
    </div>
    <div class="hero-stat">
      <div class="k">Потенциал</div>
      <div class="v">${rep.potential != null ? fmtDelta(rep.potential) : "—"}</div>
      <div class="s">лучшие 5 кругов</div>
    </div>
    <div class="hero-stat">
      <div class="k">Стабильность</div>
      <div class="v">${pct(rep.consistency)}</div>
      <div class="s">разброс ${rep.std != null ? `±${rep.std.toFixed(3)}` : "—"}</div>
    </div>
    <div class="hero-stat">
      <div class="k">Макс. скорость</div>
      <div class="v">${rep.top_speed ? Math.round(rep.top_speed) : "—"} <small>км/ч</small></div>
      <div class="s">${rep.throttle_pct != null ? `${pct(rep.throttle_pct)} полного газа` : ""}</div>
    </div>
    <div class="hero-stat">
      <div class="k">Дистанция</div>
      <div class="v">${rep.km ? rep.km.toFixed(1) : "—"} <small>км</small></div>
      <div class="s">${meta.clean_laps || 0} чистых из ${meta.laps.length}</div>
    </div>
  </div>`;
}

function tabsHTML(meta, active, lapIndex) {
  return `<div class="tabs">${TABS.map((t, i) => {
    const q = lapIndex != null ? `?lap=${lapIndex}` : "";
    const count = t.key === "laps" ? meta.laps.length
      : t.key === "errors" ? sum(EVENT_ORDER.map((k) => meta.report?.events?.[k]?.count || 0))
        : null;
    return `<a class="tab${t.key === active ? " active" : ""}" href="#/session/${encodeURIComponent(meta.id)}/${t.key}${q}" title="Alt+${i + 1}">
      ${icon(t.icon, 15)}<span>${t.label}</span>${count != null ? `<span class="n">${count}</span>` : ""}
    </a>`;
  }).join("")}</div>`;
}

function warningHTML(rep, meta) {
  if (rep.clean) return "";
  return `<div class="hint-box warn">${icon("alert", 16)}<span>
    <b>Нет чистых кругов.</b> Оценка и потери времени считаются по всем кругам и носят предварительный характер —
    в логе есть выезды, пит-лейн или контакт. Для точного разбора нужна серия чистых кругов.
  </span></div>`;
}

/* ------------------------------------------------------------- telemetry */

function lapOptions(meta, lapIndex) {
  return meta.laps.map((l) => {
    const tags = (l.tags || []).map((t) => tagMeta(t).label).filter(Boolean);
    const suffix = tags.length ? ` · ${tags.join(", ")}` : "";
    return `<option value="${l.index}"${l.index === lapIndex ? " selected" : ""}>
      #${l.index} · ${fmtTime(l.time)}${l.index === meta.best_index ? " · лучший" : ""}${l.valid ? "" : " · не чистый"}${suffix}
    </option>`;
  }).join("");
}

function readoutHTML(point, pack) {
  if (!point) return `<span class="hint">Наведи курсор на график — покажу значения в этой точке.</span>`;
  const delta = pack?.delta?.[point.i];
  return `<div class="inline-stats">
    <div class="inline-stat"><div class="k">Скорость</div><div class="v">${Math.round(point.speed)} <small>км/ч</small></div></div>
    <div class="inline-stat"><div class="k">Газ</div><div class="v">${Math.round(point.thr)}%</div></div>
    <div class="inline-stat"><div class="k">Тормоз</div><div class="v">${Math.round(point.brk)}%</div></div>
    <div class="inline-stat"><div class="k">Передача</div><div class="v">${Math.round(point.gear) || "—"}</div></div>
    <div class="inline-stat"><div class="k">Руль</div><div class="v">${Math.round(point.steer)}%</div></div>
    <div class="inline-stat"><div class="k">Дельта</div><div class="v ${deltaClass(delta)}">${delta != null ? fmtDelta(delta) : "—"}</div></div>
    <div class="inline-stat"><div class="k">Дистанция</div><div class="v">${Math.round(point.dist)} м</div></div>
  </div>`;
}

function tracePanelHTML(meta, lapIndex) {
  return `<div class="panel">
    <div class="panel-head">
      <div class="panel-title">${icon("trend", 16)}Телеметрия <span class="panel-sub" id="lap-caption">круг #${lapIndex}</span></div>
      <div class="panel-actions">
        <select class="select" id="lap-select" style="min-width:220px">${lapOptions(meta, lapIndex)}</select>
      </div>
    </div>
    <div class="panel-body tight" style="padding:10px 14px 0">
      <div class="row" style="justify-content:space-between;margin-bottom:4px">
        <div class="legend">
          <span class="legend-item"><span class="swatch" style="background:var(--accent)"></span>скорость</span>
          <span class="legend-item"><span class="swatch" style="background:var(--green)"></span>газ</span>
          <span class="legend-item"><span class="swatch" style="background:var(--red)"></span>тормоз</span>
          <span class="legend-item"><span class="swatch" style="background:var(--blue)"></span>руль</span>
        </div>
        <div class="row" style="gap:5px">
          <button class="toggle on" data-ch="speed">Скорость</button>
          <button class="toggle on" data-ch="pedals">Педали</button>
          <button class="toggle on" data-ch="steer">Руль</button>
          <button class="toggle on" data-ch="gear">Передачи</button>
        </div>
      </div>
      <div class="chart-box" id="trace-box"><canvas id="trace"></canvas></div>
    </div>
    <div class="panel-foot" id="readout" style="min-height:48px">${readoutHTML(null)}</div>
  </div>`;
}

function mapPanelHTML() {
  return `<div class="panel">
    <div class="panel-head">
      <div class="panel-title">${icon("map", 16)}Траектория</div>
      <div class="panel-actions"><span class="badge grey">скорость</span></div>
    </div>
    <div class="panel-body" style="padding:8px 10px 10px">
      <div class="map-box tall" id="map-box"><canvas id="map"></canvas>
        <div class="map-legend"><span>медленно</span><span class="grad"></span><span>быстро</span></div>
      </div>
    </div>
  </div>`;
}

function mountTelemetry(root, pack, bestPack, deltaChart) {
  const traceCanvas = root.querySelector("#trace");
  const mapCanvas = root.querySelector("#map");
  const traceBox = root.querySelector("#trace-box");
  const mapBox = root.querySelector("#map-box");
  const readout = root.querySelector("#readout");
  if (!traceCanvas || !mapCanvas || !pack) return () => {};

  const trace = new TraceChart(traceCanvas, {});
  const map = new TrackMap(mapCanvas, {});
  trace.setData({ laps: [{ pack }], corners: pack.corners || [] });
  map.setData({ pack, corners: pack.corners || [] });

  let applyCursor = (dist) => {
    trace.setCursor(dist);
    map.setCursor(dist);
    deltaChart?.setCursor(dist);
    if (readout) readout.innerHTML = dist == null ? readoutHTML(null) : readoutHTML(sampleAt(pack, dist), pack);
  };

  let frame = 0;
  let pending = null;
  const schedule = (dist) => {
    pending = dist;
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyCursor(pending);
      });
    }
  };

  traceCanvas.addEventListener("pointermove", (ev) => {
    const rect = traceCanvas.getBoundingClientRect();
    const dist = trace.distAtX(ev.clientX - rect.left);
    if (dist != null) schedule(dist);
  });
  traceCanvas.addEventListener("pointerleave", () => schedule(null));
  mapCanvas.addEventListener("pointermove", (ev) => {
    const hit = map.hitTest(ev.clientX, ev.clientY);
    if (hit) schedule(hit.dist);
  });
  mapCanvas.addEventListener("pointerleave", () => schedule(null));

  root.querySelectorAll("[data-ch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.ch;
      const on = !btn.classList.contains("on");
      btn.classList.toggle("on", on);
      trace.setChannels({ [key]: on });
    });
  });

  root.querySelectorAll("[data-cursor]").forEach((el) => {
    el.addEventListener("click", () => {
      const dist = Number(el.dataset.cursor);
      applyCursor(dist);
      root.querySelector("#trace-box")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  const redraw = () => { trace.draw(); map.draw(); };
  observe(traceBox, () => trace.draw());
  observe(mapBox, () => map.draw());
  requestAnimationFrame(redraw);

  life.add(() => cancelAnimationFrame(frame));
  return applyCursor;
}

/* ------------------------------------------------------------- analysis */

function cornerRows(pack, meta) {
  const corners = pack?.corners || [];
  if (!corners.length) return `<div class="empty" style="padding:32px 16px"><div class="empty-icon">${icon("map", 22)}</div><h3>Повороты не найдены</h3><p>В логе слишком мало данных о боковых перегрузках.</p></div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Поворот</th><th class="num">Потеря</th><th class="num">Вход</th><th class="num">Апекс</th><th class="num">Выход</th><th class="num">Передача</th><th>Баланс</th><th class="center">Ошибки</th></tr></thead>
    <tbody>${corners.map((c) => {
      const evs = (pack.events || []).filter((e) => e.corner === c.name);
      const loss = Number(c.loss || 0);
      return `<tr class="clickable" data-cursor="${c.apex}">
        <td class="name">${esc(c.name)}<span class="sub">${Math.round(c.start)}–${Math.round(c.end)} м</span></td>
        <td class="num ${deltaClass(loss)}">${Math.abs(loss) < 0.0005 ? "—" : fmtDelta(loss)}</td>
        <td class="num">${Math.round(c.entry_speed || 0)}</td>
        <td class="num">${Math.round(c.apex_speed || 0)}</td>
        <td class="num">${Math.round(c.exit_speed || 0)}</td>
        <td class="num">${c.gear || "—"}</td>
        <td>${balanceText(c.balance)}</td>
        <td class="center">${evs.length ? `<span class="badge red">${evs.length}</span>` : `<span class="dim">—</span>`}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function eventListHTML(pack, limit = 40) {
  const events = [...(pack?.events || [])].sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, limit);
  if (!events.length) {
    return `<div class="empty" style="padding:30px 14px">
      <div class="empty-icon">${icon("check", 22)}</div>
      <h3>Чисто</h3><p>На этом круге не найдено блокировок, пробуксовок и пробоев.</p></div>`;
  }
  return `<div class="event-list">${events.map((e) => `<div class="event" data-cursor="${e.dist}">
    <div class="event-ico" style="color:${eventColor(e.type)};background:${eventColor(e.type)}18">${icon(e.type === "brake_temp" ? "thermo" : e.type === "bottom" ? "layers" : e.type === "coast" ? "wind" : "alert", 15)}</div>
    <div class="event-body">
      <div class="event-title"><span>${esc(e.label)}</span><span class="sev">${Math.round(e.severity || 0)}</span></div>
      <div class="event-detail">${esc(e.detail)}</div>
      <div class="event-meta">${e.corner ? `<span class="corner">${esc(e.corner)}</span><span>·</span>` : ""}<span>${Math.round(e.dist)} м</span><span>·</span><span>${Math.round(e.start)}–${Math.round(e.end)} м</span></div>
    </div>
  </div>`).join("")}</div>`;
}

function eventTilesHTML(rep) {
  return `<div class="event-summary">${EVENT_ORDER.map((key) => {
    const count = rep.events?.[key]?.count || 0;
    return `<div class="event-tile">
      <div class="k"><span class="dot" style="background:${eventColor(key)}"></span>${eventName(key)}</div>
      <div class="v">${count}${key === "coast" ? "" : ` <small>${plural(count, "раз", "раза", "раз")}</small>`}</div>
      <div class="s">${key === "coast" ? "эпизодов без газа и тормоза" : "за сессию по всем кругам"}</div>
    </div>`;
  }).join("")}</div>`;
}

function pressureGoal(target) {
  const t = Number(target);
  return t ? `цель ${t.toFixed(1)} psi` : "цель по классу";
}

function wheelGrid(title, values, kind, target = null) {
  if (!values?.length) return "";
  return `<div>
    <div class="label">${title}</div>
    <div class="wheel-grid">${["ПЛ", "ПП", "ЗЛ", "ЗП"].map((w, i) => {
      const v = Number(values[i]) || 0;
      let cls = "";
      let sub = "";
      const goal = kind === "pressure" ? Number(target) || 27.6 : 0;
      if (kind === "pressure") {
        if (v > goal + 0.3) cls = "hot";
        if (v > 0 && v < goal - 0.3) cls = "cold";
        const d = v - goal;
        sub = v ? `${d > 0 ? "+" : ""}${d.toFixed(1)}` : "—";
      } else if (kind === "brake") {
        if (v > 800) cls = "hot";
        if (v > 0 && v < 380) cls = "cold";
        sub = v ? "°C" : "—";
      } else {
        sub = v ? "°C" : "—";
      }
      return `<div class="wheel-cell ${cls}"><div class="w">${w}</div><div class="val">${v ? v.toFixed(kind === "pressure" ? 1 : 0) : "—"}</div><div class="w" style="letter-spacing:0;text-transform:none;margin-top:1px">${sub}</div></div>`;
    }).join("")}</div>
  </div>`;
}

function analysisHTML(meta, rep, pack) {
  const losses = (rep.corner_loss || []).slice(0, 5);
  return `<div class="section" style="gap:16px">
    <div class="two-col">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        ${tracePanelHTML(meta, pack?.index ?? meta.best_index)}
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("trend", 16)}Дельта к лучшему кругу</div>
            <div class="panel-actions"><span class="legend-item"><span class="swatch" style="background:rgb(var(--red-rgb) / .7)"></span>медленнее</span>
            <span class="legend-item"><span class="swatch" style="background:rgb(var(--accent-rgb) / .7)"></span>быстрее</span></div>
          </div>
          <div class="panel-body" style="padding:8px 14px 6px"><div class="chart-box"><canvas id="delta"></canvas></div></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        ${mapPanelHTML()}
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("alert", 16)}Ошибки на круге</div>
            <div class="panel-actions"><a class="btn ghost sm" href="#/session/${encodeURIComponent(meta.id)}/errors?lap=${pack?.index ?? meta.best_index}">Все ошибки</a></div>
          </div>
          <div class="panel-body" style="padding:12px">${eventListHTML(pack, 4)}</div>
        </div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("target", 16)}Потери по поворотам</div>
          <div class="panel-actions"><span class="panel-sub">выбранный круг к лучшему</span></div>
        </div>
        ${cornerRows(pack, meta)}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("thermo", 16)}Шины и тормоза</div>
            <div class="panel-actions"><span class="panel-sub">горячие значения</span></div>
          </div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:14px">
            ${wheelGrid(`Давление · ${pressureGoal(rep.pressure_target)}`, rep.pressures, "pressure", rep.pressure_target)}
            ${wheelGrid("Тормоза", rep.brake_temps, "brake")}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("wrench", 16)}Что менять в сете</div>
            <div class="panel-actions"><a class="btn ghost sm" href="#/session/${encodeURIComponent(meta.id)}/setup?lap=${pack?.index ?? meta.best_index}">Подобрать ${icon("right", 12)}</a></div>
          </div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:10px">
            ${losses.length ? losses.map((c) => `<div class="kv"><span class="k">${esc(c.name)} · средняя потеря</span><span class="v ${deltaClass(c.loss)}">${fmtDelta(c.loss)}</span></div>`).join("")
              : `<span class="muted" style="font-size:12px">Нет данных о потерях по поворотам.</span>`}
            <div class="hint-box" style="margin-top:2px">${icon("info", 16)}<span>Открой вкладку «Сет»: рекомендации учитывают давления, тормоза, блокировки и баланс машины.</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- laps */

function lapsHTML(meta, rep) {
  const rows = [...meta.laps].sort((a, b) => a.index - b.index);
  return `<div class="section" style="gap:16px">
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">${icon("clock", 12)}Круги в логе</div><div class="kpi-value">${meta.laps_total || rows.length}</div><div class="kpi-sub">${rows.length} разобрано</div></div>
      <div class="kpi"><div class="kpi-label">${icon("check", 12)}Чистые</div><div class="kpi-value">${meta.clean_laps || 0}</div><div class="kpi-sub">${meta.laps.length ? Math.round((meta.clean_laps || 0) / meta.laps.length * 100) : 0}% сессии</div></div>
      <div class="kpi"><div class="kpi-label">${icon("trend", 12)}Средний</div><div class="kpi-value">${rep.average ? fmtShort(rep.average) : "—"}</div><div class="kpi-sub">разброс ±${rep.std ?? "—"}</div></div>
      <div class="kpi"><div class="kpi-label">${icon("target", 12)}Потенциал</div><div class="kpi-value ${deltaClass(-(rep.potential || 0))}">${rep.potential != null ? fmtDelta(rep.potential) : "—"}</div><div class="kpi-sub">между лучшим и средним из 5</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">${icon("clock", 16)}Все круги</div>
        <div class="panel-actions"><span class="panel-sub">нажми на круг, чтобы открыть разбор</span></div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Круг</th><th class="num">Время</th><th class="num">Дельта</th><th class="num">Макс.</th><th class="center">Блок.</th><th class="center">Букс.</th><th class="center">Пробои</th><th>Метки</th><th class="center">Статус</th></tr></thead>
        <tbody>${rows.map((l) => {
          const delta = l.time - meta.best_time;
          const ev = l.events || {};
          const best = l.index === meta.best_index;
          const tags = (l.tags || []).map((t) => {
            const m = tagMeta(t);
            return `<span class="badge ${m.cls}">${m.label}</span>`;
          }).join(" ");
          return `<tr class="clickable${best ? " best" : ""}" data-lap="${l.index}">
            <td class="name">#${l.index}${best ? ` <span class="badge lime">лучший</span>` : ""}</td>
            <td class="num">${fmtTime(l.time)}</td>
            <td class="num ${deltaClass(delta)}">${best ? "—" : fmtDelta(delta)}</td>
            <td class="num">${Math.round(l.top_speed || 0)}</td>
            <td class="center">${ev.lock || 0}</td>
            <td class="center">${ev.spin || 0}</td>
            <td class="center">${ev.bottom || 0}</td>
            <td>${tags || `<span class="dim">—</span>`}</td>
            <td class="center">${l.valid ? `<span class="badge lime">чистый</span>` : `<span class="badge grey">не чистый</span>`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- errors */

function errorsHTML(meta, rep, pack) {
  const counts = EVENT_ORDER.map((k) => ({ key: k, n: rep.events?.[k]?.count || 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const tips = counts.filter((c) => EVENT_TIPS[c.key]);
  return `<div class="section" style="gap:16px">
    ${eventTilesHTML(rep)}
    <div class="two-col">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">${icon("alert", 16)}События круга #${pack?.index ?? "—"}</div>
          <div class="panel-actions"><select class="select" id="lap-select" style="min-width:200px">${lapOptions(meta, pack?.index ?? meta.best_index)}</select></div>
        </div>
        <div class="panel-body" style="padding:12px">${eventListHTML(pack, 20)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("target", 16)}Где теряется время</div>
          <div class="panel-actions"><span class="panel-sub">средняя потеря за круг</span></div>
        </div>
        ${(rep.corner_loss || []).length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Поворот</th><th class="num">Потеря</th><th class="num">Кругов</th><th>Доля</th></tr></thead>
          <tbody>${rep.corner_loss.map((c, i) => {
            const max = Math.max(...rep.corner_loss.map((x) => Math.abs(x.loss) || 0), 0.001);
            return `<tr>
              <td class="name"><span class="badge grey">${i + 1}</span> ${esc(c.name)}</td>
              <td class="num ${deltaClass(c.loss)}">${fmtDelta(c.loss)}</td>
              <td class="num">${c.laps}</td>
              <td><div class="bar ${c.loss > 0 ? "red" : ""}" style="width:110px"><i style="width:${Math.max(4, Math.abs(c.loss) / max * 100)}%"></i></div></td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : `<div class="empty" style="padding:30px 16px"><div class="empty-icon">${icon("check", 22)}</div><h3>Потерь нет</h3><p>Недостаточно кругов для сравнения.</p></div>`}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">${icon("layers", 16)}Ошибки по кругам</div>
        <div class="panel-actions"><span class="panel-sub">нажми на круг, чтобы разобрать события</span></div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Круг</th><th class="num">Время</th><th class="center">Блокировки</th><th class="center">Пробуксовки</th><th class="center">Пробои</th><th class="center">Тормоза</th><th class="center">Накат</th><th class="center">Всего</th></tr></thead>
        <tbody>${[...meta.laps].sort((a, b) => a.index - b.index).map((l) => {
          const ev = l.events || {};
          const total = sum(EVENT_ORDER.map((k) => ev[k] || 0));
          return `<tr class="clickable" data-lap="${l.index}">
            <td class="name">#${l.index} ${l.index === meta.best_index ? `<span class="badge lime">лучший</span>` : ""} ${l.valid ? "" : `<span class="badge grey">не чистый</span>`}</td>
            <td class="num">${fmtTime(l.time)}</td>
            <td class="center">${ev.lock || 0}</td>
            <td class="center">${ev.spin || 0}</td>
            <td class="center">${ev.bottom || 0}</td>
            <td class="center">${ev.brake_temp || 0}</td>
            <td class="center">${ev.coast || 0}</td>
            <td class="center"><b>${total}</b></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>

    ${tips.length ? `<div class="panel">
      <div class="panel-head"><div class="panel-title">${icon("info", 16)}Что делать</div></div>
      <div class="panel-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
        ${tips.map((t) => `<div class="rec ${t.n > 8 ? "mid" : "low"}">
          <div class="rec-head"><span class="badge ${t.key === "lock" ? "red" : "orange"}">${t.n}×</span><span class="rec-title">${EVENT_TIPS[t.key].title}</span></div>
          <div class="rec-sum">${EVENT_TIPS[t.key].text}</div>
        </div>`).join("")}
      </div>
    </div>` : ""}
  </div>`;
}

/* ------------------------------------------------------------- trajectory */

function lineRefRows(meta) {
  const rows = [];
  const seen = new Set();
  const track = meta.track_id || meta.track;
  const add = (sid, index, time) => {
    if (index == null || !Number.isFinite(Number(time)) || Number(time) <= 0) return;
    const key = `${sid}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    const s = store.session(sid);
    const where = sid === meta.id
      ? "эта сессия"
      : `${fmtDate(s?.date)}${s?.car ? ` · ${s.car}` : ""}`;
    rows.push({ key, time: Number(time), label: `#${index} · ${fmtTime(time)} · ${where}` });
  };
  for (const s of store.sessions) {
    if ((s.track_id || s.track) !== track) continue;
    add(s.id, s.best_index, s.best_time);
  }
  [...meta.laps]
    .filter((l) => l.valid && l.time > 0)
    .sort((a, b) => a.time - b.time)
    .slice(0, 3)
    .forEach((l) => add(meta.id, l.index, l.time));
  return rows.sort((a, b) => a.time - b.time);
}

function lineRefOptionsHTML(rows, selected) {
  return `<option value="">— выбери эталон —</option>${rows.map((r) =>
    `<option value="${esc(r.key)}"${r.key === selected ? " selected" : ""}>${esc(r.label)}</option>`).join("")}`;
}

function lineReadoutHTML(traj, pack, dist) {
  if (!traj) {
    return `<span class="hint">Наведи курсор на карту или график — покажу отклонение и телеметрию в этой точке.</span>`;
  }
  if (!traj.available) {
    return `<span class="hint">Сравнение линии недоступно — подробности в блоке «Где линия отличается».</span>`;
  }
  if (dist == null) {
    return `<span class="hint">Наведи курсор на карту или график — покажу отклонение и телеметрию в этой точке.</span>`;
  }
  const i = Math.max(0, Math.min((traj.n || 1) - 1,
    Math.round(dist / (traj.step || 5))));
  const dev = Number(traj.dev?.[i] ?? 0);
  const zone = (traj.zones || []).find((z) => dist >= z.start - 4 && dist <= z.end + 4);
  const speed = pack?.ch?.spd?.[i];
  const thr = pack?.ch?.thr?.[i];
  const brk = pack?.ch?.brk?.[i];
  const gear = pack?.ch?.gear?.[i];
  return `<div class="inline-stats">
    <div class="inline-stat"><div class="k">Отклонение</div>
      <div class="v ${Math.abs(dev) >= 1.15 ? "slow" : ""}">${dev > 0 ? "+" : ""}${dev.toFixed(1)} <small>м</small></div></div>
    <div class="inline-stat"><div class="k">Зона</div>
      <div class="v" style="font-size:12px">${zone ? esc(`${zone.corner} · ${zone.phase_label}`) : "ровно"}</div></div>
    <div class="inline-stat"><div class="k">Скорость</div><div class="v">${speed != null ? Math.round(speed) : "—"} <small>км/ч</small></div></div>
    <div class="inline-stat"><div class="k">Газ</div><div class="v">${thr != null ? Math.round(thr) : "—"}%</div></div>
    <div class="inline-stat"><div class="k">Тормоз</div><div class="v">${brk != null ? Math.round(brk) : "—"}%</div></div>
    <div class="inline-stat"><div class="k">Передача</div><div class="v">${gear ? Math.round(gear) : "—"}</div></div>
    <div class="inline-stat"><div class="k">Дистанция</div><div class="v">${Math.round(dist)} м</div></div>
  </div>`;
}

function lineKpisHTML(summary) {
  const s = summary || {};
  const zones = s.zones || 0;
  return `<div class="kpi">
      <div class="kpi-label">${icon("route", 12)}Среднее отклонение</div>
      <div class="kpi-value">${s.avg_dev != null ? s.avg_dev.toFixed(1) : "—"} <small>м</small></div>
      <div class="kpi-sub">в поворотах от эталона</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">${icon("target", 12)}Максимум</div>
      <div class="kpi-value">${s.max_dev != null ? s.max_dev.toFixed(1) : "—"} <small>м</small></div>
      <div class="kpi-sub">${s.worst ? `худший поворот · ${esc(s.worst)}` : "отклонений нет"}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">${icon("alert", 12)}Проблемные зоны</div>
      <div class="kpi-value">${zones}</div>
      <div class="kpi-sub">${s.high ? `${s.high} требуют внимания` : "критичных нет"}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">${icon("clock", 12)}К эталону</div>
      <div class="kpi-value ${deltaClass(s.time_delta)}">${s.time_delta != null ? fmtDelta(s.time_delta) : "—"}</div>
      <div class="kpi-sub">по времени круга</div>
    </div>`;
}

function zoneCardHTML(z) {
  const metrics = [];
  const m = z.metrics || {};
  if (m.speed_delta != null && Math.abs(m.speed_delta) >= 3) {
    metrics.push(`<span class="badge ${m.speed_delta < 0 ? "red" : "lime"}">${m.speed_delta < 0 ? "−" : "+"}${Math.abs(Math.round(m.speed_delta))} км/ч</span>`);
  }
  if (m.brake_delta != null && Math.abs(m.brake_delta) >= 5) {
    metrics.push(`<span class="badge outline">тормоз ${m.brake_delta > 0 ? "позже" : "раньше"} ${Math.abs(Math.round(m.brake_delta))} м</span>`);
  }
  if (m.throttle_delta != null && Math.abs(m.throttle_delta) >= 8) {
    metrics.push(`<span class="badge outline">газ ${m.throttle_delta > 0 ? "позже" : "раньше"} ${Math.abs(Math.round(m.throttle_delta))} м</span>`);
  }
  if (m.steer_delta != null && Math.abs(m.steer_delta) >= 7) {
    metrics.push(`<span class="badge outline">руля ${m.steer_delta > 0 ? "+" : "−"}${Math.abs(Math.round(m.steer_delta))}%</span>`);
  }
  if (z.time_loss >= 0.03) {
    metrics.push(`<span class="badge orange">+${z.time_loss.toFixed(2)} с</span>`);
  }
  return `<div class="line-zone ${esc(z.severity)}" data-cursor="${z.peak_dist}" data-zone="${z.n}">
    <div class="line-zone-head">
      <span class="line-zone-num">${z.n}</span>
      <span class="badge grey">${esc(z.corner)}</span>
      <span class="line-zone-phase">${esc(z.phase_label)}</span>
      <span class="line-zone-dev ${z.dev > 0 ? "right" : "left"}" title="Среднее по фазе; пик ${z.peak_dev > 0 ? "+" : ""}${z.peak_dev.toFixed(1)} м на ${Math.round(z.peak_dist)} м">${z.dev > 0 ? "+" : ""}${z.dev.toFixed(1)} м</span>
    </div>
    <div class="line-zone-title">${esc(z.title)}</div>
    <div class="line-zone-text">${esc(z.text)}</div>
    <div class="line-zone-advice">${icon("info", 13)}<span>${esc(z.advice)}</span></div>
    ${metrics.length ? `<div class="line-zone-meta">${metrics.join("")}</div>` : ""}
  </div>`;
}

function lineHTML(meta, pack, refRows, refKey) {
  const tags = pack?.tags || [];
  const slow = tags.includes("slow");
  return `<div class="section" style="gap:16px">
    ${slow ? `<div class="hint-box">${icon("info", 16)}<span>Круг медленный — заметно медленнее лучшего. Линия сравнивается корректно, но дельта времени будет большой.</span></div>` : ""}
    <div class="kpi-grid" id="line-kpis">${lineKpisHTML(null)}</div>
    <div class="two-col">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">${icon("map", 16)}Карта траектории
            <span class="panel-sub">эталон и твоя линия</span></div>
          <div class="panel-actions">
            <select class="select" id="ref-select" style="min-width:230px">${lineRefOptionsHTML(refRows, refKey)}</select>
          </div>
        </div>
        <div class="panel-body" style="padding:8px 10px 10px">
          <div class="map-box tall" id="line-map-box"><canvas id="line-map"></canvas>
            <div class="map-legend line-legend">
              <span class="lw dash"></span><span>эталон</span>
              <span class="lw" style="background:var(--green)"></span><span>&lt;0.7 м</span>
              <span class="lw" style="background:var(--yellow)"></span><span>1–2 м</span>
              <span class="lw" style="background:var(--red)"></span><span>&gt;2 м</span>
            </div>
          </div>
        </div>
        <div class="panel-foot" id="line-readout" style="min-height:48px"><span class="hint">Наведи курсор на карту или график — покажу отклонение и телеметрию в этой точке.</span></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">${icon("route", 16)}Где линия отличается</div>
          <div class="panel-actions"><span class="panel-sub" id="line-zone-count">—</span></div>
        </div>
        <div class="panel-body" id="line-zones" style="padding:12px">
          <div class="loading"><div class="spinner"></div><span>Сравниваю траектории…</span></div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${icon("trend", 16)}Отклонение от эталона</div>
        <div class="panel-actions"><span class="legend-item"><span class="swatch" style="background:rgb(var(--yellow-rgb) / .5)"></span>допуск ±1.15 м</span></div>
      </div>
      <div class="panel-body" style="padding:10px 14px 6px">
        <div class="chart-box" id="line-chart-box"><canvas id="line-chart"></canvas></div>
      </div>
      <div class="panel-foot" id="line-ref-info"><span class="hint">Загружаю эталон…</span></div>
    </div>
    <div class="hint-box" id="line-method">${icon("info", 16)}<span>Сравнение идёт по локальным различиям линии. Медленный дрейф датчика рыскания скомпенсирован, поэтому метры показывают смещение относительно эталона, а не абсолютные координаты.</span></div>
  </div>`;
}

async function mountLine(root, meta, pack, refKey) {
  const select = root.querySelector("#ref-select");
  const zonesEl = root.querySelector("#line-zones");
  const countEl = root.querySelector("#line-zone-count");
  const kpisEl = root.querySelector("#line-kpis");
  const readout = root.querySelector("#line-readout");
  const refInfo = root.querySelector("#line-ref-info");
  const mapBox = root.querySelector("#line-map-box");
  const chartBox = root.querySelector("#line-chart-box");
  const mapCanvas = root.querySelector("#line-map");
  const chartCanvas = root.querySelector("#line-chart");
  if (!select || !zonesEl || !mapCanvas || !chartCanvas) return;

  const map = new TrajectoryMap(mapCanvas, {});
  const chart = new LineDevChart(chartCanvas, {});
  let traj = null;
  let request = 0;

  const applyCursor = (dist) => {
    map.setCursor(dist);
    chart.setCursor(dist);
    if (readout) readout.innerHTML = lineReadoutHTML(traj, pack, dist);
    zonesEl.querySelectorAll(".line-zone").forEach((el) => {
      el.classList.toggle("active", dist != null
        && Number(el.dataset.cursor) === Math.round(dist));
    });
  };

  let frame = 0;
  let pending = null;
  const schedule = (dist) => {
    pending = dist;
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyCursor(pending);
      });
    }
  };

  mapCanvas.addEventListener("pointermove", (ev) => {
    const hit = map.hitTest(ev.clientX, ev.clientY);
    if (hit) schedule(hit.dist);
  });
  mapCanvas.addEventListener("pointerleave", () => schedule(null));
  chartCanvas.addEventListener("pointermove", (ev) => {
    const rect = chartCanvas.getBoundingClientRect();
    const dist = chart.distAtX(ev.clientX - rect.left);
    if (dist != null) schedule(dist);
  });
  chartCanvas.addEventListener("pointerleave", () => schedule(null));

  zonesEl.addEventListener("click", (ev) => {
    const card = ev.target.closest(".line-zone");
    if (!card) return;
    applyCursor(Number(card.dataset.cursor));
    mapBox?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  const load = async (key) => {
    const ticket = ++request;
    zonesEl.innerHTML = `<div class="loading"><div class="spinner"></div><span>Сравниваю траектории…</span></div>`;
    if (readout) readout.innerHTML = lineReadoutHTML(null, pack, null);
    try {
      const data = await api.trajectory(meta.id, pack.index, key);
      if (ticket !== request) return;
      traj = data;
      if (!data.available) {
        kpisEl.innerHTML = lineKpisHTML(null);
        countEl.textContent = "нет данных";
        zonesEl.innerHTML = `<div class="hint-box warn" style="margin:0">${icon("alert", 16)}<span>${esc(data.reason || "Траектория недоступна.")}</span></div>`;
        map.setData({ refPath: null, curPath: null, dev: [], zones: [] });
        chart.setData({ dev: [], zones: [] });
        refInfo.innerHTML = `<span class="hint">Эталон не используется.</span>`;
        applyCursor(null);
        return;
      }
      const s = data.summary || {};
      kpisEl.innerHTML = lineKpisHTML(s);
      countEl.textContent = `${s.zones || 0} ${plural(s.zones || 0, "зона", "зоны", "зон")}`;
      zonesEl.innerHTML = (data.zones || []).length
        ? `<div class="line-zones">${data.zones.map(zoneCardHTML).join("")}</div>`
        : `<div class="empty" style="padding:34px 16px">
            <div class="empty-icon">${icon("check", 22)}</div>
            <h3>Линия совпадает с эталоном</h3>
            <p>Заметных отклонений по поворотам нет. Можно сравнить другой круг или эталон.</p>
          </div>`;
      map.setData({
        refPath: data.ref_path,
        curPath: data.cur_path,
        dev: data.dev,
        corners: data.corners,
        zones: data.zones,
        step: data.step,
      });
      chart.setData({
        dev: data.dev,
        corners: data.corners,
        zones: data.zones,
        step: data.step,
        threshold: 1.15,
      });
      const ref = data.ref || {};
      const same = ref.same_session && ref.lap === data.lap;
      refInfo.innerHTML = `<span class="legend-item"><span class="lw dash" style="background:rgb(var(--wash-rgb) / .5)"></span>эталон: ${esc(`#${ref.lap} · ${fmtTime(ref.time)}`)}${same ? " · тот же круг" : ""}</span>
        <span class="badge ${ref.same_car ? "grey" : "orange"}">${esc(ref.car || "машина")}${ref.same_session ? "" : ` · ${esc(ref.track || "")}`}</span>`;
      if (same) {
        zonesEl.insertAdjacentHTML("afterbegin", `<div class="hint-box warn" style="margin-bottom:10px">${icon("info", 16)}<span>Выбран тот же круг, что и эталон. Выбери другой круг или эталон, чтобы увидеть различия линии.</span></div>`);
      }
      applyCursor(null);
    } catch (err) {
      if (ticket !== request) return;
      zonesEl.innerHTML = `<div class="hint-box warn">${icon("alert", 16)}<span>${esc(err.message)}</span></div>`;
      refInfo.innerHTML = `<span class="hint">Ошибка загрузки эталона</span>`;
    }
  };

  select.addEventListener("change", () => {
    const key = select.value;
    const q = new URLSearchParams({ lap: String(pack.index), ref: key });
    history.replaceState(null, "", `#/session/${encodeURIComponent(meta.id)}/line?${q.toString()}`);
    load(key);
  });

  observe(mapBox, () => map.draw());
  observe(chartBox, () => chart.draw());
  life.add(() => cancelAnimationFrame(frame));
  await load(select.value || refKey);
}

/* --------------------------------------------------------------- setup */

function recHTML(rec) {
  const changeVal = (v, unit) => {
    const digits = { psi: 1, "%": 1, "мм": 0, "Н": 0, "Нм": 0, "клик": 0 }[unit];
    const n = Number(v);
    return digits === undefined || !Number.isFinite(n) ? esc(v) : n.toFixed(digits);
  };
  const changes = (rec.changes || []).map((c) => `<span class="change">
    <span class="lbl">${esc(c.label)}</span>
    <span class="from">${changeVal(c.from, c.unit)}</span>
    <span class="arrow">→</span>
    <span class="to">${changeVal(c.to, c.unit)}</span>
    <span class="unit">${esc(c.unit || "")}</span>
  </span>`).join("");
  const evidence = (rec.evidence || []).map((e) => `<span class="badge outline">${esc(e.label)}: ${esc(e.value)}</span>`).join("");
  return `<div class="rec ${esc(rec.severity || "low")}">
    <div class="rec-head">${sevBadge(rec.severity)}<span class="rec-title">${esc(rec.title)}</span></div>
    <div class="rec-sum">${esc(rec.summary)}</div>
    <div class="rec-why">${esc(rec.why)}</div>
    ${changes ? `<div class="rec-changes">${changes}</div>` : ""}
    ${evidence ? `<div class="rec-evidence">${evidence}</div>` : ""}
  </div>`;
}

const SETUP_DIGITS = {
  tyrePressure: 1, camber: 2, toe: 2, caster: 1, steerRatio: 0, wheelRate: 1,
  bumpStopRateUp: 0, rideHeight: 0, brakeBias: 1, preload: 0, fuel: 0,
  fuelPerLap: 2, brakeTorque: 0,
};

function setupValue(value, digits) {
  const one = (v) => {
    const n = Number(v);
    if (digits === undefined || !Number.isFinite(n)) return esc(v);
    return n.toFixed(digits);
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

function setupRowHTML(r) {
  const digits = SETUP_DIGITS[r.key];
  if (Array.isArray(r.value) && r.labels?.length) {
    const meta = [r.unit, r.note].filter(Boolean).map((s) => esc(s)).join(" · ");
    const hint = meta ? `<small class="setup-hint">${meta}</small>` : "";
    const chips = r.value.map((v, i) =>
      `<span class="setup-chip"><b>${esc(r.labels[i] || "")}</b>${setupValue(v, digits)}</span>`).join("");
    return `<div class="setup-row${r.converted ? " conv" : ""}">
      <span class="l">${esc(r.label)}${hint}</span>
      <span class="v"><span class="setup-chips">${chips}</span></span>
    </div>`;
  }
  const hint = r.note ? `<small class="setup-hint">${esc(r.note)}</small>` : "";
  const shown = setupValue(r.value, digits);
  const text = Array.isArray(shown) ? shown.join(" / ") : shown;
  const unit = r.unit ? `<span class="setup-unit">${esc(r.unit)}</span>` : "";
  return `<div class="setup-row${r.converted ? " conv" : ""}">
    <span class="l">${esc(r.label)}${hint}</span>
    <span class="v">${text}${unit}</span>
  </div>`;
}

function setupPreviewHTML(setup) {
  if (!setup?.sections?.length) {
    return `<div class="empty" style="padding:34px 18px">
      <div class="empty-icon">${icon("sliders", 22)}</div>
      <h3>Сет не выбран</h3>
      <p>Рекомендации построены только по телеметрии. Выбери сет из ACC, чтобы увидеть конкретные значения «было → стало».</p>
    </div>`;
  }
  const hint = setup.converted
    ? `<div class="setup-conv">${icon("info", 14)}<span>Значения пересчитаны в единицы гаража ACC: psi, градусы, мм, Н/мм, Нм. «Клик» — шаг ползунка в игре.</span></div>`
    : `<div class="setup-conv warn">${icon("alert", 14)}<span>Для этой машины нет таблицы пересчёта: давление, схождение, кастор, пружины, клиренс и баланс тормозов показаны в кликах, как в файле сета. Развал, топливо и электроника — в единицах игры.</span></div>`;
  return `${hint}<div class="setup-sections">${setup.sections.map((s) => `<div class="setup-section">
    <div class="setup-section-head"><span>${esc(s.name)}</span><span class="badge grey">${s.rows.length}</span></div>
    <div class="setup-rows">${s.rows.map(setupRowHTML).join("")}</div>
  </div>`).join("")}</div>`;
}

function setupBaseHTML(meta, rep) {
  return `<div class="setup-layout">
    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
      <div class="panel" id="setup-drop">
        <div class="panel-head">
          <div class="panel-title">${icon("wrench", 16)}Рекомендации
            <span class="panel-sub" id="setup-count">ищу сеты…</span></div>
          <div class="panel-actions">
            <button class="btn ghost sm setup-import-trigger" title="Добавить JSON-сет с диска">${icon("upload", 14)}Импорт сета</button>
            <select class="select" id="setup-select" style="min-width:230px"><option value="">Загружаю сеты…</option></select>
            <input type="file" id="setup-file" accept=".json,application/json" hidden>
          </div>
        </div>
        <div class="setup-note hint-box" id="setup-note" hidden></div>
        <div class="panel-body" id="setup-recs"><div class="loading"><div class="spinner"></div><span>Подбираю настройки…</span></div></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("sliders", 16)}Текущий сет</div>
          <div class="panel-actions">
            <button class="btn ghost sm" id="setup-expand" title="Показать весь сет">Развернуть</button>
            <span class="panel-sub" id="setup-name">—</span>
          </div>
        </div>
        <div class="panel-body setup-preview" id="setup-preview">${setupPreviewHTML(null)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("gauge", 16)}Горячие давления</div>
          <div class="panel-actions"><span class="badge lime" id="setup-target">${pressureGoal(rep.pressure_target)}</span></div>
        </div>
        <div class="panel-body">${wheelGrid("По колёсам", rep.pressures, "pressure", rep.pressure_target)}
          <div class="hint-box" style="margin-top:12px">${icon("info", 16)}<span>Разница больше 0.2 psi уже заметна на длинной серии. Холодное давление меняй на ту же величину.</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("thermo", 16)}Температуры</div></div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:14px">
          ${wheelGrid("Шины", rep.tyre_temps, "tyre")}
          ${wheelGrid("Тормоза", rep.brake_temps, "brake")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("info", 16)}Как это работает</div></div>
        <div class="panel-body muted" style="font-size:11.5px;line-height:1.65">
          Рекомендации сравнивают телеметрию с целевыми окнами ACC: давления, температуры тормозов,
          баланс осей, блокировки и пробуксовку. Сет читается из JSON ACC и пересчитывается в единицы
          гаража: psi, градусы, мм, Н/мм, Нм. Меняй по одному пункту за выезд, чтобы понимать эффект.
        </div>
      </div>
    </div>
  </div>`;
}

async function mountSetup(root, meta, rep) {
  const select = root.querySelector("#setup-select");
  const recsEl = root.querySelector("#setup-recs");
  const previewEl = root.querySelector("#setup-preview");
  const nameEl = root.querySelector("#setup-name");
  const countEl = root.querySelector("#setup-count");
  const noteEl = root.querySelector("#setup-note");
  const fileInput = root.querySelector("#setup-file");
  const trigger = root.querySelector(".setup-import-trigger");
  const drop = root.querySelector("#setup-drop");
  const expand = root.querySelector("#setup-expand");
  if (!select || !recsEl) return;

  expand?.addEventListener("click", () => {
    const open = previewEl.classList.toggle("expanded");
    expand.textContent = open ? "Свернуть" : "Развернуть";
    expand.title = open ? "Свернуть сет" : "Показать весь сет";
  });

  let setups = { exact: [], all: [] };
  let request = 0;
  let busy = false;

  function note(html, kind) {
    if (!noteEl) return;
    if (!html) {
      noteEl.hidden = true;
      noteEl.innerHTML = "";
      return;
    }
    noteEl.hidden = false;
    noteEl.className = `setup-note hint-box${kind === "warn" ? " warn" : ""}`;
    noteEl.innerHTML = `${icon(kind === "warn" ? "alert" : "info", 15)}<span>${html}</span>`;
  }

  function renderList(preferred) {
    const exact = setups.exact || [];
    const all = setups.all || [];
    const exactPaths = new Set(exact.map((s) => s.path));
    const extras = all.filter((s) => !exactPaths.has(s.path));
    select.innerHTML = `<option value="">Без сета — только телеметрия</option>
      ${exact.length ? `<optgroup label="Эта трасса · ${esc(meta.car)}">${exact.map((s) => `<option value="${esc(s.path)}">${esc(s.name)}${s.imported ? " · импорт" : ""}</option>`).join("")}</optgroup>` : ""}
      ${extras.length ? `<optgroup label="Другие трассы">${extras.map((s) => `<option value="${esc(s.path)}">${esc(s.name)} · ${esc(s.track)}</option>`).join("")}</optgroup>` : ""}`;

    const known = new Set(all.map((s) => s.path));
    const chosen = preferred && known.has(preferred) ? preferred : (exact[0]?.path || "");
    select.value = chosen;

    if (countEl) {
      const imported = exact.filter((s) => s.imported).length;
      const total = all.length;
      countEl.textContent = exact.length
        ? `${exact.length} на трассе`
        : (total ? `${total} с других трасс` : "сетов нет");
      countEl.title = total
        ? `Всего сетов для ${meta.car}: ${total}${imported ? `, из них импортировано ${imported}` : ""}`
        : "";
    }
    return chosen;
  }

  function diagnostics() {
    const exact = setups.exact || [];
    const all = setups.all || [];
    if (!all.length) {
      const where = setups.root_exists
        ? "В папке ACC сеты для этой машины не найдены."
        : "Папка Setups из ACC не найдена.";
      note(`${where} Можно добавить JSON вручную: кнопка «Импорт сета» или перетащи файл сюда — рекомендации по телеметрии работают и без сета.`, "warn");
      return;
    }
    if (!exact.length) {
      note(`Для этой трассы сетов нет — в списке сеты с других трасс. Свой можно перетащить на эту панель.`);
      return;
    }
    note("");
  }

  async function load(path) {
    const ticket = ++request;
    recsEl.innerHTML = `<div class="loading"><div class="spinner"></div><span>Считаю рекомендации…</span></div>`;
    previewEl.innerHTML = `<div class="loading" style="padding:30px 12px"><div class="spinner"></div></div>`;
    nameEl.textContent = path ? "загружаю…" : "телеметрия";
    try {
      const data = await api.recommend(meta.id, path || "");
      if (ticket !== request) return;
      const recs = data.recommendations || [];
      recsEl.innerHTML = recs.length
        ? `<div class="rec-list">${recs.map(recHTML).join("")}</div>`
        : `<div class="empty" style="padding:34px 18px"><div class="empty-icon">${icon("check", 22)}</div>
            <h3>Сет в порядке</h3><p>По текущей телеметрии критичных отклонений нет. Следи за давлениями на длинной серии.</p></div>`;
      previewEl.innerHTML = setupPreviewHTML(data.setup);
      const targetEl = root.querySelector("#setup-target");
      if (targetEl) targetEl.textContent = pressureGoal(data.target_pressure);
      nameEl.textContent = data.setup?.name || (path ? "" : "без сета");
    } catch (err) {
      if (ticket !== request) return;
      recsEl.innerHTML = `<div class="hint-box warn">${icon("alert", 16)}<span>${esc(err.message)}</span></div>`;
      previewEl.innerHTML = setupPreviewHTML(null);
      nameEl.textContent = "—";
    }
  }

  async function refresh() {
    try {
      setups = await api.setups(meta.car_id, meta.track_id);
    } catch (err) {
      recsEl.innerHTML = `<div class="hint-box warn">${icon("alert", 16)}<span>${esc(err.message)}</span></div>`;
      return null;
    }
    const chosen = renderList();
    diagnostics();
    return chosen;
  }

  async function doImport(file) {
    if (busy) return;
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      note("Поддерживаются только JSON-сеты ACC.", "warn");
      toast("Нужен JSON-файл сета", "info");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      note("Файл больше 4 МБ — похоже, это не сет ACC.", "warn");
      return;
    }

    busy = true;
    trigger?.setAttribute("disabled", "");
    note(`Читаю «${esc(file.name)}»…`);
    try {
      const content = await file.text();
      const item = await api.importSetup(meta.id, file.name, content);
      setups = await api.setups(meta.car_id, meta.track_id);
      const chosen = renderList(item.path);
      diagnostics();
      await load(chosen || item.path);
      note(`Сет «${esc(item.name)}» добавлен в библиотеку ApexLab.`, "ok");
      toast("Сет добавлен", "ok");
    } catch (err) {
      note(esc(err.message), "warn");
      toast(err.message, "info");
    } finally {
      busy = false;
      trigger?.removeAttribute("disabled");
    }
  }

  const chosen = await refresh();
  select.addEventListener("change", () => load(select.value));
  if (chosen !== null) await load(chosen);

  trigger?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) doImport(file);
  });

  if (drop) {
    const highlight = (on) => drop.classList.toggle("drop-target", on);
    drop.addEventListener("dragenter", (e) => { e.preventDefault(); highlight(true); });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); highlight(true); });
    drop.addEventListener("dragleave", (e) => {
      if (!drop.contains(e.relatedTarget)) highlight(false);
    });
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      highlight(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) doImport(file);
    });
  }
}

/* ------------------------------------------------------------ page setup */

function openRename(meta) {
  openModal({
    title: "Имя пилота",
    sub: "Относится только к этой сессии",
    narrow: true,
    body: `<div class="field"><label for="rn">Пилот</label>
      <input class="input" id="rn" maxlength="40" value="${esc(meta.driver || "")}" placeholder="Например, Иван"></div>`,
    footer: `<span class="hint">Логи ACC не содержат имени</span>
      <div class="row"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="rn-ok">Сохранить</button></div>`,
    onMount(wrap, close) {
      const input = wrap.querySelector("#rn");
      const save = async () => {
        const value = input.value.trim();
        if (!value) { toast("Введи имя", "info"); return; }
        try {
          await api.updateSession(meta.id, { driver: value });
          store.invalidate();
          await store.load(true);
          toast("Имя пилота обновлено");
          close();
          window.dispatchEvent(new CustomEvent("apex:refresh"));
        } catch (err) {
          toast(err.message, "err");
        }
      };
      wrap.querySelector("#rn-ok").addEventListener("click", save);
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") save(); });
    },
  });
}

async function deleteSession(meta) {
  const ok = await confirmDialog(
    "Удалить сессию?",
    `«${meta.track} · ${meta.car}» исчезнет из библиотеки. Кэш телеметрии тоже будет удалён, исходный .ld останется на диске.`,
    "Удалить сессию",
  );
  if (!ok) return;
  try {
    await api.deleteSession(meta.id);
    store.invalidate();
    await store.load(true);
    toast("Сессия удалена");
    location.hash = "#/garage";
    window.dispatchEvent(new CustomEvent("apex:refresh"));
  } catch (err) {
    toast(err.message, "err");
  }
}

export async function renderSession(root, sid, tab = "analysis", params) {
  await store.load();
  const meta = await api.session(sid);
  if (!meta) throw new Error("Сессия не найдена");

  const active = TABS.some((t) => t.key === tab) ? tab : "analysis";
  const rawLap = params?.get("lap");
  let lapIndex = rawLap != null && rawLap !== "" ? Number(rawLap) : NaN;
  if (!Number.isFinite(lapIndex) || !meta.laps.some((l) => l.index === lapIndex)) {
    lapIndex = meta.best_index;
  }
  const rep = meta.report || {};

  setTopbar({
    crumb: `<a href="#/garage">Гараж</a> <span class="sep">/</span> ${esc(meta.track)}`,
    title: TAB_TITLES[active],
    sub: `${esc(meta.car)} · ${esc(meta.driver || "Пилот")} · ${fmtDate(meta.date)}`,
    actions: `<button class="btn ghost icon" id="top-export" title="Экспорт отчёта · Ctrl+E">${icon("download", 16)}</button>
      <button class="btn ghost icon" id="top-import" title="Импортировать ещё логи">${icon("upload", 16)}</button>
      <a class="btn ghost" href="#/garage">${icon("car", 16)}<span>В гараж</span></a>`,
  });

  root.innerHTML = `<div class="page">
    <div id="session-id" data-id="${esc(meta.id)}"></div>
    ${heroHTML(meta, rep, lapIndex)}
    <div style="margin-top:14px">${statsHTML(meta, rep)}</div>
    <div style="margin-top:16px">${tabsHTML(meta, active, lapIndex)}</div>
    ${warningHTML(rep, meta)}
    <div id="tab-body" style="margin-top:16px"></div>
  </div>`;

  const body = root.querySelector("#tab-body");
  const top = document.getElementById("topbar");
  top?.querySelector("#top-import")?.addEventListener("click", () => openImport({
    onDone: () => {
      store.invalidate();
      store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
    },
  }));
  root.querySelector("#rename-driver")?.addEventListener("click", () => openRename(meta));
  root.querySelector("#export-report")?.addEventListener("click", () => exportSessionReport(meta));
  top?.querySelector("#top-export")?.addEventListener("click", () => exportSessionReport(meta));
  root.querySelector("#delete-session")?.addEventListener("click", () => deleteSession(meta));

  const needPack = active === "analysis" || active === "line" || active === "errors" || active === "laps";
  let pack = null;
  let bestPack = null;
  if (needPack) {
    try {
      [pack, bestPack] = await Promise.all([
        api.lap(meta.id, lapIndex),
        lapIndex === meta.best_index ? Promise.resolve(null) : api.lap(meta.id, meta.best_index),
      ]);
    } catch (err) {
      toast(`Круг не загрузился: ${err.message}`, "err");
    }
    if (!bestPack) bestPack = pack;
  }

  if (active === "analysis") {
    if (!pack) {
      body.innerHTML = emptyState({
        iconName: "alert",
        title: "Круг не загрузился",
        text: "Файл кэша повреждён или удалён. Переимпортируй лог.",
        action: `<a class="btn" href="#/garage">В гараж</a>`,
      });
      return;
    }
    body.innerHTML = analysisHTML(meta, rep, pack);
    const deltaCanvas = root.querySelector("#delta");
    let deltaChart = null;
    if (deltaCanvas) {
      deltaChart = new DeltaChart(deltaCanvas, {});
      deltaChart.setData(computeDelta(pack, bestPack) || [], {
        corners: pack.corners || [],
        step: pack.step || 5,
      });
      observe(deltaCanvas.parentElement, () => deltaChart.draw());
    }
    mountTelemetry(root, pack, bestPack, deltaChart);
    root.querySelector("#lap-select")?.addEventListener("change", (ev) => {
      goSession(meta.id, "analysis", Number(ev.target.value));
    });
    return;
  }

  if (active === "line") {
    if (!pack) {
      body.innerHTML = emptyState({
        iconName: "alert",
        title: "Круг не загрузился",
        text: "Файл кэша повреждён или удалён. Переимпортируй лог.",
        action: `<a class="btn" href="#/garage">В гараж</a>`,
      });
      return;
    }
    const rows = lineRefRows(meta);
    const currentKey = `${meta.id}:${pack.index}`;
    let refKey = params?.get("ref") || "";
    if (!rows.some((r) => r.key === refKey)) {
      refKey = (rows.find((r) => r.key !== currentKey) || rows[0])?.key || "";
    }
    body.innerHTML = lineHTML(meta, pack, rows, refKey);
    await mountLine(root, meta, pack, refKey);
    return;
  }

  if (active === "laps") {
    body.innerHTML = lapsHTML(meta, rep);
    body.querySelectorAll("[data-lap]").forEach((row) => {
      row.addEventListener("click", () => goSession(meta.id, "analysis", Number(row.dataset.lap)));
    });
    return;
  }

  if (active === "errors") {
    body.innerHTML = errorsHTML(meta, rep, pack);
    body.querySelectorAll("[data-lap]").forEach((row) => {
      row.addEventListener("click", () => goSession(meta.id, "errors", Number(row.dataset.lap)));
    });
    body.querySelectorAll("[data-cursor]").forEach((el) => {
      el.addEventListener("click", () => goSession(meta.id, "analysis", lapIndex));
    });
    root.querySelector("#lap-select")?.addEventListener("change", (ev) => {
      goSession(meta.id, "errors", Number(ev.target.value));
    });
    return;
  }

  if (active === "setup") {
    body.innerHTML = setupBaseHTML(meta, rep);
    await mountSetup(root, meta, rep);
  }
}
