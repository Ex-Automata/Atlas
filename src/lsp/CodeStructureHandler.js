// Handler for code structure data (document symbols, folding ranges)

export default class CodeStructureHandler {
  constructor(relay) {
    this.relay = relay;
  }

  /**
   * Collect and normalize code structure information for a document
   * @param {{uri: string}} params
   * @returns {Promise<{document_symbols: {[uri: string]: {[annotationId: string]: any}}, folding_ranges: {[uri: string]: {[annotationId: string]: any}}}>}
   */
  async collect({ uri }) {
    const [symbols, foldingRanges] = await Promise.all([
      this.relay._requestCached("textDocument/documentSymbol", { textDocument: { uri } }),
      this.relay._requestCached("textDocument/foldingRange", { textDocument: { uri } }).catch(() => []),
    ]);

    // Normalize and return structured data
    const normalizedSymbols = this.normalizeDocumentSymbols(symbols || [], uri);
    const normalizedFolding = this.normalizeFoldingRanges(foldingRanges || [], uri);

    // Convert to {uri: {annotationId: annotation}} structure
    const document_symbols = {};
    for (const { uri: itemUri, annotationId, annotation } of normalizedSymbols) {
      if (!document_symbols[itemUri]) document_symbols[itemUri] = {};
      document_symbols[itemUri][annotationId] = annotation;
    }

    const folding_ranges = {};
    for (const { uri: itemUri, annotationId, annotation } of normalizedFolding) {
      if (!folding_ranges[itemUri]) folding_ranges[itemUri] = {};
      folding_ranges[itemUri][annotationId] = annotation;
    }

    return {
      document_symbols,
      folding_ranges,
    };
  }

  /**
   * Normalize document symbols for annotation system
   * @param {any[]} symbols - Raw symbol data from LSP
   * @param {string} fallbackUri - URI to use when symbol doesn't have one
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeDocumentSymbols(symbols, fallbackUri) {
    const results = [];
    if (!Array.isArray(symbols) || !symbols.length) return results;

    let counter = 0;
    const stack = symbols.slice();
    
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;

      const uri = this._extractUri(node, fallbackUri);
      if (!uri || this._shouldFilter(uri)) {
        if (Array.isArray(node.children) && node.children.length) {
          stack.push(...node.children);
        }
        continue;
      }

      // Merge all possible range sources
      const ranges = [
        node.selectionRange,
        node.range,
        node.location?.range,
      ].filter(Boolean);

      if (!ranges.length) {
        if (Array.isArray(node.children) && node.children.length) {
          stack.push(...node.children);
        }
        continue;
      }

      const annotationId = node.id || node.identifier || node.name || `document_symbols#${counter}`;
      counter++;

      results.push({
        uri,
        annotationId,
        annotation: {
          id: annotationId,
          ranges,
          label: node.name || null,
          detail: node.detail || null,
          kind: node.kind || null,
        },
      });

      if (Array.isArray(node.children) && node.children.length) {
        stack.push(...node.children);
      }
    }

    return results;
  }

  /**
   * Normalize folding ranges for annotation system
   * @param {any[]} foldingRanges - Raw folding range data from LSP
   * @param {string} fallbackUri - URI to use for all ranges
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeFoldingRanges(foldingRanges, fallbackUri) {
    const results = [];
    if (!Array.isArray(foldingRanges) || !foldingRanges.length) return results;
    if (!fallbackUri || this._shouldFilter(fallbackUri)) return results;

    let counter = 0;
    for (const entry of foldingRanges) {
      if (!entry || typeof entry !== "object") continue;

      const range = this._buildRangeFromFolding(entry);
      if (!range) continue;

      const annotationId = `folding_ranges#${counter}`;
      counter++;

      results.push({
        uri: fallbackUri,
        annotationId,
        annotation: {
          id: annotationId,
          ranges: [range],
          kind: entry.kind || null,
        },
      });
    }

    return results;
  }

  _extractUri(node, fallback) {
    const uri = node.location?.uri || node.uri || fallback;
    if (!uri || typeof uri !== "string") return null;
    return this._normalizeUri(uri);
  }

  _normalizeUri(value) {
    if (typeof value !== "string") return null;
    let next = value.trim();
    if (!next) return null;
    next = next.replace(/\\/g, "/");
    if (next.length > 1 && next.endsWith("/")) {
      next = next.slice(0, -1);
    }
    return next;
  }

  _shouldFilter(uri) {
    if (!uri || typeof uri !== "string") return true;
    const lower = uri.toLowerCase();
    return lower.includes("/.cache/") || lower.includes("/node_modules/");
  }

  _buildRangeFromFolding(entry) {
    const startLine = typeof entry.startLine === "number" ? entry.startLine : null;
    const endLine = typeof entry.endLine === "number" ? entry.endLine : null;
    
    if (startLine === null || endLine === null) return null;

    return {
      startLine,
      startCharacter: typeof entry.startCharacter === "number" ? entry.startCharacter : 0,
      endLine,
      endCharacter: typeof entry.endCharacter === "number" ? entry.endCharacter : 0,
      isWholeLine: true,
    };
  }
}
