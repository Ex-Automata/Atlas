"use strict";

const vscode = require("vscode");
const path = require("path");

/**
 * RelationshipManager
 * - collectAndLogLspInfo(filePath): Opens the file and queries many VS Code LSP providers,
 *   then logs a structured summary to the extension host console.
 * - loadGraph(filePath): Lightweight neighbor discovery for local relative imports.
 */
const RelationshipManager = {
	/**
	 * Collect a broad set of LSP data for a given file and print to console.
	 * This does NOT show any UI; it opens the document in the background.
	 *
	 * @param {string} filePath absolute filesystem path
	 * @returns {Promise<object>} The collected info (also logged)
	 */
	collectAndLogLspInfo(filePath) {
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
						// Place debug folder two levels up from this file's directory
						const outDir = path.resolve(__dirname, "..", "..", ".atlas-debug");
						const outUri = vscode.Uri.file(path.join(outDir, outName));
						const json = JSON.stringify(payload, null, 2);
						const data = Buffer.from(json, "utf8");

						// Ensure directory exists then write file
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
	},

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
							// fire and forget
							RelationshipManager.collectAndLogLspInfo(filePath).catch(() => {});
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
	},
};

module.exports = { RelationshipManager };

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

