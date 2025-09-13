(function () {
    console.log("DEBUG: <anonymous>");
    const CDN_BASE =
        "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.49.0/min";
    /** @type {import('monaco-editor')} */ let monaco = undefined;

    function loadMonacoOnce() {
        console.log("DEBUG: loadMonacoOnce");
        if (monaco) return Promise.resolve();
        const ensureLoader = () =>
            new Promise((resolve, reject) => {
                console.log("DEBUG: ensureLoader");
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
                    console.log("DEBUG: loaderOnload");
                    resolve();
                };
                s.onerror = (e) => {
                    console.log("DEBUG: loaderOnerror");
                    reject(new Error("Failed to load AMD loader"));
                };
                document.head.appendChild(s);
            });
        return ensureLoader().then(
            () =>
                new Promise((resolve, reject) => {
                    console.log("DEBUG: configureMonacoRequire");
                    if (!(window.require && window.require.config))
                        return reject(new Error("AMD loader not available"));
                    window.MonacoEnvironment = {
                        getWorkerUrl: () => {
                            console.log("DEBUG: getWorkerUrl");
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
                            console.log("DEBUG: requireCallback");
                            monaco = m;
                            resolve();
                        },
                        (err) => {
                            console.log("DEBUG: requireError");
                            reject(err);
                        }
                    );
                })
        );
    }

    // Module-local registry for editor instances
    const registry = new Map();

    function getEditor(id) {
        console.log("DEBUG: getEditor");
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
        console.log("DEBUG: windowMessageHandler");
        const msg = ev.data;
        if (!msg || !msg.id || !msg.type) return;
        const inst = getEditor(msg.id);
        inst?.onMessage?.(msg);
    });

    function createInstance(root) {
        console.log("DEBUG: createInstance");
        const rid = root.getAttribute("data-editor-id");
        root.setAttribute("data-editor-id", rid);
        const els = {
            title: root.querySelector("#editorTitle"),
            monacoHost: root.querySelector("#monacoContainer"),
            diffHost: root.querySelector("#diffContainer"),
            btnCollapse: root.querySelector("#btn-collapse"),
            btnFullscreen: root.querySelector("#btn-fullscreen"),
            btnDiff: root.querySelector("#btn-diff"),
        };
        const ds = root.dataset || {};
        const state = {
            id: rid,
            initialized: false,
            collapsed: false,
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
        els.btnCollapse?.addEventListener("click", () => toggleCollapse());
        els.btnFullscreen?.addEventListener("click", () => toggleFullscreen());
        els.btnDiff?.addEventListener("click", () => toggleDiff());

        // Observe theme attribute
        els.btnFullscreen?.setAttribute("aria-pressed", "false");

        let editor = null; // single
        let diffEditor = null; // diff
        const models = { single: null, original: null, modified: null };
        const disposables = [];
        let resizeObserver = null;

        function post(msg) {
            console.log("DEBUG: post", msg);
            try {
                if (msg && typeof msg === "object" && msg.id == null)
                    msg.id = state.id;
                window.vscode?.postMessage?.(msg);
            } catch {}
        }
        function applyTheme() {
            console.log("DEBUG: applyTheme");
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
            console.log("DEBUG: disposeModel");
            const m = models[kind];
            if (m && !m.isDisposed()) m.dispose();
            models[kind] = null;
        }
        function ensureSingleModel() {
            console.log("DEBUG: ensureSingleModel");
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
            console.log("DEBUG: ensureDiffModels");
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
            console.log("DEBUG: layout");
            if (editor) editor.layout();
            if (diffEditor) diffEditor.layout();
        }
        function createEditorIfNeeded() {
            console.log("DEBUG: createEditorIfNeeded");
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
                            console.log("DEBUG: diffModified_onDidChangeContent");
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
                        console.log("DEBUG: editor_onDidChangeModelContent");
                        const val = editor.getValue();
                        state.content = val;
                        post({ type: "change", value: val });
                    });
                    disposables.push(sub);
                }
            }
            layout();
        }
        function disposeEditor(which) {
            console.log("DEBUG: disposeEditor");
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
            console.log("DEBUG: toggleCollapse");
            const next = typeof force === "boolean" ? force : !state.collapsed;
            state.collapsed = next;
            els.btnCollapse?.setAttribute("aria-pressed", String(next));
            if (next) disposeEditor("all");
            else createEditorIfNeeded();
            post({ type: "collapsed", value: next });
        }
        function toggleFullscreen(force) {
            console.log("DEBUG: toggleFullscreen");
            const next = typeof force === "boolean" ? force : !state.fullscreen;
            state.fullscreen = next;
            els.btnFullscreen?.setAttribute("aria-pressed", String(next));
            layout();
            post({ type: "fullscreen", value: next });
        }
        function toggleDiff(force) {
            console.log("DEBUG: toggleDiff");
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
            post({ type: "diff", value: next });
        }
        function setValue(text) {
            console.log("DEBUG: setValue");
            state.content = text || "";
            if (editor && !state.diff) editor.setValue(state.content);
            else if (state.diff && diffEditor) {
                const m = diffEditor.getModel();
                if (m?.modified) m.modified.setValue(state.content);
            }
        }
        function getValue() {
            console.log("DEBUG: getValue");
            if (editor && !state.diff) return editor.getValue();
            if (state.diff && diffEditor) {
                const m = diffEditor.getModel();
                if (m?.modified) return m.modified.getValue();
            }
            return state.content || "";
        }
        function setDiff(original, modified) {
            console.log("DEBUG: setDiff");
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
            console.log("DEBUG: setLanguage");
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
            console.log("DEBUG: setTitle");
            if (els.title) {
                els.title.textContent = title;
                els.title.title = title;
            }
        }
        function setTheme(theme) {
            console.log("DEBUG: setTheme");
            root.setAttribute("data-theme", theme);
            applyTheme();
        }
        function onMessage(msg) {
            console.log("DEBUG: onMessage");
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
                default:
                    break;
            }
        }
        function dispose() {
            console.log("DEBUG: dispose");
            disposeEditor("all");
            try {
                resizeObserver?.disconnect();
            } catch {}
            resizeObserver = null;
        }

        // Wire control buttons
        els.btnCollapse?.addEventListener("click", () => {
            console.log("DEBUG: btnCollapse_click");
            return toggleCollapse();
        });
        els.btnFullscreen?.addEventListener("click", () => {
            console.log("DEBUG: btnFullscreen_click");
            return toggleFullscreen();
        });
        els.btnDiff?.addEventListener("click", () => {
            console.log("DEBUG: btnDiff_click");
            return toggleDiff();
        });

        // Observe theme attribute
        new MutationObserver(() => {
            console.log("DEBUG: themeMutationObserver");
            applyTheme();
        }).observe(root, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });

        // Build after monaco
        loadMonacoOnce()
            .then(() => {
                console.log("DEBUG: loadMonacoOnce_then");
                applyTheme();
                createEditorIfNeeded();
                attachResize();
                state.initialized = true;
                post({ type: "ready" });
            })
            .catch((err) => {
                console.log("DEBUG: loadMonacoOnce_catch");
                console.error("Failed to load Monaco", err);
                post({ type: "error", error: String(err) });
            });

        function attachResize() {
            console.log("DEBUG: attachResize");
            resizeObserver = new ResizeObserver(() => {
                console.log("DEBUG: resizeObserverCallback");
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
            toggleDiff,
            toggleFullscreen,
            dispose,
        };
        // register locally
        registry.set(rid, api);
        return api;
    }

    // Auto-initialize editors present in DOM, and any added later
    function initShell(root) {
        console.log("DEBUG: initShell");
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
        console.log("DEBUG: initAllEditorsIn");
        const nodes = container.querySelectorAll(".editor-shell");
        for (const n of nodes) initShell(n);
    }

    function start() {
        console.log("DEBUG: start");
        initAllEditorsIn(document);
        // watch for dynamically added editor-shells
        const mo = new MutationObserver((muts) => {
            console.log("DEBUG: initMutationObserver");
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
