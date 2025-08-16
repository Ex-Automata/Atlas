(function(){
  const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : { postMessage: ()=>{} };
  console.log('[canvas] webview script loaded, vscode API present=', !!vscode.postMessage);
  const canvas = document.getElementById('canvas');
  const zoomEl = document.getElementById('zoom');
  const ctx = canvas.getContext('2d');

  let dpr = window.devicePixelRatio || 1;
  let width = 0, height = 0;

  // world transform
  let tx = 0, ty = 0, scale = 1;

  // ensure browser gestures don't interfere with our own touch handling
  try { canvas.style.touchAction = 'none'; } catch {}

  const DOT_SPACING = 40; // world units

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = Math.floor(canvas.clientWidth);
    height = Math.floor(canvas.clientHeight);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function clear() {
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.restore();
  }

  function draw() {
    clear();
    // background fill via CSS, so skip filling here

    // transform to world
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    // pick dot color with low opacity
    ctx.fillStyle = 'rgba(200,200,200,0.18)';

    // visible bounds in world coordinates
    const left = -tx / scale;
    const top = -ty / scale;
    const right = (width) / scale - tx/scale;
    const bottom = (height) / scale - ty/scale;

    const startX = Math.floor(left / DOT_SPACING) * DOT_SPACING;
    const startY = Math.floor(top / DOT_SPACING) * DOT_SPACING;

    // draw dots
    const r = 0.8 / Math.max(0.25, scale); // keep dots visible across zoom
    for (let x = startX; x <= right; x += DOT_SPACING) {
      for (let y = startY; y <= bottom; y += DOT_SPACING) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI*2);
        ctx.fill();
      }
    }

    ctx.restore();
    zoomEl.textContent = scale.toFixed(2);
  }

  // Helpers for zoom/pan math
  function clampScale(s) {
    return Math.min(8, Math.max(0.1, s));
  }

  function toWorld(mx, my) {
    return { x: (mx - tx) / scale, y: (my - ty) / scale };
  }

  function setScaleAt(mx, my, newScale) {
    const world = toWorld(mx, my);
    const s = clampScale(newScale);
    tx = mx - world.x * s;
    ty = my - world.y * s;
    scale = s;
  }

  function panBy(dx, dy) {
    tx += dx;
    ty += dy;
  }

  // Panning
  let dragging = false;
  let last = { x: 0, y: 0 };

  canvas.addEventListener('mousedown', (ev) => {
    dragging = true;
    last = { x: ev.clientX, y: ev.clientY };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.style.cursor = 'default';
  });

  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - last.x;
    const dy = ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    tx += dx;
    ty += dy;
    draw();
  });

  // Zooming (wheel)
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    const wheel = ev.deltaY;
    const zoomFactor = Math.exp(-wheel * 0.0015); // smooth
    setScaleAt(mx, my, scale * zoomFactor);
    draw();
  }, { passive: false });

  // Touch interactions: one-finger pan, two-finger pinch-zoom
  let touchDragging = false;
  let lastTouch = { x: 0, y: 0 };
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchPivotWorld = { x: 0, y: 0 };

  function getTouchPositions(touches) {
    const rect = canvas.getBoundingClientRect();
    const pts = [];
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      pts.push({ x: t.clientX - rect.left, y: t.clientY - rect.top });
    }
    return pts;
  }

  function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  canvas.addEventListener('touchstart', (ev) => {
    // We fully manage scrolling/zooming gestures on the canvas
    ev.preventDefault();
    const pts = getTouchPositions(ev.touches);
    if (pts.length === 1) {
      touchDragging = true;
      pinching = false;
      lastTouch = { x: pts[0].x, y: pts[0].y };
      canvas.style.cursor = 'grabbing';
    } else if (pts.length >= 2) {
      touchDragging = false;
      pinching = true;
      const a = pts[0], b = pts[1];
      pinchStartDist = distance(a, b);
      pinchStartScale = scale;
      const mid = midpoint(a, b);
      pinchPivotWorld = toWorld(mid.x, mid.y);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    const pts = getTouchPositions(ev.touches);
    if (pinching && pts.length >= 2) {
      const a = pts[0], b = pts[1];
      const mid = midpoint(a, b);
      const d = distance(a, b);
      if (pinchStartDist > 0) {
        const targetScale = clampScale(pinchStartScale * (d / pinchStartDist));
        // Set tx/ty so that the pivot world point remains under current midpoint
        tx = mid.x - pinchPivotWorld.x * targetScale;
        ty = mid.y - pinchPivotWorld.y * targetScale;
        scale = targetScale;
        draw();
      }
    } else if (touchDragging && pts.length === 1) {
      const p = pts[0];
      const dx = p.x - lastTouch.x;
      const dy = p.y - lastTouch.y;
      lastTouch = { x: p.x, y: p.y };
      panBy(dx, dy);
      draw();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (ev) => {
    ev.preventDefault();
    const count = ev.touches ? ev.touches.length : 0;
    if (count === 0) {
      touchDragging = false;
      pinching = false;
      canvas.style.cursor = 'default';
    } else if (count === 1) {
      // transition back to single-finger drag if needed
      pinching = false;
      const pts = getTouchPositions(ev.touches);
      lastTouch = { x: pts[0].x, y: pts[0].y };
      touchDragging = true;
      canvas.style.cursor = 'grabbing';
    }
  }, { passive: false });

  canvas.addEventListener('touchcancel', () => {
    touchDragging = false;
    pinching = false;
    canvas.style.cursor = 'default';
  }, { passive: false });

  // handle resize
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  window.addEventListener('resize', resize);

  // initial size
  requestAnimationFrame(resize);

  // listen for messages from extension host
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'openEntrypoint') {
      // placeholder visual feedback
      console.log('openEntrypoint', msg.entry);
    }
  });

  // Drag & drop files: forward file paths to the extension host for now
  function onDragOver(ev) {
    // allow drop
    ev.preventDefault();
    try {
      ev.dataTransfer.dropEffect = 'copy';
    } catch {}
  }

  // Helpers for robust path extraction
  function fromFileUri(u) {
    if (!u) return null;
    if (!u.startsWith('file://')) return null;
    try {
      return decodeURIComponent(u.replace(/^file:\/+/, '/'));
    } catch {
      return u;
    }
  }

  function isAbsolutePath(p) {
    return typeof p === 'string' && (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p));
  }

  function collectFromJson(val, out) {
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val;
      const walk = (node) => {
        if (!node) return;
        if (typeof node === 'string') {
          const maybe = fromFileUri(node) || (isAbsolutePath(node) ? node : null);
          if (maybe) out.add(maybe);
          return;
        }
        if (Array.isArray(node)) {
          for (const n of node) walk(n);
          return;
        }
        if (typeof node === 'object') {
          // common VS Code shapes
          if (node.scheme === 'file' && typeof node.path === 'string') out.add(node.path);
          if (typeof node.file === 'string') {
            const maybe = fromFileUri(node.file) || (isAbsolutePath(node.file) ? node.file : null);
            if (maybe) out.add(maybe);
          }
          for (const k of Object.keys(node)) walk(node[k]);
        }
      };
      walk(data);
    } catch {
      // ignore non-JSON strings
    }
  }

  async function onDrop(ev) {
    ev.preventDefault();
    const dt = ev.dataTransfer;
    console.log('[canvas] drop event', dt);
    if (!dt) return;

    const types = Array.from(dt.types || []);
    console.log('[canvas] dataTransfer types', types);

  const unique = new Set();
  let rawText = null;

    // 1) try text/uri-list (common when dragging files from OS)
    try {
      if (typeof dt.getData === 'function') {
        const uriList = dt.getData('text/uri-list');
        if (uriList) {
          rawText = uriList;
          const lines = uriList.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          for (const l of lines) {
            // turn file:// URLs into local paths when possible
            const p = fromFileUri(l);
            if (p) unique.add(p);
          }
        }
      }
    } catch (err) {
      console.warn('[canvas] failed to read text/uri-list', err);
    }

    // 2) file items (highest-fidelity next)
    try {
      if (dt.items && dt.items.length > 0) {
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i];
          if (item.kind === 'file') {
            const f = item.getAsFile && item.getAsFile();
            if (f) {
              if (f.path && isAbsolutePath(f.path)) unique.add(f.path);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[canvas] error reading dataTransfer.items(file)', err);
    }

    // 3) VS Code-specific JSON payloads in string items
    try {
      if (dt.items && dt.items.length > 0 && unique.size === 0) {
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i];
          if (item.kind === 'string') {
            await new Promise(resolve => item.getAsString((s) => { collectFromJson(s, unique); resolve(); }));
          }
        }
      }
    } catch (err) {
      console.warn('[canvas] error reading dataTransfer.items(string)', err);
    }

    // 4) plain text fallback (only if it looks like a path/URI and nothing else found)
    if (unique.size === 0) {
      try {
        const plain = dt.getData && dt.getData('text/plain');
        if (plain) {
          rawText = rawText || plain;
          const lines = plain.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          for (const l of lines) {
            const u = fromFileUri(l);
            if (u) unique.add(u);
            else if (isAbsolutePath(l)) unique.add(l);
          }
        }
      } catch (err) {
        console.warn('[canvas] failed to read text/plain', err);
      }
    }

    const paths = Array.from(unique);
    console.log('[canvas] dropped paths (final)', paths, 'rawText=', rawText);

    try {
      if (typeof vscode.postMessage === 'function') {
        vscode.postMessage({ type: 'fileDrop', paths, rawText, rawTypes: types });
      }
    } catch (err) {
      console.error('failed to postMessage from canvas webview', err);
    }
  }

  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
})();
