/* Modal helpers + the "Создать бота" wizard. Everything is built with DOM calls (no user text goes through innerHTML). */
(function (root) {
  'use strict';

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'class') e.className = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    kids.forEach((c) => { if (c != null) e.append(c); });
    return e;
  };

  /* Keeps Tab inside `box`, calls onEsc on Escape. Returns a function that removes the listener. */
  function trap(box, onEsc) {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEsc(); return; }
      if (e.key !== 'Tab') return;
      const f = [...box.querySelectorAll('button,input,textarea,[tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }


  /* Small modal dialogs. prompt → string or null, confirm → boolean. */
  function modal(title, bodyKids, buttons, onEsc, cls) {
    const dlg = h('div', { class: 'dlg wiz small' + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pmTitle' },
      h('div', { class: 'dlg-h' }, h('h2', { id: 'pmTitle', text: title })),
      h('div', { class: 'wz-body' }, ...bodyKids),
      h('div', { class: 'dlg-f' }, h('span', { class: 'sp' }), ...buttons));
    const back = h('div', { class: 'modal-back' }, dlg);
    document.body.append(back);
    const untrap = trap(dlg, onEsc);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) onEsc(); });
    return () => { untrap(); back.remove(); };
  }
  function prompt({ title, label, value, ok }) {
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const input = h('input', { type: 'text', id: 'pmInput', autocomplete: 'off', spellcheck: 'false' });
      input.value = value || '';
      const okB = h('button', { class: 'chip primary', type: 'button', text: ok || 'ОК' });
      const noB = h('button', { class: 'chip', type: 'button', text: 'Отмена' });
      let remove = null;
      const done = (v) => { remove(); if (opener && opener.focus) opener.focus(); resolve(v); };
      remove = modal(title, [h('label', { class: 'wz-lbl', for: 'pmInput', text: label }), h('div', { class: 'wz-row' }, input)], [noB, okB], () => done(null));
      okB.addEventListener('click', () => done(input.value));
      noB.addEventListener('click', () => done(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
      input.focus();
      const dot = input.value.lastIndexOf('.'); // select the name, not the extension
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  }
  function confirm({ title, text, ok }) {
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const okB = h('button', { class: 'chip primary', type: 'button', text: ok || 'ОК' });
      const noB = h('button', { class: 'chip', type: 'button', text: 'Отмена' });
      let remove = null;
      const done = (v) => { remove(); if (opener && opener.focus) opener.focus(); resolve(v); };
      remove = modal(title, [h('div', { class: 'wz-note', text })], [noB, okB], () => done(false));
      okB.addEventListener('click', () => done(true));
      noB.addEventListener('click', () => done(false));
      noB.focus(); // the safe choice is focused by default
    });
  }

  function create({ api, toast, onOpenMain }) {
    let back = null, untrap = null, opener = null, busy = false;

    function close() {
      if (!back) return;
      untrap(); back.remove(); back = null;
      if (opener && opener.focus) opener.focus();
    }

    function open() {
      if (back) return;
      opener = document.activeElement;
      back = h('div', { class: 'modal-back' });
      const dlg = h('div', { class: 'dlg wiz', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wizTitle' });
      back.append(dlg);
      back.addEventListener('pointerdown', (e) => { if (e.target === back && !busy) close(); });
      document.body.append(back);
      untrap = trap(dlg, () => { if (!busy) close(); });
      form(dlg);
    }

    function form(dlg) {
      dlg.replaceChildren();
      let parent = '';
      const status = h('div', { class: 'wz-status', 'aria-live': 'polite' });
      const say = (t, cls) => { status.textContent = t || ''; status.className = 'wz-status' + (cls ? ' ' + cls : ''); };

      const tokenIn = h('input', { type: 'password', id: 'wzToken', autocomplete: 'off', spellcheck: 'false', placeholder: '123456789:AAE… (от @BotFather)' });
      const showBtn = h('button', { class: 'chip', type: 'button', text: 'Показать' });
      const checkBtn = h('button', { class: 'chip', type: 'button', text: 'Проверить' });
      const nameIn = h('input', { type: 'text', id: 'wzName', autocomplete: 'off', spellcheck: 'false', maxlength: '40', placeholder: 'bot-1 (если оставить пустым)' });
      const pathEl = h('code', { class: 'wz-path', text: '…' });
      const pickBtn = h('button', { class: 'chip', type: 'button', text: 'Выбрать…' });

      showBtn.addEventListener('click', () => {
        const hide = tokenIn.type === 'text';
        tokenIn.type = hide ? 'password' : 'text';
        showBtn.textContent = hide ? 'Показать' : 'Скрыть';
      });
      checkBtn.addEventListener('click', async () => {
        const t = tokenIn.value.trim();
        if (!root.PFBots.TOKEN_RE.test(t)) { say('Токен выглядит неверно. Формат: 123456789:AA… — скопируй его целиком из @BotFather.', 'err'); tokenIn.focus(); return; }
        say('Спрашиваю у Telegram…'); checkBtn.disabled = true;
        const r = await api.botsCheckToken(t);
        checkBtn.disabled = false;
        if (r.ok) say('Токен рабочий: бот @' + r.username + '.', 'ok');
        else if (r.error === 'rejected') say('Telegram не принял этот токен. Проверь, что он скопирован целиком и не отозван.', 'err');
        else say('Не удалось связаться с Telegram. Токен всё равно можно сохранить и проверить позже.', 'err');
      });
      pickBtn.addEventListener('click', async () => {
        const p = await api.botsPickDir(parent);
        if (p) { parent = p; pathEl.textContent = p; }
      });
      api.botsDefaultDir().then((d) => { if (!parent) { parent = d; pathEl.textContent = d; } });

      // handler checkboxes, grouped like in the template bar
      const boxes = [];
      const list = h('div', { class: 'wz-groups' });
      root.PFBots.GROUPS.filter((g) => !g.items.some((i) => i.skeleton)).forEach((g) => {
        const col = h('fieldset', { class: 'wz-group' }, h('legend', { text: g.title.charAt(0) + g.title.slice(1).toLowerCase() }));
        g.items.forEach((it) => {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = it.label === '/start';
          boxes.push([it.label, cb]);
          col.append(h('label', { class: 'wz-chk', title: it.tip || '' }, cb, h('span', { text: it.label })));
        });
        list.append(col);
      });

      const createBtn = h('button', { class: 'chip primary', type: 'button', text: 'Создать бота' });
      const cancelBtn = h('button', { class: 'chip', type: 'button', text: 'Отмена' });
      cancelBtn.addEventListener('click', close);
      createBtn.addEventListener('click', async () => {
        const tok = tokenIn.value.trim(), name = nameIn.value.trim();
        if (tok && !root.PFBots.TOKEN_RE.test(tok)) { say('Токен выглядит неверно. Можно оставить поле пустым и вписать токен в .env позже.', 'err'); tokenIn.focus(); return; }
        if (name && !root.PFBots.NAME_RE.test(name)) { say('Имя папки: буквы, цифры, - и _ (до 40 символов).', 'err'); nameIn.focus(); return; }
        const { files, picked } = root.PFBots.buildProject(boxes.filter(([, c]) => c.checked).map(([l]) => l), tok);
        busy = true; createBtn.disabled = true; say('Создаю…');
        const r = await api.botsCreate({ parent, name, files });
        busy = false; createBtn.disabled = false;
        if (r.error === 'exists') { say('Папка с таким именем уже есть. Измени имя или оставь поле пустым.', 'err'); nameIn.focus(); return; }
        if (r.error === 'bad-name') { say('Имя папки: буквы, цифры, - и _ (до 40 символов).', 'err'); return; }
        if (r.error) { say('Не удалось создать папку: ' + r.error, 'err'); return; }
        done(dlg, r, !!tok, picked.length);
      });

      dlg.append(
        h('div', { class: 'dlg-h' }, h('h2', { id: 'wizTitle', text: 'Новый бот' })),
        h('div', { class: 'wz-body' },
          h('label', { class: 'wz-lbl', for: 'wzToken', text: 'Токен' }),
          h('div', { class: 'wz-row' }, tokenIn, showBtn, checkBtn),
          h('div', { class: 'wz-note', text: 'Токен попадёт только в файл .env внутри папки бота, в код он не вставляется.' }),
          h('label', { class: 'wz-lbl', for: 'wzName', text: 'Имя папки' }),
          h('div', { class: 'wz-row' }, nameIn),
          h('div', { class: 'wz-lbl', text: 'Где сохранить' }),
          h('div', { class: 'wz-row' }, pathEl, pickBtn),
          h('div', { class: 'wz-lbl', text: 'Что добавить в бота' }),
          list,
          status
        ),
        h('div', { class: 'dlg-f' }, h('span', { class: 'sp' }), cancelBtn, createBtn)
      );
      tokenIn.focus();
    }

    function done(dlg, r, hasToken, n) {
      dlg.replaceChildren();
      const openMain = h('button', { class: 'chip primary', type: 'button', text: 'Открыть main.py в редакторе' });
      const openDir = h('button', { class: 'chip', type: 'button', text: 'Открыть папку' });
      const closeBtn = h('button', { class: 'chip', type: 'button', text: 'Закрыть' });
      openMain.addEventListener('click', async () => { const ok = await onOpenMain(r.main); if (ok) close(); });
      openDir.addEventListener('click', () => api.botsOpenDir(r.dir));
      closeBtn.addEventListener('click', close);
      dlg.append(
        h('div', { class: 'dlg-h' }, h('h2', { id: 'wizTitle', text: 'Бот создан' })),
        h('div', { class: 'wz-body' },
          h('div', { class: 'wz-note' }, 'Папка: ', h('code', { class: 'wz-path', text: r.dir })),
          h('div', { class: 'wz-note', text: 'Внутри: main.py, .env, requirements.txt, .gitignore, README.md. Хендлеров: ' + n + '.' }),
          hasToken ? null : h('div', { class: 'wz-status err', text: 'Токен не указан. Впиши его в файл .env: BOT_TOKEN=…' }),
          h('div', { class: 'wz-lbl', text: 'Запуск в терминале' }),
          h('pre', { class: 'wz-cmd', text: 'pip install -r requirements.txt\npython main.py' }),
          h('div', { class: 'wz-note', text: 'Кнопка «Запустить» в редакторе тоже работает: скрипт запускается из папки файла и находит .env.' })
        ),
        h('div', { class: 'dlg-f' }, openDir, h('span', { class: 'sp' }), closeBtn, openMain)
      );
      openMain.focus();
      if (toast) toast('Бот создан: ' + r.name);
    }

    return { open, close };
  }

  root.PFModal = { trap, h, prompt, confirm, modal };
  root.PFBotWizard = { create };
})(window);
