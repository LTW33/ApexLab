"""
ACC / MoTeC .ld telemetry reader and analysis engine.

The .ld container is a MoTeC i2 log: a 64 byte file header, an event block and a
linked list of 124 byte channel headers.  Every channel owns a contiguous block
of float32 samples.  ACC writes all channels as float32; sample rates depend on
the channel (20 - 200 Hz).

No third party dependency except numpy.
"""
from __future__ import annotations

import math
import os
import struct
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np

HEADER_SIZE = 64
CHANNEL_HEADER_SIZE = 124
GRID_STEP = 5.0  # meters between samples in the distance domain

# ---------------------------------------------------------------- channel meta

_CHANNEL_MAP = {
    "LAP_BEACON": "beacon",
    "G_LAT": "lat",
    "G_LON": "lon",
    "ROTY": "yaw",
    "STEERANGLE": "steer",
    "SPEED": "speed",
    "THROTTLE": "throttle",
    "BRAKE": "brake",
    "GEAR": "gear",
    "CLUTCH": "clutch",
    "RPMS": "rpm",
    "TC": "tc",
    "ABS": "abs",
    "SUS_TRAVEL_LF": "sus_fl",
    "SUS_TRAVEL_RF": "sus_fr",
    "SUS_TRAVEL_LR": "sus_rl",
    "SUS_TRAVEL_RR": "sus_rr",
    "BRAKE_TEMP_LF": "bt_fl",
    "BRAKE_TEMP_RF": "bt_fr",
    "BRAKE_TEMP_LR": "bt_rl",
    "BRAKE_TEMP_RR": "bt_rr",
    "TYRE_PRESS_LF": "tp_fl",
    "TYRE_PRESS_RF": "tp_fr",
    "TYRE_PRESS_LR": "tp_rl",
    "TYRE_PRESS_RR": "tp_rr",
    "TYRE_TAIR_LF": "tt_fl",
    "TYRE_TAIR_RF": "tt_fr",
    "TYRE_TAIR_LR": "tt_rl",
    "TYRE_TAIR_RR": "tt_rr",
    "WHEEL_SPEED_LF": "ws_fl",
    "WHEEL_SPEED_RF": "ws_fr",
    "WHEEL_SPEED_LR": "ws_rl",
    "WHEEL_SPEED_RR": "ws_rr",
    "BUMPSTOPUP_RIDE_LF": "bsu_fl",
    "BUMPSTOPUP_RIDE_RF": "bsu_fr",
    "BUMPSTOPUP_RIDE_LR": "bsu_rl",
    "BUMPSTOPUP_RIDE_RR": "bsu_rr",
    "BUMPSTOPDN_RIDE_LF": "bsd_fl",
    "BUMPSTOPDN_RIDE_RF": "bsd_fr",
    "BUMPSTOPDN_RIDE_LR": "bsd_rl",
    "BUMPSTOPDN_RIDE_RR": "bsd_rr",
    "BUMPSTOP_FORCE_LF": "bsf_fl",
    "BUMPSTOP_FORCE_RF": "bsf_fr",
    "BUMPSTOP_FORCE_LR": "bsf_rl",
    "BUMPSTOP_FORCE_RR": "bsf_rr",
    "TIME": "lap_time",
    "EN_ET": "en_et",
    "EN_TL": "en_tl",
    "EN_TD": "en_td",
    "EN_TB": "en_tb",
    "EN_TW": "en_tw",
    "EN_W": "en_w",
    "EN_Dy": "en_dy",
    "EN_AP": "en_ap",
    "EN_GR": "en_gr",
}


def _text(buf: bytes, offset: int, size: int) -> str:
    raw = buf[offset:offset + size].split(b"\x00")[0]
    return raw.decode("latin-1", errors="replace").strip()


@dataclass
class Log:
    path: str
    size: int
    meta: dict
    channels: dict[str, np.ndarray]
    rates: dict[str, int]
    units: dict[str, str]
    duration: float
    raw_names: dict[str, str] = field(default_factory=dict)

    def has(self, *names: str) -> bool:
        return all(n in self.channels for n in names)


def read_ld(path: str) -> Log:
    with open(path, "rb") as fh:
        buf = fh.read()
    if len(buf) < HEADER_SIZE:
        raise ValueError("Файл слишком короткий для MoTeC .ld")
    header_size, _, chan_addr, data_addr = struct.unpack_from("<4I", buf, 0)
    if header_size not in (64, 0x40):
        raise ValueError("Неизвестный формат .ld")

    meta = {
        "date": _text(buf, 0x5E, 16),
        "time": _text(buf, 0x7E, 16),
        "venue": _text(buf, 0x15E, 64),
        "car": _text(buf, 0x6E2, 64),
        "data_addr": data_addr,
    }

    channels: dict[str, np.ndarray] = {}
    rates: dict[str, int] = {}
    units: dict[str, str] = {}
    raw_names: dict[str, str] = {}

    addr = chan_addr
    seen = 0
    while addr and seen < 512:
        seen += 1
        if addr + CHANNEL_HEADER_SIZE > len(buf):
            break
        _, nxt, offset, count, _, rate_type, _flags = struct.unpack_from("<7I", buf, addr)
        name = _text(buf, addr + 0x20, 32)
        unit = _text(buf, addr + 0x44, 20)
        rate = rate_type >> 16
        dtype = rate_type & 0xFFFF

        if name and count > 0 and rate > 0:
            key = _CHANNEL_MAP.get(name, name.lower())
            if dtype == 4:
                nbytes = count * 4
                if offset + nbytes <= len(buf):
                    arr = np.frombuffer(buf, dtype="<f4", count=count, offset=offset)
                    channels[key] = arr
                    rates[key] = rate
                    units[key] = unit
                    raw_names[key] = name
        if not nxt:
            break
        addr = nxt

    if not channels:
        raise ValueError("В логе нет каналов с данными (возможно, экспорт оборвался)")

    duration = max(len(a) / rates[k] for k, a in channels.items())
    return Log(path=path, size=len(buf), meta=meta, channels=channels,
               rates=rates, units=units, duration=duration, raw_names=raw_names)


# ---------------------------------------------------------------- lap slicing


@dataclass
class Lap:
    index: int
    start: float           # session time, s
    end: float
    time: float
    distance: float
    partial: bool = False
    valid: bool = True
    tags: list[str] = field(default_factory=list)
    stop_ratio: float = 0.0


def _session_series(log: Log, key: str, start: float, end: float):
    rate = log.rates[key]
    arr = log.channels[key]
    ia = max(0, int(math.ceil(start * rate)))
    ib = min(len(arr), int(math.floor(end * rate)) + 1)
    sl = arr[ia:ib]
    t = np.arange(ia, ib, dtype=np.float64) / rate
    return t, sl


def _resample_time(log: Log, key: str, times: np.ndarray) -> np.ndarray:
    rate = log.rates[key]
    arr = log.channels[key]
    pos = np.clip(times * rate, 0, len(arr) - 1)
    i0 = np.floor(pos).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(arr) - 1)
    frac = pos - i0
    return arr[i0] * (1.0 - frac) + arr[i1] * frac


def lap_spans(log: Log) -> list[Lap]:
    """Split a log into laps using ACC's lap timer (TIME resets to zero)."""
    if not log.has("speed"):
        return []

    speed = log.channels["speed"]
    srate = log.rates["speed"]
    duration = len(speed) / srate

    bounds: list[float] = [0.0]
    if log.has("lap_time") and len(log.channels["lap_time"]) > 8:
        lt = log.channels["lap_time"]
        lrate = log.rates["lap_time"]
        resets = np.where(np.diff(lt.astype(np.float64)) < -1.0)[0]
        for i in resets:
            b = (i + 1) / lrate
            if b > bounds[-1] + 1.0:
                bounds.append(float(b))
    bounds.append(duration)

    raw: list[Lap] = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if b - a < 3.0:
            continue
        t, s = _session_series(log, "speed", a, b)
        if len(s) < 10:
            continue
        dist = float(np.trapezoid(np.abs(s), dx=1.0 / srate))
        stop = float(np.mean(s < 2.0))
        raw.append(Lap(index=len(raw), start=a, end=b, time=b - a,
                       distance=dist, stop_ratio=stop))

    if not raw:
        return []

    # The first span is partial when the recording started mid-lap
    if log.has("lap_time"):
        first_timer = float(log.channels["lap_time"][0])
        if first_timer > 5.0:
            raw[0].partial = True

    # Reference lap length: median of the upper half of all distances.
    # Pit in/out laps drag the average down, so they must not define the track.
    all_dist = sorted(l.distance for l in raw if l.distance > 500)
    if all_dist:
        upper = all_dist[len(all_dist) // 2:]
        median_dist = float(np.median(upper))
    else:
        median_dist = 0.0
    median_time = float(np.median([l.time for l in raw if l.time > 10])) if len(raw) > 1 else 0.0
    fastest = float(min((l.time for l in raw if not l.partial and l.distance > 1000), default=0.0))

    for lap in raw:
        tags: list[str] = []
        if lap is raw[-1] and len(raw) > 1 and median_time and lap.time < 0.6 * median_time:
            tags.append("partial")
        if lap.partial:
            tags.append("out")
        if median_dist:
            ratio = lap.distance / median_dist
            if ratio < 0.90 or ratio > 1.10:
                tags.append("pit")
        if lap.stop_ratio > 0.03:
            tags.append("pit")
        if fastest and lap.time > fastest * 1.35:
            tags.append("slow")
        lap.tags = list(dict.fromkeys(tags))
        lap.valid = not lap.tags

    # best of the valid laps
    valid = [l for l in raw if l.valid]
    if valid:
        best = min(valid, key=lambda l: l.time)
        best.tags.append("best")

    return raw


# ---------------------------------------------------------------- lap analysis


def _smooth(x: np.ndarray, w: int) -> np.ndarray:
    if w <= 1 or len(x) < 3:
        return x
    w = min(w, len(x) // 2 * 2 + 1)
    k = np.ones(w, dtype=np.float64) / w
    return np.convolve(x, k, mode="same")


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous True runs -> inclusive (from, to) index pairs."""
    if not mask.any():
        return []
    m = np.concatenate(([False], mask.astype(bool), [False]))
    d = np.diff(m.astype(np.int8))
    starts = np.where(d == 1)[0]
    ends = np.where(d == -1)[0] - 1
    return list(zip(starts.tolist(), ends.tolist()))


def _segments(mask: np.ndarray, step: float, gap_m: float = 12.0,
              min_len_m: float = 12.0) -> list[tuple[float, float, int, int]]:
    runs = _runs(mask)
    if not runs:
        return []
    merged = [list(runs[0])]
    for a, b in runs[1:]:
        if (a - merged[-1][1] - 1) * step <= gap_m:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    out = []
    for a, b in merged:
        if (b - a + 1) * step >= min_len_m:
            out.append((a * step, b * step, a, b))
    return out


def _fit_balance(log: Log, start: float, end: float) -> float:
    """Fit yaw = k * v * steer on this lap; k absorbs the steering ratio."""
    if not log.has("yaw", "steer", "speed"):
        return 0.0
    rate = log.rates["yaw"]
    ia = max(0, int(math.ceil(start * rate)))
    ib = min(len(log.channels["yaw"]), int(math.floor(end * rate)) + 1)
    if ib - ia < 20:
        return 0.0
    t = np.arange(ia, ib, dtype=np.float64) / rate
    v = _resample_time(log, "speed", t)
    st = _resample_time(log, "steer", t)
    yaw = log.channels["yaw"][ia:ib].astype(np.float64)
    m = (v > 15) & (np.abs(st) > 5) & (np.abs(yaw) > 0.04)
    if m.sum() < 40:
        return 0.0
    x = v[m] * st[m]
    k = float(np.sum(x * yaw[m]) / max(np.sum(x * x), 1e-9))
    return k


def _detect_corners(lat: np.ndarray, speed: np.ndarray, step: float,
                    distance: float) -> list[dict]:
    abslat = _smooth(np.abs(lat), 5)
    mask = (abslat > 0.78) & (speed > 45.0)
    segs = _segments(mask, step, gap_m=28.0, min_len_m=25.0)
    corners = []
    for a, b, ia, ib in segs:
        apex_i = ia + int(np.argmax(abslat[ia:ib + 1]))
        corners.append({
            "start": round(max(0.0, a - 35.0), 1),
            "end": round(min(distance, b + 35.0), 1),
            "apex": round(apex_i * step, 1),
            "lat": round(float(abslat[apex_i]), 2),
        })
    # merge a first/last corner split by the start line
    if (len(corners) > 1 and corners[0]["start"] <= 0.0
            and corners[-1]["end"] >= distance - 1.0):
        first, last = corners[0], corners.pop()
        first["start"] = last["start"] - distance
        first["lat"] = max(first["lat"], last["lat"])
    for i, c in enumerate(corners):
        c["name"] = f"T{i + 1}"
        c["index"] = i
    return corners


def _corner_stats(lap: dict, corner: dict) -> dict:
    dist = lap["_dist"]
    step = lap["step"]
    ia = max(0, int(corner["start"] / step))
    ib = min(len(dist) - 1, int(corner["end"] / step))
    if ib <= ia:
        return {}
    ch = lap["ch"]
    spd = ch["spd"]
    apex_i = min(ib, max(ia, int(corner["apex"] / step)))
    bal = lap.get("_bal")
    bal_val = None
    if bal is not None:
        lo = max(ia, apex_i - 25)
        hi = min(ib, apex_i + 25)
        bal_val = float(np.mean(bal[lo:hi + 1]))
    return {
        "min_speed": round(float(np.min(spd[ia:ib + 1])), 1),
        "entry_speed": round(float(spd[ia]), 1),
        "apex_speed": round(float(spd[apex_i]), 1),
        "exit_speed": round(float(spd[ib]), 1),
        "throttle": round(float(np.mean(ch["thr"][ia:ib + 1])), 1),
        "brake": round(float(np.max(ch["brk"][ia:ib + 1])), 1),
        "gear": int(round(float(ch["gear"][apex_i]))),
        "balance": None if bal_val is None else round(bal_val, 3),
    }


def _events(lap: dict, corners: list[dict]) -> list[dict]:
    ch = lap["ch"]
    step = lap["step"]
    spd = np.maximum(np.asarray(ch["spd"], dtype=np.float64), 1.0)
    thr = np.asarray(ch["thr"], dtype=np.float64)
    brk = np.asarray(ch["brk"], dtype=np.float64)
    events: list[dict] = []

    def add(kind: str, label: str, severity: float, seg, detail: str, color: str):
        a, b, ia, ib = seg
        mid = (a + b) / 2.0
        corner = None
        best_d = 1e18
        for c in corners:
            if c["start"] - 40 <= mid <= c["end"] + 40:
                d = abs(mid - c["apex"])
                if d < best_d:
                    best_d = d
                    corner = c["name"]
        events.append({
            "type": kind,
            "label": label,
            "start": round(a, 1),
            "end": round(b, 1),
            "dist": round(mid, 1),
            "corner": corner,
            "severity": round(float(severity), 1),
            "detail": detail,
            "color": color,
        })

    wheels = ["FL", "FR", "RL", "RR"]
    ws = {w: np.asarray(ch["ws"][i], dtype=np.float64) for i, w in enumerate(wheels)}
    bsu = {w: np.asarray(ch["bs"][i], dtype=np.float64) for i, w in enumerate(wheels)}

    # --- lock ups (front and rear)
    for i, wheel in enumerate(wheels):
        axe = "front" if i < 2 else "rear"
        slip = 1.0 - ws[wheel] / spd
        mask = (slip > 0.13) & (brk > 30) & (spd > 55)
        for a, b, ia, ib in _segments(mask, step, gap_m=10, min_len_m=15):
            s = float(np.max(slip[ia:ib + 1] * brk[ia:ib + 1] / 100.0))
            add("lock", f"Блокировка {wheel}", s * 140,
                (a, b, ia, ib),
                f"{axe} {wheel}: проскальзывание {np.max(slip[ia:ib+1])*100:.0f}% при {np.max(brk[ia:ib+1]):.0f}% тормоза",
                "#ff5a4d")

    # --- wheel spin (rear axle)
    for wheel in ("RL", "RR"):
        spin = ws[wheel] / spd - 1.0
        mask = (spin > 0.25) & (thr > 50) & (spd > 20) & (spd < 210)
        for a, b, ia, ib in _segments(mask, step, gap_m=8, min_len_m=15):
            s = float(np.max(spin[ia:ib + 1]))
            add("spin", f"Пробуксовка {wheel}", s * 220,
                (a, b, ia, ib),
                f"{wheel}: колесо быстрее машины на {s*100:.0f}%",
                "#ffb020")

    # --- bump stops
    for axe, names in (("перед", ("FL", "FR")), ("зад", ("RL", "RR"))):
        flag = np.maximum(bsu[names[0]], bsu[names[1]])
        mask = flag > 0.5
        for a, b, ia, ib in _segments(mask, step, gap_m=14, min_len_m=20):
            add("bottom", f"Пробой ({axe})", (b - a) / max(step, 1),
                (a, b, ia, ib),
                f"Подвеска {axe} в отбойнике {(b-a):.0f} м",
                "#b78bff")

    # --- brake temperatures
    for axe, idxs in (("передние", (0, 1)), ("задние", (2, 3))):
        temp = np.maximum(np.asarray(ch["bt"][idxs[0]]), np.asarray(ch["bt"][idxs[1]]))
        mask = temp > (840 if axe == "передние" else 700)
        for a, b, ia, ib in _segments(mask, step, gap_m=20, min_len_m=25):
            add("brake_temp", f"Перегрев тормозов ({axe})", float(np.max(temp[ia:ib + 1])),
                (a, b, ia, ib),
                f"{axe} тормоза до {np.max(temp[ia:ib+1]):.0f} °C",
                "#ff8a3d")

    # --- coasting
    mask = (thr < 3.0) & (brk < 3.0) & (spd > 60)
    for a, b, ia, ib in _segments(mask, step, gap_m=18, min_len_m=45):
        add("coast", "Движение накатом", (b - a) / 100.0,
            (a, b, ia, ib),
            f"{(b-a):.0f} м без тяги и тормоза",
            "#7d8794")
    return events


def analyze_lap(log: Log, lap: Lap, corners: list[dict] | None = None,
                reference_t: np.ndarray | None = None) -> dict:
    """Distance-domain snapshot of one lap."""
    if not log.has("speed"):
        raise ValueError("В логе нет канала SPEED")

    srate = log.rates["speed"]
    ia = max(0, int(math.ceil(lap.start * srate)))
    ib = min(len(log.channels["speed"]), int(math.floor(lap.end * srate)) + 1)
    s = log.channels["speed"][ia:ib].astype(np.float64)
    t_src = np.arange(ia, ib, dtype=np.float64) / srate

    if len(s) < 10:
        return {}

    dist_src = np.concatenate(([0.0], np.cumsum((s[1:] + s[:-1]) * 0.5 / srate)))
    total = float(dist_src[-1])
    if total < 50:
        return {}

    grid = np.arange(0.0, total, GRID_STEP)
    # monotonic guard (a full stop produces duplicate distances)
    dist_src = np.maximum.accumulate(dist_src) + np.arange(len(dist_src)) * 1e-7
    t_grid = np.interp(grid, dist_src, t_src)
    t_grid += lap.start - t_grid[0]

    def sample(key: str) -> np.ndarray | None:
        if key not in log.channels:
            return None
        return _resample_time(log, key, t_grid)

    def arr(key: str, scale: float = 1.0, digits: int = 2):
        vals = sample(key)
        if vals is None:
            return None
        return np.round(vals.astype(np.float64) * scale, digits).tolist()

    speed_kmh = np.round(sample("speed") * 3.6, 1)
    throttle = np.round(sample("throttle"), 1)
    brake = np.round(sample("brake"), 1)
    steer = np.round(sample("steer") / 3.0, 1)  # roughly -100..100 %
    gear = np.round(sample("gear"), 0)
    rpm = np.round(sample("rpm"), 0)
    lat = np.round(sample("lat"), 2)
    lon = np.round(sample("lon"), 2)
    yaw = sample("yaw")

    ch_out = {
        "spd": speed_kmh.tolist(),
        "thr": throttle.tolist(),
        "brk": brake.tolist(),
        "str": steer.tolist(),
        "gear": gear.tolist(),
        "rpm": rpm.tolist(),
        "lat": lat.tolist(),
        "lon": lon.tolist(),
    }

    for group, prefix, scale, digits in (
        ("sus", "sus_", 1.0, 1),
        ("tp", "tp_", 1.0, 2),
        ("tt", "tt_", 1.0, 1),
        ("bt", "bt_", 1.0, 0),
        ("ws", "ws_", 3.6, 1),
        ("bs", "bsu_", 1.0, 0),
    ):
        wheels = ["fl", "fr", "rl", "rr"]
        ch_out[group] = []
        for w in wheels:
            vals = sample(prefix + w)
            if vals is None:
                vals = np.zeros_like(speed_kmh)
            ch_out[group].append(np.round(vals * scale, digits).tolist())

    # ---------------------------------------------------------------- path
    path_x, path_y = [], []
    if yaw is not None:
        dt = np.diff(t_grid, prepend=t_grid[0])
        dt[0] = 0.0
        heading = np.cumsum(yaw * dt)
        v_ms = speed_kmh / 3.6
        path_x = np.cumsum(v_ms * np.cos(heading) * dt)
        path_y = np.cumsum(v_ms * np.sin(heading) * dt)
        if not lap.partial and len(path_x) > 2:
            n = np.arange(len(path_x))
            path_x = path_x - (path_x[-1] - path_x[0]) * n / (len(path_x) - 1)
            path_y = path_y - (path_y[-1] - path_y[0]) * n / (len(path_x) - 1)
        path_x = np.round(path_x, 1).tolist()
        path_y = np.round(path_y, 1).tolist()

    # ---------------------------------------------------------------- balance
    k = _fit_balance(log, lap.start, lap.end)
    balance = None
    if yaw is not None and k:
        v = speed_kmh / 3.6
        expected = k * v * (steer * 3.0)
        balance = (yaw - expected) / (np.abs(yaw) + 0.07)

    if corners is None:
        corners = _detect_corners(lat, speed_kmh, GRID_STEP, total)

    lap_pack = {
        "ch": ch_out,
        "step": GRID_STEP,
        "n": len(grid),
        "distance": round(total, 1),
        "t": np.round(t_grid - lap.start, 3).tolist(),
        "_dist": grid,
        "_bal": balance,
    }
    corner_stats = [_corner_stats(lap_pack, c) for c in corners]
    events = _events(lap_pack, corners)

    # time loss at each corner vs reference
    if reference_t is not None:
        ref = np.interp(grid, np.arange(len(reference_t)) * GRID_STEP,
                        np.asarray(reference_t, dtype=np.float64))
        delta = (t_grid - lap.start) - ref
        for c, stat in zip(corners, corner_stats):
            i0 = min(len(delta) - 1, max(0, int(c["start"] / GRID_STEP)))
            i1 = min(len(delta) - 1, max(i0, int(c["end"] / GRID_STEP)))
            stat["loss"] = round(float(delta[i1] - delta[i0]), 3)
            d = delta[i0:i1 + 1]
            stat["delta_end"] = round(float(delta[i1]), 3)
        delta_out = np.round(delta, 3).tolist()
    else:
        delta_out = None

    return {
        "index": lap.index,
        "time": round(lap.time, 3),
        "distance": round(total, 1),
        "valid": lap.valid,
        "partial": lap.partial,
        "tags": lap.tags,
        "step": GRID_STEP,
        "n": len(grid),
        "ch": ch_out,
        "t": np.round(t_grid - lap.start, 3).tolist(),
        "path": {"x": path_x, "y": path_y},
        "events": events,
        "corners": [dict(c, **st) for c, st in zip(corners, corner_stats) if st],
        "delta": delta_out,
    }


def session_corners(best_lap_pack: dict) -> list[dict]:
    return _detect_corners(best_lap_pack["ch"]["lat"],
                           best_lap_pack["ch"]["spd"],
                           best_lap_pack["step"],
                           best_lap_pack["distance"])


# ---------------------------------------------------------------- driver report


def _baseline(reference: np.ndarray, length: int) -> np.ndarray:
    if len(reference) >= length:
        return reference[:length]
    return np.pad(reference, (0, length - len(reference)), mode="edge")


def summarize_laps(laps: list[dict], ref: dict | None = None) -> dict:
    """Aggregate lap snapshots into a driver/session report."""
    valid = [l for l in laps if l.get("valid") and l.get("time", 0) > 0]
    clean_laps = len(valid)
    clean = clean_laps > 0
    if not valid:
        valid = [l for l in laps if l.get("time", 0) > 0]
    if not valid:
        return {"empty": True}

    times = np.array([l["time"] for l in valid], dtype=np.float64)
    best = valid[int(np.argmin(times))]
    ref = ref or best

    # per lap corner losses relative to the reference lap
    ref_t = np.asarray(ref["t"], dtype=np.float64)
    ref_idx = ref.get("index")
    for l in valid:
        if l.get("index") == ref_idx:
            continue
        rt = _baseline(ref_t, len(l["t"]))
        delta = np.asarray(l["t"]) - rt
        for c in l["corners"]:
            i0 = min(len(delta) - 1, max(0, int(c["start"] / l["step"])))
            i1 = min(len(delta) - 1, max(i0, int(c["end"] / l["step"])))
            c["loss_ref"] = round(float(delta[i1] - delta[i0]), 3)

    # event aggregation
    ev_types = {
        "lock": ("Блокировки", 7.0),
        "spin": ("Пробуксовки", 5.0),
        "bottom": ("Пробои подвески", 2.0),
        "brake_temp": ("Перегрев тормозов", 3.5),
        "coast": ("Накат", 1.2),
    }
    agg = {k: {"count": 0, "corners": {}, "severity": 0.0} for k in ev_types}
    for l in valid:
        for e in l["events"]:
            a = agg.setdefault(e["type"], {"count": 0, "corners": {}, "severity": 0.0})
            a["count"] += 1
            a["severity"] += abs(e.get("severity", 0))
            if e.get("corner"):
                a["corners"][e["corner"]] = a["corners"].get(e["corner"], 0) + 1

    km = sum(l["distance"] for l in valid) / 1000.0
    per_km = {k: (v["count"] / km if km else 0) for k, v in agg.items()}
    technique = 100.0
    for k, (_, weight) in ev_types.items():
        technique -= per_km.get(k, 0) * weight
    technique = float(np.clip(technique, 5, 100))

    # Trim the slowest 20% (traffic, mistakes) before measuring consistency
    core = np.sort(times)[:max(3, int(np.ceil(len(times) * 0.8)))] if len(times) > 4 else times
    std = float(np.std(core)) if len(core) > 1 else 0.0
    consistency = float(np.clip(100.0 - (std / max(float(np.mean(core)), 1e-6)) * 100 * 6.5, 0, 100))
    # first-lap warmup inflates the spread: compare to best-5 average
    best5 = float(np.mean(np.sort(times)[:min(5, len(times))]))
    potential = best5 - float(np.min(times))

    coast_time = 0.0
    for l in valid:
        t = np.asarray(l["t"])
        dt = np.diff(t, prepend=t[0])
        thr = np.asarray(l["ch"]["thr"])
        brk = np.asarray(l["ch"]["brk"])
        spd = np.asarray(l["ch"]["spd"])
        coast_time += float(np.sum(dt[(thr < 3) & (brk < 3) & (spd > 60)]))
    total_time = float(np.sum(times))
    coast_pct = coast_time / max(total_time, 1e-6) * 100

    # pressures / temps / brake temps
    def wheel_avg(group: str, w: int, key: str, pct=None):
        vals = []
        for l in valid:
            a = np.asarray(l["ch"][group][w], dtype=np.float64)
            if key == "press":
                # discard the first 20% of the lap (cold tyres)
                a = a[int(len(a) * 0.2):]
            vals.append(a)
        allv = np.concatenate(vals) if vals else np.array([0.0])
        return round(float(np.mean(allv)) if pct is None else float(np.percentile(allv, pct)), 2)

    pressures = [wheel_avg("tp", i, "press") for i in range(4)]
    tyre_temps = [wheel_avg("tt", i, "temp") for i in range(4)]
    brake_temps = [wheel_avg("bt", i, "temp", 95) for i in range(4)]

    brake_g = []
    lat_g = []
    for l in valid:
        brake_g.append(float(np.percentile(np.abs(np.asarray(l["ch"]["lon"])), 99)))
        lat_g.append(float(np.percentile(np.abs(np.asarray(l["ch"]["lat"])), 99)))

    # balance by phase, averaged over corners
    balances = [c.get("balance") for l in valid for c in l["corners"] if c.get("balance") is not None]
    balance = float(np.mean(balances)) if balances else None

    # top corner losses
    loss_by_corner: dict[str, list[float]] = {}
    for l in valid:
        for c in l["corners"]:
            if "loss_ref" in c:
                loss_by_corner.setdefault(c["name"], []).append(c["loss_ref"])
    corner_loss = []
    for name, vals in loss_by_corner.items():
        corner_loss.append({"name": name, "loss": round(float(np.mean(vals)), 3),
                            "laps": len(vals)})
    corner_loss.sort(key=lambda x: x["loss"], reverse=True)

    lock_corners = sorted(agg.get("lock", {}).get("corners", {}).items(),
                          key=lambda kv: kv[1], reverse=True)[:5]
    spin_corners = sorted(agg.get("spin", {}).get("corners", {}).items(),
                          key=lambda kv: kv[1], reverse=True)[:5]

    # scores
    braking = float(np.clip(np.mean(brake_g) / 1.55 * 100, 0, 100)) if brake_g else 0
    traction = float(np.clip(100 - per_km.get("spin", 0) * 9, 0, 100))
    balance_score = float(np.clip(100 - abs(balance or 0) * 160, 0, 100))
    smooth = float(np.clip(100 - coast_pct * 4.5, 0, 100))

    pace = 100.0
    if ref and ref.get("time"):
        pace = float(np.clip(100 - (float(np.min(times)) - float(ref["time"])) / float(ref["time"]) * 3000, 0, 100))

    score = float(np.clip(
        technique * 0.28 + consistency * 0.18 + braking * 0.14 +
        traction * 0.14 + balance_score * 0.12 + smooth * 0.09 + pace * 0.05,
        0, 100))

    return {
        "empty": False,
        "laps": len(valid),
        "clean_laps": clean_laps,
        "clean": clean,
        "km": round(km, 1),
        "best": round(float(np.min(times)), 3),
        "average": round(float(np.mean(times)), 3),
        "std": round(std, 3),
        "best5": round(best5, 3),
        "potential": round(potential, 3),
        "consistency": round(consistency, 1),
        "coast_pct": round(coast_pct, 1),
        "technique": round(technique, 1),
        "braking": round(braking, 1),
        "traction": round(traction, 1),
        "balance": None if balance is None else round(balance, 3),
        "balance_score": round(balance_score, 1),
        "smooth": round(smooth, 1),
        "pace": round(pace, 1),
        "score": round(score, 1),
        "pressures": pressures,
        "tyre_temps": tyre_temps,
        "brake_temps": brake_temps,
        "events": {
            "lock": {"count": agg["lock"]["count"],
                     "corners": [{"name": n, "count": c} for n, c in lock_corners]},
            "spin": {"count": agg["spin"]["count"],
                     "corners": [{"name": n, "count": c} for n, c in spin_corners]},
            "bottom": {"count": agg["bottom"]["count"]},
            "brake_temp": {"count": agg["brake_temp"]["count"]},
            "coast": {"count": agg["coast"]["count"]},
        },
        "corner_loss": corner_loss,
        "top_speed": round(float(np.max([np.max(l["ch"]["spd"]) for l in valid])), 1),
        "throttle_pct": round(float(np.mean([np.mean(np.asarray(l["ch"]["thr"]) > 95) for l in valid])) * 100, 1),
    }
