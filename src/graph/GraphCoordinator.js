"use strict";

const vscode = require("vscode");
const path = require("path");
const { LspRelay } = require("./LspRelay");
const { TaskEnvelope } = require("./TaskEnvelope");
const { EditorHighlightController } = require("./EditorHighlightController");
const { CanvasLinkLayer } = require("./CanvasLinkLayer");

/**
 * GraphCoordinator (formerly RelationshipManager)
 * Central authority for managing LSP connections, highlight events, and editor coordination
 * - Coordinates LSP data collection through LspRelay
 * - Manages EditorHighlightController and CanvasLinkLayer
 * - Handles action bar toggle registration
 * - Provides event emitter API for highlight coordination
 */
class GraphCoordinator {
    constructor() {
        this.lspRelay = new LspRelay();
        this.editorHighlightController = new EditorHighlightController();
        this.canvasLinkLayer = new CanvasLinkLayer();
        
        this.activeEditors = new Map(); // editorId -> editor info
        this.canvasRoot = null;
        
        // Register action bar toggles
        this._registerActionBarToggles();
        
        console.log("[Atlas] GraphCoordinator initialized");
    }

    /**
     * Register an editor with the coordinator
     * @param {string} editorId - Editor instance ID
     * @param {object} editorInfo - Editor information (filePath, etc.)
     */
    registerEditor(editorId, editorInfo = {}) {
        this.activeEditors.set(editorId, editorInfo);
        this.editorHighlightController.mount(editorId);
        
        // Trigger LSP collection for this editor if it has a file path
        if (editorInfo.filePath) {
            this._collectAndHighlight(editorInfo.filePath, editorId);
        }
        
        console.log(`[Atlas] Registered editor: ${editorId}`);
    }

    /**
     * Unregister an editor from the coordinator
     * @param {string} editorId - Editor instance ID
     */
    unregisterEditor(editorId) {
        this.editorHighlightController.unmount(editorId);
        this.activeEditors.delete(editorId);
        
        console.log(`[Atlas] Unregistered editor: ${editorId}`);
    }

    /**
     * Register the canvas root with the link layer
     * @param {HTMLElement} canvasRoot - Canvas root element
     */
    registerCanvas(canvasRoot) {
        this.canvasRoot = canvasRoot;
        this.canvasLinkLayer.attach(canvasRoot, (uri) => this._resolveEditorIdFromUri(uri));
        
        console.log("[Atlas] Registered canvas root");
    }

    /**
     * Update editor content and trigger LSP collection
     * @param {string} editorId - Editor instance ID  
     * @param {string} filePath - File path
     * @param {string} [language] - Language ID
     */
    updateEditorContent(editorId, filePath, language = null) {
        const editorInfo = this.activeEditors.get(editorId) || {};
        editorInfo.filePath = filePath;
        editorInfo.language = language;
        this.activeEditors.set(editorId, editorInfo);
        
        // Trigger LSP collection and highlighting
        this._collectAndHighlight(filePath, editorId);
    }

    /**
     * Collect LSP info and apply highlights (enhanced version of original method)
     * @param {string} filePath - Absolute filesystem path
     * @param {string} editorId - Editor instance ID
     * @returns {Promise<object>} The collected info (also logged)
     */
    async collectAndLogLspInfo(filePath, editorId = null) {
        if (!filePath || typeof filePath !== "string") {
            return Promise.reject(new Error("collectAndLogLspInfo: filePath must be a string"));
        }

        try {
            // Use new LspRelay for data collection
            const taskEnvelopes = await this.lspRelay.collect(filePath, editorId);
            
            // Apply highlights if we have an editor ID
            if (editorId) {
                this._applyHighlights(taskEnvelopes);
            }
            
            // Also run the original comprehensive LSP collection for debugging
            const comprehensiveData = await this._collectComprehensiveLspData(filePath);
            
            const summary = {
                filePath,
                editorId,
                taskEnvelopeCount: taskEnvelopes.length,
                timestamp: Date.now()
            };
            
            console.info("[Atlas:GraphCoordinator] LSP Collection Summary:", summary);
            console.info("[Atlas:GraphCoordinator] Task Envelopes:", taskEnvelopes);
            
            return {
                summary,
                taskEnvelopes,
                comprehensiveData
            };
            
        } catch (error) {
            console.error("[Atlas] GraphCoordinator LSP collection failed:", error);
            throw error;
        }
    }

    /**
     * Original comprehensive LSP data collection (preserved for backward compatibility)
     * @param {string} filePath - Absolute filesystem path
     * @returns {Promise<object>} Complete LSP data
     */
    async _collectComprehensiveLspData(filePath) {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        
        // Pick a reasonable position: first non-empty word or (0,0)
        const pos = findInterestingPosition(doc) || new vscode.Position(0, 0);
        const wordRange = doc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos);

        // Execute a large set of commonly-supported LSP commands. All are best-effort.
        const run = (cmd, ...args) =>
            vscode.commands
                .executeCommand(cmd, ...args)
                .then(
                    (res) => res,
                    (err) => ({ __error: String(err && err.message ? err.message : err) })
                );

        const fmtOptions = { insertSpaces: true, tabSize: 4 }; // fallback

        const tasks = {
            // RELATION/STRUCTURE: Document outline and symbol hierarchy (containers, children). Read-only.
            documentSymbols: run("vscode.executeDocumentSymbolProvider", uri),
            // RELATION/NAV: Where this symbol resolves to. Edge: usage -> definition. Read-only.
            definitions: run("vscode.executeDefinitionProvider", uri, pos),
            // RELATION/NAV: Declaration sites (often distinct from definition in some languages). Read-only.
            declarations: run("vscode.executeDeclarationProvider", uri, pos),
            // RELATION/TYPES: Static type target for symbol under cursor. Read-only.
            typeDefinitions: run("vscode.executeTypeDefinitionProvider", uri, pos),
            // RELATION/IMPL: Implementations of an interface/abstract/member. Many-to-one relation. Read-only.
            implementations: run("vscode.executeImplementationProvider", uri, pos),
            // RELATION/USAGE: All references across workspace. Graph of symbol <-> usages. Read-only.
            references: run("vscode.executeReferenceProvider", uri, pos),
            // EXPLANATION: Hover docs/quick info at position. Read-only.
            hovers: run("vscode.executeHoverProvider", uri, pos),
            // EXPLANATION/AFFORDANCE: Completion suggestions at position. Read-only until applied by user.
            completions: run("vscode.executeCompletionItemProvider", uri, pos),
            // EXPLANATION: Call signature and parameter help. Read-only.
            signatureHelp: run("vscode.executeSignatureHelpProvider", uri, pos),
            // RELATION/LOCAL: Read/write occurrences of symbol in this file (for highlighting). Read-only.
            documentHighlights: run("vscode.executeDocumentHighlights", uri, pos),
            // EXPLANATION/METRICS: Inline annotations (e.g., reference counts, tests). Informational; no edits.
            codeLens: run("vscode.executeCodeLensProvider", uri),
            // DOCUMENT-CHANGING (if applied): Proposed fixes/refactors. Retrieving is read-only; applying edits changes doc.
            codeActions: run(
                "vscode.executeCodeActionProvider",
                uri,
                wordRange,
                { diagnostics: [] }
            ),
            // DOCUMENT-CHANGING: Full-document formatting edits (not applied here; just retrieved).
            formatDocumentEdits: run("vscode.executeFormatDocumentProvider", uri, fmtOptions),
            // DOCUMENT-CHANGING: Range formatting edits (not applied here; just retrieved).
            formatRangeEdits: run("vscode.executeFormatRangeProvider", uri, wordRange, fmtOptions),
            // RELATION/STRUCTURE: Logical fold regions for code structure. Read-only.
            foldingRanges: run("vscode.executeFoldingRangeProvider", uri),
            // RELATION/STRUCTURE: Ascending selection levels (node -> parent). Read-only.
            selectionRanges: run("vscode.executeSelectionRangeProvider", uri, [pos]),
            // EXPLANATION: Color infos present in document (tokens with color metadata). Read-only.
            documentColors: run("vscode.executeDocumentColorProvider", uri),
            // RELATION/NAV: Link targets embedded in the doc (e.g., imports, URLs). Read-only.
            documentLinks: run("vscode.executeLinkProvider", uri),
            // EXPLANATION/SEMANTICS: Inline type/value hints as provided by server. Read-only.
            inlayHints: run(
                "vscode.executeInlayHintProvider",
                uri,
                new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 1000000)
            ),
            // EXPLANATION/SEMANTICS: Token classifications (full doc). Read-only.
            semanticTokensFull: run("vscode.provideDocumentSemanticTokens", uri),
            // EXPLANATION/SEMANTICS: Token classifications (range). Read-only.
            semanticTokensRange: run(
                "vscode.provideDocumentRangeSemanticTokens",
                uri,
                new vscode.Range(0, 0, Math.min(100, doc.lineCount - 1), 0)
            ),
            // RELATION/CALLS: Entry point for building incoming/outgoing call trees. Read-only.
            callHierarchyPrepare: run("vscode.prepareCallHierarchy", uri, pos),
        };

        const start = Date.now();
        const entries = Object.entries(tasks);
        const pairs = await Promise.all(
            entries.map(([key, p]) =>
                p.then(
                    (val) => [key, val],
                    (e) => [key, { __error: String(e && e.message ? e.message : e) }]
                )
            )
        );

        const results = {};
        for (const [k, v] of pairs) results[k] = v;
        const elapsedMs = Date.now() - start;
        const summary = {
            filePath,
            languageId: doc.languageId,
            lineCount: doc.lineCount,
            position: { line: pos.line, character: pos.character },
            elapsedMs,
        };
        
        return {
            summary,
            results: safeSerialize(results),
        };
    }

    /**
     * Minimal dependency graph based on local relative imports.
     * Returns `{ filePath, language, imports: string[] }` where imports are
     * absolute paths to resolvable neighbor files (best-effort, JS/TS flavored).
     *
     * @param {string} filePath
     * @param {string} [language]
     * @returns {Promise<{filePath: string, language?: string, imports: string[]}>}
     */
    loadGraph(filePath, language) {
        const uri = vscode.Uri.file(filePath);
        return vscode.workspace.openTextDocument(uri).then(
            (doc) => {
                const text = doc.getText();
                const specifiers = extractRelativeImports(text);
                const baseDir = vscode.Uri.joinPath(uri, "..");
                return resolveImportSpecifiers(baseDir, specifiers).then(
                    (resolved) => {
                        const graph = { filePath, language, imports: resolved };
                        try {
                            // Trigger LSP collection using new method
                            this.collectAndLogLspInfo(filePath).catch(() => {});
                        } catch (_) {}
                        return graph;
                    },
                    () => ({ filePath, language, imports: [] })
                );
            },
            (e) => {
                console.warn("[Atlas] loadGraph: failed to open document", e);
                return { filePath, language, imports: [] };
            }
        );
    }

    /**
     * Private method to collect LSP data and apply highlights
     * @param {string} filePath - File path
     * @param {string} editorId - Editor ID
     */
    async _collectAndHighlight(filePath, editorId) {
        try {
            const taskEnvelopes = await this.lspRelay.collect(filePath, editorId);
            this._applyHighlights(taskEnvelopes);
        } catch (error) {
            console.warn("[Atlas] Failed to collect and highlight:", error);
        }
    }

    /**
     * Apply highlights from task envelopes
     * @param {TaskEnvelope[]} taskEnvelopes - Task envelopes to apply
     */
    _applyHighlights(taskEnvelopes) {
        taskEnvelopes.forEach(envelope => {
            this.editorHighlightController.apply(envelope);
            this.canvasLinkLayer.render(envelope);
        });
    }

    /**
     * Resolve editor ID from URI (helper for CanvasLinkLayer)
     * @param {string} uri - Document URI
     * @returns {string|null} Editor ID
     */
    _resolveEditorIdFromUri(uri) {
        // Simple approach: try to match file path with active editors
        const filePath = uri.replace('file://', '');
        for (const [editorId, editorInfo] of this.activeEditors.entries()) {
            if (editorInfo.filePath === filePath) {
                return editorId;
            }
        }
        return null;
    }

    /**
     * Register action bar toggles
     */
    _registerActionBarToggles() {
        // Note: Action bar registration needs to happen on the webview side
        // This will be handled by the webview initialization
        console.log("[Atlas] GraphCoordinator ready for action bar toggle registration");
    }
}

// Create singleton instance for backward compatibility
const GraphCoordinatorInstance = new GraphCoordinator();

// Export both class and singleton
module.exports = { 
    GraphCoordinator, 
    // Maintain backward compatibility with RelationshipManager
    RelationshipManager: GraphCoordinatorInstance
};

// --------------- Helpers (preserved from original) ---------------

/**
 * Try to find a position with a word on it; otherwise return null.
 * @param {vscode.TextDocument} doc
 * @returns {vscode.Position|null}
 */
function findInterestingPosition(doc) {
    const maxLines = Math.min(doc.lineCount, 200);
    for (let i = 0; i < maxLines; i++) {
        const line = doc.lineAt(i).text;
        const m = /[A-Za-z0-9_.$#\-]+/.exec(line);
        if (m && typeof m.index === "number") {
            return new vscode.Position(i, m.index);
        }
    }
    return null;
}

/**
 * Convert VS Code types into JSON-serializable plain objects.
 * @param {any} value
 */
function safeSerialize(value) {
    const seen = new WeakSet();
    const toPlain = (v) => {
        if (v === null || typeof v !== "object") return v;
        if (seen.has(v)) return undefined;
        seen.add(v);

        // Uri
        if (isUriLike(v)) {
            try { return vscode.Uri.from(v).toString(true); } catch (_) {}
            try { return String(v.toString ? v.toString(true) : v); } catch (_) {}
        }

        // Range
        if (isRangeLike(v)) {
            return {
                start: { line: v.start.line, character: v.start.character },
                end: { line: v.end.line, character: v.end.character },
            };
        }
        // Position
        if (isPositionLike(v)) {
            return { line: v.line, character: v.character };
        }
        // Location
        if (v && v.uri && isRangeLike(v.range)) {
            return { uri: toPlain(v.uri), range: toPlain(v.range) };
        }
        // Diagnostic
        if (v && v.message && isRangeLike(v.range)) {
            const out = { ...v };
            out.range = toPlain(v.range);
            if (out.relatedInformation) {
                out.relatedInformation = (Array.isArray(out.relatedInformation) ? out.relatedInformation : []).map(toPlain);
            }
            return out;
        }

        if (Array.isArray(v)) return v.map(toPlain);

        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = toPlain(val);
        }
        return out;
    };
    return toPlain(value);
}

function isUriLike(v) {
    return (
        v &&
        (v instanceof vscode.Uri ||
            (typeof v.scheme === "string" && typeof v.path === "string"))
    );
}
function isPositionLike(v) {
    return v && typeof v.line === "number" && typeof v.character === "number";
}
function isRangeLike(v) {
    return v && v.start && v.end && isPositionLike(v.start) && isPositionLike(v.end);
}

/**
 * Extract relative import specifiers from JS/TS text.
 * Returns an array like ['../foo', './bar', './baz/index'] without quotes.
 * @param {string} text
 * @returns {string[]}
 */
function extractRelativeImports(text) {
    const specs = new Set();
    const importRe = /(import\s+[^'";]+?from\s*["']([^"']+)["'])|import\s*["']([^"']+)["']/g;
    const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
    const dynamicRe = /import\(\s*["']([^"']+)["']\s*\)/g;

    for (const re of [importRe, requireRe, dynamicRe]) {
        let m;
        while ((m = re.exec(text))) {
            const spec = m[2] || m[1] || m[3] || m[4] || m[0];
            const s = (m[2] || m[3] || "").trim();
            if (s.startsWith("./") || s.startsWith("../")) {
                specs.add(s);
            }
        }
    }
    return Array.from(specs);
}

/**
 * Resolve relative specifiers to absolute file paths (best-effort, JS/TS flavors).
 * @param {vscode.Uri} baseDirUri directory of the source file
 * @param {string[]} specifiers relative import specifiers
 * @returns {Promise<string[]>}
 */
function resolveImportSpecifiers(baseDirUri, specifiers) {
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
    const candidates = [];
    for (const s of specifiers.slice(0, 50)) {
        const rel = s.replace(/\/?$/, "");
        const fileBase = vscode.Uri.joinPath(baseDirUri, rel);
        // Direct file with extension
        candidates.push(fileBase);
        for (const ext of exts) {
            candidates.push(vscode.Uri.file(fileBase.fsPath + ext));
        }
        // index.* in folder
        for (const ext of exts) {
            candidates.push(vscode.Uri.joinPath(fileBase, `index${ext}`));
        }
    }

    const out = new Set();
    const tried = new Set();
    // Run stats sequentially until cap is reached to avoid excessive FS calls
    let chain = Promise.resolve();
    for (const c of candidates) {
        chain = chain.then(() => {
            if (out.size >= 32) return; // cap neighbors
            const key = c.fsPath;
            if (tried.has(key)) return;
            tried.add(key);
            return vscode.workspace.fs.stat(c).then(
                (stat) => {
                    if (stat && stat.type === vscode.FileType.File) {
                        out.add(c.fsPath);
                    }
                },
                () => {}
            );
        });
    }
    return chain.then(() => Array.from(out));
}