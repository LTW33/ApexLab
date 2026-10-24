/* Plain-text session report: build, native save dialog, browser download. */
import {
  fmtTime, fmtShort, fmtDelta, fmtDate, fmtClock,
} from "./util.js";
import { store } from "./store.js";
import { toast } from "./ui.js";

const EVENT_NAMES = {
  lock: "Блокировки передних",
  spin: "Пробуксовка на выходе",
  bottom: "Пробои подвески",
  brake_temp: "Перегрев тормозов",
  coast: "Движение накатом",
};

const EVENT_TIPS = {
  lock: "Тормози чуть раньше и плавнее отпускай педаль. В сете: баланс тормозов назад на 0.5–1%, ABS +1.",
  spin: "Не открывай газ до распрямления руля. В сете: TC1 +1, мягче преднатяг, стабильнее задняя ось.",
  bottom: "Машина цепляет отбойники. Подними клиренс или пружины — вернётся предсказуемость.",
  brake_temp: "Открой воздуховоды на 1 клик и проверь стиль торможения: короткие серии греют меньше.",
  coast: "Между газом и тормозом теряется время. Держи тормоз до апекса или раньше открывай газ.",
};

const WHEELS = ["FL", "FR", "RL", "RR"];

function bar(char = "=", length = 58) {
  return char.repeat(length);
}

function value(v, digits = 0, suffix = "") {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}${suffix}` : "—";
}

function wheelLine(label, list, digits, suffix) {
  if (!Array.isArray(list) || !list.length) return "";
  const cells = list.slice(0, 4).map((v, i) => `${WHEELS[i] || i + 1} ${value(v, digits, suffix)}`);
  return `${label}: ${cells.join(" · ")}\n`;
}

export function reportFileName(meta) {
  const date = String(meta?.date || "").replace(/[^\d]+/g, "-").replace(/^-|-$/g, "");
  const raw = `ApexLab_${meta?.track_id || meta?.track || "session"}_${date || "report"}`;
  const safe = raw.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_");
  return `${safe || "ApexLab_report"}.txt`;
}

export function sessionReportText(meta) {
  if (!meta) return "";
  const rep = meta.report || {};
  const laps = meta.laps || [];
  const events = rep.events || {};
  const score = Number(rep.score);

  const out = [];
  out.push("APEXLAB · ОТЧЁТ О СЕССИИ");
  out.push(bar());

  out.push(`Трасса:        ${meta.track || "—"}`);
  out.push(`Пилот:         ${meta.driver || "Пилот"}`);
  out.push(`Машина:        ${meta.car || "—"}`);
  out.push(`Дата:          ${fmtDate(meta.date)}${fmtClock(meta.time) ? `, ${fmtClock(meta.time)}` : ""}`);
  if (meta.name) out.push(`Лог:           ${meta.name}`);
  out.push("");

  out.push("РЕЗУЛЬТАТЫ");
  out.push(bar("-"));
  out.push(`Лучший круг:   ${fmtTime(meta.best_time)}${meta.best_index != null ? `  (круг #${meta.best_index})` : ""}`);
  out.push(`Средний круг:  ${rep.average != null ? fmtShort(rep.average) : "—"}`);
  out.push(`Потенциал:     ${rep.potential != null ? fmtDelta(rep.potential) : "—"}`);
  out.push(`Стабильность:  ${rep.consistency != null ? `${value(rep.consistency, 1, "%")} (разброс ±${value(rep.std, 3)})` : "—"}`);
  out.push(`Кругов:        ${laps.length || rep.laps || 0}, чистых — ${meta.clean_laps ?? rep.clean_laps ?? 0}`);
  out.push(`Дистанция:     ${value(rep.km, 1, " км")}`);
  out.push(`Макс. скорость:${rep.top_speed != null ? ` ${value(rep.top_speed, 0, " км/ч")}` : " —"}`);
  out.push(`Полный газ:    ${rep.throttle_pct != null ? value(rep.throttle_pct, 1, "%") : "—"}`);
  out.push("");

  if (Number.isFinite(score) && score > 0) {
    out.push(`ОЦЕНКА ПИЛОТА: ${Math.round(score)} / 100`);
    const parts = [
      ["Техника", rep.technique],
      ["Торможение", rep.braking],
      ["Тяга", rep.traction],
      ["Баланс", rep.balance_score],
      ["Плавность", rep.smooth],
      ["Темп", rep.pace],
    ].filter(([, v]) => Number.isFinite(Number(v)));
    if (parts.length) out.push(parts.map(([k, v]) => `${k} ${Math.round(v)}`).join(" · "));
    out.push("");
  }

  const eventKeys = Object.keys(EVENT_NAMES).filter((k) => Number(events[k]?.count) > 0);
  if (eventKeys.length) {
    out.push("ОШИБКИ И СОБЫТИЯ");
    out.push(bar("-"));
    for (const key of eventKeys) {
      const item = events[key] || {};
      const corners = Array.isArray(item.corners) && item.corners.length
        ? ` — ${item.corners.map((c) => `${c.name} ×${c.count}`).join(", ")}`
        : "";
      out.push(`${EVENT_NAMES[key]}: ${item.count ?? 0}${corners}`);
    }
    out.push("");
  }

  const losses = (rep.corner_loss || []).filter((c) => Number(c.loss) > 0.0005);
  if (losses.length) {
    out.push("ПОТЕРИ ПО ПОВОРОТАМ");
    out.push(bar("-"));
    for (const c of losses) {
      out.push(`  ${String(c.name || "?").padEnd(5)} ${fmtDelta(-Math.abs(Number(c.loss)))} с${c.laps ? `  · ${c.laps} кругов` : ""}`);
    }
    out.push("");
  }

  const pressures = wheelLine("Давления, psi", rep.pressures, 2);
  const tyres = wheelLine("Шины, °C", rep.tyre_temps, 1);
  const brakes = wheelLine("Тормоза, °C", rep.brake_temps, 0);
  if (pressures || tyres || brakes) {
    out.push("СОСТОЯНИЕ МАШИНЫ");
    out.push(bar("-"));
    out.push(pressures + tyres + brakes);
    out.push("");
  }

  const advice = eventKeys.map((key) => `• ${EVENT_TIPS[key]}`);
  if (advice.length) {
    out.push("РЕКОМЕНДАЦИИ");
    out.push(bar("-"));
    out.push(advice.join("\n"));
    out.push("");
  }

  out.push(bar());
  out.push(`Сформировано ApexLab ${store.appVersion || ""} · ${new Date().toLocaleString("ru-RU")}`);
  out.push("Данные локальные: телеметрия ACC читается напрямую из MoTeC-логов.");
  return `${out.join("\n")}\n`;
}

async function saveTextFile(name, text) {
  const nativeApi = window.pywebview?.api;
  if (typeof nativeApi?.save_text === "function") {
    const res = await nativeApi.save_text(name, text);
    if (res?.ok) return { ok: true, path: res.path };
    if (res?.canceled) return { ok: false, canceled: true };
    throw new Error(res?.error || "Не удалось сохранить файл");
  }

  const blob = new Blob(["\ufeff", text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, download: true };
}

export async function exportSessionReport(meta) {
  if (!meta) {
    toast("Не удалось собрать отчёт: нет данных сессии", "err");
    return;
  }
  try {
    const text = sessionReportText(meta);
    const res = await saveTextFile(reportFileName(meta), text);
    if (res.canceled) return;
    if (res.download) {
      toast("Отчёт скачан", "ok");
    } else {
      const short = String(res.path || "").split(/[\\/]/).pop();
      toast(`Отчёт сохранён: ${short || res.path}`, "ok");
    }
  } catch (err) {
    toast(String(err?.message || err), "err");
  }
}
