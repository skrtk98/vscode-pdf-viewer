import { afterEach, describe, expect, it } from 'vitest';
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
