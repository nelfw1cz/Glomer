/* "Коммит" window: pick changed files, write a message, commit locally. No push here on purpose. */
(function (root) {
  'use strict';
  const { h, modal } = root.PFModal;
  const PF = root.PF;

  const KIND = { new: 'новый', mod: 'изменён', del: 'удалён', ren: 'переименован', conflict: 'конфликт' };
  const RISK = { secret: 'секрет?', junk: 'мусор' };
  const PROBLEM = {
    'no-git': ['Git не найден', 'Установи Git (git-scm.com; на Mac команда xcode-select --install) и перезапусти редактор.'],
    'not-repo': ['Здесь нет репозитория', 'Эта папка не под git. Открой папку проекта, в которой уже выполнено git init или git clone.'],
    'unsafe-repo': ['Git не доверяет этой папке', 'Выполни в терминале: git config --global --add safe.directory "путь к папке".'],
    'bad-dir': ['Папка не найдена', 'Открой папку проекта заново.'],
    'bad-args': ['Нечего коммитить', 'Выбери файлы и напиши сообщение.']
  };
  const FAIL = {
    'no-identity': 'Git не знает, кто ты. Выполни в терминале:\ngit config --global user.name "Твоё имя"\ngit config --global user.email "почта@пример.com"',
    conflict: 'В репозитории есть неразрешённые конфликты. Реши их (в терминале или другом git-клиенте) и открой окно заново.',
    merging: 'Идёт слияние (merge). Закончи его в терминале, потом коммить.',
    locked: 'Git занят другой операцией (файл .git/index.lock). Закрой другие git-программы и попробуй снова.',
    nothing: 'Выбранные файлы уже не изменены. Обнови окно: закрой и открой снова.'
  };

  function create({ api, toast, getDir, unsavedCount, saveAll }) {
    let remove = null, busy = false;

    function info(title, kids, extra) {
      const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
      const rm = modal(title, kids, [close], () => rm(), 'gt');
      close.addEventListener('click', () => rm());
      close.focus();
      return rm;
    }

    async function open() {
      if (document.querySelector('.modal-back')) return;
      const dir = getDir();
      if (!dir) { toast('Сначала открой папку проекта (Ctrl+Shift+O) или сохрани файл'); return; }
      const r = await api.gitStatus(dir);
      if (r.error) {
        const p = PROBLEM[r.error] || ['Ошибка git', r.detail || r.error];
        info(p[0], [h('div', { class: 'wz-note', text: p[1] })]);
        return;
      }
      view(dir, r);
    }

    function view(dir, st) {
      const rows = st.files.map((f) => {
        const risk = PF.gitRisky(f.path);
        return { f, risk, on: !risk && f.kind !== 'conflict' };
      });
      const cancel = h('button', { class: 'chip', type: 'button', text: 'Отмена' });
      const go = h('button', { class: 'chip primary', type: 'button', text: 'Закоммитить' });
      const all = h('button', { class: 'chip', type: 'button', text: 'Все' });
      const none = h('button', { class: 'chip', type: 'button', text: 'Ни одного' });
      const count = h('span', { class: 'wz-note' });
      const status = h('div', { class: 'wz-status', 'aria-live': 'polite' });
      const msg = h('textarea', { class: 'gt-msg', rows: '3', spellcheck: 'true', 'aria-label': 'Сообщение коммита', placeholder: 'Что изменилось (Ctrl+Enter — закоммитить)' });
      const say = (t, cls) => { status.textContent = t || ''; status.className = 'wz-status' + (cls ? ' ' + cls : ''); };
      const list = h('div', { class: 'gt-list', role: 'group', 'aria-label': 'Изменённые файлы' });

      const sync = () => {
        const n = rows.filter((x) => x.on).length;
        count.textContent = 'Выбрано: ' + n + ' из ' + rows.length;
        go.disabled = busy || !st.identity || n === 0 || !msg.value.trim();
      };
      rows.forEach((x) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = x.on;
        cb.addEventListener('change', () => { x.on = cb.checked; sync(); });
        x.cb = cb;
        const label = x.f.orig ? x.f.orig + ' → ' + x.f.path : x.f.path;
        list.append(h('label', { class: 'gt-row', title: label },
          cb,
          h('span', { class: 'gt-k ' + x.f.kind, text: KIND[x.f.kind] || x.f.kind }),
          h('span', { class: 'gt-p', text: label }),
          x.risk ? h('span', { class: 'gt-warn', text: RISK[x.risk] }) : null));
      });
      const setAll = (v) => { rows.forEach((x) => { if (x.f.kind !== 'conflict') { x.on = v; x.cb.checked = v; } }); sync(); };
      all.addEventListener('click', () => setAll(true));
      none.addEventListener('click', () => setAll(false));
      msg.addEventListener('input', sync);

      const body = [h('div', { class: 'wz-note' }, 'Ветка: ', h('code', { class: 'wz-path', text: st.branch || '(не на ветке)' }), ' · ', h('code', { class: 'wz-path', text: st.root }))];
      const unsaved = unsavedCount();
      if (unsaved) {
        const save = h('button', { class: 'chip', type: 'button', text: 'Сохранить и обновить' });
        save.addEventListener('click', async () => { save.disabled = true; await saveAll(); remove(); open(); });
        body.push(h('div', { class: 'wz-status err', text: 'Несохранённых файлов: ' + unsaved + '. В коммит попадёт версия с диска, а не из редактора.' }), h('div', { class: 'wz-row' }, save));
      }
      if (!st.identity) body.push(h('div', { class: 'wz-status err', text: FAIL['no-identity'] }));
      if (st.truncated) body.push(h('div', { class: 'wz-note', text: 'Файлов очень много, показаны первые тысячи.' }));
      if (!rows.length) {
        body.push(h('div', { class: 'wz-note', text: 'Изменений нет: всё уже закоммичено.' }));
        const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
        remove = modal('Коммит', body, [close], () => remove(), 'gt');
        close.addEventListener('click', () => remove());
        close.focus();
        return;
      }
      body.push(h('div', { class: 'wz-row gt-tools' }, count, h('span', { class: 'sp' }), all, none), list);
      if (rows.some((x) => x.risk === 'secret')) body.push(h('div', { class: 'wz-note', text: 'Файлы с пометкой «секрет?» могут содержать токены и пароли. Репозиторий на GitHub публичный, поэтому они по умолчанию не отмечены.' }));
      body.push(h('label', { class: 'wz-lbl', for: 'gtMsg', text: 'Сообщение коммита' }), msg, status);
      msg.id = 'gtMsg';

      remove = modal('Коммит', body, [cancel, go], () => { if (!busy) remove(); }, 'gt');
      cancel.addEventListener('click', () => { if (!busy) remove(); });
      const commit = async () => {
        if (go.disabled) return;
        const files = [];
        rows.filter((x) => x.on).forEach((x) => { files.push(x.f.path); if (x.f.orig) files.push(x.f.orig); });
        busy = true; sync(); say('Коммичу…');
        const r = await api.gitCommit({ dir, files, message: msg.value });
        busy = false;
        if (r.ok) { remove(); done(r, msg.value.trim().split('\n')[0]); return; }
        sync();
        say(FAIL[r.error] || (r.error === 'failed' ? 'Git вернул ошибку:\n' + (r.detail || '') : 'Не удалось закоммитить: ' + r.error), 'err');
      };
      go.addEventListener('click', commit);
      msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); commit(); } });
      sync();
      msg.focus();
    }

    function done(r, subject) {
      toast('Коммит ' + r.hash + ' создан');
      info('Коммит создан', [
        h('div', { class: 'wz-note' }, h('code', { class: 'wz-path', text: r.hash }), ' · файлов: ' + r.count),
        h('div', { class: 'wz-note', text: subject }),
        h('div', { class: 'wz-note', text: 'Он пока только на твоём компьютере. Чтобы отправить его на GitHub, выполни git push в терминале или через GitHub Desktop.' })
      ]);
    }

    return { open };
  }

  root.PFGit = { create };
})(window);
