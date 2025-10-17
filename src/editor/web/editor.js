(function () {
    const CDN_BASE =
        "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/min";
    /** @type {import('monaco-editor')} */ let monaco = undefined;

    function loadMonacoOnce() {
        if (monaco) return Promise.resolve();
        const ensureLoader = () =>
            new Promise((resolve, reject) => {
                if (window.require && window.require.config) return resolve();
                // Dynamically load AMD loader from CDN if not present
                const src = `${CDN_BASE}/vs/loader.min.js`;
                const already = Array.from(document.scripts).some(
                    (s) => s.src === src
                );
                if (already) return resolve();
                const s = document.createElement("script");
                s.src = src;
                s.defer = true;
                s.onload = () => {
                    resolve();
                };
                s.onerror = (e) => {
                    reject(new Error("Failed to load AMD loader"));
                };
                document.head.appendChild(s);
            });
        return ensureLoader().then(
            () =>
                new Promise((resolve, reject) => {
                    if (!(window.require && window.require.config))
                        return reject(new Error("AMD loader not available"));
                    window.MonacoEnvironment = {
                        getWorkerUrl: () => {
                            const blob = new Blob(
                                [
                                    `self.MonacoEnvironment = { baseUrl: '${CDN_BASE}/' };\n` +
                                        `importScripts('${CDN_BASE}/vs/base/worker/workerMain.js');`,
                                ],
                                { type: "text/javascript" }
                            );
                            return URL.createObjectURL(blob);
                        },
                    };
                    window.require.config({ paths: { vs: `${CDN_BASE}/vs` } });
                    window.require(
                        ["vs/editor/editor.main"],
                        (m) => {
                            monaco = m;
                            resolve();
                        },
                        (err) => {
                            reject(err);
                        }
                    );
                })
        );
    }

    // Module-local registry for editor instances
    const registry = new Map();

    function getEditor(id) {
        if (!id) return null;
        if (registry.has(id)) return registry.get(id);
        const esc =
            window.CSS && typeof CSS.escape === "function"
                ? CSS.escape(id)
                : String(id).replace(/"/g, '\\"');
        const shell = document.querySelector(
            `.editor-shell[data-editor-id="${esc}"]`
        );
        if (shell) {
            const inst = createInstance(shell);
            registry.set(inst.id, inst);
            return inst;
        }
        return null;
    }

    // Global message router: dispatch to the addressed instance by id
    window.addEventListener("message", (ev) => {
        const msg = ev.data;
        if (!msg || !msg.id || !msg.type) return;
        const inst = getEditor(msg.id);
        inst?.onMessage?.(msg);
    });

    function createInstance(root) {
        const rid = root.getAttribute("data-editor-id");
        root.setAttribute("data-editor-id", rid);
        const els = {
            title: root.querySelector("#editorTitle"),
            monacoHost: root.querySelector("#monacoContainer"),
            diffHost: root.querySelector("#diffContainer"),
            btnCollapse: root.querySelector("#btn-collapse"),
            btnFullscreen: root.querySelector("#btn-fullscreen"),
            btnDiff: root.querySelector("#btn-diff"),
            btnLoadNeighbors: root.querySelector("#btn-load-neighbors"),
        };
        const ds = root.dataset || {};
        const state = {
            id: rid,
            initialized: false,
            collapsed: false,
            // Tri-state: 0 = titlebar only (unloaded), 1 = 20-line preview, 2 = full (all lines)
            collapseState: 2,
            fullscreen: false,
            diff: (ds.diff || "off") === "on",
            language: ds.language || "plaintext",
            theme: ds.theme || "auto",
            modelUri: null,
            content: "",
            original: "",
            modified: "",
        };
        // Wire control buttons
        els.btnCollapse?.addEventListener("click", () => cycleCollapse());
        els.btnFullscreen?.addEventListener("click", () => toggleFullscreen());
        els.btnDiff?.addEventListener("click", () => toggleDiff());
        els.btnLoadNeighbors?.addEventListener("click", () => loadNeighbors());

        // Observe theme attribute
        els.btnFullscreen?.setAttribute("aria-pressed", "false");

        let editor = null; // single
        let diffEditor = null; // diff
        const models = { single: null, original: null, modified: null };
        const disposables = [];
        let resizeObserver = null;
    let heightRaf = 0;
    // track editor DOM listener so we can attach directly to Monaco's DOM node
    let attachedEditorDom = null;

        function post(msg) {
            try {
                if (msg && typeof msg === "object" && msg.id == null)
                    msg.id = state.id;
                window.vscode?.postMessage?.(msg);
            } catch {}
        }
        function applyTheme() {
            const containerTheme =
                root.getAttribute("data-theme") || state.theme || "auto";
            const prefersDark =
                window.matchMedia &&
                window.matchMedia("(prefers-color-scheme: dark)").matches;
            const mode =
                containerTheme === "auto"
                    ? prefersDark
                        ? "dark"
                        : "light"
                    : containerTheme;
            if (monaco)
                monaco.editor.setTheme(mode === "dark" ? "vs-dark" : "vs");
            state.theme = containerTheme;
        }
        function disposeModel(kind) {
            const m = models[kind];
            if (m && !m.isDisposed()) m.dispose();
            models[kind] = null;
        }
        function ensureSingleModel() {
            if (models.single && !models.single.isDisposed())
                return models.single;
            const uri = state.modelUri
                ? monaco.Uri.parse(state.modelUri)
                : monaco.Uri.parse(`inmemory://model/${Date.now()}`);
            models.single = monaco.editor.createModel(
                state.content || "",
                state.language,
                uri
            );
            return models.single;
        }
        function ensureDiffModels() {
            const make = (text, label) =>
                monaco.editor.createModel(
                    text || "",
                    state.language,
                    monaco.Uri.parse(`inmemory://diff/${label}/${Date.now()}`)
                );
            disposeModel("single");
            disposeModel("original");
            disposeModel("modified");
            models.original = make(state.original, "original");
            models.modified = make(state.modified, "modified");
            return { original: models.original, modified: models.modified };
        }
        function layout() {
            if (editor) editor.layout();
            if (diffEditor) diffEditor.layout();
        }
        function getWrapper() {
            // editor root is inside the canvas wrapper (editor-host)
            return root && root.parentElement ? root.parentElement : root;
        }
        function titlebarHeight() {
            const tb = root.querySelector(".editor-titlebar");
            return (tb && tb.offsetHeight) || 42;
        }
        function getActiveEditorForMetrics() {
            if (state.diff && diffEditor && !diffEditor._disposed) {
                return (
                    (typeof diffEditor.getModifiedEditor === "function" &&
                        diffEditor.getModifiedEditor()) || editor
                );
            }
            return editor;
        }
        // If editor can't scroll further in the wheel direction, propagate to canvas to pan.
        function onRootWheel(ev) {
            try {
                // Only handle vertical wheel motion
                const deltaY = ev.deltaY || 0;
                if (deltaY === 0) return;
                const ed = getActiveEditorForMetrics();
                // If no editor instance, forward the event to canvas
                if (!ed || typeof ed.getScrollTop !== "function") {
                    ev.preventDefault();
                    window.dispatchEvent(new CustomEvent("atlas:editorWheel", { detail: { deltaY } }));
                    return;
                }

                // Compute scroll positions using Monaco API
                const scrollTop = ed.getScrollTop();
                const scrollHeight = ed.getScrollHeight();
                const domNode = ed.getDomNode && ed.getDomNode();
                const clientHeight = domNode ? domNode.clientHeight : 0;
                
                if (deltaY > 0) {
                    // scrolling down -> if at (or very near) bottom, forward
                    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
                    if (atBottom) {
                        ev.preventDefault();
                        window.dispatchEvent(new CustomEvent("atlas:editorWheel", { detail: { deltaY } }));
                    }
                    // otherwise let Monaco handle native scrolling
                } else {
                    // scrolling up -> if at (or very near) top, forward
                    const atTop = scrollTop <= 1;
                    if (atTop) {
                        ev.preventDefault();
                        window.dispatchEvent(new CustomEvent("atlas:editorWheel", { detail: { deltaY } }));
                    }
                }
            } catch (e) {
                // on any error, forward to canvas to be safe
                console.warn && console.warn("[editor] wheel handler error, forwarding to canvas", e);
                try {
                    ev.preventDefault();
                    window.dispatchEvent(new CustomEvent("atlas:editorWheel", { detail: { deltaY: ev.deltaY || 0 } }));
                } catch (err) {
                    console.error && console.error("[editor] failed to forward wheel after error", err);
                }
            }
        }
        function getLineHeight() {
            try {
                const ed = getActiveEditorForMetrics();
                if (ed && monaco && monaco.editor && monaco.editor.EditorOption)
                    return (
                        ed.getOption(monaco.editor.EditorOption.lineHeight) || 20
                    );
            } catch {}
            return 20;
        }
        function scheduleHeightApply() {
            if (heightRaf) cancelAnimationFrame(heightRaf);
            heightRaf = requestAnimationFrame(() => {
                heightRaf = 0;
                if (state.collapseState === 0) setWrapperHeightTitlebarOnly();
                else if (state.collapseState === 1) setWrapperHeightForLines(20);
                else setWrapperHeightForLines(Math.max(1, getVisibleLineCount()));
            });
        }
        function getVisibleLineCount() {
            try {
                if (state.diff && diffEditor && !diffEditor._disposed) {
                    const m = diffEditor.getModel();
                    const a = m?.original?.getLineCount?.() || 0;
                    const b = m?.modified?.getLineCount?.() || 0;
                    return Math.max(a, b) || 0;
                }
                if (editor && !editor._disposed) {
                    const m = editor.getModel?.();
                    return (m && m.getLineCount && m.getLineCount()) || 0;
                }
            } catch {}
            return 0;
        }
        function setWrapperHeightForLines(lines) {
            const wrap = getWrapper();
            if (!wrap) return;
            const lh = getLineHeight();
            const extra = 16; // scrollbar/padding allowance
            const h = Math.max(0, Math.floor(lines * lh + titlebarHeight() + extra));
            wrap.style.height = `${h}px`;
            requestAnimationFrame(layout);
        }
        function setWrapperHeightTitlebarOnly() {
            const wrap = getWrapper();
            if (!wrap) return;
            wrap.style.height = `${titlebarHeight()}px`;
            requestAnimationFrame(layout);
        }
        function createEditorIfNeeded() {
            if (state.collapsed) return;
            if (state.diff) {
                disposeEditor("single");
                if (!diffEditor || diffEditor._disposed) {
                    const { original, modified } = ensureDiffModels();
                    diffEditor = monaco.editor.createDiffEditor(els.diffHost, {
                        readOnly: false,
                        renderSideBySide: true,
                        enableSplitViewResizing: true,
                        automaticLayout: false,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        wordWrap: "off",
                    });
                    diffEditor.setModel({ original, modified });
                    const modModel = diffEditor.getModel()?.modified;
                    if (modModel) {
                        const sub = modModel.onDidChangeContent(() => {
                            try {
                                const val = modModel.getValue();
                                state.modified = val;
                                state.content = val;
                                post({ type: "change", value: val });
                            } catch {}
                        });
                        disposables.push(sub);
                    }
                    els.diffHost.removeAttribute("hidden");
                    // attach to modified editor DOM inside diff editor
                    try {
                        const maybe =
                            typeof diffEditor.getModifiedEditor === "function" &&
                            diffEditor.getModifiedEditor();
                        const node = maybe && maybe.getDomNode && maybe.getDomNode();
                        if (node && !node.__atlasWheelAttached) {
                            node.addEventListener("wheel", onRootWheel, { passive: false });
                            node.__atlasWheelAttached = true;
                            attachedEditorDom = node;
                        }
                    } catch (e) {
                        console.warn && console.warn("[editor] failed to attach wheel to diff editor DOM", e);
                    }
                }
            } else {
                disposeEditor("diff");
                if (!editor || editor._disposed) {
                    const model = ensureSingleModel();
                    editor = monaco.editor.create(els.monacoHost, {
                        model,
                        automaticLayout: false,
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        wordWrap: "off",
                    });
                    const sub = editor.onDidChangeModelContent(() => {
                        const val = editor.getValue();
                        state.content = val;
                        post({ type: "change", value: val });
                        if (state.collapseState === 2) scheduleHeightApply();
                    });
                    disposables.push(sub);
                    
                    // Listen for cursor position changes
                    const cursorSub = editor.onDidChangeCursorPosition((e) => {
                        const position = e.position;
                        post({ 
                            type: "cursorPositionChange", 
                            line: position.lineNumber - 1, // Convert to 0-based
                            column: position.column - 1 
                        });
                    });
                    disposables.push(cursorSub);
                    
                    // Listen for selection changes
                    const selectionSub = editor.onDidChangeCursorSelection((e) => {
                        const selection = e.selection;
                        post({ 
                            type: "selectionChange",
                            start: { 
                                line: selection.startLineNumber - 1, // Convert to 0-based
                                column: selection.startColumn - 1 
                            },
                            end: { 
                                line: selection.endLineNumber - 1, 
                                column: selection.endColumn - 1 
                            }
                        });
                    });
                    disposables.push(selectionSub);
                    // attach wheel handling directly to Monaco's DOM node so we reliably see wheel events
                    try {
                        const node = editor.getDomNode && editor.getDomNode();
                        if (node && !node.__atlasWheelAttached) {
                            node.addEventListener("wheel", onRootWheel, { passive: false });
                            node.__atlasWheelAttached = true;
                            attachedEditorDom = node;
                        }
                    } catch (e) {
                        console.warn && console.warn("[editor] failed to attach wheel to editor DOM", e);
                    }
                }
            }
            layout();
        }
        function disposeEditor(which) {
            if (which === "single" || which === "all") {
                if (editor && !editor._disposed) {
                    try {
                        state.content = editor.getValue();
                    } catch {}
                    editor.dispose();
                }
                editor = null;
                disposeModel("single");
            }
            if (which === "diff" || which === "all") {
                if (diffEditor && !diffEditor._disposed) {
                    try {
                        const m = diffEditor.getModel()?.modified;
                        if (m) state.modified = m.getValue();
                    } catch {}
                    diffEditor.dispose();
                }
                diffEditor = null;
                disposeModel("original");
                disposeModel("modified");
                els.diffHost?.setAttribute("hidden", "");
            }
            while (disposables.length) {
                try {
                    disposables.pop().dispose();
                } catch {}
            }
        }
        function toggleCollapse(force) {
            const next = typeof force === "boolean" ? force : !state.collapsed;
            state.collapsed = next;
            els.btnCollapse?.setAttribute("aria-pressed", String(next));
            if (next) disposeEditor("all");
            else createEditorIfNeeded();
            post({ type: "collapsed", value: next });
        }

        function applyCollapseState() {
            // 0 = titlebar only (unloaded)
            // 1 = 20-line preview
            // 2 = full height (all lines)
            const s = state.collapseState;
            if (s === 0) {
                // collapse/unload and shrink wrapper to titlebar height
                toggleCollapse(true);
                setWrapperHeightTitlebarOnly();
                return;
            }
            // ensure expanded and editor created for 1 or 2
            toggleCollapse(false);
            createEditorIfNeeded();
            if (s === 1) {
                setWrapperHeightForLines(20);
            } else {
                const lc = Math.max(1, getVisibleLineCount());
                setWrapperHeightForLines(lc);
            }
        }

        function cycleCollapse() {
            // Cycle 0 -> 1 -> 2 -> 0
            state.collapseState = (state.collapseState + 1) % 3;
            applyCollapseState();
        }
        function toggleFullscreen(force) {
            const next = typeof force === "boolean" ? force : !state.fullscreen;
            state.fullscreen = next;
            els.btnFullscreen?.setAttribute("aria-pressed", String(next));
            layout();
            post({ type: "fullscreen", value: next });
        }
        function toggleDiff(force) {
            const next = typeof force === "boolean" ? force : !state.diff;
            if (state.diff === next) return;
            state.diff = next;
            root.setAttribute("data-diff", next ? "on" : "off");
            els.btnDiff?.setAttribute("aria-pressed", String(next));
            if (next) {
                if (!state.original) state.original = state.content || "";
                state.modified = state.content || "";
            } else {
                if (models.modified && !models.modified.isDisposed())
                    state.content = models.modified.getValue();
            }
            disposeEditor("all");
            createEditorIfNeeded();
            scheduleHeightApply();
            post({ type: "diff", value: next });
        }
        function loadNeighbors() {
            post({ type: "loadNeighbors" });
        }
        function setValue(text) {
            state.content = text || "";
            if (editor && !state.diff) editor.setValue(state.content);
            else if (state.diff && diffEditor) {
                const m = diffEditor.getModel();
                if (m?.modified) m.modified.setValue(state.content);
            }
            scheduleHeightApply();
        }
        function getValue() {
            if (editor && !state.diff) return editor.getValue();
            if (state.diff && diffEditor) {
                const m = diffEditor.getModel();
                if (m?.modified) return m.modified.getValue();
            }
            return state.content || "";
        }
        function setDiff(original, modified) {
            state.original = original || "";
            state.modified = modified || "";
            if (!state.diff) toggleDiff(true);
            if (diffEditor) {
                const mdl = diffEditor.getModel();
                mdl?.original?.setValue(state.original);
                mdl?.modified?.setValue(state.modified);
            }
        }
        function setLanguage(lang) {
            state.language = lang || state.language;
            const apply = (m) =>
                m &&
                !m.isDisposed() &&
                monaco.editor.setModelLanguage(m, state.language);
            apply(models.single);
            apply(models.original);
            apply(models.modified);
        }
        function setTitle(title) {
            if (els.title) {
                els.title.textContent = title;
                els.title.title = title;
            }
        }
        function setTheme(theme) {
            root.setAttribute("data-theme", theme);
            applyTheme();
        }
        function onMessage(msg) {
            if (!msg || typeof msg !== "object") return;
            if (msg.id != null && msg.id !== state.id) return;
            switch (msg.type) {
                case "setContent":
                    setValue(msg.value || "");
                    if (msg.language) setLanguage(msg.language);
                    if (msg.uri) state.modelUri = msg.uri;
                    break;
                case "getContent":
                    post({
                        type: "content",
                        value: getValue(),
                        requestId: msg.requestId,
                    });
                    break;
                case "setDiff":
                    setDiff(msg.original || "", msg.modified || "");
                    if (msg.language) setLanguage(msg.language);
                    break;
                case "setLanguage":
                    setLanguage(msg.language);
                    break;
                case "setTitle":
                    setTitle(msg.title);
                    break;
                case "setTheme":
                    setTheme(msg.theme);
                    break;
                case "toggleCollapse":
                    toggleCollapse(!!msg.value);
                    break;
                case "toggleDiff":
                    toggleDiff(!!msg.value);
                    break;
                case "toggleFullscreen":
                    toggleFullscreen(!!msg.value);
                    break;
                case "setCursorPosition":
                    if (editor && msg.line !== undefined && msg.column !== undefined) {
                        const position = { lineNumber: msg.line + 1, column: msg.column + 1 }; // Convert to 1-based
                        editor.setPosition(position);
                        editor.revealPosition(position);
                    }
                    break;
                case "getCursorPosition":
                    if (editor) {
                        const position = editor.getPosition();
                        post({
                            type: "cursorPosition",
                            line: position.lineNumber - 1, // Convert to 0-based
                            column: position.column - 1,
                            requestId: msg.requestId,
                        });
                    }
                    break;
                case "setSelection":
                    if (editor && msg.start && msg.end) {
                        const selection = {
                            startLineNumber: msg.start.line + 1, // Convert to 1-based
                            startColumn: msg.start.column + 1,
                            endLineNumber: msg.end.line + 1,
                            endColumn: msg.end.column + 1
                        };
                        editor.setSelection(selection);
                        editor.revealRange(selection);
                    }
                    break;
                case "getSelection":
                    if (editor) {
                        const selection = editor.getSelection();
                        post({
                            type: "selection",
                            start: { 
                                line: selection.startLineNumber - 1, // Convert to 0-based
                                column: selection.startColumn - 1 
                            },
                            end: { 
                                line: selection.endLineNumber - 1, 
                                column: selection.endColumn - 1 
                            },
                            requestId: msg.requestId,
                        });
                    }
                    break;
                case "loadNeighbors":
                    loadNeighbors();
                    break;
                default:
                    break;
            }
        }
        function dispose() {
            disposeEditor("all");
            try {
                resizeObserver?.disconnect();
            } catch {}
            try {
                // detach wheel handler if present
                root.removeEventListener("wheel", onRootWheel, { passive: false });
            } catch {}
            resizeObserver = null;
        }

        // Wire control buttons
    // (re-wire above) collapse handled by cycleCollapse
        els.btnFullscreen?.addEventListener("click", () => {
            return toggleFullscreen();
        });
        els.btnDiff?.addEventListener("click", () => {
            return toggleDiff();
        });

        // Observe theme attribute
        new MutationObserver(() => {
            applyTheme();
        }).observe(root, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });

        // Build after monaco
        loadMonacoOnce()
            .then(() => {
                applyTheme();
                createEditorIfNeeded();
                attachResize();
                state.initialized = true;
                post({ type: "ready" });
                // apply initial collapse mode (full by default)
                applyCollapseState();
                // Attach wheel handler to root to detect overflow and forward to canvas when appropriate
                try {
                    root.addEventListener("wheel", onRootWheel, { passive: false });
                } catch {}
            })
            .catch((err) => {
                console.error("Failed to load Monaco", err);
                post({ type: "error", error: String(err) });
            });

        function attachResize() {
            resizeObserver = new ResizeObserver(() => {
                layout();
            });
            resizeObserver.observe(root);
            window.addEventListener("resize", layout);
        }

        const api = {
            id: rid,
            root,
            state,
            onMessage,
            setValue,
            getValue,
            setLanguage,
            setDiff,
            setTheme,
            setTitle,
            toggleCollapse,
            cycleCollapse,
            toggleDiff,
            toggleFullscreen,
            loadNeighbors,
            dispose,
        };
        // register locally
        registry.set(rid, api);
        return api;
    }

    // Auto-initialize editors present in DOM, and any added later
    function initShell(root) {
        if (!root) return null;
        const idAttr =
            root.getAttribute("data-editor-id") ||
            `ed-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
        root.setAttribute("data-editor-id", idAttr);
        if (registry.has(idAttr)) return registry.get(idAttr);
        return createInstance(root);
    }

    function initAllEditorsIn(container = document) {
        const nodes = container.querySelectorAll(".editor-shell");
        for (const n of nodes) initShell(n);
    }

    function start() {
        initAllEditorsIn(document);
        // watch for dynamically added editor-shells
        const mo = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type !== "childList") continue;
                m.addedNodes?.forEach((node) => {
                    if (!(node instanceof Element)) return;
                    if (node.matches?.(".editor-shell")) initShell(node);
                    else if (node.querySelector) initAllEditorsIn(node);
                });
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", start);
    else start();

    // no global exports; EditorBridge controls editors by posting messages with id
})();
