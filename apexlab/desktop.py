"""ApexLab — native desktop shell.

Starts the local HTTP server in a background thread and shows the UI in a
native window (WebView2 via pywebview).  Falls back to the default browser if
the native runtime is unavailable.

All diagnostics go to ``data/apexlab.log`` because the packaged build runs
without a console.
"""
from __future__ import annotations

import ctypes
import json
import logging
import os
import socket
import sys
import threading
import time
import traceback
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

import server as http_server
import session as store

APP_NAME = "ApexLab"
APP_VERSION = "2.0.0"
TITLE = "ApexLab — телеметрия ACC"

ROOT = store.ROOT
DATA = store.DATA
UI_FILE = DATA / "ui.json"
LOG_FILE = DATA / "apexlab.log"
ASSETS = Path(getattr(sys, "_MEIPASS", str(Path(__file__).resolve().parent)))
ICON = ASSETS / "icon.ico"

DEFAULT_WIDTH = 1440
DEFAULT_HEIGHT = 900
MIN_WIDTH = 1120
MIN_HEIGHT = 720

THEME_COLORS = {
    "carbon": {"bg": "#07090c", "text": "#e9eff6", "line": "#202733", "dark": True},
    "midnight": {"bg": "#05070f", "text": "#e7efff", "line": "#1a2840", "dark": True},
    "ember": {"bg": "#0b0806", "text": "#f7eee2", "line": "#332519", "dark": True},
    "violet": {"bg": "#08060f", "text": "#f0eaff", "line": "#251c3c", "dark": True},
    "daylight": {"bg": "#eef1f6", "text": "#101725", "line": "#dde3ec", "dark": False},
    "mono": {"bg": "#ffffff", "text": "#0a0a0a", "line": "#dcdcdc", "dark": False},
    "graphite": {"bg": "#141517", "text": "#f0f2f4", "line": "#2e3237", "dark": True},
}

log = logging.getLogger("apexlab")


# --------------------------------------------------------------------- logging
def setup_logging() -> None:
    if log.handlers:
        return
    DATA.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s", "%Y-%m-%d %H:%M:%S")
    try:
        handler = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        handler.setFormatter(fmt)
        log.addHandler(handler)
    except Exception:  # noqa: BLE001 - read-only folder must not break startup
        pass
    if sys.stderr is not None:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        log.addHandler(stream)


def show_error(title: str, text: str) -> None:
    """Report a fatal error even when there is no console."""
    log.error("%s: %s", title, text)
    if os.name != "nt":
        return
    try:
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)  # MB_ICONERROR
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ ui storage
_ui_lock = threading.Lock()


def load_ui() -> dict:
    try:
        # utf-8-sig: a hand-edited file saved by Notepad may carry a BOM.
        data = json.loads(UI_FILE.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - missing or broken file
        return {}


def save_ui(patch: dict | None = None) -> dict:
    """Merge ``patch`` into ui.json and write it atomically."""
    with _ui_lock:
        ui = load_ui()
        if patch:
            ui.update(patch)
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            tmp = UI_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(ui, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, UI_FILE)
        except Exception as exc:  # noqa: BLE001
            log.warning("не удалось сохранить %s: %s", UI_FILE, exc)
        return ui


# ------------------------------------------------------------------- geometry
def _dpi_scale() -> float:
    if os.name != "nt":
        return 1.0
    try:
        return max(1.0, ctypes.windll.user32.GetDpiForSystem() / 96.0)
    except Exception:  # noqa: BLE001
        return 1.0


def logical_screen() -> tuple[int, int]:
    if os.name != "nt":
        return 1920, 1080
    try:
        raw_w = ctypes.windll.user32.GetSystemMetrics(0)
        raw_h = ctypes.windll.user32.GetSystemMetrics(1)
        scale = _dpi_scale()
        return int(raw_w / scale), int(raw_h / scale)
    except Exception:  # noqa: BLE001
        return 1920, 1080


def initial_geometry(ui: dict) -> dict:
    screen_w, screen_h = logical_screen()
    win = ui.get("window") if isinstance(ui.get("window"), dict) else {}

    width = int(win.get("width") or min(DEFAULT_WIDTH, screen_w - 80))
    height = int(win.get("height") or min(DEFAULT_HEIGHT, screen_h - 80))
    width = max(MIN_WIDTH, min(width, max(MIN_WIDTH, screen_w - 40)))
    height = max(MIN_HEIGHT, min(height, max(MIN_HEIGHT, screen_h - 40)))

    x = win.get("x")
    y = win.get("y")
    if not isinstance(x, int) or not isinstance(y, int) or not _on_screen(x, y, width, height, screen_w, screen_h):
        x = None
        y = None

    return {
        "width": width,
        "height": height,
        "x": x,
        "y": y,
        "maximized": bool(win.get("maximized")),
        "theme": str(ui.get("theme") or "carbon"),
    }


def _on_screen(x: int, y: int, width: int, height: int, screen_w: int, screen_h: int) -> bool:
    # Keep at least a strip of the title bar reachable.
    if x <= -width + 160 or x >= screen_w - 160:
        return False
    if y < -8 or y > screen_h - 80:
        return False
    return True


# --------------------------------------------------------- frameless window
# The native caption is gone, so window actions go through Win32 messages.  A
# custom HTML titlebar drives them; the messages are safe to send from worker
# threads, which is how pywebview dispatches JS API calls.
WM_CLOSE = 0x0010
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

_HT = {
    "left": 10,
    "right": 11,
    "top": 12,
    "topleft": 13,
    "topright": 14,
    "bottom": 15,
    "bottomleft": 16,
    "bottomright": 17,
}


def _user32():
    """user32 with pointer-safe prototypes (64-bit HWND)."""
    user32 = ctypes.windll.user32
    user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.ReleaseCapture.restype = ctypes.c_bool
    user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.PostMessageW.restype = ctypes.c_bool
    user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    user32.SetWindowPos.restype = ctypes.c_bool
    user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.IsZoomed.argtypes = [ctypes.c_void_p]
    user32.IsZoomed.restype = ctypes.c_bool
    user32.IsIconic.argtypes = [ctypes.c_void_p]
    user32.IsIconic.restype = ctypes.c_bool
    user32.GetCursorPos.argtypes = [ctypes.c_void_p]
    user32.GetWindowLongPtrW.restype = ctypes.c_void_p
    user32.GetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    return user32


def _hwnd(window) -> int:
    try:
        return int(window.native.Handle.ToInt64())
    except Exception:  # noqa: BLE001 - window may be closing
        return 0


def _cursor_lparam(user32) -> int:
    """Pack the cursor position the way WM_NCLBUTTONDOWN expects."""
    class _Point(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    point = _Point()
    user32.GetCursorPos(ctypes.byref(point))
    return ((point.y & 0xFFFF) << 16) | (point.x & 0xFFFF)


def _native_drag(hwnd: int, hit_test: int) -> None:
    """Hand the drag/resize loop to Windows (keeps Aero Snap smooth)."""
    user32 = _user32()
    user32.ReleaseCapture()
    user32.SendMessageW(ctypes.c_void_p(hwnd), WM_NCLBUTTONDOWN,
                        ctypes.c_size_t(hit_test), ctypes.c_ssize_t(_cursor_lparam(user32)))


def _run_on_ui(window, callback) -> None:
    """Run a mouse-capture action on the WinForms thread.

    WebView2 owns the mouse capture on the UI thread.  ``ReleaseCapture`` from
    the pywebview API worker therefore does nothing and Windows never starts
    the move/size loop; marshalling the call fixes frameless drag and resize.
    """
    native = getattr(window, "native", None)
    if native is None:
        callback()
        return
    try:
        from System import Action
    except Exception:  # noqa: BLE001 - pythonnet is unavailable off-Windows
        callback()
        return
    try:
        if not native.InvokeRequired:
            callback()
            return
        native.Invoke(Action(callback))
    except Exception as exc:  # noqa: BLE001 - the window may be closing
        log.debug("оконное действие не выполнено: %s", exc)


# -------------------------------------------------------------------- window
class Bridge:
    """Methods exposed to JavaScript as ``window.pywebview.api``.

    Keep every attribute underscore-prefixed: pywebview introspects public
    attributes recursively when it builds the JS API, and a pywebview window
    object must never be walked that way.
    """

    def __init__(self, topmost: bool = False) -> None:
        self._window = None
        self._theme = "carbon"
        self._topmost = bool(topmost)

    # -- appearance --------------------------------------------------------
    def set_theme(self, theme) -> dict:
        theme = str(theme or "")
        if theme not in THEME_COLORS:
            theme = "carbon"
        if theme != self._theme:
            self._theme = theme
            save_ui({"theme": theme})
            log.info("тема: %s", theme)
        return {"ok": True, "theme": theme}

    def app_info(self) -> dict:
        return {
            "version": APP_VERSION,
            "theme": self._theme,
            "native": True,
            "topmost": self._topmost,
        }

    # -- frameless shell ---------------------------------------------------
    def window_state(self) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if not hwnd:
            return {"native": False, "maximized": False, "minimized": False,
                    "topmost": self._topmost}
        user32 = _user32()
        return {
            "native": True,
            "maximized": bool(user32.IsZoomed(ctypes.c_void_p(hwnd))),
            "minimized": bool(user32.IsIconic(ctypes.c_void_p(hwnd))),
            "topmost": self._topmost,
        }

    def window_minimize(self) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if hwnd:
            _user32().ShowWindow(ctypes.c_void_p(hwnd), SW_MINIMIZE)
        return {"ok": bool(hwnd)}

    def window_toggle_maximize(self) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if not hwnd:
            return {"ok": False, "maximized": False}
        user32 = _user32()
        zoomed = bool(user32.IsZoomed(ctypes.c_void_p(hwnd)))
        user32.ShowWindow(ctypes.c_void_p(hwnd), SW_RESTORE if zoomed else SW_MAXIMIZE)
        return {"ok": True, "maximized": not zoomed}

    def window_close(self) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if hwnd:
            _user32().PostMessageW(ctypes.c_void_p(hwnd), WM_CLOSE, 0, 0)
        return {"ok": bool(hwnd)}

    def window_drag(self) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if hwnd:
            log.debug("перетаскивание окна")
            _run_on_ui(self._window, lambda: _native_drag(hwnd, HTCAPTION))
        return {"ok": bool(hwnd)}

    def window_resize(self, edge) -> dict:
        hwnd = _hwnd(self._window) if self._window is not None else 0
        code = _HT.get(str(edge or ""))
        if hwnd and code:
            log.debug("изменение размера: %s", edge)
            _run_on_ui(self._window, lambda: _native_drag(hwnd, code))
        return {"ok": bool(hwnd and code)}

    def set_topmost(self, value) -> dict:
        self._topmost = bool(value)
        hwnd = _hwnd(self._window) if self._window is not None else 0
        if hwnd:
            try:
                _user32().SetWindowPos(
                    ctypes.c_void_p(hwnd),
                    ctypes.c_void_p(HWND_TOPMOST if self._topmost else HWND_NOTOPMOST),
                    0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("не удалось переключить поверх окон: %s", exc)
        save_ui({"topmost": self._topmost})
        log.info("поверх всех окон: %s", self._topmost)
        return {"ok": True, "topmost": self._topmost}

    # -- files -------------------------------------------------------------
    def save_text(self, name, content) -> dict:
        """Ask for a path with the native dialog and write UTF-8 text."""
        import webview

        suggested = "".join(c for c in str(name or "apexlab.txt") if c not in '\\/:*?"<>|').strip()
        if not suggested:
            suggested = "apexlab.txt"
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename=suggested,
                file_types=("Текст (*.txt)", "Все файлы (*.*)"),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("диалог сохранения не открылся: %s", exc)
            return {"ok": False, "error": str(exc)}
        if not result:
            return {"ok": False, "canceled": True}
        target = Path(result if isinstance(result, str) else result[0])
        try:
            target.write_text(str(content or ""), encoding="utf-8-sig")
        except Exception as exc:  # noqa: BLE001
            log.warning("не удалось записать отчёт: %s", exc)
            return {"ok": False, "error": str(exc)}
        log.info("отчёт сохранён: %s", target)
        return {"ok": True, "path": str(target)}


class WindowState:
    """Persist size/position, debounced and only while the window is normal."""

    def __init__(self, window, theme: str) -> None:
        self.window = window
        self.theme = theme
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._last = initial_geometry(load_ui())
        self._closing = False

    def _is_normal(self) -> bool:
        try:
            return "Maximized" not in str(self.window.native.WindowState) and \
                   "Minimized" not in str(self.window.native.WindowState)
        except Exception:  # noqa: BLE001
            return True

    def on_resized(self, width, height) -> None:
        if self._closing or not self._is_normal():
            return
        self._last.update(width=int(width), height=int(height))
        self._schedule()

    def on_moved(self, x, y) -> None:
        if self._closing or not self._is_normal():
            return
        self._last.update(x=int(x), y=int(y))
        self._schedule()

    def on_maximized(self) -> None:
        self._last["maximized"] = True
        self._flush()

    def on_restored(self) -> None:
        self._last["maximized"] = False
        self._schedule()

    def _schedule(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(0.9, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self, force: bool = False) -> None:
        if self._closing and not force:
            return
        width = self._last["width"]
        height = self._last["height"]
        payload = {
            "width": width,
            "height": height,
            "maximized": bool(self._last["maximized"]),
        }
        if self._last.get("x") is not None:
            payload["x"] = self._last["x"]
            payload["y"] = self._last["y"]
        save_ui({"window": payload})

    def on_closing(self) -> None:
        if self._closing:
            return
        self._closing = True
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        self._flush(force=True)
        log.info("геометрия окна сохранена")


# --------------------------------------------------------------------- server
def wait_for_server(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.06)
    return False


def start_server() -> tuple[http_server.ThreadingHTTPServer, int, threading.Thread]:
    lib = store.load_library()
    settings = lib.get("settings", {})
    if not settings.get("acc_path") or not os.path.isdir(settings.get("motec_path", "")):
        settings.update(http_server.detect_acc())
        lib["settings"] = settings
        store.save_library(lib)

    port = http_server.free_port(8765)
    server = http_server.create_server(port)
    thread = threading.Thread(target=server.serve_forever, name="apexlab-http", daemon=True)
    thread.start()
    return server, port, thread


# ----------------------------------------------------------------------- main
def run_native(url: str, ui: dict) -> None:
    import webview

    geometry = initial_geometry(ui)
    theme = geometry["theme"] if geometry["theme"] in THEME_COLORS else "carbon"
    topmost = bool(ui.get("topmost"))
    bridge = Bridge(topmost=topmost)
    bridge._theme = theme

    window = webview.create_window(
        TITLE,
        url,
        js_api=bridge,
        width=geometry["width"],
        height=geometry["height"],
        x=geometry["x"],
        y=geometry["y"],
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        maximized=geometry["maximized"],
        resizable=True,
        frameless=True,
        easy_drag=False,
        shadow=True,
        on_top=topmost,
        background_color=THEME_COLORS[theme]["bg"],
        text_select=True,
        confirm_close=False,
    )
    bridge._window = window
    state = WindowState(window, theme)
    pushed = {"maximized": None}

    def push_shell_state() -> None:
        """Keep the HTML titlebar in sync with native maximize state."""
        try:
            maximized = bool(bridge.window_state().get("maximized"))
        except Exception:  # noqa: BLE001 - window is closing
            return
        if pushed["maximized"] == maximized:
            return
        pushed["maximized"] = maximized
        try:
            window.evaluate_js(
                "window.__apexShell && window.__apexShell.setMaximized(%s);"
                % ("true" if maximized else "false")
            )
        except Exception:  # noqa: BLE001
            pass

    def on_resized(width, height) -> None:
        state.on_resized(width, height)
        push_shell_state()

    window.events.loaded += push_shell_state
    window.events.shown += push_shell_state
    window.events.resized += on_resized
    window.events.moved += state.on_moved
    window.events.maximized += state.on_maximized
    window.events.maximized += push_shell_state
    window.events.restored += state.on_restored
    window.events.restored += push_shell_state
    window.events.closing += state.on_closing

    log.info("окно %sx%s @ (%s, %s), тема %s, без рамки", geometry["width"], geometry["height"],
             geometry["x"], geometry["y"], theme)

    # Diagnostic hook: close automatically (used by packaging smoke tests).
    quit_after = os.environ.get("APEXLAB_QUIT_AFTER")
    starter = None
    if quit_after:
        try:
            delay = float(quit_after)
        except ValueError:
            delay = 0.0
        if delay > 0:
            def starter() -> None:  # noqa: F811 - pywebview calls this in a worker thread
                time.sleep(delay)
                log.info("автозакрытие через %.1f с", delay)
                window.destroy()

    webview.start(
        func=starter,
        gui="edgechromium",
        debug=False,
        private_mode=False,
        storage_path=str(DATA / "webview"),
        icon=str(ICON) if ICON.is_file() else None,
    )
    state.on_closing()
    log.info("цикл окна завершён")


def run_browser(url: str, reason: str = "") -> None:
    """Fallback: keep the server alive and open the default browser."""
    if reason:
        log.warning("нативное окно недоступно: %s", reason)
    print("ApexLab запущен:", url)
    print("Закрой это окно, чтобы остановить сервер.")
    if os.environ.get("APEXLAB_NO_BROWSER") != "1":
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass


def main() -> int:
    setup_logging()
    log.info("=" * 52)
    log.info("%s %s, python %s", APP_NAME, APP_VERSION, sys.version.split()[0])

    ui = load_ui()
    server, port, _thread = start_server()
    if not wait_for_server(port):
        show_error("ApexLab", "Локальный сервер не запустился.\n"
                              f"Подробности: {LOG_FILE}")
        return 1

    theme = str(ui.get("theme") or "carbon")
    if theme not in THEME_COLORS:
        theme = "carbon"
    url = f"http://127.0.0.1:{port}/?theme={theme}"
    log.info("сервер: %s", url)

    exit_code = 0
    try:
        run_native(url, ui)
    except Exception as exc:  # noqa: BLE001
        log.error("нативное окно не запустилось: %s\n%s", exc, traceback.format_exc())
        detail = (
            "Не удалось открыть окно приложения.\n\n"
            "Скорее всего, в системе нет компонента WebView2 (Microsoft Edge WebView2 Runtime).\n"
            "Приложение откроется в обычном браузере.\n\n"
            f"Подробности: {LOG_FILE}"
        )
        try:
            ctypes.windll.user32.MessageBoxW(None, detail, "ApexLab", 0x30)  # MB_ICONWARNING
        except Exception:  # noqa: BLE001
            pass
        try:
            run_browser(url, str(exc))
        except KeyboardInterrupt:
            pass
    finally:
        try:
            server.shutdown()
            server.server_close()
        except Exception:  # noqa: BLE001
            pass
        log.info("остановлено")
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        err = traceback.format_exc()
        try:
            setup_logging()
        except Exception:  # noqa: BLE001
            pass
        show_error("ApexLab", "Приложение остановилось из-за ошибки.\n\n"
                              f"{err[-1200:]}\n\nЖурнал: {LOG_FILE}")
        raise
