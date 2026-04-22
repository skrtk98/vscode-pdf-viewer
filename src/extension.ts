import * as vscode from 'vscode';
import { PdfEditorProvider } from './PdfEditorProvider';

/**
 * Called by VS Code when the extension is first activated.
 *
 * Registers {@link PdfEditorProvider} as a custom read-only editor for the
 * `pdfViewer.pdfEditor` view type declared in `package.json`.
 * The webview context is retained when the panel is hidden so that scroll
 * position and zoom level survive tab switches.
 *
 * @param context - The extension context supplied by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'pdfViewer.pdfEditor',
      new PdfEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );
}

/**
 * Called by VS Code when the extension is deactivated.
 *
 * No cleanup is required because all disposables are tracked via
 * `context.subscriptions` in {@link activate}.
 */
export function deactivate(): void {}
