"use strict";

/**
 * EditorHighlightController - Manages visual highlights within editor instances
 * Creates DOM overlays for task spans and provides enable/disable functionality
 */
class EditorHighlightController {
    constructor() {
        this.enabled = true;
        this.editorHighlights = new Map(); // editorId -> Set of highlight elements
        this.taskHighlights = new Map(); // taskId -> highlight element
    }

    /**
     * Mount highlight support for an editor instance
     * @param {string} editorId - Editor instance ID
     */
    mount(editorId) {
        if (!editorId) {
            console.warn("[Atlas] EditorHighlightController.mount: missing editorId");
            return;
        }

        // Initialize highlights set for this editor
        if (!this.editorHighlights.has(editorId)) {
            this.editorHighlights.set(editorId, new Set());
        }

        console.log(`[Atlas] Mounted editor highlights for ${editorId}`);
    }

    /**
     * Unmount highlight support for an editor instance
     * @param {string} editorId - Editor instance ID
     */
    unmount(editorId) {
        if (!editorId) return;

        // Clean up highlights for this editor
        const highlights = this.editorHighlights.get(editorId);
        if (highlights) {
            highlights.forEach(element => {
                if (element && element.remove) {
                    element.remove();
                }
            });
            highlights.clear();
            this.editorHighlights.delete(editorId);
        }

        // Clean up task highlights that belonged to this editor
        for (const [taskId, element] of this.taskHighlights.entries()) {
            if (element && element.dataset.editorId === editorId) {
                element.remove();
                this.taskHighlights.delete(taskId);
            }
        }

        console.log(`[Atlas] Unmounted editor highlights for ${editorId}`);
    }

    /**
     * Apply highlights from a TaskEnvelope
     * @param {TaskEnvelope} taskEnvelope - Task data to highlight
     */
    apply(taskEnvelope) {
        if (!this.enabled || !taskEnvelope) {
            return;
        }

        const { editorId, taskId, type, ranges } = taskEnvelope;
        
        // Find the editor root element
        const editorRoot = document.querySelector(`[data-editor-id="${editorId}"]`);
        if (!editorRoot) {
            console.warn(`[Atlas] No editor found for ID: ${editorId}`);
            return;
        }

        // Remove existing highlight for this task if it exists
        this.clearTask(taskId);

        // Create highlight elements for each range
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            const highlightElement = this._createHighlightElement(taskEnvelope, range, i);
            
            if (highlightElement) {
                // Add to editor's highlight container
                this._addHighlightToEditor(editorRoot, highlightElement);
                
                // Track the highlight
                const editorHighlights = this.editorHighlights.get(editorId) || new Set();
                editorHighlights.add(highlightElement);
                this.editorHighlights.set(editorId, editorHighlights);
                
                this.taskHighlights.set(`${taskId}-${i}`, highlightElement);
            }
        }
    }

    /**
     * Clear highlights for a specific task
     * @param {string} taskId - Task ID to clear
     */
    clearTask(taskId) {
        // Find all highlight elements for this task (including range indices)
        const toRemove = [];
        for (const [key, element] of this.taskHighlights.entries()) {
            if (key.startsWith(taskId)) {
                toRemove.push([key, element]);
            }
        }

        toRemove.forEach(([key, element]) => {
            if (element && element.remove) {
                element.remove();
            }
            this.taskHighlights.delete(key);
            
            // Remove from editor highlights set
            const editorId = element?.dataset?.editorId;
            if (editorId) {
                const editorHighlights = this.editorHighlights.get(editorId);
                if (editorHighlights) {
                    editorHighlights.delete(element);
                }
            }
        });
    }

    /**
     * Enable or disable highlights
     * @param {boolean} enabled - Whether highlights should be enabled
     */
    setEnabled(enabled) {
        this.enabled = !!enabled;
        
        if (this.enabled) {
            // Show all existing highlights
            this.taskHighlights.forEach(element => {
                if (element) element.style.display = '';
            });
        } else {
            // Hide all highlights
            this.taskHighlights.forEach(element => {
                if (element) element.style.display = 'none';
            });
        }
    }

    /**
     * Create a highlight element for a range
     * @param {TaskEnvelope} taskEnvelope - Task data
     * @param {object} range - Range object with start/end positions
     * @param {number} rangeIndex - Index of this range within the task
     * @returns {HTMLElement|null} Created highlight element
     */
    _createHighlightElement(taskEnvelope, range, rangeIndex) {
        const element = document.createElement('div');
        element.className = `atlas-editor-highlight atlas-highlight-${taskEnvelope.type}`;
        element.dataset.taskId = taskEnvelope.taskId;
        element.dataset.editorId = taskEnvelope.editorId;
        element.dataset.rangeIndex = rangeIndex;
        element.dataset.type = taskEnvelope.type;
        
        // Set position styles based on range
        // Note: This is a simplified approach - real implementation would need
        // to coordinate with Monaco editor's positioning system
        element.style.position = 'absolute';
        element.style.pointerEvents = 'none';
        element.style.zIndex = '10';
        
        // Different styling for different highlight types
        switch (taskEnvelope.type) {
            case 'definitions':
                element.style.backgroundColor = 'rgba(100, 200, 100, 0.2)';
                element.style.border = '1px solid rgba(100, 200, 100, 0.5)';
                break;
            case 'references':
                element.style.backgroundColor = 'rgba(100, 150, 200, 0.2)';
                element.style.border = '1px solid rgba(100, 150, 200, 0.5)';
                break;
            case 'highlight':
            case 'documentHighlights':
                element.style.backgroundColor = 'rgba(255, 255, 100, 0.3)';
                element.style.border = '1px solid rgba(255, 255, 100, 0.6)';
                break;
            default:
                element.style.backgroundColor = 'rgba(150, 150, 150, 0.2)';
                element.style.border = '1px solid rgba(150, 150, 150, 0.5)';
        }
        
        // Add tooltip
        element.title = `${taskEnvelope.type}: Line ${range.start?.line + 1 || '?'}, Col ${range.start?.character + 1 || '?'}`;
        
        return element;
    }

    /**
     * Add a highlight element to the editor's highlight container
     * @param {HTMLElement} editorRoot - Editor root element
     * @param {HTMLElement} highlightElement - Highlight element to add
     */
    _addHighlightToEditor(editorRoot, highlightElement) {
        // Find or create highlight container
        let container = editorRoot.querySelector('.atlas-editor-highlights');
        if (!container) {
            container = document.createElement('div');
            container.className = 'atlas-editor-highlights';
            container.style.position = 'absolute';
            container.style.top = '0';
            container.style.left = '0';
            container.style.right = '0';
            container.style.bottom = '0';
            container.style.pointerEvents = 'none';
            container.style.zIndex = '5';
            
            // Add to editor body
            const editorBody = editorRoot.querySelector('.editor-body');
            if (editorBody) {
                editorBody.appendChild(container);
            } else {
                editorRoot.appendChild(container);
            }
        }
        
        container.appendChild(highlightElement);
    }
}

module.exports = { EditorHighlightController };