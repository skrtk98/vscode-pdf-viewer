import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// vi.hoisted ensures these are available before vi.mock factories run
const {
  mockPostMessage,
  mockOpenExternal,
  mockShowInputBox,
  mockWatcherDispose,
  getOnDidChangeCb,
  setOnDidChangeCb,
  getOnDidReceiveCb,
  setOnDidReceiveCb,
  getOnDidDisposeCb,
  setOnDidDisposeCb,
} = vi.hoisted(() => {
  let _onDidChangeCb: ((uri: unknown) => void) | null = null;
  let _onDidReceiveCb: ((msg: unknown) => void) | null = null;
  let _onDidDisposeCb: (() => void) | null = null;
  return {
    mockPostMessage: vi.fn().mockResolvedValue(undefined),
    mockOpenExternal: vi.fn().mockResolvedValue(undefined),
    mockShowInputBox: vi.fn(),
    mockWatcherDispose: vi.fn(),
    getOnDidChangeCb: () => _onDidChangeCb,
    setOnDidChangeCb: (cb: ((uri: unknown) => void) | null) => { _onDidChangeCb = cb; },
    getOnDidReceiveCb: () => _onDidReceiveCb,
    setOnDidReceiveCb: (cb: ((msg: unknown) => void) | null) => { _onDidReceiveCb = cb; },
    getOnDidDisposeCb: () => _onDidDisposeCb,
    setOnDidDisposeCb: (cb: (() => void) | null) => { _onDidDisposeCb = cb; },
  };
});

vi.mock('vscode', () => {
  const mockWatcher = {
    onDidChange: (cb: (uri: unknown) => void) => {
      setOnDidChangeCb(cb);
      return { dispose: mockWatcherDispose };
    },
    dispose: mockWatcherDispose,
  };

  const mockWebview = {
    options: {} as Record<string, unknown>,
    html: '',
    cspSource: 'vscode-webview-resource:',
    asWebviewUri: (uri: { toString: () => string }) => ({
      toString: () => `vscode-resource://${uri.toString()}`,
    }),
    postMessage: mockPostMessage,
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      setOnDidReceiveCb(cb);
      return { dispose: vi.fn() };
    },
  };

  const mockWebviewPanel = {
    webview: mockWebview,
    onDidDispose: (cb: () => void) => {
      setOnDidDisposeCb(cb);
      return { dispose: vi.fn() };
    },
  };

  return {
    __esModule: true,
    workspace: {
      fs: {
        readFile: vi.fn(),
      },
      createFileSystemWatcher: vi.fn().mockReturnValue(mockWatcher),
      getConfiguration: vi.fn().mockReturnValue({
        get: (key: string, def: unknown) => def,
      }),
    },
    env: {
      openExternal: mockOpenExternal,
    },
    window: {
      showInputBox: mockShowInputBox,
      showErrorMessage: vi.fn(),
    },
    Uri: {
      joinPath: (...args: unknown[]) => {
        const parts = args.slice(1) as string[];
        const base = (args[0] as { fsPath: string }).fsPath ?? '';
        const src = args[0] as { scheme?: string; authority?: string; path?: string };
        return {
          scheme: src.scheme,
          authority: src.authority,
          path: path.posix.join(src.path ?? base, ...parts),
          fsPath: path.join(base, ...parts),
          toString: () => path.join(base, ...parts),
        };
      },
      parse: (url: string) => {
        if (/^\s|^https?:\/\/\//i.test(url)) throw new Error('malformed');
        return { scheme: url.slice(0, Math.max(0, url.indexOf(':'))), toString: () => url };
      },
      file: (p: string) => ({ fsPath: p, toString: () => p }),
    },
    RelativePattern: vi.fn(function () { return {}; }),
    mockWebviewPanel,
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (filePath: unknown, ...args: unknown[]) => {
      if (typeof filePath === 'string' && filePath.endsWith('viewer.html')) {
        return '<html><body>PDF Viewer</body></html>';
      }
      return actual.readFileSync(filePath as string, ...(args as [BufferEncoding]));
    },
    promises: {
      ...actual.promises,
      readFile: async (filePath: unknown, ...args: unknown[]) => {
        if (typeof filePath === 'string' && filePath.endsWith('viewer.html')) {
          return '<html><body>PDF Viewer</body></html>';
        }
        return actual.promises.readFile(filePath as string, ...(args as [BufferEncoding]));
      },
    },
  };
});

import { PdfEditorProvider, clampSetting } from '../src/PdfEditorProvider';
import * as vscode from 'vscode';

const makeContext = () => ({
  extensionUri: { fsPath: '/mock/extension', toString: () => '/mock/extension' },
  subscriptions: [],
});

async function setup(data: Uint8Array, scheme = 'file', authority = '') {
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
    data as unknown as Uint8Array & { buffer: ArrayBuffer }
  );

  setOnDidChangeCb(null);
  setOnDidReceiveCb(null);
  setOnDidDisposeCb(null);
  mockPostMessage.mockClear();
  mockOpenExternal.mockClear();
  mockShowInputBox.mockClear();
  vi.mocked(vscode.workspace.fs.readFile).mockClear();

  const context = makeContext();
  const provider = new PdfEditorProvider(context as unknown as vscode.ExtensionContext);
  const uri = {
    scheme,
    authority,
    fsPath: '/tmp/test.pdf',
    toString: () => '/tmp/test.pdf',
    path: '/tmp/test.pdf',
  } as unknown as vscode.Uri;

  const doc = await provider.openCustomDocument(
    uri,
    {} as vscode.CustomDocumentOpenContext,
    {} as vscode.CancellationToken
  );

  const panel = (vscode as unknown as { mockWebviewPanel: vscode.WebviewPanel }).mockWebviewPanel;
  await provider.resolveCustomEditor(doc, panel, {} as vscode.CancellationToken);

  return { provider, doc, panel };
}

async function triggerReady() {
  await getOnDidReceiveCb()?.({ type: 'ready' });
  await Promise.resolve();
  await Promise.resolve();
}

describe('TC-INT-01: load message sent on ready', () => {
  it('sends the webview URL of a file PDF with settings instead of its bytes', async () => {
    await setup(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await triggerReady();

    const call = mockPostMessage.mock.calls[0][0];
    expect(call).toMatchObject({ type: 'load', loadId: 0, url: 'vscode-resource:///tmp/test.pdf' });
    expect(call.data).toBeUndefined();
    expect(typeof call.defaultZoom).toBe('number');
    expect(typeof call.renderResolution).toBe('number');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('lets the webview read the PDF directory', async () => {
    const { panel } = await setup(new Uint8Array([1]));
    const roots = (panel.webview.options.localResourceRoots ?? []).map(String);
    expect(roots).toContain(path.join('/tmp/test.pdf', '..'));
  });

  it('sends bytes for URIs the webview cannot fetch', async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await setup(data, 'untitled');
    await triggerReady();

    const call = mockPostMessage.mock.calls[0][0];
    expect(call).toMatchObject({ type: 'load', loadId: 0, data });
    expect(call.url).toBeUndefined();
  });
});

describe('TC-INT-02: fetch failure falls back to bytes', () => {
  it('sends the file bytes after fetchFailed', async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await setup(data);
    await triggerReady();
    mockPostMessage.mockClear();

    await getOnDidReceiveCb()?.({ type: 'fetchFailed', loadId: 0 });

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'load', loadId: 0, data });
  });

  it('ignores fetchFailed for a file version that was already replaced', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    mockPostMessage.mockClear();

    await getOnDidReceiveCb()?.({ type: 'fetchFailed', loadId: 0 });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('drops fallback bytes when the file changes while they are being read', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    let finishRead!: (data: Uint8Array) => void;
    vi.mocked(vscode.workspace.fs.readFile).mockReturnValueOnce(
      new Promise(resolve => { finishRead = resolve as (data: Uint8Array) => void; }) as never
    );
    const fallback = getOnDidReceiveCb()?.({ type: 'fetchFailed', loadId: 0 });
    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    mockPostMessage.mockClear();

    finishRead(new Uint8Array([9]));
    await fallback;

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('TC-INT-03: FileSystemWatcher triggers re-load', () => {
  it('sends the URL with a new loadId when the file changes', async () => {
    await setup(new Uint8Array([1, 2, 3]));
    await triggerReady();
    mockPostMessage.mockClear();

    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'load', loadId: 1, url: 'vscode-resource:///tmp/test.pdf' });
  });

  it('sends new bytes for URIs the webview cannot fetch', async () => {
    await setup(new Uint8Array([1, 2, 3]), 'untitled');
    await triggerReady();
    mockPostMessage.mockClear();

    const dataB = new Uint8Array([4, 5, 6]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      dataB as unknown as Uint8Array & { buffer: ArrayBuffer }
    );
    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'load', loadId: 1, data: dataB });
  });
});

describe('TC-INT-04: FileSystemWatcher disposed on panel close', () => {
  it('no postMessage after dispose', async () => {
    const data = new Uint8Array([1]);
    await setup(data);
    await triggerReady();
    mockPostMessage.mockClear();

    getOnDidDisposeCb()?.();

    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('TC-INT-05: openExternal message relay', () => {
  it('calls vscode.env.openExternal', async () => {
    const data = new Uint8Array([1]);
    await setup(data);

    await getOnDidReceiveCb()?.({ type: 'openExternal', url: 'https://example.com' });
    await Promise.resolve();

    expect(mockOpenExternal).toHaveBeenCalled();
  });

  it.each(['file:///C:/Windows/System32/calc.exe', 'ms-settings:display', 'vscode://settings', 'javascript:alert(1)'])(
    'does not open %s',
    async (url) => {
      await setup(new Uint8Array([1]));
      await getOnDidReceiveCb()?.({ type: 'openExternal', url });
      await Promise.resolve();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    },
  );

  it('ignores malformed link URIs without throwing', async () => {
    await setup(new Uint8Array([1]));
    await expect(getOnDidReceiveCb()?.({ type: 'openExternal', url: 'https:////example.com' })).resolves.toBeUndefined();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('opens mailto and upper-case HTTPS links', async () => {
    await setup(new Uint8Array([1]));
    await getOnDidReceiveCb()?.({ type: 'openExternal', url: 'mailto:a@example.com' });
    await getOnDidReceiveCb()?.({ type: 'openExternal', url: 'HTTPS://example.com' });
    await Promise.resolve();
    expect(mockOpenExternal).toHaveBeenCalledTimes(2);
  });
});

describe('TC-INT-06: requestPassword → password', () => {
  it('sends only the password after showInputBox', async () => {
    const data = new Uint8Array([1, 2]);
    await setup(data);
    await triggerReady();
    mockPostMessage.mockClear();

    mockShowInputBox.mockResolvedValue('secret');
    await getOnDidReceiveCb()?.({ type: 'requestPassword', loadId: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'password', loadId: 0, password: 'secret' });
  });
});

describe('settings sent to the webview', () => {
  it('limits out-of-range and invalid settings', async () => {
    const values: Record<string, unknown> = { defaultZoom: 1000, renderResolution: 'high' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: (key: string) => values[key],
    } as unknown as vscode.WorkspaceConfiguration);
    await setup(new Uint8Array([1]));
    await triggerReady();

    const call = mockPostMessage.mock.calls[0][0];
    expect(call.defaultZoom).toBe(16);
    expect(call.renderResolution).toBe(96);
  });

  it('clampSetting keeps finite numbers within range and replaces anything else', () => {
    expect(clampSetting(1.5, 0.1, 16, 1)).toBe(1.5);
    expect(clampSetting(0, 0.1, 16, 1)).toBe(0.1);
    expect(clampSetting(-5, 48, 384, 96)).toBe(48);
    expect(clampSetting(10_000, 48, 384, 96)).toBe(384);
    expect(clampSetting(Number.NaN, 48, 384, 96)).toBe(96);
    expect(clampSetting(Infinity, 48, 384, 96)).toBe(96);
    expect(clampSetting(undefined, 48, 384, 96)).toBe(96);
    expect(clampSetting('200', 48, 384, 96)).toBe(96);
  });
});

describe('extension manifest', () => {
  it('supports Restricted Mode while ignoring workspace render resolution', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(manifest.capabilities.untrustedWorkspaces).toMatchObject({
      supported: 'limited',
      restrictedConfigurations: ['pdfViewer.renderResolution'],
    });
  });
});

describe('file watcher', () => {
  it('watches the document directory with its own scheme', async () => {
    vi.mocked(vscode.RelativePattern).mockClear();
    await setup(new Uint8Array([1]), 'memfs', 'tenant-a');
    const [base, pattern] = vi.mocked(vscode.RelativePattern).mock.calls[0] as unknown as [
      { scheme: string; authority: string; path: string },
      string,
    ];
    expect(base).toMatchObject({ scheme: 'memfs', authority: 'tenant-a', path: '/tmp' });
    expect(pattern).toBe('*');
  });

  it('reloads only when the open PDF changes, not its neighbours', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    await getOnDidChangeCb()?.({ path: '/tmp/test1.pdf' });
    await Promise.resolve();
    expect(mockPostMessage).not.toHaveBeenCalled();

    await getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });
});
