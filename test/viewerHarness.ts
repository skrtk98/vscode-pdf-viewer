import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import mupdf from 'mupdf';
import { renderTile } from '../src/raster';

/** Minimal DOM adapter; actual viewer handlers and MuPDF run unchanged. */
export function createViewer() {
  const messages: any[] = [];
  const workerMessages: any[] = [];
  const thumbnailFetches: (() => void)[] = [];
  /**
   * PDF responses by URL, answered as VS Code answers `Range: bytes=0-`.
   * `gate` holds the second half of the body until the test releases it.
   */
  const served = new Map<string, Uint8Array | Error | { bytes: Uint8Array; gate: Promise<void> }>();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const status: string[] = [];
  const clipboard: string[] = [];
  const idle = new Map<number, (deadline: { timeRemaining(): number }) => void>();
  const frames = new Map<number, () => void>();
  let nextId = 0;
  class Element {
    style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
    dataset: Record<string, string> = {};
    children: Element[] = [];
    parent: Element | null = null;
    className = '';
    classes = new Set<string>();
    classList = {
      add: (name: string) => { this.classes.add(name); },
      remove: (name: string) => { this.classes.delete(name); },
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: (name: string) => this.classes.has(name),
    };
    listeners: Record<string, Function[]> = {};
    width = 612; height = 792;
    clientWidth = 800; clientHeight = 600;
    scrollTop = 0; scrollLeft = 0;
    value = ''; textContent = '';
    rect = { left: 0, top: 0, width: 612, height: 792 };
    clears = 0;
    fills: number[][] = [];
    path: number[] = [];
    image: any;
    context = {
      clearRect: () => { this.clears++; this.fills = []; },
      beginPath: () => { this.path = []; },
      moveTo: (x: number, y: number) => this.path.push(x, y),
      lineTo: (x: number, y: number) => this.path.push(x, y),
      closePath() {}, fill: () => this.fills.push([...this.path]),
      putImageData: (image: any) => { this.image = image; },
    };
    set innerHTML(_: string) { this.children = []; }
    appendChild(child: Element) { this.children.push(child); child.parent = this; }
    getContext() { return this.context; }
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    addEventListener(type: string, listener: Function) { (this.listeners[type] ??= []).push(listener); }
    async dispatch(type: string, event: any = {}) {
      for (const listener of this.listeners[type] ?? []) await listener({ target: this, button: 0, preventDefault() {}, ...event });
    }
    matches(selector: string): boolean {
      if (selector.startsWith('[data-page=')) return this.dataset.page === selector.match(/"(.*?)"/)?.[1];
      return this.className.split(' ').includes(selector.slice(1));
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    scrollIntoView() {} select() {} blur() {}
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const window = new Element() as any;
  window.devicePixelRatio = 1;
  window.matchMedia = () => ({ addEventListener() {} });
  const document = new Element() as any;
  document.getElementById = element;
  document.createElement = () => new Element();
  document.body = new Element();
  document.activeElement = null;
  const context = createContext({
    console, window, document, Uint8Array, Uint8ClampedArray,
    setTimeout, clearTimeout,
    requestIdleCallback: (callback: any) => { idle.set(++nextId, callback); return nextId; },
    cancelIdleCallback: (id: number) => idle.delete(id),
    requestAnimationFrame: (callback: any) => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { observe() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    ImageData: class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} },
    acquireVsCodeApi: () => ({ postMessage: (msg: any) => messages.push(msg) }),
    navigator: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
    fetch: async (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
      const entry = served.get(url);
      if (entry === undefined) {
        return new Promise(resolve => { thumbnailFetches.push(() => resolve({ blob: async () => ({}) })); });
      }
      requests.push({ url, headers: init?.headers ?? {} });
      if (entry instanceof Error) throw entry;
      const { bytes, gate } = entry instanceof Uint8Array ? { bytes: entry, gate: Promise.resolve() } : entry;
      const half = bytes.byteLength >> 1;
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(bytes.slice(0, half));
          await gate;
          if (signal?.aborted) controller.error(signal.reason);
          else { controller.enqueue(bytes.slice(half)); controller.close(); }
        },
      });
      return new Response(body, {
        status: 206,
        headers: { 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
      });
    },
    AbortController, Response, ReadableStream, Date,
    URL: { createObjectURL: () => 'blob:thumbnail-worker', revokeObjectURL() {} },
    Worker: class extends Element {
      postMessage(message: any) { workerMessages.push(message); }
      terminate() {}
    },
    engine: mupdf, renderTile,
  });
  const coords = readFileSync('src/coords.ts', 'utf8').replace(/^export /gm, '');
  let viewer = readFileSync('src/viewer.ts', 'utf8').replace(/^import .*;\n/gm, '');
  viewer = viewer.slice(0, viewer.lastIndexOf('(async () => {'));
  runInContext(ts.transpile(coords + '\n' + viewer, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
  const evaluate = (code: string): any => runInContext(code, context);
  evaluate('mupdf = engine;');
  const statusEl = element('status');
  Object.defineProperty(statusEl, 'textContent', { set(text: string) { status.push(text); }, get() { return status.at(-1) ?? ''; } });
  return {
    evaluate, element, window, document, messages, clipboard, frames, workerMessages, served, status, requests,
    async finishThumbnailFetch(index: number) {
      thumbnailFetches[index]();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    async loadData(data: Uint8Array, extra: Record<string, unknown> = {}) {
      await window.dispatch('message', { data: { type: 'load', data, ...extra } });
    },
    async loadUrl(url: string, extra: Record<string, unknown> = {}) {
      await window.dispatch('message', { data: { type: 'load', url, ...extra } });
    },
    async load(fixture: string, extra: Record<string, unknown> = {}) {
      await window.dispatch('message', { data: { type: 'load', data: readFileSync(`test/fixtures/${fixture}.pdf`), ...extra } });
      if (messages.some(m => m.type === 'error')) throw new Error(JSON.stringify(messages));
    },
    flushIdle() {
      for (const [id, callback] of [...idle]) { idle.delete(id); callback({ timeRemaining: () => 100 }); }
    },
    dispose() {
      evaluate('if (statusTimer) clearTimeout(statusTimer); if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer); stextCache.forEach(s => s.destroy()); doc?.destroy();');
    },
  };
}
