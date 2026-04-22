import { describe, it, expect } from 'vitest';
import { toCanvasCoord, toPdfCoord, buildOutlineTree, OutlineItem } from '../src/coords';

describe('toCanvasCoord', () => {
  it('TC-UNIT-01: rotation=0', () => {
    const result = toCanvasCoord(100, 200, 600, 800, 1.0, 1.0, 0);
    expect(result).toEqual({ x: 100, y: 600 });
  });

  it('TC-UNIT-02: rotation=90', () => {
    const result = toCanvasCoord(100, 200, 600, 800, 1.0, 1.0, 90);
    expect(result).toEqual({ x: 600, y: 500 });
  });

  it('TC-UNIT-04A: scale=1.0, dpr=1.0', () => {
    const result = toCanvasCoord(100, 100, 600, 400, 1.0, 1.0, 0);
    expect(result).toEqual({ x: 100, y: 300 });
  });

  it('TC-UNIT-04B: scale=2.0, dpr=2.0 gives 4x', () => {
    const result = toCanvasCoord(100, 100, 600, 400, 2.0, 2.0, 0);
    expect(result).toEqual({ x: 400, y: 1200 });
  });
});

describe('toPdfCoord', () => {
  it('TC-UNIT-03: inverse transform', () => {
    const result = toPdfCoord(450, 2100, 600, 1000, 1.5, 2.0, 0);
    expect(result.x).toBeCloseTo(150, 5);
    expect(result.y).toBeCloseTo(300, 5);
  });

  it('roundtrip rotation=0', () => {
    const pdfX = 120, pdfY = 340;
    const canvas = toCanvasCoord(pdfX, pdfY, 600, 800, 1.5, 2.0, 0);
    const back = toPdfCoord(canvas.x, canvas.y, 600, 800, 1.5, 2.0, 0);
    expect(back.x).toBeCloseTo(pdfX, 5);
    expect(back.y).toBeCloseTo(pdfY, 5);
  });

  it('roundtrip rotation=90', () => {
    const pdfX = 120, pdfY = 340;
    const canvas = toCanvasCoord(pdfX, pdfY, 600, 800, 1.0, 1.0, 90);
    const back = toPdfCoord(canvas.x, canvas.y, 600, 800, 1.0, 1.0, 90);
    expect(back.x).toBeCloseTo(pdfX, 5);
    expect(back.y).toBeCloseTo(pdfY, 5);
  });

  it('roundtrip rotation=180', () => {
    const pdfX = 120, pdfY = 340;
    const canvas = toCanvasCoord(pdfX, pdfY, 600, 800, 1.0, 1.0, 180);
    const back = toPdfCoord(canvas.x, canvas.y, 600, 800, 1.0, 1.0, 180);
    expect(back.x).toBeCloseTo(pdfX, 5);
    expect(back.y).toBeCloseTo(pdfY, 5);
  });

  it('roundtrip rotation=270', () => {
    const pdfX = 120, pdfY = 340;
    const canvas = toCanvasCoord(pdfX, pdfY, 600, 800, 1.0, 1.0, 270);
    const back = toPdfCoord(canvas.x, canvas.y, 600, 800, 1.0, 1.0, 270);
    expect(back.x).toBeCloseTo(pdfX, 5);
    expect(back.y).toBeCloseTo(pdfY, 5);
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
