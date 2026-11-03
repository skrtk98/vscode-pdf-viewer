import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Minimal custom document that identifies a single PDF file.
 *
 * VS Code calls {@link PdfEditorProvider.openCustomDocument} once per URI and
 * passes the resulting `PdfDocument` to every
 * {@link PdfEditorProvider.resolveCustomEditor} call for that file.
 * The bytes are not held here: the webview fetches the file itself.
 */
class PdfDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose(): void {}
}

/**
 * Custom read-only editor provider that renders PDF files inside a VS Code webview.
 *
 * Registered for the `pdfViewer.pdfEditor` view type in `package.json`.
 * Each opened PDF gets its own {@link PdfDocument} and webview panel.  The
 * provider injects viewer assets (HTML / CSS / JS / WASM) into the webview,
 * tells it where to fetch the PDF on startup, and reloads the viewer whenever
 * the underlying file changes on disk.
 */
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Wrap the PDF's URI in a {@link PdfDocument}.
   *
   * VS Code calls this once per URI before the first editor panel is created.
   *
   * @param uri - URI of the PDF file being opened.
   * @param _openContext - Unused backup/restore context.
   * @param _token - Cancellation token.
   * @returns A new `PdfDocument` for the file.
   */
  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PdfDocument> {
    return new PdfDocument(uri);
  }

  /**
   * Populate a webview panel with the PDF viewer UI.
   *
   * Injects a Content Security Policy nonce, resolves all asset URIs,
   * expands the `viewer.html` template, and sets up message handlers for:
   * - `ready` — sends `load` with the PDF's webview URL and user settings
   * - `fetchFailed` — sends `load` with the PDF bytes instead
   * - `openExternal` — opens a URI in the default browser
   * - `requestPassword` — prompts the user and sends `password`
   * - `error` — surfaces the message as a VS Code error notification
   *
   * Sending a URL rather than the bytes matters over Remote-SSH, where a large
   * `postMessage` payload stalls the extension host for minutes, while the
   * webview's resource loader streams the same file quickly.
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
    // Only file URIs can be served through asWebviewUri; other schemes get bytes.
    const fetchable = document.uri.scheme === 'file';
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ...(fetchable ? [vscode.Uri.joinPath(document.uri, '..')] : []),
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
    // Identifies the file version a message refers to. Bumped on each reload so
    // that replies to an older load (fallback bytes, passwords) are discarded.
    let loadId = 0;

    const loadMessage = async (): Promise<Record<string, unknown>> => {
      const id = loadId;
      if (fetchable) {
        return { type: 'load', loadId: id, url: webview.asWebviewUri(document.uri).toString() };
      }
      return { type: 'load', loadId: id, data: await vscode.workspace.fs.readFile(document.uri) };
    };

    const sendBytes = async (id: number): Promise<void> => {
      try {
        const data = await vscode.workspace.fs.readFile(document.uri);
        if (!disposed && id === loadId) await webview.postMessage({ type: 'load', loadId: id, data });
      } catch (e) {
        vscode.window.showErrorMessage(`PDF Viewer: Failed to read PDF: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const messageHandler = webview.onDidReceiveMessage(async (msg) => {
      if (disposed) return;
      switch (msg.type) {
        case 'ready': {
          const config = vscode.workspace.getConfiguration('pdfViewer');
          const defaultZoom = config.get<number>('defaultZoom', 1.0);
          const renderResolution = config.get<number>('renderResolution', 96);
          try {
            await webview.postMessage({ ...(await loadMessage()), defaultZoom, renderResolution });
          } catch (e) {
            vscode.window.showErrorMessage(`PDF Viewer: Failed to read PDF: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }

        case 'fetchFailed':
          if (msg.loadId === loadId) await sendBytes(loadId);
          break;

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
            await webview.postMessage({ type: 'password', loadId: msg.loadId, password });
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
      loadId++;
      try {
        await webview.postMessage(await loadMessage());
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
