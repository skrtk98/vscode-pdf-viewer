import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

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
    asWebviewUri: (uri: { fsPath?: string; toString: () => string }) => ({
      toString: () => `vscode-resource://${uri.fsPath ?? uri.toString()}`,
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
        return {
          fsPath: path.join(base, ...parts),
          toString: () => path.join(base, ...parts),
        };
      },
      parse: (url: string) => ({ toString: () => url }),
      file: (p: string) => ({ fsPath: p, toString: () => p }),
    },
    RelativePattern: vi.fn().mockReturnValue({}),
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

import { PdfEditorProvider } from '../src/PdfEditorProvider';
import * as vscode from 'vscode';

const makeContext = () => ({
  extensionUri: { fsPath: '/mock/extension', toString: () => '/mock/extension' },
  subscriptions: [],
});

async function setup(data: Uint8Array) {
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
    data as unknown as Uint8Array & { buffer: ArrayBuffer }
  );

  setOnDidChangeCb(null);
  setOnDidReceiveCb(null);
  setOnDidDisposeCb(null);
  mockPostMessage.mockClear();
  mockOpenExternal.mockClear();
  mockShowInputBox.mockClear();

  const context = makeContext();
  const provider = new PdfEditorProvider(context as unknown as vscode.ExtensionContext);
  const uri = {
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

  return { provider, doc };
}

async function triggerReady() {
  await getOnDidReceiveCb()?.({ type: 'ready' });
  await Promise.resolve();
  await Promise.resolve();
}

describe('TC-INT-01: load message sent on ready', () => {
  it('sends load message with correct data and settings', async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await setup(data);
    await triggerReady();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'load', data: expect.any(Uint8Array) })
    );
    const call = mockPostMessage.mock.calls[0][0];
    expect(call.data).toEqual(data);
    expect(typeof call.defaultZoom).toBe('number');
    expect(typeof call.renderResolution).toBe('number');
  });
});

describe('TC-INT-02: load message is a copy (not transferred)', () => {
  it('document data is still intact after postMessage', async () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { doc } = await setup(data);
    await triggerReady();

    expect(doc.data.byteLength).toBe(4);
  });
});

describe('TC-INT-03: FileSystemWatcher triggers re-load', () => {
  it('sends new data when file changes', async () => {
    const dataA = new Uint8Array([1, 2, 3]);
    await setup(dataA);
    await triggerReady();
    mockPostMessage.mockClear();

    const dataB = new Uint8Array([4, 5, 6]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
      dataB as unknown as Uint8Array & { buffer: ArrayBuffer }
    );
    await getOnDidChangeCb()?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'load', data: dataB })
    );
    expect(mockPostMessage.mock.calls[0][0].data).not.toEqual(dataA);
  });
});

describe('TC-INT-04: FileSystemWatcher disposed on panel close', () => {
  it('no postMessage after dispose', async () => {
    const data = new Uint8Array([1]);
    await setup(data);
    await triggerReady();
    mockPostMessage.mockClear();

    getOnDidDisposeCb()?.();

    await getOnDidChangeCb()?.({});
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
});

describe('TC-INT-06: requestPassword → load with password', () => {
  it('sends load with password after showInputBox', async () => {
    const data = new Uint8Array([1, 2]);
    await setup(data);
    await triggerReady();
    mockPostMessage.mockClear();

    mockShowInputBox.mockResolvedValue('secret');
    await getOnDidReceiveCb()?.({ type: 'requestPassword' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'load', password: 'secret' })
    );
  });
});
