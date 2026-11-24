import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import mupdf from 'mupdf';
import { parseSyncTex, syncTexLookup, sourcePathCandidates } from '../src/synctex';

// test/fixtures/synctex/main.pdf was built with `pdflatex -synctex=1 main.tex` (TeX Live 2022) in /work.
// test/fixtures/synctex-ja/main.pdf was built with `uplatex -synctex=1` and dvipdfmx.
const fixture = 'test/fixtures/synctex';
const load = (dir: string) => parseSyncTex(gunzipSync(readFileSync(`${dir}/main.synctex.gz`)).toString('utf8'));
const data = load(fixture);

/** Look up the centre of the first occurrence of `word` on a page, as the viewer would send it. */
function lookupWord(pageIndex: number, word: string, dir = fixture) {
  const doc = mupdf.Document.openDocument(readFileSync(`${dir}/main.pdf`), 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const quad = page.search(word)[0][0];
    page.destroy();
    const cjk = /[\u3000-\u9fff]/.test(word);
    const result = syncTexLookup(load(dir), pageIndex + 1, (quad[0] + quad[2]) / 2, (quad[1] + quad[5]) / 2, { cjk });
    return result && `${path.posix.basename(result.file)}:${result.line}`;
  } finally {
    doc.destroy();
  }
}

describe('parseSyncTex', () => {
  it('reads input files, including ones opened after the preamble', () => {
    expect(data.inputs.get(1)).toBe('/work/./main.tex');
    expect(data.inputs.get(5)).toBe('/work/./chapters/part.tex');
    expect([...data.pages.keys()]).toEqual([1, 2]);
  });

  it('accepts CRLF line endings and applies unit and magnification', () => {
    const text = [
      'SyncTeX Version:1', 'Input:1:a.tex', 'Output:pdf', 'Magnification:2000', 'Unit:2',
      'X Offset:0', 'Y Offset:0', 'Content:', '{1',
      '(1,5:0,1000:100000,500,0', 'k1,6:20000,1000:10000', ')', '}1', '',
    ].join('\r\n');
    const parsed = parseSyncTex(text);
    // One file unit is 2 * 2 sp here, so the kern at 20000 units ends at 80000 sp.
    const bp = (units: number) => units * 4 / 65781.76;
    expect(syncTexLookup(parsed, 1, bp(10000), bp(1000))).toEqual({ file: 'a.tex', line: 6 });
  });
});

describe('syncTexLookup on real pdfLaTeX output', () => {
  it.each([
    [0, 'Introduction', 'main.tex:3'],
    [0, 'first', 'main.tex:4'],
    // "span" begins source line 5 but is typeset at the end of the line that starts with line 4.
    [0, 'span', 'main.tex:5'],
    [0, 'somewhere', 'main.tex:6'],
    [0, 'starts', 'main.tex:8'],
    [0, 'sentence', 'part.tex:2'],
    [1, 'Text', 'main.tex:14'],
  ])('page %i word %s maps to %s', (page, word, expected) => {
    expect(lookupWord(page, word)).toBe(expected);
  });

  it('maps the empty end of a paragraph to its last source line, not the blank line after it', () => {
    // The last line of the first paragraph ends around x = 260 bp at baseline y ≈ 180.5 bp.
    expect(syncTexLookup(data, 1, 500, 180)).toMatchObject({ line: 6 });
  });

  it('uses the nearest line between lines and outside the text block', () => {
    expect(syncTexLookup(data, 1, 300, 162)).toMatchObject({ line: 5 });
    expect(syncTexLookup(data, 1, 20, 157)).toMatchObject({ line: 4 });
  });

  it('returns undefined for a page without SyncTeX records', () => {
    expect(syncTexLookup(data, 3, 100, 100)).toBeUndefined();
  });
});

describe('syncTexLookup on upLaTeX output through DVI', () => {
  it('applies the one-inch DVI offset', () => {
    const ja = load('test/fixtures/synctex-ja');
    expect(ja.xOffset).toBeCloseTo(72, 3);
    expect(ja.yOffset).toBeCloseTo(72, 3);
  });

  it.each([
    ['はじめに', 'main.tex:3'],
    ['これは', 'main.tex:4'],
    ['段落です', 'main.tex:4'],
    ['行をまたぐ', 'main.tex:4'],
    ['書いて', 'main.tex:4'],
    ['二行目', 'main.tex:5'],
    ['さらに', 'main.tex:5'],
    // TeX records nothing for source line 6, which continues the paragraph; line 5 is the closest.
    ['三行目', 'main.tex:5'],
    ['別の', 'main.tex:8'],
    ['始まり', 'main.tex:8'],
  ])('%s maps to %s', (word, expected) => {
    expect(lookupWord(0, word, 'test/fixtures/synctex-ja')).toBe(expected);
  });
});

describe('syncTexLookup on a Japanese paragraph ended by \\par on its last source line', () => {
  // The paragraph box carries line 4, which is also where half of its text comes from.
  it.each([
    ['これは', 'main.tex:3'],
    ['書いて', 'main.tex:3'],
    ['二行目', 'main.tex:4'],
    ['最後の行', 'main.tex:4'],
    ['次の段落', 'main.tex:5'],
  ])('%s maps to %s', (word, expected) => {
    expect(lookupWord(0, word, 'test/fixtures/synctex-ja-par')).toBe(expected);
  });

  it('maps the start of a line to the text it continues', () => {
    const ja = load('test/fixtures/synctex-ja-par');
    expect(syncTexLookup(ja, 1, 80, 141, { cjk: true })).toMatchObject({ line: 4 });
    const other = load('test/fixtures/synctex-ja');
    expect(syncTexLookup(other, 1, 80, 183.6, { cjk: true })).toMatchObject({ line: 5 });
  });
});

describe('sourcePathCandidates', () => {
  it('tries the part after /./ in the PDF directory and the roots before the recorded absolute path', () => {
    expect(sourcePathCandidates('/work/./chapters/part.tex', '/home/me/paper', path.posix, ['/home/me']))
      .toEqual(['/home/me/paper/chapters/part.tex', '/home/me/chapters/part.tex', '/work/chapters/part.tex']);
  });

  it('resolves relative paths against the PDF directory and the roots', () => {
    expect(sourcePathCandidates('./main.tex', '/home/me/paper/build', path.posix, ['/home/me/paper']))
      .toEqual(['/home/me/paper/build/main.tex', '/home/me/paper/main.tex']);
    expect(sourcePathCandidates('main.tex', 'C:\\paper', path.win32)).toEqual(['C:\\paper\\main.tex']);
    expect(sourcePathCandidates('../common/defs.tex', '/p/doc', path.posix)).toEqual(['/p/common/defs.tex']);
  });

  it('handles Windows paths recorded by MiKTeX or TeX Live', () => {
    expect(sourcePathCandidates('C:/Users/me/paper/./main.tex', 'D:\\copy', path.win32))
      .toEqual(['D:\\copy\\main.tex', 'C:\\Users\\me\\paper\\main.tex']);
  });

  it('finds a project compiled on Windows when read on Linux, without joining the drive path', () => {
    expect(sourcePathCandidates('C:/work/./main.tex', '/home/me/project', path.posix)).toEqual(['/home/me/project/main.tex']);
    expect(sourcePathCandidates('C:/work/main.tex', '/home/me/project', path.posix)).toEqual([]);
  });

  it('keeps the whole of a relative path that contains ./', () => {
    expect(sourcePathCandidates('chapters/./part.tex', '/repo', path.posix)).toEqual(['/repo/chapters/part.tex']);
  });

  it('prefers a recorded absolute path inside the workspace over a copy next to the PDF', () => {
    expect(sourcePathCandidates('/repo/./chapters/part.tex', '/repo/build', path.posix, ['/repo'], ['/repo']))
      .toEqual(['/repo/chapters/part.tex', '/repo/build/chapters/part.tex']);
    expect(sourcePathCandidates('/work/./main.tex', '/repo/build', path.posix, ['/repo'], ['/repo']))
      .toEqual(['/repo/build/main.tex', '/repo/main.tex', '/work/main.tex']);
    // With several workspace folders, a path in any of them comes first.
    expect(sourcePathCandidates('/repo/src/./main.tex', '/repo/out', path.posix, [], ['/repo/out', '/repo/src']))
      .toEqual(['/repo/src/main.tex', '/repo/out/main.tex']);
  });

  it('does not duplicate a candidate', () => {
    expect(sourcePathCandidates('/p/./main.tex', '/p', path.posix)).toEqual(['/p/main.tex']);
  });
});

describe('parseSyncTex robustness', () => {
  it('reads compressed vertical positions (",=")', () => {
    const parsed = parseSyncTex([
      'Input:1:a.tex', 'Content:', '{1', '(1,9:0,1000:100000,500,0',
      'k1,3:20000,1000:10000', 'k1,4:40000,=:10000', 'k1,5:60000,=:10000', ')', '}1',
    ].join('\n'));
    const at = (x: number) => syncTexLookup(parsed, 1, x * parsed.scale, 1000 * parsed.scale)?.line;
    expect([at(10000), at(30000), at(50000)]).toEqual([3, 4, 5]);
  });

  it('scales offsets by the unit but not the magnification', () => {
    const parsed = parseSyncTex(['Unit:8192', 'Magnification:2000', 'X Offset:578', 'Y Offset:578', 'Content:'].join('\n'));
    expect(parsed.xOffset).toBeCloseTo(578 * 8192 / 65781.76, 6);
    expect(parsed.scale).toBeCloseTo(8192 * 2 / 65781.76, 9);
  });

  const content = (...records: (string | string[])[]) =>
    ['Input:1:a.tex', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:', '{1', ...records, '}1'].flat().join('\n');
  const lineAt = (text: string, x: number, y: number) => {
    const parsed = parseSyncTex(text);
    return syncTexLookup(parsed, 1, x * parsed.scale, y * parsed.scale)?.line;
  };

  it('keeps PDF form definitions out of the page and keeps boxes that only place a form', () => {
    const text = content(
      '<1', '(1,99:0,1000:100000,500,0', 'k1,99:50000,1000:100', ')', '>',
      '(1,20:0,5000:100000,500,0', 'f1:0,5000', ')',
      '(1,30:0,9000:100000,500,0', 'k1,30:50000,9000:100', ')',
    );
    // A point where the form's own coordinates would put line 99 belongs to the box at y = 5000.
    expect(lineAt(text, 1000, 1000)).toBe(20);
    expect(lineAt(text, 1000, 4900)).toBe(20);
    const parsed = parseSyncTex(text);
    expect(syncTexLookup(parsed, 1, 1000 * parsed.scale, 4900 * parsed.scale, { cjk: true })).toMatchObject({ line: 20 });
  });

  it('applies the magnification and offsets of a post scriptum', () => {
    const parsed = parseSyncTex([
      'Unit:1', 'Magnification:1000', 'X Offset:0', 'Y Offset:0', 'Content:', 'Postamble:', 'Count:0',
      'Post scriptum:', 'Magnification:2', 'X Offset:72bp', 'Y Offset:1in',
    ].join('\n'));
    expect(parsed.scale).toBeCloseTo(2 / 65781.76, 12);
    expect(parsed.xOffset).toBeCloseTo(72, 3);
    expect(parsed.yOffset).toBeCloseTo(72, 3);
  });

  it('reads rule records', () => {
    expect(lineAt(content('(1,12:0,1000:100000,500,0', 'r1,10:0,1000:100000,500,0', ')'), 50000, 1000)).toBe(10);
  });

  it('keeps words on the paragraph-ending line and skips only its trailing glue', () => {
    // A paragraph ended by \par on its last source line: the box and its last words share line 5.
    const text = content('(1,5:0,1000:100000,500,0', 'k1,4:30000,1000:100', 'k1,5:60000,1000:100', 'k1,5:100000,1000:40000', ')');
    expect(lineAt(text, 10000, 1000)).toBe(4);
    expect(lineAt(text, 40000, 1000)).toBe(5);
  });

  it('handles a box with more records than a call accepts as arguments', () => {
    const records = Array.from({ length: 150000 }, (_, i) => `k1,${i % 7 + 1}:${i * 10},1000:5`);
    expect(lineAt(content('(1,9:0,1000:2000000,500,0', records, ')'), 15, 1000)).toBe(3);
  });

  it('parses deeply nested boxes in linear memory and finds the innermost record', () => {
    const depth = 20000;
    const lines = ['Input:1:a.tex', 'Content:', '{1'];
    for (let i = 0; i < depth; i++) lines.push(`(1,1:0,1000:100000,500,0`);
    lines.push('k1,7:50000,1000:100');
    for (let i = 0; i < depth; i++) lines.push(')');
    lines.push('}1');
    const started = performance.now();
    const parsed = parseSyncTex(lines.join('\n'));
    expect(syncTexLookup(parsed, 1, 1 * parsed.scale, 1000 * parsed.scale)).toEqual({ file: 'a.tex', line: 7 });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
