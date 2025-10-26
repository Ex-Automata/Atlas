const RELATION_TYPES = [
    {
        id: "document_symbols",
        label: "Symbols",
        iconOn: "SY",
        iconOff: "sy",
        hint: "Toggle document symbols",
        defaultEnabled: true,
    },
    {
        id: "folding_ranges",
        label: "Folding",
        iconOn: "FO",
        iconOff: "fo",
        hint: "Toggle folding ranges",
        defaultEnabled: true,
    },
    {
        id: "definitions",
        label: "Defs",
        iconOn: "DE",
        iconOff: "de",
        hint: "Toggle definitions",
        defaultEnabled: true,
    },
    {
        id: "declarations",
        label: "Decl",
        iconOn: "DC",
        iconOff: "dc",
        hint: "Toggle declarations",
        defaultEnabled: true,
    },
    {
        id: "implementations",
        label: "Impl",
        iconOn: "IM",
        iconOff: "im",
        hint: "Toggle implementations",
        defaultEnabled: true,
    },
    {
        id: "type_definitions",
        label: "Type Def",
        iconOn: "TD",
        iconOff: "td",
        hint: "Toggle type definitions",
        defaultEnabled: true,
    },
    {
        id: "references",
        label: "Refs",
        iconOn: "RF",
        iconOff: "rf",
        hint: "Toggle references",
        defaultEnabled: true,
    },
    {
        id: "imports",
        label: "Imports",
        iconOn: "IN",
        iconOff: "in",
        hint: "Toggle imports",
        defaultEnabled: true,
    },
    {
        id: "call_hierarchy",
        label: "Calls",
        iconOn: "CH",
        iconOff: "ch",
        hint: "Toggle call hierarchy",
        defaultEnabled: true,
    },
    {
        id: "type_hierarchy",
        label: "Types",
        iconOn: "TH",
        iconOff: "th",
        hint: "Toggle type hierarchy",
        defaultEnabled: true,
    },
    {
        id: "manual",
        label: "Manual",
        iconOn: "MA",
        iconOff: "ma",
        hint: "Add manual annotation",
        defaultEnabled: true,
        action: "dialog",
    },
];

function createDatasetsSkeleton() {
    const datasets = Object.create(null);
    for (const rel of RELATION_TYPES) {
        datasets[rel.id] = Object.create(null);
    }
    return datasets;
}

function normalizeGraphPayload(graph) {
    // Data is already normalized by handlers, just structure it for the annotation system
    const datasets = createDatasetsSkeleton();
    
    if (!graph || typeof graph !== "object") {
        return datasets;
    }

    // Code structure
    if (graph.code_structure) {
        if (graph.code_structure.document_symbols) {
            datasets.document_symbols = graph.code_structure.document_symbols;
        }
        if (graph.code_structure.folding_ranges) {
            datasets.folding_ranges = graph.code_structure.folding_ranges;
        }
    }

    // Code navigation
    if (graph.code_navigation) {
        if (graph.code_navigation.definitions) {
            datasets.definitions = graph.code_navigation.definitions;
        }
        if (graph.code_navigation.declarations) {
            datasets.declarations = graph.code_navigation.declarations;
        }
        if (graph.code_navigation.implementations) {
            datasets.implementations = graph.code_navigation.implementations;
        }
        if (graph.code_navigation.type_definitions) {
            datasets.type_definitions = graph.code_navigation.type_definitions;
        }
        if (graph.code_navigation.references) {
            datasets.references = graph.code_navigation.references;
        }
    }

    // Imports
    if (graph.imports) {
        datasets.imports = graph.imports;
    }

    // Hierarchies
    if (graph.call_hierarchy) {
        datasets.call_hierarchy = graph.call_hierarchy;
    }
    if (graph.type_hierarchy) {
        datasets.type_hierarchy = graph.type_hierarchy;
    }

    return datasets;
}

function createAnnotationManager(canvasBridge) {
    if (!canvasBridge || !canvasBridge.parent || !canvasBridge.parent.webview) {
        throw new Error(
            "AnnotationManager requires a canvas bridge with an active webview"
        );
    }

    const webview = canvasBridge.parent.webview;
    const disposables = [];
    const state = {
        ready: false,
        latest: {
            document_symbols: {},
            folding_ranges: {},
            definitions: {},
            declarations: {},
            implementations: {},
            type_definitions: {},
            references: {},
            imports: {},
            call_hierarchy: {},
            type_hierarchy: {},
            manual: {},
        },
        needsSync: false,
    };

    function post(action, payload) {
        try {
            webview.postMessage({
                type: "atlas:annotation",
                action,
                payload,
            });
        } catch (err) {
            console.warn("[Atlas] Failed to post annotation message", err);
        }
    }

    function flush() {
        if (!state.ready || !state.needsSync) return;
        if (state.latest) {
            console.debug(
                "[Atlas:AnnotationManager] Flush state.latest:",
                state.latest
            );
            post("data", state.latest);
        }
        state.needsSync = false;
    }

    function bootstrap() {
        post("bootstrap", { relations: RELATION_TYPES });
    }

    disposables.push(
        webview.onDidReceiveMessage((msg) => {
            if (!msg || msg.type !== "atlas:annotation") return;
            if (msg.event === "ready") {
                state.ready = true;
                bootstrap();
                flush();
            } else if (msg.event === "requestLatest") {
                state.needsSync = true;
                flush();
            }
        })
    );

    function displayAnnotations(graph) {
        state.latest = normalizeGraphPayload(graph || {});
        state.needsSync = true;
        if (state.ready) {
            flush();
        }
    }

    function dispose() {
        while (disposables.length) {
            const disposable = disposables.pop();
            try {
                disposable?.dispose?.();
            } catch (err) {
                console.warn(
                    "[Atlas] Failed to dispose annotation listener",
                    err
                );
            }
        }
        state.ready = false;
        state.latest = null;
        state.needsSync = false;
    }

    return {
        displayAnnotations,
        dispose,
    };
}

module.exports = {
    createAnnotationManager,
    RELATION_TYPES,
};
