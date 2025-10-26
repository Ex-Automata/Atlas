"use strict";

(function () {
    const registry = window.AtlasAnnotations;
    if (!registry || typeof registry.register !== "function") return;

    const activeLines = new Map();
    let updateScheduled = false;
    let leaderLineWarned = false;
    const pinnedLines = new Set(); // Track which lines should stay visible
    let delegatedHandlersInstalled = false;

    function installDelegatedHandlersOnce() {
        if (delegatedHandlersInstalled) return;
        delegatedHandlersInstalled = true;

        // Helper to find nearest editor shell
        function getShell(node) {
            return node && node.closest ? node.closest('.editor-shell[data-editor-id]') : null;
        }

        // Extract atlas anchor id from a node's class list
        function getAnchorIdFromNode(node) {
            if (!node || !node.classList) return null;
            for (const cls of node.classList) {
                if (cls.startsWith('atlas-anchor-')) {
                    return cls.slice('atlas-anchor-'.length);
                }
            }
            return null;
        }

        // Delegated click to toggle pinning even when direct listeners fail
        document.addEventListener(
            'click',
            (e) => {
                const clickX = e.clientX;
                const clickY = e.clientY;

                // 1) Try DOM-ancestor detection first
                let target = e.target;
                let anchorId = null;
                while (target && target !== document.body && !anchorId) {
                    anchorId = getAnchorIdFromNode(target);
                    if (!anchorId) target = target.parentElement;
                }
                // Find shell from the nearest element we have
                let shell = getShell(target || e.target);

                // 2) If we still don't have an anchor, do a manual hit-test over anchor spans
                if (!anchorId) {
                    // If we don't have shell yet, try to get it from the initial event target
                    if (!shell) shell = getShell(e.target);
                    if (!shell) return;
                    const anchors = shell.querySelectorAll('[class*="atlas-anchor-"]');
                    for (const el of anchors) {
                        const rect = el.getBoundingClientRect();
                        if (
                            clickX >= rect.left &&
                            clickX <= rect.right &&
                            clickY >= rect.top &&
                            clickY <= rect.bottom
                        ) {
                            anchorId = getAnchorIdFromNode(el);
                            if (anchorId) { target = el; break; }
                        }
                    }
                }

                if (!anchorId) return;
                if (!shell) shell = getShell(target);
                if (!shell) return;
                const editorId = (shell.getAttribute('data-editor-id') || '').toLowerCase();
                if (!editorId) return;

                // Find matching entries by anchorId and source editor id
                const matches = [];
                for (const [key, entry] of activeLines.entries()) {
                    if (!entry) continue;
                    const entryAnchor = (entry.anchorId || '').toLowerCase();
                    const entrySrc = (normalizePathLike(entry.sourceUri) || '').toLowerCase();
                    if (entryAnchor === anchorId && (entrySrc === editorId || entrySrc.endsWith(editorId) || editorId.endsWith(entrySrc))) {
                        matches.push([key, entry]);
                    }
                }
                if (!matches.length) return;

                // Toggle pin state for all matches
                e.preventDefault();
                e.stopPropagation();
                for (const [key, entry] of matches) {
                    const isPinned = pinnedLines.has(key);
                    if (isPinned) {
                        pinnedLines.delete(key);
                        // Hide if cursor not hovering (best effort)
                        if (entry.line) {
                            try { entry.line.hide('draw', { duration: 200 }); } catch {}
                        }
                    } else {
                        pinnedLines.add(key);
                        // Ensure line exists and show it
                        updateEntryPosition(key);
                        if (entry.line) {
                            try { entry.line.show('draw', { duration: 200 }); } catch {}
                        }
                    }
                }
            },
            true // capture to beat Monaco handlers
        );

        // Delegated hover (mouseover/mouseout) to show/hide when not pinned
        document.addEventListener(
            'mouseover',
            (e) => {
                let target = e.target;
                let anchorId = null;
                while (target && target !== document.body && !anchorId) {
                    anchorId = getAnchorIdFromNode(target);
                    if (!anchorId) target = target.parentElement;
                }
                // Case 1: hovering a source anchor span
                if (anchorId) {
                    const shell = getShell(target);
                    if (!shell) return;
                    const editorId = (shell.getAttribute('data-editor-id') || '').toLowerCase();
                    if (!editorId) return;

                    for (const [key, entry] of activeLines.entries()) {
                        const entryAnchor = (entry.anchorId || '').toLowerCase();
                        const entrySrc = (normalizePathLike(entry.sourceUri) || '').toLowerCase();
                        if (
                            entryAnchor === anchorId &&
                            (entrySrc === editorId || entrySrc.endsWith(editorId) || editorId.endsWith(entrySrc))
                        ) {
                            if (!pinnedLines.has(key)) {
                                updateEntryPosition(key);
                                if (entry.line) {
                                    try { entry.line.show('draw', { duration: 150 }); } catch {}
                                }
                            }
                        }
                    }
                    return;
                }

                // Case 2: hovering a target editor titlebar (reveal incoming lines to that target)
                let node = e.target;
                const titlebar = node && node.closest ? node.closest('.editor-titlebar') : null;
                if (!titlebar) return;
                const shell = getShell(titlebar);
                if (!shell) return;
                for (const [key, entry] of activeLines.entries()) {
                    if (pinnedLines.has(key)) continue;
                    updateEntryPosition(key);
                    if (entry.targetElement === titlebar) {
                        if (entry.line) {
                            try { entry.line.show('draw', { duration: 150 }); } catch {}
                        }
                    }
                }
            },
            true
        );
        document.addEventListener(
            'mouseout',
            (e) => {
                let target = e.target;
                let anchorId = null;
                while (target && target !== document.body && !anchorId) {
                    anchorId = getAnchorIdFromNode(target);
                    if (!anchorId) target = target.parentElement;
                }
                // Case 1: leaving a source anchor span
                if (anchorId) {
                    const shell = getShell(target);
                    if (!shell) return;
                    const editorId = (shell.getAttribute('data-editor-id') || '').toLowerCase();
                    if (!editorId) return;

                    // If moving within the same anchor, ignore
                    const related = e.relatedTarget;
                    if (related && target && target.contains && target.contains(related)) return;

                    for (const [key, entry] of activeLines.entries()) {
                        const entryAnchor = (entry.anchorId || '').toLowerCase();
                        const entrySrc = (normalizePathLike(entry.sourceUri) || '').toLowerCase();
                        if (
                            entryAnchor === anchorId &&
                            (entrySrc === editorId || entrySrc.endsWith(editorId) || editorId.endsWith(entrySrc))
                        ) {
                            if (!pinnedLines.has(key)) {
                                if (entry.line) {
                                    try { entry.line.hide('draw', { duration: 150 }); } catch {}
                                }
                            }
                        }
                    }
                    return;
                }

                // Case 2: leaving a target editor titlebar
                let node = e.target;
                const titlebar = node && node.closest ? node.closest('.editor-titlebar') : null;
                if (!titlebar) return;
                // If moving within the same titlebar, ignore
                const related = e.relatedTarget;
                if (related && titlebar.contains && titlebar.contains(related)) return;

                for (const [key, entry] of activeLines.entries()) {
                    if (pinnedLines.has(key)) continue;
                    if (entry.targetElement === titlebar) {
                        if (entry.line) {
                            try { entry.line.hide('draw', { duration: 150 }); } catch {}
                        }
                    }
                }
            },
            true
        );
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
            // Clean up event listeners
            if (entry.anchorElement) {
                if (entry.mouseEnterHandler) {
                    entry.anchorElement.removeEventListener('mouseenter', entry.mouseEnterHandler);
                }
                if (entry.mouseLeaveHandler) {
                    entry.anchorElement.removeEventListener('mouseleave', entry.mouseLeaveHandler);
                }
                if (entry.clickHandler) {
                    entry.anchorElement.removeEventListener('click', entry.clickHandler);
                }
            }
            
            try {
                entry.line.remove();
            } catch {
                // ignore leader line removal failures
            }
            entry.line = null;
            entry.mouseEnterHandler = null;
            entry.mouseLeaveHandler = null;
            entry.clickHandler = null;
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
            const line = new LeaderLine(startElement, endElement, {
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
            // Hide by default
            line.hide('none');
            return line;
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
                pinnedLines.delete(key); // Clean up pinned state
            }
        }
    }

    function cleanupAll() {
        for (const entry of activeLines.values()) {
            removeLine(entry);
        }
        activeLines.clear();
        pinnedLines.clear();
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
                            relationshipKey: relationshipKey,
                            mouseEnterHandler: null,
                            mouseLeaveHandler: null,
                            clickHandler: null,
                        };
                        activeLines.set(relationshipKey, entry);
                    } else {
                        entry.sourceUri = uri;
                        entry.targetPath = annotation.targetPath;
                        entry.anchorId = primaryAnchorId;
                        entry.metadata = metadata;
                        entry.relationshipKey = relationshipKey;
                    }

                    updateEntryPosition(relationshipKey);
                }
            }

            cleanupRemoved(relationships);

            if (activeLines.size) {
                ensureUpdateLoop();
                installDelegatedHandlersOnce();
            }
        },
    });

    window.addEventListener("beforeunload", cleanupAll);
})();
