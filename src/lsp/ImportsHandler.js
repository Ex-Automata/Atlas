import { promises as fs } from "fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "url";

const COMMON_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".pcss",
  ".styl",
  ".html",
  ".htm",
  ".svelte",
  ".vue",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".py",
  ".rb",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
];

const INDEX_BASENAMES = ["index", "main"];

export default class ImportsHandler {
  constructor(relay) {
    this.relay = relay;
  }

  /**
   * Collect and normalize import information using multiple strategies
   * All strategies are merged and deduplicated into a single result
   * @param {{uri: string, symbols?: any[], definition?: any, references?: any[]}} params
   * @returns {Promise<{imports: {}}>}
   */
  async collect({ uri, symbols, definition, references }) {
    const [documentLinks, alternatives] = await Promise.all([
      this.relay._requestCached("textDocument/documentLink", { textDocument: { uri } }).catch(() => []),
      this.collectAlternatives({ uri }),
    ]);

    // Build comprehensive import graph using multiple LSP methods
    const importsData = await this._buildImportGraph({ 
      uri, 
      symbols, 
      definition, 
      references, 
      links: documentLinks 
    });

    // Merge all import sources
    const allImports = [
      ...importsData.imports,
      ...alternatives.imports_1,
      ...alternatives.imports_2,
      ...alternatives.imports_3,
    ];

    // Deduplicate and rank by quality
    const mergedImports = this._mergeAndRankImports(allImports);

    // Normalize imports
    const normalizedImports = this.normalizeImports(mergedImports, uri);

    // Convert to {uri: {annotationId: annotation}} structure
    const imports = {};
    for (const { uri: itemUri, annotationId, annotation } of normalizedImports) {
      if (!imports[itemUri]) imports[itemUri] = {};
      imports[itemUri][annotationId] = annotation;
    }

    return {
      imports,
    };
  }

  /**
   * Merge imports from multiple sources, keeping the best quality version of each
   * Priority: exists > has range > LSP methods > text analysis
   */
  _mergeAndRankImports(imports) {
    const byTargetUri = new Map();

    for (const imp of imports) {
      if (!imp || !imp.uri) continue;

      const existing = byTargetUri.get(imp.uri);
      if (!existing) {
        byTargetUri.set(imp.uri, imp);
        continue;
      }

      // Keep the better quality import
      const current = this._scoreImport(existing);
      const candidate = this._scoreImport(imp);

      if (candidate > current) {
        byTargetUri.set(imp.uri, imp);
      } else if (candidate === current && imp.range && !existing.range) {
        // Same score but candidate has range
        byTargetUri.set(imp.uri, imp);
      }
    }

    return Array.from(byTargetUri.values());
  }

  /**
   * Score import quality (higher is better)
   * - File exists: +100
   * - Has range: +50
   * - Method quality: LSP (30) > symbol analysis (20) > heuristics (10)
   */
  _scoreImport(imp) {
    let score = 0;

    if (imp.exists) score += 100;
    if (imp.range) score += 50;

    if (imp.method) {
      if (imp.method.includes('documentLinks')) score += 30;
      else if (imp.method.includes('symbolAnalysis')) score += 20;
      else if (imp.method.includes('definition')) score += 25;
      else if (imp.method.includes('references')) score += 15;
      else if (imp.method.includes('jsLike')) score += 18;
      else if (imp.method.includes('heuristic')) score += 10;
    }

    return score;
  }

  /**
   * Normalize imports for annotation system
   * @param {RelatedFile[]} imports - Raw import data
   * @param {string} fallbackUri - URI to use when import doesn't have one
   * @returns {{uri: string, annotationId: string, annotation: any}[]}
   */
  normalizeImports(imports, fallbackUri) {
    const results = [];
    if (!Array.isArray(imports) || !imports.length) return results;

    let counter = 0;
    for (const entry of imports) {
      if (!entry || typeof entry !== "object") continue;

      const targetUri = this._extractUri(entry, fallbackUri);
      if (!targetUri || this._shouldFilter(targetUri)) continue;

      const ranges = entry.range ? [entry.range] : [];
      if (!ranges.length) continue;

      const annotationId = `imports#${counter}`;
      counter++;

      // Extract text from specifier or filename
      const text = entry.specifier || this._getFileName(targetUri);

      // Build metadata about the detection method
      const metadata = {
        detector: this._getDetectorName(entry.method),
        targetPath: targetUri,
        sourcePath: fallbackUri,
        verified: entry.exists === true,
        ...(entry.method && { method: entry.method }),
        ...(entry.specifier && { specifier: entry.specifier }),
        ...(entry.resolvedPath && { resolvedPath: entry.resolvedPath }),
        ...(entry.kind && { kind: entry.kind }),
        ...(entry.symbolName && { symbolName: entry.symbolName }),
      };

      results.push({
        uri: fallbackUri, // imports are annotated on the source file
        annotationId,
        annotation: {
          id: annotationId,
          ranges,
          text,
          targetPath: targetUri,
          metadata,
        },
      });
    }

    return results;
  }

  /**
   * Get friendly detector name from method string
   */
  _getDetectorName(method) {
    if (!method) return 'unknown';
    
    // Map internal method names to friendly detector names
    if (method.includes('documentLinks')) return 'lsp-document-links';
    if (method.includes('definition')) return 'lsp-definition';
    if (method.includes('symbolAnalysis')) return 'lsp-symbol-analysis';
    if (method.includes('references')) return 'lsp-references';
    if (method.includes('jsLike.static')) return 'static-import';
    if (method.includes('jsLike.dynamic')) return 'dynamic-import';
    if (method.includes('jsLike.require')) return 'require-call';
    if (method.includes('jsLike.export')) return 'export-from';
    if (method.includes('heuristic.attrs')) return 'html-attributes';
    if (method.includes('heuristic.css-import')) return 'css-import';
    if (method.includes('heuristic.css-url')) return 'css-url';
    if (method.includes('heuristic.include')) return 'c-include';
    
    return method;
  }

  /**
   * Build three alternative import collections that do not depend on
   * the previously collected graph artefacts.
   * @param {{uri:string}} params
   * @returns {Promise<{imports_1:RelatedFile[], imports_2:RelatedFile[], imports_3:RelatedFile[]}>}
   */
  async collectAlternatives({ uri }) {
    const text = await this._readFile(uri);
    const lineOffsets = typeof text === "string" ? computeLineOffsets(text) : [0];

    const [imports_1, imports_2] = text
      ? await Promise.all([
          this._fromJsLikeImports({ uri, text, lineOffsets }),
          this._fromHeuristicPaths({ uri, text, lineOffsets }),
        ])
      : [[], []];

    const imports_3 = await this._fromDocumentLinks({ uri, text, lineOffsets });

    return {
      imports_1,
      imports_2,
      imports_3,
    };
  }

  /**
   * Build comprehensive import graph using multiple LSP methods
   * @param {{uri:string, symbols:any[], definition:any, references:any[], links:any[]}} params
   * @returns {Promise<{imports: RelatedFile[], documentLinks: any[], symbolImports: RelatedFile[], definitionReferences: RelatedFile[]}>}
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
          const symbolRefs = await this.relay.references({
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

  _extractUri(entry, fallback) {
    const uri = entry.uri || fallback;
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

  _getFileName(uri) {
    if (!uri || typeof uri !== "string") return null;
    const parts = uri.split("/");
    return parts[parts.length - 1] || null;
  }

  async _readFile(uri) {
    if (!isFileUri(uri)) return null;
    try {
      const filePath = fileURLToPath(uri);
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async _fromJsLikeImports({ uri, text, lineOffsets }) {
    const patterns = [
      { label: "static", regex: /import\s+(?:[\w*\s{},]+?\s+from\s+)?["'`](.+?)["'`]/g },
      { label: "dynamic", regex: /import\s*\(\s*["'`](.+?)["'`]\s*\)/g },
      { label: "require", regex: /require\s*\(\s*["'`](.+?)["'`]\s*\)/g },
      { label: "export-from", regex: /export\s+.+?\s+from\s+["'`](.+?)["'`]/g },
    ];

    const tasks = [];
    for (const pattern of patterns) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = re.exec(text))) {
        const specifier = match[1];
        if (!specifier) continue;
        const specifierOffset = match.index + match[0].indexOf(specifier);
        const range = rangeFromOffsets(specifierOffset, specifierOffset + specifier.length, lineOffsets);
        tasks.push(
          (async () => {
            const resolved = await resolveSpecifierToUri(uri, specifier);
            if (!resolved) return null;
            return {
              uri: resolved.uri,
              from: uri,
              kind: "import",
              method: `text.jsLike.${pattern.label}`,
              range,
              specifier,
              exists: resolved.exists,
              resolvedPath: resolved.path,
            };
          })(),
        );
      }
    }

    const imports = (await Promise.all(tasks)).filter(Boolean);
    return dedupeByUri(imports);
  }

  async _fromHeuristicPaths({ uri, text, lineOffsets }) {
    const patterns = [
      { label: "attrs", regex: /(src|href|data-src)\s*=\s*["'`](\.{1,2}\/[^"'`]+)["'`]/gi },
      { label: "css-import", regex: /@import\s+(?:url\()?["'`](\.{1,2}\/[^"'`]+)["'`]/gi },
      { label: "css-url", regex: /url\(\s*["']?(\.{1,2}\/[^"'`)]+)["']?\s*\)/gi },
      { label: "include", regex: /#include\s*["<](\.{1,2}\/[^">]+)[">]/g },
    ];

    const results = [];
    for (const pattern of patterns) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = re.exec(text))) {
        const specifier = match[2] || match[1];
        if (!specifier) continue;
        const specifierOffset = match.index + match[0].indexOf(specifier);
        const range = rangeFromOffsets(specifierOffset, specifierOffset + specifier.length, lineOffsets);
        results.push({ specifier, range, label: pattern.label });
      }
    }

    const imports = await Promise.all(
      results.map(async ({ specifier, range, label }) => {
        const resolved = await resolveSpecifierToUri(uri, specifier);
        if (!resolved) return null;
        return {
          uri: resolved.uri,
          from: uri,
          kind: "import",
          method: `text.heuristic.${label}`,
          range,
          specifier,
          exists: resolved.exists,
          resolvedPath: resolved.path,
        };
      }),
    );

    return dedupeByUri(imports.filter(Boolean));
  }

  async _fromDocumentLinks({ uri, text, lineOffsets }) {
    if (!this.relay || typeof this.relay.documentLinks !== "function") return [];
    let links = [];
    try {
      links = await this.relay.documentLinks({ uri });
    } catch {
      return [];
    }

    if (!Array.isArray(links) || links.length === 0) return [];

    const imports = await Promise.all(
      links.map(async (link) => {
        if (!link || !link.range) return null;
        const raw = text ? sliceRange(text, lineOffsets, link.range) : null;
        const specifier = raw ? stripQuotes(raw.trim()) : null;

        let targetUri = typeof link.target === "string" ? link.target : null;
        let exists = false;
        let resolvedPath = null;

        if (isFileUri(targetUri)) {
          resolvedPath = fileURLToPath(targetUri);
          exists = await pathExists(resolvedPath);
        } else if (specifier) {
          const resolved = await resolveSpecifierToUri(uri, specifier);
          if (!resolved) return null;
          targetUri = resolved.uri;
          exists = resolved.exists;
          resolvedPath = resolved.path;
        } else {
          return null;
        }

        return {
          uri: targetUri,
          from: uri,
          kind: "import",
          method: "lsp.documentLinks",
          range: link.range,
          tooltip: link.tooltip,
          specifier: specifier || undefined,
          exists,
          resolvedPath,
        };
      }),
    );

    return dedupeByUri(imports.filter(Boolean));
  }
}

function dedupeByUri(items) {
  const map = new Map();
  for (const item of items) {
    if (!item || !item.uri) continue;
    const existing = map.get(item.uri);
    if (!existing) {
      map.set(item.uri, item);
      continue;
    }
    if (isBetterImport(existing, item)) {
      map.set(item.uri, { ...existing, ...item });
    }
  }
  return Array.from(map.values());
}

function isBetterImport(current, candidate) {
  if (!current) return true;
  if (!candidate) return false;
  if (candidate.exists && !current.exists) return true;
  if (!current.range && candidate.range) return true;
  if (candidate.method === "lsp.documentLinks" && current.method !== "lsp.documentLinks") return true;
  return false;
}

function computeLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function rangeFromOffsets(start, end, lineOffsets) {
  return {
    start: positionAt(start, lineOffsets),
    end: positionAt(end, lineOffsets),
  };
}

function positionAt(offset, lineOffsets) {
  let low = 0;
  let high = lineOffsets.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineOffsets[mid] > offset) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const line = Math.max(0, low - 1);
  const character = offset - (lineOffsets[line] || 0);
  return { line, character };
}

function sliceRange(text, lineOffsets, range) {
  if (!range || !range.start || !range.end) return "";
  const start = offsetAt(range.start, lineOffsets);
  const end = offsetAt(range.end, lineOffsets);
  if (start >= end || start < 0 || end > text.length) return "";
  return text.slice(start, end);
}

function offsetAt(position, lineOffsets) {
  const line = Math.max(0, Math.min(position.line || 0, lineOffsets.length - 1));
  const base = lineOffsets[line] || 0;
  return base + Math.max(0, position.character || 0);
}

function stripQuotes(value) {
  if (!value) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"') || (first === "`" && last === "`")) {
    return value.slice(1, -1);
  }
  return value;
}

function isFileUri(uri) {
  return typeof uri === "string" && uri.startsWith("file://");
}

function isAbsoluteUrl(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);
}

async function resolveSpecifierToUri(baseUri, specifier) {
  if (!specifier || typeof specifier !== "string") return null;

  if (isFileUri(specifier)) {
    const filePath = fileURLToPath(specifier);
    const exists = await pathExists(filePath);
    return { uri: specifier, path: filePath, exists };
  }

  if (isAbsoluteUrl(specifier)) {
    return null;
  }

  if (!isFileUri(baseUri)) return null;
  const basePath = fileURLToPath(baseUri);
  const baseDir = path.dirname(basePath);

  const cleaned = stripQueryAndHash(specifier.trim());
  if (!cleaned) return null;
  if (!(cleaned.startsWith(".") || cleaned.startsWith("/"))) return null;

  const targetPath = cleaned.startsWith("/")
    ? path.resolve(cleaned)
    : path.resolve(baseDir, cleaned);

  const candidates = buildCandidatePaths(targetPath);
  const existing = await firstExistingPath(candidates);
  const resolvedPath = existing || candidates[0];
  if (!resolvedPath) return null;

  return {
    uri: pathToFileURL(resolvedPath).href,
    path: resolvedPath,
    exists: Boolean(existing),
  };
}

function stripQueryAndHash(value) {
  const idx = value.search(/[?#]/);
  return idx >= 0 ? value.slice(0, idx) : value;
}

function buildCandidatePaths(targetPath) {
  const candidates = new Set();
  const normalized = path.normalize(targetPath);
  candidates.add(normalized);

  if (!hasKnownExtension(normalized)) {
    for (const ext of COMMON_EXTENSIONS) {
      candidates.add(`${normalized}${ext}`);
    }
    for (const base of INDEX_BASENAMES) {
      for (const ext of COMMON_EXTENSIONS) {
        candidates.add(path.join(normalized, `${base}${ext}`));
      }
    }
  }

  return Array.from(candidates);
}

function hasKnownExtension(filePath) {
  return Boolean(path.extname(filePath));
}

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        for (const base of INDEX_BASENAMES) {
          for (const ext of COMMON_EXTENSIONS) {
            const inside = path.join(candidate, `${base}${ext}`);
            if (await pathExists(inside)) return inside;
          }
        }
      }
    } catch {
      // ignore missing paths
    }
  }
  return null;
}

async function pathExists(p) {
  if (!p) return false;
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {{name:string, detail?:string, kind?:number, range?:any, selectionRange?:any, children?:SymbolNode[]}} SymbolNode
 * @typedef {{uri:string, from:string, kind:"import"|"export", method?:string, range?:any, specifier?:string, exists?:boolean, resolvedPath?:string}} RelatedFile
 */
