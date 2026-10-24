"""Build a shareable ApexLab.exe (PyInstaller onefile) and zip it for handing over."""
from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
ROOT = APP.parent
BUILD = APP / "build"
RELEASE = ROOT / "release"
NAME = "ApexLab"
# Two channels: release is polished and frozen per version, beta carries new ideas.
ARGS = sys.argv[1:]
CHANNEL = "beta" if "beta" in ARGS else "release"
VERSION = "2.1.0-beta" if CHANNEL == "beta" else "2.0.0"
FILE_VERSION = VERSION.split("-")[0]
OUT_DIR = RELEASE / "beta" if CHANNEL == "beta" else RELEASE

READ_ME = """ApexLab — телеметрия Assetto Corsa Competizione
Версия 2.0.0
================================================

Это самостоятельная сборка: Python и все библиотеки уже внутри.
Ставить ничего не нужно.

ЗАПУСК
1. Распакуй архив целиком в любую папку (не в Program Files — приложению нужно
   писать рядом свои данные). Запускать прямо из архива нельзя: Windows не даст
   сохранить библиотеку.
2. Двойной щёлчок по ApexLab.exe — откроется отдельное окно приложения.
3. Закрыть приложение — крестик в правом верхнем углу окна.

ОКНО
Окно без системной рамки: сверху своя панель, её можно тянуть мышью,
двойной щёлчок разворачивает на весь экран, за края и углы окно тянется
как обычное. Кнопки справа — свернуть, развернуть, закрыть; кнопка
с булавкой оставляет окно поверх остальных. Размер, положение и состояние
запоминаются.

ТЕМЫ
Слева внизу — переключатель тем: Карбон, Полночь, Янтарь, Фиалка, светлая
День, чёрно-белая Моно и графитовая Графит. Тема применяется сразу и
сохраняется между запусками; в «Настройках» есть те же темы крупными
карточками. Ctrl+Shift+T переключает темы по кругу.

ГОРЯЧИЕ КЛАВИШИ
Ctrl+K — командная строка (поиск сессий, трасс, пилотов и разделов);
Ctrl+Shift+T — следующая тема; Ctrl+B — свернуть/развернуть боковую панель;
Ctrl+E — сохранить отчёт о сессии в текстовый файл; Ctrl+P — печать;
Alt+1…Alt+5 — вкладки внутри сессии; F1 — настройки и список горячих клавиш.

ОТЧЁТ
В сессии кнопка «Отчёт» (или Ctrl+E) собирает текстовый отчёт: результаты,
оценка пилота, ошибки по поворотам, потери времени, давления и температуры,
рекомендации по сету. Файл сохраняется рядом с тем местом, которое выберешь.

Windows SmartScreen может предупредить, что издатель неизвестен:
«Подробнее» → «Выполнить всё равно». Это нормально для сборки без платной подписи.

ПЕРВЫЙ ЗАПУСК
Приложение само ищет папку ACC в Документах. Если не нашло — открой «Настройки»
и укажи пути к MoTeC и Setups, затем нажми «Импорт».

ЕСЛИ СЕТОВ НЕ ВИДНО
Открой сессию → вкладка «Сет». Кнопка «Импорт сета» или перетаскивание .json
на панель копирует сет в библиотеку ApexLab, и он сразу подставляется в
рекомендации. Это работает, даже если папка Setups не найдена.

ГДЕ ЛЕЖАТ ДАННЫЕ
Рядом с ApexLab.exe появится папка data — это библиотека, кэш разбора и
журнал apexlab.log. Её можно удалить, приложение соберёт всё заново из твоих
логов. Исходные логи и сеты приложение только читает.

ЕДИНИЦЫ В СЕТЕ
ACC пишет setup в кликах, а гараж показывает физику. ApexLab пересчитывает
клики в то, что видно в игре: давление в psi (холодное), развал и схождение
в градусах, пружины в Н/мм, клиренс в мм, отбойник в Н, баланс тормозов в %,
предварительная нагрузка в Нм. Стабилизаторы, амортизаторы, крыло и
воздуховоды остаются в кликах — в игре они тоже в кликах. ApexLab знает 46
машин ACC (GT3, GT4, Cup, TCX, M2 CS Racing); для мода, которого нет в
таблице, над сетом будет предупреждение, а «кликовые» параметры останутся в
кликах. Целевое горячее давление зависит от класса: 27.2 psi для GT3/Cup и
27.0 psi для GT4/TCX/M2; если класс неизвестен, число не подставляется.

ЧТО ВНУТРИ
Гараж, разбор сессии (обзор, траектория, круги, ошибки, сет),
сравнение двух кругов, профили пилотов, рекомендации по сету и
экспорт отчёта. Семь тем оформления.

ТРЕБОВАНИЯ
Windows 10 или 11. Для окна нужен компонент Microsoft Edge WebView2 — он уже
есть в Windows 11 и в актуальном Edge. Если компонента нет, приложение
сообщит об этом и откроется в обычном браузере.

ПОДРОБНЕЕ
README.md в исходниках проекта.
"""

BETA_NOTE = """

ЭТО БЕТА-СБОРКА
Канал бета: здесь появляются новые функции до того, как попадут в релиз.
Эксперименты включены по умолчанию (бейдж BETA в заголовке). Выключить или
включить обратно: «Настройки» → «Канал» → «Эксперименты». Рядом с этой
сборкой можно держать релизную — у них разные папки, данные не смешиваются,
если распаковать их отдельно.
"""


def run(cmd: list[str], cwd: Path) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    icon = BUILD / "apexlab.ico"
    run([sys.executable, str(APP / "tools" / "make_icon.py"), str(icon)], APP)

    version_file = BUILD / "version.txt"
    version_file.write_text(
        f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({FILE_VERSION.replace('.', ', ')}, 0), prodvers=({FILE_VERSION.replace('.', ', ')}, 0),
                    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'ApexLab'),
      StringStruct('FileDescription', 'ApexLab - ACC telemetry studio'),
      StringStruct('FileVersion', '{FILE_VERSION}'),
      StringStruct('InternalName', 'ApexLab'),
      StringStruct('OriginalFilename', 'ApexLab.exe'),
      StringStruct('ProductName', 'ApexLab'),
      StringStruct('ProductVersion', '{FILE_VERSION}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""",
        encoding="utf-8",
    )

    work = BUILD / "work"
    spec = BUILD / "spec"
    if work.exists():
        shutil.rmtree(work)
    spec.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    extra = []
    if CHANNEL == "beta":
        flag = BUILD / "beta.flag"
        flag.write_text("2.1.0-beta\n", encoding="utf-8")
        extra = ["--add-data", f"{flag};."]

    run([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", NAME,
        "--icon", str(icon),
        "--version-file", str(version_file),
        "--add-data", f"{APP / 'web'};web",
        "--add-data", f"{APP / 'icon.ico'};.",
        "--collect-data", "pythonnet",
        "--collect-data", "clr_loader",
        "--hidden-import", "clr",
        "--hidden-import", "pythonnet",
        "--hidden-import", "clr_loader",
        "--hidden-import", "System",
        "--distpath", str(OUT_DIR),
        "--workpath", str(work),
        "--specpath", str(spec),
        "--exclude-module", "tkinter",
        "--exclude-module", "matplotlib",
        "--exclude-module", "pandas",
        "--exclude-module", "PIL",
        "--exclude-module", "pytest",
        *extra,
        str(APP / "desktop.py"),
    ], APP)

    exe = OUT_DIR / f"{NAME}.exe"
    if not exe.exists():
        raise SystemExit("PyInstaller не собрал exe")

    readme = OUT_DIR / "ПРОЧТИ МЕНЯ.txt"
    readme.write_text(READ_ME + (BETA_NOTE if CHANNEL == "beta" else ""), encoding="utf-8-sig")

    suffix = "win64"
    zip_path = OUT_DIR / f"{NAME}-{VERSION}-{suffix}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(exe, f"{NAME}/{exe.name}")
        z.write(readme, f"{NAME}/{readme.name}")
    size = zip_path.stat().st_size / 1024 / 1024
    print(f"\nканал: {CHANNEL}")
    print(f"ready: {zip_path} ({size:.1f} МБ)")
    print(f"exe:   {exe} ({exe.stat().st_size / 1024 / 1024:.1f} МБ)")


if __name__ == "__main__":
    main()
