// Handler for hierarchy data (call hierarchy, type hierarchy)

export default class HierarchyHandler {
  constructor(relay) {
    this.relay = relay;
  }

  /**
   * Collect and normalize hierarchy information for a position
   * @param {{uri: string, position?: {line: number, character: number}}} params
   * @returns {Promise<{call_hierarchy: {}, type_hierarchy: {}}>}
   */
  async collect({ uri, position }) {
    const emptyResult = {
      call_hierarchy: {},
      type_hierarchy: {},
    };

    // Validate position has required properties
    if (!position || typeof position.line !== 'number' || typeof position.character !== 'number') {
      return emptyResult;
    }

    try {
      const [callHierarchy, typeHierarchy] = await Promise.all([
        this.relay._requestCached("textDocument/prepareCallHierarchy", { textDocument: { uri }, position }).catch(() => null),
        this.relay._requestCached("textDocument/prepareTypeHierarchy", { textDocument: { uri }, position }).catch(() => null),
      ]);
      
      // Normalize hierarchies
      const normalizedCall = this.normalizeHierarchy("call_hierarchy", callHierarchy, uri);
      const normalizedType = this.normalizeHierarchy("type_hierarchy", typeHierarchy, uri);

      // Convert to {uri: {annotationId: annotation}} structure
      const call_hierarchy = {};
      for (const { uri: itemUri, annotationId, annotation } of normalizedCall) {
        if (!call_hierarchy[itemUri]) call_hierarchy[itemUri] = {};
        call_hierarchy[itemUri][annotationId] = annotation;
      }

      const type_hierarchy = {};
      for (const { uri: itemUri, annotationId, annotation } of normalizedType) {
        if (!type_hierarchy[itemUri]) type_hierarchy[itemUri] = {};
        type_hierarchy[itemUri][annotationId] = annotation;
      }

      return {
        call_hierarchy,
        type_hierarchy,
      };
    } catch (error) {
      console.warn('Hierarchy methods not available:', error.message);
      return emptyResult;
    }
  }

  /**
   * Normalize hierarchy data for annotation system
   * @param {string} relationId - Type of hierarchy (call_hierarchy, type_hierarchy)
   * @param {any} items - Raw hierarchy data from LSP
   * @param {string} fallbackUri - URI to use when item doesn't have one
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeHierarchy(relationId, items, fallbackUri) {
    const results = [];
    if (!items) return results;

    const list = Array.isArray(items) ? items : [items];
    if (!list.length) return results;

    let counter = 0;
    const stack = list.slice();
    const visited = typeof WeakSet === "function" ? new WeakSet() : null;

    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== "object") continue;
      
      if (visited) {
        if (visited.has(item)) continue;
        visited.add(item);
      }

      const annotationId = item.id || item.identifier || item.label || `${relationId}#${counter}`;
      counter++;

      const uris = this._collectItemUris(item, fallbackUri);
      
      for (const uri of uris) {
        if (this._shouldFilter(uri)) continue;

        const ranges = this._extractRanges(item);
        if (!ranges.length) continue;

        results.push({
          uri,
          annotationId,
          annotation: {
            id: annotationId,
            ranges,
            label: item.name || item.label || null,
            detail: item.detail || null,
            kind: item.kind || null,
          },
        });
      }

      // Traverse hierarchy
      const next = [];
      if (Array.isArray(item.children) && item.children.length) {
        next.push(...item.children);
      }
      if (Array.isArray(item.incomingCalls) && item.incomingCalls.length) {
        next.push(...item.incomingCalls.map(c => c.from).filter(Boolean));
      }
      if (Array.isArray(item.outgoingCalls) && item.outgoingCalls.length) {
        next.push(...item.outgoingCalls.map(c => c.to).filter(Boolean));
      }
      if (next.length) {
        stack.push(...next);
      }
    }

    return results;
  }

  _collectItemUris(item, fallbackUri) {
    const collector = new Set();
    this._gatherUris(item, collector);
    
    if (!collector.size && fallbackUri) {
      collector.add(this._normalizeUri(fallbackUri));
    }
    
    return Array.from(collector).filter(Boolean);
  }

  _gatherUris(items, collector) {
    if (!items) return;
    const arr = Array.isArray(items) ? items : [items];
    
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;

      const uri = this._normalizeUri(item.uri);
      if (uri) collector.add(uri);

      if (item.location?.uri) {
        const locUri = this._normalizeUri(item.location.uri);
        if (locUri) collector.add(locUri);
      }

      if (Array.isArray(item.children)) {
        this._gatherUris(item.children, collector);
      }
    }
  }

  _extractRanges(item) {
    const ranges = [];
    
    if (item.selectionRange) ranges.push(item.selectionRange);
    if (item.range) ranges.push(item.range);
    if (item.location?.range) ranges.push(item.location.range);
    
    return ranges.filter(Boolean);
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
}
