const vscode = require("vscode");
const { createEditorManager } = require("./editor/EditorManager");
const { CanvasBridge } = require("./canvas/CanvasBridge");
const { createAnnotationManager } = require("./annotation/AnnotationManager");

const STATE_KEY = "atlas.state";

const atlasTabs = new Map();

function activate(context) {
    function addToStatusBar() {
        const item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        item.text = "$(graph) Atlas";
        item.tooltip = "Open Atlas";
        item.command = "atlas.open";
        item.show();
        context.subscriptions.push(item);

        // optional: reflect selection
        vscode.window.onDidChangeTextEditorSelection((e) => {
            const word =
                e.textEditor?.document.getText(e.textEditor.selection) || "";
            item.text = word ? `$(graph) Atlas: ${word}` : "$(graph) Atlas";
        });
    }
    addToStatusBar();

    context.subscriptions.push(
        vscode.commands.registerCommand("atlas.open.entrypoint", async () => {
            atlasTab = openAtlasTab("atlas.tab.entrypoint", "Atlas - Pathfinder", context);

            try {
                const entry = await detectEntrypoint();
                if (entry) {
                    tab.canvas.editorManager.getEditor(entry.fsPath);
                }
            } catch (e) {
                console.warn(
                    "Atlas entrypoint detection failed:",
                    e?.message || e
                );
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("atlas.open", async () => {
            openAtlasTab("atlas.tab", "Atlas", context);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("atlas.open.empty", async () => {
            openAtlasTab("atlas.canvas", "Atlas", context);
        })
    );

    // Send selected resource(s) to the canvas
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "atlas.sendToCanvas",
            async (uri, uris) => {
                // VS Code passes a single URI or a list depending on source; normalize
                let list = [];
                if (uris && Array.isArray(uris)) list = uris;
                else if (uri) list = [uri];
                else if (vscode.window.activeTextEditor)
                    list = [vscode.window.activeTextEditor.document.uri];

                if (!list.length) {
                    vscode.window.showWarningMessage(
                        "Atlas: No resource to send to canvas."
                    );
                    return;
                }

                // Ensure canvas is open
                tab = openAtlasTab("atlas.canvas", "Atlas", context);

                // Post to webview and also log visibly
                const paths = list.map((u) => u.fsPath || u.path || String(u));
                console.log("Atlas sendToCanvas:", paths);
                vscode.window.showInformationMessage(
                    `Atlas: sent ${paths.length} item(s) to canvas. First: ${paths[0]}`
                );
                
                paths.map((p) => {
                    tab.canvas.editorManager.getEditor(p);
                });

            }
        )
    );

    vscode.window.onDidChangeTextEditorSelection(async () => {
        // Reserved for future focus features; no-op for canvas mode
    });
}

function deactivate() {
    for (const tab of atlasTabs.values()) {
        tab.dispose();
    }
}

module.exports = { activate, deactivate };

async function detectEntrypoint() {
    const pkgFiles = ["package.json", "tsconfig.json", "jsconfig.json"];
    const candidates = [];
    for (const f of pkgFiles) {
        const files = await vscode.workspace.findFiles(
            `**/${f}`,
            "**/node_modules/**"
        );
        if (files.length) candidates.push(...files);
    }
    if (candidates.length === 0) return;

    // Pick the shallowest path
    const rootPkg = candidates.sort(
        (a, b) => a.path.split("/").length - b.path.split("/").length
    )[0];

    const pkgContent = await vscode.workspace.fs.readFile(rootPkg);
    const pkgJson = JSON.parse(Buffer.from(pkgContent).toString("utf8"));

    // Actually find entry file.
    let entry =
        pkgJson.main ||
        (pkgJson.exports && pkgJson.exports["."]) ||
        pkgJson.module ||
        null;

    if (typeof entry === "object" && entry.default) {
        entry = entry.default;
    }

    if (entry) {
        return vscode.Uri.joinPath(
            rootPkg.with({ path: rootPkg.path.replace(/package\.json$/, "") }),
            entry
        );
    }

    return null;
}

function openAtlasTab(id, title, context) {
    if (atlasTabs.has(id)) {
        const existingTab = atlasTabs.get(id);
        try {
            existingTab.reveal(vscode.ViewColumn.One);
            return existingTab;
        } catch (error) {
            // Webview was disposed, remove it and create a new one
            console.log(`Atlas: Webview for ${id} was disposed, creating new one`);
            atlasTabs.delete(id);
        }
    }

    const extensionUri = context.extensionUri;
    const tab = vscode.window.createWebviewPanel(
        id,
        title,
        {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
        },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(
                    extensionUri,
                    "src",
                    "canvas",
                    "web"
                ),
                vscode.Uri.joinPath(
                    extensionUri,
                    "src",
                    "editor",
                    "web"
                ),
                vscode.Uri.joinPath(
                    extensionUri,
                    "src",
                    "lsp",
                    "web"
                ),
                vscode.Uri.joinPath(
                    extensionUri,
                    "src",
                    "annotation",
                    "web"
                ),
            ],
        }
    );

    tab.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "media", "atlas_icon.png"),
        dark: vscode.Uri.joinPath(extensionUri, "media", "atlas_icon_dark.png"),
    };

    tab.webview.html = `<html><body style="background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family)">Loading Atlas Canvas…</body></html>`;
    tab.onDidDispose(() => {
        tab.canvas.annotationManager?.dispose?.();
        tab.canvas.shutdown();
        tab.canvas.editorManager.shutdown();
        atlasTabs.delete(id);
    });

    tab.context = context
    tab.extensionUri = extensionUri;
    tab.canvas = new CanvasBridge(tab);
    tab.canvas.editorManager = createEditorManager(tab.canvas);
    // Annotation manager will receive handlers from LSPRelay instances via EditorManager
    tab.canvas.annotationManager = createAnnotationManager(tab.canvas);


    tab.webview.onDidReceiveMessage((msg) => {
        //TODO: handle messages, best done in the relevant bridge object.
    });

    atlasTabs.set(id, tab);

    return tab;
}