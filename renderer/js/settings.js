/* Settings window (zoom, theme, animations, update check), the About window and the "new version" dialog. */
(function (root) {
  'use strict';
  const { h, modal } = root.PFModal;

  const DEFAULTS = { zoom: 1, anim: true, lens: true, clearBase: 0.46, updates: true, skip: '' };
  // Edit this list to change the names shown in "О программе".
  const AUTHORS = ['nelfw1cz', 'Claude', 'Qwen', 'fleet-charm'];

  const load = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pf-settings') || '{}') }; } catch (e) { return { ...DEFAULTS }; } };
  const save = (s) => { try { localStorage.setItem('pf-settings', JSON.stringify(s)); } catch (e) { /* storage may be unavailable */ } };
  const clampZoom = (z) => Math.round(Math.min(1.6, Math.max(0.7, Number(z) || 1)) * 10) / 10;

  function create({ api, toast, themes, themeIndex, setTheme, onMotion, onLens, onBase }) {
    const s = load();
    s.zoom = clampZoom(s.zoom);
    let live = null; // the open settings dialog's refresh function

    function applyZoom() {
      const z = api.setZoom ? api.setZoom(s.zoom) : s.zoom;
      if (typeof z === 'number') s.zoom = z;
    }
    function applyMotion() {
      document.documentElement.dataset.anim = s.anim ? 'on' : 'off';
      onMotion(!!s.anim);
    }
    function apply() { applyZoom(); applyMotion(); onLens(!!s.lens); onBase(s.clearBase); }
    function setZoom(z, say) {
      s.zoom = clampZoom(z); applyZoom(); save(s);
      if (live) live();
      if (say) toast('Масштаб ' + Math.round(s.zoom * 100) + '%');
    }

    /* ── update check ── */
    async function check(manual) {
      if (!api.checkUpdate) return null;
      const r = await api.checkUpdate();
      if (r.ok && r.newer && (manual || r.latest !== s.skip)) showUpdate(r);
      else if (manual) {
        toast(r.ok ? 'У вас последняя версия (' + r.current + ')'
          : r.error === 'no-releases' ? 'На GitHub пока нет релизов'
          : 'Не удалось проверить обновления');
      }
      return r;
    }
    function showUpdate(r) {
      let remove = null;
      const later = h('button', { class: 'chip', type: 'button', text: 'Позже' });
      const skip = h('button', { class: 'chip', type: 'button', text: 'Пропустить эту версию' });
      const go = h('button', { class: 'chip primary', type: 'button', text: 'Открыть страницу загрузки' });
      remove = modal('Доступна новая версия', [
        h('div', { class: 'wz-note', text: 'Вышла версия ' + r.latest + ', у вас ' + r.current + '. Скачай новую сборку со страницы релиза и замени файлы.' })
      ], [skip, later, go], () => remove());
      later.addEventListener('click', () => remove());
      skip.addEventListener('click', () => { s.skip = r.latest; save(s); remove(); });
      go.addEventListener('click', () => { api.openUrl(r.url); remove(); });
      go.focus();
    }

    /* ── about ── */
    async function about() {
      let info = {};
      try { info = (api.appInfo ? await api.appInfo() : {}) || {}; } catch (e) { info = {}; }
      let remove = null;
      const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
      const kids = [
        h('div', { class: 'ab-name', text: info.name || 'PyForge' }),
        h('div', { class: 'wz-note', text: 'Версия ' + (info.version || '—') }),
        h('div', { class: 'wz-note', text: 'Редактор кода на Electron: стеклянный интерфейс, карта связей, режим ботов aiogram, живые темы.' }),
        h('div', { class: 'wz-lbl', text: 'Авторы' }),
        h('ul', { class: 'ab-list' }, ...AUTHORS.map((a) => h('li', { text: a })))
      ];
      const btns = [close];
      if (info.repo) {
        const repo = h('button', { class: 'chip', type: 'button', text: 'GitHub' });
        repo.addEventListener('click', () => api.openUrl('https://github.com/' + info.repo));
        btns.unshift(repo);
      }
      remove = modal('О программе', kids, btns, () => remove());
      close.addEventListener('click', () => remove());
      close.focus();
    }


    function linuxHelp() {
      const p = (t) => h('div', { class: 'wz-note', text: t });
      const code = (t) => h('pre', { class: 'wz-cmd', text: t });
      let remove = null;
      const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
      remove = modal('Размытие на Linux', [
        p('Редактор просит у системы прозрачное окно, а само размытие рисует композитор рабочего стола. Без него окно будет просто прозрачным: тогда подними «Плотность стекла».'),
        h('div', { class: 'wz-lbl', text: 'Hyprland' }),
        p('Включи размытие в hyprland.conf. Оно применяется ко всем окнам с прозрачностью, в том числе к нашему:'),
        code('decoration {\n    blur {\n        enabled = true\n        size = 8\n        passes = 3\n    }\n}'),
        p('Класс окна смотри командой hyprctl clients, если понадобятся правила для одного окна. После включения опции перезапусти редактор.'),
        h('div', { class: 'wz-lbl', text: 'KDE Plasma' }),
        p('Включи эффект «Размытие» (Параметры системы → Поведение рабочей среды → Эффекты рабочего стола). Chromium сам не просит размытие у KWin, поэтому окно нужно добавить принудительно: в настройках эффекта «Размытие» есть принудительное размытие по классу окна, а в некоторых версиях Plasma для этого ставят расширение Better Blur. Название и место пункта зависят от версии.'),
        h('div', { class: 'wz-lbl', text: 'Другие окружения' }),
        p('GNOME: расширение Blur my Shell. Sway: форк SwayFX. X11 с picom: опция blur-background. Без композитора (или с выключенным) прозрачность не работает.'),
        p('Если окно стало чёрным, а не прозрачным, выключи опцию в настройках и перезапусти: это значит, что композитор не поддерживает прозрачные окна.')
      ], [close], () => remove());
      close.addEventListener('click', () => remove());
      close.focus();
    }

    /* ── settings dialog ── */
    function open() {
      if (document.querySelector('.modal-back')) return;
      const slider = h('input', { type: 'range', class: 'st-range', min: '70', max: '160', step: '10', 'aria-label': 'Масштаб интерфейса' });
      const zlabel = h('span', { class: 'st-val' });
      const zreset = h('button', { class: 'chip', type: 'button', text: '100%' });
      const chips = h('div', { class: 'st-themes', role: 'radiogroup', 'aria-label': 'Тема' });
      const anim = h('input', { type: 'checkbox' });
      const upd = h('input', { type: 'checkbox' });
      const lensCb = h('input', { type: 'checkbox' });
      const clearCb = h('input', { type: 'checkbox' });
      const clearNote = h('div', { class: 'wz-note' });
      const linuxBtn = h('button', { class: 'chip', type: 'button', text: 'Как включить размытие…' });
      linuxBtn.hidden = true;
      linuxBtn.addEventListener('click', () => linuxHelp());
      const dens = h('input', { type: 'range', class: 'st-range', min: '0', max: '70', step: '2', 'aria-label': 'Плотность стекла' });
      dens.value = String(Math.round((typeof s.clearBase === 'number' ? s.clearBase : 0.46) * 100));
      const densRow = h('div', { class: 'wz-row' }, h('span', { class: 'wz-note', text: 'Прозрачнее' }), dens, h('span', { class: 'wz-note', text: 'Плотнее' }));
      dens.addEventListener('input', () => { s.clearBase = dens.value / 100; save(s); onBase(s.clearBase); });
      const clearRow = h('label', { class: 'wz-chk', title: 'Рабочий стол просвечивает сквозь окно. Windows 11 и macOS.' }, clearCb, h('span', { text: 'Прозрачное окно (виден рабочий стол)' }));
      const now = h('button', { class: 'chip', type: 'button', text: 'Проверить сейчас' });
      const ab = h('button', { class: 'chip', type: 'button', text: 'О программе…' });
      const close = h('button', { class: 'chip primary', type: 'button', text: 'Закрыть' });
      let remove = null;

      const paintThemes = () => {
        chips.replaceChildren();
        themes().forEach((t, i) => {
          const on = i === themeIndex();
          const b = h('button', { class: 'chip' + (on ? ' primary' : ''), type: 'button', role: 'radio', 'aria-checked': String(on), text: t.name });
          b.addEventListener('click', () => { setTheme(i); paintThemes(); });
          chips.append(b);
        });
      };
      live = () => { slider.value = String(Math.round(s.zoom * 100)); zlabel.textContent = Math.round(s.zoom * 100) + '%'; };
      live(); paintThemes();
      anim.checked = !!s.anim; upd.checked = !!s.updates; lensCb.checked = !!s.lens;

      slider.addEventListener('input', () => setZoom(slider.value / 100, false));
      zreset.addEventListener('click', () => setZoom(1, false));
      anim.addEventListener('change', () => { s.anim = anim.checked; save(s); applyMotion(); });
      clearRow.hidden = true; clearNote.hidden = true; densRow.hidden = true;
      if (api.winGlassInfo) api.winGlassInfo().then((g) => {
        if (!g) return;
        clearRow.hidden = false; clearNote.hidden = false; densRow.hidden = !g.supported; linuxBtn.hidden = g.platform !== 'linux';
        clearCb.checked = g.enabled; clearCb.disabled = !g.supported;
        const say = () => { clearNote.textContent = !g.supported ? 'Нужна Windows 11, macOS или Linux с композитором.' : (clearCb.checked !== g.active ? 'Перезапусти редактор, чтобы применить.' : (g.platform === 'linux' && g.active ? 'Размытие рисует композитор: нажми «Как включить размытие…».' : '')); };
        say();
        clearCb.addEventListener('change', async () => { const r = await api.winGlassSet(clearCb.checked); if (r && r.error) clearCb.checked = !clearCb.checked; say(); });
      });
      lensCb.addEventListener('change', () => { s.lens = lensCb.checked; save(s); onLens(!!s.lens); });
      upd.addEventListener('change', () => { s.updates = upd.checked; save(s); });
      now.addEventListener('click', async () => { now.disabled = true; await check(true); now.disabled = false; });
      ab.addEventListener('click', () => { remove(); about(); });
      close.addEventListener('click', () => remove());

      const rm = modal('Настройки', [
        h('div', { class: 'wz-lbl', text: 'Масштаб интерфейса' }),
        h('div', { class: 'wz-row' }, slider, zlabel, zreset),
        h('div', { class: 'wz-lbl', text: 'Тема' }),
        chips,
        h('div', { class: 'wz-lbl', text: 'Поведение' }),
        h('label', { class: 'wz-chk' }, anim, h('span', { text: 'Анимации и свечение' })),
        h('label', { class: 'wz-chk', title: 'Только для темы Liquid glass. Нагружает видеокарту; на слабых ПК выключи.' }, lensCb, h('span', { text: 'Реалистичное стекло (WebGL, тема Liquid glass)' })),
        clearRow, clearNote, densRow, h('div', { class: 'wz-row' }, linuxBtn),
        h('label', { class: 'wz-chk' }, upd, h('span', { text: 'Проверять новые версии при запуске' })),
        h('div', { class: 'wz-row' }, now)
      ], [ab, close], () => remove());
      remove = () => { live = null; rm(); };
      slider.focus();
    }

    return {
      apply, open, about, check,
      zoomBy: (d) => setZoom(s.zoom + d, true),
      zoomReset: () => setZoom(1, true),
      scheduleCheck: () => { setTimeout(() => { if (s.updates) check(false); }, 4000); },
      get state() { return { ...s }; }
    };
  }

  root.PFSettings = { create, AUTHORS };
})(window);
