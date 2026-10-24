import { api } from "../api.js";
import { store } from "../store.js";
import {
  esc, fmtTime, fmtDelta, deltaClass, fmtDate, fmtClock, icon, plural, avg, tagMeta,
} from "../util.js";
import { TraceChart, TrackMap, DeltaChart, computeDelta } from "../charts.js";
import { setTopbar, observe, toast, emptyState, life } from "../ui.js";
import { openImport } from "../importmodal.js";

const COLOR_A = "var(--accent)";
const COLOR_B = "var(--orange)";

function allLaps() {
  const rows = [];
  for (const s of store.sessions) {
    for (const lap of s.laps || []) {
      rows.push({
        sid: s.id,
        index: lap.index,
        time: lap.time,
        valid: lap.valid,
        tags: lap.tags || [],
        driver: s.driver || "Пилот",
        track: s.track,
        trackKey: s.track_id || s.track,
        car: s.car,
        date: s.date,
        timeOfDay: s.time,
        session: s,
      });
    }
  }
  return rows;
}

function keyOf(row) {
  return `${row.sid}:${row.index}`;
}

function parseSide(raw, pool) {
  if (!raw) return null;
  const cut = String(raw).lastIndexOf(":");
  if (cut < 0) return null;
  const sid = raw.slice(0, cut);
  const index = Number(raw.slice(cut + 1));
  return pool.find((l) => l.sid === sid && l.index === index) || null;
}

function sessionLaps(pool, sid) {
  return pool.filter((l) => l.sid === sid).sort((a, b) => a.index - b.index);
}

function fastest(pool) {
  const valid = pool.filter((l) => l.valid);
  const list = (valid.length ? valid : pool).slice().sort((a, b) => a.time - b.time);
  return list[0] || null;
}

function defaultPair(pool) {
  const a = fastest(pool);
  if (!a) return [null, null];
  const ordered = pool.slice().sort((x, y) => (y.valid - x.valid) || x.time - y.time);
  let b = ordered.find((l) => l.sid !== a.sid) || ordered.find((l) => keyOf(l) !== keyOf(a)) || a;
  return [a, b];
}

function metrics(pack) {
  const ch = pack?.ch || {};
  const spd = ch.spd || [];
  const thr = ch.thr || [];
  const brk = ch.brk || [];
  const events = {};
  for (const e of pack?.events || []) events[e.type] = (events[e.type] || 0) + 1;
  const n = spd.length || 1;
  const coast = spd.reduce((acc, v, i) => acc + (v > 60 && (thr[i] || 0) < 3 && (brk[i] || 0) < 3 ? 1 : 0), 0);
  return {
    maxSpeed: spd.length ? Math.max(...spd) : 0,
    avgSpeed: avg(spd),
    fullThrottle: thr.filter((v) => v >= 95).length / n * 100,
    braking: brk.filter((v) => v > 5).length / n * 100,
    coast: coast / n * 100,
    events,
  };
}

function sessionOptions(pool, currentSid) {
  const sids = [...new Set(pool.map((l) => l.sid))];
  return sids.map((sid) => {
    const laps = sessionLaps(pool, sid);
    const s = laps[0].session;
    return `<option value="${esc(sid)}"${sid === currentSid ? " selected" : ""}>${esc(s.driver)} · ${fmtTime(s.best_time)} · ${fmtDate(s.date)}</option>`;
  }).join("");
}

function lapOptions(pool, sid, currentIndex) {
  return sessionLaps(pool, sid).map((l) => `<option value="${l.index}"${l.index === currentIndex ? " selected" : ""}>
    #${l.index} · ${fmtTime(l.time)}${l.valid ? "" : " · не чистый"}
  </option>`).join("");
}

function pickHTML(side, row, pool) {
  const cls = side === "a" ? "a" : "b";
  const label = side === "a" ? "Эталон" : "Соперник";
  if (!row) {
    return `<div class="pick ${cls}">
      <div class="pick-head"><span class="tag">${side.toUpperCase()}</span>${label}</div>
      <div class="pick-meta" style="margin-top:10px">Нет кругов на этой трассе</div>
    </div>`;
  }
  return `<div class="pick ${cls}">
    <div class="pick-head"><span class="tag">${side.toUpperCase()}</span>${label}</div>
    <div class="pick-row" style="margin-top:10px">
      <select class="select" data-session="${side}">${sessionOptions(pool, row.sid)}</select>
      <select class="select" data-lap="${side}">${lapOptions(pool, row.sid, row.index)}</select>
    </div>
    <div class="pick-meta" style="margin-top:9px">
      <span>${icon("user", 13)} ${esc(row.driver)}</span>
      <span>${esc(row.car)}</span>
      <span>${fmtDate(row.date)}${fmtClock(row.timeOfDay) ? ` · ${fmtClock(row.timeOfDay)}` : ""}</span>
    </div>
    <div class="pick-time ${cls === "a" ? "lime" : "orange"}">${fmtTime(row.time)}</div>
  </div>`;
}

function statRow(label, a, b, unit = "") {
  return `<div class="stat-compare">
    <div class="k">${label}</div>
    <div class="a">${a}${unit ? ` <span class="mid">${unit}</span>` : ""}</div>
    <div class="mid">vs</div>
    <div class="b">${b}${unit ? ` <span class="mid">${unit}</span>` : ""}</div>
  </div>`;
}

function compareBodyHTML(aRow, bRow, aPack, bPack, aMet, bMet) {
  const finalDelta = aRow.time - bRow.time;
  const series = computeDelta(aPack, bPack) || [];
  const deltaEnd = series.length ? series[series.length - 1] : finalDelta;

  const corners = aPack.corners || [];
  const step = aPack.step || 5;
  const cornerRows = corners.slice(0, Math.min(corners.length, bPack.corners?.length || 0)).map((c, i) => {
    const other = bPack.corners[i];
    const ia = Math.min(aPack.n - 1, Math.max(0, Math.round(c.end / step)));
    const ib = Math.min(bPack.n - 1, Math.max(0, Math.round(other.end / step)));
    const d = (aPack.t?.[ia] ?? 0) - (bPack.t?.[ib] ?? 0);
    const apexDiff = (c.apex_speed || 0) - (other.apex_speed || 0);
    const minDiff = (c.min_speed || 0) - (other.min_speed || 0);
    return `<tr>
      <td class="name">${esc(c.name)}<span class="sub">${Math.round(c.start)}–${Math.round(c.end)} м</span></td>
      <td class="num">${Math.round(c.min_speed || 0)}</td>
      <td class="num">${Math.round(other.min_speed || 0)}</td>
      <td class="num ${deltaClass(-minDiff)}">${minDiff > 0.5 ? "+" : ""}${Math.round(minDiff)}</td>
      <td class="num">${Math.round(c.apex_speed || 0)}</td>
      <td class="num">${Math.round(other.apex_speed || 0)}</td>
      <td class="num ${deltaClass(-apexDiff)}">${apexDiff > 0.5 ? "+" : ""}${Math.round(apexDiff)}</td>
      <td class="num ${deltaClass(d)}">${fmtDelta(d)}</td>
    </tr>`;
  }).join("");

  const bestCorners = corners.map((c, i) => {
    const other = bPack.corners?.[i];
    if (!other) return null;
    const ia = Math.min(aPack.n - 1, Math.max(0, Math.round(c.end / step)));
    const ib = Math.min(bPack.n - 1, Math.max(0, Math.round(other.end / step)));
    return { name: c.name, d: (aPack.t?.[ia] ?? 0) - (bPack.t?.[ib] ?? 0) };
  }).filter(Boolean).sort((x, y) => y.d - x.d);
  const worst = bestCorners[0];
  const best = bestCorners[bestCorners.length - 1];

  return `<div class="section" style="gap:16px">
    <div class="two-col">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">${icon("compare", 16)}Круг за кругом</div>
            <div class="panel-actions">
              <span class="legend-item"><span class="swatch" style="background:${COLOR_A}"></span>A · ${esc(aRow.driver)}</span>
              <span class="legend-item"><span class="swatch" style="background:${COLOR_B}"></span>B · ${esc(bRow.driver)}</span>
            </div>
          </div>
          <div class="panel-body" style="padding:8px 14px"><div class="chart-box" id="cmp-trace"><canvas></canvas></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("trend", 16)}Дельта A − B</div>
            <div class="panel-actions"><span class="badge ${deltaEnd >= 0 ? "red" : "lime"}">${fmtDelta(deltaEnd)}</span></div>
          </div>
          <div class="panel-body" style="padding:8px 14px 6px"><div class="chart-box" id="cmp-delta"><canvas></canvas></div></div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("gauge", 16)}Итог</div></div>
          <div class="panel-body" style="padding:6px 18px 14px">
            ${statRow("Круг", fmtTime(aRow.time), fmtTime(bRow.time))}
            ${statRow("Макс. скорость", Math.round(aMet.maxSpeed), Math.round(bMet.maxSpeed), "км/ч")}
            ${statRow("Средняя скорость", Math.round(aMet.avgSpeed), Math.round(bMet.avgSpeed), "км/ч")}
            ${statRow("Полный газ", Math.round(aMet.fullThrottle), Math.round(bMet.fullThrottle), "%")}
            ${statRow("Торможение", Math.round(aMet.braking), Math.round(bMet.braking), "%")}
            ${statRow("Накат", Math.round(aMet.coast), Math.round(bMet.coast), "%")}
            ${statRow("Блокировки", aMet.events.lock || 0, bMet.events.lock || 0)}
            ${statRow("Пробуксовки", aMet.events.spin || 0, bMet.events.spin || 0)}
            ${statRow("Пробои", aMet.events.bottom || 0, bMet.events.bottom || 0)}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("target", 16)}Главное</div></div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:9px;font-size:12px;line-height:1.55">
            ${worst ? `<div class="kv"><span class="k">Больше всего теряет A</span><span class="v ${deltaClass(worst.d)}">${esc(worst.name)} ${fmtDelta(worst.d)}</span></div>` : ""}
            ${best ? `<div class="kv"><span class="k">Лучший поворот A</span><span class="v ${deltaClass(best.d)}">${esc(best.name)} ${fmtDelta(best.d)}</span></div>` : ""}
            <div class="kv"><span class="k">Разница на финише</span><span class="v ${deltaClass(deltaEnd)}">${fmtDelta(deltaEnd)}</span></div>
            <div class="hint-box" style="margin-top:4px">${icon("info", 16)}<span>Дельта считается по дистанции. Отрицательная — A быстрее. Нажми на карту или график, чтобы посмотреть точку.</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">${icon("map", 16)}Траектории</div>
        <div class="panel-actions"><span class="panel-sub">A · ${esc(aRow.driver)} / B · ${esc(bRow.driver)}</span></div>
      </div>
      <div class="panel-body" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:10px">
        <div class="map-box wide" style="min-height:260px" data-map="a"><canvas></canvas>
          <div class="map-badge" style="top:8px;left:8px;position:absolute">A</div>
        </div>
        <div class="map-box wide" style="min-height:260px" data-map="b"><canvas></canvas>
          <div class="map-badge" style="top:8px;left:8px;position:absolute">B</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">${icon("target", 16)}По поворотам</div>
        <div class="panel-actions"><span class="panel-sub">скорости в км/ч, дельта по времени</span></div>
      </div>
      ${cornerRows ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Поворот</th><th class="num" title="A">Мин. A</th><th class="num" title="B">Мин. B</th><th class="num">Δ</th><th class="num">Апекс A</th><th class="num">Апекс B</th><th class="num">Δ</th><th class="num">Время A−B</th></tr></thead>
        <tbody>${cornerRows}</tbody>
      </table></div>` : `<div class="empty" style="padding:34px 16px"><div class="empty-icon">${icon("map", 22)}</div><h3>Повороты не совпали</h3><p>У одного из кругов нет разметки поворотов.</p></div>`}
    </div>
  </div>`;
}

function mountCharts(root, aPack, bPack) {
  const traceBox = root.querySelector("#cmp-trace");
  if (traceBox) {
    const trace = new TraceChart(traceBox.querySelector("canvas"), {});
    trace.setData({
      laps: [
        { pack: aPack },
        { pack: bPack },
      ],
      corners: aPack.corners || [],
    });
    observe(traceBox, () => trace.draw());
    traceBox.querySelector("canvas").addEventListener("pointermove", (ev) => {
      const rect = ev.target.getBoundingClientRect();
      const d = trace.distAtX(ev.clientX - rect.left);
      if (d != null) trace.setCursor(d);
    });
    traceBox.querySelector("canvas").addEventListener("pointerleave", () => trace.setCursor(null));
  }

  const deltaBox = root.querySelector("#cmp-delta");
  if (deltaBox) {
    const delta = new DeltaChart(deltaBox.querySelector("canvas"), {});
    delta.setData(computeDelta(aPack, bPack) || [], {
      corners: aPack.corners || [],
      step: aPack.step || 5,
    });
    observe(deltaBox, () => delta.draw());
  }

  [["a", aPack], ["b", bPack]].forEach(([key, pack]) => {
    const box = root.querySelector(`[data-map="${key}"]`);
    if (!box) return;
    const map = new TrackMap(box.querySelector("canvas"), { compact: false, corners: false, events: false });
    map.setData({ pack, corners: [], events: [] });
    observe(box, () => map.draw());
  });
}

function renderPage(root, pool, trackKey, aRow, bRow) {
  const tracks = store.tracks();
  const title = tracks.find((t) => t.key === trackKey)?.name || aRow?.track || "Сравнение";
  const aKey = aRow ? keyOf(aRow) : "";
  const bKey = bRow ? keyOf(bRow) : "";
  const chips = `<div class="chips">${tracks.map((t) => `<a class="chip${t.key === trackKey ? " active" : ""}" href="#/compare?track=${encodeURIComponent(t.key)}">${esc(t.name)} <span class="n">${t.laps}</span></a>`).join("")}</div>`;

  setTopbar({
    crumb: "ApexLab",
    title: "Сравнение",
    sub: `${title} · два круга, дельта и разбор по поворотам`,
    actions: `<button class="btn ghost" data-swap>${icon("compare", 16)}<span>Поменять местами</span></button>
      <button class="btn ghost icon" id="top-import" title="Импорт логов">${icon("upload", 16)}</button>`,
  });

  root.innerHTML = `<div class="page">
    <div class="section-head" style="margin-bottom:16px">
      ${chips}
      <span class="hint">${pool.length} ${plural(pool.length, "круг", "круга", "кругов")} на трассе</span>
    </div>
    <div class="compare-picks">
      ${pickHTML("a", aRow, pool)}
      <div class="vs">VS</div>
      ${pickHTML("b", bRow, pool)}
    </div>
    <div id="cmp-body" style="margin-top:18px"><div class="loading"><div class="spinner"></div><span>Загружаю круги…</span></div></div>
  </div>`;

  const top = document.getElementById("topbar");
  top?.querySelector("[data-swap]")?.addEventListener("click", () => {
    if (!aRow || !bRow) return;
    location.hash = `#/compare?track=${encodeURIComponent(trackKey)}&a=${encodeURIComponent(bKey)}&b=${encodeURIComponent(aKey)}`;
  });
  top?.querySelector("#top-import")?.addEventListener("click", () => openImport({
    onDone: () => {
      store.invalidate();
      store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
    },
  }));

  root.querySelectorAll("[data-session]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const side = sel.dataset.session;
      const laps = sessionLaps(pool, sel.value);
      const best = fastest(laps);
      if (!best) return;
      const nextA = side === "a" ? best : aRow;
      const nextB = side === "b" ? best : bRow;
      location.hash = `#/compare?track=${encodeURIComponent(trackKey)}&a=${encodeURIComponent(keyOf(nextA))}&b=${encodeURIComponent(keyOf(nextB))}`;
    });
  });

  root.querySelectorAll("[data-lap]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const side = sel.dataset.lap;
      const sid = side === "a" ? aRow?.sid : bRow?.sid;
      if (!sid) return;
      const row = pool.find((l) => l.sid === sid && l.index === Number(sel.value));
      if (!row) return;
      const nextA = side === "a" ? row : aRow;
      const nextB = side === "b" ? row : bRow;
      location.hash = `#/compare?track=${encodeURIComponent(trackKey)}&a=${encodeURIComponent(keyOf(nextA))}&b=${encodeURIComponent(keyOf(nextB))}`;
    });
  });

  const body = root.querySelector("#cmp-body");
  if (!aRow || !bRow) {
    body.innerHTML = emptyState({
      iconName: "compare",
      title: "Недостаточно кругов",
      text: "Для сравнения нужны хотя бы два круга на одной трассе. Импортируй ещё логи или выбери другую трассу.",
      action: `<a class="btn" href="#/garage">В гараж</a>`,
    });
    return null;
  }

  return body;
}

export async function renderCompare(root, params) {
  await store.load();
  const laps = allLaps();
  if (!laps.length) {
    setTopbar({ crumb: "ApexLab", title: "Сравнение", sub: "Два круга бок о бок" });
    root.innerHTML = `<div class="page">${emptyState({
      iconName: "compare",
      title: "Сравнивать пока нечего",
      text: "Импортируй логи ACC — затем выбери два круга на одной трассе.",
      action: `<button class="btn primary" id="cmp-import">${icon("upload", 16)}Импортировать логи</button>`,
    })}</div>`;
    root.querySelector("#cmp-import")?.addEventListener("click", () => openImport());
    return;
  }

  const tracks = store.tracks();
  const requestedTrack = params?.get("track");
  // Default to the track with the most clean laps; fall back to the newest session.
  const richest = [...tracks].sort((a, b) => (b.clean - a.clean) || (b.laps - a.laps))[0];
  let trackKey = requestedTrack && laps.some((l) => l.trackKey === requestedTrack)
    ? requestedTrack
    : ((richest?.clean ? richest.key : null)
      || laps.find((l) => l.sid === store.sorted()[0]?.id)?.trackKey
      || tracks[0]?.key);
  if (!trackKey) trackKey = laps[0].trackKey;

  const pool = laps.filter((l) => l.trackKey === trackKey);
  let aRow = parseSide(params?.get("a"), pool);
  let bRow = parseSide(params?.get("b"), pool);

  if (!aRow || !bRow) {
    const [da, db] = defaultPair(pool);
    aRow = aRow || da;
    bRow = bRow || db;
  }
  if (aRow && bRow && keyOf(aRow) === keyOf(bRow)) {
    const [da, db] = defaultPair(pool);
    if (da && db && keyOf(da) !== keyOf(db)) { aRow = da; bRow = db; }
  }

  const body = renderPage(root, pool, trackKey, aRow, bRow);
  if (!body || !aRow || !bRow) return;

  let aPack;
  let bPack;
  try {
    [aPack, bPack] = await Promise.all([api.lap(aRow.sid, aRow.index), api.lap(bRow.sid, bRow.index)]);
  } catch (err) {
    body.innerHTML = emptyState({
      iconName: "alert",
      title: "Круг не загрузился",
      text: String(err?.message || err),
      action: `<a class="btn" href="#/garage">В гараж</a>`,
    });
    return;
  }
  if (!body.isConnected) return;

  body.innerHTML = compareBodyHTML(aRow, bRow, aPack, bPack, metrics(aPack), metrics(bPack));
  mountCharts(root, aPack, bPack);
  life.add(() => { /* observers are cleaned by lifecycle */ });
}
