// Host-side, transport-agnostic LSP relay.
// Expect an `adapter` that handles JSON-RPC transport (stdio/ws/etc).
// Keeps web/editor layers unchanged; GraphCoordinator (host) calls this.

import ImportsHandler from "./ImportsHandler.js";
import CodeStructureHandler from "./CodeStructureHandler.js";
import CodeNavigationHandler from "./CodeNavigationHandler.js";
import HierarchyHandler from "./HierarchyHandler.js";

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
    
    // Initialize handlers
    this.importsHandler = new ImportsHandler(this);
    this.codeStructureHandler = new CodeStructureHandler(this);
    this.codeNavigationHandler = new CodeNavigationHandler(this);
    this.hierarchyHandler = new HierarchyHandler(this);
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
   *   call_hierarchy: {};
   *   type_hierarchy: {};
   *   code_structure: {
   *     document_symbols: {};
   *     folding_ranges: {};
   *   };
   *   code_navigation: {
   *     definitions: {};
   *     declarations: {};
   *     implementations: {};
   *     type_definitions: {};
   *     references: {};
   *   };
   *   imports: {};
   * }>}
   */
  async collect({ uri, position }) {
    await this.init();

    // Collect raw data needed for imports handler
    const [symbols, definition, references] = await Promise.all([
      this._requestCached("textDocument/documentSymbol", { textDocument: { uri } }),
      position ? this._requestCached("textDocument/definition", { textDocument: { uri }, position }) : Promise.resolve(null),
      position ? this._requestCached("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: false } }) : Promise.resolve([]),
    ]);

    // Collect and normalize data using handlers (they do both collection and normalization)
    const [codeStructure, codeNavigation, hierarchy, importsData] = await Promise.all([
      this.codeStructureHandler.collect({ uri }),
      this.codeNavigationHandler.collect({ uri, position }),
      this.hierarchyHandler.collect({ uri, position }),
      this.importsHandler.collect({ uri, symbols, definition, references }),
    ]);

    return {
      call_hierarchy: hierarchy.call_hierarchy,
      type_hierarchy: hierarchy.type_hierarchy,
      code_structure: {
        document_symbols: codeStructure.document_symbols,
        folding_ranges: codeStructure.folding_ranges,
      },
      code_navigation: {
        definitions: codeNavigation.definitions,
        declarations: codeNavigation.declarations,
        implementations: codeNavigation.implementations,
        type_definitions: codeNavigation.type_definitions,
        references: codeNavigation.references,
      },
      imports: importsData.imports,
    };
  }

  // ---------------------------
  // Internals
  // ---------------------------

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

/**
 * @typedef {{name:string, detail?:string, kind?:number, range?:any, selectionRange?:any, children?:SymbolNode[]}} SymbolNode
 * @typedef {{uri:string, range:any}} Location
 * @typedef {{originSelectionRange?:any, targetUri:string, targetRange:any, targetSelectionRange?:any}} LocationLink
 * @typedef {{target:string, tooltip?:string, range?:any, data?:any}} DocumentLink
 * @typedef {{uri:string, from:string, kind:"import"|"export"}} RelatedFile
} */
