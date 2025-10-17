// Uses VS Code's built-in language features via executeCommand.
// No server process, no LanguageClient.

const vscode = require('vscode');

class LSPAdapter {
  constructor() {}

  async initialize() { /* no-op */ }
  dispose() { /* no-op */ }

  onNotification(_method, _cb) {
    // VS Code API doesn't expose LSP notifications directly here—no-op.
    return () => {};
  }

  async request(method, params) {
    const { textDocument, position, context } = params || {};
    const uri = vscode.Uri.parse(textDocument?.uri);

    // Ensure the doc is loaded so providers run
    await ensureOpen(uri);

    switch (method) {
      case 'textDocument/documentSymbol':
        return vscode.commands.executeCommand(
          'vscode.executeDocumentSymbolProvider',
          uri
        );

      case 'textDocument/definition':
        return vscode.commands.executeCommand(
          'vscode.executeDefinitionProvider',
          uri,
          toVscodePos(position)
        );

      case 'textDocument/references':
        return vscode.commands.executeCommand(
          'vscode.executeReferenceProvider',
          uri,
          toVscodePos(position),
          context ?? { includeDeclaration: false }
        );

      case 'textDocument/documentLink':
        return vscode.commands.executeCommand(
          'vscode.executeDocumentLinkProvider',
          uri
        );

      case 'textDocument/typeDefinition':
        return vscode.commands.executeCommand(
          'vscode.executeTypeDefinitionProvider',
          uri,
          toVscodePos(position)
        );

      case 'textDocument/foldingRange':
        return vscode.commands.executeCommand(
          'vscode.executeFoldingRangeProvider',
          uri
        );

      case 'textDocument/declaration':
        return vscode.commands.executeCommand(
          'vscode.executeDeclarationProvider',
          uri,
          toVscodePos(position)
        );

      case 'textDocument/implementation':
        return vscode.commands.executeCommand(
          'vscode.executeImplementationProvider',
          uri,
          toVscodePos(position)
        );

      // Call hierarchy support
      case 'textDocument/prepareCallHierarchy':
        return vscode.commands.executeCommand(
          'vscode.prepareCallHierarchy',
          uri,
          toVscodePos(position)
        );

      // Type hierarchy support
      case 'textDocument/prepareTypeHierarchy':
        return vscode.commands.executeCommand(
          'vscode.prepareTypeHierarchy',
          uri,
          toVscodePos(position)
        );

      default:
        throw new Error(`Unsupported method for VscodeApiAdapter: ${method}`);
    }
  }
}

async function ensureOpen(uri) {
  const existing = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (existing) return existing;
  return vscode.workspace.openTextDocument(uri);
}

function toVscodePos(p) {
  if (!p) return new vscode.Position(0, 0);
  return new vscode.Position(p.line ?? 0, p.character ?? 0);
}

module.exports = { LSPAdapter };
