"""ApexLab — local ACC telemetry studio. Standard library HTTP server."""
from __future__ import annotations

import json
import mimetypes
import os
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import session as store
import coach

ROOT = Path(__file__).resolve().parent
# When frozen by PyInstaller the web assets live in the unpacked bundle.
ASSETS = Path(getattr(sys, "_MEIPASS", str(ROOT)))
WEB = ASSETS / "web"
# The beta build ships a marker file; APEX_CHANNEL=beta switches a dev run.
BETA_FLAG = ASSETS / "beta.flag"
CHANNEL = "beta" if BETA_FLAG.exists() or os.environ.get("APEX_CHANNEL") == "beta" else "release"
BUILD_VERSION = BETA_FLAG.read_text(encoding="utf-8").strip() if BETA_FLAG.exists() else ""

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


def detect_acc() -> dict:
    home = Path(os.environ.get("USERPROFILE", str(Path.home())))
    candidates = []
    for base in (os.environ.get("OneDrive"), home / "OneDrive", home):
        if not base:
            continue
        b = Path(base)
        candidates += [b / "Документы" / "Assetto Corsa Competizione",
                       b / "Documents" / "Assetto Corsa Competizione",
                       b / "Документы" / "Assetto Corsa Competizione"]
    candidates.append(home / "Documents" / "Assetto Corsa Competizione")
    for c in candidates:
        if c.is_dir():
            return {"acc_path": str(c), "motec_path": str(c / "MoTeC"),
                    "setups_path": str(c / "Setups")}
    return {"acc_path": str(store.ACC_DEFAULT),
            "motec_path": str(store.MOTEC_DEFAULT),
            "setups_path": str(store.SETUPS_DEFAULT)}


def light(s: dict) -> dict:
    return s


def collect_drivers(sessions: list[dict]) -> list[dict]:
    by: dict[str, dict] = {}
    for s in sessions:
        name = s.get("driver") or "Пилот"
        d = by.setdefault(name, {
            "name": name, "sessions": [], "tracks": {},
            "best": None, "laps": 0, "clean_laps": 0,
            "clean_sessions": 0, "unclean_sessions": 0,
            "score": 0.0, "consistency": 0.0, "technique": 0.0,
            "braking": 0.0, "traction": 0.0, "balance_score": 0.0,
            "smooth": 0.0, "pace": 0.0,
            "events": {"lock": 0, "spin": 0, "bottom": 0, "brake_temp": 0},
            "pressures": [0, 0, 0, 0], "brake_temps": [0, 0, 0, 0], "n": 0,
        })
        rep = s.get("report") or {}
        clean = bool(rep.get("clean"))
        d["sessions"].append(s["id"])
        d["laps"] += rep.get("laps", 0) or 0
        d["clean_laps"] += rep.get("clean_laps", 0) or 0
        track = s.get("track") or "—"
        tr = d["tracks"].setdefault(track, {"track": track, "best": None, "sessions": 0})
        tr["sessions"] += 1
        if clean and s.get("best_time"):
            tr["best"] = s["best_time"] if tr["best"] is None else min(tr["best"], s["best_time"])
            d["best"] = s["best_time"] if d["best"] is None else min(d["best"], s["best_time"])
        ev = rep.get("events") or {}
        for k in d["events"]:
            d["events"][k] += (ev.get(k) or {}).get("count", 0)
        if not clean:
            d["unclean_sessions"] += 1
            continue
        d["clean_sessions"] += 1
        weight = max(1, rep.get("laps", 1) or 1)
        for k in ("score", "consistency", "technique", "braking", "traction",
                  "balance_score", "smooth", "pace"):
            v = rep.get(k)
            if v is not None:
                d[k] += float(v) * weight
        d["n"] += weight
        for i in range(4):
            d["pressures"][i] += (rep.get("pressures") or [0, 0, 0, 0])[i] * weight
            d["brake_temps"][i] += (rep.get("brake_temps") or [0, 0, 0, 0])[i] * weight
    out = []
    for d in by.values():
        if d["n"]:
            for k in ("score", "consistency", "technique", "braking", "traction",
                      "balance_score", "smooth", "pace"):
                d[k] = round(d[k] / d["n"], 1)
            d["pressures"] = [round(x / d["n"], 2) for x in d["pressures"]]
            d["brake_temps"] = [round(x / d["n"], 0) for x in d["brake_temps"]]
        d["tracks"] = sorted(d["tracks"].values(), key=lambda t: (t["best"] is None, t["best"] or 0))
        d.pop("n", None)
        out.append(d)
    out.sort(key=lambda x: (-(x.get("score") or 0), x["best"] or 9e9))
    return out


def cache_stats() -> dict:
    total = files = 0
    if store.CACHE.exists():
        for p in store.CACHE.rglob("*"):
            if p.is_file():
                files += 1
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    return {"cache_bytes": total, "cache_files": files}


def state_payload() -> dict:
    lib = store.load_library()
    all_sessions = lib.get("sessions", [])
    sessions = [s for s in all_sessions if not s.get("reference")]
    references = [s for s in all_sessions if s.get("reference")]
    # Attach the class-specific pressure target without touching the cached library.
    def with_target(s):
        if isinstance(s.get("report"), dict):
            return {**s, "report": {**s["report"],
                                    "pressure_target": store.pressure_target(
                                        store.CAR_DATA.get(s.get("car_id") or s.get("car") or "", {}))}}
        return s
    sessions = [with_target(s) for s in sessions]
    references = [with_target(s) for s in references]
    session_paths = {s["file"] for s in all_sessions if s.get("file")}
    folders = sorted({os.path.dirname(p) for p in session_paths}) or [lib["settings"].get("motec_path")]
    laps = sum(len(s.get("laps") or []) for s in sessions)
    clean = sum(int(s.get("clean_laps") or 0) for s in sessions)
    km = sum(float((s.get("report") or {}).get("km") or 0) for s in sessions)
    series = coach.group_sessions(sessions)
    return {
        "sessions": sessions,
        "references": references,
        "series": series,
        "drivers": collect_drivers(sessions),
        "settings": lib.get("settings", {}),
        "folders": folders,
        "version": store.VERSION,
        "app_version": BUILD_VERSION or store.APP_VERSION,
        "channel": CHANNEL,
        "stats": {"sessions": len(sessions), "references": len(references),
                  "series": len(series), "laps": laps, "clean_laps": clean,
                  "km": round(km, 1), **cache_stats()},
    }


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    server_version = "ApexLab/2.0"

    def log_message(self, fmt, *args):
        if os.environ.get("APEX_DEBUG"):
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # -------------------------------------------------------------- helpers
    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store"):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def json(self, payload, status: int = 200):
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, raw, "application/json; charset=utf-8")

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ApiError(f"Некорректный JSON: {exc}") from exc

    def static(self, rel: str):
        candidate = (WEB / rel).resolve()
        try:
            candidate.relative_to(WEB.resolve())
        except Exception:
            raise ApiError("Нет доступа", 404)
        if not candidate.is_file():
            raise ApiError("Файл не найден", 404)
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, candidate.read_bytes(), ctype, "no-cache")

    # -------------------------------------------------------------- routing
    def do_GET(self):  # noqa: N802
        self.route("GET")

    def do_POST(self):  # noqa: N802
        self.route("POST")

    def do_PATCH(self):  # noqa: N802
        self.route("PATCH")

    def do_DELETE(self):  # noqa: N802
        self.route("DELETE")

    def route(self, method: str):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:], qs)
            if path in ("/", "/index.html"):
                return self.static("index.html")
            return self.static(path.lstrip("/"))
        except ApiError as exc:
            self.json({"error": str(exc)}, exc.status)
        except FileNotFoundError:
            self.json({"error": "Не найдено"}, 404)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.json({"error": f"Внутренняя ошибка: {exc}"}, 500)

    def api(self, method: str, resource: str, qs: dict):
        parts = [p for p in resource.split("/") if p]

        if method == "GET" and resource == "state":
            return self.json(state_payload())

        if method == "GET" and resource == "settings":
            lib = store.load_library()
            return self.json({"settings": lib.get("settings", {}), "detected": detect_acc()})

        if method == "PATCH" and resource == "settings":
            patch = self.body()
            lib = store.load_library()
            for key in ("acc_path", "motec_path", "setups_path"):
                if isinstance(patch.get(key), str) and patch[key].strip():
                    lib["settings"][key] = patch[key].strip().rstrip("\\/")
            store.save_library(lib)
            return self.json({"ok": True, "settings": lib["settings"]})

        if method == "GET" and resource == "scan":
            folder = qs.get("path") or store.load_library()["settings"].get("motec_path")
            files = store.scan_folder(folder)
            lib = store.load_library()
            known = {s["file"] for s in lib["sessions"]}
            sigs = {s.get("signature") for s in lib["sessions"]}
            for f in files:
                f["imported"] = f["path"] in known
            return self.json({"folder": folder, "files": files,
                              "exists": os.path.isdir(folder)})

        if method == "POST" and resource == "import":
            data = self.body()
            paths = [p for p in (data.get("paths") or []) if isinstance(p, str)]
            driver = data.get("driver") or ""
            reference = bool(data.get("reference"))
            added, skipped = store.import_files(paths, driver, reference=reference)
            if reference and added:
                try:
                    coach.rebuild_learning()
                except Exception:  # noqa: BLE001
                    pass
            return self.json({"added": added, "skipped": skipped,
                              "state": state_payload()})

        if method == "POST" and resource == "driver":
            data = self.body()
            count = store.rename_driver(data.get("from") or "Пилот",
                                        data.get("to") or "")
            if not count:
                raise ApiError("Пилот не найден или пустое имя", 404)
            return self.json({"ok": True, "renamed": count, "state": state_payload()})

        if parts and parts[0] == "session" and len(parts) >= 2:
            sid = parts[1]
            if method == "GET" and len(parts) == 2:
                meta = store.load_meta(sid)
                if not meta:
                    raise ApiError("Сессия не найдена", 404)
                return self.json(meta)
            if method == "GET" and len(parts) == 4 and parts[2] == "lap":
                try:
                    idx = int(parts[3])
                except ValueError as exc:
                    raise ApiError("Плохой номер круга") from exc
                pack = store.load_lap(sid, idx)
                if not pack:
                    raise ApiError("Круг не найден", 404)
                return self.json(pack)
            if method == "PATCH" and len(parts) == 2:
                data = self.body()
                updated = store.update_session(sid, data)
                if not updated:
                    raise ApiError("Сессия не найдена", 404)
                return self.json({"session": updated, "state": state_payload()})
            if method == "DELETE" and len(parts) == 2:
                ok = store.remove_session(sid)
                return self.json({"ok": ok, "state": state_payload()})

        if method == "GET" and resource == "trajectory":
            sid = qs.get("session", "")
            ref = qs.get("ref", "")
            try:
                lap = int(qs.get("lap", "-1"))
            except ValueError as exc:
                raise ApiError("Плохой номер круга") from exc
            ref_sid = ref_idx = None
            if ":" in ref:
                ref_sid, _, raw_idx = ref.rpartition(":")
                try:
                    ref_idx = int(raw_idx)
                except ValueError:
                    ref_sid = ref_idx = None
            data = store.trajectory(sid, lap, ref_sid, ref_idx)
            if not data:
                raise ApiError("Не удалось сравнить траектории", 404)
            return self.json(data)

        if method == "GET" and resource == "coach":
            data = coach.session_analysis(qs.get("session", ""), qs.get("ref", ""))
            if not data:
                raise ApiError("Сессия для разбора не найдена", 404)
            return self.json(data)

        if method == "GET" and resource == "series":
            data = coach.series_detail(qs.get("session", ""))
            if not data:
                raise ApiError("Серия не найдена", 404)
            return self.json(data)

        if method == "GET" and resource == "learning":
            return self.json(coach.learning_payload())

        if method == "POST" and resource == "learning":
            coach.rebuild_learning()
            return self.json(coach.learning_payload())

        if method == "GET" and resource == "setups":
            car = qs.get("car", "")
            track = qs.get("track", "")
            exact = store.scan_setups(car, track)
            everything = store.all_setups(car)
            root = store.setups_root()
            return self.json({"exact": exact, "all": everything,
                              "root": str(root), "root_exists": root.is_dir(),
                              "imported_root": str(store.IMPORTED_SETUPS)})

        if method == "POST" and resource == "setups/import":
            data = self.body()
            meta = store.load_meta(data.get("session") or "") if data.get("session") else None
            car = ((meta or {}).get("car_id") or (meta or {}).get("car")
                   or data.get("car") or "")
            track = ((meta or {}).get("track_id") or (meta or {}).get("track")
                     or data.get("track") or "")
            try:
                item = store.import_setup(car, track, data.get("filename") or "",
                                          data.get("content") or "")
            except ValueError as exc:
                raise ApiError(str(exc), 400)
            try:
                item["setup"] = store.parse_setup(item["path"])
            except Exception:  # noqa: BLE001
                item["setup"] = None
                item["warning"] = "Сет сохранён, но разобрать его не удалось."
            return self.json(item)

        if method == "GET" and resource == "setup":
            path = qs.get("path", "")
            safe = store.safe_setup_path(path)
            if not safe:
                raise ApiError("Сет не найден", 404)
            return self.json(store.parse_setup(str(safe)))

        if method == "POST" and resource == "recommend":
            data = self.body()
            sid = data.get("session")
            meta = store.load_meta(sid)
            if not meta:
                raise ApiError("Сессия не найдена", 404)
            parsed = {"path": "", "name": "Телеметрия", "car": meta.get("car", ""),
                      "sections": [], "raw": {}}
            if data.get("setup"):
                safe = store.safe_setup_path(data.get("setup", ""))
                if not safe:
                    raise ApiError("Сет не найден", 404)
                parsed = store.parse_setup(str(safe))
            recs = store.recommendations(meta.get("report") or {}, parsed)
            car_id = meta.get("car_id") or parsed.get("car") or ""
            return self.json({"setup": parsed, "recommendations": recs,
                              "target_pressure": store.pressure_target(
                                  store.CAR_DATA.get(car_id, {})),
                              "session": {"id": sid, "driver": meta.get("driver"),
                                          "track": meta.get("track"), "car": meta.get("car"),
                                          "report": meta.get("report")}})

        if method == "POST" and resource == "reveal":
            data = self.body()
            path = data.get("path") or ""
            if not path or not os.path.exists(path):
                raise ApiError("Папка не найдена", 404)
            if os.name == "nt":
                os.startfile(path)  # noqa: S606
            elif sys.platform == "darwin":
                os.system(f'open "{path}"')  # noqa: S605
            else:
                os.system(f'xdg-open "{path}"')  # noqa: S605
            return self.json({"ok": True})

        if method == "GET" and resource == "laps":
            lib = store.load_library()
            rows = []
            for s in lib["sessions"]:
                for lap in s.get("laps", []):
                    rows.append({
                        "session": s["id"],
                        "driver": s.get("driver"),
                        "track": s.get("track"),
                        "car": s.get("car"),
                        "index": lap["index"],
                        "time": lap["time"],
                        "valid": lap["valid"],
                        "tags": lap.get("tags", []),
                        "best": lap["index"] == s.get("best_index"),
                        "date": s.get("date"),
                    })
            return self.json({"laps": rows})

        raise ApiError("Неизвестный запрос", 404)


def free_port(start: int = 8765) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def create_server(port: int) -> ThreadingHTTPServer:
    """HTTP server bound to the loopback interface."""
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    if os.name == "nt" and getattr(sys, "frozen", False):
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW("ApexLab — телеметрия ACC")
        except Exception:  # noqa: BLE001
            pass

    try:
        import numpy  # noqa: F401
    except ImportError:
        print("Нужен numpy. Установи:  python -m pip install numpy")
        input("Enter — выйти")
        return

    lib = store.load_library()
    settings = lib.get("settings", {})
    if not settings.get("acc_path") or not os.path.isdir(settings.get("motec_path", "")):
        detected = detect_acc()
        settings.update(detected)
        lib["settings"] = settings
        store.save_library(lib)

    port = free_port(8765)
    url = f"http://127.0.0.1:{port}/"
    server = create_server(port)
    print("=" * 62)
    print("  APEXLAB  ·  ACC telemetry studio")
    print(f"  Открываю {url}")
    print("  Закрой это окно, чтобы остановить.")
    print("=" * 62)
    if os.environ.get("APEXLAB_NO_BROWSER") == "1":
        print("  Браузер не открываю (APEXLAB_NO_BROWSER=1).")
    else:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        if getattr(sys, "frozen", False):
            try:
                input("\nEnter — закрыть")
            except EOFError:
                pass
        raise
