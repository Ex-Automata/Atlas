"use strict";

/**
 * GraphCoordinatorWebview - Web-side integration for GraphCoordinator
 * Handles action bar registration and webview-side highlighting coordination
 */
(function() {
    // Wait for Atlas components to be ready
    function waitForAtlas(callback) {
        if (typeof window !== 'undefined' && window.AtlasActionBar) {
            callback();
        } else {
            setTimeout(() => waitForAtlas(callback), 100);
        }
    }

    // Initialize when ready
    waitForAtlas(() => {
        console.log("[Atlas] GraphCoordinator webview integration initializing");

        // Track toggle states
        let editorHighlightsEnabled = true;
        let canvasLinksEnabled = true;

        // Register editor highlights toggle
        window.AtlasActionBar.registerAction("editorHighlights", {
            label: "Editor highlights",
            icon: "🎯",
            hint: "Toggle editor span highlights",
            onSelect: () => {
                editorHighlightsEnabled = !editorHighlightsEnabled;
                
                // Toggle visibility of all highlight elements
                const highlights = document.querySelectorAll('.atlas-editor-highlight');
                highlights.forEach(highlight => {
                    highlight.style.display = editorHighlightsEnabled ? '' : 'none';
                });
                
                console.log(`[Atlas] Editor highlights ${editorHighlightsEnabled ? 'enabled' : 'disabled'}`);
                
                // Send message to extension host
                if (window.postMessage) {
                    window.postMessage({
                        type: 'atlas:toggleEditorHighlights',
                        enabled: editorHighlightsEnabled
                    }, '*');
                }
            }
        });

        // Register canvas links toggle  
        window.AtlasActionBar.registerAction("canvasLinks", {
            label: "Canvas links",
            icon: "🔗", 
            hint: "Toggle canvas connection lines",
            onSelect: () => {
                canvasLinksEnabled = !canvasLinksEnabled;
                
                // Toggle visibility of SVG link layer
                const linkLayers = document.querySelectorAll('.atlas-canvas-links');
                linkLayers.forEach(layer => {
                    layer.style.display = canvasLinksEnabled ? '' : 'none';
                });
                
                console.log(`[Atlas] Canvas links ${canvasLinksEnabled ? 'enabled' : 'disabled'}`);
                
                // Send message to extension host
                if (window.postMessage) {
                    window.postMessage({
                        type: 'atlas:toggleCanvasLinks',
                        enabled: canvasLinksEnabled
                    }, '*');
                }
            }
        });

        console.log("[Atlas] GraphCoordinator webview integration ready");
    });

    // Listen for messages from extension host about highlights
    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message && typeof message === 'object') {
            switch (message.type) {
                case 'atlas:highlightsUpdate':
                    // Could handle real-time highlight updates here
                    console.log('[Atlas] Received highlights update:', message);
                    break;
                case 'atlas:editorRegistered':
                    console.log('[Atlas] Editor registered:', message.editorId);
                    break;
                case 'atlas:canvasRegistered':
                    console.log('[Atlas] Canvas registered');
                    break;
            }
        }
    });

})();