const vscode = require("vscode");
const { RelationshipManager } = require("../graph/GraphCoordinator");

// Per-editor bridge. Lifecycle tied to an editor id.
class EditorBridge {
    /**
     * @param {object} opts
     * @param {string} opts.id editor id
     * @param {{ open: Function }} opts.parentCanvas
     */
    constructor(id, parentCanvas) {
        this.id = id;
        this.parentCanvas = parentCanvas;
        this.content = "";
        this.language = "plaintext";
        this.title = "";
        this.filePath = id;
        this.dirty = false;
        this.diff = false;
        this.collapsed = false;
        this.fullscreen = false;
        this.graph = null;
        this.handlers = {
            ready: new Set(),
            change: new Set(),
            collapsed: new Set(),
            fullscreen: new Set(),
            diff: new Set(),
            error: new Set(),
            contentResponse: new Set(),
        };
        // Queue for outbound messages until the embedded editor signals 'ready'
        this._outbox = [];
        this.ready = false;
        this.pendingContent = new Map();

        this.parentCanvas.parent.webview.onDidReceiveMessage((msg) => {
            if (msg && msg.id && msg.id === this.id) {
                this.handleMessage(msg);
            }
        });

        EditorBridge.buildEditorHtml(
            this.parentCanvas.parent.webview,
            this.parentCanvas.parent.extensionUri
        )
            .then((html) => {
                html = html.replace(/\{\{EDITOR_ID\}\}/g, this.id);
                this.parentCanvas.addToCanvas(this.id, html);
            })
            .then(() => {
                this.open(this.filePath);
            })
            .catch((e) => {
                console.error("Failed to build editor HTML", e);
            });
    }

    on(type, fn) {
        const set = this.handlers[type];
        if (!set) throw new Error(`Unknown editor event: ${type}`);
        set.add(fn);
        return { dispose: () => set.delete(fn) };
    }

    // ------------ Outbound helpers ------------
    _send(msg) {
        const message = { ...msg, id: this.id };
        if (!this.ready) {
            this._outbox.push(message);
            return;
        }
        this.parentCanvas.parent.webview.postMessage(message);
    }

    _flush() {
        if (!this.ready || !this._outbox.length) return;
        for (const m of this._outbox.splice(0)) {
            try {
                this.parentCanvas.parent.webview.postMessage(m);
            } catch (e) {
                console.error("EditorBridge flush send failed", e);
            }
        }
    }

    setTitle(title) {
        this._send({ type: "setTitle", title });
        this.title = title;
    }
    setLanguage(language) {
        this._send({
            type: "setLanguage",
            language: language,
        });
        this.language = language;
    }
    setContent(value, language) {
        this._send({
            type: "setContent",
            value,
            language: language,
            uri: this.filePath ? `file://${this.filePath}` : undefined,
        });
        this.dirty = false;
        this.content = value;
        this.language = language;

        // Register with GraphCoordinator and trigger LSP collection
        try {
            RelationshipManager.registerEditor(this.id, {
                filePath: this.filePath,
                language: language
            });
            
            // Update content and trigger LSP collection
            RelationshipManager.updateEditorContent(this.id, this.filePath, language);
        } catch (e) {
            console.warn("[Atlas] setContent: failed to register with GraphCoordinator", e);
        }
    }
    toggleDiff(v) {
        this._send({ type: "toggleDiff", value: v });
    }
    toggleCollapse(v) {
        this._send({ type: "toggleCollapse", value: v });
    }
    toggleFullscreen(v) {
        this._send({ type: "toggleFullscreen", value: v });
    }

    requestContent() {
        const requestId = `req-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
        return new Promise((resolve, reject) => {
            this.pendingContent.set(requestId, { resolve, reject });
            this._send({ type: "getContent", requestId });
            setTimeout(() => {
                if (this.pendingContent.has(requestId)) {
                    this.pendingContent.delete(requestId);
                    reject(new Error("getContent timeout"));
                }
            }, 5000);
        });
    }

    open(filePath) {
        const uri = vscode.Uri.file(filePath);

        vscode.workspace.fs
            .readFile(uri)
            .then((bytes) => {
                const content = Buffer.from(bytes).toString("utf8");
                const title = vscode.workspace.asRelativePath(uri, false);
                const language = EditorBridge.languageFromPath(filePath);
                this.setTitle(title);
                this.setLanguage(language);
                this.setContent(content, language);
            })
            .catch((e) => {
                vscode.window.showErrorMessage(
                    `Failed to open file: ${filePath}`
                );
                console.error("EditorBridge Error loading file.", e);
            });

        try {
            this.parentCanvas.parent.reveal(vscode.ViewColumn.Active, false);
        } catch (e) {
            console.error("Failed to reveal editor panel", e);
            vscode.window.showErrorMessage(
                `Failed to reveal editor panel for ${id}: ${
                    e && e.message ? e.message : String(e)
                }`
            );
        }
        return this;
    }

    handleMessage(msg) {
        switch (msg.type) {
            case "ready":
                this.ready = true;
                this._flush();
                //this.setTitle(this.title); // re-sync
                //this.setLanguage(this.language);
                //if (this.content) this.setContent(this.content);
                this._fire("ready", msg);
                break;
            case "change":
                this.content = msg.value || this.content;
                this.dirty = true;
                this._fire("change", msg);
                break;
            case "collapsed":
                this.collapsed = !!msg.value;
                this._fire("collapsed", msg);
                break;
            case "fullscreen":
                this.fullscreen = !!msg.value;
                this._fire("fullscreen", msg);
                break;
            case "diff":
                this.diff = !!msg.value;
                this._fire("diff", msg);
                break;
            case "content": {
                const req =
                    msg.requestId && this.pendingContent.get(msg.requestId);
                if (req) {
                    this.pendingContent.delete(msg.requestId);
                    req.resolve(msg.value || "");
                }
                this._fire("contentResponse", msg);
                break;
            }
            case "error":
                this._fire("error", msg);
                vscode.window.showErrorMessage(
                    `Editor error: ${msg.error || "unknown"}`
                );
                break;
            default:
                break;
        }
    }

    _fire(type, msg) {
        const set = this.handlers[type];
        if (!set) return;
        for (const fn of Array.from(set)) {
            try {
                fn(msg);
            } catch (e) {
                console.error("EditorBridge handler error", e);
            }
        }
    }

    dispose() {
        // Unregister from GraphCoordinator
        try {
            RelationshipManager.unregisterEditor(this.id);
        } catch (e) {
            console.warn("[Atlas] dispose: failed to unregister from GraphCoordinator", e);
        }
        
        // Clear handlers
        for (const set of Object.values(this.handlers)) {
            set.clear();
        }
        
        this.pendingContent.clear();
        this._outbox.length = 0;
    }
}

// Static helper for building editor HTML fragment (previously in EditorManager)
EditorBridge.buildEditorHtml = (webview, extensionUri) => {
    const EDITOR_WEB_DIR = vscode.Uri.joinPath(
        extensionUri,
        "src",
        "editor",
        "web"
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(EDITOR_WEB_DIR, "editor.css")
    );
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(EDITOR_WEB_DIR, "editor.js")
    );
    const editorHtmlUri = vscode.Uri.joinPath(EDITOR_WEB_DIR, "editor.html");
    return vscode.workspace.fs.readFile(editorHtmlUri).then((bytes) => {
        let html = Buffer.from(bytes).toString("utf8");
        html = html
            .replace(/\{\{EDITOR_CSS\}\}/g, String(styleUri))
            .replace(/\{\{EDITOR_JS\}\}/g, String(scriptUri));
        return html;
    });
};

EditorBridge.languageFromPath = (filePath) => {
    const ext = (filePath || "").toLowerCase().split(".").pop();
    const map = {
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        html: "html",
        css: "css",
        scss: "scss",
        md: "markdown",
        java: "java",
        py: "python",
        rb: "ruby",
        rs: "rust",
        go: "go",
        php: "php",
        c: "c",
        cpp: "cpp",
        h: "cpp",
        cs: "csharp",
        swift: "swift",
        kt: "kotlin",
        kts: "kotlin",
        sh: "shellscript",
        zsh: "shellscript",
        bash: "shellscript",
        yml: "yaml",
        yaml: "yaml",
        xml: "xml",
        txt: "plaintext",
        text: "plaintext",
        log: "plaintext",
        vue: "vue",
        svelte: "svelte",
        dart: "dart",
        lua: "lua",
        sql: "sql",
        makefile: "makefile",
        dockerfile: "dockerfile",
        plaintext: "plaintext",
    };
    return map[ext] || "plaintext";
};

module.exports = { EditorBridge };
