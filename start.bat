@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 1. Проверка Node.js и npm
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в PATH!
    echo Установите Node.js с сайта https://nodejs.org и перезапустите скрипт.
    pause
    exit /b 1
)

:: 2. Проверка Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Python не найден в PATH!
    echo Установите Python с сайта https://python.org ^(не забудьте галочку "Add to PATH"^).
    pause
    exit /b 1
)

echo Окружение проверено: Node.js и Python доступны.

:: 3. Проверка зависимостей и запуск проекта
if not exist "node_modules" (
    echo Папка node_modules не найдена. Выполняю npm install...
    call npm install
)

echo Запуск проекта...
call npm start
pause
