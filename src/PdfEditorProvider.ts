import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Minimal custom document that holds the raw PDF bytes for a single file.
 *
 * VS Code calls {@link PdfEditorProvider.openCustomDocument} once per URI and
 * passes the resulting `PdfDocument` to every
 * {@link PdfEditorProvider.resolveCustomEditor} call for that file.
 */
class PdfDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  /** Raw bytes of the PDF file; updated in place when the file changes on disk. */
  data: Uint8Array;

  constructor(uri: vscode.Uri, data: Uint8Array) {
    this.uri = uri;
    this.data = data;
  }

  dispose(): void {}
}

/**
 * Custom read-only editor provider that renders PDF files inside a VS Code webview.
 *
 * Registered for the `pdfViewer.pdfEditor` view type in `package.json`.
 * Each opened PDF gets its own {@link PdfDocument} and webview panel.  The
 * provider injects viewer assets (HTML / CSS / JS / WASM) into the webview,
 * forwards the PDF bytes on startup, and reloads the viewer whenever the
 * underlying file changes on disk.
 */
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Read the PDF from disk and wrap it in a {@link PdfDocument}.
   *
   * VS Code calls this once per URI before the first editor panel is created.
   *
   * @param uri - URI of the PDF file being opened.
   * @param _openContext - Unused backup/restore context.
   * @param _token - Cancellation token.
   * @returns A new `PdfDocument` containing the file's raw bytes.
   */
  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PdfDocument> {
    const data = await vscode.workspace.fs.readFile(uri);
    return new PdfDocument(uri, data);
  }

  /**
   * Populate a webview panel with the PDF viewer UI.
   *
   * Injects a Content Security Policy nonce, resolves all asset URIs,
   * expands the `viewer.html` template, and sets up message handlers for:
   * - `ready` — sends `load` with PDF bytes and user settings
   * - `openExternal` — opens a URI in the default browser
   * - `requestPassword` — prompts the user and resends `load` with the password
   * - `error` — surfaces the message as a VS Code error notification
   *
   * Also creates a file-system watcher that reloads the viewer whenever the
   * PDF file is modified on disk (e.g. after a LaTeX recompile).
   *
   * @param document - The {@link PdfDocument} produced by {@link openCustomDocument}.
   * @param webviewPanel - The webview panel to populate.
   * @param _token - Cancellation token.
   */
  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const nonce = crypto.randomBytes(16).toString('base64');
    const cspSrc = webview.cspSource;
    const wasmUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'mupdf.wasm')).toString();
    const mupdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'mupdf.js')).toString();
    const viewerUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'viewer.js')).toString();
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'worker.js')).toString();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'viewer.css')).toString();

    const templatePath = vscode.Uri.joinPath(mediaPath, 'viewer.html').fsPath;
    const template = await fs.promises.readFile(templatePath, 'utf8');
    const html = template
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cspSrc\}/g, cspSrc)
      .replace(/\$\{wasmUri\}/g, wasmUri)
      .replace(/\$\{mupdfJsUri\}/g, mupdfJsUri)
      .replace(/\$\{viewerUri\}/g, viewerUri)
      .replace(/\$\{workerUri\}/g, workerUri)
      .replace(/\$\{cssUri\}/g, cssUri);

    webview.html = html;

    const disposables: vscode.Disposable[] = [];
    let disposed = false;

    const messageHandler = webview.onDidReceiveMessage(async (msg) => {
      if (disposed) return;
      switch (msg.type) {
        case 'ready': {
          const config = vscode.workspace.getConfiguration('pdfViewer');
          const defaultZoom = config.get<number>('defaultZoom', 1.0);
          const renderResolution = config.get<number>('renderResolution', 96);
          await webview.postMessage({
            type: 'load',
            data: document.data,
            defaultZoom,
            renderResolution,
          });
          break;
        }

        case 'openExternal':
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;

        case 'requestPassword': {
          const password = await vscode.window.showInputBox({
            prompt: 'Enter PDF password',
            password: true,
            ignoreFocusOut: true,
          });
          if (password !== undefined) {
            await webview.postMessage({ type: 'load', data: document.data, password });
          }
          break;
        }

        case 'error':
          vscode.window.showErrorMessage(`PDF Viewer: ${msg.message}`);
          break;
      }
    });
    disposables.push(messageHandler);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        path.basename(document.uri.fsPath)
      )
    );

    const onDidChange = watcher.onDidChange(async () => {
      if (disposed) return;
      try {
        const newData = await vscode.workspace.fs.readFile(document.uri);
        document.data = newData;
        await webview.postMessage({ type: 'load', data: newData });
      } catch (_e) {
      }
    });
    disposables.push(watcher, onDidChange);

    const disposeSubscription = webviewPanel.onDidDispose(() => {
      disposed = true;
      for (const d of disposables) {
        d.dispose();
      }
    });
    disposables.push(disposeSubscription);
  }
}
