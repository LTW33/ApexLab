/* Beta: reference logs, learned targets, session series entry point. */
import { api } from "../api.js";
import { store } from "../store.js";
import {
  esc, fmtTime, fmtShort, fmtDate, fmtClock, icon, plural,
} from "../util.js";
import { setTopbar, toast, confirmDialog, emptyState, openModal } from "../ui.js";
import { openImport } from "../importmodal.js";

function kpi(iconName, label, value, sub) {
  return `<div class="kpi">
    <div class="kpi-label">${icon(iconName, 12)}${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

function targetRows(targets) {
  if (!targets?.length) {
    return `<div class="hint-box warn">${icon("alert", 16)}<span>Ориентиры ещё не собраны: импортируй эталонный лог с разобранными кругами.</span></div>`;
  }
  return `<div class="table-wrap"><table class="table coach-targets">
    <thead><tr><th>Поворот</th><th class="num">Вход</th><th class="num">Минимум</th><th class="num">Апекс</th><th class="num">Выход</th><th class="num">Тормоз</th><th class="num">Газ 95%</th><th class="num">Передача</th><th class="num">Кругов</th></tr></thead>
    <tbody>${targets.map((t) => `<tr>
      <td class="name">${esc(t.name)}<span class="sub">${esc(t.label || "")}</span></td>
      <td class="num">${Math.round(t.entry || 0)}</td>
      <td class="num">${Math.round(t.min || 0)}</td>
      <td class="num">${Math.round(t.apex_speed || 0)}</td>
      <td class="num">${Math.round(t.exit || 0)}</td>
      <td class="num">${t.brake_m != null ? `${Math.round(t.brake_m)} м` : "—"}</td>
      <td class="num">${t.throttle_m != null ? `${Math.round(t.throttle_m)} м` : "—"}</td>
      <td class="num">${t.gear || "—"}</td>
      <td class="num">${t.n || 0}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function profileCard(group) {
  const drivers = (group.drivers || []).join(", ") || "—";
  return `<div class="panel coach-profile">
    <div class="panel-head">
      <div class="panel-title">${icon("target", 16)}${esc(group.track || "—")} <span class="panel-sub">${esc(group.car || "")}</span></div>
      <div class="panel-actions"><span class="badge lime">${fmtTime(group.target)}</span></div>
    </div>
    <div class="panel-body tight">
      <div class="coach-meta">
        <span>${icon("user", 13)}${esc(drivers)}</span>
        <span>${icon("db", 13)}${group.count} ${plural(group.count, "лог", "лога", "логов")}</span>
        <span>${icon("target", 13)}${(group.targets || []).length} ${plural((group.targets || []).length, "поворот", "поворота", "поворотов")}</span>
      </div>
      <details class="coach-details">
        <summary>${icon("chevronDown", 14)}Ориентиры по поворотам</summary>
        ${targetRows(group.targets)}
      </details>
    </div>
  </div>`;
}

function mySessionsFor(ref) {
  const track = ref.track_id || ref.track;
  const car = ref.car_id || ref.car;
  return store.sessions.filter((s) => {
    if ((s.track_id || s.track) !== track) return false;
    if (car && (s.car_id || s.car) !== car) return false;
    return true;
  });
}

function compareControl(ref) {
  const rows = mySessionsFor(ref);
  if (!rows.length) {
    return `<span class="hint">Нет моей сессии на этой трассе и машине</span>`;
  }
  if (rows.length === 1) {
    return `<a class="btn ghost sm" href="#/session/${encodeURIComponent(rows[0].id)}/coach">${icon("compare", 13)}Сравнить</a>`;
  }
  return `<span class="row" style="gap:6px">
    <select class="select select-sm" data-compare="${esc(ref.id)}">
      ${rows.map((s) => `<option value="${s.id}">${fmtShort(s.best_time)} · ${fmtDate(s.date)}${fmtClock(s.time) ? ` ${fmtClock(s.time)}` : ""}</option>`).join("")}
    </select>
    <button class="btn sm" data-compare-go="${esc(ref.id)}">${icon("compare", 13)}</button>
  </span>`;
}

function referenceRow(ref) {
  return `<div class="coach-ref-row" data-ref="${esc(ref.id)}">
    <div class="coach-ref-main">
      <div class="coach-ref-title">${icon("flag", 14)}${esc(ref.track || "—")}<span class="badge outline">${esc(ref.car || "")}</span></div>
      <div class="coach-ref-sub">${esc(ref.driver || "Пилот")} · ${esc(fmtDate(ref.date))}${fmtClock(ref.time) ? ` · ${fmtClock(ref.time)}` : ""} · ${ref.clean_laps || 0} ${plural(ref.clean_laps || 0, "чистый круг", "чистых круга", "чистых кругов")}</div>
    </div>
    <div class="coach-ref-time">${fmtTime(ref.best_time)}</div>
    <div class="coach-ref-actions">
      ${compareControl(ref)}
      <button class="btn ghost sm" data-unref="${esc(ref.id)}" title="Убрать из эталонов">${icon("x", 13)}</button>
    </div>
  </div>`;
}

function emptyView(root) {
  root.innerHTML = `<div class="page">
    <div class="session-hero">
      <div class="hero-main">
        <div class="eyebrow">APEXLAB · LEARNING</div>
        <div class="hero-title">Эталоны быстрых пилотов</div>
        <div class="hero-meta" style="max-width:760px;line-height:1.65">
          Загрузи MoTeC-логи пилота, который едет быстрее. ApexLab сравнит его лучший круг с твоим,
          покажет, где и в какой фазе поворота теряется время, и запомнит ориентиры по трассе и машине.
          Следующие разборы будут считаться уже от этих цифр.
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" id="coach-import">${icon("upload", 16)}Загрузить эталон</button>
          <button class="btn ghost" id="coach-mark">${icon("target", 16)}Сделать эталоном мою сессию</button>
        </div>
      </div>
      ${icon("target", 64)}
    </div>
    <div class="equal-col">
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("upload", 16)}1. Лог</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">Обычный экспорт ACC: <span class="mono">.ld</span>. В логе достаточно одного чистого круга, но серия кругов даёт устойчивые ориентиры.</div></div>
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("target", 16)}2. Ориентиры</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">По каждому повороту запоминаются скорости входа, апекса и выхода, точка торможения, момент полного газа и передача.</div></div>
      <div class="panel"><div class="panel-head"><div class="panel-title">${icon("trend", 16)}3. Разбор</div></div>
        <div class="panel-body muted" style="font-size:12.5px;line-height:1.7">В сессии появится вкладка «Эталон»: потери и выигрыш по поворотам, сравнение стиля и текстовый разбор.</div></div>
    </div>
  </div>`;
  root.querySelector("#coach-import").addEventListener("click", () => openImport({
    mode: "reference",
    onDone: () => refresh(),
  }));
  root.querySelector("#coach-mark").addEventListener("click", () => markOwnModal());
}

function markOwnModal() {
  const rows = store.sorted();
  if (!rows.length) {
    toast("Сначала импортируй свои логи в гараж", "info");
    return;
  }
  const { close } = openModal({
    title: "Сделать эталоном свою сессию",
    sub: "Обычно эталон — лог более быстрого пилота, но можно закрепить и свой лучший круг",
    body: `<div class="field">
      <label>Сессия</label>
      <select class="select" id="mark-session">
        ${rows.map((s) => `<option value="${s.id}">${esc(s.track)} · ${fmtShort(s.best_time)} · ${fmtDate(s.date)}${fmtClock(s.time) ? ` ${fmtClock(s.time)}` : ""}</option>`).join("")}
      </select>
      <div class="hint">Сессия уйдёт из гаража в эталоны. Вернуть можно там же.</div>
    </div>`,
    footer: `<span class="hint">Ориентиры пересчитаются сразу</span>
      <div class="row"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" data-ok>В эталоны</button></div>`,
    onMount(wrap) {
      wrap.querySelector("[data-ok]").addEventListener("click", async () => {
        const sid = wrap.querySelector("#mark-session").value;
        try {
          await api.markReference(sid, true);
          close();
          toast("Сессия добавлена в эталоны", "ok");
          refresh();
        } catch (err) {
          toast(err.message, "err");
        }
      });
    },
  });
}

function refresh() {
  store.invalidate();
  store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
}

export async function renderCoach(root, params) {
  await store.load();
  let payload;
  try {
    payload = await api.learning();
  } catch (err) {
    root.innerHTML = `<div class="page">${emptyState({
      iconName: "alert",
      title: "Не удалось прочитать эталоны",
      text: err.message,
      action: `<button class="btn" onclick="location.reload()">Обновить</button>`,
    })}</div>`;
    return;
  }

  const groups = payload.groups || [];
  const refs = payload.references || [];
  setTopbar({
    crumb: "ApexLab",
    title: "Эталоны",
    sub: `${refs.length} ${plural(refs.length, "лог", "лога", "логов")} · ${groups.length} ${plural(groups.length, "профиль", "профиля", "профилей")} по трассе и машине`,
    actions: `<button class="btn ghost icon" id="coach-rebuild" title="Пересчитать ориентиры">${icon("refresh", 16)}</button>
      <button class="btn primary" id="coach-import">${icon("upload", 16)}<span>Эталон</span></button>`,
  });
  const top = document.getElementById("topbar");
  top.querySelector("#coach-import").addEventListener("click", () => openImport({
    mode: "reference",
    onDone: () => refresh(),
  }));
  top.querySelector("#coach-rebuild").addEventListener("click", async () => {
    try {
      await api.rebuildLearning();
      toast("Ориентиры пересчитаны", "ok");
      refresh();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  if (!refs.length) {
    emptyView(root);
    return;
  }

  const targets = groups.reduce((n, g) => n + (g.targets || []).length, 0);
  const best = refs.reduce((v, s) => Math.min(v, Number(s.best_time) || 9e9), 9e9);
  root.innerHTML = `<div class="page">
    <div class="kpi-grid">
      ${kpi("db", "Эталонные логи", String(refs.length), "хранятся локально, отдельно от гаража")}
      ${kpi("target", "Профили", String(groups.length), "трасса + машина")}
      ${kpi("map", "Ориентиры", String(targets), "поворотов с целевыми скоростями")}
      ${kpi("trophy", "Лучший эталон", best < 9e9 ? fmtTime(best) : "—", "лучший круг среди загруженных")}
    </div>

    <div class="section-head">
      <div class="panel-title">${icon("target", 16)}Чему научилась ApexLab</div>
      <button class="btn sm" id="coach-mark">${icon("target", 13)}Сделать эталоном мою сессию</button>
    </div>
    <div class="coach-profiles">${groups.map(profileCard).join("")}</div>

    <div class="section-head" style="margin-top:18px">
      <div class="panel-title">${icon("db", 16)}Эталонные логи</div>
      <span class="hint">Сравнение открывается во вкладке «Эталон» выбранной сессии</span>
    </div>
    <div class="panel"><div class="panel-body tight coach-refs">${refs.map(referenceRow).join("")}</div></div>
  </div>`;

  root.querySelector("#coach-mark")?.addEventListener("click", () => markOwnModal());
  root.querySelectorAll("[data-unref]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Убрать из эталонов?",
        "Лог останется в библиотеке как обычная сессия, ориентиры пересчитаются без него.");
      if (!ok) return;
      try {
        await api.markReference(btn.dataset.unref, false);
        toast("Лог больше не эталон", "ok");
        refresh();
      } catch (err) {
        toast(err.message, "err");
      }
    });
  });
  root.querySelectorAll("[data-compare-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-ref]");
      const sid = row?.querySelector("[data-compare]")?.value;
      if (sid) location.hash = `#/session/${encodeURIComponent(sid)}/coach`;
    });
  });
}
