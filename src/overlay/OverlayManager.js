"use strict";

const vscode = require("vscode");
const path = require("path");
const LSPHelper = require("./LSPHelper");

/**
 * OverlayManager
 * - collectAndLogLspInfo(filePath): Opens the file and queries many VS Code LSP providers,
 *   then logs a structured summary to the extension host console.
 * - loadGraph(filePath): Lightweight neighbor discovery for local relative imports.
 */
const OverlayManager = {
	/**
	 * Collect a broad set of LSP data for a given file and print to console.
	 * This does NOT show any UI; it opens the document in the background.
	 *
	 * @param {string} filePath absolute filesystem path
	 * @returns {Promise<object>} The collected info (also logged)
	 */
	collectAndLogLspInfo(filePath) {
		// Delegate to the centralized LSP helper to avoid duplicating LSP logic
		return LSPHelper.collectAndLogLspInfo(filePath);
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
							// fire and forget: delegated to LSPHelper
							LSPHelper.collectAndLogLspInfo(filePath).catch(() => {});
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

module.exports = { OverlayManager };

// --------------- Helpers ---------------

/**
 * Try to find a position with a word on it; otherwise return null.
 * @param {vscode.TextDocument} doc
 * @returns {vscode.Position|null}
 */
// Note: LSP-related helpers (findInterestingPosition, safeSerialize, isUriLike,
// isPositionLike, isRangeLike) were moved to `LSPHelper.js` to centralize logic.

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
