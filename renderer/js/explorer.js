/* Explorer: a folder tree in the left panel (open folder, expand, open file, new file/folder, rename, to recycle bin). */
(function (root) {
  'use strict';
  const { h } = root.PFModal;

  const under = (p, base) => !!p && !!base && (p === base || (p.startsWith(base) && /[\\/]/.test(p[base.length] || '')));
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage may be unavailable */ } }
  };
  const ERR = {
    exists: 'Файл или папка с таким именем уже есть.',
    'bad-name': 'Недопустимое имя: без / \\ : * ? " < > |, без пробела или точки в конце.',
    'bad-args': 'Недопустимый путь.'
  };
  const errText = (e) => ERR[e] || String(e);

  function create({ api, toast, onOpen, onRenamed, onTrashed, activePath }) {
    const panel = document.getElementById('explorer'), tree = document.getElementById('exTree');
    const empty = document.getElementById('exEmpty'), title = document.getElementById('exTitle');
    const toggleBtn = document.getElementById('exToggle');
    let rootDir = '', cache = new Map(), open = new Set(), sel = '';
    let visible = [], els = new Map(), shown = false, menuEl = null, lastFocusRefresh = 0;

    /* ── data ── */
    async function setRoot(dir, silent) {
      const r = await api.listDir(dir);
      if (r.error) { if (!silent) toast('Не удалось открыть папку: ' + r.error); return false; }
      rootDir = dir; cache = new Map([[dir, r.entries]]); open = new Set([dir]); sel = '';
      store.set('pf-root', dir);
      show(); render();
      return true;
    }
    async function openFolder() {
      const d = await api.pickDir();
      if (d) await setRoot(d);
    }
    async function refresh() {
      if (!rootDir) return;
      const dirs = [...open];
      const res = await Promise.all(dirs.map((d) => api.listDir(d)));
      dirs.forEach((d, i) => {
        if (res[i].error) { open.delete(d); cache.delete(d); } else cache.set(d, res[i].entries);
      });
      if (!cache.has(rootDir)) { rootDir = ''; store.set('pf-root', ''); }
      render();
    }
    async function toggleDir(p) {
      if (open.has(p)) { open.delete(p); render(); return; }
      if (!cache.has(p)) {
        const r = await api.listDir(p);
        if (r.error) { toast('Не удалось открыть папку: ' + r.error); return; }
        cache.set(p, r.entries);
      }
      open.add(p); render();
    }

    /* ── rendering ── */
    function render() {
      const hadFocus = panel.contains(document.activeElement) && !menuEl;
      title.textContent = rootDir ? baseName(rootDir) : 'Проводник';
      title.title = rootDir;
      empty.hidden = !!rootDir;
      tree.hidden = !rootDir;
      visible = []; els = new Map();
      const walk = (dir, depth) => {
        for (const e of cache.get(dir) || []) {
          visible.push({ e, depth });
          if (e.dir && open.has(e.path)) walk(e.path, depth + 1);
        }
      };
      if (rootDir) walk(rootDir, 0);
      if (!visible.some((v) => v.e.path === sel)) sel = visible.length ? visible[0].e.path : '';
      const frag = document.createDocumentFragment();
      const ap = activePath();
      for (const { e, depth } of visible) {
        const row = h('div', {
          class: 'ex-row' + (e.dir ? ' dir' : '') + (/\.py$/i.test(e.name) ? ' py' : '') + (e.path === ap ? ' on' : '') + (e.path === sel ? ' sel' : ''),
          role: 'treeitem', 'data-path': e.path, 'aria-level': String(depth + 1), title: e.path,
          tabindex: e.path === sel ? '0' : '-1'
        }, h('span', { class: 'ex-chev' }), h('span', { class: 'ex-name', text: e.name }));
        if (e.dir) row.setAttribute('aria-expanded', open.has(e.path) ? 'true' : 'false');
        row.style.setProperty('--d', depth);
        els.set(e.path, row);
        frag.append(row);
      }
      tree.replaceChildren(frag);
      if (rootDir && !visible.length) tree.append(h('div', { class: 'ex-empty-dir', text: 'Папка пуста' }));
      if (hadFocus && els.get(sel)) els.get(sel).focus();
    }
    function markActive() {
      const ap = activePath();
      els.forEach((el, p) => el.classList.toggle('on', p === ap));
    }
    function select(p, focus) {
      const prev = els.get(sel);
      if (prev) { prev.classList.remove('sel'); prev.tabIndex = -1; }
      sel = p;
      const el = els.get(p);
      if (el) { el.classList.add('sel'); el.tabIndex = 0; if (focus) { el.focus(); el.scrollIntoView({ block: 'nearest' }); } }
    }
    const entryAt = (p) => (visible.find((v) => v.e.path === p) || {}).e;

    /* ── actions ── */
    const targetDir = () => { const e = entryAt(sel); return !e ? rootDir : e.dir ? e.path : dirName(e.path); };
    async function newEntry(parent, isDir) {
      if (!rootDir) return;
      const name = await root.PFModal.prompt({ title: isDir ? 'Новая папка' : 'Новый файл', label: 'Имя', value: '', ok: 'Создать' });
      if (name == null) return;
      const r = await api.fsCreate({ parent, name: name.trim(), dir: isDir });
      if (r.error) { toast(errText(r.error)); return; }
      const l = await api.listDir(parent);
      if (!l.error) { cache.set(parent, l.entries); open.add(parent); }
      sel = r.path; render(); select(r.path, false);
      if (!isDir) onOpen(r.path);
    }
    async function rename(e) {
      const name = await root.PFModal.prompt({ title: 'Переименовать', label: 'Новое имя', value: e.name, ok: 'Переименовать' });
      if (name == null || name.trim() === e.name) return;
      const r = await api.fsRename({ path: e.path, name: name.trim() });
      if (r.error) { toast(errText(r.error)); return; }
      const remap = (p) => (under(p, e.path) ? r.path + p.slice(e.path.length) : p);
      open = new Set([...open].map(remap));
      cache = new Map([...cache].map(([k, v]) => [remap(k), v]));
      if (sel === e.path) sel = r.path;
      onRenamed(e.path, r.path);
      await refresh();
    }
    async function trash(e) {
      const ok = await root.PFModal.confirm({
        title: 'Удалить в корзину?',
        text: '«' + e.name + '»' + (e.dir ? ' вместе со всем содержимым' : '') + ' будет перемещён в корзину. Это можно отменить из самой корзины.',
        ok: 'В корзину'
      });
      if (!ok) return;
      const r = await api.fsTrash(e.path);
      if (r.error) { toast('Не удалось удалить: ' + r.error); return; }
      onTrashed(e.path);
      await refresh();
    }

    /* ── context menu ── */
    function closeMenu(restore) {
      if (!menuEl) return;
      menuEl.remove(); menuEl = null;
      document.removeEventListener('pointerdown', onOutside, true);
      if (restore && els.get(sel)) els.get(sel).focus();
    }
    function onOutside(ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(false); }
    function showMenu(x, y, items) {
      closeMenu(false);
      const m = h('div', { class: 'ctx', role: 'menu' });
      for (const it of items) {
        if (it === '-') { m.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
        const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '' }, h('span', { text: it.label }));
        if (it.key) b.append(h('kbd', { text: it.key }));
        b.addEventListener('click', () => { closeMenu(false); it.run(); });
        m.append(b);
      }
      m.addEventListener('keydown', (ev) => {
        const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
        else if (ev.key === 'Tab') { ev.preventDefault(); closeMenu(true); }
      });
      document.body.append(m);
      menuEl = m;
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
      m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
      document.addEventListener('pointerdown', onOutside, true);
      m.querySelector('button').focus();
    }
    function menuFor(e, x, y) {
      const common = [
        { label: 'Переименовать', key: 'F2', run: () => rename(e) },
        { label: 'Показать в проводнике', run: () => api.fsReveal(e.path) },
        '-',
        { label: 'Удалить в корзину', key: 'Del', danger: true, run: () => trash(e) }
      ];
      if (!e) {
        showMenu(x, y, [{ label: 'Новый файл', run: () => newEntry(rootDir, false) }, { label: 'Новая папка', run: () => newEntry(rootDir, true) }, '-', { label: 'Обновить', run: refresh }]);
      } else if (e.dir) {
        showMenu(x, y, [{ label: 'Новый файл', run: () => newEntry(e.path, false) }, { label: 'Новая папка', run: () => newEntry(e.path, true) }, '-', ...common]);
      } else {
        showMenu(x, y, [{ label: 'Открыть', run: () => onOpen(e.path) }, '-', ...common]);
      }
    }

    /* ── events ── */
    tree.addEventListener('click', (ev) => {
      const row = ev.target.closest('.ex-row');
      if (!row) return;
      const p = row.dataset.path, e = entryAt(p);
      select(p, true);
      if (e.dir) toggleDir(p); else onOpen(p);
    });
    tree.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const row = ev.target.closest('.ex-row');
      if (row) select(row.dataset.path, false);
      menuFor(row ? entryAt(row.dataset.path) : null, ev.clientX, ev.clientY);
    });
    tree.addEventListener('keydown', (ev) => {
      const i = visible.findIndex((v) => v.e.path === sel), cur = visible[i];
      const go = (k) => { if (visible.length) select(visible[Math.max(0, Math.min(visible.length - 1, k))].e.path, true); };
      if (ev.key === 'ArrowDown') { ev.preventDefault(); go(i + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(i - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); go(0); }
      else if (ev.key === 'End') { ev.preventDefault(); go(visible.length - 1); }
      else if (!cur) return;
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); if (cur.e.dir) { if (!open.has(cur.e.path)) toggleDir(cur.e.path); else go(i + 1); } }
      else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        if (cur.e.dir && open.has(cur.e.path)) toggleDir(cur.e.path);
        else { for (let k = i - 1; k >= 0; k--) if (visible[k].depth < cur.depth) { go(k); break; } }
      }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (cur.e.dir) toggleDir(cur.e.path); else onOpen(cur.e.path); }
      else if (ev.key === 'F2') { ev.preventDefault(); rename(cur.e); }
      else if (ev.key === 'Delete') { ev.preventDefault(); trash(cur.e); }
      else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
        ev.preventDefault();
        const r = (els.get(cur.e.path) || tree).getBoundingClientRect();
        menuFor(cur.e, r.left + 24, r.bottom);
      }
    });
    document.getElementById('exNewFile').addEventListener('click', () => newEntry(targetDir(), false));
    document.getElementById('exNewDir').addEventListener('click', () => newEntry(targetDir(), true));
    document.getElementById('exRefresh').addEventListener('click', refresh);
    document.getElementById('exClose').addEventListener('click', () => hide());
    document.getElementById('exOpen').addEventListener('click', openFolder);
    toggleBtn.addEventListener('click', () => toggle());
    addEventListener('focus', () => { // pick up files changed outside the editor
      if (!shown || !rootDir || Date.now() - lastFocusRefresh < 1500) return;
      lastFocusRefresh = Date.now(); refresh();
    });

    /* ── visibility ── */
    function show() {
      shown = true; panel.hidden = false; document.body.classList.add('has-ex');
      panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter');
      toggleBtn.setAttribute('aria-pressed', 'true'); store.set('pf-ex', '1');
    }
    function hide() {
      shown = false; panel.hidden = true; document.body.classList.remove('has-ex');
      toggleBtn.setAttribute('aria-pressed', 'false'); store.set('pf-ex', '0'); closeMenu(false);
    }
    function toggle() { if (shown) hide(); else { show(); render(); if (!rootDir) document.getElementById('exOpen').focus(); } }
    async function restore() {
      const wasShown = store.get('pf-ex') === '1';
      const saved = store.get('pf-root');
      if (saved) await setRoot(saved, true);
      if (wasShown) { show(); render(); } else hide();
    }
    render();
    return { setRoot, openFolder, toggle, refresh, markActive, restore, get root() { return rootDir; }, get visible() { return shown; } };
  }

  root.PFExplorer = { create, under };
})(window);
