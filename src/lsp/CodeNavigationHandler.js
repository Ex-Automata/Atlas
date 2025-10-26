// Handler for code navigation data (definitions, declarations, implementations, references, type definitions)

export default class CodeNavigationHandler {
  constructor(relay) {
    this.relay = relay;
  }

  /**
   * Collect and normalize code navigation information for a position
   * @param {{uri: string, position?: {line: number, character: number}}} params
   * @returns {Promise<{definitions: {}, declarations: {}, implementations: {}, type_definitions: {}, references: {}}>}
   */
  async collect({ uri, position }) {
    const emptyResult = {
      definitions: {},
      declarations: {},
      implementations: {},
      type_definitions: {},
      references: {},
    };

    // Validate position has required properties
    if (!position || typeof position.line !== 'number' || typeof position.character !== 'number') {
      return emptyResult;
    }

    const [definition, declarations, implementations, typeDefinitions, references] = await Promise.all([
      this.relay._requestCached("textDocument/definition", { textDocument: { uri }, position }),
      this.relay._requestCached("textDocument/declaration", { textDocument: { uri }, position }).catch(() => []),
      this.relay._requestCached("textDocument/implementation", { textDocument: { uri }, position }).catch(() => []),
      this.relay._requestCached("textDocument/typeDefinition", { textDocument: { uri }, position }).catch(() => null),
      this.relay._requestCached("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: false } }).catch(() => []),
    ]);

    // Normalize all navigation data
    const normalizedDefs = this.normalizeLocations("definitions", definition, uri);
    const normalizedDecls = this.normalizeLocations("declarations", declarations, uri);
    const normalizedImpls = this.normalizeLocations("implementations", implementations, uri);
    const normalizedTypeDefs = this.normalizeLocations("type_definitions", typeDefinitions, uri);
    const normalizedRefs = this.normalizeReferences(references, uri);

    // Convert to {uri: {annotationId: annotation}} structure
    const result = {
      definitions: this._toUriMap(normalizedDefs),
      declarations: this._toUriMap(normalizedDecls),
      implementations: this._toUriMap(normalizedImpls),
      type_definitions: this._toUriMap(normalizedTypeDefs),
      references: this._toUriMap(normalizedRefs),
    };

    return result;
  }

  _toUriMap(normalizedItems) {
    const map = {};
    for (const { uri, annotationId, annotation } of normalizedItems) {
      if (!map[uri]) map[uri] = {};
      map[uri][annotationId] = annotation;
    }
    return map;
  }

  /**
   * Normalize location-based navigation data
   * @param {string} relationId - Type of relation (definitions, declarations, etc.)
   * @param {any} locations - Raw location data from LSP
   * @param {string} fallbackUri - URI to use when location doesn't have one
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeLocations(relationId, locations, fallbackUri) {
    const results = [];
    const list = this._collectLocations(locations);
    if (!list.length) return results;

    let counter = 0;
    for (const loc of list) {
      if (!loc || typeof loc !== "object") continue;

      const uri = this._extractUri(loc, fallbackUri);
      if (!uri || this._shouldFilter(uri)) continue;

      const ranges = this._extractRanges(loc);
      if (!ranges.length) continue;

      const annotationId = `${relationId}#${counter}`;
      counter++;

      results.push({
        uri,
        annotationId,
        annotation: {
          id: annotationId,
          ranges,
        },
      });
    }

    return results;
  }

  /**
   * Normalize references specifically (may include context)
   * @param {any} references - Raw reference data from LSP
   * @param {string} fallbackUri - URI to use when reference doesn't have one
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeReferences(references, fallbackUri) {
    return this.normalizeLocations("references", references, fallbackUri);
  }

  _collectLocations(value) {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    const out = [];
    
    for (const item of arr) {
      if (!item) continue;
      
      if (item.targetUri) {
        // LocationLink format
        out.push({
          uri: item.targetUri,
          range: item.targetRange,
          targetRange: item.targetRange,
          targetSelectionRange: item.targetSelectionRange,
          originSelectionRange: item.originSelectionRange,
        });
      } else if (item.uri) {
        // Location format
        out.push({
          uri: item.uri,
          range: item.range,
        });
      }
    }
    
    return out;
  }

  _extractUri(location, fallback) {
    const uri = location.uri || fallback;
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

  _extractRanges(location) {
    const ranges = [];
    
    if (location.range) ranges.push(location.range);
    if (location.targetRange) ranges.push(location.targetRange);
    if (location.targetSelectionRange) ranges.push(location.targetSelectionRange);
    
    return ranges.filter(Boolean);
  }
}
