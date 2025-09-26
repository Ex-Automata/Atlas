"use strict";

/**
 * TaskEnvelope - Shared data contract for LSP task information
 * Provides normalized format for task data across all highlighting components
 */
class TaskEnvelope {
    /**
     * @param {object} params
     * @param {string} params.taskId - Unique identifier for this task
     * @param {string} params.type - Task type (e.g., 'definition', 'reference', 'highlight')
     * @param {string} params.sourceUri - URI of the source document
     * @param {string} params.editorId - ID of the editor instance
     * @param {Array} params.ranges - Array of range objects with start/end positions
     * @param {Array} [params.relatedUris] - Related document URIs for connections
     * @param {object} [params.metadata] - Additional task-specific data
     */
    constructor(params) {
        this.taskId = params.taskId;
        this.type = params.type;
        this.sourceUri = params.sourceUri;
        this.editorId = params.editorId;
        this.ranges = params.ranges || [];
        this.relatedUris = params.relatedUris || [];
        this.metadata = params.metadata || {};
        this.timestamp = Date.now();
    }

    /**
     * Factory method to create TaskEnvelope from LSP response data
     * @param {string} taskType - Type of LSP task
     * @param {string} sourceUri - Source document URI
     * @param {string} editorId - Editor instance ID
     * @param {any} lspData - Raw LSP response data
     * @returns {TaskEnvelope[]} Array of TaskEnvelopes
     */
    static fromLspData(taskType, sourceUri, editorId, lspData) {
        const envelopes = [];
        
        if (!lspData || lspData.__error) {
            return envelopes;
        }

        // Handle array of locations (definitions, references, etc.)
        if (Array.isArray(lspData)) {
            for (let i = 0; i < lspData.length; i++) {
                const item = lspData[i];
                if (item && item.range) {
                    envelopes.push(new TaskEnvelope({
                        taskId: `${taskType}-${sourceUri}-${i}`,
                        type: taskType,
                        sourceUri: sourceUri,
                        editorId: editorId,
                        ranges: [item.range],
                        relatedUris: item.uri ? [item.uri] : [],
                        metadata: { lspItem: item }
                    }));
                }
            }
        }
        // Handle single location or range data
        else if (lspData.range) {
            envelopes.push(new TaskEnvelope({
                taskId: `${taskType}-${sourceUri}-single`,
                type: taskType,
                sourceUri: sourceUri,
                editorId: editorId,
                ranges: [lspData.range],
                relatedUris: lspData.uri ? [lspData.uri] : [],
                metadata: { lspItem: lspData }
            }));
        }
        // Handle document highlights (special case)
        else if (taskType === 'documentHighlights' && Array.isArray(lspData)) {
            for (let i = 0; i < lspData.length; i++) {
                const highlight = lspData[i];
                if (highlight && highlight.range) {
                    envelopes.push(new TaskEnvelope({
                        taskId: `highlight-${sourceUri}-${i}`,
                        type: 'highlight',
                        sourceUri: sourceUri,
                        editorId: editorId,
                        ranges: [highlight.range],
                        relatedUris: [],
                        metadata: { 
                            kind: highlight.kind,
                            lspItem: highlight 
                        }
                    }));
                }
            }
        }

        return envelopes;
    }

    /**
     * Helper to resolve editor ID from URI using provided resolver function
     * @param {string} uri - Document URI
     * @param {Function} resolver - Function that maps URI to editor ID
     * @returns {string|null} Editor ID if found
     */
    static resolveEditorId(uri, resolver) {
        if (typeof resolver === 'function') {
            try {
                return resolver(uri);
            } catch (e) {
                console.warn('[Atlas] Failed to resolve editor ID for URI:', uri, e);
            }
        }
        return null;
    }
}

module.exports = { TaskEnvelope };