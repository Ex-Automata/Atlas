(function(){
  // Atlas UI logic
  const vscode = acquireVsCodeApi();
  let monacoReady = false;
  let tiles = new Map(); // file -> {el, x, y, w, h, minimized, editor}
  let relations = new Map(); // file -> Set(related)
  let pan = { x: 0, y: 0 };
  let scale = 1;
  let theme = 'vs';
  const GRID_SPACING = 24; // px in world units

  function detectTheme() {
    const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast') || document.body.classList.contains('vscode-high-contrast-light');
    theme = dark ? 'vs-dark' : 'vs';
    if (monacoReady && window.monaco) monaco.editor.setTheme(theme);
  }
  const mo = new MutationObserver(detectTheme);
  mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class'] });
  detectTheme();

  function updateGrid() {
    const viewport = document.getElementById('viewport');
    const size = Math.max(4, GRID_SPACING * scale);
    const mod = (n, m) => ((n % m) + m) % m;
    viewport.style.backgroundSize = size + 'px ' + size + 'px';
    viewport.style.backgroundPosition = mod(pan.x, size) + 'px ' + mod(pan.y, size) + 'px';
  }

  function setWorldTransform() {
    const world = document.getElementById('world');
    world.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + scale + ')';
    updateGrid();
    drawWires();
  }

  function ensureEmptyPlaceholder() {
    const empty = document.getElementById('empty');
    empty.style.display = tiles.size === 0 ? 'block' : 'none';
  }

  function makeEditor(file, content, language) {
    const t = tiles.get(file); if (!t) return;
    if (!window.require || !monacoReady) {
      t.editorHost.textContent = (content||'').slice(0, 4000);
      t.editorHost.style.whiteSpace = 'pre';
      t.editorHost.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      t.editorHost.style.fontSize = '12px';
      t.editorHost.style.padding = '8px';
      t.editorHost.style.overflow = 'auto';
      return;
    }
    t.editor = monaco.editor.create(t.editorHost, {
      value: content || '',
      language: language || 'plaintext',
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      theme,
    });
  }

  function disposeEditor(file) {
    const t = tiles.get(file); if (!t) return;
    if (t.editor && t.editor.dispose) t.editor.dispose();
    t.editor = null;
    t.editorHost.innerHTML = '';
  }

  function toggleTile(file) {
    const t = tiles.get(file); if (!t) return;
    t.minimized = !t.minimized;
    t.el.classList.toggle('min', t.minimized);
    if (t.minimized) {
      disposeEditor(file);
      t.el.style.width = (t.wMin || 220) + 'px';
      t.el.style.height = 'auto';
    } else {
      vscode.postMessage({ type: 'loadFile', file });
      t.el.style.width = (t.w || 520) + 'px';
      t.el.style.height = (t.h || 400 + 32) + 'px';
    }
    queueDrawWires();
  }

  function updateRelated(file, related) {
    const t = tiles.get(file); if (!t) return;
    relations.set(file, new Set(related||[]));
    t.badges.innerHTML = '';
    (related||[]).slice(0, 20).forEach(r => {
      const b = document.createElement('button');
      b.className = 'badge';
      b.title = r;
      b.textContent = r.split('/').slice(-2).join('/');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tiles.has(r)) {
          toggleTile(r);
        } else {
          vscode.postMessage({ type: 'loadFile', file: r });
        }
      });
      t.badges.appendChild(b);
    });
    queueDrawWires();
  }

  function addResizeHandle(t) {
    const r = document.createElement('div');
    r.className = 'resize';
    t.el.appendChild(r);
    r.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, w: t.el.offsetWidth, h: t.el.offsetHeight };
      const onMove = (ev) => {
        const dw = ev.clientX - start.x; const dh = ev.clientY - start.y;
        const w = Math.max(260, start.w + dw);
        const h = Math.max(120, start.h + dh);
        t.el.style.width = w + 'px';
        t.el.style.height = h + 'px';
        t.w = w; t.h = h;
        queueDrawWires();
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function createTile(file, content, language, related=[]) {
    if (tiles.has(file)) {
      updateRelated(file, related);
      const t = tiles.get(file);
      if (!t.editor && !t.minimized && (content != null)) makeEditor(file, content, language);
      return tiles.get(file).el;
    }
    const el = document.createElement('div');
    el.className = 'tile';
    el.style.left = (40 + Math.random()*60) + 'px';
    el.style.top = (40 + Math.random()*60) + 'px';

    const head = document.createElement('div');
    head.className = 'head';
    head.title = file;
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = file.split('/').slice(-3).join('/');
    const badges = document.createElement('div');
    badges.className = 'badges';

    head.appendChild(title);
    head.appendChild(badges);

    const editorHost = document.createElement('div');
    editorHost.className = 'editor';

    el.appendChild(head);
    el.appendChild(editorHost);
    document.getElementById('world').appendChild(el);

    const tile = { el, x: parseFloat(el.style.left)||0, y: parseFloat(el.style.top)||0, w: 520, h: 432, wMin: 220, minimized: false, editor: null, editorHost, badges, file };
    tiles.set(file, tile);

    addResizeHandle(tile);

    head.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, ox: tile.x, oy: tile.y };
      el.style.zIndex = String(Date.now());
      const onMove = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        tile.x = start.ox + dx; tile.y = start.oy + dy;
        el.style.left = tile.x + 'px'; el.style.top = tile.y + 'px';
        queueDrawWires();
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    title.addEventListener('click', () => toggleTile(file));

    updateRelated(file, related);
    if (content != null) makeEditor(file, content, language);

    ensureEmptyPlaceholder();
    queueDrawWires();
    return el;
  }

  function getTileBounds(file) {
    const t = tiles.get(file); if (!t) return null;
    const el = t.el;
    const x = parseFloat(el.style.left)||0;
    const y = parseFloat(el.style.top)||0;
    const w = el.offsetWidth || t.w || 520;
    const h = el.offsetHeight || t.h || 432;
    return { x, y, w, h };
  }

  function drawWires() {
    const svg = document.getElementById('wires');
    if (!svg) return;
    svg.innerHTML = '';
    relations.forEach((rels, from) => {
      const a = getTileBounds(from); if (!a) return;
      rels.forEach(to => {
        const b = getTileBounds(to); if (!b) return;
        const fromRightDist = Math.abs((a.x + a.w) - b.x);
        const fromLeftDist = Math.abs(a.x - (b.x + b.w));
        const fromRight = fromRightDist <= fromLeftDist;
        const ax = fromRight ? (a.x + a.w) : a.x;
        const ay = a.y + Math.min(a.h - 20, 20);
        const bx = (Math.abs(ax - b.x) < Math.abs(ax - (b.x + b.w))) ? b.x : (b.x + b.w);
        const by = b.y + Math.min(b.h - 20, 20);
        const mx = (ax + bx) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M ' + ax + ' ' + ay + ' C ' + mx + ' ' + ay + ', ' + mx + ' ' + by + ', ' + bx + ' ' + by);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--tile-border)');
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
      });
    });
  }

  let wireTimer = null;
  function queueDrawWires() {
    if (wireTimer) cancelAnimationFrame(wireTimer);
    wireTimer = requestAnimationFrame(drawWires);
  }

  function serializeState() {
    const tileArr = [];
    tiles.forEach((t, file) => {
      tileArr.push({ file, x: t.x, y: t.y, w: t.w || t.el.offsetWidth, h: t.h || t.el.offsetHeight, minimized: t.minimized });
    });
    return { pan, scale, tiles: tileArr };
  }

  function saveState() {
    vscode.postMessage({ type: 'saveState', state: serializeState() });
  }

  // Hook state saves
  function onMovedOrResized() { queueDrawWires(); saveState(); }

  // Patch move/resize handlers to call saveState
  const origSetupPanning = (function(){
    const viewport = document.getElementById('viewport');
    viewport.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tile')) return;
      viewport.classList.add('panning');
      const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      const onMove = (ev) => { pan.x = start.px + (ev.clientX - start.x); pan.y = start.py + (ev.clientY - start.y); setWorldTransform(); };
      const onUp = () => { viewport.classList.remove('panning'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); saveState(); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });

  // Wrap createTile to add save hooks
  const _createTile = createTile;
  createTile = function(file, content, language, related){
    const el = _createTile(file, content, language, related);
    const t = tiles.get(file);
    const head = el.querySelector('.head');
    head.addEventListener('pointerup', saveState);
    const resize = el.querySelector('.resize');
    if (resize) resize.addEventListener('pointerup', saveState);
    return el;
  };

  (function setupPanning(){
    const viewport = document.getElementById('viewport');
    viewport.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tile')) return; // ignore when starting on tile
      viewport.classList.add('panning');
      const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      const onMove = (ev) => { pan.x = start.px + (ev.clientX - start.x); pan.y = start.py + (ev.clientY - start.y); setWorldTransform(); };
      const onUp = () => { viewport.classList.remove('panning'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  })();

  (function setupZoom(){
    const viewport = document.getElementById('viewport');
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    viewport.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // zoom only when holding Ctrl
      e.preventDefault();
      const prev = scale;
      const factor = Math.exp(-e.deltaY * 0.001);
      scale = clamp(prev * factor, 0.25, 3);
      const rect = viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      pan.x = cx - (cx - pan.x) * (scale / prev);
      pan.y = cy - (cy - pan.y) * (scale / prev);
      setWorldTransform();
    }, { passive: false });
  })();

  (function setupDnD(){
    const viewport = document.getElementById('viewport');
    ['dragenter','dragover'].forEach(ev => viewport.addEventListener(ev, (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; viewport.classList.add('dragover'); }));
    viewport.addEventListener('dragleave', (e) => { if (e.target === viewport) viewport.classList.remove('dragover'); });
    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      viewport.classList.remove('dragover');
      const uris = new Set();
      const uriList = e.dataTransfer.getData('text/uri-list');
      if (uriList) uriList.split(/\r?\n/).filter(Boolean).forEach(u => uris.add(u));
      const txt = e.dataTransfer.getData('text/plain');
      if (txt && /^file:\/\//.test(txt)) uris.add(txt.trim());
      for (const f of (e.dataTransfer.files || [])) {
        if (f.path) uris.add(f.path);
      }
      if (uris.size === 0) return;
      uris.forEach(u => vscode.postMessage({ type: 'loadFile', file: u }));
    });
  })();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      ensureEmptyPlaceholder();
      setWorldTransform();
    } else if (msg.type === 'fileData') {
      const rel = Array.isArray(msg.related) ? msg.related : [];
      createTile(msg.file, msg.content, msg.language, rel);
    } else if (msg.type === 'restore' && msg.state) {
      pan = msg.state.pan || pan; scale = msg.state.scale ?? scale; setWorldTransform();
      (msg.state.tiles || []).forEach(t => {
        const el = _createTile(t.file, null, null, []);
        const tile = tiles.get(t.file);
        tile.x = t.x; tile.y = t.y; tile.w = t.w; tile.h = t.h; tile.minimized = !!t.minimized;
        el.style.left = tile.x + 'px'; el.style.top = tile.y + 'px';
        el.style.width = (tile.minimized ? (tile.wMin || 220) : (tile.w || 520)) + 'px';
        if (!tile.minimized) el.style.height = (tile.h || 432) + 'px';
        if (!tile.minimized) vscode.postMessage({ type: 'loadFile', file: t.file });
      });
      ensureEmptyPlaceholder();
      queueDrawWires();
    }
  });

  if (window.require) {
    window.require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
    window.require(['vs/editor/editor.main'], function() {
      monacoReady = true;
      detectTheme();
      tiles.forEach((t, file) => { if (!t.minimized && !t.editor) vscode.postMessage({ type: 'loadFile', file }); });
    });
  }
})();
