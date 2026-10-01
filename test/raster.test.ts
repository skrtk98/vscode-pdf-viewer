import { it, expect, vi } from 'vitest';
import mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { renderTile } from '../src/raster';

it('releases the drawing device and pixmap if page rendering fails', () => {
  const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/simple.pdf'), 'application/pdf');
  const page = doc.loadPage(0);
  const deviceDestroy = vi.spyOn(mupdf.DrawDevice.prototype, 'destroy');
  const pixmapDestroy = vi.spyOn(mupdf.Pixmap.prototype, 'destroy');
  vi.spyOn(page, 'run').mockImplementation(() => { throw new Error('render failed'); });
  try {
    expect(() => renderTile(mupdf, page, mupdf.Matrix.identity, [0, 0, 100, 100])).toThrow('render failed');
    expect(deviceDestroy).toHaveBeenCalledOnce();
    expect(pixmapDestroy).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks(); page.destroy(); doc.destroy();
  }
});
