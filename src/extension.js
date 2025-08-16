const vscode = require('vscode');
const { createCanvasManager } = require('./canvas/CanvasManager');

const STATE_KEY = 'atlas.state';

function activate(context) {
  function addToStatusBar() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = '$(graph) Atlas';
    item.tooltip = 'Open Atlas';
    item.command = 'atlas.open';
    item.show();
    context.subscriptions.push(item);

    // optional: reflect selection
    vscode.window.onDidChangeTextEditorSelection(e => {
      const word = e.textEditor?.document.getText(e.textEditor.selection) || '';
      item.text = word ? `$(graph) Atlas: ${word}` : '$(graph) Atlas';
    });
  }
  addToStatusBar();

  // Delegate canvas responsibilities to the CanvasManager
  const canvas = createCanvasManager(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('atlas.open', async () => {
      canvas.open();
      try {
        const entry = await detectEntrypoint();
        if (entry) {
          await canvas.openEntrypoint(entry);
        }
      } catch (e) {
        console.warn('Atlas entrypoint detection failed:', e?.message || e);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('atlas.open.empty', async () => {
      canvas.open();
    })
  );

  // Send selected resource(s) to the canvas
  context.subscriptions.push(
    vscode.commands.registerCommand('atlas.sendToCanvas', async (uri, uris) => {
      // VS Code passes a single URI or a list depending on source; normalize
      let list = [];
      if (uris && Array.isArray(uris)) list = uris;
      else if (uri) list = [uri];
      else if (vscode.window.activeTextEditor) list = [vscode.window.activeTextEditor.document.uri];

      if (!list.length) {
        vscode.window.showWarningMessage('Atlas: No resource to send to canvas.');
        return;
      }

      // Ensure canvas is open
      const panel = canvas.open();

      // Post to webview and also log visibly
      const paths = list.map(u => u.fsPath || u.path || String(u));
      console.log('Atlas sendToCanvas:', paths);
      vscode.window.showInformationMessage(`Atlas: sent ${paths.length} item(s) to canvas. First: ${paths[0]}`);
      panel.webview.postMessage({ type: 'sendToCanvas', paths });
    })
  );

  vscode.window.onDidChangeTextEditorSelection(async () => {
    // Reserved for future focus features; no-op for canvas mode
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

async function detectEntrypoint() {
  const pkgFiles = ['package.json', 'tsconfig.json', 'jsconfig.json'];
  const candidates = [];
  for (const f of pkgFiles) {
      const files = await vscode.workspace.findFiles(`**/${f}`, '**/node_modules/**');
      if (files.length) candidates.push(...files);
  }
  if (candidates.length === 0) return;

  // Pick the shallowest path
  const rootPkg = candidates.sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length
  )[0];

  const pkgContent = await vscode.workspace.fs.readFile(rootPkg);
  const pkgJson = JSON.parse(Buffer.from(pkgContent).toString('utf8'));

  // Actually find entry file.
  let entry =
    pkgJson.main ||
    (pkgJson.exports && pkgJson.exports['.']) ||
    pkgJson.module ||
    null;

  if (typeof entry === 'object' && entry.default) {
    entry = entry.default;
  }

  if (entry) {
    return vscode.Uri.joinPath(rootPkg.with({ path: rootPkg.path.replace(/package\.json$/, '') }), entry);
  }

  return null;
}