"use strict";

const vscode = require("vscode");
const { TaskEnvelope } = require("./TaskEnvelope");

/**
 * LspRelay - Handles LSP data collection and normalization
 * Proxies LSP provider results to normalized TaskEnvelope format
 */
class LspRelay {
    constructor() {
        this.isCollecting = false;
    }

    /**
     * Collect LSP data for a file and return normalized TaskEnvelopes
     * @param {string} filePath - Absolute file path
     * @param {string} editorId - Editor instance ID
     * @param {vscode.Position} [position] - Specific position for queries
     * @returns {Promise<TaskEnvelope[]>} Array of task envelopes
     */
    async collect(filePath, editorId, position = null) {
        if (!filePath || typeof filePath !== "string") {
            throw new Error("LspRelay.collect: filePath must be a string");
        }

        const uri = vscode.Uri.file(filePath);
        const uriString = uri.toString();
        
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const pos = position || this._findInterestingPosition(doc) || new vscode.Position(0, 0);
            const wordRange = doc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos);

            // Execute core LSP commands that are useful for highlighting
            const tasks = {
                definitions: this._runLspCommand("vscode.executeDefinitionProvider", uri, pos),
                references: this._runLspCommand("vscode.executeReferenceProvider", uri, pos),
                documentHighlights: this._runLspCommand("vscode.executeDocumentHighlights", uri, pos),
                documentSymbols: this._runLspCommand("vscode.executeDocumentSymbolProvider", uri),
                implementations: this._runLspCommand("vscode.executeImplementationProvider", uri, pos),
                typeDefinitions: this._runLspCommand("vscode.executeTypeDefinitionProvider", uri, pos),
                codeLens: this._runLspCommand("vscode.executeCodeLensProvider", uri)
            };

            const results = await Promise.all(
                Object.entries(tasks).map(async ([taskType, promise]) => {
                    try {
                        const data = await promise;
                        return { taskType, data };
                    } catch (error) {
                        return { taskType, data: { __error: error.message } };
                    }
                })
            );

            // Convert all LSP results to TaskEnvelopes
            const envelopes = [];
            for (const { taskType, data } of results) {
                const taskEnvelopes = TaskEnvelope.fromLspData(taskType, uriString, editorId, data);
                envelopes.push(...taskEnvelopes);
            }

            return envelopes;

        } catch (error) {
            console.error("[Atlas] LspRelay.collect failed:", error);
            throw error;
        }
    }

    /**
     * Run a single LSP command with error handling
     * @param {string} command - LSP command name
     * @param {...any} args - Command arguments
     * @returns {Promise<any>} LSP command result
     */
    async _runLspCommand(command, ...args) {
        try {
            const result = await vscode.commands.executeCommand(command, ...args);
            return result;
        } catch (error) {
            return { __error: error.message };
        }
    }

    /**
     * Find an interesting position in the document with actual content
     * @param {vscode.TextDocument} doc
     * @returns {vscode.Position|null}
     */
    _findInterestingPosition(doc) {
        const maxLines = Math.min(doc.lineCount, 200);
        for (let i = 0; i < maxLines; i++) {
            const line = doc.lineAt(i).text;
            const match = /[A-Za-z0-9_.$#\-]+/.exec(line);
            if (match && typeof match.index === "number") {
                return new vscode.Position(i, match.index);
            }
        }
        return null;
    }

    /**
     * Quick check if LSP providers are available for a document
     * @param {string} filePath - Absolute file path
     * @returns {Promise<boolean>} True if LSP providers are likely available
     */
    async isLspAvailable(filePath) {
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            
            // Quick test with a simple provider
            const symbols = await this._runLspCommand("vscode.executeDocumentSymbolProvider", uri);
            return symbols && !symbols.__error;
        } catch (error) {
            return false;
        }
    }
}

module.exports = { LspRelay };