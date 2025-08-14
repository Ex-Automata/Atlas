const vscode = require('vscode');
const fs = require('fs');

const STATE_KEY = 'atlas.state';

function activate(context) {
  let panel;
  let edgesCache = null; // cache import edges for related files

  async function gatherImportEdges() {
    const edges = [];
    const files = await vscode.workspace.findFiles('**/*.{js,jsx,ts,tsx}', '**/node_modules/**');
    for (const uri of files) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const re = /import\s+.*?from\s+['"](.+?)['"]|require\(\s*['"](.+?)['"]\s*\)/g;
      let m;
      while ((m = re.exec(text))) {
        const spec = (m[1] || m[2] || '').replace(/^\.\//, '');
        if (!spec || spec.startsWith('http')) continue;
        edges.push({ type: 'import', from: uri.fsPath, toSpec: spec });
      }
    }
    const fileSet = new Set(files.map(f => f.fsPath));
    edges.forEach(e => {
      if (e.toSpec.startsWith('.')) {
        const fromDir = vscode.Uri.file(e.from).path.replace(/\/[^/]+$/, '');
        const candidates = [
          `${fromDir}/${e.toSpec}`,
          `${fromDir}/${e.toSpec}.js`,
          `${fromDir}/${e.toSpec}.ts`,
          `${fromDir}/${e.toSpec}/index.js`,
          `${fromDir}/${e.toSpec}/index.ts`
        ].map(s => s.replace('file://', ''));
        e.to = candidates.find(c => fileSet.has(c)) || e.toSpec;
      } else {
        e.to = e.toSpec;
      }
    });
    return edges;
  }

  async function getEdges() {
    if (!edgesCache) edgesCache = await gatherImportEdges();
    return edgesCache;
  }

  async function referencesForSelection(editor) {
    if (!editor) return { symbol: null, refs: [] };
    const pos = editor.selection.active;
    const uri = editor.document.uri;
    try {
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos) || [];
      const wordRange = editor.document.getWordRangeAtPosition(pos);
      const symbol = wordRange ? editor.document.getText(wordRange) : null;
      return { symbol, refs: refs.map(r => ({ uri: r.uri.fsPath, range: r.range })) };
    } catch {
      return { symbol: null, refs: [] };
    }
  }

  function ensurePanel() {
    if (panel) { panel.reveal(); return panel; }
    panel = vscode.window.createWebviewPanel(
      'atlas', 'Atlas', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')]
      }
    );
    panel.onDidDispose(() => panel = undefined);
    panel.webview.html = getHtml(panel.webview, context.extensionUri);

    // Listen to messages from the Webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg && msg.type === 'openFile' && typeof msg.file === 'string') {
          const uri = msg.file.startsWith('/') ? vscode.Uri.file(msg.file.replace(/^file:\/\//, '')) : vscode.Uri.parse(msg.file);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
        } else if (msg && msg.type === 'loadFile' && typeof msg.file === 'string') {
          const uri = msg.file.startsWith('/') ? vscode.Uri.file(msg.file.replace(/^file:\/\//, '')) : vscode.Uri.parse(msg.file);
          const doc = await vscode.workspace.openTextDocument(uri);
          const content = doc.getText();
          const language = guessLanguage(uri.fsPath || msg.file);
          const edges = await getEdges();
          const relatedSet = new Set();
          edges.forEach(e => {
            if (e.from === uri.fsPath && typeof e.to === 'string' && e.to.startsWith('/')) relatedSet.add(e.to);
            if (e.to === uri.fsPath && typeof e.from === 'string' && e.from.startsWith('/')) relatedSet.add(e.from);
          });
          panel.webview.postMessage({ type: 'fileData', file: uri.fsPath || msg.file, content, language, related: Array.from(relatedSet) });
        } else if (msg && msg.type === 'refreshEdges') {
          edgesCache = await gatherImportEdges();
          panel.webview.postMessage({ type: 'edgesReady' });
        } else if (msg && msg.type === 'saveState' && msg.state) {
          await context.workspaceState.update(STATE_KEY, msg.state);
        }
      } catch (err) {
        vscode.window.showErrorMessage('Error handling message: ' + (err?.message || String(err)));
      }
    });

    // Show empty canvas and attempt restore
    setTimeout(() => {
      panel?.webview.postMessage({ type: 'init' });
      const saved = context.workspaceState.get(STATE_KEY);
      if (saved) panel?.webview.postMessage({ type: 'restore', state: saved });
    }, 0);

    return panel;
  }

  function guessLanguage(filePath) {
    const lower = (filePath || '').toLowerCase();
    if (lower.endsWith('.py')) return 'python';
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
    if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.css')) return 'css';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
    return 'plaintext';
  }

  async function refreshGraph() {
    const p = ensurePanel();
    p.webview.postMessage({ type: 'init' });
    const saved = context.workspaceState.get(STATE_KEY);
    if (saved) p.webview.postMessage({ type: 'restore', state: saved });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('atlas.open', () => ensurePanel())
  );

  vscode.window.onDidChangeTextEditorSelection(async () => {
    // Reserved for future focus features; no-op for canvas mode
  });
}

function getHtml(webview, extensionUri) {
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'canvas.html');
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'main.js'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'canvas.css'));
  const csp = webview.cspSource;
  let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
  // Inject cspSource in meta tag and allow webview resources
  html = html
    .replace("script-src 'unsafe-inline' 'unsafe-eval' https:", "script-src 'unsafe-inline' 'unsafe-eval' " + csp + " https:")
    .replace("style-src 'unsafe-inline' https:", "style-src 'unsafe-inline' " + csp + " https:")
    .replace('img-src https: data:', 'img-src ' + csp + ' https: data:')
    .replace('font-src https: data:', 'font-src ' + csp + ' https: data:')
    .replace('connect-src https:', 'connect-src ' + csp + ' https:');
  // Point resources to webview URIs
  html = html.replace('<script src="./main.js"></script>', '<script src="' + mainJsUri.toString() + '"></script>');
  html = html.replace('<link rel="stylesheet" href="./canvas.css" />', '<link rel="stylesheet" href="' + cssUri.toString() + '" />');
  return html;
}

function deactivate() {}

module.exports = { activate, deactivate };
