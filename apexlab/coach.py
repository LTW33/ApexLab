"""Beta coaching layer.

Three ideas live here and stay out of the release channel:

* reference logs (fast drivers) -> a learned target profile per track/car;
* session series -> logs recorded within a short window are analysed as one
  stint instead of single laps;
* a plain-language race-engineer style debrief built strictly from numbers we
  already have (no cloud, no guesswork).

The module only reads the cached lap packs produced by :mod:`session`, so it
never changes the cache schema.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from statistics import mean, median

import numpy as np

import session as store

SERIES_GAP_MINUTES = 90
MAX_SERIES_SESSIONS = 10
MAX_SERIES_LAPS_PER_SESSION = 6

PHASE_LABELS = {
    "entry": "на входе",
    "apex": "в апексе",
    "exit": "на выходе",
}

CORNER_TYPES = {
    "slow": "медленный",
    "medium": "среднескоростной",
    "fast": "скоростной",
}

CORNER_TYPES_PLURAL = {
    "slow": "медленных",
    "medium": "среднескоростных",
    "fast": "скоростных",
}


# ------------------------------------------------------------------ helpers


def parse_datetime(s: dict) -> datetime | None:
    """ACC writes dates as dd/mm/yyyy or yyyy.mm.dd; accept both."""
    raw_date = str(s.get("date") or "").strip()
    raw_time = str(s.get("time") or "").strip()
    m = raw_date.replace(".", "/").replace("-", "/").split("/")
    if len(m) != 3:
        return None
    try:
        if len(m[0]) == 4:
            year, month, day = int(m[0]), int(m[1]), int(m[2])
        else:
            day, month, year = int(m[0]), int(m[1]), int(m[2])
            if year < 100:
                year += 2000
    except ValueError:
        return None
    t = raw_time.split(":")
    try:
        hh = int(t[0]) if len(t) > 0 else 0
        mm = int(t[1]) if len(t) > 1 else 0
        ss = int(t[2]) if len(t) > 2 else 0
        return datetime(year, month, day, hh, mm, ss)
    except (ValueError, IndexError):
        return None


def _iso(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


def _round(value, digits=3):
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(value):
        return None
    return round(value, digits)


def _num(value, default=0.0) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    return value if np.isfinite(value) else default


def _mean(values, digits=1):
    values = [v for v in values if v is not None and np.isfinite(float(v))]
    return _round(mean(values), digits) if values else None


def _delta(value) -> str:
    v = _num(value)
    if abs(v) < 0.0005:
        return "±0.000"
    return f"{v:+.3f}"


def _secs(value, digits=3) -> str:
    v = _num(value)
    if v <= 0:
        return "—"
    m = int(v // 60)
    rest = v - m * 60
    return f"{m}:{rest:0{digits + 3}.{digits}f}" if m else f"{rest:.{digits}f}"


def _plural(n, one, few, many) -> str:
    n = abs(int(n)) % 100
    last = n % 10
    if 10 < n < 20:
        return many
    if 1 < last < 5:
        return few
    if last == 1:
        return one
    return many


def _driver(s: dict) -> str:
    return (s.get("driver") or "Пилот").strip() or "Пилот"


def _track_key(s: dict) -> str:
    return (s.get("track_id") or s.get("track") or "").strip().lower().replace(" ", "_")


def _car_key(s: dict) -> str:
    return (s.get("car_id") or s.get("car") or "").strip().lower().replace(" ", "_")


def _session_key(s: dict) -> str:
    return f"{_track_key(s)}|{_car_key(s)}|{_driver(s)}"


def _clean_laps(meta: dict) -> list[dict]:
    laps = [l for l in (meta.get("laps") or []) if l.get("valid") and _num(l.get("time")) > 0]
    return laps or [l for l in (meta.get("laps") or []) if _num(l.get("time")) > 0]


def _best_lap(meta: dict) -> dict | None:
    laps = _clean_laps(meta)
    if not laps:
        return None
    best_index = meta.get("best_index")
    for lap in laps:
        if lap.get("index") == best_index:
            return lap
    return min(laps, key=lambda l: _num(l.get("time")))


# --------------------------------------------------------------- grouping


def group_sessions(sessions: list[dict], gap_minutes: int = SERIES_GAP_MINUTES) -> list[dict]:
    """Group logs of one track/car/driver recorded within ``gap_minutes``.

    A series is how a real test day looks: several MoTeC exports, one after
    another, sometimes crossing midnight.  The grouping is deliberately
    conservative: only gaps <= 90 minutes and the same driver join a series.
    """
    mine = [s for s in sessions if not s.get("reference")]
    buckets: dict[str, list[tuple[datetime, dict]]] = {}
    for s in mine:
        dt = parse_datetime(s)
        if not dt:
            continue
        buckets.setdefault(_session_key(s), []).append((dt, s))

    out = []
    for key, rows in buckets.items():
        rows.sort(key=lambda item: item[0])
        chunk: list[tuple[datetime, dict]] = []
        for dt, s in rows:
            if chunk and dt - chunk[-1][0] > timedelta(minutes=gap_minutes):
                out.extend(_series_from_chunk(chunk))
                chunk = []
            chunk.append((dt, s))
        out.extend(_series_from_chunk(chunk))

    out.sort(key=lambda g: g["start"], reverse=True)
    return [g for g in out if g["count"] >= 2]


def _series_from_chunk(chunk: list[tuple[datetime, dict]]) -> list[dict]:
    if not chunk:
        return []
    first_dt, first = chunk[0]
    last_dt, _ = chunk[-1]
    sessions = [s for _, s in chunk]
    laps = sum(len(s.get("laps") or []) for s in sessions)
    clean = sum(int(s.get("clean_laps") or 0) for s in sessions)
    scored = [s for s in sessions if (s.get("report") or {}).get("clean")]
    score = _mean([(s.get("report") or {}).get("score") for s in scored], 1)
    best = min((s for s in sessions if s.get("best_time")),
               key=lambda s: _num(s.get("best_time")), default=None)
    token = f"{_session_key(first)}|{_iso(first_dt)}|{first.get('id')}"
    gid = "s_" + hashlib.sha1(token.encode("utf-8")).hexdigest()[:10]
    return [{
        "id": gid,
        "track_id": _track_key(first),
        "track": first.get("track") or "",
        "car_id": _car_key(first),
        "car": first.get("car") or "",
        "driver": _driver(first),
        "start": _iso(first_dt),
        "end": _iso(last_dt),
        "span_minutes": int(round((last_dt - first_dt).total_seconds() / 60)),
        "sessions": [s["id"] for s in sessions],
        "count": len(sessions),
        "laps": laps,
        "clean_laps": clean,
        "best": _round(best.get("best_time"), 3) if best else None,
        "best_session": best.get("id") if best else None,
        "average": _mean([(s.get("report") or {}).get("average") for s in scored], 2),
        "score": score,
    }]


def series_for(session_id: str, sessions: list[dict] | None = None) -> dict | None:
    sessions = sessions if sessions is not None else store.load_library().get("sessions", [])
    rows = [s for s in sessions if session_id in (s.get("id"),)]
    if not rows:
        return None
    target = rows[0]
    for group in group_sessions(sessions):
        if session_id in group["sessions"]:
            return group
    # a lone session is still a series of one so the UI has something to show
    dt = parse_datetime(target)
    one = _series_from_chunk([(dt, target)]) if dt else []
    return one[0] if one else None


# ---------------------------------------------------------- lap mechanics


def _sample(t: list, step: float, distance: float) -> float | None:
    if not t:
        return None
    idx = distance / max(step, 1e-6)
    arr = np.asarray(t, dtype=np.float64)
    return float(np.interp(idx, np.arange(len(arr)), arr))


def _corner_type(min_speed: float) -> str:
    if min_speed < 85:
        return "slow"
    if min_speed < 145:
        return "medium"
    return "fast"


def _corner_label(name: str, kind: str, direction: str) -> str:
    pieces = [name]
    if kind:
        pieces.append(CORNER_TYPES[kind])
    if direction:
        pieces.append(direction)
    return " · ".join(pieces)


def _corner_mechanics(pack: dict, corner: dict) -> dict:
    """Phase detail that the cached corner stats do not contain."""
    step = _num(pack.get("step"), 5.0) or 5.0
    ch = pack.get("ch") or {}
    spd = np.asarray(ch.get("spd") or [], dtype=np.float64)
    thr = np.asarray(ch.get("thr") or [], dtype=np.float64)
    brk = np.asarray(ch.get("brk") or [], dtype=np.float64)
    steer = np.asarray(ch.get("str") or [], dtype=np.float64)
    lat = np.asarray(ch.get("lat") or [], dtype=np.float64)
    n = min(len(spd), len(thr), len(brk), len(steer), len(lat))
    if not n:
        return {}
    spd, thr, brk, steer, lat = spd[:n], thr[:n], brk[:n], steer[:n], lat[:n]
    start = max(0, int(_num(corner.get("start")) / step))
    end = min(n - 1, int(_num(corner.get("end")) / step))
    apex = min(end, max(start, int(_num(corner.get("apex")) / step)))
    if end <= start:
        return {}

    # braking point: first 5%+ brake application in the 100 m before the apex.
    look = max(0, int((_num(corner.get("start")) - 100) / step))
    brake_i = None
    for i in range(look, apex + 1):
        if brk[i] >= 5:
            brake_i = i
            break
    # throttle pickup: first 95% after the apex inside the corner + 80 m.
    tail = min(n - 1, end + int(80 / step))
    thr_i = None
    for i in range(apex, tail + 1):
        if thr[i] >= 95:
            thr_i = i
            break
    thr10 = None
    for i in range(apex, tail + 1):
        if thr[i] >= 10:
            thr10 = i
            break
    thr95 = thr_i
    steps = 0
    if thr10 is not None and thr95 is not None and thr95 > thr10:
        seg = thr[thr10:thr95 + 1]
        drops = np.diff(seg)
        steps = int(np.sum(drops < -12))
    coast = 0
    for i in range(start, min(n, end + int(50 / step))):
        if thr[i] < 3 and brk[i] < 3 and spd[i] > 60:
            coast += 1

    apex_slice = slice(max(start, apex - 6), min(n, apex + 7))
    lat_here = float(np.mean(lat[apex_slice])) if n else 0.0
    direction = "правый" if lat_here < 0 else "левый" if lat_here > 0 else ""
    min_speed = float(np.min(spd[start:end + 1]))
    kind = _corner_type(min_speed)
    return {
        "brake_m": round((brake_i - apex) * step, 1) if brake_i is not None else None,
        "throttle_m": round((thr_i - apex) * step, 1) if thr_i is not None else None,
        "throttle_ramp_m": round((thr95 - thr10) * step, 1) if thr10 is not None and thr95 is not None else None,
        "throttle_steps": steps,
        "coast_m": round(coast * step, 1),
        "steer_corrections": int(np.sum(np.abs(np.diff(steer[start:end + 1])) > 4.0)) if end > start else 0,
        "direction": direction,
        "type": kind,
        "label": _corner_label(str(corner.get("name") or "T?"), kind, direction),
        "lat": round(lat_here, 2),
    }


def _speed_at(pack: dict, distance: float) -> float:
    step = _num(pack.get("step"), 5.0) or 5.0
    spd = np.asarray((pack.get("ch") or {}).get("spd") or [], dtype=np.float64)
    if not len(spd):
        return 0.0
    return float(np.interp(distance / step, np.arange(len(spd)), spd))


def _segment_stats(pack: dict, corner: dict) -> dict:
    """Stats at the canonical corner boundaries, whatever corners this pack detected.

    Corner detection can merge or skip a kink between two sessions, so matching
    by corner name is unsafe: T2 in one log is not T2 in another.  We always
    sample the reference window instead.
    """
    step = _num(pack.get("step"), 5.0) or 5.0
    spd = np.asarray((pack.get("ch") or {}).get("spd") or [], dtype=np.float64)
    gear = np.asarray((pack.get("ch") or {}).get("gear") or [], dtype=np.float64)
    if not len(spd):
        return {}
    start = _num(corner.get("start"))
    end = _num(corner.get("end"))
    apex = _num(corner.get("apex"))
    i0 = max(0, int(start / step))
    i1 = min(len(spd) - 1, int(end / step))
    ia = min(len(spd) - 1, max(0, int(apex / step)))
    return {
        "entry": round(_speed_at(pack, start), 1),
        "apex": round(_speed_at(pack, apex), 1),
        "exit": round(_speed_at(pack, end), 1),
        "min": round(float(np.min(spd[i0:i1 + 1])) if i1 >= i0 else 0.0, 1),
        "gear": int(round(float(np.interp(apex / step, np.arange(len(gear)), gear)))) if len(gear) else None,
    }


def _corner_comparison(user: dict, ref: dict, corner: dict) -> dict:
    step = _num(ref.get("step"), 5.0) or 5.0
    start = _num(corner.get("start"))
    end = _num(corner.get("end"))
    du0 = _sample(user.get("t"), step, start)
    du1 = _sample(user.get("t"), step, end)
    dr0 = _sample(ref.get("t"), step, start)
    dr1 = _sample(ref.get("t"), step, end)
    loss = None if None in (du0, du1, dr0, dr1) else (du1 - du0) - (dr1 - dr0)

    ref_mech = _corner_mechanics(ref, corner)
    you_mech = _corner_mechanics(user, corner)
    you = _segment_stats(user, corner)
    ref_stats = _segment_stats(ref, corner)

    phases = {
        "entry": (_num(you.get("entry")) - _num(ref_stats.get("entry"))),
        "apex": (_num(you.get("apex")) - _num(ref_stats.get("apex"))),
        "exit": (_num(you.get("exit")) - _num(ref_stats.get("exit"))),
    }
    worst_phase = min(phases, key=phases.get) if phases else "apex"
    if abs(loss or 0) < 0.02:
        verdict = "ровно"
    elif (loss or 0) > 0:
        verdict = "медленнее"
    else:
        verdict = "быстрее"

    return {
        "name": corner.get("name"),
        "label": ref_mech.get("label") or _corner_label(str(corner.get("name") or "T?"), ref_mech.get("type"), ""),
        "start": start,
        "end": end,
        "apex": _num(corner.get("apex")),
        "type": ref_mech.get("type"),
        "direction": ref_mech.get("direction"),
        "loss": _round(loss, 3),
        "verdict": verdict,
        "worst_phase": worst_phase,
        "phase_label": PHASE_LABELS.get(worst_phase, worst_phase),
        "speed_delta": round(phases[worst_phase], 1) if phases else None,
        "phases": {k: round(v, 1) for k, v in phases.items()},
        "ref": {
            "entry": _round(ref_stats.get("entry"), 1),
            "apex": _round(ref_stats.get("apex"), 1),
            "exit": _round(ref_stats.get("exit"), 1),
            "min": _round(ref_stats.get("min"), 1),
            "gear": ref_stats.get("gear"),
            "brake_m": ref_mech.get("brake_m"),
            "throttle_m": ref_mech.get("throttle_m"),
            "throttle_ramp_m": ref_mech.get("throttle_ramp_m"),
            "throttle_steps": ref_mech.get("throttle_steps"),
            "coast_m": ref_mech.get("coast_m"),
            "steer_corrections": ref_mech.get("steer_corrections"),
        },
        "you": {
            "entry": _round(you.get("entry"), 1),
            "apex": _round(you.get("apex"), 1),
            "exit": _round(you.get("exit"), 1),
            "min": _round(you.get("min"), 1),
            "gear": you.get("gear"),
            "brake_m": you_mech.get("brake_m"),
            "throttle_m": you_mech.get("throttle_m"),
            "throttle_ramp_m": you_mech.get("throttle_ramp_m"),
            "throttle_steps": you_mech.get("throttle_steps"),
            "coast_m": you_mech.get("coast_m"),
            "steer_corrections": you_mech.get("steer_corrections"),
        },
    }


def _sectors(user: dict, ref: dict, count: int = 6) -> list[dict]:
    distance = min(_num(user.get("distance")), _num(ref.get("distance")))
    if distance < 100:
        return []
    step = _num(ref.get("step"), 5.0) or 5.0
    out = []
    for i in range(count):
        a = distance * i / count
        b = distance * (i + 1) / count
        ua, ub = _sample(user.get("t"), step, a), _sample(user.get("t"), step, b)
        ra, rb = _sample(ref.get("t"), step, a), _sample(ref.get("t"), step, b)
        if None in (ua, ub, ra, rb):
            continue
        out.append({
            "from": round(a), "to": round(b),
            "loss": round((ub - ua) - (rb - ra), 3),
        })
    return out


def _style(user: dict, ref: dict, corners: list[dict]) -> dict:
    def agg(key, side):
        vals = [c[side].get(key) for c in corners if c[side].get(key) is not None]
        return _mean(vals, 1)

    return {
        "throttle_m": agg("throttle_m", "you"),
        "ref_throttle_m": agg("throttle_m", "ref"),
        "throttle_ramp_m": agg("throttle_ramp_m", "you"),
        "ref_throttle_ramp_m": agg("throttle_ramp_m", "ref"),
        "throttle_steps": agg("throttle_steps", "you"),
        "ref_throttle_steps": agg("throttle_steps", "ref"),
        "brake_m": agg("brake_m", "you"),
        "ref_brake_m": agg("brake_m", "ref"),
        "coast_m": agg("coast_m", "you"),
        "ref_coast_m": agg("coast_m", "ref"),
        "steer_corrections": agg("steer_corrections", "you"),
        "ref_steer_corrections": agg("steer_corrections", "ref"),
    }


# ------------------------------------------------------------- comparison


def compare_to_reference(meta: dict, ref_meta: dict) -> dict | None:
    user_lap = _best_lap(meta)
    ref_lap = _best_lap(ref_meta)
    if not user_lap or not ref_lap:
        return None
    user_pack = store.load_lap(meta["id"], user_lap["index"])
    ref_pack = store.load_lap(ref_meta["id"], ref_lap["index"])
    if not user_pack or not ref_pack:
        return None
    if not ref_pack.get("corners"):
        return None

    user_dist = _num(user_pack.get("distance"))
    ref_dist = _num(ref_pack.get("distance"))
    aligned = abs(user_dist - ref_dist) <= max(60.0, ref_dist * 0.03)

    corners = []
    for corner in ref_pack.get("corners") or []:
        corners.append(_corner_comparison(user_pack, ref_pack, corner))

    valid = [c for c in corners if c.get("loss") is not None]
    losses = sorted([c for c in valid if (c["loss"] or 0) > 0.005],
                    key=lambda c: c["loss"], reverse=True)
    gains = sorted([c for c in valid if (c["loss"] or 0) < -0.005],
                   key=lambda c: c["loss"])

    by_type = {}
    for kind in ("slow", "medium", "fast"):
        rows = [c for c in valid if c.get("type") == kind]
        by_type[kind] = {
            "count": len(rows),
            "loss": _round(sum((c.get("loss") or 0) for c in rows), 3) if rows else None,
            "speed": _mean([c["you"].get("apex") for c in rows], 1),
            "ref_speed": _mean([c["ref"].get("apex") for c in rows], 1),
        }

    style = _style(user_pack, ref_pack, corners)
    user_rep = meta.get("report") or {}
    ref_rep = ref_meta.get("report") or {}
    return {
        "reference": {
            "session": ref_meta["id"],
            "driver": _driver(ref_meta),
            "track": ref_meta.get("track"),
            "car": ref_meta.get("car"),
            "date": ref_meta.get("date"),
            "time": ref_meta.get("time"),
            "best": _round(ref_lap.get("time"), 3),
            "lap": ref_lap.get("index"),
        },
        "you": {
            "session": meta["id"],
            "driver": _driver(meta),
            "best": _round(user_lap.get("time"), 3),
            "lap": user_lap.get("index"),
        },
        "delta": _round(_num(user_lap.get("time")) - _num(ref_lap.get("time")), 3),
        "aligned": aligned,
        "distance_delta": round(user_dist - ref_dist, 1),
        "corners": corners,
        "losses": losses[:6],
        "gains": gains[:4],
        "loss_total": _round(sum((c["loss"] or 0) for c in losses), 3),
        "gain_total": _round(sum((c["loss"] or 0) for c in gains), 3),
        "by_type": by_type,
        "style": style,
        "sectors": _sectors(user_pack, ref_pack),
        "speed": {
            "you": _round(user_rep.get("top_speed"), 1),
            "ref": _round(ref_rep.get("top_speed"), 1),
            "you_throttle": _round(user_rep.get("throttle_pct"), 1),
            "ref_throttle": _round(ref_rep.get("throttle_pct"), 1),
        },
    }


# ---------------------------------------------------------------- learning


def _reference_sessions(sessions: list[dict]) -> list[dict]:
    return [s for s in sessions if s.get("reference")]


def _learning_fingerprint(refs: list[dict]) -> str:
    parts = [f"{s.get('id')}:{s.get('built') or s.get('imported') or ''}" for s in refs]
    return hashlib.sha1("|".join(sorted(parts)).encode("utf-8")).hexdigest()[:16]


def _aggregate_profile(track_key: str, car_key: str, refs: list[dict]) -> dict:
    # Canonical corners: the fastest clean reference lap on this track/car.
    fastest = min(refs, key=lambda s: _num(s.get("best_time"), 9e9))
    fastest_lap = _best_lap(fastest)
    canonical_pack = store.load_lap(fastest["id"], fastest_lap["index"]) if fastest_lap else None
    if not canonical_pack or not canonical_pack.get("corners"):
        return {}
    corners = canonical_pack["corners"]
    bucket: dict[str, dict] = {
        str(c.get("name")): {"name": c.get("name"), "start": c.get("start"),
                             "end": c.get("end"), "apex": c.get("apex"),
                             "entry": [], "apex_speed": [], "exit": [], "min": [],
                             "brake": [], "throttle": [], "gear": []}
        for c in corners
    }
    used_sessions: set[str] = set()
    drivers: set[str] = set()
    for ref in refs:
        used_sessions.add(ref.get("id", ""))
        drivers.add(_driver(ref))
        laps = sorted(_clean_laps(ref), key=lambda l: _num(l.get("time")))[:4]
        for lap in laps:
            pack = store.load_lap(ref["id"], lap["index"])
            if not pack:
                continue
            for corner in corners:
                stats = _segment_stats(pack, corner)
                if not stats:
                    continue
                mech = _corner_mechanics(pack, corner)
                item = bucket[str(corner.get("name"))]
                item["entry"].append(_num(stats.get("entry")))
                item["apex_speed"].append(_num(stats.get("apex")))
                item["exit"].append(_num(stats.get("exit")))
                item["min"].append(_num(stats.get("min")))
                if mech.get("brake_m") is not None:
                    item["brake"].append(_num(mech.get("brake_m")))
                if mech.get("throttle_m") is not None:
                    item["throttle"].append(_num(mech.get("throttle_m")))
                item["gear"].append(_num(stats.get("gear")))
    targets = []
    for name, item in bucket.items():
        if not item["apex_speed"]:
            continue
        first = next((c for c in corners if str(c.get("name")) == name), {})
        mech = _corner_mechanics(canonical_pack, first)
        targets.append({
            "name": name,
            "label": mech.get("label") or name,
            "start": first.get("start"),
            "end": first.get("end"),
            "apex": first.get("apex"),
            "entry": _mean(item["entry"], 1),
            "min": _mean(item["min"], 1),
            "apex_speed": _mean(item["apex_speed"], 1),
            "exit": _mean(item["exit"], 1),
            "brake_m": _mean(item["brake"], 1),
            "throttle_m": _mean(item["throttle"], 1),
            "gear": int(round(median(item["gear"]))) if item["gear"] else None,
            "n": len(item["apex_speed"]),
        })
    best = min(refs, key=lambda s: _num(s.get("best_time"), 9e9))
    return {
        "track_id": track_key,
        "car_id": car_key,
        "track": best.get("track"),
        "car": best.get("car"),
        "target": _round(best.get("best_time"), 3),
        "sources": sorted(d for d in drivers if d),
        "sessions": sorted(s for s in used_sessions if s),
        "targets": targets,
        "updated": _iso(datetime.now()),
    }


def rebuild_learning(lib: dict | None = None, save: bool = True) -> dict:
    lib = lib if lib is not None else store.load_library()
    refs = _reference_sessions(lib.get("sessions", []))
    profiles = {}
    by: dict[tuple[str, str], list[dict]] = {}
    for ref in refs:
        by.setdefault((_track_key(ref), _car_key(ref)), []).append(ref)
    for (track, car), rows in by.items():
        profile = _aggregate_profile(track, car, rows)
        if profile:
            profiles[f"{track}|{car}"] = profile
    learning = {
        "source": _learning_fingerprint(refs),
        "updated": _iso(datetime.now()),
        "profiles": profiles,
    }
    lib["learning"] = learning
    if save:
        store.save_library(lib)
    return learning


def ensure_learning(lib: dict | None = None) -> dict:
    lib = lib if lib is not None else store.load_library()
    refs = _reference_sessions(lib.get("sessions", []))
    current = lib.get("learning") or {}
    if current.get("source") != _learning_fingerprint(refs):
        return rebuild_learning(lib)
    return current


def profile_for(meta: dict, lib: dict | None = None) -> dict | None:
    learning = ensure_learning(lib)
    return (learning.get("profiles") or {}).get(f"{_track_key(meta)}|{_car_key(meta)}")


def reference_candidates(meta: dict, sessions: list[dict]) -> list[dict]:
    track = _track_key(meta)
    car = _car_key(meta)
    refs = [s for s in sessions if s.get("reference")]
    same = [s for s in refs if _track_key(s) == track and _car_key(s) == car]
    if same:
        return sorted(same, key=lambda s: _num(s.get("best_time"), 9e9))
    return sorted([s for s in refs if _track_key(s) == track],
                  key=lambda s: _num(s.get("best_time"), 9e9))


# ------------------------------------------------------------------- series


def _series_laps(meta: dict) -> list[dict]:
    return sorted(_clean_laps(meta), key=lambda l: _num(l.get("time")))


def series_detail(session_id: str, sessions: list[dict] | None = None) -> dict | None:
    sessions = sessions if sessions is not None else store.load_library().get("sessions", [])
    group = series_for(session_id, sessions)
    if not group:
        return None
    rows = [s for s in sessions if s["id"] in group["sessions"]]
    rows.sort(key=lambda s: (parse_datetime(s) or datetime.min))
    ref_row = next((s for s in rows if s["id"] == group.get("best_session")), rows[0] if rows else None)
    ref_lap = _best_lap(ref_row) if ref_row else None
    ref_pack = store.load_lap(ref_row["id"], ref_lap["index"]) if ref_row and ref_lap else None
    canonical = (ref_pack or {}).get("corners") or []
    total = min(_num(ref_pack.get("distance"), 0), 9e9) if ref_pack else 0

    session_rows = []
    run = []
    corner_cells: dict[str, dict[str, list]] = {
        str(c.get("name")): {"name": c.get("name"), "name_label": str(c.get("name")),
                             "start": c.get("start"), "apex": c.get("apex"),
                             "end": c.get("end"), "loss": {}, "apex_speed": {}}
        for c in canonical
    }
    for s in rows:
        laps = _series_laps(s)
        best_lap = laps[0] if laps else None
        rep = s.get("report") or {}
        session_rows.append({
            "id": s["id"],
            "date": s.get("date"),
            "time": s.get("time"),
            "best": _round(best_lap.get("time"), 3) if best_lap else None,
            "average": _round(rep.get("average"), 3),
            "clean_laps": int(s.get("clean_laps") or 0),
            "laps": len(s.get("laps") or []),
            "score": _round(rep.get("score"), 1),
            "consistency": _round(rep.get("consistency"), 1),
            "pressures": rep.get("pressures"),
            "balance": rep.get("balance"),
            "top_speed": _round(rep.get("top_speed"), 1),
            "throttle_pct": _round(rep.get("throttle_pct"), 1),
        })
        for lap in laps[:MAX_SERIES_LAPS_PER_SESSION]:
            run.append({
                "session": s["id"],
                "date": s.get("date"),
                "time": s.get("time"),
                "index": lap.get("index"),
                "time": _round(lap.get("time"), 3),
                "delta": _round(_num(lap.get("time")) - _num(group.get("best")), 3),
            })
            if not canonical or not ref_pack:
                continue
            pack = store.load_lap(s["id"], lap["index"])
            if not pack:
                continue
            step = _num(pack.get("step"), 5.0) or 5.0
            for corner in canonical:
                name = str(corner.get("name"))
                cell = corner_cells.get(name)
                if not cell:
                    continue
                a = _sample(pack.get("t"), step, _num(corner.get("start")))
                b = _sample(pack.get("t"), step, _num(corner.get("end")))
                ra = _sample(ref_pack.get("t"), step, _num(corner.get("start")))
                rb = _sample(ref_pack.get("t"), step, _num(corner.get("end")))
                if None not in (a, b, ra, rb):
                    cell["loss"].setdefault(s["id"], []).append((b - a) - (rb - ra))
                stats = _segment_stats(pack, corner)
                if stats:
                    cell["apex_speed"].setdefault(s["id"], []).append(_num(stats.get("apex")))

    corners = []
    for cell in corner_cells.values():
        corners.append({
            "name": cell["name"],
            "start": cell["start"],
            "end": cell["end"],
            "apex": cell["apex"],
            "sessions": {
                sid: {
                    "loss": _round(sum(vals) / len(vals), 3) if vals else None,
                    "apex": _mean(cell["apex_speed"].get(sid), 1),
                }
                for sid, vals in cell["loss"].items()
            },
            "mean_loss": _round(sum(sum(v) for v in cell["loss"].values())
                                / max(1, sum(len(v) for v in cell["loss"].values())), 3),
        })
    corners.sort(key=lambda c: _num(c.get("mean_loss")), reverse=True)

    first = session_rows[0] if session_rows else None
    last = session_rows[-1] if session_rows else None
    changes = []
    if first and last and first["id"] != last["id"]:
        for key, label, digits in (
            ("best", "лучший круг", 3), ("average", "средний круг", 3),
            ("consistency", "стабильность", 1), ("score", "оценка", 1),
            ("top_speed", "максимальная скорость", 1),
            ("throttle_pct", "доля полного газа", 1),
        ):
            a, b = _num(first.get(key)), _num(last.get(key))
            if a and b:
                changes.append({"key": key, "label": label,
                                "from": _round(a, digits), "to": _round(b, digits),
                                "delta": _round(b - a, digits)})
        pa, pb = first.get("pressures") or [], last.get("pressures") or []
        if len(pa) == 4 and len(pb) == 4:
            changes.append({"key": "pressure", "label": "среднее давление",
                            "from": _mean(pa, 2), "to": _mean(pb, 2),
                            "delta": _round(_mean(pb, 2) - _mean(pa, 2), 2)})
        if first.get("balance") is not None and last.get("balance") is not None:
            changes.append({"key": "balance", "label": "баланс",
                            "from": _round(first.get("balance"), 3),
                            "to": _round(last.get("balance"), 3),
                            "delta": _round(_num(last.get("balance")) - _num(first.get("balance")), 3)})

    return {
        "series": group,
        "sessions": session_rows,
        "run": run,
        "corners": corners,
        "changes": changes,
        "target": group.get("best"),
        "distance": total if total < 9e9 else None,
    }


# ---------------------------------------------------------------- narrative


def _corner_phrase(corner: dict) -> str:
    label = corner.get("label") or corner.get("name")
    loss = _num(corner.get("loss"))
    phase = corner.get("phase_label") or "в апексе"
    speed = corner.get("speed_delta")
    text = f"{label}: {_delta(loss)} с"
    if speed:
        text += f", {phase} {abs(speed):.0f} км/ч {'медленнее' if speed < 0 else 'быстрее'} эталона"
    return text


def _throttle_sentence(style: dict) -> str | None:
    you = _num(style.get("throttle_m"), None)
    ref = _num(style.get("ref_throttle_m"), None)
    ramp_you = _num(style.get("throttle_ramp_m"), None)
    ramp_ref = _num(style.get("ref_throttle_ramp_m"), None)
    steps_you = _num(style.get("throttle_steps"))
    steps_ref = _num(style.get("ref_throttle_steps"))
    if you is None or ref is None:
        return None
    if you > ref + 5:
        out = f"На газ ты встаёшь позже эталона в среднем на {you - ref:.0f} м"
    elif you < ref - 5:
        out = f"Газ открываешь раньше эталона в среднем на {ref - you:.0f} м"
    else:
        out = "Момент открытия газа близок к эталону"
    if ramp_you is not None and ramp_ref is not None and ramp_you > ramp_ref + 8:
        out += f", но делаешь это растянуто: от 10% до 95% проходит {ramp_you:.0f} м против {ramp_ref:.0f} м"
    if steps_you > steps_ref + 1.5:
        out += " — педаль идёт ступенями, тяга теряется на микро-сбросах"
    return out + "."


def _brake_sentence(style: dict) -> str | None:
    you = _num(style.get("brake_m"), None)
    ref = _num(style.get("ref_brake_m"), None)
    if you is None or ref is None:
        return None
    diff = you - ref  # negative = later than reference
    if diff < -4:
        return f"Тормозная точка в среднем на {abs(diff):.0f} м позже эталона — на входе не хватает стабильности."
    if diff > 4:
        return f"Тормозишь раньше эталона примерно на {diff:.0f} м, теряя скорость до апекса."
    return "Тормозные точки почти совпадают с эталоном."


def _type_sentence(by_type: dict) -> str | None:
    rows = []
    for key in ("fast", "medium", "slow"):
        item = by_type.get(key) or {}
        if item.get("loss") is None:
            continue
        rows.append((key, item["loss"]))
    if not rows:
        return None
    best = min(rows, key=lambda x: x[1])
    worst = max(rows, key=lambda x: x[1])
    if best[1] < -0.02 and worst[1] > 0.02:
        return (f"В {CORNER_TYPES_PLURAL[best[0]]} поворотах ты отыгрываешь {abs(best[1]):.3f} с, "
                f"в {CORNER_TYPES_PLURAL[worst[0]]} теряешь {worst[1]:.3f} с.")
    if worst[1] > 0.02:
        return f"Основная потеря — {CORNER_TYPES_PLURAL[worst[0]]} повороты: {worst[1]:.3f} с."
    if best[1] < -0.02:
        return f"Сильная сторона круга — {CORNER_TYPES_PLURAL[best[0]]} повороты: {abs(best[1]):.3f} с преимущества."
    return "По типам поворотов разница с эталоном небольшая."


def _series_sentence(detail: dict | None) -> str | None:
    if not detail:
        return None
    rows = detail.get("sessions") or []
    if len(rows) < 2:
        return None
    first, last = rows[0], rows[-1]
    if not first.get("best") or not last.get("best"):
        return None
    diff = _num(last.get("best")) - _num(first.get("best"))
    if abs(diff) < 0.03:
        trend = "темп между сессиями не изменился"
    elif diff < 0:
        trend = f"от первой сессии к последней ты прибавил {abs(diff):.3f} с"
    else:
        trend = f"от первой сессии к последней потерял {diff:.3f} с"
    out = (f"В серии {len(rows)} {_plural(len(rows), 'сессия', 'сессии', 'сессий')} "
           f"({_secs(first.get('best'))} → {_secs(last.get('best'))}): {trend}.")
    corners = detail.get("corners") or []
    improved = [c for c in corners if c.get("mean_loss") is not None and c["mean_loss"] < -0.02]
    regressed = [c for c in corners if c.get("mean_loss") is not None and c["mean_loss"] > 0.02]
    if improved:
        out += f" Прибавка пришла в {improved[0]['name']}."
    if regressed:
        out += f" Дольше всего держится потеря в {regressed[0]['name']}."
    return out


def _change_sentence(changes: list[dict]) -> str | None:
    if not changes:
        return None
    pressure = next((c for c in changes if c.get("key") == "pressure"), None)
    balance = next((c for c in changes if c.get("key") == "balance"), None)
    bits = []
    if pressure and abs(_num(pressure.get("delta"))) >= 0.05:
        direction = "выросло" if _num(pressure["delta"]) > 0 else "упало"
        bits.append(f"среднее давление {direction} на {abs(_num(pressure['delta'])):.2f} psi")
    if balance and abs(_num(balance.get("delta"))) >= 0.02:
        direction = "в сторону избыточной" if _num(balance["delta"]) > 0 else "в сторону недостаточной"
        bits.append(f"баланс сместился {direction} на {abs(_num(balance['delta'])):.2f}")
    if not bits:
        return None
    return "Между сессиями " + ", ".join(bits) + "."


def build_narrative(meta: dict, coach: dict | None, detail: dict | None,
                    profile: dict | None) -> dict:
    rep = meta.get("report") or {}
    series = (detail or {}).get("series") if detail else None
    paragraphs = []
    facts = []
    actions = []

    best = _num(meta.get("best_time"))
    avg = _num(rep.get("average"))
    title = meta.get("track") or "Сессия"

    # 1. Pace / reference
    if coach:
        ref = coach["reference"]
        delta = _num(coach.get("delta"))
        opener = (f"Лучший круг {_secs(best)} против {_secs(ref.get('best'))} "
                  f"у {ref.get('driver')} — разница {_delta(delta)} с.")
        if delta > 0.05:
            opener += " Эталон пока быстрее, и разрыв объясняется не одним поворотом."
        elif delta < -0.05:
            opener += " По чистой скорости ты уже быстрее эталона — вопрос в повторяемости."
        else:
            opener += " Темп практически совпал, дальше решают детали."
        losses = coach.get("losses") or []
        if losses:
            opener += " Больше всего времени уходит в " + ", ".join(
                f"{c['name']} ({_delta(c['loss'])} с)" for c in losses[:3]) + "."
        paragraphs.append({"kind": "pace", "text": opener})
        facts.append(f"Δ круга к эталону: {_delta(delta)} с")
    else:
        potential = _num(rep.get("potential"))
        text = f"Лучший круг {_secs(best)}, средний {_secs(avg)}."
        if rep.get("potential") is not None:
            text += (f" Внутри сессии запас между лучшим кругом и средним из пяти — "
                     f"{_delta(potential)} с.")
        text += " Внешнего эталона по этой трассе пока нет, поэтому оценка идёт от твоих же кругов."
        paragraphs.append({"kind": "pace", "text": text})
        facts.append(f"Запас внутри сессии: {_delta(potential)} с")

    # 2. Where
    if coach and coach.get("corners"):
        losses = [c for c in coach.get("losses") or [] if _num(c.get("loss")) > 0.01]
        gains = [c for c in coach.get("gains") or [] if _num(c.get("loss")) < -0.01]
        if losses or gains:
            text = "Разложим по трассе. "
            if losses:
                text += "Потери: " + "; ".join(_corner_phrase(c) for c in losses[:4]) + "."
            if gains:
                if losses:
                    text += " "
                text += "Выигрыш: " + ", ".join(
                    f"{c['name']} даёт {abs(_num(c['loss'])):.3f} с" for c in gains[:2]) + "."
            paragraphs.append({"kind": "where", "text": text})
            for c in losses[:3]:
                facts.append(f"{c['name']}: {_delta(c['loss'])} с, {c.get('phase_label')} {_num(c.get('speed_delta')):+.0f} км/ч")

    # 3. Driving
    if coach:
        style = coach.get("style") or {}
        bits = [_throttle_sentence(style), _brake_sentence(style)]
        bits = [b for b in bits if b]
        coast = _num(style.get("coast_m"), None)
        ref_coast = _num(style.get("ref_coast_m"), None)
        if coast is not None and ref_coast is not None and coast > ref_coast + 20:
            bits.append(f"Накатом пройдено на {coast - ref_coast:.0f} м больше эталона — это чистые потери.")
        if bits:
            text = " ".join(bits)
            events = rep.get("events") or {}
            lock = (events.get("lock") or {}).get("count") or 0
            spin = (events.get("spin") or {}).get("count") or 0
            if lock or spin:
                text += f" За сессию: блокировок {lock}, пробуксовок {spin}."
            paragraphs.append({"kind": "driving", "text": text})
            if style.get("throttle_steps") is not None:
                facts.append(f"Ступени газа: {style.get('throttle_steps')} против {style.get('ref_throttle_steps')} у эталона")

    # 4. Car / balance
    if coach:
        text = _type_sentence(coach.get("by_type") or {})
        speed = coach.get("speed") or {}
        top_you, top_ref = _num(speed.get("you")), _num(speed.get("ref"))
        if text and top_you and top_ref:
            diff = top_you - top_ref
            if abs(diff) >= 1:
                text += (f" На прямых максимум {top_you:.0f} км/ч, "
                         f"это {'плюс' if diff > 0 else 'минус'} {abs(diff):.0f} км/ч к эталону.")
        if text:
            text += " Формулировка про машину здесь означает связку «машина + настройки + пилот», а не паспортные данные автомобиля."
            paragraphs.append({"kind": "car", "text": text})
    elif detail:
        text = _type_sentence({})
        if text:
            paragraphs.append({"kind": "car", "text": text})

    # 5. Series
    series_text = _series_sentence(detail)
    if series_text:
        paragraphs.append({"kind": "series", "text": series_text})
    change_text = _change_sentence((detail or {}).get("changes") or [])
    if change_text:
        paragraphs.append({"kind": "setup", "text": change_text})

    # 6. Plan
    if coach:
        losses = coach.get("losses") or []
        for c in losses[:3]:
            gain = abs(_num(c.get("loss")))
            phase = c.get("phase_label") or "в апексе"
            speed = _num(c.get("speed_delta"))
            verb = "поднять скорость" if speed < 0 else "стабилизировать машину"
            actions.append(
                f"{c['name']}: {verb} {phase} (разница {speed:+.0f} км/ч), "
                f"ориентир — {gain:.3f} с.")
        if (coach.get("style") or {}).get("throttle_steps") is not None:
            actions.append("Газ открывать одной дугой: меньше микро-сбросов и ступеней.")
    else:
        losses = (rep.get("corner_loss") or [])[:3]
        for c in losses:
            actions.append(f"{c.get('name')}: убрать среднюю потерю {abs(_num(c.get('loss'))):.3f} с.")
    if series and len((detail or {}).get("sessions") or []) >= 2:
        actions.append("Повторить лучший круг в конце серии: стабильность важнее одного быстрого круга.")

    if coach:
        confidence = ("Высокая: есть внешний эталон и покадровое сравнение каналов." if coach.get("aligned")
                      else "Средняя: длины кругов отличаются, сравнение по дистанции может смещаться.")
    elif series:
        confidence = "Средняя: внешнего эталона нет, выводы опираются на серию твоих сессий."
    else:
        confidence = "Базовая: одна сессия без эталона, выводы предварительные."

    headline = f"{title}: {_delta(_num(coach.get('delta')))} с к эталону" if coach else f"{title}: разбор сессии"
    return {
        "headline": headline,
        "paragraphs": paragraphs,
        "facts": facts[:8],
        "actions": actions[:4],
        "confidence": confidence,
        "has_reference": bool(coach),
        "has_series": bool(series and (series.get("count") or 0) > 1),
    }


# ------------------------------------------------------------------- payload


def session_analysis(session_id: str, ref_id: str = "") -> dict | None:
    lib = store.load_library()
    sessions = lib.get("sessions", [])
    meta = next((s for s in sessions if s["id"] == session_id), None)
    if not meta:
        meta = store.load_meta(session_id)
    if not meta:
        return None

    refs = reference_candidates(meta, sessions)
    if ref_id:
        refs = [s for s in refs if s["id"] == ref_id] or refs
    ref_meta = refs[0] if refs else None
    coach = compare_to_reference(meta, ref_meta) if ref_meta else None
    detail = series_detail(session_id, sessions)
    profile = profile_for(meta, lib)
    narrative = build_narrative(meta, coach, detail, profile)
    return {
        "session": meta,
        "series": detail,
        "reference": coach,
        "learning": profile,
        "narrative": narrative,
        "references": [{"id": s["id"], "driver": _driver(s), "best": _round(s.get("best_time"), 3),
                        "date": s.get("date"), "time": s.get("time")} for s in refs],
    }


def learning_payload() -> dict:
    lib = store.load_library()
    learning = ensure_learning(lib)
    sessions = lib.get("sessions", [])
    refs = [s for s in sessions if s.get("reference")]
    by_key = {}
    for ref in refs:
        key = f"{_track_key(ref)}|{_car_key(ref)}"
        row = by_key.setdefault(key, {
            "key": key, "track": ref.get("track"), "car": ref.get("car"),
            "track_id": _track_key(ref), "car_id": _car_key(ref),
            "sessions": [], "drivers": set(), "best": None,
        })
        row["sessions"].append(ref["id"])
        row["drivers"].add(_driver(ref))
        if ref.get("best_time"):
            row["best"] = min(_num(row["best"], 9e9), _num(ref["best_time"]))
    groups = []
    for key, row in by_key.items():
        profile = (learning.get("profiles") or {}).get(key)
        row["drivers"] = sorted(row["drivers"])
        row["count"] = len(row["sessions"])
        row["target"] = (profile or {}).get("target")
        row["targets"] = (profile or {}).get("targets") or []
        groups.append(row)
    groups.sort(key=lambda g: (g.get("track") or "", g.get("car") or ""))
    return {"learning": learning, "groups": groups, "references": refs}
