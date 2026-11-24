import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { parseSyncTex, syncTexLookup, sourcePathCandidates, SyncTexData } from './synctex';

const gunzip = promisify(zlib.gunzip);
/** Largest SyncTeX file read, compressed or not; a long book is a few tens of megabytes. */
const MAX_SYNCTEX_BYTES = 256 * 1024 * 1024;
/** pdfTeX writes the SyncTeX file just after the PDF; allow for that and for coarse timestamps. */
const SYNCTEX_NEWER_TOLERANCE_MS = 2000;
/** How long after the SyncTeX file changes a newer SyncTeX file is taken to mean a build in progress. */
const BUILD_IN_PROGRESS_MS = 30_000;

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
   * - `syncTexInverse` — opens the TeX source line at a page position (Ctrl+click)
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
    const fileName = path.posix.basename(document.uri.path);
    // Parsed SyncTeX data, reused until the file's modification time or size changes.
    let syncTex: { key: string; data: Promise<SyncTexData> } | undefined;

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

    const loadSyncTex = async (): Promise<{ data: SyncTexData; mtime: number } | undefined> => {
      // TeX names the file after the job, which is also the PDF's name.
      const base = fileName.replace(/\.pdf$/i, '');
      let found: { uri: vscode.Uri; stat: vscode.FileStat } | undefined;
      for (const name of [`${base}.synctex.gz`, `${base}.synctex`]) {
        const uri = vscode.Uri.joinPath(document.uri, '..', name);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!found || stat.mtime > found.stat.mtime) found = { uri, stat };
        } catch {
          // Not present.
        }
      }
      if (!found) return undefined;
      const { uri, stat } = found;
      const key = `${uri.toString()}|${stat.mtime}|${stat.size}`;
      if (syncTex?.key !== key) {
        const data = (async () => {
          if (stat.size > MAX_SYNCTEX_BYTES) throw new Error(`${path.posix.basename(uri.path)} is too large.`);
          const raw = await vscode.workspace.fs.readFile(uri);
          const bytes = uri.path.endsWith('.gz')
            ? await gunzip(raw, { maxOutputLength: MAX_SYNCTEX_BYTES })
            : Buffer.from(raw);
          return parseSyncTex(bytes.toString('utf8'));
        })();
        syncTex = { key, data };
        data.catch(() => {
          if (syncTex?.data === data) syncTex = undefined;
        });
      }
      return { data: await syncTex!.data, mtime: stat.mtime };
    };

    const findSource = async (recorded: string): Promise<vscode.Uri | undefined> => {
      const local = document.uri.scheme === 'file';
      const api = local ? path : path.posix;
      const toPath = (uri: vscode.Uri) => local ? uri.fsPath : uri.path;
      const pdfDir = api.dirname(toPath(document.uri));
      // TeX may have run in a parent of the PDF's directory (an output directory such as build/),
      // so also try each parent up to the workspace folder.
      const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
      const roots: string[] = [];
      const root = folder ? toPath(folder.uri) : undefined;
      if (root !== undefined) {
        const relative = api.relative(root, pdfDir);
        if (relative && !relative.startsWith('..') && !api.isAbsolute(relative)) {
          for (let dir = api.dirname(pdfDir); ; dir = api.dirname(dir)) {
            roots.push(dir);
            if (dir === root || api.dirname(dir) === dir) break;
          }
        }
      }
      const workspaces = (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === document.uri.scheme && f.uri.authority === document.uri.authority)
        .map((f) => toPath(f.uri));
      for (const candidate of sourcePathCandidates(recorded, pdfDir, api, roots, workspaces)) {
        // Keep the query and fragment: some virtual file systems use them to select a version.
        const uri = local ? vscode.Uri.file(candidate) : document.uri.with({ path: candidate });
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type & vscode.FileType.File) return uri;
        } catch {
          // Try the next candidate.
        }
      }
      return undefined;
    };

    // Only the latest Ctrl+click opens a file, even if an earlier one finishes reading later.
    let syncRequest = 0;
    const syncTexInverse = async (msg: Record<string, unknown>): Promise<void> => {
      const { page, x, y } = msg;
      // The click was on a PDF that has since changed on disk; its position may not match the new
      // SyncTeX data, and the viewer is about to show the new file.
      if (msg.loadId !== loadId) return;
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 ||
          typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        return;
      }
      const request = ++syncRequest;
      // A reload of the PDF (loadId changes) also makes the request stale: the lines may have moved.
      const requestLoad = loadId;
      const current = () => !disposed && request === syncRequest && requestLoad === loadId;
      try {
        const synced = await loadSyncTex();
        if (!current()) return;
        if (!synced) {
          // Without SyncTeX data, Ctrl+click on a link behaves like a plain click.
          if (msg.link === true) {
            await webview.postMessage({ type: 'followLink', token: msg.token });
            return;
          }
          vscode.window.showInformationMessage(
            `MuPDF Viewer: No SyncTeX data found for ${fileName}. Compile with SyncTeX enabled ` +
            '(for example, pdflatex -synctex=1) to jump to the source with Ctrl+click.'
          );
          return;
        }
        // With a DVI build (pLaTeX, upLaTeX), TeX writes the SyncTeX file before dvipdfmx writes
        // the PDF. A SyncTeX file clearly newer than the PDF and written moments ago most likely
        // belongs to a build still in progress. Files copied without their timestamps can also be
        // out of order, so the check only applies for a short time after the SyncTeX file changes.
        // A modification time in the future means the file system's clock is ahead of this one;
        // the age is then unknown, so the check is skipped instead of blocking until the clocks meet.
        const pdfMtime = await vscode.workspace.fs.stat(document.uri).then((stat) => stat.mtime, () => undefined);
        if (!current()) return;
        const syncTexAge = Date.now() - synced.mtime;
        if (pdfMtime !== undefined && synced.mtime > pdfMtime + SYNCTEX_NEWER_TOLERANCE_MS &&
            syncTexAge >= 0 && syncTexAge < BUILD_IN_PROGRESS_MS) {
          vscode.window.showInformationMessage(
            'MuPDF Viewer: The SyncTeX data is newer than the PDF. Try again when the build has finished.'
          );
          return;
        }
        const location = syncTexLookup(synced.data, page, x, y, { cjk: msg.cjk === true });
        if (!location) {
          vscode.window.showInformationMessage('MuPDF Viewer: No source location found at this point.');
          return;
        }
        const target = await findSource(location.file);
        if (!current()) return;
        if (!target) {
          vscode.window.showWarningMessage(`MuPDF Viewer: Source file not found: ${location.file}`);
          return;
        }
        // Open the document first: loading it can take a while, and a newer click may finish meanwhile.
        const source = await vscode.workspace.openTextDocument(target);
        if (!current()) return;
        // Text at the end of a paragraph can be recorded with the blank line that ends it.
        let line = Math.min(Math.max(location.line - 1, 0), Math.max(source.lineCount - 1, 0));
        if (source.lineAt(line).isEmptyOrWhitespace) {
          for (let previous = line - 1; previous >= 0 && line - previous <= 3; previous--) {
            if (!source.lineAt(previous).isEmptyOrWhitespace) {
              line = previous;
              break;
            }
          }
        }
        const position = new vscode.Position(line, 0);
        // Prefer the group that already shows the file, then any other group with a text editor,
        // so the source opens beside the PDF instead of replacing it.
        const visible = vscode.window.visibleTextEditors;
        const viewColumn =
          visible.find((e) => e.document.uri.toString() === target.toString())?.viewColumn ??
          visible.find((e) => e.viewColumn !== undefined && e.viewColumn !== webviewPanel.viewColumn)?.viewColumn ??
          vscode.ViewColumn.Beside;
        await vscode.window.showTextDocument(source, { viewColumn, selection: new vscode.Range(position, position) });
      } catch (e) {
        if (current()) {
          vscode.window.showErrorMessage(`MuPDF Viewer: Failed to jump to the source: ${e instanceof Error ? e.message : String(e)}`);
        }
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

        case 'syncTexInverse':
          await syncTexInverse(msg);
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
