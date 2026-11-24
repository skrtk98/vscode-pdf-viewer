import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  getOnDidCreateCb,
  setOnDidCreateCb,
  getOnDidReceiveCb,
  setOnDidReceiveCb,
  getOnDidDisposeCb,
  setOnDidDisposeCb,
} = vi.hoisted(() => {
  let _onDidChangeCb: ((uri: unknown) => void) | null = null;
  let _onDidCreateCb: ((uri: unknown) => void) | null = null;
  let _onDidReceiveCb: ((msg: unknown) => void) | null = null;
  let _onDidDisposeCb: (() => void) | null = null;
  return {
    mockPostMessage: vi.fn().mockResolvedValue(undefined),
    mockOpenExternal: vi.fn().mockResolvedValue(undefined),
    mockShowInputBox: vi.fn(),
    mockWatcherDispose: vi.fn(),
    getOnDidChangeCb: () => _onDidChangeCb,
    setOnDidChangeCb: (cb: ((uri: unknown) => void) | null) => { _onDidChangeCb = cb; },
    getOnDidCreateCb: () => _onDidCreateCb,
    setOnDidCreateCb: (cb: ((uri: unknown) => void) | null) => { _onDidCreateCb = cb; },
    getOnDidReceiveCb: () => _onDidReceiveCb,
    setOnDidReceiveCb: (cb: ((msg: unknown) => void) | null) => { _onDidReceiveCb = cb; },
    getOnDidDisposeCb: () => _onDidDisposeCb,
    setOnDidDisposeCb: (cb: (() => void) | null) => { _onDidDisposeCb = cb; },
  };
});

/** A text document backed by the real file, with the members the provider uses. */
function textDocument(uri: { fsPath: string }) {
  const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
  return { uri, lineCount: lines.length, lineAt: (i: number) => ({ isEmptyOrWhitespace: lines[i].trim() === '' }) };
}

vi.mock('vscode', () => {
  const mockWatcher = {
    onDidChange: (cb: (uri: unknown) => void) => {
      setOnDidChangeCb(cb);
      return { dispose: mockWatcherDispose };
    },
    onDidCreate: (cb: (uri: unknown) => void) => {
      setOnDidCreateCb(cb);
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
        stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
      },
      openTextDocument: vi.fn(async (uri: { fsPath: string }) => textDocument(uri)),
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
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showTextDocument: vi.fn().mockResolvedValue(undefined),
      visibleTextEditors: [] as unknown[],
    },
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    ViewColumn: { Beside: -2 },
    FileType: { File: 1, Directory: 2 },
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
      file: (p: string) => ({ scheme: 'file', path: p, fsPath: p, toString: () => p }),
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

import { PdfEditorProvider, clampSetting, RELOAD_DEBOUNCE_MS, RELOAD_MAX_WAIT_MS } from '../src/PdfEditorProvider';
import * as vscode from 'vscode';

const makeContext = () => ({
  extensionUri: { fsPath: '/mock/extension', toString: () => '/mock/extension' },
  subscriptions: [],
});

async function setup(data: Uint8Array, scheme = 'file', authority = '', pdfPath = '/tmp/test.pdf') {
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
    data as unknown as Uint8Array & { buffer: ArrayBuffer }
  );

  setOnDidChangeCb(null);
  setOnDidCreateCb(null);
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
    fsPath: pdfPath,
    toString: () => pdfPath,
    path: pdfPath,
    with(change: { path: string }) { return { scheme, authority, path: change.path, fsPath: change.path, toString: () => `${scheme}://${authority}${change.path}` }; },
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

/** Fires a watcher event for `filePath` and waits until the debounced reload has run. */
async function fileEvent(kind: 'change' | 'create', filePath = '/tmp/test.pdf', wait = RELOAD_DEBOUNCE_MS) {
  vi.useFakeTimers();
  try {
    (kind === 'change' ? getOnDidChangeCb() : getOnDidCreateCb())?.({ path: filePath });
    await vi.advanceTimersByTimeAsync(wait);
  } finally {
    vi.useRealTimers();
  }
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
    await fileEvent('change');
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
    await fileEvent('change');
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

    await fileEvent('change');
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
    await fileEvent('change');
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

    await fileEvent('change');
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

  it('answers a request for an older load with its own loadId, leaving the check to the webview', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockShowInputBox.mockResolvedValue('secret');
    await fileEvent('change');
    mockPostMessage.mockClear();

    await getOnDidReceiveCb()?.({ type: 'requestPassword', loadId: 0 });

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'password', loadId: 0, password: 'secret' });
  });

  it('does not send a password after the editor is closed', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    let answer!: (value: string) => void;
    mockShowInputBox.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const reply = getOnDidReceiveCb()?.({ type: 'requestPassword', loadId: 0 });
    getOnDidDisposeCb()?.();
    mockPostMessage.mockClear();

    answer('secret');
    await reply;

    expect(mockPostMessage).not.toHaveBeenCalled();
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

    await fileEvent('change', '/tmp/test1.pdf');
    await Promise.resolve();
    expect(mockPostMessage).not.toHaveBeenCalled();

    await fileEvent('change');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });
});

describe('reload on replaced files', () => {
  it('reloads when the PDF is replaced by renaming a temporary file over it', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    await fileEvent('create');

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load', loadId: 1 }));
  });

  it('ignores creates of other files in the directory', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    await fileEvent('create', '/tmp/.test.pdf.tmp123');

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('reloads once for a burst of create and change events', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    vi.useFakeTimers();
    try {
      getOnDidCreateCb()?.({ path: '/tmp/test.pdf' });
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS - 50);
      getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS - 50);
      getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS - 1);
      expect(mockPostMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'load', loadId: 3 }));
  });

  it('rejects a fallback for the old version while the reload is still waiting', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    vi.useFakeTimers();
    try {
      getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
      mockPostMessage.mockClear();
      await getOnDidReceiveCb()?.({ type: 'fetchFailed', loadId: 0 });
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reloads at least every RELOAD_MAX_WAIT_MS while events keep arriving', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    vi.useFakeTimers();
    try {
      for (let t = 0; t < 3 * RELOAD_MAX_WAIT_MS; t += 100) {
        getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
        await vi.advanceTimersByTimeAsync(100);
      }
      const duringBurst = mockPostMessage.mock.calls.length;
      expect(duringBurst).toBeGreaterThanOrEqual(2);
      expect(duringBurst).toBeLessThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
    } finally {
      vi.useRealTimers();
    }
    const last = mockPostMessage.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ type: 'load', loadId: 30 });
  });

  it('keeps showing new snapshots of a slow non-file PDF while events keep arriving', async () => {
    await setup(new Uint8Array([1]), 'memfs');
    await triggerReady();
    mockPostMessage.mockClear();
    vi.useFakeTimers();
    try {
      vi.mocked(vscode.workspace.fs.readFile).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(new Uint8Array([7]) as never), 200)) as never
      );
      for (let t = 0; t < 5000; t += 100) {
        getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
        await vi.advanceTimersByTimeAsync(100);
      }
    } finally {
      vi.useRealTimers();
      vi.mocked(vscode.workspace.fs.readFile).mockReset();
    }
    expect(mockPostMessage.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('bounds the wait even if the system clock goes back', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();
    vi.useFakeTimers();
    try {
      getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
      vi.setSystemTime(Date.now() - 60 * 60 * 1000);
      for (let t = 0; t < RELOAD_MAX_WAIT_MS + 100; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        getOnDidChangeCb()?.({ path: '/tmp/test.pdf' });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(mockPostMessage).toHaveBeenCalled();
  });

  it('clears the pending reload timer when the editor is closed', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    vi.useFakeTimers();
    try {
      getOnDidCreateCb()?.({ path: '/tmp/test.pdf' });
      expect(vi.getTimerCount()).toBe(2);
      getOnDidDisposeCb()?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not post bytes read for a non-file PDF after the editor is closed', async () => {
    await setup(new Uint8Array([1]), 'memfs');
    await triggerReady();
    let finishRead!: (data: Uint8Array) => void;
    vi.mocked(vscode.workspace.fs.readFile).mockReturnValueOnce(
      new Promise(resolve => { finishRead = resolve as (data: Uint8Array) => void; }) as never
    );
    await fileEvent('create');
    mockPostMessage.mockClear();
    getOnDidDisposeCb()?.();

    finishRead(new Uint8Array([9]));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('does not reload after the editor is closed during the wait', async () => {
    await setup(new Uint8Array([1]));
    await triggerReady();
    mockPostMessage.mockClear();

    vi.useFakeTimers();
    try {
      getOnDidCreateCb()?.({ path: '/tmp/test.pdf' });
      getOnDidDisposeCb()?.();
      await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS * 2);
    } finally {
      vi.useRealTimers();
    }

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('SyncTeX inverse search', () => {
  const fixture = path.resolve('test/fixtures/synctex');
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A copy of the fixture project in a fresh directory, served through the mocked workspace.fs. */
  async function project(files: Record<string, string> = {
    'main.synctex.gz': 'main.synctex.gz', 'main.tex': 'main.tex', 'chapters/part.tex': 'chapters/part.tex',
  }, pdf = 'main.pdf') {
    dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'synctex-'));
    fs.mkdirSync(path.join(dir, 'chapters'));
    fs.mkdirSync(path.join(dir, 'build'));
    for (const [to, from] of Object.entries(files)) fs.copyFileSync(path.join(fixture, from), path.join(dir, to));
    // The PDF is written after its SyncTeX file, as dvipdfmx does.
    fs.copyFileSync(path.join(fixture, 'main.pdf'), path.join(dir, pdf));
    const real = (uri: { fsPath?: string; path: string }) => uri.fsPath ?? uri.path;
    await setup(new Uint8Array([1]), 'file', '', path.join(dir, pdf));
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri) => {
      const stat = fs.statSync(real(uri as never));
      return { type: stat.isFile() ? 1 : 2, mtime: stat.mtimeMs, ctime: 0, size: stat.size } as vscode.FileStat;
    });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri) => fs.readFileSync(real(uri as never)));
    vi.mocked(vscode.window.showTextDocument).mockClear();
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  }

  const click = (page: number, x: number, y: number) =>
    getOnDidReceiveCb()?.({ type: 'syncTexInverse', loadId: 0, page, x, y });

  it('opens the source line found next to the PDF, resolving paths recorded on another machine', async () => {
    await project();
    // The word "sentence" on page 1 comes from line 2 of chapters/part.tex.
    await click(1, 120, 270);
    const [source, options] = vi.mocked(vscode.window.showTextDocument).mock.calls[0] as unknown as
      [{ uri: { fsPath: string } }, { viewColumn: number; selection: { start: { line: number } } }];
    expect(source.uri.fsPath).toBe(path.join(dir, 'chapters', 'part.tex'));
    expect(options.selection.start.line).toBe(1);
    expect(options.viewColumn).toBe(vscode.ViewColumn.Beside);
  });

  it('opens the source in the editor group that already shows it', async () => {
    await project();
    (vscode.window as { visibleTextEditors: unknown[] }).visibleTextEditors = [
      { document: { uri: { toString: () => 'other.tex' } }, viewColumn: 3 },
      { document: { uri: { toString: () => path.join(dir, 'main.tex') } }, viewColumn: 1 },
    ];
    try {
      await click(1, 300, 157);
      const options = vi.mocked(vscode.window.showTextDocument).mock.calls[0][1] as { viewColumn: number };
      expect(options.viewColumn).toBe(1);
    } finally {
      (vscode.window as { visibleTextEditors: unknown[] }).visibleTextEditors = [];
    }
  });

  it('reads an uncompressed .synctex file and reuses the parsed data', async () => {
    await project({ 'main.tex': 'main.tex' });
    fs.writeFileSync(path.join(dir, 'main.synctex'), require('zlib').gunzipSync(fs.readFileSync(path.join(fixture, 'main.synctex.gz'))));
    await click(1, 300, 157);
    await click(1, 300, 157);
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(2);
    const reads = vi.mocked(vscode.workspace.fs.readFile).mock.calls.filter(([uri]) => (uri as { path: string }).path.includes('synctex'));
    expect(reads).toHaveLength(1);
  });

  it('explains how to enable SyncTeX when there is no data', async () => {
    await project({});
    await click(1, 300, 157);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('-synctex=1'));
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('warns when the recorded source file cannot be found', async () => {
    await project({ 'main.synctex.gz': 'main.synctex.gz' });
    await click(1, 300, 157);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('/work/./main.tex'));
  });

  it('asks the viewer to follow the link when there is no SyncTeX data', async () => {
    await project({});
    mockPostMessage.mockClear();
    await getOnDidReceiveCb()?.({ type: 'syncTexInverse', loadId: 0, page: 1, x: 300, y: 157, link: true, token: 7 });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'followLink', token: 7 });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('opens only the latest request when an earlier read finishes later', async () => {
    await project();
    const readFile = vi.mocked(vscode.workspace.fs.readFile);
    const real = readFile.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    readFile.mockImplementationOnce(async (uri) => { await gate; return real(uri); });
    const first = click(1, 120, 270);
    // Let the first request reach the read before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = click(1, 300, 157);
    release();
    await Promise.all([first, second]);
    const targets = vi.mocked(vscode.window.showTextDocument).mock.calls.map(([doc]) => (doc as unknown as { uri: { fsPath: string } }).uri.fsPath);
    expect(targets).toEqual([path.join(dir, 'main.tex')]);
  });

  it('shows only the latest request when an earlier source document loads later', async () => {
    await project();
    const open = vi.mocked(vscode.workspace.openTextDocument);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    open.mockImplementationOnce(async (uri: unknown) => { await gate; return textDocument(uri as { fsPath: string }) as never; });
    const first = click(1, 120, 270);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await click(1, 300, 157);
    release();
    await first;
    const targets = vi.mocked(vscode.window.showTextDocument).mock.calls.map(([doc]) => (doc as unknown as { uri: { fsPath: string } }).uri.fsPath);
    expect(targets).toEqual([path.join(dir, 'main.tex')]);
  });

  it('finds sources in a parent of an output directory inside the workspace', async () => {
    await project({ 'build/main.synctex.gz': 'main.synctex.gz', 'main.tex': 'main.tex' }, 'build/main.pdf');
    const getFolder = vi.fn(() => ({ uri: { fsPath: path.dirname(dir), path: path.dirname(dir) } }));
    (vscode.workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder = getFolder;
    try {
      await click(1, 300, 157);
      const [doc] = vi.mocked(vscode.window.showTextDocument).mock.calls[0] as unknown as [{ uri: { fsPath: string } }];
      expect(doc.uri.fsPath).toBe(path.join(dir, 'main.tex'));
    } finally {
      delete (vscode.workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder;
    }
  });

  it('does not open the source when the PDF is reloaded while the request is pending', async () => {
    await project();
    const open = vi.mocked(vscode.workspace.openTextDocument);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    open.mockImplementationOnce(async (uri: unknown) => { await gate; return textDocument(uri as { fsPath: string }) as never; });
    const pending = click(1, 300, 157);
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.useFakeTimers();
    try {
      getOnDidChangeCb()?.({ path: path.join(dir, 'main.pdf') });
    } finally {
      vi.useRealTimers();
    }
    release();
    await pending;
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('ignores a click on a PDF version the host has already replaced', async () => {
    await project();
    vi.useFakeTimers();
    try {
      getOnDidChangeCb()?.({ path: path.join(dir, 'main.pdf') });
    } finally {
      vi.useRealTimers();
    }
    await click(1, 300, 157);
    expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
    await getOnDidReceiveCb()?.({ type: 'syncTexInverse', loadId: 1, page: 1, x: 300, y: 157 });
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('moves from a blank line to the text above it', async () => {
    await project();
    fs.writeFileSync(path.join(dir, 'main.tex'), fs.readFileSync(path.join(fixture, 'main.tex'), 'utf8').replace('ends up somewhere', '\n\nends up somewhere'));
    // Line 6 is now blank, after line 5.
    await click(1, 300, 180);
    const options = vi.mocked(vscode.window.showTextDocument).mock.calls[0][1] as { selection: { start: { line: number } } };
    expect(options.selection.start.line).toBe(4);
  });

  it('does not search SyncTeX data from a build whose PDF is not written yet', async () => {
    await project();
    const pdf = path.join(dir, 'main.pdf');
    fs.writeFileSync(pdf, '');
    const now = Date.now();
    const recent = new Date(now - 10_000);
    const old = new Date(now - 60_000);
    fs.utimesSync(path.join(dir, 'main.synctex.gz'), recent, recent);
    fs.utimesSync(pdf, old, old);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await click(1, 300, 157);
    } finally {
      spy.mockRestore();
    }
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('newer than the PDF'));
  });

  it('uses SyncTeX data newer than the PDF once it is no longer being written', async () => {
    await project();
    const old = new Date(Date.now() - 600_000);
    const older = new Date(Date.now() - 900_000);
    fs.utimesSync(path.join(dir, 'main.synctex.gz'), old, old);
    fs.utimesSync(path.join(dir, 'main.pdf'), older, older);
    await click(1, 300, 157);
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SyncTeX 2001 ms newer, written 10 s ago', -10_000, 2001, false],
    ['SyncTeX 2000 ms newer, written 10 s ago', -10_000, 2000, true],
    ['SyncTeX written 29999 ms ago', -29_999, 60_000, false],
    ['SyncTeX written 30000 ms ago', -30_000, 60_000, true],
    ['SyncTeX dated in the future by the file system clock', 3_600_000, 60_000, true],
  ])('freshness check: %s', async (_name, syncTexOffset, newerBy, opens) => {
    await project();
    // Exact times come from the stat mock, since file systems may round modification times.
    const now = 1_800_000_000_000;
    const mtimes = new Map([
      [path.join(dir, 'main.synctex.gz'), now + syncTexOffset],
      [path.join(dir, 'main.pdf'), now + syncTexOffset - newerBy],
    ]);
    const real = vi.mocked(vscode.workspace.fs.stat).getMockImplementation()!;
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri) => {
      const stat = await real(uri);
      const mtime = mtimes.get((uri as { fsPath: string }).fsPath);
      return mtime === undefined ? stat : { ...stat, mtime };
    });
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await click(1, 300, 157);
    } finally {
      spy.mockRestore();
    }
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(opens ? 1 : 0);
  });

  it('skips the freshness check when the PDF cannot be inspected', async () => {
    await project();
    const pdf = path.join(dir, 'main.pdf');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(pdf, old, old);
    const real = vi.mocked(vscode.workspace.fs.stat).getMockImplementation()!;
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri) => {
      if ((uri as { fsPath: string }).fsPath === pdf) throw new Error('EACCES');
      return real(uri);
    });
    await click(1, 300, 157);
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('does not report a read error after the PDF is closed', async () => {
    await project();
    let fail!: (e: Error) => void;
    vi.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const pending = click(1, 300, 157);
    await new Promise((resolve) => setTimeout(resolve, 20));
    getOnDidDisposeCb()?.();
    fail(new Error('gone'));
    await pending;
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it.each([
    [0, 10, 10], [1.5, 10, 10], ['1', 10, 10], [1, Number.NaN, 10], [1, 10, Infinity],
  ])('ignores invalid positions (page %s, x %s, y %s)', async (page, x, y) => {
    await project();
    await getOnDidReceiveCb()?.({ type: 'syncTexInverse', loadId: 0, page, x, y });
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
  });
});
