@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0apexlab"
set PYTHONIOENCODING=utf-8
title ApexLab - телеметрия ACC

if /i "%~1"=="beta" (
  set APEX_CHANNEL=beta
  echo Канал: бета ^(эксперименты включены^)
)

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python не найден. Установи Python 3.11+ и добавь его в PATH.
  echo https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

python -c "import numpy" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не хватает numpy. Ставлю...
  python -m pip install --quiet numpy
  if errorlevel 1 (
    echo Не удалось установить numpy. Выполни вручную:
    echo   python -m pip install numpy
    pause
    exit /b 1
  )
)

python -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не хватает pywebview для отдельного окна. Ставлю...
  python -m pip install --quiet "pywebview>=6,<7"
  if errorlevel 1 (
    echo Не удалось установить pywebview. Приложение откроется в браузере.
  )
)

python desktop.py
if errorlevel 1 (
  echo.
  echo Приложение остановилось с ошибкой. Текст выше.
  echo Журнал: apexlab\data\apexlab.log
  pause
)
endlocal
