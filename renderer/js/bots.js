/* Telegram bot templates for aiogram 3.x. Every template lists the imports it needs; PF.ensureImports adds the missing ones. */
(function (root) {
  'use strict';

  const SKELETON = `import asyncio
import logging
import os

from aiogram import Bot, Dispatcher, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

# Токен выдаёт @BotFather. Лучше хранить его в переменной окружения BOT_TOKEN.
TOKEN = os.getenv("BOT_TOKEN", "ВСТАВЬТЕ_ТОКЕН")

router = Router()


@router.message(CommandStart())
async def cmd_start(message: Message):
    await message.answer(f"Привет, {message.from_user.full_name}!")


@router.message(Command("help"))
async def cmd_help(message: Message):
    await message.answer("Доступные команды: /start, /help")


async def main():
    logging.basicConfig(level=logging.INFO)
    bot = Bot(token=TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
`;

  const M = 'from aiogram.types import Message';
  const F = 'from aiogram import F';
  const CMD = 'from aiogram.filters import Command';

  const GROUPS = [
    { title: 'КАРКАС', items: [
      { label: 'Новый бот', tip: 'Полный каркас бота: токен, роутер, /start, /help, запуск polling', skeleton: true, text: SKELETON }
    ] },
    { title: 'ХЕНДЛЕРЫ', items: [
      { label: '/start', tip: 'Обработчик команды /start', needs: ['from aiogram.filters import CommandStart', M], body: `@router.message(CommandStart())
async def cmd_start(message: Message):
    await message.answer(f"Привет, {message.from_user.full_name}!")` },
      { label: '/команда', tip: 'Обработчик любой команды, например /help', needs: [CMD, M], body: `@router.message(Command("about"))
async def cmd_about(message: Message):
    await message.answer("Текст ответа")` },
      { label: 'текст', tip: 'Реакция на точный текст сообщения', needs: [F, M], body: `@router.message(F.text == "Привет")
async def on_hello(message: Message):
    await message.answer("Привет-привет!")` },
      { label: 'callback', tip: 'Нажатие на inline-кнопку', needs: [F, 'from aiogram.types import CallbackQuery'], body: `@router.callback_query(F.data == "btn")
async def on_btn(callback: CallbackQuery):
    await callback.message.answer("Кнопка нажата")
    await callback.answer()  # убирает «часики» на кнопке` },
      { label: 'фото', tip: 'Пользователь прислал фото', needs: [F, M], body: `@router.message(F.photo)
async def on_photo(message: Message):
    file_id = message.photo[-1].file_id  # самое большое фото
    await message.answer_photo(file_id, caption="Получил фото!")` },
      { label: 'документ', tip: 'Пользователь прислал файл', needs: [F, M], body: `@router.message(F.document)
async def on_document(message: Message):
    await message.answer(f"Файл: {message.document.file_name}")` },
      { label: 'эхо', tip: 'Ловит любой текст. Должен стоять ПОСЛЕДНИМ среди хендлеров', needs: [F, M], body: `# Ловит любой текст, поэтому все остальные хендлеры должны стоять выше
@router.message(F.text)
async def echo(message: Message):
    await message.answer(message.text)` }
    ] },
    { title: 'КЛАВИАТУРЫ', items: [
      { label: 'inline', tip: 'Кнопки под сообщением', needs: ['from aiogram.utils.keyboard import InlineKeyboardBuilder'], body: `def inline_kb():
    builder = InlineKeyboardBuilder()
    builder.button(text="Нажми меня", callback_data="btn")
    builder.button(text="Сайт", url="https://example.com")
    builder.adjust(2)  # кнопок в ряду
    return builder.as_markup()


# Использование: await message.answer("Выбери:", reply_markup=inline_kb())` },
      { label: 'reply', tip: 'Кнопки вместо обычной клавиатуры', needs: ['from aiogram.utils.keyboard import ReplyKeyboardBuilder'], body: `def menu_kb():
    builder = ReplyKeyboardBuilder()
    builder.button(text="Кнопка 1")
    builder.button(text="Кнопка 2")
    builder.adjust(2)
    return builder.as_markup(resize_keyboard=True)


# Использование: await message.answer("Меню", reply_markup=menu_kb())` },
      { label: 'убрать', tip: 'Команда, которая убирает reply-клавиатуру', needs: [CMD, M, 'from aiogram.types import ReplyKeyboardRemove'], body: `@router.message(Command("hide"))
async def cmd_hide(message: Message):
    await message.answer("Клавиатура убрана", reply_markup=ReplyKeyboardRemove())` }
    ] },
    { title: 'ЕЩЁ', items: [
      { label: 'FSM-анкета', tip: 'Диалог из нескольких шагов (состояния)', needs: [CMD, M, 'from aiogram.fsm.context import FSMContext', 'from aiogram.fsm.state import State, StatesGroup'], body: `class Form(StatesGroup):
    name = State()
    age = State()


@router.message(Command("form"))
async def form_start(message: Message, state: FSMContext):
    await state.set_state(Form.name)
    await message.answer("Как тебя зовут?")


@router.message(Form.name)
async def form_name(message: Message, state: FSMContext):
    await state.update_data(name=message.text)
    await state.set_state(Form.age)
    await message.answer("Сколько тебе лет?")


@router.message(Form.age)
async def form_age(message: Message, state: FSMContext):
    data = await state.update_data(age=message.text)
    await state.clear()
    await message.answer(f"Готово! {data['name']}, {data['age']}")` },
      { label: 'админам', tip: 'Команда только для списка id администраторов', needs: [CMD, F, M], body: `ADMINS = {123456789}  # свой id можно узнать у @userinfobot


@router.message(Command("admin"), F.from_user.id.in_(ADMINS))
async def cmd_admin(message: Message):
    await message.answer("Админ-панель")` },
      { label: 'отправить фото', tip: 'Отправка картинки из файла', needs: [CMD, M, 'from aiogram.types import FSInputFile'], body: `@router.message(Command("pic"))
async def cmd_pic(message: Message):
    await message.answer_photo(FSInputFile("photo.jpg"), caption="Подпись")` },
      { label: 'middleware', tip: 'Код, который выполняется перед каждым хендлером', needs: ['import logging', 'from aiogram import BaseMiddleware'], body: `class LogMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        logging.info("Событие: %s", type(event).__name__)
        return await handler(event, data)


router.message.middleware(LogMiddleware())` }
    ] }
  ];


  /* A fresh project: the base file (token from .env) plus the chosen handlers, in the order of GROUPS ("эхо" always last). */
  const BASE = `import asyncio
import logging
import os

from aiogram import Bot, Dispatcher, Router
from dotenv import find_dotenv, load_dotenv

# Токен лежит в файле .env рядом с main.py (его выдаёт @BotFather). Не публикуй .env!
load_dotenv(find_dotenv(usecwd=True))
TOKEN = os.getenv("BOT_TOKEN")
if not TOKEN:
    raise SystemExit("Не найден BOT_TOKEN. Впиши токен в файл .env: BOT_TOKEN=123456:ABC...")

router = Router()


async def main():
    logging.basicConfig(level=logging.INFO)
    bot = Bot(token=TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
`;
  const TOKEN_RE = /^\d{5,14}:[A-Za-z0-9_-]{30,50}$/;
  const NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
  const handlerItems = () => GROUPS.filter((g) => !g.items.some((i) => i.skeleton)).flatMap((g) => g.items);

  function buildProject(labels, token) {
    const PFc = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.PF;
    const want = new Set(labels || []);
    const items = handlerItems().filter((i) => want.has(i.label));
    items.sort((a, b) => (a.label === 'эхо') - (b.label === 'эхо')); // stable: the echo handler goes last
    let code = BASE;
    for (const it of items) {
      const r = PFc.insertTopLevel(code, it.body);
      code = PFc.ensureImports(r.text, it.needs || []);
    }
    const tok = String(token || '').trim();
    const files = {
      'main.py': code,
      '.env': '# Секрет: не загружай этот файл в GitHub (он уже есть в .gitignore)\nBOT_TOKEN=' + tok + '\n',
      'requirements.txt': 'aiogram>=3.0\npython-dotenv\n',
      '.gitignore': '.env\n__pycache__/\n*.pyc\n.venv/\n',
      'README.md': '# Telegram-бот на aiogram 3\n\nСоздано в PyForge.\n\n## Запуск\n\n```\npip install -r requirements.txt\npython main.py\n```\n\nТокен бота хранится в файле `.env` (`BOT_TOKEN=...`). ' +
        (tok ? '' : '**Сейчас он пустой: впиши токен от @BotFather.** ') +
        'Файл `.env` не попадает в Git.\n\n## Хендлеры\n\n' + (items.length ? items.map((i) => '- ' + i.label + ' — ' + i.tip).join('\n') : 'Пока нет ни одного: добавь их в `main.py`.') + '\n'
    };
    return { files, picked: items.map((i) => i.label) };
  }

  const api = { GROUPS, SKELETON, buildProject, handlerItems, TOKEN_RE, NAME_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PFBots = api;
})(typeof window !== 'undefined' ? window : globalThis);
