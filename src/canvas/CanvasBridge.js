const vscode = require("vscode");

/**
 * CanvasBridge encapsulates all communication between the extension host and the
 * canvas webview (src/canvas/web/canvas.js). It is responsible for:
 *  - Creating / revealing the webview panel
 *  - Injecting the correct HTML (with CSP + resource URIs)
 *  - Providing explicit, typed helper methods for host -> webview messages
 *  - Providing explicit handler registration for webview -> host messages
 *  - Managing HTML injection only; no explicit ready-state handshake is required
 */
class CanvasBridge {
    /**
     * @param {vscode.WebviewPanel} parent
     */
    constructor(parent) {
        this.parent = parent;

        this._loadHtml(this.parent.webview);
        //this.title = options.title || "Atlas Canvas";

        // inbound handlers (webview -> host)
        //this.handlers = {
        //    fileDrop: new Set(),
        //    //canvasReady: new Set(),
        //};

        this.parent.webview.onDidReceiveMessage(async (msg) => {
            // 1) General editor message routing: any message with an id belongs to an editor instance
            //if (msg && msg.id) {
            //    try {
            //        const manager = this.editorManager;
            //        if (manager && typeof manager.listEditors === "function") {
            //            const ed = manager
            //                .listEditors()
            //                .find((e) => e && e.id === msg.id);
            //            if (ed && typeof ed.handleMessage === "function") {
            //                ed.handleMessage(msg);
            //                return; // handled
            //            }
            //        }
            //    } catch (e) {
            //        console.error("CanvasBridge: failed to route editor message", e);
            //    }
            //}

            // 2) Canvas-level events
            if (msg && msg.type === "fileDrop") {
                const paths = Array.isArray(msg.paths) ? msg.paths : [];
                if (paths.length === 0) {
                    vscode.window.showWarningMessage(
                        "Canvas: drop detected but no file path could be determined."
                    );
                    return;
                }
                vscode.window.showInformationMessage(
                    `Canvas: ${paths.length} file(s) dropped. First: ${paths[0]}`
                );
                for (const p of paths) {
                    try {
                        if (this.editorManager) {
                            this.editorManager.getEditor(p);
                        } else {
                            console.warn("No editor manager on canvas");
                        }
                    } catch (e) {
                        console.error(
                            "CanvasManager: failed to open dropped file",
                            p,
                            e
                        );
                    }
                }
            }
        });
    }

    addToCanvas(id, html){
        this.parent.webview.postMessage({ type: "addToCanvas", id, html });
    }

    _loadHtml(webview) {
        buildHtmlFromIndex(webview, this.parent.extensionUri)
            .then((html) => {
                this.parent.webview.html = html;
            })
            .catch((e) => {
                throw e;
            });
    }
}

// ----------------- HTML builder (moved from CanvasManager) -----------------
function buildHtmlFromIndex(webview, extensionUri) {
    const basePath = vscode.Uri.joinPath(extensionUri, "src", "canvas", "web");
    const editorBase = vscode.Uri.joinPath(extensionUri, "src", "editor", "web");
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(basePath, "canvas.css")
    );
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(basePath, "canvas.js")
    );
    const editorStyleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(editorBase, "editor.css")
    );
    const editorScriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(editorBase, "editor.js")
    );
    const canvasUri = vscode.Uri.joinPath(basePath, "canvas.html");
    const cspSource = webview.cspSource;

    return vscode.workspace.fs.readFile(canvasUri).then((bytes) => {
        let html = Buffer.from(bytes).toString("utf8");
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        img-src ${cspSource} https: data:;
        font-src ${cspSource} https: data:;
        style-src ${cspSource} https://cdnjs.cloudflare.com 'unsafe-inline';
        script-src ${cspSource} https://cdnjs.cloudflare.com 'unsafe-eval';
        worker-src blob:; 
        connect-src ${cspSource} https:;">`;

        if (html.includes("</head>")) {
            html = html.replace("</head>", `${cspMeta}\n</head>`);
        } else {
            html = cspMeta + html;
        }

        // Token substitution for asset URIs
        html = html
            .replace(/\{\{CANVAS_CSS\}\}/g, String(styleUri))
            .replace(/\{\{CANVAS_JS\}\}/g, String(scriptUri))
            .replace(/\{\{EDITOR_CSS\}\}/g, String(editorStyleUri))
            .replace(/\{\{EDITOR_JS\}\}/g, String(editorScriptUri));
        return html;
    });
}

module.exports = { CanvasBridge };
