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
