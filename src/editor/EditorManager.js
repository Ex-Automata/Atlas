const vscode = require("vscode");
const { EditorBridge } = require("./EditorBridge");

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

    function getEditor(filePath) {
        if (!editors.has(filePath)) {
            const editor = new EditorBridge(
                filePath,
                parentCanvas,
            );
            editors.set(filePath, editor);
        }

        // Open via bridge (handles injection + file load)
        return editors.get(filePath);
    }

    return {
        getEditor,
        listEditors: () => Array.from(editors.values()),
    };
}

module.exports = { createEditorManager };
