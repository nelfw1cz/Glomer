@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === Проверяем игнорирование секретов и мусора ===
git rm -r --cached .aider.conf.yml .aider.tags.cache.v4 .aider.chat.history.md .aider.input.history .aiderignore CONVENTIONS.md >nul 2>&1

echo === Текущие изменения для отправки на GitHub ===
git status -s
echo.

set /p msg="Введите описание изменений (или нажмите Enter для 'update'): "
if "%msg%"=="" set msg=update

git add .
git commit -m "%msg%"
git push

echo.
echo === Готово! ===
pause
