import { afterEach, describe, expect, it } from 'vitest';
import mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { createViewer } from './viewerHarness';

let viewer: ReturnType<typeof createViewer> | undefined;
afterEach(() => { viewer?.dispose(); viewer = undefined; });

describe('PDF links', () => {
  for (const mode of ['single', 'scroll']) {
    for (const rotation of [0, 90, 180, 270]) {
      it(`opens a link at its rendered position in ${mode} mode, rotation ${rotation}`, async () => {
        viewer = createViewer();
        viewer.evaluate(`viewMode = '${mode}';`);
        await viewer.load('with-links');
        viewer.evaluate(`pageRotations.set(0, ${rotation}); pageDimensionsCache.clear(); ${mode === 'scroll' ? 'renderScrollPage(0)' : 'renderPage()'};`);
        const root = mode === 'single' ? viewer.element('pdf-canvas') : viewer.element('scroll-container');
        const target = mode === 'single' ? root : root.querySelector('[data-page="0"]')!.querySelector('.scroll-page-canvas')!;
        const geometry = mode === 'single' ? 'singleTransform' : 'scrollTransforms.get(0)';
        // Locate the visible link independently using its actual MuPDF bounds and rotation.
        const point = viewer.evaluate(`transformPoint(${geometry}.matrix, 100, 82)`);
        const event = { target, clientX: point.x * target.rect.width / target.width, clientY: point.y * target.rect.height / target.height };
        await root.dispatch('mousedown', event);
        await root.dispatch('mouseup', event);
        expect(viewer.messages.filter(m => m.type === 'openExternal')).toEqual([{ type: 'openExternal', url: 'https://example.com' }]);
        viewer.messages.length = 0;
        const empty = viewer.evaluate(`transformPoint(${geometry}.matrix, 100, 710)`);
        await root.dispatch('mousedown', { target, clientX: empty.x * target.rect.width / target.width, clientY: empty.y * target.rect.height / target.height });
        await root.dispatch('mouseup', { target, clientX: empty.x * target.rect.width / target.width, clientY: empty.y * target.rect.height / target.height });
        expect(viewer.messages).toEqual([]);
      });
    }
  }
  it('resolves an internal link on the clicked scroll page', async () => {
    viewer = createViewer();
    await viewer.load('multi-page');
    viewer.evaluate(`const linkPage = doc.loadPage(1); linkPage.createLink([72,72,200,92], '#page=5'); linkPage.destroy(); renderScrollPage(1);`);
    const root = viewer.element('scroll-container');
    const target = root.querySelector('[data-page="1"]')!.querySelector('.scroll-page-canvas')!;
    await root.dispatch('mousedown', { target, clientX: 100, clientY: 82 });
    await root.dispatch('mouseup', { target, clientX: 100, clientY: 82 });
    expect(viewer.evaluate('currentPage')).toBe(4);
  });
});


describe('scroll raster lifetime', () => {
  it('copies exactly the same pixels as the single-page renderer', async () => {
    viewer = createViewer();
    await viewer.load('simple');
    viewer.evaluate('renderScrollPage(0);');
    const scrollImage = viewer.element('scroll-container').querySelector('[data-page="0"]')!.querySelector('.scroll-page-canvas')!.image;
    viewer.evaluate("viewMode = 'single'; renderPage();");
    const singleImage = viewer.element('pdf-canvas').image;
    expect(scrollImage.width).toBe(singleImage.width);
    expect(scrollImage.height).toBe(singleImage.height);
    expect(Buffer.from(scrollImage.data).equals(Buffer.from(singleImage.data))).toBe(true);
  });
});


describe('viewer settings', () => {
  it('preserves resolution and user zoom when a file reload omits settings', async () => {
    viewer = createViewer();
    await viewer.load('simple', { defaultZoom: 1.25, renderResolution: 192 });
    expect(viewer.evaluate('scale')).toBe(1.25);
    viewer.evaluate('applyScale(2);');
    await viewer.load('simple');
    expect(viewer.evaluate('scale')).toBe(2);
    expect(viewer.evaluate('computeRenderScale()')).toBe(4);
  });

  it('retains initial settings while waiting for a PDF password', async () => {
    viewer = createViewer();
    const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/simple.pdf'), 'application/pdf') as mupdf.PDFDocument;
    const buffer = doc.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
    const bytes = new Uint8Array(buffer.asUint8Array());
    buffer.destroy(); doc.destroy();
    await viewer.loadData(bytes, { defaultZoom: 1.5, renderResolution: 192 });
    expect(viewer.messages).toContainEqual({ type: 'requestPassword' });
    await viewer.loadData(bytes, { password: 'secret' });
    expect(viewer.evaluate('scale')).toBe(1.5);
    expect(viewer.evaluate('computeRenderScale()')).toBe(3);
    expect(viewer.messages.filter(m => m.type === 'error')).toEqual([]);
  });
});


describe('document loading', () => {
  const encrypted = () => {
    const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/simple.pdf'), 'application/pdf') as mupdf.PDFDocument;
    const buffer = doc.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
    const bytes = new Uint8Array(buffer.asUint8Array());
    buffer.destroy(); doc.destroy();
    return bytes;
  };
  const fixture = (name: string) => new Uint8Array(readFileSync(`test/fixtures/${name}.pdf`));
  const gate = () => { let open!: () => void; const promise = new Promise<void>(r => { open = r; }); return { promise, open }; };

  it('fetches the PDF with a range request and applies the settings sent with it', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', fixture('simple'));
    await viewer.loadUrl('pdf:a', { loadId: 0, defaultZoom: 1.5 });
    expect(viewer.requests).toEqual([{ url: 'pdf:a', headers: { Range: 'bytes=0-' } }]);
    expect(viewer.evaluate('totalPages')).toBe(1);
    expect(viewer.evaluate('scale')).toBe(1.5);
    expect(viewer.messages).toEqual([]);
    expect(viewer.status.some(t => /^Loading PDF… [\d.]+ MB \/ [\d.]+ MB$/.test(t))).toBe(true);
  });

  it('fills the status as a progress bar while loading and hides it afterwards', async () => {
    viewer = createViewer();
    const slow = gate();
    const bytes = fixture('simple');
    viewer.served.set('pdf:a', { bytes, gate: slow.promise });
    const load = viewer.loadUrl('pdf:a', { loadId: 0 });
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    const status = viewer.element('status');
    expect([...status.classes].sort()).toEqual(['progress', 'visible']);
    const half = bytes.byteLength >> 1;
    expect(status.style['--progress']).toBe(`${(half / bytes.byteLength * 100).toFixed(1)}%`);
    slow.open();
    await load;
    expect(status.classes.has('visible')).toBe(false);
    expect(viewer.evaluate('totalPages')).toBe(1);
  });

  it('does not show stale progress from a read that finishes after a newer load', async () => {
    viewer = createViewer();
    const slow = gate();
    const bytes = fixture('multi-page');
    // Unlike the default harness, deliver the second chunk even after an abort,
    // as when a read has already resolved before the newer load arrives.
    viewer.evaluate('globalThis').fetch = async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(bytes.slice(0, 100));
        await slow.promise;
        controller.enqueue(bytes.slice(100));
        controller.close();
      },
    }), { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` } });
    const old = viewer.loadUrl('pdf:old', { loadId: 0 });
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    await viewer.loadData(fixture('simple'), { loadId: 1 });
    await new Promise(r => setTimeout(r, 120));
    slow.open();
    await old;
    expect(viewer.element('status').classes.has('visible')).toBe(false);
    expect(viewer.evaluate('totalPages')).toBe(1);
  });

  it('asks the host for the bytes when the fetch fails, keeping the settings', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', new Error('blocked'));
    await viewer.loadUrl('pdf:a', { loadId: 0, defaultZoom: 1.5 });
    expect(viewer.messages).toEqual([{ type: 'fetchFailed', loadId: 0 }]);
    await viewer.loadData(fixture('simple'), { loadId: 0 });
    expect(viewer.evaluate('totalPages')).toBe(1);
    expect(viewer.evaluate('scale')).toBe(1.5);
  });

  it('discards a fetch that completes after a newer load', async () => {
    viewer = createViewer();
    const slow = gate();
    viewer.served.set('pdf:old', { bytes: fixture('multi-page'), gate: slow.promise });
    viewer.served.set('pdf:new', fixture('simple'));
    const old = viewer.loadUrl('pdf:old', { loadId: 0 });
    await viewer.loadUrl('pdf:new', { loadId: 1 });
    slow.open();
    await old;
    expect(viewer.evaluate('totalPages')).toBe(1);
    expect(viewer.messages).toEqual([]);
  });

  it('ignores bytes for an older file version arriving after a newer one', async () => {
    viewer = createViewer();
    await viewer.loadData(fixture('multi-page'), { loadId: 1 });
    await viewer.loadData(fixture('simple'), { loadId: 0 });
    expect(viewer.evaluate('totalPages')).toBe(5);
  });

  it('opens an encrypted PDF with the entered password without fetching it again', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', encrypted());
    await viewer.loadUrl('pdf:a', { loadId: 0 });
    expect(viewer.messages).toEqual([{ type: 'requestPassword', loadId: 0 }]);
    await viewer.window.dispatch('message', { data: { type: 'password', loadId: 0, password: 'secret' } });
    expect(viewer.requests).toHaveLength(1);
    expect(viewer.evaluate('totalPages')).toBe(1);
    expect(viewer.evaluate('pendingPassword')).toBeNull();
  });

  it('does not apply a password to a file version that is being replaced', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', encrypted());
    await viewer.loadUrl('pdf:a', { loadId: 0 });
    const slow = gate();
    viewer.served.set('pdf:b', { bytes: encrypted(), gate: slow.promise });
    const reload = viewer.loadUrl('pdf:b', { loadId: 1 });
    await viewer.window.dispatch('message', { data: { type: 'password', loadId: 0, password: 'secret' } });
    expect(viewer.evaluate('doc')).toBeNull();
    slow.open();
    await reload;
    expect(viewer.messages).toEqual([{ type: 'requestPassword', loadId: 0 }, { type: 'requestPassword', loadId: 1 }]);
  });

  it('accepts the correct password after an empty one', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', encrypted());
    await viewer.loadUrl('pdf:a', { loadId: 0 });
    await viewer.window.dispatch('message', { data: { type: 'password', loadId: 0, password: '' } });
    await viewer.window.dispatch('message', { data: { type: 'password', loadId: 0, password: 'secret' } });
    expect(viewer.evaluate('totalPages')).toBe(1);
    expect(viewer.messages.filter(m => m.type === 'error')).toEqual([]);
  });

  it('cancels the transfer when the body exceeds its declared size', async () => {
    viewer = createViewer();
    let cancelled = false;
    const bytes = fixture('simple');
    viewer.evaluate('globalThis').fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    }), { status: 206, headers: { 'Content-Range': `bytes 0-9/10` } });
    await viewer.loadUrl('pdf:a', { loadId: 0 });
    expect(cancelled).toBe(true);
    expect(viewer.messages).toEqual([{ type: 'fetchFailed', loadId: 0 }]);
  });

  it('releases the downloaded bytes once an unencrypted PDF opens', async () => {
    viewer = createViewer();
    viewer.served.set('pdf:a', fixture('simple'));
    await viewer.loadUrl('pdf:a', { loadId: 0 });
    expect(viewer.evaluate('pendingPassword')).toBeNull();
  });

  it('shows a message without inline styles when the PDF has no outline', async () => {
    viewer = createViewer();
    await viewer.load('simple');
    const panel = viewer.element('outline-panel');
    expect(panel.children.map(c => [c.className, c.textContent])).toEqual([['outline-empty', 'No outline']]);
  });
});


describe('document selection lifecycle', () => {
  it('drops selected text and pending drag painting when the document reloads', async () => {
    viewer = createViewer();
    viewer.evaluate("viewMode = 'single';");
    await viewer.load('searchable');
    const canvas = viewer.element('pdf-canvas');
    await canvas.dispatch('dblclick', { clientX: 80, clientY: 67 });
    await viewer.evaluate('copySelection()');
    expect(viewer.clipboard).toEqual(['Hello']);
    await canvas.dispatch('mousedown', { clientX: 75, clientY: 67 });
    await canvas.dispatch('mousemove', { clientX: 95, clientY: 67 });
    expect(viewer.frames.size).toBe(1);
    await viewer.load('simple');
    expect(viewer.frames.size).toBe(0);
    expect(viewer.evaluate('isDragging')).toBe(false);
    expect(viewer.evaluate('selectionPageChars.length')).toBe(0);
    await viewer.evaluate('copySelection()');
    expect(viewer.clipboard).toEqual(['Hello']);
    expect(viewer.element('search-overlay').fills).toEqual([]);
  });
  it('does not paint a previous page selection on the next single page', async () => {
    viewer = createViewer();
    viewer.evaluate("viewMode = 'single';");
    await viewer.load('searchable');
    await viewer.element('pdf-canvas').dispatch('dblclick', { clientX: 80, clientY: 67 });
    expect(viewer.element('search-overlay').fills.length).toBeGreaterThan(0);
    viewer.evaluate('goToPage(1);');
    expect(viewer.element('search-overlay').fills).toEqual([]);
  });
});


describe('search overlays', () => {
  it('clears scroll highlights when the query becomes empty', async () => {
    viewer = createViewer();
    await viewer.load('searchable');
    viewer.evaluate('renderScrollPage(0); startSearch("Hello");');
    const overlay = viewer.element('scroll-container').querySelector('[data-page="0"]')!.querySelector('.scroll-page-overlay')!;
    expect(overlay.fills.length).toBeGreaterThan(0);
    viewer.evaluate('startSearch("");');
    expect(overlay.fills).toEqual([]);
    expect(viewer.element('search-info').textContent).toBe('');
  });
  it('clears search safely when reloading with fewer pages', async () => {
    viewer = createViewer();
    await viewer.load('searchable');
    viewer.evaluate('renderScrollPage(1); currentPage = 1; startSearch("Page");');
    await viewer.load('simple');
    expect(viewer.evaluate('searchQuery')).toBe('');
    expect(viewer.evaluate('currentPage')).toBe(0);
  });
});


describe('incremental search', () => {
  it('searches the page navigated to while idle work is pending and paints its hits', async () => {
    viewer = createViewer();
    await viewer.load('searchable');
    viewer.evaluate('renderScrollPage(1); startSearch("Page"); goToPage(1);');
    viewer.flushIdle();
    expect(viewer.evaluate('getTotalHits()')).toBe(1);
    expect(viewer.element('search-info').textContent).toBe('- / 1');
    const overlay = viewer.element('scroll-container').querySelector('[data-page="1"]')!.querySelector('.scroll-page-overlay')!;
    expect(overlay.fills.length).toBeGreaterThan(0);
  });
  it('keeps the selected hit when earlier pages finish searching', async () => {
    viewer = createViewer();
    await viewer.load('multi-page');
    viewer.evaluate('goToPage(3); startSearch("Page"); navigateSearch(1);');
    viewer.flushIdle();
    expect(viewer.evaluate('searchHitIndex')).toBe(3);
    expect(viewer.evaluate('currentPage')).toBe(3);
    expect(viewer.element('search-info').textContent).toBe('4 / 5');
  });
  it('cancels old idle work when the query is replaced', async () => {
    viewer = createViewer();
    await viewer.load('searchable');
    viewer.evaluate('startSearch("Page"); startSearch("Hello");');
    viewer.flushIdle();
    expect(viewer.evaluate('searchHits.map(hits => hits.length)')).toEqual([1, 0]);
  });
});


describe('thumbnail initialization', () => {
  it('forwards the password used to open the document to the worker', async () => {
    viewer = createViewer();
    const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/simple.pdf'), 'application/pdf') as mupdf.PDFDocument;
    const buffer = doc.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
    const bytes = new Uint8Array(buffer.asUint8Array());
    buffer.destroy(); doc.destroy();
    await viewer.loadData(bytes, { password: 'secret' });
    await viewer.finishThumbnailFetch(0);
    expect(viewer.workerMessages).toHaveLength(1);
    expect(viewer.workerMessages[0]).toMatchObject({ type: 'init', password: 'secret', data: bytes });
  });
  it('ignores a stale worker fetch completing after a reload', async () => {
    viewer = createViewer();
    await viewer.load('simple');
    await viewer.load('searchable');
    await viewer.finishThumbnailFetch(1);
    await viewer.finishThumbnailFetch(0);
    expect(viewer.workerMessages).toHaveLength(1);
    expect(viewer.workerMessages[0].data).toEqual(readFileSync('test/fixtures/searchable.pdf'));
  });
});


describe('transformed viewer interactions', () => {
  for (const mode of ['single', 'scroll']) {
    for (const rotation of [0, 90, 180, 270]) {
      it(`selects the visible word at fractional zoom and DPI in ${mode}, rotation ${rotation}`, async () => {
        viewer = createViewer();
        viewer.evaluate(`viewMode = '${mode}'; dpr = 1.25;`);
        await viewer.load('searchable', { defaultZoom: 1.33, renderResolution: 144 });
        viewer.evaluate(`pageRotations.set(0, ${rotation}); pageDimensionsCache.clear(); ${mode === 'single' ? 'renderPage()' : 'renderScrollPage(0)'}; startSearch('Hello');`);
        const root = mode === 'single' ? viewer.element('pdf-canvas') : viewer.element('scroll-container');
        const target = mode === 'single' ? root : root.querySelector('[data-page="0"]')!.querySelector('.scroll-page-canvas')!;
        const overlay = mode === 'single' ? viewer.element('search-overlay') : root.querySelector('[data-page="0"]')!.querySelector('.scroll-page-overlay')!;
        const highlight = overlay.fills[0];
        // Click the center of the painted search hit, in actual CSS dimensions.
        const x = (highlight[0] + highlight[4]) / 2;
        const y = (highlight[1] + highlight[5]) / 2;
        await root.dispatch('dblclick', { target, clientX: x * target.rect.width / target.width, clientY: y * target.rect.height / target.height });
        await viewer.evaluate('copySelection()');
        expect(viewer.clipboard).toEqual(['Hello']);
        expect(overlay.fills.length).toBe(2);
      });
    }
  }
  it('hit-tests a clipped tile after CSS resizing before the next render', async () => {
    viewer = createViewer();
    await viewer.load('simple', { defaultZoom: 4, renderResolution: 144 });
    viewer.evaluate(`const p = doc.loadPage(0); p.createLink([400,400,480,450], 'https://example.com/tile').destroy(); p.destroy();`);
    const root = viewer.element('scroll-container');
    const wrapper = root.querySelector('[data-page="0"]')!;
    wrapper.rect = { left: -1000, top: -1000, width: 2448, height: 3168 };
    viewer.evaluate('renderScrollPage(0);');
    expect(viewer.evaluate('pageTiles.get(0).cssLeft')).toBeGreaterThan(0);
    expect(viewer.evaluate('pageTiles.get(0).cssTop')).toBeGreaterThan(0);
    const target = wrapper.querySelector('.scroll-page-canvas')!;
    // Simulate CSS zoom while retaining the old tile pixels until the debounce fires.
    target.rect = { left: -200, top: -150, width: parseFloat(target.style.width) * 1.25, height: parseFloat(target.style.height) * 1.25 };
    const local = viewer.evaluate('transformPoint(scrollTransforms.get(0).matrix, 440, 425)');
    const event = { target, clientX: target.rect.left + local.x * target.rect.width / target.width, clientY: target.rect.top + local.y * target.rect.height / target.height };
    await root.dispatch('mousedown', event);
    await root.dispatch('mouseup', event);
    expect(viewer.messages).toContainEqual({ type: 'openExternal', url: 'https://example.com/tile' });
  });
});
