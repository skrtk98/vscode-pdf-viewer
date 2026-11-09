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
/** Time to wait after the last file event before reloading. */
export const RELOAD_DEBOUNCE_MS = 150;
/** Longest time to hold back a reload while file events keep arriving. */
export const RELOAD_MAX_WAIT_MS = 1000;

const EXTERNAL_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Returns `value` limited to `[min, max]`, or `fallback` when it is not a finite number.
 * Settings are user-editable JSON, so the viewer must not trust their type or range.
 */
export function clampSetting(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

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
    // that a late fallback request for an older load is discarded.
    let loadId = 0;
    // Reload scheduling (see the file watcher below). maxWaitTimer is started by the first event of
    // a burst and not reset by later ones, so the wait is bounded without relying on the wall clock.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;

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

    const promptPassword = async (id: number): Promise<void> => {
      const password = await vscode.window.showInputBox({
        prompt: 'Enter PDF password',
        password: true,
        ignoreFocusOut: true,
      });
      if (password !== undefined && !disposed) {
        await webview.postMessage({ type: 'password', loadId: id, password });
      }
    };

    const messageHandler = webview.onDidReceiveMessage(async (msg) => {
      if (disposed) return;
      switch (msg.type) {
        case 'ready': {
          const config = vscode.workspace.getConfiguration('pdfViewer');
          const defaultZoom = clampSetting(config.get('defaultZoom'), 0.1, 16, 1.0);
          const renderResolution = clampSetting(config.get('renderResolution'), 48, 384, 96);
          try {
            const message = await loadMessage();
            await webview.postMessage({ ...message, defaultZoom, renderResolution });
          } catch (e) {
            vscode.window.showErrorMessage(`PDF Viewer: Failed to read PDF: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }

        case 'fetchFailed':
          if (msg.loadId === loadId) await sendBytes(loadId);
          break;

        case 'openExternal': {
          // Link targets come from the PDF, so only hand web and mail links to the OS.
          // Other schemes (file:, ms-settings:, custom protocol handlers) could launch local programs.
          try {
            const target = typeof msg.url === 'string' ? vscode.Uri.parse(msg.url.trim(), true) : undefined;
            if (target && EXTERNAL_LINK_SCHEMES.has(target.scheme.toLowerCase())) {
              await vscode.env.openExternal(target);
            }
          } catch {
            // Malformed link URIs are ignored.
          }
          break;
        }

        case 'requestPassword':
          // The host cannot tell which load the webview currently shows (loads can arrive out of
          // order or across a webview reload), so it answers every request. The webview ignores a
          // password whose loadId is not the document it is waiting on, and a newer prompt replaces
          // an older one that is still open.
          await promptPassword(msg.loadId);
          break;

        case 'error':
          vscode.window.showErrorMessage(`PDF Viewer: ${msg.message}`);
          break;
      }
    });
    disposables.push(messageHandler);

    // Watch the PDF's directory and match the file by name: glob characters such as `[` in the
    // file name would otherwise be read as a pattern. joinPath keeps the scheme and authority,
    // so files on remote and virtual file systems are watched too.
    const fileName = path.posix.basename(document.uri.path);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*')
    );

    // Tools that write a temporary file and rename it over the PDF (Tinymist, latexmk -pvc with
    // dvipdfmx) are reported as a create, not a change. One write can also produce several events,
    // so reload once no event has arrived for RELOAD_DEBOUNCE_MS, or at least every
    // RELOAD_MAX_WAIT_MS while events keep arriving. A delete alone does not reload: the file is
    // usually recreated right after, which arrives as a create.
    const cancelReload = () => {
      clearTimeout(reloadTimer);
      clearTimeout(maxWaitTimer);
      reloadTimer = undefined;
      maxWaitTimer = undefined;
    };
    const reload = async () => {
      cancelReload();
      if (disposed) return;
      try {
        const message = await loadMessage();
        // Post even if the file changed again while a non-file PDF was being read: the snapshot is
        // still newer than what is shown, a further reload is already scheduled, and the viewer
        // ignores loads older than the latest one it has received.
        if (!disposed) await webview.postMessage(message);
      } catch (_e) {
      }
    };
    const scheduleReload = (changed: vscode.Uri) => {
      if (disposed || path.posix.basename(changed.path) !== fileName) return;
      // Invalidate the current load at once so a late fallback for it is dropped.
      loadId++;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
      maxWaitTimer ??= setTimeout(reload, RELOAD_MAX_WAIT_MS);
    };
    const onDidChange = watcher.onDidChange(scheduleReload);
    const onDidCreate = watcher.onDidCreate(scheduleReload);
    disposables.push(watcher, onDidChange, onDidCreate, { dispose: cancelReload });

    const disposeSubscription = webviewPanel.onDidDispose(() => {
      disposed = true;
      for (const d of disposables) {
        d.dispose();
      }
    });
    disposables.push(disposeSubscription);
  }
}
