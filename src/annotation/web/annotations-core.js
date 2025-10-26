"use strict";

(function () {
    if (!window.vscode) {
        window.vscode =
            typeof acquireVsCodeApi === "function"
                ? acquireVsCodeApi()
                : { postMessage: () => {} };
    }

    const processors = new Map();
    const relationDefinitions = new Map();
    const toggleState = new Map();
    const datasets = Object.create(null);
    let rangeIndex = new Map();
    let primaryKey = null;
    let renderScheduled = false;

    const actionBarQueue = [];

    function sendToHost(payload) {
        try {
            window.vscode?.postMessage?.({
                type: "atlas:annotation",
                ...payload,
            });
        } catch (err) {
            console.warn("[Atlas] Failed to notify host from annotation core", err);
        }
    }

    function normalizePathLike(value) {
        if (!value || typeof value !== "string") return null;
        let next = value.trim();
        if (!next) return null;
        if (/^file:\/\//i.test(next)) {
            try {
                const url = new URL(next);
                next = decodeURIComponent(url.pathname || "");
                if (/^\/[A-Za-z]:/.test(next)) {
                    next = next.slice(1);
                }
                if (url.hostname && url.hostname !== "localhost") {
                    next = `//${url.hostname}${next}`;
                }
            } catch {
                // ignore parsing errors
            }
        }
        next = next.replace(/\\/g, "/");
        if (next.length > 1 && next.endsWith("/")) {
            next = next.slice(0, -1);
        }
        return next;
    }

    function ensureNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function normalizeRange(range, options = {}) {
        if (!range) return null;

        let startLine = 0;
        let startColumn = 0;
        let endLine = 0;
        let endColumn = 0;

        if (
            typeof range.startLine === "number" ||
            typeof range.startCharacter === "number"
        ) {
            startLine = ensureNumber(range.startLine, 0);
            startColumn = ensureNumber(range.startCharacter, 0);
            endLine = ensureNumber(range.endLine, startLine);
            endColumn = ensureNumber(range.endCharacter, startColumn);
        } else if (range.start || range.end) {
            const start = range.start || range.range?.start || {};
            const end = range.end || range.range?.end || start;
            startLine = ensureNumber(
                start.line ?? start.lineNumber ?? startLine,
                0
            );
            startColumn = ensureNumber(
                start.character ?? start.column ?? startColumn,
                0
            );
            endLine = ensureNumber(end.line ?? end.lineNumber ?? endLine, startLine);
            endColumn = ensureNumber(
                end.character ?? end.column ?? endColumn,
                startColumn
            );
        } else {
            return null;
        }

        if (endLine < startLine) {
            endLine = startLine;
        }
        if (endColumn < startColumn) {
            endColumn = startColumn;
        }

        const normalized = {
            startLine,
            startColumn,
            endLine,
            endColumn,
            isWholeLine: Boolean(options.markWholeLine),
        };

        if (options) {
            const anchorId = options.anchorId;
            if (anchorId != null) {
                const str = String(anchorId).trim();
                if (str) normalized.anchorId = str;
            }
            const annotationId = options.annotationId;
            if (annotationId != null) {
                const str = String(annotationId).trim();
                if (str) normalized.annotationId = str;
            }
            if (options.metadata != null) {
                normalized.metadata = options.metadata;
            } else if (options.data != null) {
                normalized.metadata = options.data;
            }
            if (options.hover != null) {
                normalized.hover = options.hover;
            }
        }

        return normalized;
    }

    function toSegments(value) {
        return String(value || "")
            .replace(/^[A-Za-z]:/, "")
            .split("/")
            .map((segment) => segment.trim())
            .filter(Boolean);
    }

    function suffixMatchLength(aSegments, bSegments) {
        if (!aSegments.length || !bSegments.length) return 0;
        const limit = Math.min(aSegments.length, bSegments.length);
        let score = 0;
        for (let i = 1; i <= limit; i += 1) {
            if (aSegments[aSegments.length - i] !== bSegments[bSegments.length - i]) {
                break;
            }
            score = i;
        }
        return score;
    }

    function lookupBucketEntry(buckets, key) {
        if (!buckets || !key) return null;
        const direct = buckets.get(key);
        if (direct) return direct;

        const targetSegments = toSegments(key);
        let best = null;
        let bestScore = 0;

        for (const [candidateKey, entry] of buckets.entries()) {
            if (candidateKey === key) return entry;
            const candidateSegments = toSegments(candidateKey);
            const score = suffixMatchLength(candidateSegments, targetSegments);
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        }
        return best;
    }

    function addRange(buckets, uri, range, options = {}) {
        const allowFallback = options.allowFallback !== false;
        const fallbackUri = options.fallbackUri != null ? options.fallbackUri : null;
        let targetUri = uri;
        if ((!targetUri || !normalizePathLike(targetUri)) && allowFallback) {
            targetUri = fallbackUri;
        }
        if (!targetUri) return;

        const key = normalizePathLike(targetUri);
        if (!key) return;

        const normalizedRange = normalizeRange(range, options);
        if (!normalizedRange) return;

        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = {
                uri: targetUri,
                ranges: [],
                seen: new Set(),
            };
            buckets.set(key, bucket);
        }

        const fingerprint = `${normalizedRange.startLine}:${normalizedRange.startColumn}:${normalizedRange.endLine}:${normalizedRange.endColumn}:${normalizedRange.isWholeLine ? 1 : 0}`;
        if (bucket.seen.has(fingerprint)) return;
        bucket.seen.add(fingerprint);
        bucket.ranges.push(normalizedRange);
    }

    function addLocation(buckets, location, options = {}) {
        if (!location) return;
        if (location.targetUri) {
            addRange(
                buckets,
                location.targetUri,
                location.targetSelectionRange || location.targetRange || location.range,
                options
            );
            return;
        }
        if (location.uri) {
            addRange(buckets, location.uri, location.range, options);
            return;
        }
        if (location.location) {
            addLocation(buckets, location.location, options);
        }
    }

    function visitDocumentSymbols(symbols, buckets, options = {}) {
        if (!Array.isArray(symbols) || !symbols.length) return;
        const stack = symbols.slice();
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            if (node.location?.uri) {
                addRange(buckets, node.location.uri, node.location.range, options);
            } else if (node.uri || node.range || node.selectionRange) {
                addRange(
                    buckets,
                    node.uri,
                    node.range || node.selectionRange,
                    options
                );
            }
            if (Array.isArray(node.children) && node.children.length) {
                stack.push(...node.children);
            }
        }
    }

    function visitHierarchy(items, buckets, options = {}) {
        if (!items) return;
        const arr = Array.isArray(items) ? items : [items];
        for (const item of arr) {
            if (!item) continue;
            if (item.item) {
                visitHierarchy(item.item, buckets, options);
            }
            if (item.from) {
                addRange(
                    buckets,
                    item.from.uri,
                    item.from.range || item.from.selectionRange,
                    options
                );
            }
            if (item.to) {
                addRange(
                    buckets,
                    item.to.uri,
                    item.to.range || item.to.selectionRange,
                    options
                );
            }
            if (item.uri) {
                addRange(buckets, item.uri, item.range || item.selectionRange, options);
            }
            if (Array.isArray(item.fromRanges)) {
                for (const range of item.fromRanges) {
                    addRange(buckets, item.from?.uri, range, options);
                }
            }
            if (Array.isArray(item.toRanges)) {
                for (const range of item.toRanges) {
                    addRange(buckets, item.to?.uri, range, options);
                }
            }
            if (Array.isArray(item.children) && item.children.length) {
                visitHierarchy(item.children, buckets, options);
            }
            if (Array.isArray(item.incomingCalls) && item.incomingCalls.length) {
                visitHierarchy(item.incomingCalls, buckets, options);
            }
            if (Array.isArray(item.outgoingCalls) && item.outgoingCalls.length) {
                visitHierarchy(item.outgoingCalls, buckets, options);
            }
        }
    }

    function finalizeBuckets(buckets) {
        for (const entry of buckets.values()) {
            delete entry.seen;
        }
    }

    function createProcessingContext(buckets) {
        const fallbackUri = primaryKey || null;
        return {
            addRange(uri, range, options) {
                addRange(buckets, uri, range, {
                    fallbackUri,
                    allowFallback: true,
                    ...options,
                });
            },
            addLocation(location, options) {
                addLocation(buckets, location, {
                    fallbackUri,
                    allowFallback: true,
                    ...options,
                });
            },
            addLocations(list, options) {
                if (!Array.isArray(list)) return;
                for (const item of list) {
                    addLocation(buckets, item, {
                        fallbackUri,
                        allowFallback: true,
                        ...options,
                    });
                }
            },
            visitDocumentSymbols(symbols, options) {
                visitDocumentSymbols(symbols, buckets, {
                    fallbackUri,
                    allowFallback: true,
                    ...options,
                });
            },
            visitHierarchy(nodes, options) {
                visitHierarchy(nodes, buckets, {
                    fallbackUri,
                    allowFallback: true,
                    ...options,
                });
            },
            normalizeRange(range, options) {
                return normalizeRange(range, options);
            },
            normalizePath(value) {
                return normalizePathLike(value);
            },
        };
    }

    function buildBucketsForRelation(relationId) {
        const processor = processors.get(relationId);
        if (typeof processor !== "function") {
            return new Map();
        }
        const buckets = new Map();
        const dataset = Object.prototype.hasOwnProperty.call(datasets, relationId)
            ? datasets[relationId]
            : undefined;
        try {
            const context = createProcessingContext(buckets);
            processor(dataset, context);
        } catch (err) {
            console.warn(`[Atlas] Annotation processor '${relationId}' failed`, err);
        }
        finalizeBuckets(buckets);
        return buckets;
    }

    function rebuildAllBuckets() {
        const next = new Map();
        relationDefinitions.forEach((_, relationId) => {
            next.set(relationId, buildBucketsForRelation(relationId));
        });
        rangeIndex = next;
    }

    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            applyDecorations();
        });
    }

    function ensurePrimaryForEditors(editorKeys) {
        if (primaryKey) return;
        const first = editorKeys.find(Boolean);
        if (first) {
            primaryKey = first;
        }
    }

    function buildAnnotationsFor(normalizedKey) {
        const annotations = [];
        relationDefinitions.forEach((rel) => {
            const enabled = toggleState.get(rel.id) !== false;
            const buckets = rangeIndex.get(rel.id);
            const entry =
                enabled && buckets ? lookupBucketEntry(buckets, normalizedKey) : null;
            const ranges = entry?.ranges ? entry.ranges.map((r) => ({ ...r })) : [];
            annotations.push({ relation: rel.id, ranges });
        });
        return annotations;
    }

    function applyDecorations() {
        const nodes = Array.from(
            document.querySelectorAll(".editor-shell[data-editor-id]")
        );
        if (!nodes.length) return;

        const editorKeys = nodes.map((node) =>
            normalizePathLike(node.getAttribute("data-editor-id"))
        );
        ensurePrimaryForEditors(editorKeys);

        nodes.forEach((node, index) => {
            const editorId = node.getAttribute("data-editor-id");
            const normalized =
                editorKeys[index] || normalizePathLike(editorId);
            if (!editorId || !normalized) return;
            const annotations = buildAnnotationsFor(normalized);
            window.postMessage(
                {
                    id: editorId,
                    type: "annotation:apply",
                    annotations,
                },
                "*"
            );
        });
    }

    function ensureActionBar(callback) {
        if (
            window.AtlasActionBar &&
            typeof window.AtlasActionBar.registerAction === "function"
        ) {
            try {
                callback(window.AtlasActionBar);
            } catch (err) {
                console.warn("[Atlas] Annotation action callback failed", err);
            }
            return;
        }
        actionBarQueue.push(callback);
    }

    function flushActionBarQueue() {
        if (!window.AtlasActionBar || !actionBarQueue.length) return;
        while (actionBarQueue.length) {
            const cb = actionBarQueue.shift();
            try {
                cb(window.AtlasActionBar);
            } catch (err) {
                console.warn("[Atlas] Failed to execute deferred action bar callback", err);
            }
        }
    }

    const actionBarCheck = setInterval(() => {
        if (
            window.AtlasActionBar &&
            typeof window.AtlasActionBar.registerAction === "function"
        ) {
            clearInterval(actionBarCheck);
            flushActionBarQueue();
        }
    }, 50);

    function registerActionFor(relationId) {
        const rel = relationDefinitions.get(relationId);
        if (!rel) return;
        const enabled = toggleState.get(relationId) !== false;
        if (rel.action === "dialog") {
            const icon = rel.iconOn || rel.iconOff || "■";
            ensureActionBar((bar) => {
                bar.registerAction(`atlas.annotation.${relationId}`, {
                    label: rel.label,
                    icon,
                    hint: rel.hint,
                    onSelect: () => {
                        toggleState.set(relationId, true);
                        window.dispatchEvent(
                            new CustomEvent("atlas:annotation:dialog", {
                                detail: { relationId },
                            })
                        );
                    },
                });
            });
            return;
        }

        const icon = enabled
            ? rel.iconOn || rel.iconOff || "■"
            : rel.iconOff || rel.iconOn || "□";
        const hint = `${enabled ? "Hide" : "Show"} ${rel.hint || rel.label}`;
        ensureActionBar((bar) => {
            bar.registerAction(`atlas.annotation.${relationId}`, {
                label: rel.label,
                icon,
                hint,
                onSelect: () => {
                    const next = !enabled;
                    toggleState.set(relationId, next);
                    registerActionFor(relationId);
                    scheduleRender();
                    window.dispatchEvent(
                        new CustomEvent("atlas:annotation:toggle", {
                            detail: { relationId, enabled: next },
                        })
                    );
                },
            });
        });
    }

    function registerRelations(relations) {
        if (!Array.isArray(relations)) return;
        relationDefinitions.clear();
        relations.forEach((rel) => {
            if (!rel || !rel.id) return;
            relationDefinitions.set(rel.id, { ...rel });
            if (!Object.prototype.hasOwnProperty.call(datasets, rel.id)) {
                datasets[rel.id] = [];
            }
            if (!toggleState.has(rel.id)) {
                const initial =
                    rel.action === "dialog" ? true : rel.defaultEnabled !== false;
                toggleState.set(rel.id, initial);
            }
            registerActionFor(rel.id);
        });
        rebuildAllBuckets();
        scheduleRender();
    }

    function handleData(datasetsPayload) {
        const payload =
            datasetsPayload && typeof datasetsPayload === "object"
                ? datasetsPayload
                : {};

        // Merge incoming data with existing datasets
        for (const key of Object.keys(payload)) {
            const incomingData = payload[key];
            
            // Ensure the relation bucket exists
            if (!Object.prototype.hasOwnProperty.call(datasets, key)) {
                datasets[key] = Object.create(null);
            }
            
            // If incoming data is an object (uri -> annotations), merge it
            if (incomingData && typeof incomingData === "object" && !Array.isArray(incomingData)) {
                for (const uri in incomingData) {
                    if (!datasets[key][uri]) {
                        datasets[key][uri] = Object.create(null);
                    }
                    // Merge annotations for this URI
                    const uriAnnotations = incomingData[uri];
                    if (uriAnnotations && typeof uriAnnotations === "object") {
                        for (const annotationId in uriAnnotations) {
                            datasets[key][uri][annotationId] = uriAnnotations[annotationId];
                        }
                    }
                }
            } else {
                // If it's not in the expected format, replace it
                datasets[key] = incomingData;
            }
        }

        // Ensure all registered relations have a bucket
        relationDefinitions.forEach((rel, relationId) => {
            if (!Object.prototype.hasOwnProperty.call(payload, relationId)) {
                if (rel?.action === "dialog") return;
                if (!Object.prototype.hasOwnProperty.call(datasets, relationId)) {
                    datasets[relationId] = Object.create(null);
                }
            }
        });

        rebuildAllBuckets();
        scheduleRender();
    }

    function registerProcessor(definition) {
        if (!definition || typeof definition !== "object") {
            throw new Error("[Atlas] Annotation registration requires an object");
        }
        const { id, process } = definition;
        if (!id) throw new Error("[Atlas] Annotation registration missing id");
        if (typeof process !== "function") {
            throw new Error(
                `[Atlas] Annotation processor '${id}' requires process(dataset, api)`
            );
        }
        processors.set(id, process);
        if (!Object.prototype.hasOwnProperty.call(datasets, id)) {
            datasets[id] = [];
        }
        updateRelationBuckets(id);
    }

    function updateRelationBuckets(relationId, opts = {}) {
        rangeIndex.set(relationId, buildBucketsForRelation(relationId));
        if (!opts.silent) scheduleRender();
    }

    function setDataset(relationId, values, options = {}) {
        const list = Array.isArray(values) ? values.slice() : [];
        datasets[relationId] = list;
        updateRelationBuckets(relationId, options);
    }

    function addDatasetEntry(relationId, entry, options = {}) {
        if (!Array.isArray(datasets[relationId])) datasets[relationId] = [];
        datasets[relationId].push(entry);
        updateRelationBuckets(relationId, options);
    }

    function getDataset(relationId) {
        const value = datasets[relationId];
        return Array.isArray(value) ? value.slice() : [];
    }

    function setToggleState(relationId, value, options = {}) {
        if (!relationDefinitions.has(relationId)) return;
        const next = Boolean(value);
        toggleState.set(relationId, next);
        if (!options.silent) {
            registerActionFor(relationId);
            scheduleRender();
        }
    }

    window.AtlasAnnotations = {
        register: registerProcessor,
        setDataset,
        addDatasetEntry,
        getDataset,
        setToggleState,
    };

    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.type !== "atlas:annotation") return;
        if (data.action === "bootstrap") {
            registerRelations(data.payload?.relations || []);
        } else if (data.action === "data") {
            handleData(data.payload);
        }
    });

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type !== "childList") continue;
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (
                    node.matches?.(".editor-shell[data-editor-id]") ||
                    node.querySelector?.(".editor-shell[data-editor-id]")
                ) {
                    scheduleRender();
                    return;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    sendToHost({ event: "ready" });
})();
