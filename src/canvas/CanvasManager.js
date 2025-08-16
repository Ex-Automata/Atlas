const vscode = require('vscode');

function createCanvasManager(context) {
  let panel = null;

  function getWebviewOptions() {
    return {
      enableScripts: true,
  retainContextWhenHidden: true,
  // Limit the webview to only load resources from the shipped web folder
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'canvas', 'web')],
    };
  }

  function open() {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return panel;
    }

    panel = vscode.window.createWebviewPanel(
      'atlas.canvas',
      'Atlas Canvas',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      getWebviewOptions()
    );

    // show a small loading placeholder while we asynchronously load the real HTML
    panel.webview.html = `<html><body style="background:transparent;color:var(--vscode-editor-foreground)">Loading Atlas Canvas…</body></html>`;

    // asynchronously build the real HTML from the shipped index.html
    buildHtmlFromIndex(panel.webview, context.extensionUri)
      .then(html => { if (panel) panel.webview.html = html; })
      .catch(err => {
        console.error('Failed to load canvas HTML', err);
      });

    panel.onDidDispose(() => {
      panel = null;
    });

    // handle messages from the webview if needed in future
    panel.webview.onDidReceiveMessage(async (msg) => {
      // handle dropped files from the webview
      if (msg && msg.type === 'fileDrop') {
        // support either single `path` or array `paths`
        const paths = Array.isArray(msg.paths) ? msg.paths : (msg.path ? [msg.path] : []);
        console.log('Canvas fileDrop debug:', { paths, rawText: msg.rawText, rawTypes: msg.rawTypes });
        if (paths.length > 0) {
          // show a visible message to the user so they can confirm drop worked
          vscode.window.showInformationMessage(`Canvas: ${paths.length} file(s) dropped. First: ${paths[0]}`);
        } else {
          // no usable paths discovered — surface this clearly
          vscode.window.showWarningMessage('Canvas: drop detected but no file path could be determined. Check webview DevTools for details.');
        }
        return;
      }
      // fallback
      console.log('canvas msg', msg);
    });

    return panel;
  }

  async function openEntrypoint(entry) {
    // Placeholder: in future this will open and focus a file or render entry-specific data
    //if (!panel) open();
    //panel.webview.postMessage({ type: 'openEntrypoint', entry: entry || null });
  }

  return {
    open,
    openEntrypoint,
  };
}

  async function buildHtmlFromIndex(webview, extensionUri) {
  // Build URIs for the webview to load local extension resources.
  const basePath = vscode.Uri.joinPath(extensionUri, 'src', 'canvas', 'web');
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(basePath, 'canvas.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(basePath, 'canvas.js'));
  const canvasUri = vscode.Uri.joinPath(basePath, 'canvas.html');

  // Content Security Policy: allow the webview source for scripts/styles
  const cspSource = webview.cspSource;

  // Read the canvas.html shipped with the extension (use vscode FS so packaged extensions work)
  const bytes = await vscode.workspace.fs.readFile(canvasUri);
  let html = Buffer.from(bytes).toString('utf8');

  // Inject CSP meta into head (if not present) and replace asset references with webview URIs
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline';">`;

  // Insert CSP right before closing </head>
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${cspMeta}\n</head>`);
  } else {
    html = cspMeta + html;
  }

  // Replace relative references (allow optional ./ and single/double quotes) with their webview URIs
  // e.g. href="canvas.css" or href='./canvas.css' or href="./canvas.css"
  html = html.replace(/href=(['"])(?:\.\/)?canvas\.css\1/g, `href="${styleUri}"`);
  html = html.replace(/src=(['"])(?:\.\/)?canvas\.js\1/g, `src="${scriptUri}"`);

  return html;
}

module.exports = { createCanvasManager };
