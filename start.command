#!/bin/bash
# Двойной клик в Finder: проверяет Node.js, ставит зависимости (один раз) и запускает PyForge.
cd "$(dirname "$0")" || exit 1

clear
echo "PyForge — запуск"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установи LTS-версию с https://nodejs.org и запусти этот файл снова."
  read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: ставлю зависимости (это займёт пару минут)..."
  if ! npm install; then
    echo
    echo "npm install не сработал. Проверь интернет и запусти файл снова."
    read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно..."
    exit 1
  fi
fi

echo "Запускаю PyForge..."
npm start
