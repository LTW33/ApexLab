"""Session building, cache, setup parsing and setup recommendations."""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

import apexld
from cardata import CAR_DATA


def _writable_root() -> Path:
    """Folder for user data: next to the exe when frozen, project root otherwise."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = _writable_root()
DATA = ROOT / "data"
CACHE = DATA / "cache"
LIBRARY = DATA / "library.json"
ACC_DEFAULT = Path(os.environ.get("USERPROFILE", "")) / "OneDrive" / "Документы" / "Assetto Corsa Competizione"
SETUPS_DEFAULT = ACC_DEFAULT / "Setups"
MOTEC_DEFAULT = ACC_DEFAULT / "MoTeC"
VERSION = 3
APP_VERSION = "2.0.0"

TRACK_NAMES = {
    "spa": "Спа-Франкоршам",
    "monza": "Монца",
    "red_bull_ring": "Ред Булл Ринг",
    "silverstone": "Сильверстоун",
    "suzuka": "Судзука",
    "zolder": "Зольдер",
    "nurburgring": "Нюрбургринг",
    "nurburgring_24h": "Нюрбургринг 24h",
    "imola": "Имола",
    "misano": "Мисано",
    "barcelona": "Барселона",
    "brands_hatch": "Брэндс-Хэтч",
    "hungaroring": "Хунгароринг",
    "kyalami": "Кьялами",
    "laguna_seca": "Лагуна Сека",
    "mount_panorama": "Маунт-Панорама",
    "oulton_park": "Оултон-Парк",
    "paul_ricard": "Поль-Рикар",
    "snetterton": "Снеттертон",
    "valencia": "Валенсия",
    "watkins_glen": "Уоткинс-Глен",
    "zandvoort": "Зандворт",
    "indianapolis": "Индианаполис",
    "cota": "CODA",
    "donington": "Донингтон",
}

CAR_BRANDS = {
    "ferrari": "Ferrari",
    "mclaren": "McLaren",
    "porsche": "Porsche",
    "audi": "Audi",
    "amr": "Aston Martin",
    "aston": "Aston Martin",
    "bmw": "BMW",
    "mercedes": "Mercedes-AMG",
    "honda": "Honda",
    "lamborghini": "Lamborghini",
    "lexus": "Lexus",
    "nissan": "Nissan",
    "bentley": "Bentley",
    "jaguar": "Jaguar",
    "ford": "Ford",
    "chevrolet": "Chevrolet",
    "maserati": "Maserati",
    "alpine": "Alpine",
}


def jsonable(value):
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return None if (math.isnan(v) or math.isinf(v)) else round(v, 4)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, np.ndarray):
        return jsonable(value.tolist())
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def pretty_track(slug: str, fallback: str = "") -> str:
    key = (slug or "").strip().lower().replace(" ", "_")
    if key in TRACK_NAMES:
        return TRACK_NAMES[key]
    raw = (fallback or slug or "Трасса").replace("_", " ").strip()
    return raw[:1].upper() + raw[1:]


def pretty_car(car_id: str, label: str = "") -> str:
    cid = (car_id or "").lower()
    brand = ""
    for k, v in CAR_BRANDS.items():
        if cid.startswith(k):
            brand = v
            break
    clean = (label or "").strip()
    if not clean:
        clean = cid.replace("_", " ").upper()
    if brand and not clean.lower().startswith(brand.lower().split("-")[0]):
        return f"{brand} {clean}"
    return clean


def parse_filename(path: str) -> dict:
    name = os.path.basename(path)
    stem = name[:-3] if name.lower().endswith(".ld") else name
    parts = stem.split("-")
    track_id = parts[0] if parts else ""
    car_id = parts[1] if len(parts) > 1 else ""
    m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})", stem)
    stamp = f"{m.group(1)}-{m.group(2)}-{m.group(3)} {m.group(4)}:{m.group(5)}" if m else ""
    return {"track_id": track_id, "car_id": car_id, "stamp": stamp}


def content_id(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()[:14]


def signature(log: apexld.Log, laps: list) -> str:
    """Fingerprint of the recorded telemetry.

    Export time is deliberately ignored: ACC writes the same recording several
    times with a slightly different header clock, and those copies must collapse
    into one session.  Lap times + lengths identify a recording reliably.
    """
    parts = [log.meta.get("venue", ""), log.meta.get("car", "")]
    parts += [f"{l.time:.2f}/{l.distance:.0f}" for l in laps[:60]]
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def _lap_keys(s: dict) -> list[float]:
    # Lap length can shift by a metre when the recording starts at a different
    # point, so time alone is the stable part of the fingerprint.
    return [round(float(l.get("time", 0)), 2) for l in s.get("laps") or []]


def _lcs_len(a: list, b: list) -> int:
    """Length of the longest common subsequence (laps stay in order)."""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def _same_recording(a: dict, b: dict) -> bool:
    ka, kb = _lap_keys(a), _lap_keys(b)
    if not ka or not kb:
        return False
    small, big = (ka, kb) if len(ka) <= len(kb) else (kb, ka)
    if len(small) < 3:
        # tiny logs: require a full match, otherwise keep both
        return small == big
    return _lcs_len(small, big) >= max(3, int(len(small) * 0.7))


def dedupe_library(lib: dict) -> list[dict]:
    """Drop recordings that overlap a more complete recording of the same stint.

    ACC splits long stints into several files (and lets the same recording be
    exported repeatedly).  Keep the file with the most laps, tie-broken by the
    longest recording.  Reference logs and own logs are deduplicated separately,
    so importing a fast driver's file never hides your own stint.
    """
    sessions = lib.get("sessions") or []
    order = sorted(range(len(sessions)),
                   key=lambda i: (-int(sessions[i].get("clean_laps") or 0),
                                  -len(_lap_keys(sessions[i])),
                                  -float(sessions[i].get("duration") or 0)))
    kept: list[dict] = []
    removed: list[dict] = []
    for i in order:
        s = sessions[i]
        dup = next((k for k in kept
                    if k.get("track") == s.get("track")
                    and k.get("car") == s.get("car")
                    and bool(k.get("reference")) == bool(s.get("reference"))
                    and _same_recording(k, s)), None)
        if dup is None:
            kept.append(s)
        else:
            removed.append(s)
    if removed:
        dead = {s["id"] for s in removed}
        lib["sessions"] = [s for s in sessions if s["id"] not in dead]
        for s in removed:
            shutil.rmtree(CACHE / s["id"], ignore_errors=True)
    return removed


# ---------------------------------------------------------------- library


def _empty_library() -> dict:
    return {"version": VERSION, "sessions": [], "settings": {
        "acc_path": str(ACC_DEFAULT),
        "setups_path": str(SETUPS_DEFAULT),
        "motec_path": str(MOTEC_DEFAULT),
    }}


def load_library() -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    if not LIBRARY.exists():
        return _empty_library()
    try:
        lib = json.loads(LIBRARY.read_text(encoding="utf-8"))
    except Exception:
        return _empty_library()
    if lib.get("version") != VERSION:
        # keep entries but refresh global defaults
        lib.setdefault("sessions", [])
        lib.setdefault("settings", {})
    return lib


def save_library(lib: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = LIBRARY.with_suffix(".tmp")
    tmp.write_text(json.dumps(jsonable(lib), ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(LIBRARY)


# ---------------------------------------------------------------- build


def _pick_best(laps: list) -> "apexld.Lap | None":
    usable = [l for l in laps if l.distance > 400 and l.time > 8]
    if not usable:
        return None
    valid = [l for l in usable if l.valid]
    if valid:
        return min(valid, key=lambda l: l.time)
    # no clean lap: prefer the longest lap, then the fastest
    return max(usable, key=lambda l: (l.distance, -l.time))


def build_session(path: str, driver: str = "", reference: bool = False) -> dict:
    t0 = time.time()
    log = apexld.read_ld(path)
    laps = apexld.lap_spans(log)
    usable = [l for l in laps if l.distance > 300 and l.time > 8]
    best = _pick_best(usable)
    if best is None:
        raise ValueError("В логе нет пригодных кругов — похоже, телеметрия оборвалась")

    best_pack = apexld.analyze_lap(log, best)
    if not best_pack:
        raise ValueError("Не удалось разобрать лучший круг")
    corners = best_pack["corners"]
    ref_t = best_pack["t"]

    packs: dict[int, dict] = {}
    for lap in usable:
        pack = apexld.analyze_lap(log, lap, corners=corners, reference_t=ref_t)
        if pack:
            packs[lap.index] = pack

    report = apexld.summarize_laps(list(packs.values()), best_pack)

    info = parse_filename(path)
    venue = log.meta.get("venue") or info["track_id"]
    track_id = (venue or info["track_id"]).strip().lower().replace(" ", "_")
    car_id = info["car_id"] or ""
    sid = content_id(path)
    summary_laps = []
    for lap in usable:
        pack = packs.get(lap.index)
        if not pack:
            continue
        counts = {}
        for e in pack["events"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
        summary_laps.append({
            "index": lap.index,
            "time": round(lap.time, 3),
            "distance": round(lap.distance, 1),
            "valid": lap.valid,
            "tags": lap.tags,
            "events": counts,
            "top_speed": round(float(max(pack["ch"]["spd"])), 1),
        })

    session = {
        "id": sid,
        "file": path,
        "name": os.path.basename(path),
        "track": pretty_track(track_id, venue),
        "track_id": track_id,
        "car": pretty_car(car_id, log.meta.get("car", "")),
        "car_id": car_id,
        "date": log.meta.get("date", ""),
        "time": log.meta.get("time", ""),
        "driver": driver.strip() or "Пилот",
        "reference": bool(reference),
        "duration": round(log.duration, 1),
        "imported": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "built": time.time(),
        "mtime": os.path.getmtime(path),
        "size": os.path.getsize(path),
        "signature": signature(log, laps),
        "laps_total": len(laps),
        "laps": summary_laps,
        "clean_laps": sum(1 for l in usable if l.valid),
        "clean": any(l.valid for l in usable),
        "best_index": best.index,
        "best_time": round(best.time, 3),
        "corners": corners,
        "report": report,
        "map": best_pack.get("path", {"x": [], "y": []}),
        "rates": {k: log.rates[k] for k in ("speed", "throttle", "brake") if k in log.rates},
        "build_seconds": round(time.time() - t0, 2),
    }

    cache_dir = CACHE / sid
    if cache_dir.exists():
        shutil.rmtree(cache_dir, ignore_errors=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    for idx, pack in packs.items():
        payload = gzip.compress(json.dumps(jsonable(pack), ensure_ascii=False,
                                           separators=(",", ":")).encode("utf-8"), 6)
        (cache_dir / f"lap_{idx:03d}.json.gz").write_bytes(payload)
    (cache_dir / "meta.json.gz").write_bytes(
        gzip.compress(json.dumps(jsonable(session), ensure_ascii=False,
                                 separators=(",", ":")).encode("utf-8"), 6))

    return session


def load_meta(sid: str) -> dict | None:
    p = CACHE / sid / "meta.json.gz"
    if not p.exists():
        return None
    return json.loads(gzip.decompress(p.read_bytes()).decode("utf-8"))


def load_lap(sid: str, index: int) -> dict | None:
    p = CACHE / sid / f"lap_{index:03d}.json.gz"
    if not p.exists():
        return None
    return json.loads(gzip.decompress(p.read_bytes()).decode("utf-8"))


# ---------------------------------------------------------------- trajectory

LINE_THRESHOLD = 1.15       # metres, smallest deviation worth explaining
LINE_SMOOTH_M = 220.0       # slow yaw-integration drift is removed below this scale
LINE_MIN_LEN_M = 10.0


def _smooth_moving(x: np.ndarray, window: int) -> np.ndarray:
    if window <= 1 or len(x) < 3:
        return np.asarray(x, dtype=np.float64)
    w = int(window) | 1
    pad = w // 2
    padded = np.pad(np.asarray(x, dtype=np.float64), (pad, pad), mode="edge")
    out = np.convolve(padded, np.ones(w) / w, mode="valid")
    return out[:len(x)]


def _detrend_offset(delta: np.ndarray, s: np.ndarray, step: float) -> np.ndarray:
    """Remove slow path drift while keeping corner-scale line differences."""
    d = np.asarray(delta, dtype=np.float64)
    n = len(d)
    if n < 8:
        return np.zeros_like(d)
    deg = 2 if n >= 20 else 1
    try:
        coef, *_ = np.linalg.lstsq(np.vander(s, deg + 1), d, rcond=None)
        base = np.vander(s, deg + 1) @ coef
    except np.linalg.LinAlgError:
        base = np.zeros_like(d)
    residual = d - base
    return base + _smooth_moving(residual, max(5, int(round(LINE_SMOOTH_M / step))))


def _wrap_pi(a: float) -> float:
    return (a + math.pi) % (2.0 * math.pi) - math.pi


def _corner_direction(pack: dict, corner: dict) -> int:
    """+1 left, -1 right, 0 unknown. ACC lat < 0 for a right-hander."""
    step = float(pack.get("step") or 5.0)
    apex = int(round(float(corner.get("apex") or 0.0) / step))
    lat = (pack.get("ch") or {}).get("lat") or []
    if lat and 0 <= apex < len(lat):
        lo = max(0, apex - 3)
        hi = min(len(lat), apex + 4)
        mean = float(np.mean(lat[lo:hi]))
        if abs(mean) > 0.25:
            return 1 if mean > 0 else -1
    xs = (pack.get("path") or {}).get("x") or []
    ys = (pack.get("path") or {}).get("y") or []
    if 1 <= apex < min(len(xs), len(ys)) - 1:
        h0 = math.atan2(ys[apex] - ys[apex - 1], xs[apex] - xs[apex - 1])
        h1 = math.atan2(ys[apex + 1] - ys[apex], xs[apex + 1] - xs[apex])
        dh = _wrap_pi(h1 - h0)
        if abs(dh) > 1e-4:
            return 1 if dh > 0 else -1
    return 0


def _pedal_point(arr, i0: int, i1: int, limit: float) -> int | None:
    """Rising edge: the pedal was released shortly before crossing the limit."""
    if arr is None or len(arr) == 0:
        return None
    lo = max(0, i0)
    hi = min(len(arr) - 1, i1)
    for i in range(lo + 3, hi + 1):
        if float(arr[i]) > limit and min(float(v) for v in arr[i - 3:i]) < limit / 2:
            return i
    return None


LINE_PHASE = {"entry": "на входе", "apex": "в апексе", "exit": "на выходе"}

LINE_TEMPLATES = {
    ("entry", "inside"): (
        "Ранний вход",
        "Ты раньше уводишь машину внутрь — на {d:.1f} м относительно эталона. "
        "Дуга начинается раньше, и на выходе не остаётся ширины.",
        "Начни поворот на 2–4 м позже и отпускай тормоз плавнее, оставляя машину "
        "снаружи до апекса.",
    ),
    ("entry", "outside"): (
        "Поздний вход",
        "На входе траектория на {d:.1f} м снаружи эталона: машина позже выходит "
        "на дугу, апекс смещается.",
        "Поворачивай раньше и не перетормаживай — поздний вход отнимает выход.",
    ),
    ("apex", "inside"): (
        "Срезание апекса",
        "В апексе ты на {d:.1f} м внутри эталона. Путь короче, но радиус меньше — "
        "на выходе теряется скорость.",
        "Оставь 0.3–0.5 м до поребрика и раскрывай траекторию на выходе.",
    ),
    ("apex", "outside"): (
        "Промах мимо апекса",
        "В апексе машина на {d:.1f} м снаружи эталона — не доворачивает или входит "
        "слишком быстро.",
        "Сбрось 3–5 км/ч на входе или добавь руля. Если машина скользит наружу, "
        "проверь баланс и переднее сцепление.",
    ),
    ("exit", "inside"): (
        "Ранний выход",
        "На выходе ты на {d:.1f} м внутри: не используешь всю ширину и теряешь "
        "скорость на следующей прямой.",
        "Позже открывай газ и выпускай машину наружу — так тяга будет стабильнее.",
    ),
    ("exit", "outside"): (
        "Широкий выход",
        "На выходе машина на {d:.1f} м снаружи эталона — теряется тяга и время.",
        "Раньше открывай газ, но без пробуксовки. Если уносит наружу, стабилизируй "
        "заднюю ось.",
    ),
}

LINE_OFFSET = (
    "Смещение траектории",
    "Линия проходит в {d:.1f} м от эталона. Зона не привязана к фазе поворота — "
    "проверь положение машины относительно поребриков.",
    "Сравни с эталоном покадрово и выровняй положение на входе в поворот.",
)


def _line_text(phase: str, side: str, value: float, metrics: dict) -> dict:
    key = (phase, side)
    title, text, advice = LINE_TEMPLATES.get(key, LINE_OFFSET)
    d = abs(value)
    extra = []
    spd = metrics.get("speed_delta")
    if spd is not None and abs(spd) >= 4:
        extra.append(f"скорость {'ниже' if spd < 0 else 'выше'} эталона на {abs(spd):.0f} км/ч")
    brake = metrics.get("brake_delta")
    if brake is not None and abs(brake) >= 5:
        extra.append(f"торможение {'позже' if brake > 0 else 'раньше'} на {abs(brake):.0f} м")
    throttle = metrics.get("throttle_delta")
    if throttle is not None and abs(throttle) >= 8:
        extra.append(f"газ открыт {'позже' if throttle > 0 else 'раньше'} на {abs(throttle):.0f} м")
    steer = metrics.get("steer_delta")
    if steer is not None and abs(steer) >= 7:
        extra.append(f"руля в апексе {'больше' if steer > 0 else 'меньше'} на {abs(steer):.0f}%")
    loss = metrics.get("time_loss")
    if loss is not None and loss >= 0.03:
        extra.append(f"зона стоит +{loss:.2f} с")
    body = text.format(d=d)
    if extra:
        extra_txt = "; ".join(extra)
        body += " " + extra_txt[0].upper() + extra_txt[1:] + "."
    return {"title": title, "text": body, "advice": advice}


def _default_reference(meta: dict, lap_index: int) -> tuple[str, int]:
    """Fastest clean lap on this track, then the fastest lap of this session."""
    lib = load_library()
    track = meta.get("track_id") or meta.get("track")
    candidates = []
    for s in lib.get("sessions", []):
        if (s.get("track_id") or s.get("track")) != track:
            continue
        for l in s.get("laps") or []:
            if not l.get("valid") or not l.get("time"):
                continue
            if s["id"] == meta["id"] and int(l["index"]) == lap_index:
                continue
            candidates.append((float(l["time"]), s["id"], int(l["index"])))
    candidates.sort()
    if candidates:
        return candidates[0][1], candidates[0][2]
    laps = [l for l in meta.get("laps", [])
            if l.get("index") != lap_index and l.get("time", 0) > 0
            and "pit" not in (l.get("tags") or []) and "out" not in (l.get("tags") or [])]
    if laps:
        best = min(laps, key=lambda l: l["time"])
        return meta["id"], int(best["index"])
    laps = [l for l in meta.get("laps", [])
            if l.get("index") != lap_index and l.get("time", 0) > 0]
    if laps:
        best = min(laps, key=lambda l: l["time"])
        return meta["id"], int(best["index"])
    return meta["id"], lap_index


def trajectory(sid: str, lap_index: int,
               ref_sid: str | None = None,
               ref_index: int | None = None) -> dict | None:
    """Compare one lap's racing line with a reference lap in the distance domain."""
    cur_meta = load_meta(sid)
    cur = load_lap(sid, lap_index)
    if not cur_meta or not cur:
        return None

    cur_path = cur.get("path") or {}
    if not cur_path.get("x") or not cur_path.get("y"):
        return {
            "available": False,
            "reason": "В логе нет канала поворота (ROTY), поэтому траекторию "
                      "восстановить нельзя. Доступны телеметрия, ошибки и сет.",
        }

    cur_tags = cur.get("tags") or []
    if cur.get("partial") or "pit" in cur_tags or "out" in cur_tags:
        return {
            "available": False,
            "reason": "Круг невалидный: выезд из боксов, пита или неполный круг. "
                      "Сравнивать такую линию с эталоном нет смысла — выбери "
                      "боевой круг.",
        }

    if ref_sid is None or ref_index is None:
        ref_sid, ref_index = _default_reference(cur_meta, lap_index)
    ref_meta = load_meta(ref_sid) if ref_sid else None
    ref = load_lap(ref_sid, ref_index) if ref_sid else None
    if not ref_meta or not ref:
        ref_sid, ref_index = _default_reference(cur_meta, lap_index)
        ref_meta = load_meta(ref_sid)
        ref = load_lap(ref_sid, ref_index)
    if not ref_meta or not ref:
        return None

    ref_path = ref.get("path") or {}
    if not ref_path.get("x") or not ref_path.get("y"):
        return {
            "available": False,
            "reason": "У эталонного круга нет восстановленной траектории. "
                      "Выбери другой эталон.",
        }

    step = float(cur.get("step") or ref.get("step") or 5.0)
    n = min(len(cur_path["x"]), len(cur_path["y"]),
            len(ref_path["x"]), len(ref_path["y"]))
    if n < 12:
        return {"available": False, "reason": "Слишком мало точек для сравнения."}

    cur_dist = float(cur.get("distance") or (n - 1) * step)
    ref_dist = float(ref.get("distance") or (n - 1) * step)
    if cur_dist > 0 and ref_dist > 0 and abs(cur_dist - ref_dist) > max(180.0, 0.04 * max(cur_dist, ref_dist)):
        return {
            "available": False,
            "reason": f"Круги разной длины: {cur_dist / 1000:.2f} км против {ref_dist / 1000:.2f} км. "
                      "Так бывает на круге выезда, пита или неполном круге — сопоставлять "
                      "траектории по дистанции нельзя. Выбери боевой круг и эталон.",
        }

    cx = np.asarray(cur_path["x"], dtype=np.float64)
    cy = np.asarray(cur_path["y"], dtype=np.float64)
    rx_all = np.asarray(ref_path["x"], dtype=np.float64)
    ry_all = np.asarray(ref_path["y"], dtype=np.float64)
    nc, nr = len(cx), len(rx_all)
    if nc < 12 or nr < 12:
        return {"available": False, "reason": "Слишком мало точек для сравнения."}

    # Two different lines cover slightly different distances, so matching by
    # raw index drifts apart towards the end of the lap. Map the reference onto
    # the current lap's fractional progress instead.
    pos = np.arange(nc) * (nr - 1) / max(nc - 1, 1)
    rx = np.interp(pos, np.arange(nr), rx_all)
    ry = np.interp(pos, np.arange(nr), ry_all)
    n = nc

    # compensate accumulated yaw-integration drift without erasing corner line
    s = np.linspace(0.0, 1.0, n)
    ox = _detrend_offset(rx - cx, s, step)
    oy = _detrend_offset(ry - cy, s, step)
    ax = cx + ox
    ay = cy + oy

    tx = np.gradient(rx)
    ty = np.gradient(ry)
    norm = np.maximum(np.hypot(tx, ty), 1e-6)
    dev = (tx * (ay - ry) - ty * (ax - rx)) / norm
    dev = _smooth_moving(dev, 3)

    cur_t = np.asarray(cur.get("t") or [], dtype=np.float64)
    ref_t_raw = np.asarray(ref.get("t") or [], dtype=np.float64)
    ref_t = (np.interp(pos, np.arange(len(ref_t_raw)), ref_t_raw)
             if len(ref_t_raw) > 1 else ref_t_raw)

    # reference channels on the same fractional grid, for fair metric deltas
    ref_ch = {}
    for key in ("spd", "brk", "thr", "str"):
        arr = (ref.get("ch") or {}).get(key) or []
        if len(arr) > 1:
            ref_ch[key] = np.interp(pos, np.arange(len(arr)),
                                    np.asarray(arr, dtype=np.float64))
    ref_aligned = {"ch": ref_ch}
    corners = ref.get("corners") or cur.get("corners") or []

    zones = []
    all_abs = []
    for c in corners:
        i0 = max(0, int(round((float(c.get("start", 0)) - 25.0) / step)))
        i1 = min(n - 1, int(round((float(c.get("end", 0)) + 25.0) / step)))
        if i1 - i0 < 6:
            continue
        apex_i = min(i1, max(i0, int(round(float(c.get("apex", 0)) / step))))
        slices = {
            "entry": (i0, max(i0, apex_i - 4)),
            "apex": (max(i0, apex_i - 4), min(i1, apex_i + 5)),
            "exit": (min(i1, apex_i + 5), i1),
        }
        means = {k: float(np.mean(dev[a:b + 1])) for k, (a, b) in slices.items() if b >= a}
        if not means:
            continue
        phase = max(means, key=lambda k: abs(means[k]))
        zdev = means[phase]
        peak_abs = float(np.max(np.abs(dev[i0:i1 + 1])))
        if abs(zdev) < LINE_THRESHOLD and peak_abs < 2.0:
            continue
        pa, pb = slices[phase]
        seg = dev[pa:pb + 1]
        sign = 1.0 if zdev >= 0 else -1.0
        signed = seg * sign
        peak_i = pa + int(np.argmax(signed)) if len(seg) and float(np.max(signed)) > 0 else (pa + pb) // 2
        dirn = _corner_direction(ref, c)
        inside = dirn != 0 and zdev * dirn > 0
        side = "inside" if inside else ("outside" if dirn else "offset")

        # contiguous stretch around the peak for the map highlight
        thr = max(0.55, abs(zdev) * 0.5)
        a = peak_i
        while a > i0 and abs(dev[a - 1]) >= thr:
            a -= 1
        b = peak_i
        while b < i1 and abs(dev[b + 1]) >= thr:
            b += 1
        if (b - a) * step < LINE_MIN_LEN_M:
            a = max(i0, peak_i - 2)
            b = min(i1, peak_i + 2)

        def chan(pack, key):
            arr = (pack.get("ch") or {}).get(key)
            return arr if arr is not None else []

        def apex_mean(pack, group):
            arr = chan(pack, group)
            seg = arr[max(0, apex_i - 1):min(len(arr), apex_i + 2)] if len(arr) else []
            return float(np.mean(seg)) if len(seg) else None

        spd_cur, spd_ref = apex_mean(cur, "spd"), apex_mean(ref_aligned, "spd")
        speed_delta = (round(spd_cur - spd_ref, 1)
                       if spd_cur is not None and spd_ref is not None else None)

        def apex_steer(pack):
            arr = chan(pack, "str")
            seg = arr[max(0, apex_i - 2):min(len(arr), apex_i + 3)]
            return float(np.mean(np.abs(seg))) if len(seg) else None

        sc, sr = apex_steer(cur), apex_steer(ref_aligned)
        steer_delta = round(sc - sr, 1) if sc is not None and sr is not None else None

        brk_cur_arr = chan(cur, "brk")
        brk_ref_arr = chan(ref_aligned, "brk")
        b0 = max(i0, apex_i - int(round(140 / step)))
        bc = _pedal_point(brk_cur_arr, b0, apex_i, 22)
        br = _pedal_point(brk_ref_arr, b0, apex_i, 22)
        brake_delta = round((bc - br) * step, 1) if bc is not None and br is not None else None

        thr_cur_arr = chan(cur, "thr")
        thr_ref_arr = chan(ref_aligned, "thr")
        t1 = min(n - 1, i1 + int(round(40 / step)))
        tc = _pedal_point(thr_cur_arr, apex_i, t1, 82)
        tr = _pedal_point(thr_ref_arr, apex_i, t1, 82)
        throttle_delta = round((tc - tr) * step, 1) if tc is not None and tr is not None else None

        time_loss = 0.0
        if i1 < len(cur_t) and i1 < len(ref_t) and i0 < len(cur_t) and i0 < len(ref_t):
            time_loss = round(float((cur_t[i1] - cur_t[i0]) - (ref_t[i1] - ref_t[i0])), 3)

        metrics = {
            "speed_delta": speed_delta,
            "brake_delta": brake_delta,
            "throttle_delta": throttle_delta,
            "steer_delta": steer_delta,
            "time_loss": time_loss,
        }
        text = _line_text(phase, side, zdev, metrics)
        zabs = abs(zdev)
        severity = "high" if zabs >= 2.2 else "mid" if zabs >= 1.5 else "low"
        zones.append({
            "corner": c.get("name") or f"T{len(zones) + 1}",
            "phase": phase,
            "phase_label": LINE_PHASE[phase],
            "side": side,
            "dev": round(zdev, 2),
            "abs_dev": round(zabs, 2),
            "peak_dev": round(float(dev[peak_i]), 2),
            "peak_dist": round(peak_i * step, 1),
            "start": round(a * step, 1),
            "end": round(b * step, 1),
            "severity": severity,
            "title": text["title"],
            "text": text["text"],
            "advice": text["advice"],
            "metrics": metrics,
            "time_loss": time_loss,
            "corner_apex": round(float(c.get("apex", 0)), 1),
        })
        all_abs.extend(np.abs(dev[i0:i1 + 1]).tolist())

    zones.sort(key=lambda z: (-z["abs_dev"], z["peak_dist"]))
    for i, z in enumerate(zones):
        z["n"] = i + 1

    avg_dev = round(float(np.mean(all_abs)), 2) if all_abs else 0.0
    max_dev = round(float(np.max(all_abs)), 2) if all_abs else 0.0
    cur_time = float(cur.get("time") or 0.0)
    ref_time = float(ref.get("time") or 0.0)

    return {
        "available": True,
        "session": sid,
        "lap": lap_index,
        "ref": {
            "session": ref_sid,
            "lap": ref_index,
            "time": ref_time,
            "driver": ref_meta.get("driver"),
            "car": ref_meta.get("car"),
            "track": ref_meta.get("track"),
            "date": ref_meta.get("date"),
            "same_session": ref_sid == sid and ref_index == lap_index,
            "same_car": ref_meta.get("car_id") == cur_meta.get("car_id"),
        },
        "current": {
            "time": cur_time,
            "driver": cur_meta.get("driver"),
            "car": cur_meta.get("car"),
        },
        "step": step,
        "n": n,
        "distance": round((n - 1) * step, 1),
        "ref_path": {"x": [round(float(v), 1) for v in rx],
                     "y": [round(float(v), 1) for v in ry]},
        "cur_path": {"x": [round(float(v), 1) for v in ax],
                     "y": [round(float(v), 1) for v in ay]},
        "dev": [round(float(v), 2) for v in dev],
        "corners": [{"name": c.get("name"), "start": c.get("start"),
                     "apex": c.get("apex"), "end": c.get("end")} for c in corners],
        "zones": zones,
        "summary": {
            "avg_dev": avg_dev,
            "max_dev": max_dev,
            "zones": len(zones),
            "high": sum(1 for z in zones if z["severity"] == "high"),
            "time_delta": round(cur_time - ref_time, 3),
            "corner_count": len(corners),
            "worst": zones[0]["corner"] if zones else None,
            "clean": not zones,
        },
        "method": "Отклонение считается по восстановленной траектории в метрах. "
                  "Медленный дрейф датчика рыскания скомпенсирован, поэтому "
                  "сравниваются локальные различия линии, а не абсолютные координаты.",
    }


# ---------------------------------------------------------------- scan / import


def peek(path: str) -> dict:
    """Cheap metadata for the import list (without parsing all channels)."""
    size = os.path.getsize(path)
    info = parse_filename(path)
    meta = {}
    try:
        with open(path, "rb") as fh:
            head = fh.read(0x800)
        meta = {
            "date": head[0x5E:0x6E].split(b"\0")[0].decode("latin-1", "replace").strip(),
            "time": head[0x7E:0x8E].split(b"\0")[0].decode("latin-1", "replace").strip(),
            "venue": head[0x15E:0x19E].split(b"\0")[0].decode("latin-1", "replace").strip(),
            "car": head[0x6E2:0x722].split(b"\0")[0].decode("latin-1", "replace").strip(),
        }
    except Exception:
        pass
    track_id = (meta.get("venue") or info["track_id"]).lower().replace(" ", "_")
    return {
        "path": path,
        "name": os.path.basename(path),
        "size": size,
        "mtime": os.path.getmtime(path),
        "track": pretty_track(track_id, meta.get("venue", "")),
        "track_id": track_id,
        "car": pretty_car(info["car_id"], meta.get("car", "")),
        "car_id": info["car_id"],
        "date": meta.get("date", ""),
        "time": meta.get("time", ""),
    }


def scan_folder(folder: str) -> list[dict]:
    if not folder or not os.path.isdir(folder):
        return []
    files = []
    for entry in sorted(os.scandir(folder), key=lambda e: e.name.lower()):
        if entry.is_file() and entry.name.lower().endswith(".ld"):
            try:
                files.append(peek(entry.path))
            except Exception:
                continue
    return files


def import_files(paths: list[str], driver: str = "",
                 reference: bool = False) -> tuple[list[dict], list[dict]]:
    lib = load_library()
    by_sig = {s.get("signature"): s for s in lib["sessions"]}
    by_id = {s["id"]: s for s in lib["sessions"]}
    added, skipped = [], []
    for path in paths:
        try:
            sid = content_id(path)
            if sid in by_id:
                skipped.append({"file": path, "reason": "уже в библиотеке", "session": by_id[sid]})
                continue
            session = build_session(path, driver, reference=reference)
            sig = session["signature"]
            if sig in by_sig:
                old = by_sig[sig]
                shutil.rmtree(CACHE / session["id"], ignore_errors=True)
                skipped.append({"file": path, "reason": "дубликат телеметрии",
                                "session": old})
                continue
            lib["sessions"].append(session)
            by_sig[sig] = session
            by_id[sid] = session
            added.append(session)
        except Exception as exc:  # noqa: BLE001
            skipped.append({"file": path, "reason": str(exc)})
    removed = dedupe_library(lib)
    save_library(lib)
    return added, skipped


def remove_session(sid: str) -> bool:
    lib = load_library()
    before = len(lib["sessions"])
    lib["sessions"] = [s for s in lib["sessions"] if s["id"] != sid]
    save_library(lib)
    shutil.rmtree(CACHE / sid, ignore_errors=True)
    return len(lib["sessions"]) != before


def update_session(sid: str, patch: dict) -> dict | None:
    lib = load_library()
    for s in lib["sessions"]:
        if s["id"] == sid:
            ref_changed = False
            for key in ("driver", "name"):
                if key in patch and isinstance(patch[key], str):
                    s[key] = patch[key].strip() or s.get(key)
            if "reference" in patch:
                new_ref = bool(patch["reference"])
                ref_changed = bool(s.get("reference")) != new_ref
                s["reference"] = new_ref
            meta = load_meta(sid)
            if meta:
                for key in ("driver", "name", "reference"):
                    if key in patch and (isinstance(patch[key], str)
                                         or isinstance(patch[key], bool)):
                        meta[key] = s.get(key)
                (CACHE / sid / "meta.json.gz").write_bytes(
                    gzip.compress(json.dumps(jsonable(meta), ensure_ascii=False,
                                             separators=(",", ":")).encode("utf-8"), 6))
            save_library(lib)
            if ref_changed or ("driver" in patch and s.get("reference")):
                try:
                    import coach
                    coach.rebuild_learning()
                except Exception:  # noqa: BLE001
                    pass
            return s
    return None


def rename_driver(old: str, new: str) -> int:
    """Rename a driver label across every session that uses it."""
    new = (new or "").strip()
    if not new:
        return 0
    lib = load_library()
    count = 0
    for s in lib["sessions"]:
        if (s.get("driver") or "Пилот") != old:
            continue
        s["driver"] = new
        meta = load_meta(s["id"])
        if meta:
            meta["driver"] = new
            (CACHE / s["id"] / "meta.json.gz").write_bytes(
                gzip.compress(json.dumps(jsonable(meta), ensure_ascii=False,
                                         separators=(",", ":")).encode("utf-8"), 6))
        count += 1
    if count:
        save_library(lib)
        try:
            import coach
            coach.rebuild_learning()
        except Exception:  # noqa: BLE001
            pass
    return count


# ---------------------------------------------------------------- setups


def setups_root(lib: dict | None = None) -> Path:
    lib = lib or load_library()
    p = lib.get("settings", {}).get("setups_path")
    return Path(p) if p else SETUPS_DEFAULT


IMPORTED_SETUPS = DATA / "setups"


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _setup_roots() -> list[Path]:
    """ACC setups folder plus setups imported through the app."""
    roots: list[Path] = []
    acc = setups_root()
    if acc.is_dir():
        roots.append(acc.resolve())
    try:
        IMPORTED_SETUPS.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    if IMPORTED_SETUPS.is_dir():
        roots.append(IMPORTED_SETUPS.resolve())
    return roots


def _find_car_dir(root: Path, car_id: str) -> Path | None:
    try:
        dirs = [d for d in root.iterdir() if d.is_dir()]
    except OSError:
        return None
    for d in dirs:
        if _norm(d.name) == _norm(car_id):
            return d
    if not _norm(car_id):
        return None
    for d in dirs:
        name = _norm(d.name)
        if name and (name in _norm(car_id) or _norm(car_id).startswith(name)):
            return d
    return None


def _car_setups(root: Path, car_id: str, track_id: str | None) -> list[dict]:
    car_dir = _find_car_dir(root, car_id)
    if car_dir is None:
        return []
    try:
        tracks = [d for d in car_dir.iterdir() if d.is_dir()]
    except OSError:
        return []
    if track_id is None:
        chosen = tracks
    else:
        wanted = _norm(track_id)
        exact = [d for d in tracks if _norm(d.name) == wanted]
        near = [d for d in tracks if wanted and wanted in _norm(d.name)]
        chosen = exact or near
    imported = root == IMPORTED_SETUPS.resolve()
    found = []
    for d in chosen:
        for f in sorted(d.glob("*.json"), key=lambda x: x.name.lower()):
            found.append({
                "path": str(f),
                "name": f.stem,
                "track": d.name,
                "car": car_dir.name,
                "mtime": f.stat().st_mtime,
                "imported": imported,
            })
    return found


def scan_setups(car_id: str, track_id: str) -> list[dict]:
    seen: set[str] = set()
    found: list[dict] = []
    for root in _setup_roots():
        for item in _car_setups(root, car_id, track_id):
            if item["path"] in seen:
                continue
            seen.add(item["path"])
            found.append(item)
    found.sort(key=lambda x: (x.get("imported", False), x["name"].lower()))
    return found


def all_setups(car_id: str) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for root in _setup_roots():
        for item in _car_setups(root, car_id, None):
            if item["path"] in seen:
                continue
            seen.add(item["path"])
            out.append(item)
    out.sort(key=lambda x: (not x.get("imported", False), x["name"].lower()))
    return out


def _safe_component(text: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.-]+", "_", text or "").strip("._")
    return clean[:60] or "other"


def import_setup(car_id: str, track_id: str, filename: str,
                 content: str) -> dict:
    """Store a setup JSON sent from the UI so it works even outside ACC's folder."""
    if not content or len(content) > 4 * 1024 * 1024:
        raise ValueError("Файл пустой или слишком большой.")
    try:
        payload = json.loads(content)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Это не JSON-файл сета ACC.") from exc
    if not isinstance(payload, dict) or not (
            payload.get("basicSetup") or payload.get("advancedSetup")):
        raise ValueError("В файле нет basicSetup / advancedSetup — похоже, это не сет ACC.")

    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", Path(filename or "").stem).strip(" .")
    stem = (stem or "setup")[:80]
    target_dir = IMPORTED_SETUPS / _safe_component(car_id) / _safe_component(track_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    text = json.dumps(payload, ensure_ascii=False, indent=1)
    target = target_dir / f"{stem}.json"
    counter = 2
    while target.exists():
        try:
            same = target.read_text(encoding="utf-8", errors="ignore").strip() == text.strip()
        except OSError:
            same = False
        if same:
            break
        target = target_dir / f"{stem} ({counter}).json"
        counter += 1
    target.write_text(text, encoding="utf-8")
    return {
        "path": str(target),
        "name": target.stem,
        "car": car_id,
        "track": track_id,
        "imported": True,
        "mtime": target.stat().st_mtime,
    }


def safe_setup_path(path: str) -> Path | None:
    try:
        rp = Path(path).resolve()
    except (OSError, ValueError):
        return None
    if rp.suffix.lower() != ".json" or not rp.is_file():
        return None
    for root in _setup_roots():
        try:
            rp.relative_to(root)
        except ValueError:
            continue
        return rp
    return None



# ---------------------------------------------------------------- setup parser

WHEELS = ["ПЛ", "ПП", "ЗЛ", "ЗП"]

AXLES = ["Перед", "Зад"]

COMPOUNDS = {0: "Сухая", 1: "Дождевая"}

EXTRA_LABELS = {
    "fuelMix": "Смесь",
    "nPitStops": "Пит-стопы",
    "tyreSet": "Комплект шин",
    "fuelPerLap": "Расход",
    "trackBopType": "BOP",
}

SECTION_NAMES = {
    "tyres": "Шины",
    "alignment": "Развал / схождение",
    "electronics": "Электроника",
    "strategy": "Стратегия",
    "mechanicalBalance": "Механика",
    "dampers": "Амортизаторы",
    "aeroBalance": "Аэродинамика",
    "drivetrain": "Трансмиссия",
}


def _caster_deg(info: dict, raw) -> float | None:
    """Raw caster click -> degrees using the car table."""
    caster = info.get("caster")
    if isinstance(caster, tuple) and len(caster) == 2:
        return float(raw) * caster[0] + caster[1]
    if isinstance(caster, list):
        idx = int(raw)
        if 0 <= idx < len(caster):
            return caster[idx]
    return None


def _wheel_rates(info: dict, clicks) -> list[float] | None:
    """Raw wheel-rate clicks -> N/mm, one value per wheel."""
    tables = info.get("wheel_rates")
    if not tables or not isinstance(clicks, list):
        return None
    out = []
    for i, click in enumerate(clicks):
        table = tables[0 if i < 2 else 1]
        idx = int(click)
        if not 0 <= idx < len(table):
            return None
        out.append(round(float(table[idx]), 1))
    return out


def _plain(value):
    if isinstance(value, list):
        return [int(v) if float(v).is_integer() else round(float(v), 2) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return int(value) if float(value).is_integer() else round(float(value), 2)
    return value


def _setup_rows(group: str, content: dict, info: dict) -> list[dict]:
    """Build display rows for one setup group, in game units where possible."""
    rows: list[dict] = []

    def add(key, label, value, unit="", *, raw=None, layout=None, labels=None,
            note=None, converted=False):
        rows.append({
            "key": key,
            "label": label,
            "value": value,
            "unit": unit,
            "raw": jsonable(value if raw is None else raw),
            "layout": layout,
            "labels": labels,
            "note": note,
            "converted": converted,
        })

    if group == "tyres":
        compound = content.get("tyreCompound")
        if compound is not None:
            idx = int(compound)
            add("tyreCompound", "Комплект", COMPOUNDS.get(idx, f"#{idx}"),
                raw=compound, converted=idx in COMPOUNDS)

        press = content.get("tyrePressure")
        if isinstance(press, list):
            base = info.get("pressure_base")
            if base is not None:
                add("tyrePressure", "Давление",
                    [round(base + float(v) * 0.1, 1) for v in press], " psi",
                    raw=press, layout="wheel", labels=WHEELS,
                    note="холодное, как в гараже ACC", converted=True)
            else:
                add("tyrePressure", "Давление", [int(v) for v in press], "",
                    raw=press, layout="wheel", labels=WHEELS,
                    note="нет таблицы пересчёта для этой машины")
        return rows

    if group == "alignment":
        camber = content.get("camber")
        static = content.get("staticCamber")
        if isinstance(static, list) and len(static) == 4:
            add("camber", "Развал", [round(float(v), 2) for v in static], "°",
                raw=camber if isinstance(camber, list) else static,
                layout="wheel", labels=WHEELS,
                note="статический развал", converted=True)
        elif isinstance(camber, list):
            add("camber", "Развал", [int(v) for v in camber], " клик",
                raw=camber, layout="wheel", labels=WHEELS)

        toe = content.get("toe")
        toe_min = info.get("toe_min")
        if isinstance(toe, list):
            if toe_min:
                add("toe", "Схождение",
                    [round(toe_min[0 if i < 2 else 1] + float(v) / 100.0, 2)
                     for i, v in enumerate(toe)], "°",
                    raw=toe, layout="wheel", labels=WHEELS,
                    note="на колесо", converted=True)
            else:
                add("toe", "Схождение", [int(v) for v in toe], " клик",
                    raw=toe, layout="wheel", labels=WHEELS)

        lf, rf = content.get("casterLF"), content.get("casterRF")
        if lf is not None and rf is not None:
            left, right = _caster_deg(info, lf), _caster_deg(info, rf)
            if left is None or right is None:
                add("caster", "Кастор", [int(lf), int(rf)], " клик",
                    raw=[lf, rf], layout="wheel", labels=WHEELS[:2])
            elif abs(left - right) < 0.05:
                add("caster", "Кастор", round((left + right) / 2.0, 1), "°",
                    raw=[lf, rf], converted=True)
            else:
                add("caster", "Кастор", [round(left, 1), round(right, 1)], "°",
                    raw=[lf, rf], layout="wheel", labels=WHEELS[:2], converted=True)

        ratio = content.get("steerRatio")
        if ratio is not None:
            smin = info.get("steering_ratio_min")
            if smin is not None:
                add("steerRatio", "Рулевое отношение",
                    round(float(ratio) + smin, 1), raw=ratio, converted=True)
            else:
                add("steerRatio", "Рулевое отношение", int(ratio), " клик",
                    raw=ratio)
        return rows

    if group == "electronics":
        labels = {"tC1": "TC 1", "tC2": "TC 2", "abs": "ABS",
                  "eCUMap": "Карта ECU", "fuelMix": "Смесь"}
        for key, value in content.items():
            label = labels.get(key)
            if not label or isinstance(value, (dict, list)):
                continue
            if key == "eCUMap":
                add(key, label, int(value) + 1, raw=value, converted=True)
            else:
                add(key, label, int(value), raw=value)
        return rows

    if group == "strategy":
        fuel = content.get("fuel")
        if fuel is not None:
            add("fuel", "Топливо", round(float(fuel), 1), " л", raw=fuel)
        stops = content.get("nPitStops")
        if stops is not None:
            add("nPitStops", "Пит-стопы", int(stops), raw=stops)
        tset = content.get("tyreSet")
        if tset is not None:
            add("tyreSet", "Комплект шин", int(tset), raw=tset)
        fp = content.get("frontBrakePadCompound")
        rp = content.get("rearBrakePadCompound")
        if fp is not None and rp is not None:
            if int(fp) == int(rp):
                add("brakePad", "Колодки", int(fp) + 1, raw=[fp, rp],
                    note="компаунд", converted=True)
            else:
                add("brakePad", "Колодки", [int(fp) + 1, int(rp) + 1],
                    raw=[fp, rp], layout="axle", labels=AXLES,
                    note="компаунд", converted=True)
        per_lap = content.get("fuelPerLap")
        if per_lap is not None:
            add("fuelPerLap", "Расход", round(float(per_lap), 2), " л/круг",
                raw=per_lap)
        return rows

    if group == "mechanicalBalance":
        for key, label in (("aRBFront", "Стабилизатор перед"),
                           ("aRBRear", "Стабилизатор зад")):
            value = content.get(key)
            if value is not None:
                add(key, label, int(value), " клик", raw=value)

        rate = content.get("wheelRate")
        if isinstance(rate, list):
            converted = _wheel_rates(info, rate)
            if converted:
                add("wheelRate", "Пружины", converted, " Н/мм", raw=rate,
                    layout="wheel", labels=WHEELS, converted=True)
            else:
                add("wheelRate", "Пружины", [int(v) for v in rate], " клик",
                    raw=rate, layout="wheel", labels=WHEELS)

        bump = content.get("bumpStopRateUp")
        if isinstance(bump, list):
            add("bumpStopRateUp", "Отбойник, сжатие",
                [int(300 + int(v) * 100) for v in bump], " Н",
                raw=bump, layout="wheel", labels=WHEELS, converted=True)

        window = content.get("bumpStopWindow")
        if isinstance(window, list):
            add("bumpStopWindow", "Диапазон отбойника",
                [int(v) for v in window], raw=window,
                layout="wheel", labels=WHEELS)

        power = content.get("brakeTorque")
        if power is not None:
            add("brakeTorque", "Усилие тормоза", int(power) + 80, " %",
                raw=power, converted=True)

        bias = content.get("brakeBias")
        if bias is not None:
            bmin = info.get("brake_bias_min")
            if bmin is not None:
                add("brakeBias", "Баланс тормозов",
                    round(float(bias) / 5.0 + bmin, 1), " %",
                    raw=bias, converted=True)
            else:
                add("brakeBias", "Баланс тормозов", int(bias), " клик",
                    raw=bias)
        return rows

    if group == "dampers":
        for key, label in (("bumpSlow", "Сжатие slow"),
                           ("bumpFast", "Сжатие fast"),
                           ("reboundSlow", "Отбой slow"),
                           ("reboundFast", "Отбой fast")):
            value = content.get(key)
            if isinstance(value, list):
                add(key, label, [int(v) for v in value], " клик", raw=value,
                    layout="wheel", labels=WHEELS)
        return rows

    if group == "aeroBalance":
        ride = content.get("rideHeight")
        if isinstance(ride, list) and len(ride) >= 4:
            mins = info.get("ride_height_min")
            if mins:
                add("rideHeight", "Клиренс",
                    [round(mins[0] + float(ride[0]), 1),
                     round(mins[1] + float(ride[2]), 1)], " мм",
                    raw=ride, layout="axle", labels=AXLES, converted=True)
            else:
                add("rideHeight", "Клиренс", [int(ride[0]), int(ride[2])],
                    " клик", raw=ride, layout="axle", labels=AXLES)

        split = content.get("splitter")
        if split is not None:
            add("splitter", "Сплиттер", int(split) + 1, raw=split, converted=True)

        wing = content.get("rearWing")
        if wing is not None:
            add("rearWing", "Заднее крыло", int(wing), " клик", raw=wing)

        ducts = content.get("brakeDuct")
        if isinstance(ducts, list):
            add("brakeDuct", "Воздуховоды", [int(v) for v in ducts], " клик",
                raw=ducts, layout="axle", labels=AXLES[:len(ducts)])
        return rows

    if group == "drivetrain":
        preload = content.get("preload")
        if preload is not None:
            add("preload", "Преднатяг", int(preload) * 10 + 20, " Нм",
                raw=preload, converted=True)
        return rows

    for key, value in content.items():
        if isinstance(value, (dict, list)) or value is None:
            continue
        add(key, EXTRA_LABELS.get(key, key), _plain(value), raw=value)
    return rows


def parse_setup(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    car = data.get("carName", "")
    info = CAR_DATA.get(car, {})
    sections = []
    # ACC nests the groups one level down: basicSetup -> tyres/alignment/...
    for root_key in ("basicSetup", "advancedSetup"):
        root_group = data.get(root_key)
        if not isinstance(root_group, dict):
            continue
        for group, content in root_group.items():
            if not isinstance(content, dict):
                continue
            rows = _setup_rows(group, content, info)
            if rows:
                sections.append({"key": group, "name": SECTION_NAMES.get(group, group),
                                 "rows": rows})
    return {
        "path": path,
        "name": Path(path).stem,
        "car": car,
        "carName": info.get("name") or pretty_car(car),
        "converted": bool(info),
        "sections": sections,
        "raw": jsonable(data),
        "fuelPerLap": data.get("basicSetup", {}).get("strategy", {}).get("fuelPerLap"),
    }


def _raw_value(raw: dict, group: str, key: str, default=None):
    node = raw.get(group, {}) if raw else {}
    if isinstance(node, dict):
        return node.get(key, default)
    return default


# ---------------------------------------------------------------- recommendations

TARGET_PRESS = 27.2  # psi hot, dry GT3
# Companion's pressure_base separates the classes: 20.3 psi = GT3/Cup, 17 psi = GT4/TCX.
TARGET_PRESS_BY_BASE = {20.3: TARGET_PRESS, 17.0: 27.0}


def pressure_target(info: dict | None) -> float | None:
    base = (info or {}).get("pressure_base")
    if base is None:
        return None
    return TARGET_PRESS_BY_BASE.get(round(float(base), 1))


def recommendations(report: dict, setup: dict) -> list[dict]:
    raw = setup.get("raw", {})
    out: list[dict] = []

    def add(rid, severity, title, summary, why, changes=None, evidence=None):
        out.append({
            "id": rid,
            "severity": severity,
            "title": title,
            "summary": summary,
            "why": why,
            "changes": changes or [],
            "evidence": evidence or [],
        })

    info = CAR_DATA.get(setup.get("car", ""), {})
    press_base = info.get("pressure_base")
    target_press = pressure_target(info)

    # --- pressures
    pressures = report.get("pressures") or []
    cur_press = _raw_value(raw, "basicSetup", "tyres", {})
    cur_press = cur_press.get("tyrePressure") if isinstance(cur_press, dict) else None
    if pressures and target_press is None:
        add("press_unknown", "low", "Цель по давлению неизвестна",
            f"Сейчас {', '.join(f'{p:.1f}' for p in pressures)} psi.",
            "Для этой машины нет таблицы класса, поэтому ApexLab не подставляет "
            "целевое давление GT3 — ориентируйся на свою телеметрию и рекомендации "
            "производителя сета.",
            [], [{"label": "Горячее давление",
                  "value": " / ".join(f"{p:.1f}" for p in pressures) + " psi"}])
    if pressures and target_press is not None:
        diffs = [target_press - p for p in pressures]
        if any(abs(d) >= 0.18 for d in diffs):
            changes = []
            if cur_press and press_base is not None:
                for i, d in enumerate(diffs):
                    if i < len(cur_press):
                        cold = press_base + float(cur_press[i]) * 0.1
                        changes.append({
                            "label": WHEELS[i],
                            "from": round(cold, 1),
                            "to": round(cold + d, 1),
                            "raw_from": cur_press[i],
                            "raw_to": int(round((cold + d - press_base) * 10)),
                            "unit": "psi",
                        })
            worst = max(abs(d) for d in diffs)
            add("press", "high" if worst > 0.55 else "mid",
                f"Подогнать горячие давления под {target_press:.1f} psi",
                f"Сейчас {', '.join(f'{p:.1f}' for p in pressures)} psi. Разница с целью "
                f"до {worst:.1f} psi.",
                "ACC даёт максимум сцепления в узком окне горячего давления. "
                "В гараже выставляется холодное давление: сдвинь его ровно на эту "
                "разницу с шагом 0.1 psi.",
                changes,
                [{"label": "Горячее давление", "value": " / ".join(f"{p:.1f}" for p in pressures) + " psi"}])

    # --- brake temperatures / ducts
    bt = report.get("brake_temps") or []
    ducts = _raw_value(raw, "advancedSetup", "aeroBalance", {})
    ducts = ducts.get("brakeDuct") if isinstance(ducts, dict) else None
    if len(bt) == 4:
        front, rear = max(bt[0], bt[1]), max(bt[2], bt[3])
        changes = []
        if front > 805 and ducts:
            changes.append({"label": "Воздуховоды перед", "from": ducts[0],
                            "to": min(int(ducts[0]) + 1, 6), "unit": "клик"})
        if rear > 720 and ducts and len(ducts) > 1:
            changes.append({"label": "Воздуховоды зад", "from": ducts[1],
                            "to": min(int(ducts[1]) + 1, 6), "unit": "клик"})
        if changes:
            add("brake_temp", "mid", "Охладить тормоза",
                f"Средние температуры: перед {front:.0f} °C, зад {rear:.0f} °C.",
                "Выше 800 °C спереди колодки начинают плыть, а точка схватывания уезжает. "
                "Один клик воздуховода снимает примерно 25–40 °C.",
                changes, [{"label": "Пик", "value": f"{max(bt):.0f} °C"}])
        elif front < 380 and ducts:
            add("brake_temp_cold", "low", "Тормоза недогреты",
                f"Передние тормоза в среднем {front:.0f} °C.",
                "Слишком открытые воздуховоды не дают колодкам выйти в рабочее окно — "
                "закрой воздуховоды на 1 клик.", [
                    {"label": "Воздуховоды перед", "from": ducts[0],
                     "to": max(int(ducts[0]) - 1, 0), "unit": "клик"}])

    # --- lock ups
    lock = (report.get("events") or {}).get("lock", {}).get("count", 0)
    if lock >= max(2, report.get("laps", 1) // 3):
        bias = _raw_value(raw, "advancedSetup", "mechanicalBalance", {}).get("brakeBias")
        absv = _raw_value(raw, "basicSetup", "electronics", {}).get("abs")
        changes = []
        shift = "на 1 клик"
        if bias is not None:
            bias_min = info.get("brake_bias_min")
            if bias_min is not None:
                current = float(bias) / 5.0 + bias_min
                changes.append({"label": "Баланс тормозов",
                                "from": round(current, 1),
                                "to": round(current - 0.4, 1), "unit": "%"})
                shift = "на 0.4% (2 клика)"
            else:
                changes.append({"label": "Баланс тормозов", "from": int(bias),
                                "to": int(bias) - 1, "unit": "клик"})
        if absv is not None and int(absv) < 10:
            changes.append({"label": "ABS", "from": absv, "to": int(absv) + 1, "unit": ""})
        corners = ", ".join(c["name"] for c in (report["events"]["lock"].get("corners") or [])[:3])
        add("lock", "high", "Убрать блокировки передних",
            f"{lock} блокировок за сессию" + (f", чаще всего: {corners}." if corners else "."),
            f"Передние колёса блокируются раньше, чем нужно. Сдвинь баланс назад {shift} "
            "и/или подними ABS на 1: это стабилизирует торможение без потери замедления.",
            changes, [{"label": "Блокировки", "value": f"{lock}"}])

    # --- wheel spin
    spin = (report.get("events") or {}).get("spin", {}).get("count", 0)
    if spin >= max(2, report.get("laps", 1) // 4):
        tc1 = _raw_value(raw, "basicSetup", "electronics", {}).get("tC1")
        preload = _raw_value(raw, "advancedSetup", "drivetrain", {}).get("preload")
        changes = []
        if tc1 is not None and int(tc1) < 10:
            changes.append({"label": "TC1", "from": tc1, "to": int(tc1) + 1, "unit": ""})
        if preload is not None:
            current = int(preload) * 10 + 20
            changes.append({"label": "Преднатяг", "from": current,
                            "to": current + 10, "unit": "Нм"})
        add("spin", "mid", "Побороть пробуксовку на выходе",
            f"{spin} эпизодов пробуксовки за сессию.",
            "Задняя ось проскальзывает на выходе из медленных поворотов. "
            "Начни с TC1 +1 — это дешевле по времени. Если пробуксовка остаётся, "
            "+10 Нм преднатяга сильнее блокирует дифференциал и ровнее делит момент "
            "между задними колёсами; в обмен машина станет чуть менее охотной на входе.",
            changes, [{"label": "Пробуксовки", "value": f"{spin}"}])

    # --- bottoming
    bottom = (report.get("events") or {}).get("bottom", {}).get("count", 0)
    if bottom >= max(3, report.get("laps", 1) // 2):
        ride = _raw_value(raw, "advancedSetup", "aeroBalance", {}).get("rideHeight")
        bump = _raw_value(raw, "advancedSetup", "mechanicalBalance", {}).get("bumpStopRateUp")
        changes = []
        ride_min = info.get("ride_height_min")
        if ride and len(ride) >= 4:
            if ride_min:
                front = ride_min[0] + float(ride[0])
                rear = ride_min[1] + float(ride[2])
                changes.append({"label": "Клиренс перед", "from": round(front, 1),
                                "to": round(front + 2, 1), "unit": "мм"})
                changes.append({"label": "Клиренс зад", "from": round(rear, 1),
                                "to": round(rear + 2, 1), "unit": "мм"})
            else:
                changes.append({"label": "Клиренс перед", "from": int(ride[0]),
                                "to": int(ride[0]) + 2, "unit": "клик"})
                changes.append({"label": "Клиренс зад", "from": int(ride[2]),
                                "to": int(ride[2]) + 2, "unit": "клик"})
        if bump and len(bump) >= 4:
            changes.append({"label": "Отбойник, сжатие",
                            "from": int(300 + int(bump[0]) * 100),
                            "to": int(400 + int(bump[0]) * 100), "unit": "Н"})
        add("bottom", "mid", "Подвеска пробивает отбойники",
            f"{bottom} эпизодов контакта с отбойником.",
            "Пробой делает шасси непредсказуемым на поребриках и в торможении. "
            "Если пробои в основном на кербах — подними пружины/отбойники, если на прямых — клиренс.",
            changes, [{"label": "Пробои", "value": f"{bottom}"}])

    # --- balance
    bal = report.get("balance")
    if bal is not None and abs(bal) > 0.07:
        arb_f = _raw_value(raw, "advancedSetup", "mechanicalBalance", {}).get("aRBFront")
        arb_r = _raw_value(raw, "advancedSetup", "mechanicalBalance", {}).get("aRBRear")
        wing = _raw_value(raw, "advancedSetup", "aeroBalance", {}).get("rearWing")
        changes = []
        if bal < 0:  # understeer
            if arb_f is not None:
                changes.append({"label": "Стабилизатор перед", "from": arb_f,
                                "to": max(0, int(arb_f) - 1), "unit": "клик"})
            if arb_r is not None:
                changes.append({"label": "Стабилизатор зад", "from": arb_r,
                                "to": min(12, int(arb_r) + 1), "unit": "клик"})
            if wing is not None and int(wing) > 0:
                changes.append({"label": "Заднее крыло", "from": wing,
                                "to": max(0, int(wing) - 1), "unit": "клик"})
            title = "Недостаточная поворачиваемость"
            text = "Машина просит больше руля, чем даёт траектория."
            why = "Передняя ось теряет больше сцепления, чем задняя. Смягчить передний стабилизатор, "
            why += "усилить задний и/или снять немного заднего крыла."
        else:
            if arb_f is not None:
                changes.append({"label": "Стабилизатор перед", "from": arb_f,
                                "to": min(12, int(arb_f) + 1), "unit": "клик"})
            if arb_r is not None:
                changes.append({"label": "Стабилизатор зад", "from": arb_r,
                                "to": max(0, int(arb_r) - 1), "unit": "клик"})
            if wing is not None:
                changes.append({"label": "Заднее крыло", "from": wing,
                                "to": min(12, int(wing) + 1), "unit": "клик"})
            title = "Избыточная поворачиваемость"
            text = "Задняя ось уезжает — машина вращается быстрее, чем нужно."
            why = "Жёстче передний стабилизатор и мягче задний стабилизируют заднюю ось; "
            why += "плюс клик заднего крыла добавит уверенности на выходе."
        add("balance", "mid", title, text, why, changes,
            [{"label": "Индекс баланса", "value": f"{bal:+.2f}"}])

    # --- tyre temperatures (informational)
    tt = report.get("tyre_temps") or []
    if tt and max(tt) > 96:
        add("tyre_temp", "low", "Шины перегреваются",
            f"Максимальная средняя температура колеса {max(tt):.0f} °C.",
            "Держи давление в окне и не перегревай шину длинными сериями — "
            "перегретая шина теряет пик сцепления уже через 2–3 круга.", [],
            [{"label": "Температуры", "value": " / ".join(f"{t:.0f}" for t in tt) + " °C"}])

    order = {"high": 0, "mid": 1, "low": 2}
    out.sort(key=lambda x: order.get(x["severity"], 3))
    return out
