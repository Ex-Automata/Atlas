"use strict";

/**
 * CanvasLinkLayer - Draws connection lines on canvas between task usages and definitions
 * Renders SVG lines between related symbols across multiple editors
 */
class CanvasLinkLayer {
    constructor() {
        this.enabled = true;
        this.canvasRoot = null;
        this.svgLayer = null;
        this.connections = new Map(); // taskId -> SVG path element
        this.editorResolver = null; // Function to resolve editor positions
    }

    /**
     * Attach the link layer to a canvas root element
     * @param {HTMLElement} canvasRoot - Canvas root DOM element
     * @param {Function} [editorResolver] - Function to resolve editor positions from IDs
     */
    attach(canvasRoot, editorResolver = null) {
        if (!canvasRoot) {
            console.warn("[Atlas] CanvasLinkLayer.attach: missing canvasRoot");
            return;
        }

        this.canvasRoot = canvasRoot;
        this.editorResolver = editorResolver;
        
        // Create SVG layer for drawing connections
        this._createSvgLayer();
        
        console.log("[Atlas] CanvasLinkLayer attached to canvas");
    }

    /**
     * Detach the link layer from the canvas
     */
    detach() {
        if (this.svgLayer && this.svgLayer.remove) {
            this.svgLayer.remove();
        }
        
        this.canvasRoot = null;
        this.svgLayer = null;
        this.connections.clear();
        this.editorResolver = null;
        
        console.log("[Atlas] CanvasLinkLayer detached");
    }

    /**
     * Render connections from a TaskEnvelope
     * @param {TaskEnvelope} taskEnvelope - Task data to render connections for
     */
    render(taskEnvelope) {
        if (!this.enabled || !this.canvasRoot || !this.svgLayer || !taskEnvelope) {
            return;
        }

        const { taskId, type, editorId, relatedUris } = taskEnvelope;
        
        // Only render connections for tasks that have related URIs
        if (!relatedUris || relatedUris.length === 0) {
            return;
        }

        // Clear existing connections for this task
        this.clearTask(taskId);

        // Find source editor position
        const sourceEditor = this._findEditorElement(editorId);
        if (!sourceEditor) {
            console.warn(`[Atlas] Source editor not found: ${editorId}`);
            return;
        }

        // Create connections to related editors
        relatedUris.forEach((relatedUri, index) => {
            const targetEditorId = this._resolveEditorIdFromUri(relatedUri);
            if (targetEditorId && targetEditorId !== editorId) {
                const targetEditor = this._findEditorElement(targetEditorId);
                if (targetEditor) {
                    const connectionId = `${taskId}-${index}`;
                    const pathElement = this._createConnectionPath(
                        sourceEditor, 
                        targetEditor, 
                        type, 
                        connectionId
                    );
                    
                    if (pathElement) {
                        this.connections.set(connectionId, pathElement);
                        this.svgLayer.appendChild(pathElement);
                    }
                }
            }
        });
    }

    /**
     * Clear connections for a specific task
     * @param {string} taskId - Task ID to clear connections for
     */
    clearTask(taskId) {
        const toRemove = [];
        for (const [connectionId, pathElement] of this.connections.entries()) {
            if (connectionId.startsWith(taskId)) {
                toRemove.push([connectionId, pathElement]);
            }
        }

        toRemove.forEach(([connectionId, pathElement]) => {
            if (pathElement && pathElement.remove) {
                pathElement.remove();
            }
            this.connections.delete(connectionId);
        });
    }

    /**
     * Enable or disable connection rendering
     * @param {boolean} enabled - Whether connections should be enabled
     */
    setEnabled(enabled) {
        this.enabled = !!enabled;
        
        if (this.svgLayer) {
            this.svgLayer.style.display = this.enabled ? '' : 'none';
        }
    }

    /**
     * Update all connections (useful when editors are moved/resized)
     */
    updateAllConnections() {
        if (!this.enabled || !this.svgLayer) {
            return;
        }

        // Re-calculate positions for all existing connections
        for (const [connectionId, pathElement] of this.connections.entries()) {
            const sourceEditorId = pathElement.dataset.sourceEditorId;
            const targetEditorId = pathElement.dataset.targetEditorId;
            
            if (sourceEditorId && targetEditorId) {
                const sourceEditor = this._findEditorElement(sourceEditorId);
                const targetEditor = this._findEditorElement(targetEditorId);
                
                if (sourceEditor && targetEditor) {
                    const path = this._calculateConnectionPath(sourceEditor, targetEditor);
                    pathElement.setAttribute('d', path);
                }
            }
        }
    }

    /**
     * Create the SVG layer for drawing connections
     */
    _createSvgLayer() {
        this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svgLayer.className = 'atlas-canvas-links';
        this.svgLayer.style.position = 'absolute';
        this.svgLayer.style.top = '0';
        this.svgLayer.style.left = '0';
        this.svgLayer.style.width = '100%';
        this.svgLayer.style.height = '100%';
        this.svgLayer.style.pointerEvents = 'none';
        this.svgLayer.style.zIndex = '1';
        
        this.canvasRoot.appendChild(this.svgLayer);
    }

    /**
     * Create an SVG path element for a connection between two editors
     * @param {HTMLElement} sourceEditor - Source editor element
     * @param {HTMLElement} targetEditor - Target editor element
     * @param {string} connectionType - Type of connection
     * @param {string} connectionId - Unique connection ID
     * @returns {SVGPathElement|null} Created path element
     */
    _createConnectionPath(sourceEditor, targetEditor, connectionType, connectionId) {
        const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        
        // Calculate the path between editors
        const pathData = this._calculateConnectionPath(sourceEditor, targetEditor);
        pathElement.setAttribute('d', pathData);
        
        // Style based on connection type
        switch (connectionType) {
            case 'definitions':
                pathElement.setAttribute('stroke', '#64c864');
                pathElement.setAttribute('stroke-width', '2');
                break;
            case 'references':
                pathElement.setAttribute('stroke', '#6496c8');
                pathElement.setAttribute('stroke-width', '1.5');
                break;
            case 'implementations':
                pathElement.setAttribute('stroke', '#c864c8');
                pathElement.setAttribute('stroke-width', '2');
                break;
            default:
                pathElement.setAttribute('stroke', '#999999');
                pathElement.setAttribute('stroke-width', '1');
        }
        
        pathElement.setAttribute('fill', 'none');
        pathElement.setAttribute('stroke-dasharray', '4,2');
        pathElement.setAttribute('opacity', '0.7');
        
        // Add metadata
        pathElement.dataset.connectionId = connectionId;
        pathElement.dataset.sourceEditorId = sourceEditor.dataset.editorId;
        pathElement.dataset.targetEditorId = targetEditor.dataset.editorId;
        pathElement.dataset.type = connectionType;
        
        // Add title for debugging
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${connectionType}: ${sourceEditor.dataset.editorId} → ${targetEditor.dataset.editorId}`;
        pathElement.appendChild(title);
        
        return pathElement;
    }

    /**
     * Calculate SVG path data for a connection between two editor elements
     * @param {HTMLElement} sourceEditor - Source editor element
     * @param {HTMLElement} targetEditor - Target editor element
     * @returns {string} SVG path data
     */
    _calculateConnectionPath(sourceEditor, targetEditor) {
        const sourceRect = sourceEditor.getBoundingClientRect();
        const targetRect = targetEditor.getBoundingClientRect();
        const canvasRect = this.canvasRoot.getBoundingClientRect();
        
        // Calculate relative positions within the canvas
        const sourceX = sourceRect.left - canvasRect.left + sourceRect.width / 2;
        const sourceY = sourceRect.top - canvasRect.top + sourceRect.height / 2;
        const targetX = targetRect.left - canvasRect.left + targetRect.width / 2;
        const targetY = targetRect.top - canvasRect.top + targetRect.height / 2;
        
        // Create a curved path
        const controlPointOffset = Math.min(100, Math.abs(targetX - sourceX) / 2);
        const controlX1 = sourceX + controlPointOffset;
        const controlY1 = sourceY;
        const controlX2 = targetX - controlPointOffset;
        const controlY2 = targetY;
        
        return `M ${sourceX} ${sourceY} C ${controlX1} ${controlY1} ${controlX2} ${controlY2} ${targetX} ${targetY}`;
    }

    /**
     * Find an editor element by editor ID
     * @param {string} editorId - Editor ID to find
     * @returns {HTMLElement|null} Editor element or null if not found
     */
    _findEditorElement(editorId) {
        if (!this.canvasRoot) return null;
        return this.canvasRoot.querySelector(`[data-editor-id="${editorId}"]`);
    }

    /**
     * Resolve editor ID from a URI using the configured resolver
     * @param {string} uri - Document URI
     * @returns {string|null} Editor ID or null if not resolvable
     */
    _resolveEditorIdFromUri(uri) {
        if (this.editorResolver && typeof this.editorResolver === 'function') {
            try {
                return this.editorResolver(uri);
            } catch (error) {
                console.warn('[Atlas] Failed to resolve editor ID from URI:', uri, error);
            }
        }
        
        // Fallback: try to use URI as editor ID (simplified approach)
        const match = uri.match(/file:\/\/(.+)$/);
        return match ? match[1] : null;
    }
}

module.exports = { CanvasLinkLayer };