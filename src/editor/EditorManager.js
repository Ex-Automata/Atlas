const vscode = require("vscode");
const { EditorBridge } = require("./EditorBridge");
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { LSPAdapter } = require("../lsp/LSPAdapter");
const { default: LSPRelay } = require("../lsp/LSPRelay");
const path = require('path');
/**
 * EditorManager: boots the editor webview (editor.html) inside the Canvas panel.
 * - Avoids duplicate instances by reusing the canvas panel and updating content
 * - Builds CSP suitable for Monaco (CDN loader + blob workers)
 * - Hosts multiple Monaco editor instances via a bridge maintaining shared state
 *
 * Usage:
 *   const { createEditorManager } = require('./EditorManager');
 *   const editor = createEditorManager(context, canvas);
 *   await editor.openEditor('/absolute/path/to/file.js');
 */

function createEditorManager(parentCanvas) {

    const editors = new Map();
    const lsps = new Map();

    async function getEditor(filePath) {
        if (!editors.has(filePath)) {
            const editor = new EditorBridge(
                filePath,
                parentCanvas,
            );
            editors.set(filePath, editor);

            const language = EditorBridge.languageFromPath(filePath);
            if (!lsps.has(language)) {
                const adapter = new LSPAdapter();     // <-- built-in VS Code features
                const relay   = new LSPRelay(adapter);
                await relay.init();                          // no-op but keeps API consistent
                lsps.set(language, relay);
            }
            editor.lspRelay = lsps.get(language);
            editor.refreshLSP().then(graph => {
                // Graph is already normalized by handlers in LSPRelay
                parentCanvas.annotationManager?.displayAnnotations(graph);
            });
        }
        return editors.get(filePath);
    }

    function loadNeighbors(graph) {
        // graph.imports is now {uri: {annotationId: annotation}} structure 
        for (const reference of Object.values(Object.values(graph["imports"])[0])) {
            const uri = reference["targetPath"];
            const fsPath = vscode.Uri.parse(uri).fsPath;
            const workspaceFolders = vscode.workspace.workspaceFolders || [];
            const isInWorkspace = workspaceFolders.some(folder => {
                const rel = path.relative(folder.uri.fsPath, fsPath);
                return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
            });
            if (!isInWorkspace) continue;

            const neighbor = getEditor(fsPath);
        }
    }

    function shutdown(){
        for (const editor of editors.values()) {
            editor.shutdown();
        }
        for (const relay of lsps.values()) {
            relay.dispose();
        }
        editors.clear();
        lsps.clear();
    }

    return {
        getEditor,
        listEditors: () => Array.from(editors.values()),
        loadNeighbors,
        shutdown
    };
}

module.exports = { createEditorManager };
