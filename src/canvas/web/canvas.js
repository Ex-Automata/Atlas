(function () {
    if (!window.vscode) {
        window.vscode =
            typeof acquireVsCodeApi === "function"
                ? acquireVsCodeApi()
                : { postMessage: () => {} };
    }
    console.log(
        "[canvas] webview script loaded, vscode API present=",
        !!vscode.postMessage
    );
    const canvas = document.getElementById("canvas");
    const zoomEl = document.getElementById("zoom");
    const worldEl = document.getElementById("world");
    const ctx = canvas.getContext("2d");

    // shared metrics
    let dpr = window.devicePixelRatio || 1;
    let width = 0,
        height = 0;

    // Canvas rendering helper
    const CanvasRenderer = (() => {
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
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
        }

        function draw() {
            clear();
            // transform to world
            ctx.save();
            const t = CanvasNav.getTransform();
            ctx.translate(t.tx, t.ty);
            ctx.scale(t.scale, t.scale);

            // pick dot color with low opacity
            ctx.fillStyle = "rgba(200,200,200,0.18)";

            // visible bounds in world coordinates
            const left = -t.tx / t.scale;
            const top = -t.ty / t.scale;
            const right = width / t.scale - t.tx / t.scale;
            const bottom = height / t.scale - t.ty / t.scale;

            const startX = Math.floor(left / DOT_SPACING) * DOT_SPACING;
            const startY = Math.floor(top / DOT_SPACING) * DOT_SPACING;

            // draw dots
            const r = 0.8 / Math.max(0.25, t.scale); // keep dots visible across zoom
            for (let x = startX; x <= right; x += DOT_SPACING) {
                for (let y = startY; y <= bottom; y += DOT_SPACING) {
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            ctx.restore();

            if (zoomEl) zoomEl.textContent = t.scale.toFixed(2);

            // Update world DOM layer transform to follow canvas pan/zoom
            if (worldEl) {
                worldEl.style.transformOrigin = "0 0";
                worldEl.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
            }
        }

        return {
            resize,
            clear,
            draw,
        };
    })();

    // Navigation helper: pan/zoom state and handlers
    const CanvasNav = (() => {
        // world transform
        let tx = 0,
            ty = 0,
            scale = 1;

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

        function getTransform() {
            return { tx, ty, scale };
        }

        // mouse pan state
        let mouseDragging = false;
        let lastMouse = { x: 0, y: 0 };

        // touch state
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
            const dx = a.x - b.x,
                dy = a.y - b.y;
            return Math.hypot(dx, dy);
        }

        function midpoint(a, b) {
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }

        // register event handlers
        function registerHandlers() {
            // ensure browser gestures don't interfere with our own touch handling
            try {
                canvas.style.touchAction = "none";
            } catch {}

            canvas.addEventListener("mousedown", (ev) => {
                mouseDragging = true;
                lastMouse = { x: ev.clientX, y: ev.clientY };
                canvas.style.cursor = "grabbing";
            });

            window.addEventListener("mouseup", () => {
                mouseDragging = false;
                canvas.style.cursor = "default";
            });

            window.addEventListener("mousemove", (ev) => {
                if (!mouseDragging) return;
                const dx = ev.clientX - lastMouse.x;
                const dy = ev.clientY - lastMouse.y;
                lastMouse = { x: ev.clientX, y: ev.clientY };
                panBy(dx, dy);
                CanvasRenderer.draw();
            });

            // wheel zoom
            canvas.addEventListener(
                "wheel",
                (ev) => {
                    ev.preventDefault();
                    const rect = canvas.getBoundingClientRect();
                    const mx = ev.clientX - rect.left;
                    const my = ev.clientY - rect.top;

                    const wheel = ev.deltaY;
                    const zoomFactor = Math.exp(-wheel * 0.0015); // smooth
                    setScaleAt(mx, my, scale * zoomFactor);
                    CanvasRenderer.draw();
                },
                { passive: false }
            );

            // touch interactions: one-finger pan, two-finger pinch-zoom
            canvas.addEventListener(
                "touchstart",
                (ev) => {
                    ev.preventDefault();
                    const pts = getTouchPositions(ev.touches);
                    if (pts.length === 1) {
                        touchDragging = true;
                        pinching = false;
                        lastTouch = { x: pts[0].x, y: pts[0].y };
                        canvas.style.cursor = "grabbing";
                    } else if (pts.length >= 2) {
                        touchDragging = false;
                        pinching = true;
                        const a = pts[0],
                            b = pts[1];
                        pinchStartDist = distance(a, b);
                        pinchStartScale = scale;
                        const mid = midpoint(a, b);
                        pinchPivotWorld = toWorld(mid.x, mid.y);
                    }
                },
                { passive: false }
            );

            canvas.addEventListener(
                "touchmove",
                (ev) => {
                    ev.preventDefault();
                    const pts = getTouchPositions(ev.touches);
                    if (pinching && pts.length >= 2) {
                        const a = pts[0],
                            b = pts[1];
                        const mid = midpoint(a, b);
                        const d = distance(a, b);
                        if (pinchStartDist > 0) {
                            const targetScale = clampScale(
                                pinchStartScale * (d / pinchStartDist)
                            );
                            // Set tx/ty so that the pivot world point remains under current midpoint
                            tx = mid.x - pinchPivotWorld.x * targetScale;
                            ty = mid.y - pinchPivotWorld.y * targetScale;
                            scale = targetScale;
                            CanvasRenderer.draw();
                        }
                    } else if (touchDragging && pts.length === 1) {
                        const p = pts[0];
                        const dx = p.x - lastTouch.x;
                        const dy = p.y - lastTouch.y;
                        lastTouch = { x: p.x, y: p.y };
                        panBy(dx, dy);
                        CanvasRenderer.draw();
                    }
                },
                { passive: false }
            );

            canvas.addEventListener(
                "touchend",
                (ev) => {
                    ev.preventDefault();
                    const count = ev.touches ? ev.touches.length : 0;
                    if (count === 0) {
                        touchDragging = false;
                        pinching = false;
                        canvas.style.cursor = "default";
                    } else if (count === 1) {
                        pinching = false;
                        const pts = getTouchPositions(ev.touches);
                        lastTouch = { x: pts[0].x, y: pts[0].y };
                        touchDragging = true;
                        canvas.style.cursor = "grabbing";
                    }
                },
                { passive: false }
            );

            canvas.addEventListener(
                "touchcancel",
                () => {
                    touchDragging = false;
                    pinching = false;
                    canvas.style.cursor = "default";
                },
                { passive: false }
            );
        }

        return {
            registerHandlers,
            setScaleAt,
            panBy,
            toWorld,
            getTransform,
        };
    })();

    // register nav handlers and resize observer
    CanvasNav.registerHandlers();
    const ro = new ResizeObserver(CanvasRenderer.resize);
    ro.observe(canvas);
    window.addEventListener("resize", CanvasRenderer.resize);

    // initial size
    requestAnimationFrame(CanvasRenderer.resize);

    // No explicit canvasReady handshake is required; assets are statically included.

    // listen for messages from extension host
    window.addEventListener("message", (ev) => {
        const msg = ev.data;
        if (!msg) return;
        else if (msg.type === "addToCanvas") {
            try {
                const host = worldEl || document.getElementById("root");
                const wrapper = document.createElement("div");
                wrapper.className = "widget editor-host";
                // Multiple editor support: offset each new editor horizontally
                const existing = host.querySelectorAll(".editor-host");
                const offsetX = 80 + existing.length * 1000; // 900px wide + 100px gap
                const WORLD_X = offsetX,
                    WORLD_Y = 80,
                    WORLD_W = 900,
                    WORLD_H = 600;
                wrapper.style.left = `${WORLD_X}px`;
                wrapper.style.top = `${WORLD_Y}px`;
                wrapper.style.width = `${WORLD_W}px`;
                wrapper.style.height = `${WORLD_H}px`;
                wrapper.style.boxShadow = "0 6px 18px rgba(0,0,0,0.25)";
                wrapper.style.borderRadius = "8px";
                wrapper.style.overflow = "hidden";
                wrapper.style.zIndex = 10 + existing.length;
                // Preserve payload object so we can load scripts via webview-safe URIs
                wrapper.innerHTML = msg.html;
                
                host.appendChild(wrapper);

                // Make editor draggable by its titlebar
                const titlebar = wrapper.querySelector(".editor-titlebar");
                let dragging = false,
                    dragStart = null,
                    startLeft = 0,
                    startTop = 0;
                if (titlebar) {
                    titlebar.style.cursor = "grab";
                    titlebar.addEventListener("mousedown", (ev) => {
                        dragging = true;
                        dragStart = { x: ev.clientX, y: ev.clientY };
                        startLeft = parseInt(wrapper.style.left, 10) || 0;
                        startTop = parseInt(wrapper.style.top, 10) || 0;
                        titlebar.style.cursor = "grabbing";
                        ev.preventDefault();
                        ev.stopPropagation();
                    });
                    window.addEventListener("mousemove", (ev) => {
                        if (!dragging) return;
                        const dx = ev.clientX - dragStart.x;
                        const dy = ev.clientY - dragStart.y;
                        wrapper.style.left = `${startLeft + dx}px`;
                        wrapper.style.top = `${startTop + dy}px`;
                    });
                    window.addEventListener("mouseup", () => {
                        if (dragging) {
                            dragging = false;
                            titlebar.style.cursor = "grab";
                        }
                    });
                }
            } catch (err) {
                console.error("Failed to displayHtml", err);
            }
        }
    });

    // Drag & drop files: forward file paths to the extension host for now
    function onDragOver(ev) {
        // allow drop
        ev.preventDefault();
        try {
            ev.dataTransfer.dropEffect = "copy";
        } catch {}
    }

    // Helpers for robust path extraction
    function fromFileUri(u) {
        if (!u) return null;
        if (!u.startsWith("file://")) return null;
        try {
            return decodeURIComponent(u.replace(/^file:\/+/, "/"));
        } catch {
            return u;
        }
    }

    function isAbsolutePath(p) {
        return (
            typeof p === "string" &&
            (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p))
        );
    }

    function collectFromJson(val, out) {
        try {
            const data = typeof val === "string" ? JSON.parse(val) : val;
            const walk = (node) => {
                if (!node) return;
                if (typeof node === "string") {
                    const maybe =
                        fromFileUri(node) ||
                        (isAbsolutePath(node) ? node : null);
                    if (maybe) out.add(maybe);
                    return;
                }
                if (Array.isArray(node)) {
                    for (const n of node) walk(n);
                    return;
                }
                if (typeof node === "object") {
                    // common VS Code shapes
                    if (node.scheme === "file" && typeof node.path === "string")
                        out.add(node.path);
                    if (typeof node.file === "string") {
                        const maybe =
                            fromFileUri(node.file) ||
                            (isAbsolutePath(node.file) ? node.file : null);
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
        console.log("[canvas] drop event", dt);
        if (!dt) return;

        const types = Array.from(dt.types || []);
        console.log("[canvas] dataTransfer types", types);

        const unique = new Set();
        let rawText = null;

        // 1) try text/uri-list (common when dragging files from OS)
        try {
            if (typeof dt.getData === "function") {
                const uriList = dt.getData("text/uri-list");
                if (uriList) {
                    rawText = uriList;
                    const lines = uriList
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    for (const l of lines) {
                        // turn file:// URLs into local paths when possible
                        const p = fromFileUri(l);
                        if (p) unique.add(p);
                    }
                }
            }
        } catch (err) {
            console.warn("[canvas] failed to read text/uri-list", err);
        }

        // 2) file items (highest-fidelity next)
        try {
            if (dt.items && dt.items.length > 0) {
                for (let i = 0; i < dt.items.length; i++) {
                    const item = dt.items[i];
                    if (item.kind === "file") {
                        const f = item.getAsFile && item.getAsFile();
                        if (f) {
                            if (f.path && isAbsolutePath(f.path))
                                unique.add(f.path);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(
                "[canvas] error reading dataTransfer.items(file)",
                err
            );
        }

        // 3) VS Code-specific JSON payloads in string items
        try {
            if (dt.items && dt.items.length > 0 && unique.size === 0) {
                for (let i = 0; i < dt.items.length; i++) {
                    const item = dt.items[i];
                    if (item.kind === "string") {
                        await new Promise((resolve) =>
                            item.getAsString((s) => {
                                collectFromJson(s, unique);
                                resolve();
                            })
                        );
                    }
                }
            }
        } catch (err) {
            console.warn(
                "[canvas] error reading dataTransfer.items(string)",
                err
            );
        }

        // 4) plain text fallback (only if it looks like a path/URI and nothing else found)
        if (unique.size === 0) {
            try {
                const plain = dt.getData && dt.getData("text/plain");
                if (plain) {
                    rawText = rawText || plain;
                    const lines = plain
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    for (const l of lines) {
                        const u = fromFileUri(l);
                        if (u) unique.add(u);
                        else if (isAbsolutePath(l)) unique.add(l);
                    }
                }
            } catch (err) {
                console.warn("[canvas] failed to read text/plain", err);
            }
        }

        const paths = Array.from(unique);
        console.log(
            "[canvas] dropped paths (final)",
            paths,
            "rawText=",
            rawText
        );

        try {
            if (typeof vscode.postMessage === "function") {
                vscode.postMessage({
                    type: "fileDrop",
                    paths,
                    rawText,
                    rawTypes: types,
                });
            }
        } catch (err) {
            console.error("failed to postMessage from canvas webview", err);
        }
    }

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
})();
