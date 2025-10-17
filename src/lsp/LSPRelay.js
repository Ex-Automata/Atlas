// File: src/overlay/LspRelay.js
// Host-side, transport-agnostic LSP relay.
// Expect an `adapter` that handles JSON-RPC transport (stdio/ws/etc).
// Keeps web/editor layers unchanged; GraphCoordinator (host) calls this.

export default class LSPRelay {
  /**
   * @param {Object} opts
   * @param {LspAdapter} opts.adapter - Transport adapter (see interface below).
   * @param {number} [opts.cacheTtlMs=3000] - Soft TTL for request-level cache.
   */
  constructor(adapter, cacheTtlMs = 3000) {
    if (!adapter) throw new Error("LSPRelay requires an adapter");
    this.adapter = adapter;
    this.cacheTtlMs = cacheTtlMs;

    /** @type {Map<string,{t:number, v:any}>} */
    this._cache = new Map();
    this._isInit = false;

    // optional: notifications from server (e.g., diagnostics)
    this._notifHandlers = new Map();
  }

  async init() {
    if (this._isInit) return;
    await this.adapter.initialize?.();
    // Wire pass-through for a few common notifications if adapter offers them
    if (this.adapter.onNotification) {
      const known = [
        "textDocument/publishDiagnostics",
        "workspace/applyEdit",
        "window/showMessage",
      ];
      for (const m of known) {
        this.adapter.onNotification(m, (p) => this._emit(m, p));
      }
    }
    this._isInit = true;
  }

  dispose() {
    this._cache.clear();
    this.adapter.dispose?.();
    this._notifHandlers.clear();
    this._isInit = false;
  }

  on(method, handler) {
    if (!this._notifHandlers.has(method)) this._notifHandlers.set(method, new Set());
    this._notifHandlers.get(method).add(handler);
    return () => this._notifHandlers.get(method)?.delete(handler);
  }

  _emit(method, payload) {
    const set = this._notifHandlers.get(method);
    if (!set) return;
    for (const h of set) {
      try { h(payload); } catch {}
    }
  }

  // ---------------------------
  // Public high-level API
  // ---------------------------

  /**
   * One-shot collection for hierarchical code information and file relationships.
   * Returns a unified graph object grouped by capability.
   * @param {{uri:string, position?:{line:number; character:number}}} args
   * @returns {Promise<{
   *   graph: {
   *     call_hierarchy?: any;
   *     type_hierarchy?: any;
   *     code_structure: {
   *       document_symbols: SymbolNode[];
   *       folding_ranges: any[];
   *     };
   *     code_navigation: {
   *       definitions: LocationLink[]|Location[]|null;
   *       declarations: Location[];
   *       implementations: Location[];
   *       type_definitions: Location[]|LocationLink[]|null;
   *       references: Location[];
   *     };
   *     imports: RelatedFile[];
   *   }
   * }>}
   */
  async collect({ uri, position }) {
    await this.init();

    // Core LSP requests
    const [symbols, definition, references, links, foldingRanges, declarations, implementations, typeDefinitions] = await Promise.all([
      this.symbols({ uri }),
      position ? this.definition({ uri, position }) : Promise.resolve(null),
      position ? this.references({ uri, position }) : Promise.resolve([]),
      this.documentLinks({ uri }).catch(() => []),
      this.foldingRanges({ uri }).catch(() => []),
      position ? this.declaration({ uri, position }).catch(() => []) : Promise.resolve([]),
      position ? this.implementation({ uri, position }).catch(() => []) : Promise.resolve([]),
      position ? this.typeDefinition({ uri, position }).catch(() => null) : Promise.resolve(null),
    ]);

    // Hierarchical information (when position is available)
    let call_hierarchy = null;
    let type_hierarchy = null;
    
    if (position) {
      try {
        const [callHierarchy, typeHierarchy] = await Promise.all([
          this.prepareCallHierarchy({ uri, position }).catch(() => null),
          this.prepareTypeHierarchy({ uri, position }).catch(() => null),
        ]);
        call_hierarchy = callHierarchy;
        type_hierarchy = typeHierarchy;
      } catch (error) {
        console.warn('Hierarchy methods not available:', error.message);
      }
    }

    // Multiple approaches to find directly referenced files
    const importGraph = await this._buildImportGraph({ uri, symbols, definition, references, links });

    return {
        call_hierarchy,
        type_hierarchy,
        code_structure: {
          document_symbols: symbols || [],
          folding_ranges: foldingRanges || []
        },
        code_navigation: {
          definitions: definition,
          declarations: declarations || [],
          implementations: implementations || [],
          type_definitions: typeDefinitions,
          references: references || []
        },
        imports: importGraph.imports || []
    }
  }

  async importsOf({ uri }) {
    return this._requestCached("textDocument/documentLink", {
      textDocument: { uri },
    });
  }


  /**
   * @returns {Promise<SymbolNode[]>}
   */
  async symbols({ uri }) {
    return this._requestCached("textDocument/documentSymbol", { textDocument: { uri } });
  }

  /**
   * @returns {Promise<LocationLink[]|Location[]|null>}
   */
  async definition({ uri, position }) {
    return this._requestCached("textDocument/definition", {
      textDocument: { uri },
      position,
    });
  }

  /**
   * @returns {Promise<Location[]>}
   */
  async references({ uri, position, includeDeclaration = false }) {
    return this._requestCached("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  /**
   * Lightweight way to infer imports/related URIs if server supports it.
   * @returns {Promise<DocumentLink[]>}
   */
  async documentLinks({ uri }) {
    return this._requestCached("textDocument/documentLink", {
      textDocument: { uri },
    });
  }

  /**
   * Optional helpers you might use later:
   */
  async prepareCallHierarchy({ uri, position }) {
    return this._requestCached("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position,
    });
  }

  async prepareTypeHierarchy({ uri, position }) {
    return this._requestCached("textDocument/prepareTypeHierarchy", {
      textDocument: { uri },
      position,
    });
  }

  async typeDefinition({ uri, position }) {
    return this._requestCached("textDocument/typeDefinition", {
      textDocument: { uri },
      position,
    });
  }

  async foldingRanges({ uri }) {
    return this._requestCached("textDocument/foldingRange", {
      textDocument: { uri },
    });
  }

  async declaration({ uri, position }) {
    return this._requestCached("textDocument/declaration", {
      textDocument: { uri },
      position,
    });
  }

  async implementation({ uri, position }) {
    return this._requestCached("textDocument/implementation", {
      textDocument: { uri },
      position,
    });
  }

  // ---------------------------
  // Internals
  // ---------------------------

  /**
   * Build comprehensive import graph using multiple LSP methods
   * @param {{uri:string, symbols:SymbolNode[], definition:any, references:Location[], links:DocumentLink[]}} params
   * @returns {Promise<{imports: RelatedFile[], documentLinks: DocumentLink[], symbolImports: RelatedFile[], definitionReferences: RelatedFile[]}>}
   */
  async _buildImportGraph({ uri, symbols, definition, references, links }) {
    const results = {
      imports: [],
      documentLinks: links || [],
      symbolImports: [],
      definitionReferences: []
    };

    // Method 1: Document links (primary method for imports)
    if (links && links.length > 0) {
      const linkImports = links
        .filter(link => link.target && !link.target.startsWith('#'))
        .map(link => ({
          uri: link.target,
          from: uri,
          kind: "import",
          method: "documentLinks",
          range: link.range
        }));
      results.imports.push(...linkImports);
    }

    // Method 2: Symbol-based analysis for imports
    if (symbols && symbols.length > 0) {
      const importSymbols = symbols.filter(symbol => 
        symbol.name && (
          symbol.name.toLowerCase().includes('import') ||
          symbol.name.toLowerCase().includes('require') ||
          symbol.name.toLowerCase().includes('from') ||
          symbol.kind === 9 // Module symbol kind
        )
      );

      for (const symbol of importSymbols) {
        try {
          const symbolRefs = await this.references({
            uri,
            position: symbol.selectionRange?.start || symbol.range?.start || { line: 0, character: 0 }
          });

          const symbolImports = symbolRefs
            .filter(ref => ref.uri !== uri) // exclude self-references
            .map(ref => ({
              uri: ref.uri,
              from: uri,
              kind: "import",
              method: "symbolAnalysis",
              range: ref.range,
              symbolName: symbol.name
            }));

          results.symbolImports.push(...symbolImports);
        } catch (error) {
          console.warn(`Failed to get references for symbol ${symbol.name}:`, error.message);
        }
      }
    }

    // Method 3: Definition-based references
    if (definition) {
      const definitions = Array.isArray(definition) ? definition : [definition];
      const definitionFiles = definitions
        .filter(def => def && (def.uri || def.targetUri))
        .map(def => {
          const targetUri = def.uri || def.targetUri;
          return targetUri !== uri ? {
            uri: targetUri,
            from: uri,
            kind: "definition",
            method: "definition",
            range: def.range || def.targetRange
          } : null;
        })
        .filter(Boolean);

      results.definitionReferences.push(...definitionFiles);
    }

    // Method 4: Reference-based file discovery
    if (references && references.length > 0) {
      const refFiles = references
        .filter(ref => ref.uri !== uri) // exclude self-references
        .map(ref => ({
          uri: ref.uri,
          from: uri,
          kind: "reference",
          method: "references",
          range: ref.range
        }));

      results.definitionReferences.push(...refFiles);
    }

    // Combine all methods for final imports list
    const allImports = [
      ...results.imports,
      ...results.symbolImports,
      ...results.definitionReferences
    ];

    results.imports = dedupeByUri(allImports);

    return results;
  }

  _cacheKey(method, params) {
    return `${method}:${stableStringify(params)}`;
  }

  async _requestCached(method, params) {
    await this.init();
    const key = this._cacheKey(method, params);
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit && now - hit.t < this.cacheTtlMs) return hit.v;

    const value = await this.adapter.request(method, params);
    this._cache.set(key, { t: now, v: value });
    return value;
  }
}

/**
 * Adapter interface (documented, not enforced):
 *
 * class MyAdapter {
 *   async initialize() {}
 *   async request(method, params) { /* send JSON-RPC 2.0 *\/ }
 *   onNotification(method, handler) { /* optional *\/ }
 *   dispose() {}
 * }
 */

// ---------- helpers / typedefs ----------

function stableStringify(x) {
  try {
    return JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, k) => (o[k] = v[k], o), {})
      : v));
  } catch {
    return String(x);
  }
}

function dedupeByUri(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.uri || it.target || JSON.stringify(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * @typedef {{name:string, detail?:string, kind?:number, range?:any, selectionRange?:any, children?:SymbolNode[]}} SymbolNode
 * @typedef {{uri:string, range:any}} Location
 * @typedef {{originSelectionRange?:any, targetUri:string, targetRange:any, targetSelectionRange?:any}} LocationLink
 * @typedef {{target:string, tooltip?:string, range?:any, data?:any}} DocumentLink
 * @typedef {{uri:string, from:string, kind:"import"|"export"}} RelatedFile
} */
