"use strict";

const vscode = require("vscode");
const path = require("path");

/**
 * collectAndLogLspInfo(filePath): Opens the file and queries many VS Code LSP providers,
 * then logs a structured summary to the extension host console.
 * @param {string} filePath absolute filesystem path
 * @returns {Promise<object>} The collected info (also logged)
 */
function collectAndLogLspInfo(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return Promise.reject(new Error("collectAndLogLspInfo: filePath must be a string"));
    }

    const uri = vscode.Uri.file(filePath);
    return vscode.workspace.openTextDocument(uri).then(
        (doc) => {
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
                documentSymbols: run("vscode.executeDocumentSymbolProvider", uri),
                definitions: run("vscode.executeDefinitionProvider", uri, pos),
                declarations: run("vscode.executeDeclarationProvider", uri, pos),
                typeDefinitions: run("vscode.executeTypeDefinitionProvider", uri, pos),
                implementations: run("vscode.executeImplementationProvider", uri, pos),
                references: run("vscode.executeReferenceProvider", uri, pos),
                hovers: run("vscode.executeHoverProvider", uri, pos),
                completions: run("vscode.executeCompletionItemProvider", uri, pos),
                signatureHelp: run("vscode.executeSignatureHelpProvider", uri, pos),
                documentHighlights: run("vscode.executeDocumentHighlights", uri, pos),
                codeLens: run("vscode.executeCodeLensProvider", uri),
                codeActions: run(
                    "vscode.executeCodeActionProvider",
                    uri,
                    wordRange,
                    { diagnostics: [] }
                ),
                formatDocumentEdits: run("vscode.executeFormatDocumentProvider", uri, fmtOptions),
                formatRangeEdits: run("vscode.executeFormatRangeProvider", uri, wordRange, fmtOptions),
                foldingRanges: run("vscode.executeFoldingRangeProvider", uri),
                selectionRanges: run("vscode.executeSelectionRangeProvider", uri, [pos]),
                documentColors: run("vscode.executeDocumentColorProvider", uri),
                documentLinks: run("vscode.executeLinkProvider", uri),
                inlayHints: run(
                    "vscode.executeInlayHintProvider",
                    uri,
                    new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 1000000)
                ),
                semanticTokensFull: run("vscode.provideDocumentSemanticTokens", uri),
                semanticTokensRange: run(
                    "vscode.provideDocumentRangeSemanticTokens",
                    uri,
                    new vscode.Range(0, 0, Math.min(100, doc.lineCount - 1), 0)
                ),
                callHierarchyPrepare: run("vscode.prepareCallHierarchy", uri, pos),
            };

            const start = Date.now();
            const entries = Object.entries(tasks);
            return Promise.all(
                entries.map(([key, p]) =>
                    p.then(
                        (val) => [key, val],
                        (e) => [key, { __error: String(e && e.message ? e.message : e) }]
                    )
                )
            ).then((pairs) => {
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
                const payload = {
                    summary,
                    results: safeSerialize(results),
                };
                console.info("[Atlas:LSP] Summary:", summary);
                try {
                    console.info("[Atlas:LSP] Details:", payload);
                } catch (e) {
                    try {
                        console.info("[Atlas:LSP] Details(JSON):", JSON.stringify(payload));
                    } catch (_e) {
                        console.warn("[Atlas:LSP] Failed to stringify payload");
                    }
                }
                try {
                    const outName = `${path.basename(filePath)}.atlas-lsp.json`;
                    const outDir = path.resolve(__dirname, "..", "..", ".atlas-debug");
                    const outUri = vscode.Uri.file(path.join(outDir, outName));
                    const json = JSON.stringify(payload, null, 2);
                    const data = Buffer.from(json, "utf8");

                    return vscode.workspace.fs
                        .createDirectory(vscode.Uri.file(outDir))
                        .then(
                            () =>
                                vscode.workspace.fs.writeFile(outUri, data).then(
                                    () => {
                                        console.info("[Atlas] Wrote LSP payload to", outUri.fsPath);
                                        return payload;
                                    },
                                    (err) => {
                                        console.warn(
                                            "[Atlas] Failed to write LSP payload:",
                                            err && err.message ? err.message : err
                                        );
                                        return payload;
                                    }
                                ),
                            (err) => {
                                console.warn(
                                    "[Atlas] Failed to create debug dir:",
                                    err && err.message ? err.message : err
                                );
                                return payload;
                            }
                        );
                } catch (e) {
                    console.warn("[Atlas] Failed to serialize/write payload", e);
                    return payload;
                }
            });
        },
        (e) => {
            console.error("[Atlas] Failed to open document for LSP collection", e);
            return Promise.reject(e);
        }
    );
}

// --------------- Helpers ---------------

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

module.exports = { collectAndLogLspInfo };
