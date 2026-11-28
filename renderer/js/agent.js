/* Agent chat panel (OpenAI-compatible API). All network and the API key stay in the main process; this file only draws the chat.
   Token savers: small default context (selection or the function under the cursor), only the last N messages are re-sent,
   a cap on the reply length, a live estimate before every send, a per-session budget. */
(function (root) {
  'use strict';
  const { h, modal } = root.PFModal;
  const PF = root.PF;

  const SYSTEM = 'Ты помощник по Python в редакторе кода. Отвечай по-русски, кратко и по делу. Код давай блоком ```python, только изменённый фрагмент, без лишних пояснений, если не просили объяснить.';
  const ERR = {
    auth: 'Сервер не принял ключ. Проверь его в настройках.',
    'not-found': 'Адрес или название модели не найдены. Проверь настройки.',
    rate: 'Лимит запросов или закончились деньги на ключе.',
    balance: 'На ключе закончились деньги.',
    server: 'Ошибка на стороне сервера. Попробуй позже.',
    network: 'Нет связи с сервером.',
    timeout: 'Сервер слишком долго не отвечает.',
    'bad-request': 'Сервер отклонил запрос. Возможно, модель не поддерживает такие параметры.',
    'bad-reply': 'Сервер ответил в неожиданном формате.',
    'too-big': 'Запрос слишком большой. Выбери меньше кода.',
    busy: 'Предыдущий запрос ещё идёт.',
    'no-key': 'Не указан ключ API.',
    'no-model': 'Не указана модель.',
    http: 'Сервер вернул ошибку.'
  };
  const fmt = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const $ = (id) => document.getElementById(id);

  function create({ api, toast, getContext, insertCode }) {
    const els = { box: $('chat'), log: $('chLog'), input: $('chIn'), send: $('chSend'), est: $('chEst'), use: $('chUse'), ctx: $('chCtx'), model: $('chModel') };
    let cfg = null, history = [], busy = false, nextId = 1, used = { in: 0, out: 0 }, raf = 0;
    const routes = new Map();   // request id → { chunk, done, error }

    try { const m = localStorage.getItem('pf-agent-ctx'); if (m && [...els.ctx.options].some((o) => o.value === m)) els.ctx.value = m; } catch (e) { /* ignore */ }

    if (api.onAiChunk) {   // absent only when the preload bridge is older than this file
      api.onAiChunk((p) => { const r = routes.get(p.id); if (r) r.chunk(p.text); });
      api.onAiDone((p) => { const r = routes.get(p.id); if (r) { routes.delete(p.id); r.done(p.usage); } });
      api.onAiError((p) => { const r = routes.get(p.id); if (r) { routes.delete(p.id); r.error(p.error, p.detail); } });
    }

    const ready = () => !!(cfg && cfg.model && cfg.hasKey);
    async function refresh() {
      cfg = await api.aiGet();
      els.model.textContent = cfg.model || 'модель не выбрана';
      estimate();
    }

    /* what would be sent right now */
    function plan() {
      const question = els.input.value.trim();
      let ctx = els.ctx.value === 'none' ? null : getContext(els.ctx.value);
      let note = '';
      if (ctx && ctx.blocked) { note = ctx.blocked; ctx = null; }
      const b = PF.buildAgentMessages({ system: SYSTEM, history, keep: cfg ? cfg.keep : 4, context: ctx, question: question || '…' });
      return { question, ctx, note, ...b };
    }
    function estimate() {
      raf = 0;
      if (!cfg) return;
      const p = plan();
      const parts = ['≈ ' + fmt(p.estTokens) + ' токенов на входе' + (p.ctx ? ' · ' + p.ctx.label : ' · без кода')];
      if (p.truncated) parts.push('код обрезан');
      if (p.redacted) parts.push('скрыто секретов: ' + p.redacted);
      els.est.textContent = parts.join(' · ');
      els.est.title = p.note || '';
      if (p.note) els.est.textContent += ' · ' + p.note;
      const total = used.in + used.out;
      els.use.textContent = total ? 'За сессию: ↑' + fmt(used.in) + ' ↓' + fmt(used.out) + (cfg.budget ? ' из ' + fmt(cfg.budget) : '') : (cfg.budget ? 'Лимит сессии: ' + fmt(cfg.budget) + ' токенов' : '');
    }
    const soon = () => { if (!raf) raf = requestAnimationFrame(estimate); };

    /* drawing */
    function copy(text) {
      const fallback = () => { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); };
      try { navigator.clipboard.writeText(text).catch(fallback); } catch (e) { fallback(); }
      toast('Скопировано');
    }
    function renderBot(box, text, finished) {
      box.replaceChildren();
      PF.splitFences(text).forEach((p) => {
        if (p.type === 'text') { if (p.text.trim()) box.append(h('div', { class: 'ch-t', text: p.text.replace(/^\n+|\n+$/g, '') })); return; }
        const head = h('div', { class: 'ch-code-h' }, h('span', { text: p.lang || 'код' }), h('span', { class: 'sp' }));
        if (finished || !p.open) {
          const cp = h('button', { class: 'chip', type: 'button', text: 'Копировать' });
          const ins = h('button', { class: 'chip', type: 'button', text: 'Вставить', title: 'Вставить в редактор на место выделения или курсора' });
          cp.addEventListener('click', () => copy(p.text));
          ins.addEventListener('click', () => insertCode(p.text));
          head.append(cp, ins);
        }
        box.append(h('div', { class: 'ch-code' }, head, h('pre', { text: p.text })));
      });
    }
    const addUser = (text) => { const m = h('div', { class: 'ch-msg user', text }); els.log.append(m); scroll(); return m; };
    const addBot = () => { const m = h('div', { class: 'ch-msg bot' }); els.log.append(m); scroll(); return m; };
    const addInfo = (text, cls) => { const m = h('div', { class: 'ch-info' + (cls ? ' ' + cls : ''), text }); els.log.append(m); scroll(); return m; };
    const scroll = () => { els.log.scrollTop = els.log.scrollHeight; };
    function hint() {
      els.log.replaceChildren();
      if (!ready()) addInfo('Чтобы начать, подключи API: нажми «Настройки» и укажи адрес, модель и ключ.');
      else addInfo('Спроси что-нибудь про код. По умолчанию отправляется только выделение или функция под курсором: так дешевле.');
    }

    /* sending */
    function setBusy(v) { busy = v; els.send.textContent = v ? 'Стоп' : 'Отправить'; els.send.classList.toggle('primary', !v); els.input.disabled = false; }
    async function send() {
      if (busy) { if (cfg && routes.size) { const id = [...routes.keys()][0]; api.aiAbort(id); } return; }
      if (!ready()) { await refresh(); if (!ready()) { settings(); return; } }
      const p = plan();
      if (!p.question) { els.input.focus(); return; }
      if (cfg.budget && used.in + used.out + p.estTokens > cfg.budget) {
        addInfo('Лимит сессии исчерпан (' + fmt(used.in + used.out) + ' из ' + fmt(cfg.budget) + '). Сбрось счётчик в настройках агента или увеличь лимит.', 'err');
        return;
      }
      if (!els.log.querySelector('.ch-msg')) els.log.replaceChildren();
      addUser(p.question + (p.ctx ? '\n[' + p.ctx.label + ']' : ''));
      if (p.note) addInfo(p.note);
      const box = addBot(); box.textContent = '…';
      const id = nextId++;
      let text = '';
      const draw = () => { renderBot(box, text, false); scroll(); };
      const finish = (ok, err, detail) => {
        setBusy(false);
        renderBot(box, text, true);
        if (err) { addInfo((ERR[err] || 'Ошибка: ' + err) + (detail && err !== 'aborted' ? '\n' + detail : ''), 'err'); if (err === 'aborted') box.append(h('div', { class: 'ch-info', text: '(остановлено)' })); }
        if (!text) box.remove();
        scroll();
      };
      routes.set(id, {
        chunk: (t) => { text += t; if (!box._r) box._r = requestAnimationFrame(() => { box._r = 0; draw(); }); },
        done: (u) => {
          const inT = u && u.prompt != null ? u.prompt : p.estTokens, outT = u && u.completion != null ? u.completion : PF.estimateTokens(text);
          used.in += inT; used.out += outT;
          history.push({ role: 'user', content: p.question }, { role: 'assistant', content: text });
          finish(true);
          els.input.value = ''; estimate();
        },
        error: (err, detail) => {
          if (err === 'aborted' && text) { history.push({ role: 'user', content: p.question }, { role: 'assistant', content: text }); els.input.value = ''; }
          finish(false, err, detail); estimate();
        }
      });
      setBusy(true);
      const r = await api.aiChat({ id, messages: p.messages });
      if (r && r.error) { routes.delete(id); finish(false, r.error); }
    }
    els.send.addEventListener('click', send);
    els.input.addEventListener('input', soon);
    els.ctx.addEventListener('change', () => { try { localStorage.setItem('pf-agent-ctx', els.ctx.value); } catch (e) { /* ignore */ } estimate(); });
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); send(); }
      else if (e.key === 'Escape' && busy) { e.preventDefault(); e.stopPropagation(); send(); }
    });
    $('chNew').addEventListener('click', () => { if (busy) send(); history = []; hint(); estimate(); els.input.focus(); });
    $('chCfg').addEventListener('click', () => settings());
    $('chClose').addEventListener('click', () => toggle(false));
    $('chPeek').addEventListener('click', () => {
      const p = plan();
      let rm = null;
      const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
      rm = modal('Что уйдёт на сервер', [
        h('div', { class: 'wz-note', text: 'Ровно это отправится по адресу ' + (cfg ? cfg.baseUrl : '') + ' (около ' + fmt(p.estTokens) + ' токенов). Секреты уже скрыты.' }),
        h('pre', { class: 'wz-cmd ch-peek', text: p.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n') })
      ], [close], () => rm(), 'gt');
      close.addEventListener('click', () => rm()); close.focus();
    });

    /* settings dialog */
    function settings(msg) {
      if (document.querySelector('.modal-back')) return;
      const f = (id, attrs) => h('input', { id, autocomplete: 'off', spellcheck: 'false', ...attrs });
      const url = f('agUrl', { type: 'text' }), model = f('agModel', { type: 'text', placeholder: 'например, маленькая быстрая модель' });
      const key = f('agKey', { type: 'password', placeholder: cfg && cfg.hasKey ? 'ключ сохранён (оставь пустым, чтобы не менять)' : 'sk-…' });
      const maxT = f('agMax', { type: 'number', min: '50', max: '8000', step: '50' }), keep = f('agKeep', { type: 'number', min: '0', max: '12' }), bud = f('agBud', { type: 'number', min: '0', step: '1000' });
      url.value = cfg.baseUrl; model.value = cfg.model; maxT.value = cfg.maxTokens; keep.value = cfg.keep; bud.value = cfg.budget;
      const status = h('div', { class: 'wz-status', 'aria-live': 'polite' });
      const say = (t, cls) => { status.textContent = t || ''; status.className = 'wz-status' + (cls ? ' ' + cls : ''); };
      const save = h('button', { class: 'chip primary', type: 'button', text: 'Сохранить' });
      const test = h('button', { class: 'chip', type: 'button', text: 'Проверить' });
      const del = h('button', { class: 'chip', type: 'button', text: 'Удалить ключ' });
      const reset = h('button', { class: 'chip', type: 'button', text: 'Сбросить счётчик' });
      const close = h('button', { class: 'chip', type: 'button', text: 'Закрыть' });
      let rm = null;
      const row = (label, el, id, note) => [h('label', { class: 'wz-lbl', for: id, text: label }), h('div', { class: 'wz-row' }, el), note ? h('div', { class: 'wz-note', text: note }) : null];
      rm = modal('Агент: подключение', [
        msg ? h('div', { class: 'wz-note', text: msg }) : null,
        ...row('Адрес API (OpenAI-совместимый)', url, 'agUrl', 'Код из редактора отправляется на этот сервер. Обычно адрес заканчивается на /v1.'),
        ...row('Модель', model, 'agModel', 'Для вопросов по коду хватает маленькой модели: она в разы дешевле.'),
        ...row('Ключ', key, 'agKey', cfg.canStoreKey ? 'Хранится зашифрованным системой и в интерфейс не возвращается.' : 'В этой системе нет хранилища ключей. Задай ключ переменной окружения PYFORGE_API_KEY и перезапусти редактор.'),
        ...row('Максимум в ответе, токенов', maxT, 'agMax', 'Ограничивает длину ответа, а значит и расход.'),
        ...row('Помнить прошлых сообщений', keep, 'agKeep', 'Каждое повторно отправляется с вопросом. 0 — каждый вопрос с чистого листа, дешевле всего.'),
        ...row('Лимит токенов на сессию (0 — без лимита)', bud, 'agBud'),
        status
      ], [reset, del, test, save, close], () => rm(), 'gt');
      const collect = () => ({ baseUrl: url.value, model: model.value, maxTokens: Number(maxT.value), keep: Number(keep.value), budget: Number(bud.value), ...(key.value.trim() ? { key: key.value } : {}) });
      const saveNow = async () => {
        const r = await api.aiSet(collect());
        if (r.error) { say({ 'bad-url': 'Адрес должен начинаться с https:// (http:// — только для localhost).', 'bad-model': 'Название модели: буквы, цифры и . : / @ + - без пробелов.', 'bad-limit': 'Числа вне допустимых пределов.', 'bad-key': 'Ключ выглядит неверно (слишком короткий или с пробелами).', 'no-encryption': 'В системе нет хранилища ключей. Используй PYFORGE_API_KEY.', write: 'Не удалось записать настройки.' }[r.error] || 'Ошибка: ' + r.error, 'err'); return false; }
        cfg = r.config; key.value = ''; key.placeholder = cfg.hasKey ? 'ключ сохранён (оставь пустым, чтобы не менять)' : 'sk-…';
        els.model.textContent = cfg.model || 'модель не выбрана'; estimate();
        return true;
      };
      save.addEventListener('click', async () => { if (await saveNow()) say('Сохранено.', 'ok'); });
      test.addEventListener('click', async () => {
        if (!(await saveNow())) return;
        if (!ready()) { say('Укажи модель и ключ.', 'err'); return; }
        say('Спрашиваю у сервера (потратится несколько токенов)…'); test.disabled = true;
        const id = nextId++;
        let text = '';
        const end = (m, cls) => { test.disabled = false; say(m, cls); };
        routes.set(id, { chunk: (t) => { text += t; }, done: (u) => end('Работает. Ответ: «' + text.trim().slice(0, 40) + '»' + (u && u.prompt != null ? ' (' + u.prompt + '+' + u.completion + ' токенов)' : ''), 'ok'), error: (e, d) => end((ERR[e] || e) + (d ? '\n' + d : ''), 'err') });
        const r = await api.aiChat({ id, messages: [{ role: 'user', content: 'Ответь одним словом: ок' }], maxTokens: 8 });
        if (r && r.error) { routes.delete(id); end(ERR[r.error] || r.error, 'err'); }
      });
      del.addEventListener('click', async () => { const r = await api.aiSet({ clearKey: true }); if (r.ok) { cfg = r.config; key.placeholder = 'sk-…'; say('Ключ удалён.', 'ok'); estimate(); } });
      reset.addEventListener('click', () => { used = { in: 0, out: 0 }; estimate(); say('Счётчик сброшен.', 'ok'); });
      close.addEventListener('click', () => rm());
      url.focus();
    }

    function toggle(force) {
      const on = force === undefined ? els.box.hidden : !!force;
      els.box.hidden = !on;
      document.body.classList.toggle('has-chat', on);
      if (on) { refresh().then(() => { if (!els.log.children.length) hint(); }); els.input.focus(); }
    }

    return { toggle, isOpen: () => !els.box.hidden };
  }

  root.PFAgent = { create };
})(window);
