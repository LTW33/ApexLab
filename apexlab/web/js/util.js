/* Small helpers: formatting, escaping, icons. */

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtTime(sec, digits = 3) {
  const value = Number(sec);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const m = Math.floor(value / 60);
  const s = value - m * 60;
  const body = s.toFixed(digits).padStart(digits + 3, "0");
  return m > 0 ? `${m}:${body}` : s.toFixed(digits);
}

export function fmtShort(sec, digits = 1) {
  const value = Number(sec);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const m = Math.floor(value / 60);
  const s = value - m * 60;
  return m > 0 ? `${m}:${s.toFixed(digits).padStart(digits + 3, "0")}` : s.toFixed(digits);
}

export function fmtDelta(sec, digits = 3) {
  const value = Number(sec);
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0.0005 ? "+" : value < -0.0005 ? "−" : "";
  return sign + Math.abs(value).toFixed(digits);
}

export function deltaClass(sec) {
  const value = Number(sec);
  if (!Number.isFinite(value) || Math.abs(value) < 0.0005) return "";
  return value > 0 ? "delta-pos" : "delta-neg";
}

export function fmtKm(meters, digits = 2) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(digits)} км`;
  return `${Math.round(value)} м`;
}

export function fmtSize(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
  if (value > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  if (value > 1024) return `${(value / 1024).toFixed(0)} КБ`;
  return `${value} Б`;
}

export function fmtDate(str) {
  const text = String(str || "");
  const m = text.match(/(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/);
  if (!m) return text;
  let day, month, year;
  if (m[1].length === 4) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else {
    day = +m[1]; month = +m[2]; year = +m[3];
    if (year < 100) year += 2000;
  }
  if (!day || !month || month > 12) return text;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function fmtClock(str) {
  const m = String(str || "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${+m[1]}:${m[2]}` : "";
}

export function fmtDateTime(date, time) {
  const d = fmtDate(date);
  const t = fmtClock(time);
  return [d, t].filter(Boolean).join(", ");
}

export function dateValue(str) {
  const m = String(str || "").match(/(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/);
  if (!m) return 0;
  if (m[1].length === 4) return +m[1] * 10000 + +m[2] * 100 + +m[3];
  return +m[3] * 10000 + +m[2] * 100 + +m[1];
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "P";
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

export function avg(list) {
  const arr = (list || []).filter((v) => Number.isFinite(Number(v)));
  if (!arr.length) return 0;
  return arr.reduce((a, v) => a + Number(v), 0) / arr.length;
}

export function sum(list) {
  return (list || []).reduce((a, v) => a + (Number(v) || 0), 0);
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function plural(n, one, few, many) {
  const num = Math.abs(n) % 100;
  const last = num % 10;
  if (num > 10 && num < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function scoreColor(score) {
  const s = Number(score);
  if (!Number.isFinite(s) || s <= 0) return "var(--dim)";
  if (s >= 90) return "var(--accent)";
  if (s >= 80) return "var(--cyan)";
  if (s >= 70) return "var(--yellow)";
  if (s >= 60) return "var(--orange)";
  return "var(--red)";
}

export function scoreLabel(score) {
  const s = Number(score);
  if (!Number.isFinite(s) || s <= 0) return "нет данных";
  if (s >= 90) return "отличный темп";
  if (s >= 80) return "уверенно";
  if (s >= 70) return "есть запас";
  if (s >= 60) return "много ошибок";
  return "нужна работа";
}

export function balanceText(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.05) return "нейтрально";
  return v < 0 ? "недостаточная" : "избыточная";
}

export function tagMeta(tag) {
  const map = {
    best: { label: "быстрейший", cls: "lime" },
    pit: { label: "пит-лейн", cls: "orange" },
    out: { label: "выезд", cls: "grey" },
    slow: { label: "медленный", cls: "red" },
    partial: { label: "фрагмент", cls: "grey" },
  };
  return map[tag] || { label: tag, cls: "grey" };
}

export const EVENTS = {
  lock: { label: "Блокировка", many: "Блокировки", color: "var(--red)", icon: "alert" },
  spin: { label: "Пробуксовка", many: "Пробуксовки", color: "var(--yellow)", icon: "zap" },
  bottom: { label: "Пробой", many: "Пробои подвески", color: "var(--purple)", icon: "layers" },
  brake_temp: { label: "Перегрев тормозов", many: "Перегрев тормозов", color: "var(--orange)", icon: "thermo" },
  coast: { label: "Накат", many: "Движение накатом", color: "var(--muted)", icon: "wind" },
};

const ICONS = {
  car: '<path d="M19 17h2v-4l-2-5H5l-2 5v4h2"/><path d="M7 17h10"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 12h14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  compare: '<path d="m8 3-4 4 4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
  trophy: '<path d="M6 4h12v5a6 6 0 0 1-12 0V4Z"/><path d="M6 6H4a2 2 0 0 0 0 4h2M18 6h2a2 2 0 0 1 0 4h-2"/><path d="M12 15v5M8 21h8"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18h1.4a2.4 2.4 0 0 0 2.4-2.4c0-.7-.3-1.3-.7-1.8-.4-.5-.6-1-.6-1.6 0-1.2 1-2.2 2.2-2.2H18a3 3 0 0 0 3-3c0-4.5-4.1-7-9-7Z"/><circle cx="7.4" cy="11.6" r="1"/><circle cx="10.2" cy="7.6" r="1"/><circle cx="15.2" cy="7.6" r="1"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  upRight: '<path d="M7 17 17 7M7 7h10v10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  map: '<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3Z"/><path d="M9 3v15M15 6v15"/>',
  gauge: '<path d="M12 14 17 9"/><path d="M21 12a9 9 0 1 0-18 0"/><path d="M3 12h2M19 12h2M12 3v2"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  thermo: '<path d="M14 4a2 2 0 0 0-4 0v9.5a4 4 0 1 0 4 0V4Z"/><path d="M12 9v6"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  play: '<path d="m8 5 12 7-12 7V5Z"/>',
  route: '<circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="5" r="2.5"/><path d="M7.5 19h3.5a3 3 0 0 0 3-3v-2a3 3 0 0 1 3-3h2"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  pin: '<path d="M9 3h6l-.9 5.2 2.9 2.9V13H7v-1.9l2.9-2.9L9 3Z"/><path d="M12 13v8"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
};

export function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

export function scoreRing(score, cls = "") {
  const r = 27;
  const circ = 2 * Math.PI * r;
  const value = Number(score);
  const has = Number.isFinite(value) && value > 0;
  const pct = has ? clamp(value, 0, 100) : 0;
  const color = scoreColor(has ? value : 0);
  const offset = circ * (1 - pct / 100);
  const label = has ? Math.round(value) : "—";
  return `<svg class="score-ring ${cls}" viewBox="0 0 64 64" role="img" aria-label="Счёт ${label}">
    <circle class="ring-bg" cx="32" cy="32" r="${r}"/>
    <circle class="ring-fg" cx="32" cy="32" r="${r}" stroke="${color}"
      stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="35.5" text-anchor="middle">${label}</text>
    <text class="ring-cap" x="32" y="46" text-anchor="middle">ОЦЕНКА</text>
  </svg>`;
}

export function debounce(fn, ms = 120) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function sampleIndex(pack, dist, step = 5) {
  const n = pack?.n || 0;
  if (!n) return 0;
  return clamp(Math.round(dist / step), 0, n - 1);
}

export function sampleAt(pack, dist) {
  if (!pack) return null;
  const i = sampleIndex(pack, dist, pack.step || 5);
  const ch = pack.ch;
  return {
    i,
    dist: i * (pack.step || 5),
    speed: ch.spd?.[i] ?? 0,
    thr: ch.thr?.[i] ?? 0,
    brk: ch.brk?.[i] ?? 0,
    gear: ch.gear?.[i] ?? 0,
    steer: ch.str?.[i] ?? 0,
    lat: ch.lat?.[i] ?? 0,
    rpm: ch.rpm?.[i] ?? 0,
    time: pack.t?.[i] ?? 0,
  };
}
