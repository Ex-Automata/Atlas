"use strict";

(function () {
    const annotations = window.AtlasAnnotations;
    if (!annotations || typeof annotations.register !== "function") return;

    const RELATION_ID = "manual";
    const SAMPLE_RANGE = "2:1-4:12";
    let stylesInjected = false;

    annotations.register({
        id: RELATION_ID,
        process(dataset, api) {
            const entries = Array.isArray(dataset) ? dataset : [];
            for (const entry of entries) {
                if (!entry) continue;
                const uri = entry.uri || entry.editorId || entry.path;
                const range = entry.range || null;
                if (!uri || !range) continue;
                api.addRange(uri, range, { allowFallback: false });
            }
        },
    });

    function injectStyles() {
        if (stylesInjected) return;
        const style = document.createElement("style");
        style.textContent = `
        .atlas-manual-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.45);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2147483645;
        }
        .atlas-manual-dialog {
            min-width: 320px;
            max-width: 420px;
            background: var(--atlas-manual-bg, #1d1f23);
            color: #f4f4f6;
            border-radius: 8px;
            box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
            padding: 20px 24px;
            font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto,
                Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial;
        }
        .atlas-manual-dialog h2 {
            margin: 0 0 12px;
            font-size: 18px;
            font-weight: 600;
        }
        .atlas-manual-dialog label {
            display: block;
            font-size: 13px;
            margin-bottom: 6px;
            font-weight: 500;
        }
        .atlas-manual-dialog select,
        .atlas-manual-dialog input[type="text"] {
            width: 100%;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.18);
            background: rgba(0, 0, 0, 0.2);
            color: inherit;
            font-size: 13px;
            margin-bottom: 12px;
        }
        .atlas-manual-dialog input[type="text"]::placeholder {
            color: rgba(244, 244, 246, 0.4);
        }
        .atlas-manual-dialog p.sample {
            margin: 0 0 16px;
            font-size: 12px;
            color: rgba(244, 244, 246, 0.72);
        }
        .atlas-manual-dialog .actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
        .atlas-manual-dialog button {
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.18);
            background: rgba(255, 255, 255, 0.08);
            color: inherit;
            padding: 6px 14px;
            font-size: 13px;
            cursor: pointer;
        }
        .atlas-manual-dialog button.primary {
            background: #ff4d6d;
            border-color: rgba(255, 77, 109, 0.72);
            color: #fff;
        }
        .atlas-manual-dialog button.primary:disabled {
            opacity: 0.6;
            cursor: default;
        }
        .atlas-manual-error {
            font-size: 12px;
            color: #ff8c42;
            margin: -6px 0 12px;
        }
        @media (prefers-color-scheme: light) {
            .atlas-manual-dialog {
                background: #ffffff;
                color: #24292f;
            }
            .atlas-manual-dialog select,
            .atlas-manual-dialog input[type="text"] {
                background: rgba(0, 0, 0, 0.04);
                border: 1px solid rgba(0, 0, 0, 0.12);
                color: inherit;
            }
            .atlas-manual-dialog button {
                border: 1px solid rgba(0, 0, 0, 0.12);
                background: rgba(0, 0, 0, 0.06);
            }
        }
        `;
        document.head.appendChild(style);
        stylesInjected = true;
    }

    function getOpenEditorIds() {
        const nodes = document.querySelectorAll(".editor-shell[data-editor-id]");
        const ids = [];
        for (const node of nodes) {
            const id = node.getAttribute("data-editor-id");
            if (id) ids.push(id);
        }
        return ids;
    }

    function parseRangeInput(value) {
        if (!value) return null;
        const match = String(value)
            .trim()
            .match(/^\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*:\s*(\d+)\s*$/);
        if (!match) return null;
        const startLine = Math.max(0, parseInt(match[1], 10) - 1);
        const startCharacter = Math.max(0, parseInt(match[2], 10) - 1);
        const endLineRaw = Math.max(0, parseInt(match[3], 10) - 1);
        const endCharacterRaw = Math.max(0, parseInt(match[4], 10) - 1);
        const endLine = Math.max(endLineRaw, startLine);
        const endCharacter = Math.max(
            endCharacterRaw,
            endLine === startLine ? startCharacter : 0
        );
        return {
            startLine,
            startCharacter,
            endLine,
            endCharacter,
        };
    }

    function showError(container, message) {
        let box = container.querySelector(".atlas-manual-error");
        if (!box) {
            box = document.createElement("div");
            box.className = "atlas-manual-error";
            container.appendChild(box);
        }
        box.textContent = message;
    }

    function clearError(container) {
        const box = container.querySelector(".atlas-manual-error");
        if (box) box.textContent = "";
    }

    function openDialog() {
        injectStyles();
        const editors = getOpenEditorIds();
        if (!editors.length) {
            window.alert("No open editors found. Open a document in Atlas first.");
            return;
        }

        const overlay = document.createElement("div");
        overlay.className = "atlas-manual-overlay";
        const dialog = document.createElement("div");
        dialog.className = "atlas-manual-dialog";
        dialog.innerHTML = `
            <h2>Add Manual Annotation</h2>
            <form class="atlas-manual-form">
                <label for="atlas-manual-editor">Editor</label>
                <select id="atlas-manual-editor"></select>
                <label for="atlas-manual-range">Range</label>
                <input id="atlas-manual-range" type="text" placeholder="${SAMPLE_RANGE}" />
                <p class="sample">Range format: <code>startLine:startColumn-endLine:endColumn</code> (1-based). Example: <code>${SAMPLE_RANGE}</code></p>
                <div class="atlas-manual-error"></div>
                <div class="actions">
                    <button type="button" data-action="cancel">Cancel</button>
                    <button type="submit" class="primary">Add</button>
                </div>
            </form>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const form = dialog.querySelector(".atlas-manual-form");
        const editorSelect = dialog.querySelector("#atlas-manual-editor");
        const rangeInput = dialog.querySelector("#atlas-manual-range");
        const cancelBtn = dialog.querySelector('button[data-action="cancel"]');

        editors.forEach((id) => {
            const option = document.createElement("option");
            option.value = id;
            option.textContent = id;
            editorSelect.appendChild(option);
        });

        rangeInput.focus();

        function closeDialog() {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
        }

        function onKeyDown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                closeDialog();
            }
        }

        document.addEventListener("keydown", onKeyDown, true);

        cancelBtn?.addEventListener("click", () => {
            closeDialog();
        });

        form.addEventListener("submit", (event) => {
            event.preventDefault();
            clearError(dialog);
            const editorId = editorSelect.value;
            const parsedRange = parseRangeInput(rangeInput.value);
            if (!editorId) {
                showError(dialog, "Please select an editor.");
                return;
            }
            if (!parsedRange) {
                showError(dialog, "Enter a range like 2:1-4:12 (1-based).");
                return;
            }
            annotations.addDatasetEntry(RELATION_ID, {
                uri: editorId,
                range: parsedRange,
                createdAt: Date.now(),
            });
            annotations.setToggleState?.(RELATION_ID, true, { silent: true });
            closeDialog();
        });
    }

    window.addEventListener("atlas:annotation:dialog", (event) => {
        if (!event || !event.detail) return;
        if (event.detail.relationId !== RELATION_ID) return;
        annotations.setToggleState?.(RELATION_ID, true, { silent: true });
        openDialog();
    });
})();
