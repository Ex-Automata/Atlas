"use strict";

(function () {
    const registry = window.AtlasAnnotations;
    if (!registry || typeof registry.register !== "function") return;

    const activeLines = new Map();
    let updateScheduled = false;
    let leaderLineWarned = false;

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
                // ignore URI parsing errors
            }
        }
        next = next.replace(/\\/g, "/");
        if (next.length > 1 && next.endsWith("/")) {
            next = next.slice(0, -1);
        }
        return next;
    }

    function sanitizeAnchorId(value) {
        if (value == null) return null;
        const normalized = String(value)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return normalized || null;
    }

    function isElementInDocument(node) {
        return Boolean(node && (node.isConnected || (node.ownerDocument && node.ownerDocument.contains(node))));
    }

    function findEditorShell(uri) {
        const normalizedUri = (normalizePathLike(uri) || "").toLowerCase();
        if (!normalizedUri) return null;
        const shells = document.querySelectorAll(".editor-shell[data-editor-id]");
        for (const shell of shells) {
            const editorId = shell.getAttribute("data-editor-id");
            if (!editorId) continue;
            const normalizedId = (normalizePathLike(editorId) || "").toLowerCase();
            if (!normalizedId) continue;
            if (
                normalizedUri === normalizedId ||
                normalizedUri.endsWith(normalizedId) ||
                normalizedId.endsWith(normalizedUri)
            ) {
                return shell;
            }
        }
        return null;
    }

    function findEditorTitlebar(editorPath) {
        const shell = findEditorShell(editorPath);
        if (!shell) return null;
        return shell.querySelector(".editor-titlebar");
    }

    function findAnchorElement(uri, anchorId) {
        const shell = findEditorShell(uri);
        if (!shell) return null;
        const sanitized = sanitizeAnchorId(anchorId);
        if (!sanitized) return null;
        return shell.querySelector(`.atlas-anchor-${sanitized}`);
    }

    function removeLine(entry) {
        if (entry && entry.line) {
            try {
                entry.line.remove();
            } catch {
                // ignore leader line removal failures
            }
            entry.line = null;
        }
    }

    function createLeaderLine(startElement, endElement, metadata) {
        if (typeof LeaderLine === "undefined") {
            if (!leaderLineWarned) {
                console.warn("LeaderLine library not loaded");
                leaderLineWarned = true;
            }
            return null;
        }
        try {
            const verified = metadata && metadata.verified;
            return new LeaderLine(startElement, endElement, {
                color: verified ? "#73d13d" : "#ff4d4f",
                size: 1,
                path: "fluid",
                startSocket: "right",
                endSocket: "left",
                startPlug: "disc",
                endPlug: "arrow2",
                dash: verified ? false : { len: 4, gap: 4 },
                gradient: true,
                startPlugColor: verified ? "#73d13d" : "#ff4d4f",
                endPlugColor: verified ? "#52c41a" : "#ff7875",
            });
        } catch (error) {
            console.warn("Atlas imports: failed to create leader line", error);
            return null;
        }
    }

    function updateEntryPosition(key) {
        const entry = activeLines.get(key);
        if (!entry) return;

        const anchorSelector = entry.anchorId;
        let anchorElement = entry.anchorElement;
        if (!isElementInDocument(anchorElement)) {
            anchorElement = null;
        }
        if (!anchorElement) {
            anchorElement = findAnchorElement(entry.sourceUri, anchorSelector);
        }

        let targetElement = entry.targetElement;
        if (!isElementInDocument(targetElement)) {
            targetElement = null;
        }
        if (!targetElement) {
            targetElement = findEditorTitlebar(entry.targetPath);
        }

        if (!anchorElement || !targetElement) {
            removeLine(entry);
            entry.anchorElement = anchorElement || null;
            entry.targetElement = targetElement || null;
            return;
        }

        const anchorChanged = anchorElement !== entry.anchorElement;
        const targetChanged = targetElement !== entry.targetElement;

        entry.anchorElement = anchorElement;
        entry.targetElement = targetElement;

        if (!entry.line || anchorChanged || targetChanged) {
            removeLine(entry);
            entry.line = createLeaderLine(anchorElement, targetElement, entry.metadata);
            return;
        }

        try {
            entry.line.position();
        } catch {
            // ignore positioning errors
        }
    }

    function ensureUpdateLoop() {
        if (updateScheduled) return;
        updateScheduled = true;
        const tick = () => {
            if (!activeLines.size) {
                updateScheduled = false;
                return;
            }
            activeLines.forEach((_, key) => updateEntryPosition(key));
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
    }

    function cleanupRemoved(currentKeys) {
        for (const [key, entry] of activeLines.entries()) {
            if (!currentKeys.has(key)) {
                removeLine(entry);
                activeLines.delete(key);
            }
        }
    }

    function cleanupAll() {
        for (const entry of activeLines.values()) {
            removeLine(entry);
        }
        activeLines.clear();
        updateScheduled = false;
    }

    registry.register({
        id: "imports",
        process(dataset, api) {
            if (!dataset || typeof dataset !== "object") {
                cleanupAll();
                return;
            }

            const relationships = new Set();

            for (const uri in dataset) {
                if (!Object.prototype.hasOwnProperty.call(dataset, uri)) continue;
                const annotations = dataset[uri];
                if (!annotations || typeof annotations !== "object") continue;

                for (const annotationId in annotations) {
                    if (!Object.prototype.hasOwnProperty.call(annotations, annotationId)) continue;
                    const annotation = annotations[annotationId];
                    if (!annotation || !annotation.ranges || !annotation.targetPath) continue;

                    const ranges = Array.isArray(annotation.ranges) ? annotation.ranges : [];
                    if (!ranges.length) continue;

                    const hoverParts = [];
                    if (annotation.text) {
                        hoverParts.push(`**Import:** \`${annotation.text}\``);
                    }
                    if (annotation.targetPath) {
                        hoverParts.push(`**Target:** ${annotation.targetPath}`);
                    }
                    if (annotation.metadata) {
                        const meta = annotation.metadata;
                        if (meta.detector) {
                            hoverParts.push(`**Detector:** ${meta.detector}`);
                        }
                        if (meta.verified !== undefined) {
                            hoverParts.push(`**File exists:** ${meta.verified ? "✓" : "✗"}`);
                        }
                        if (meta.resolvedPath && meta.resolvedPath !== annotation.targetPath) {
                            hoverParts.push(`**Resolved:** ${meta.resolvedPath}`);
                        }
                    }
                    const hoverText = hoverParts.length ? hoverParts.join("\n\n") : undefined;

                    const metadata = {
                        targetPath: annotation.targetPath,
                        ...(annotation.metadata || {}),
                    };

                    const anchorBase = annotation.id || annotationId;
                    let primaryAnchorId = null;

                    for (let index = 0; index < ranges.length; index += 1) {
                        const range = ranges[index];
                        if (!range) continue;
                        const anchorId = sanitizeAnchorId(`${anchorBase}-${index}`);
                        if (!anchorId) continue;
                        if (primaryAnchorId == null) {
                            primaryAnchorId = anchorId;
                        }
                        api.addRange(uri, range, {
                            hover: hoverText,
                            metadata,
                            anchorId,
                            annotationId: anchorBase,
                        });
                    }

                    if (!primaryAnchorId) continue;

                    const sourceKey = (normalizePathLike(uri) || uri || "").toLowerCase();
                    const targetKey = (normalizePathLike(annotation.targetPath) || annotation.targetPath || "").toLowerCase();
                    const relationshipKey = `${sourceKey}::${targetKey}::${primaryAnchorId}`;
                    relationships.add(relationshipKey);

                    let entry = activeLines.get(relationshipKey);
                    if (!entry) {
                        entry = {
                            sourceUri: uri,
                            targetPath: annotation.targetPath,
                            anchorId: primaryAnchorId,
                            metadata,
                            line: null,
                            anchorElement: null,
                            targetElement: null,
                        };
                        activeLines.set(relationshipKey, entry);
                    } else {
                        entry.sourceUri = uri;
                        entry.targetPath = annotation.targetPath;
                        entry.anchorId = primaryAnchorId;
                        entry.metadata = metadata;
                    }

                    updateEntryPosition(relationshipKey);
                }
            }

            cleanupRemoved(relationships);

            if (activeLines.size) {
                ensureUpdateLoop();
            }
        },
    });

    window.addEventListener("beforeunload", cleanupAll);
})();
