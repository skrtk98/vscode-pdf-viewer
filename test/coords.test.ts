import { describe, it, expect } from 'vitest';
import mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { createPageTransform, tileTransform, transformPoint, canvasPointToPage, buildOutlineTree, OutlineItem } from '../src/coords';

// Verify against MuPDF's raster output, not merely two mutually inverse helpers.
describe('page transforms', () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const shape of ['portrait', 'landscape', 'cropped', 'intrinsic-rotation']) {
      it(`aligns search quads with actual glyph pixels: ${shape}, ${rotation} degrees`, () => {
        const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/searchable.pdf'), 'application/pdf') as mupdf.PDFDocument;
        const object = doc.findPage(0);
        if (shape === 'landscape') object.put('MediaBox', [0, 0, 900, 792]);
        if (shape === 'cropped') object.put('CropBox', [30, 20, 580, 770]);
        if (shape === 'intrinsic-rotation') object.put('Rotate', 90);
        const page = doc.loadPage(0);
        const geometry = createPageTransform(mupdf, page.getBounds(), 1.75, rotation);
        const pixmap = page.toPixmap(geometry.matrix, mupdf.ColorSpace.DeviceRGB, false);
        const quad = page.search('Hello')[0][0];
        const points = [0, 2, 4, 6].map(i => transformPoint(geometry.matrix, quad[i], quad[i + 1]));
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        let ink = 0;
        const pixels = pixmap.getPixels();
        for (let y = Math.ceil(Math.min(...ys)); y < Math.floor(Math.max(...ys)); y++) {
          for (let x = Math.ceil(Math.min(...xs)); x < Math.floor(Math.max(...xs)); x++) {
            if (pixels[((y - pixmap.getY()) * pixmap.getWidth() + x - pixmap.getX()) * 3] < 128) ink++;
          }
        }
        expect(ink).toBeGreaterThan(20);
        // Render a clipped tile around the word and verify its pixels match the full page.
        const box: mupdf.Rect = [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))];
        const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
        tile.clear(255);
        const device = new mupdf.DrawDevice(geometry.matrix, tile);
        page.run(device, mupdf.Matrix.identity);
        device.close(); device.destroy();
        const local = tileTransform(mupdf, geometry, box);
        const centerX = (quad[0] + quad[6]) / 2, centerY = (quad[1] + quad[7]) / 2;
        const point = transformPoint(local.matrix, centerX, centerY);
        const recovered = canvasPointToPage(local, point.x / 2.3, point.y / 2.3,
          tile.getWidth() / 2.3, tile.getHeight() / 2.3, tile.getWidth(), tile.getHeight());
        expect(recovered.x).toBeCloseTo(centerX);
        expect(recovered.y).toBeCloseTo(centerY);
        const tilePixels = tile.getPixels();
        const fullOffset = ((box[1] - pixmap.getY()) * pixmap.getWidth() + box[0] - pixmap.getX()) * 3;
        for (let y = 0; y < tile.getHeight(); y++) {
          expect(tilePixels.slice(y * tile.getStride(), (y + 1) * tile.getStride())).toEqual(
            pixels.slice(fullOffset + y * pixmap.getStride(), fullOffset + y * pixmap.getStride() + tile.getStride()));
        }
        tile.destroy(); pixmap.destroy(); page.destroy(); object.destroy(); doc.destroy();
      });
    }
  }
  it('normalizes a nonzero page origin and rotates clockwise', () => {
    const geometry = createPageTransform(mupdf, [10, 20, 622, 812], 1, 90);
    expect(transformPoint(geometry.matrix, 82, 80)).toEqual({ x: 732, y: 72 });
  });
});

describe('buildOutlineTree', () => {
  it('TC-UNIT-05: converts mupdf OutlineItem[] to OutlineNode[]', () => {
    // mupdf actual API: down is OutlineItem[] (array), page is 0-indexed
    const raw: OutlineItem[] = [
      {
        title: 'Chapter 1',
        uri: '#page=0',
        open: true,
        page: 0,
        down: [
          { title: 'Section 1.1', uri: '#page=1', open: false, page: 1 },
          { title: 'Section 1.2', uri: '#page=3', open: false, page: 3 },
        ],
      },
      {
        title: 'Chapter 2',
        uri: '#page=5',
        open: false,
        page: 5,
      },
    ];

    const result = buildOutlineTree(raw);
    expect(result).toEqual([
      {
        title: 'Chapter 1',
        page: 0,
        children: [
          { title: 'Section 1.1', page: 1, children: [] },
          { title: 'Section 1.2', page: 3, children: [] },
        ],
      },
      { title: 'Chapter 2', page: 5, children: [] },
    ]);
  });

  it('handles undefined title', () => {
    const raw: OutlineItem[] = [
      { title: undefined, uri: undefined, open: false, page: 0 },
    ];
    const result = buildOutlineTree(raw);
    expect(result[0].title).toBe('');
  });

  it('handles empty array', () => {
    expect(buildOutlineTree([])).toEqual([]);
  });
});
