/* Canvas charts: telemetry traces, track map, delta, radar. */
import { clamp, fmtDelta } from "./util.js";

function css(name, fallback = "") {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readPalette() {
  const wash = css("--wash-rgb", "255 255 255");
  const alpha = (a) => `rgb(${wash} / ${a})`;
  return {
    accent: css("--accent", "#c8ff3d"),
    accentRgb: css("--accent-rgb", "200 255 61"),
    orange: css("--orange", "#ff7a1a"),
    orangeRgb: css("--orange-rgb", "255 122 26"),
    red: css("--red", "#ff4f57"),
    redRgb: css("--red-rgb", "255 79 87"),
    green: css("--green", "#57e389"),
    greenRgb: css("--green-rgb", "87 227 137"),
    blue: css("--blue", "#57a8ff"),
    purple: css("--purple", "#b388ff"),
    yellow: css("--yellow", "#ffc53d"),
    yellowRgb: css("--yellow-rgb", "255 197 61"),
    text: css("--text", "#e9eff6"),
    muted: css("--muted", "#8b97a8"),
    dim: css("--dim", "#5c6778"),
    wash,
    grid: alpha(".055"),
    gridSoft: alpha(".032"),
    band: alpha(".021"),
    bandLine: alpha(".075"),
    casing: css("--chart-casing", "rgba(2,4,7,.86)"),
    labelBg: css("--chart-label-bg", "rgba(8,11,15,.82)"),
    labelText: css("--chart-label-text", "rgba(190,203,217,.85)"),
    start: css("--chart-start", "#f3f8ff"),
    marker: css("--chart-marker-stroke", "#0a0d12"),
    ink: css("--chart-ink", "rgba(235,243,252,.88)"),
    cursor: alpha(".5"),
    light: css("--theme-light", "0") === "1",
    chartMono: css("--chart-mono", "0") === "1",
    mono: '"Cascadia Mono","Consolas",monospace',
    sans: '"Segoe UI",system-ui,sans-serif',
  };
}

let C = readPalette();

export function refreshPalette() {
  C = readPalette();
}

const LIVE = new Set();
function track(chart) {
  LIVE.add(chart);
  return chart;
}

export function redrawAll() {
  C = readPalette();
  for (const chart of [...LIVE]) {
    if (!chart.canvas || !chart.canvas.isConnected) {
      LIVE.delete(chart);
      continue;
    }
    try { chart.draw(); } catch (err) { console.error("Не удалось перерисовать график", err); }
  }
  for (const canvas of [...RADARS]) {
    if (!canvas.isConnected) {
      RADARS.delete(canvas);
      continue;
    }
    try { drawRadar(canvas, canvas.__radarAxes || []); } catch (err) { console.error("Не удалось перерисовать радар", err); }
  }
}

const SPEED_DARK = [
  [0.0, [74, 92, 255]],
  [0.3, [63, 224, 207]],
  [0.58, [200, 255, 61]],
  [0.8, [255, 122, 26]],
  [1.0, [255, 79, 87]],
];

const SPEED_LIGHT = [
  [0.0, [37, 99, 235]],
  [0.3, [13, 148, 136]],
  [0.58, [101, 163, 13]],
  [0.8, [217, 119, 6]],
  [1.0, [220, 38, 38]],
];

const SPEED_MONO_DARK = [
  [0.0, [78, 84, 91]],
  [0.35, [139, 146, 154]],
  [0.65, [196, 202, 208]],
  [1.0, [255, 255, 255]],
];

const SPEED_MONO_LIGHT = [
  [0.0, [196, 196, 196]],
  [0.35, [138, 138, 138]],
  [0.65, [74, 74, 74]],
  [1.0, [5, 5, 5]],
];

export function speedColor(t) {
  const stops = C.chartMono
    ? (C.light ? SPEED_MONO_LIGHT : SPEED_MONO_DARK)
    : (C.light ? SPEED_LIGHT : SPEED_DARK);
  const x = clamp(Number(t) || 0, 0, 1);
  for (let i = 1; i < stops.length; i += 1) {
    const [p1, c1] = stops[i];
    const [p0, c0] = stops[i - 1];
    if (x <= p1) {
      const k = (x - p0) / Math.max(p1 - p0, 1e-6);
      const mix = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

function prepare(canvas, height) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(220, Math.round(rect.width || canvas.parentElement?.clientWidth || 640));
  const h = Math.max(40, Math.round(height || rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function prepareFill(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(60, Math.round(rect.width));
  const h = Math.max(60, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceStep(xMax, target = 8) {
  const steps = [100, 200, 250, 500, 1000, 2000, 2500, 5000];
  for (const s of steps) if (xMax / s <= target) return s;
  return 5000;
}

function hexAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function percentile(arr, q) {
  const a = Array.from(arr || []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = clamp(q * (a.length - 1), 0, a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/* ------------------------------------------------------------------ traces */

export class TraceChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.laps = [];
    this.corners = [];
    this.cursor = null;
    this.channels = { speed: true, pedals: true, steer: true, gear: true, ...(opts.channels || {}) };
    this.geom = null;
    track(this);
  }

  setData({ laps, corners, channels }) {
    this.laps = (laps || []).filter((l) => l && l.pack);
    this.corners = corners || this.laps[0]?.pack?.corners || [];
    if (channels) this.channels = { ...this.channels, ...channels };
    this.draw();
  }

  setCursor(dist) {
    this.cursor = dist;
    this.draw();
  }

  setChannels(channels) {
    this.channels = { ...this.channels, ...channels };
    this.draw();
  }

  distAtX(px) {
    if (!this.geom) return null;
    const { left, right, xMax } = this.geom;
    if (px < left - 2 || px > right + 2) return null;
    return clamp(((px - left) / Math.max(right - left, 1)) * xMax, 0, xMax);
  }

  draw() {
    const ch = this.channels;
    const panelsDef = [];
    if (ch.speed) panelsDef.push({ key: "speed", h: 132 });
    if (ch.pedals) panelsDef.push({ key: "pedals", h: 62 });
    if (ch.steer) panelsDef.push({ key: "steer", h: 46 });
    const gearH = ch.gear && this.laps.length ? 18 : 0;
    const gap = 10;
    const height = 20 + panelsDef.reduce((a, p) => a + p.h, 0)
      + gap * Math.max(0, panelsDef.length - 1) + (gearH ? gearH + 8 : 0) + 24;
    const { ctx, w, h } = prepare(this.canvas, height);

    const ml = 44, mr = 14, mt = 16;
    const xMax = Math.max(100, ...this.laps.map((l) => l.pack.distance || 0));
    const left = ml, right = w - mr;
    const xAt = (d) => left + (d / xMax) * (right - left);

    const panels = [];
    let y = mt;
    for (const p of panelsDef) {
      panels.push({ ...p, top: y, bottom: y + p.h });
      y += p.h + gap;
    }
    const gearTop = gearH ? y + 2 : 0;
    const axisY = (gearH ? gearTop + gearH : y) + 14;

    this.geom = { left, right, xMax, height: h, xAt };

    // vertical grid + corner bands
    const step = niceStep(xMax);
    ctx.font = `9px ${C.mono}`;
    for (let d = 0; d <= xMax + 1; d += step) {
      const x = Math.round(xAt(d)) + 0.5;
      ctx.strokeStyle = C.gridSoft;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, mt - 4);
      ctx.lineTo(x, axisY - 12);
      ctx.stroke();
      ctx.fillStyle = C.dim;
      ctx.textAlign = "center";
      ctx.fillText((d / 1000).toFixed(1), x, axisY);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.fillText("км", right - 10, axisY);

    if (this.corners?.length) {
      for (const c of this.corners) {
        const x0 = xAt(c.start), x1 = xAt(c.end), xa = xAt(c.apex);
        ctx.fillStyle = C.band;
        ctx.fillRect(x0, mt - 6, Math.max(1, x1 - x0), axisY - mt - 8);
        ctx.strokeStyle = C.bandLine;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(xa, mt - 6);
        ctx.lineTo(xa, axisY - 12);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.labelText;
        ctx.font = `8.5px ${C.mono}`;
        ctx.textAlign = "center";
        ctx.fillText(c.name || "", xa, 10);
      }
      ctx.textAlign = "left";
    }

    // panels
    for (const p of panels) {
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      if (p.key === "speed") {
        const max = Math.max(180, Math.ceil((Math.max(...this.laps.map((l) => Math.max(...l.pack.ch.spd))) + 10) / 50) * 50);
        p.min = 0; p.max = max;
        const rows = 3;
        for (let i = 0; i <= rows; i += 1) {
          const v = (max / rows) * i;
          const yy = p.bottom - (p.h * i) / rows;
          ctx.strokeStyle = i === 0 ? C.grid : C.gridSoft;
          ctx.beginPath(); ctx.moveTo(left, yy + 0.5); ctx.lineTo(right, yy + 0.5); ctx.stroke();
          ctx.fillStyle = C.dim;
          ctx.font = `9px ${C.mono}`;
          ctx.textAlign = "right";
          ctx.fillText(String(Math.round(v)), left - 9, yy + 3);
        }
      } else if (p.key === "pedals") {
        p.min = 0; p.max = 100;
        for (const v of [0, 50, 100]) {
          const yy = p.bottom - (p.h * v) / 100;
          ctx.strokeStyle = v === 0 ? C.grid : C.gridSoft;
          ctx.beginPath(); ctx.moveTo(left, yy + 0.5); ctx.lineTo(right, yy + 0.5); ctx.stroke();
          ctx.fillStyle = C.dim;
          ctx.font = `8.5px ${C.mono}`;
          ctx.textAlign = "right";
          ctx.fillText(String(v), left - 9, yy + 3);
        }
      } else {
        p.min = -100; p.max = 100;
        for (const v of [-100, 0, 100]) {
          const yy = p.bottom - ((v + 100) / 200) * p.h;
          ctx.strokeStyle = v === 0 ? C.grid : C.gridSoft;
          ctx.beginPath(); ctx.moveTo(left, yy + 0.5); ctx.lineTo(right, yy + 0.5); ctx.stroke();
          ctx.fillStyle = C.dim;
          ctx.font = `8px ${C.mono}`;
          ctx.textAlign = "right";
          ctx.fillText(v > 0 ? "R" : v < 0 ? "L" : "0", left - 9, yy + 3);
        }
      }
    }

    const valueY = (p, v) => p.bottom - ((clamp(v, p.min, p.max) - p.min) / (p.max - p.min)) * p.h;
    const makePath = (ctx2, pack, accessor) => {
      ctx2.beginPath();
      const n = pack.n;
      const s = pack.step || 5;
      for (let i = 0; i < n; i += 1) {
        const x = xAt(i * s);
        const yv = accessor(i);
        if (i === 0) ctx2.moveTo(x, yv); else ctx2.lineTo(x, yv);
      }
    };

    const speedPanel = panels.find((p) => p.key === "speed");
    const pedalPanel = panels.find((p) => p.key === "pedals");
    const steerPanel = panels.find((p) => p.key === "steer");
    const single = this.laps.length === 1;

    // speed
    if (speedPanel) {
      for (const [li, lap] of this.laps.entries()) {
        const pack = lap.pack;
        const color = lap.color || (li === 0 ? C.accent : C.orange);
        if (single) {
          const grad = ctx.createLinearGradient(0, speedPanel.top, 0, speedPanel.bottom);
          grad.addColorStop(0, hexAlpha(color, 0.2));
          grad.addColorStop(1, hexAlpha(color, 0.01));
          makePath(ctx, pack, (i) => valueY(speedPanel, pack.ch.spd[i]));
          ctx.lineTo(xAt((pack.n - 1) * (pack.step || 5)), speedPanel.bottom);
          ctx.lineTo(xAt(0), speedPanel.bottom);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
        makePath(ctx, pack, (i) => valueY(speedPanel, pack.ch.spd[i]));
        ctx.strokeStyle = color;
        ctx.lineWidth = single ? 2 : 1.8;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }

    // pedals
    if (pedalPanel) {
      for (const [li, lap] of this.laps.entries()) {
        const pack = lap.pack;
        const dashed = li > 0;
        if (single) {
          const gt = ctx.createLinearGradient(0, pedalPanel.top, 0, pedalPanel.bottom);
          gt.addColorStop(0, `rgb(${C.greenRgb} / .16)`);
          gt.addColorStop(1, `rgb(${C.greenRgb} / 0)`);
          makePath(ctx, pack, (i) => valueY(pedalPanel, pack.ch.thr[i]));
          ctx.lineTo(xAt((pack.n - 1) * (pack.step || 5)), pedalPanel.bottom);
          ctx.lineTo(xAt(0), pedalPanel.bottom);
          ctx.closePath();
          ctx.fillStyle = gt;
          ctx.fill();
        }
        if (dashed) ctx.setLineDash([4, 4]);
        ctx.globalAlpha = dashed ? 0.55 : 1;
        makePath(ctx, pack, (i) => valueY(pedalPanel, pack.ch.thr[i]));
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        makePath(ctx, pack, (i) => valueY(pedalPanel, pack.ch.brk[i]));
        ctx.strokeStyle = C.red;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }

    // steering
    if (steerPanel) {
      for (const [li, lap] of this.laps.entries()) {
        const pack = lap.pack;
        if (li > 0) ctx.setLineDash([4, 4]);
        ctx.globalAlpha = li > 0 ? 0.55 : 1;
        makePath(ctx, pack, (i) => valueY(steerPanel, pack.ch.str[i]));
        ctx.strokeStyle = li > 0 ? C.orange : C.blue;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }

    // gear strip
    if (gearH && this.laps[0]) {
      const pack = this.laps[0].pack;
      ctx.fillStyle = `rgb(${C.wash} / .03)`;
      ctx.font = `8.5px ${C.mono}`;
      ctx.textAlign = "center";
      const s = pack.step || 5;
      let start = 0;
      for (let i = 1; i <= pack.n; i += 1) {
        const g = pack.ch.gear[i - 1] || 0;
        const prev = pack.ch.gear[start] || 0;
        if (i === pack.n || g !== prev) {
          if (prev > 0) {
            const xa = xAt(start * s), xb = xAt(Math.min(i, pack.n - 1) * s);
            if (xb - xa > 9) ctx.fillText(String(Math.round(prev)), (xa + xb) / 2, gearTop + 13);
          }
          start = i;
        }
      }
      ctx.textAlign = "left";
      ctx.fillStyle = C.dim;
      ctx.font = `8px ${C.sans}`;
      ctx.fillText("передача", left - 42, gearTop + 13);
    }

    // cursor
    if (this.cursor != null) {
      const x = xAt(this.cursor);
      ctx.strokeStyle = C.cursor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mt - 6);
      ctx.lineTo(x + 0.5, axisY - 14);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const lap of this.laps) {
        const i = clamp(Math.round(this.cursor / (lap.pack.step || 5)), 0, lap.pack.n - 1);
        if (speedPanel) {
          ctx.beginPath();
          ctx.arc(x, valueY(speedPanel, lap.pack.ch.spd[i]), 3, 0, Math.PI * 2);
          ctx.fillStyle = lap.color || C.accent;
          ctx.fill();
          ctx.strokeStyle = C.marker;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ track map */

export class TrackMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = Object.assign({
      corners: true,
      events: true,
      compact: false,
      eventTypes: ["lock", "spin", "bottom"],
    }, opts);
    this.pack = null;
    this.cursor = null;
    this.geom = null;
    track(this);
  }

  setData({ pack, corners, events, eventTypes }) {
    if (pack !== undefined) this.pack = pack;
    if (corners !== undefined) this.corners = corners;
    if (events !== undefined) this.events = events;
    if (eventTypes !== undefined) this.opts.eventTypes = eventTypes;
    this.draw();
  }

  setCursor(dist) {
    this.cursor = dist;
    this.draw();
  }

  draw() {
    const pack = this.pack;
    const { ctx, w, h } = prepareFill(this.canvas);
    if (!pack?.path?.x?.length) {
      ctx.fillStyle = C.dim;
      ctx.font = `11px ${C.sans}`;
      ctx.textAlign = "center";
      ctx.fillText("Нет данных для карты", w / 2, h / 2);
      return;
    }
    const xs = pack.path.x, ys = pack.path.y;
    const n = Math.min(xs.length, ys.length);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    const compact = this.opts.compact;
    const pad = compact ? 10 : Math.min(30, Math.max(16, Math.min(w, h) * 0.06));
    const dx = Math.max(maxX - minX, 1);
    const dy = Math.max(maxY - minY, 1);
    const scale = Math.min((w - pad * 2) / dx, (h - pad * 2) / dy);
    const ox = (w - dx * scale) / 2 - minX * scale;
    const oy = (h - dy * scale) / 2 + maxY * scale;
    const pt = (i) => [ox + xs[i] * scale, oy - ys[i] * scale];
    this.geom = { pt, n, scale, ox, oy, w, h };

    const spd = pack.ch?.spd || [];
    const lo = percentile(spd, 0.03);
    const hi = percentile(spd, 0.97);
    const range = Math.max(hi - lo, 1);
    const step = pack.step || 5;

    // casing
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    let [px, py] = pt(0);
    ctx.moveTo(px, py);
    for (let i = 1; i < n; i += 1) {
      [px, py] = pt(i);
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = C.casing;
    ctx.lineWidth = compact ? 7.5 : 11;
    ctx.shadowColor = `rgb(${C.accentRgb} / .10)`;
    ctx.shadowBlur = compact ? 5 : 14;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // coloured segments
    ctx.lineWidth = compact ? 3.6 : 5.6;
    for (let i = 0; i < n - 1; i += 1) {
      const [x0, y0] = pt(i);
      const [x1, y1] = pt(i + 1);
      ctx.strokeStyle = speedColor((spd[i] - lo) / range);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // corner labels
    const corners = this.corners !== undefined ? this.corners : pack.corners || [];
    if (this.opts.corners && !compact && corners.length) {
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i += 1) { const [x, y] = pt(i); cx += x; cy += y; }
      cx /= n; cy /= n;
      ctx.font = `9px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const c of corners) {
        const i = clamp(Math.round((c.apex || 0) / step), 0, n - 1);
        const [x, y] = pt(i);
        const vx = x - cx, vy = y - cy;
        const len = Math.hypot(vx, vy) || 1;
        const lx = x + (vx / len) * 17;
        const ly = y + (vy / len) * 17;
        ctx.strokeStyle = `rgb(${C.wash} / .28)`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx - (vx / len) * 6, ly - (vy / len) * 6); ctx.stroke();
        const label = c.name || "";
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = C.labelBg;
        ctx.beginPath();
        ctx.roundRect(lx - tw / 2, ly - 7, tw, 14, 4);
        ctx.fill();
        ctx.fillStyle = C.labelText;
        ctx.fillText(label, lx, ly + 0.5);
      }
      ctx.textBaseline = "alphabetic";
    }

    // event markers
    const events = this.events !== undefined ? this.events : pack.events || [];
    if (this.opts.events && !compact && events.length) {
      const colors = { lock: C.red, spin: C.yellow, bottom: C.purple, brake_temp: C.orange, coast: C.muted };
      for (const e of events) {
        if (!this.opts.eventTypes.includes(e.type)) continue;
        const i = clamp(Math.round((e.dist || 0) / step), 0, n - 1);
        const [x, y] = pt(i);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = colors[e.type] || C.muted;
        ctx.strokeStyle = C.marker;
        ctx.lineWidth = 1.4;
        ctx.fillRect(-3, -3, 6, 6);
        ctx.strokeRect(-3, -3, 6, 6);
        ctx.restore();
      }
    }

    // start / finish
    const [sx, sy] = pt(0);
    ctx.beginPath();
    ctx.arc(sx, sy, compact ? 3 : 4.2, 0, Math.PI * 2);
    ctx.fillStyle = C.start;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.accent;
    ctx.stroke();

    // cursor
    if (this.cursor != null) {
      const i = clamp(Math.round(this.cursor / step), 0, n - 1);
      const [x, y] = pt(i);
      ctx.beginPath();
      ctx.arc(x, y, compact ? 5 : 7.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${C.wash} / .14)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, compact ? 2.6 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = C.text;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = C.marker;
      ctx.stroke();
    }
  }

  hitTest(clientX, clientY) {
    if (!this.geom) return null;
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { pt, n } = this.geom;
    const step = this.pack?.step || 5;
    let best = Infinity, bestI = 0;
    for (let i = 0; i < n; i += 1) {
      const [x, y] = pt(i);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < best) { best = d; bestI = i; }
    }
    const radius = this.opts.compact ? 16 : 26;
    if (best > radius * radius) return null;
    const [x, y] = pt(bestI);
    return { dist: bestI * step, x, y, index: bestI };
  }
}

/* ------------------------------------------------------------------ radar */

const RADARS = new Set();

export function drawRadar(canvas, axes) {
  RADARS.add(canvas);
  canvas.__radarAxes = axes;
  const { ctx, w, h } = prepareFill(canvas);
  const n = axes.length;
  if (!n) return;
  const cx = w / 2;
  const cy = h / 2 + 4;
  const R = Math.max(28, Math.min(w, h) / 2 - 34);

  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 4; ring += 1) {
    ctx.beginPath();
    for (let i = 0; i <= n; i += 1) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const r = (R * ring) / 4;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.strokeStyle = C.gridSoft;
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i <= n; i += 1) {
    const idx = i % n;
    const a = -Math.PI / 2 + (idx / n) * Math.PI * 2;
    const r = (R * clamp(axes[idx].value || 0, 0, 100)) / 100;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = `rgb(${C.accentRgb} / .13)`;
  ctx.fill();
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = (R * clamp(axes[i].value || 0, 0, 100)) / 100;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.arc(x, y, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = C.accent;
    ctx.fill();
  }

  ctx.font = `9.5px ${C.sans}`;
  ctx.fillStyle = C.labelText;
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const lx = cx + Math.cos(a) * (R + 17);
    const ly = cy + Math.sin(a) * (R + 15);
    const cos = Math.cos(a);
    ctx.textAlign = Math.abs(cos) < 0.25 ? "center" : cos > 0 ? "left" : "right";
    ctx.fillText(axes[i].label, lx, ly + 3);
  }
  ctx.textAlign = "left";
}

/* ------------------------------------------------------------------ delta */

export function computeDelta(a, b) {
  if (!a || !b) return null;
  const n = Math.min(a.n, b.n);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = a.t[i] - b.t[i];
  return out;
}

export class DeltaChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.series = null;
    this.corners = [];
    this.cursor = null;
    this.step = 5;
    this.geom = null;
    track(this);
  }

  setData(series, { corners, step } = {}) {
    this.series = series;
    this.corners = corners || [];
    this.step = step || 5;
    this.draw();
  }

  setCursor(dist) {
    this.cursor = dist;
    this.draw();
  }

  distAtX(px) {
    if (!this.geom) return null;
    const { left, right, xMax } = this.geom;
    if (px < left - 2 || px > right + 2) return null;
    return clamp(((px - left) / Math.max(right - left, 1)) * xMax, 0, xMax);
  }

  draw() {
    const { ctx, w, h } = prepare(this.canvas, 142);
    const ml = 44, mr = 14, mt = 12, mb = 22;
    const left = ml, right = w - mr, top = mt, bottom = h - mb;
    const data = this.series;
    if (!data?.length) {
      ctx.fillStyle = C.dim;
      ctx.font = `11px ${C.sans}`;
      ctx.textAlign = "center";
      ctx.fillText("Нет данных для дельты", w / 2, h / 2);
      return;
    }
    const xMax = Math.max(100, (data.length - 1) * this.step);
    const raw = Math.max(0.15, ...data.map((v) => Math.abs(v)));
    const nice = raw <= 0.25 ? 0.25 : raw <= 0.5 ? 0.5 : raw <= 1 ? 1 : raw <= 2 ? 2 : Math.ceil(raw);
    const mid = (top + bottom) / 2;
    const yAt = (v) => mid - (v / nice) * ((bottom - top) / 2);
    const xAt = (d) => left + (d / xMax) * (right - left);
    this.geom = { left, right, xMax };

    for (const c of this.corners || []) {
      const x0 = xAt(c.start), x1 = xAt(c.end);
      ctx.fillStyle = C.band;
      ctx.fillRect(x0, top, Math.max(1, x1 - x0), bottom - top);
    }

    for (const v of [nice, nice / 2, 0, -nice / 2, -nice]) {
      const y = yAt(v);
      ctx.strokeStyle = v === 0 ? `rgb(${C.wash} / .16)` : C.gridSoft;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(right, y + 0.5); ctx.stroke();
      ctx.fillStyle = C.dim;
      ctx.font = `9px ${C.mono}`;
      ctx.textAlign = "right";
      ctx.fillText(v === 0 ? "0" : fmtDelta(v, 2), left - 8, y + 3);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = `9px ${C.mono}`;
    const stepM = niceStep(xMax);
    for (let d = 0; d <= xMax + 1; d += stepM) {
      const x = Math.round(xAt(d)) + 0.5;
      ctx.strokeStyle = C.gridSoft;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillStyle = C.dim;
      ctx.fillText((d / 1000).toFixed(1), x, h - 7);
    }
    ctx.textAlign = "left";

    // area segments
    for (let i = 1; i < data.length; i += 1) {
      const x0 = xAt((i - 1) * this.step), x1 = xAt(i * this.step);
      const y0 = yAt(data[i - 1]), y1 = yAt(data[i]);
      const positive = (data[i - 1] + data[i]) / 2 >= 0;
      ctx.fillStyle = positive ? `rgb(${C.redRgb} / .16)` : `rgb(${C.accentRgb} / .16)`;
      ctx.beginPath();
      ctx.moveTo(x0, mid);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, mid);
      ctx.closePath();
      ctx.fill();
    }

    ctx.beginPath();
    for (let i = 0; i < data.length; i += 1) {
      const x = xAt(i * this.step), y = yAt(data[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    if (this.cursor != null) {
      const i = clamp(Math.round(this.cursor / this.step), 0, data.length - 1);
      const x = xAt(i * this.step);
      const y = yAt(data[i]);
      ctx.strokeStyle = `rgb(${C.wash} / .45)`;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = C.text;
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------- trajectory compare */

export function lineColor(absDev) {
  const v = Math.abs(Number(absDev) || 0);
  if (v < 0.7) return C.green;
  if (v < 1.4) return C.accent;
  if (v < 2.4) return C.yellow;
  return C.red;
}

export class TrajectoryMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = Object.assign({ corners: true }, opts);
    this.refPath = null;
    this.curPath = null;
    this.dev = [];
    this.corners = [];
    this.zones = [];
    this.step = 5;
    this.cursor = null;
    this.geom = null;
    track(this);
  }

  setData({ refPath, curPath, dev, corners, zones, step }) {
    this.refPath = refPath || null;
    this.curPath = curPath || null;
    this.dev = dev || [];
    this.corners = corners || [];
    this.zones = zones || [];
    this.step = step || 5;
    this.draw();
  }

  setCursor(dist) {
    this.cursor = dist;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = prepareFill(this.canvas);
    const rp = this.refPath;
    if (!rp?.x?.length) {
      ctx.fillStyle = C.dim;
      ctx.font = `11px ${C.sans}`;
      ctx.textAlign = "center";
      ctx.fillText("Нет данных для карты", w / 2, h / 2);
      return;
    }
    const n = Math.min(rp.x.length, rp.y.length,
      this.curPath?.x?.length || Infinity, this.curPath?.y?.length || Infinity);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const x = rp.x[i], y = rp.y[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = Math.min(34, Math.max(18, Math.min(w, h) * 0.065));
    const dx = Math.max(maxX - minX, 1);
    const dy = Math.max(maxY - minY, 1);
    const scale = Math.min((w - pad * 2) / dx, (h - pad * 2) / dy);
    const ox = (w - dx * scale) / 2 - minX * scale;
    const oy = (h - dy * scale) / 2 + maxY * scale;
    const pt = (i) => [ox + rp.x[i] * scale, oy - rp.y[i] * scale];
    const cpt = (i) => [ox + this.curPath.x[i] * scale, oy - this.curPath.y[i] * scale];
    this.geom = { pt, cpt, n, scale, ox, oy, w, h };

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // reference casing + line
    ctx.beginPath();
    let [px, py] = pt(0);
    ctx.moveTo(px, py);
    for (let i = 1; i < n; i += 1) {
      [px, py] = pt(i);
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = C.casing;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.strokeStyle = `rgb(${C.wash} / .42)`;
    ctx.lineWidth = 2.2;
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // current line, coloured by deviation
    const cp = this.curPath;
    if (cp?.x?.length) {
      ctx.lineWidth = 5.2;
      for (let i = 0; i < n - 1; i += 1) {
        const [x0, y0] = cpt(i);
        const [x1, y1] = cpt(i + 1);
        ctx.strokeStyle = lineColor((this.dev[i] + this.dev[i + 1]) / 2);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }

    // corner names
    if (this.opts.corners && this.corners.length) {
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i += 1) { const [x, y] = pt(i); cx += x; cy += y; }
      cx /= n; cy /= n;
      ctx.font = `9px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const c of this.corners) {
        const i = clamp(Math.round((c.apex || 0) / this.step), 0, n - 1);
        const [x, y] = pt(i);
        const vx = x - cx, vy = y - cy;
        const len = Math.hypot(vx, vy) || 1;
        const lx = x + (vx / len) * 17;
        const ly = y + (vy / len) * 17;
        const label = c.name || "";
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = C.labelBg;
        ctx.beginPath();
        ctx.roundRect(lx - tw / 2, ly - 7, tw, 14, 4);
        ctx.fill();
        ctx.fillStyle = C.labelText;
        ctx.fillText(label, lx, ly + 0.5);
      }
      ctx.textBaseline = "alphabetic";
    }

    // numbered problem zones
    for (const z of this.zones) {
      const i = clamp(Math.round((z.peak_dist || 0) / this.step), 0, n - 1);
      const [x, y] = cpt(i);
      const color = z.severity === "high" ? C.red : z.severity === "mid" ? C.orange : C.yellow;
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = C.labelBg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = `600 9px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(z.n), x, y + 0.5);
    }
    ctx.textBaseline = "alphabetic";

    // start / finish
    const [sx, sy] = pt(0);
    ctx.beginPath();
    ctx.arc(sx, sy, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = C.start;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.accent;
    ctx.stroke();

    // cursor: reference point, current point and the offset between them
    if (this.cursor != null) {
      const i = clamp(Math.round(this.cursor / this.step), 0, n - 1);
      const [rx, ry] = pt(i);
      const [kx, ky] = cpt(i);
      ctx.strokeStyle = `rgb(${C.wash} / .52)`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(kx, ky); ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y, color] of [[rx, ry, `rgb(${C.wash} / .9)`], [kx, ky, lineColor(this.dev[i])]]) {
        ctx.beginPath();
        ctx.arc(x, y, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = C.marker;
        ctx.stroke();
      }
    }
  }

  hitTest(clientX, clientY) {
    if (!this.geom || !this.curPath?.x?.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { cpt, n } = this.geom;
    let best = Infinity, bestI = 0;
    for (let i = 0; i < n; i += 1) {
      const [x, y] = cpt(i);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < best) { best = d; bestI = i; }
    }
    if (best > 28 * 28) return null;
    return { dist: bestI * this.step, index: bestI };
  }
}

export class LineDevChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.dev = [];
    this.corners = [];
    this.zones = [];
    this.step = 5;
    this.threshold = 1.15;
    this.cursor = null;
    this.geom = null;
    track(this);
  }

  setData({ dev, corners, zones, step, threshold }) {
    this.dev = dev || [];
    this.corners = corners || [];
    this.zones = zones || [];
    this.step = step || 5;
    this.threshold = threshold || 1.15;
    this.draw();
  }

  setCursor(dist) {
    this.cursor = dist;
    this.draw();
  }

  distAtX(px) {
    if (!this.geom) return null;
    const { left, right, xMax } = this.geom;
    if (px < left - 2 || px > right + 2) return null;
    return clamp(((px - left) / Math.max(right - left, 1)) * xMax, 0, xMax);
  }

  draw() {
    const { ctx, w, h } = prepare(this.canvas, 188);
    const ml = 46, mr = 16, mt = 14, mb = 24;
    const left = ml, right = w - mr, top = mt, bottom = h - mb;
    const data = this.dev;
    if (!data?.length) {
      ctx.fillStyle = C.dim;
      ctx.font = `11px ${C.sans}`;
      ctx.textAlign = "center";
      ctx.fillText("Нет данных об отклонении", w / 2, h / 2);
      return;
    }
    const xMax = Math.max(100, (data.length - 1) * this.step);
    const p = percentile(data.map((v) => Math.abs(v)), 0.97);
    const yMax = Math.max(2.5, Math.ceil((p + 0.4) * 2) / 2);
    const mid = (top + bottom) / 2;
    const yAt = (v) => mid - (v / yMax) * ((bottom - top) / 2);
    const xAt = (d) => left + (d / xMax) * (right - left);
    this.geom = { left, right, xMax };

    for (const c of this.corners) {
      const x0 = xAt(Math.max(0, c.start)), x1 = xAt(Math.min(xMax, c.end));
      ctx.fillStyle = C.band;
      ctx.fillRect(x0, top, Math.max(1, x1 - x0), bottom - top);
      ctx.fillStyle = C.labelText;
      ctx.font = `8.5px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.fillText(c.name || "", xAt(clamp(c.apex, 0, xMax)), top - 3 + 9);
    }

    // threshold band
    ctx.fillStyle = `rgb(${C.yellowRgb} / .035)`;
    ctx.fillRect(left, yAt(this.threshold), right - left, yAt(-this.threshold) - yAt(this.threshold));
    for (const v of [this.threshold, -this.threshold]) {
      ctx.strokeStyle = `rgb(${C.yellowRgb} / .26)`;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, yAt(v) + 0.5); ctx.lineTo(right, yAt(v) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }

    const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax];
    for (const v of ticks) {
      const y = yAt(v);
      ctx.strokeStyle = v === 0 ? `rgb(${C.wash} / .18)` : C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(right, y + 0.5); ctx.stroke();
      ctx.fillStyle = C.dim;
      ctx.font = `9px ${C.mono}`;
      ctx.textAlign = "right";
      ctx.fillText(v === 0 ? "0" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`, left - 8, y + 3);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.font = `9px ${C.mono}`;
    ctx.fillText("м", left - 34, top + 8);

    // area + line
    for (let i = 1; i < data.length; i += 1) {
      const x0 = xAt((i - 1) * this.step), x1 = xAt(i * this.step);
      const y0 = yAt(data[i - 1]), y1 = yAt(data[i]);
      const v = (Math.abs(data[i - 1]) + Math.abs(data[i])) / 2;
      ctx.fillStyle = v < 0.55 ? `rgb(${C.greenRgb} / .12)`
        : v < 1.2 ? `rgb(${C.accentRgb} / .16)`
          : v < 2.2 ? `rgb(${C.yellowRgb} / .18)` : `rgb(${C.redRgb} / .20)`;
      ctx.beginPath();
      ctx.moveTo(x0, mid);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1, mid);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < data.length; i += 1) {
      const x = xAt(i * this.step), y = yAt(data[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // zone dots
    for (const z of this.zones) {
      const x = xAt(clamp(z.peak_dist, 0, xMax));
      const y = yAt(clamp(z.peak_dev, -yMax, yMax));
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = z.severity === "high" ? C.red : z.severity === "mid" ? C.orange : C.yellow;
      ctx.fill();
      ctx.strokeStyle = C.marker;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    const stepM = niceStep(xMax);
    for (let d = 0; d <= xMax + 1; d += stepM) {
      const x = Math.round(xAt(d)) + 0.5;
      ctx.strokeStyle = C.gridSoft;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillStyle = C.dim;
      ctx.fillText((d / 1000).toFixed(1), x, h - 7);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = C.dim;
    ctx.fillText("км", right - 12, h - 7);

    if (this.cursor != null) {
      const i = clamp(Math.round(this.cursor / this.step), 0, data.length - 1);
      const x = xAt(i * this.step);
      const y = yAt(clamp(data[i], -yMax, yMax));
      ctx.strokeStyle = `rgb(${C.wash} / .48)`;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = C.text;
      ctx.fill();
    }
  }
}
