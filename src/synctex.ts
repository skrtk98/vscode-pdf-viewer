/**
 * SyncTeX reader for inverse search: map a point on a PDF page to a source file and line.
 *
 * TeX engines run with `-synctex=1` write `<jobname>.synctex.gz` next to the PDF. The file lists
 * the input files, then for every output page ("sheet") a tree of boxes:
 *
 * ```
 * Input:1:/home/user/paper/./main.tex
 * {1                                   page 1 starts
 * [1,13:x,y:W,H,D                      vbox from input 1, line 13
 * (1,7:x,y:W,H,D                       hbox (usually one typeset line)
 * k1,4:x,y:W                           kern, glue (g), math ($), current point (x)
 * h1,8:x,y:W,H,D                       void hbox (also v void vbox, r rule)
 * )
 * ]
 * }1
 * ```
 *
 * Coordinates are in TeX scaled points measured from the top-left corner of the page; `y` is the
 * baseline, the box extends `H` above and `D` below it. Words themselves have no records. A line
 * box records the line where TeX finished the paragraph, and `x` records inside it are not
 * reliable either. The space after each word is a kern or glue record whose position is the end
 * of the space and whose line is the line of that word, so a point maps to the first such record
 * to its right.
 */

/** Scaled points per PostScript point (1 bp = 1/72 in = 65781.76 sp). */
const SP_PER_BP = 65781.76;

export interface SyncTexLocation {
  /** Input file path exactly as recorded by TeX. */
  file: string;
  /** One-based source line. */
  line: number;
}

interface SyncNode {
  /** Record type: `k` kern, `g` glue, `$` math, `x` current point, or a box type. */
  kind: string;
  tag: number;
  line: number;
  x: number;
  y: number;
}

interface SyncBox extends SyncNode {
  width: number;
  height: number;
  depth: number;
  /** Records directly inside this box. */
  nodes: SyncNode[];
  /** Boxes directly inside this box. */
  children: SyncBox[];
}

interface SyncPage {
  boxes: SyncBox[];
  /** Every record on the page, used when no box is near the point. */
  nodes: SyncNode[];
}

export interface SyncTexData {
  inputs: Map<number, string>;
  pages: Map<number, SyncPage>;
  /** Multiplies a recorded coordinate to get PDF points. */
  scale: number;
  xOffset: number;
  yOffset: number;
}

// `,=` in place of the vertical position repeats the previous record's position.
const BOX_RECORD = /^([[(hvr])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+|=):(-?\d+),(-?\d+),(-?\d+)/;
const POINT_RECORD = /^([xkg$])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+|=)/;
const FORM_REF_RECORD = /^f-?\d+:(-?\d+),(-?\d+|=)/;

/** Parse the text of a `.synctex` file (already decompressed). */
export function parseSyncTex(text: string): SyncTexData {
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncPage>();
  // Defaults follow the reference parser (synctex_parser.c) for files that omit a header line.
  let unit = 8192;
  let magnification = 1000;
  let xOffset = 578;
  let yOffset = 578;
  // Corrections appended by `synctex update` after "Post scriptum:", in scaled points.
  let postMagnification: number | undefined;
  let postXOffset: number | undefined;
  let postYOffset: number | undefined;
  let section: 'preamble' | 'content' | 'postscript' = 'preamble';
  let page: SyncPage | undefined;
  // Depth of PDF form definitions (`<` … `>`). Their records are in the form's own coordinates
  // and are skipped; a form reference (`f`) keeps the box that places it searchable.
  let formDepth = 0;
  let lastY = 0;
  const open: SyncBox[] = [];

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
    start = end + 1;
    if (!line) continue;

    // Input records appear in the preamble and wherever TeX opens a new file.
    if (line.startsWith('Input:')) {
      const sep = line.indexOf(':', 6);
      const tag = Number(line.slice(6, sep));
      if (sep > 6 && Number.isInteger(tag)) inputs.set(tag, line.slice(sep + 1));
      continue;
    }
    if (section === 'preamble') {
      const value = Number(line.slice(line.indexOf(':') + 1));
      if (line === 'Content:') section = 'content';
      else if (!Number.isFinite(value)) continue;
      else if (line.startsWith('Unit:')) unit = value;
      else if (line.startsWith('Magnification:')) magnification = value;
      else if (line.startsWith('X Offset:')) xOffset = value;
      else if (line.startsWith('Y Offset:')) yOffset = value;
      continue;
    }
    if (line === 'Post scriptum:') {
      section = 'postscript';
      continue;
    }
    if (section === 'postscript') {
      if (line.startsWith('Magnification:')) {
        const value = parseFloat(line.slice(14));
        if (value > 0) postMagnification = value;
      } else if (line.startsWith('X Offset:')) {
        postXOffset = parseDimension(line.slice(9)) ?? postXOffset;
      } else if (line.startsWith('Y Offset:')) {
        postYOffset = parseDimension(line.slice(9)) ?? postYOffset;
      }
      continue;
    }

    const kind = line[0];
    if (kind === '<') {
      formDepth++;
      continue;
    }
    if (kind === '>') {
      formDepth = Math.max(0, formDepth - 1);
      continue;
    }
    if (formDepth > 0) continue;
    if (kind === '{') {
      const number = Number(line.slice(1));
      page = Number.isInteger(number) ? { boxes: [], nodes: [] } : undefined;
      if (page) pages.set(number, page);
      open.length = 0;
      continue;
    }
    if (kind === '}') {
      page = undefined;
      open.length = 0;
      continue;
    }
    if (!page) continue;
    if (kind === ')' || kind === ']') {
      open.pop();
      continue;
    }

    const parent = open[open.length - 1];
    if (kind === 'f') {
      const ref = FORM_REF_RECORD.exec(line);
      if (ref) {
        if (ref[2] !== '=') lastY = Number(ref[2]);
        // Not tied to an input file; it only marks that the box has content.
        parent?.nodes.push({ kind: 'f', tag: -1, line: 0, x: Number(ref[1]), y: lastY });
      }
      continue;
    }
    const box = BOX_RECORD.exec(line);
    const point = box ? undefined : POINT_RECORD.exec(line);
    const match = box ?? point;
    if (!match) continue;
    if (match[5] !== '=') lastY = Number(match[5]);
    const node: SyncNode = { kind: match[1], tag: Number(match[2]), line: Number(match[3]), x: Number(match[4]), y: lastY };
    page.nodes.push(node);
    if (box) {
      const record: SyncBox = {
        ...node, width: Number(box[6]), height: Number(box[7]), depth: Number(box[8]), nodes: [], children: [],
      };
      if (parent) parent.children.push(record);
      if (box[1] === '(') page.boxes.push(record);
      if (box[1] === '(' || box[1] === '[') open.push(record);
      else parent?.nodes.push(node);
    } else {
      parent?.nodes.push(node);
    }
  }

  if (!(unit > 0)) unit = 8192;
  if (!(magnification > 0)) magnification = 1000;
  const scale = unit * (postMagnification ?? 1) * magnification / 1000 / SP_PER_BP;
  return {
    inputs, pages,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1 / SP_PER_BP,
    // Offsets are in the same unit as coordinates but are not magnified.
    xOffset: finite((postXOffset ?? xOffset * unit) / SP_PER_BP),
    yOffset: finite((postYOffset ?? yOffset * unit) / SP_PER_BP),
  };
}

const finite = (value: number) => Number.isFinite(value) ? value : 0;

/** TeX units in scaled points, as accepted by the reference parser in a post scriptum. */
const SP_PER_UNIT: Record<string, number> = {
  in: 72.27 * 65536, cm: 72.27 * 65536 / 2.54, mm: 72.27 * 65536 / 25.4, pt: 65536, bp: 72.27 / 72 * 65536,
  pc: 12 * 65536, sp: 1, dd: 1238 / 1157 * 65536, cc: 14856 / 1157 * 65536, nd: 685 / 642 * 65536, nc: 1370 / 107 * 65536,
};

/** Parse a dimension such as `72bp` or `-1in` into scaled points; a bare number is in scaled points. */
function parseDimension(text: string): number | undefined {
  const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z]{2})?/.exec(text);
  if (!match) return undefined;
  const factor = match[2] === undefined ? 1 : SP_PER_UNIT[match[2]];
  return factor === undefined ? undefined : Number(match[1]) * factor;
}

/** Distance from a point to a box's rectangle; 0 inside. */
function boxDistance(box: SyncBox, x: number, y: number): number {
  const left = Math.min(box.x, box.x + box.width);
  const right = Math.max(box.x, box.x + box.width);
  const dx = x < left ? left - x : x > right ? x - right : 0;
  const top = box.y - box.height;
  const bottom = box.y + box.depth;
  const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
  return Math.hypot(dx, dy);
}

/** Records inside a box, including those of nested boxes. */
function descendants(box: SyncBox): SyncNode[] {
  const nodes: SyncNode[] = [];
  const stack = [box];
  for (let current = stack.pop(); current; current = stack.pop()) {
    // Loops rather than spreads: a box can hold more records than a call accepts as arguments.
    for (const node of current.nodes) nodes.push(node);
    for (const child of current.children) stack.push(child);
  }
  return nodes;
}

export interface SyncTexLookupOptions {
  /**
   * The text under the point is Chinese or Japanese. Lines of such text have no spaces between
   * words; the glue between characters belongs to the character after it, and the `x` record at
   * the end of a run of characters carries that run's line.
   */
  cjk?: boolean;
}

/**
 * Find the source location for a point on a page.
 *
 * @param page - One-based page number.
 * @param x - Horizontal position in PDF points from the left edge of the page.
 * @param y - Vertical position in PDF points from the top edge of the page.
 */
export function syncTexLookup(
  data: SyncTexData, page: number, x: number, y: number, options: SyncTexLookupOptions = {},
): SyncTexLocation | undefined {
  const sheet = data.pages.get(page);
  if (!sheet) return undefined;
  // Convert the point into the file's coordinate space instead of converting every record.
  const px = (x - data.xOffset) / data.scale;
  const py = (y - data.yOffset) / data.scale;

  // The box under the point, or the nearest one; on ties the smaller (more nested) box wins.
  let best: SyncBox | undefined;
  let bestDistance = Infinity;
  let bestArea = Infinity;
  for (const box of sheet.boxes) {
    if (box.nodes.length === 0 && box.children.length === 0) continue;
    const distance = boxDistance(box, px, py);
    const area = Math.abs(box.width) * (box.height + box.depth);
    if (distance < bestDistance || (distance === bestDistance && area < bestArea)) {
      best = box;
      bestDistance = distance;
      bestArea = area;
    }
  }

  const known = (node: SyncNode) => data.inputs.has(node.tag) && node.line >= 1;
  let result: SyncNode | undefined;
  if (best) {
    const box = best;
    const nodes = descendants(box).filter(known);
    // Records carrying the box's own line mark where the paragraph ended (the blank line or \par,
    // as the glue filling the last line), not the text under the pointer.
    const sameLine = (node: SyncNode) => node.tag === box.tag && node.line === box.line;
    // Records with the box's own line at its right edge are the glue filling the paragraph's last
    // line, not text. Records with that line elsewhere may be text (a paragraph ended by \par on
    // its last source line) and are kept.
    const rightEdge = Math.max(box.x, box.x + box.width);
    const own = (node: SyncNode) => sameLine(node) && node.x >= rightEdge;
    const preferred = options.cjk
      ? (node: SyncNode) => node.kind === 'x'
      : (node: SyncNode) => node.kind === 'k' || node.kind === 'g' || node.kind === '$';
    const first = nodes.filter(node => preferred(node) && !own(node));
    const others = nodes.filter(node => !own(node));
    const ordered = (first.length > 0 ? first : others.length > 0 ? others : nodes).sort((a, b) => a.x - b.x);
    let index = ordered.findIndex(node => node.x > px);
    if (index < 0) index = ordered.length - 1;
    if (index < 0) return known(box) ? { file: data.inputs.get(box.tag)!, line: box.line } : undefined;
    // In CJK text, TeX tags the record after a punctuation mark with the box's line when it breaks
    // the paragraph, so such a record right after text from another line belongs to that text.
    // At the start of a line there is no earlier record; the text continues to the next one instead.
    if (options.cjk && sameLine(ordered[index])) {
      if (index > 0 && !sameLine(ordered[index - 1])) index--;
      else if (index === 0) index = Math.max(0, ordered.findIndex(node => !sameLine(node)));
    }
    result = ordered[index];
    if (!result && known(box)) result = box;
  } else {
    result = sheet.nodes.filter(known).reduce<SyncNode | undefined>(
      (nearest, node) => !nearest || Math.hypot(node.x - px, node.y - py) < Math.hypot(nearest.x - px, nearest.y - py)
        ? node : nearest, undefined);
  }
  return result ? { file: data.inputs.get(result.tag)!, line: result.line } : undefined;
}

/** The subset of `path.posix` / `path.win32` used to resolve input paths. */
export interface PathApi {
  isAbsolute(p: string): boolean;
  relative(from: string, to: string): string;
  normalize(p: string): string;
  join(...paths: string[]): string;
}

/**
 * Where to look for an input file recorded in a SyncTeX file, in order of preference.
 *
 * TeX records the path it opened, relative to the directory TeX ran in. TeX Live records absolute
 * paths as `<run directory>/./<relative path>`.
 *
 * 1. A recorded absolute path inside a workspace folder is the file TeX read, so it comes first.
 * 2. The part after `/./` (or a relative path) in the PDF's directory and then in `parentDirs`
 *    (its parents up to the workspace folder). This finds the source when the project was
 *    compiled into an output directory, in a container, or on another machine.
 * 3. A recorded absolute path outside the workspace.
 */
export function sourcePathCandidates(
  recorded: string, pdfDir: string, api: PathApi, parentDirs: string[] = [], workspaces: string[] = [],
): string[] {
  const candidates: string[] = [];
  // A path recorded on Windows is absolute even when read on Linux or macOS.
  const absolute = api.isAbsolute(recorded) || /^(?:[A-Za-z]:)?[\\/]/.test(recorded);
  const native = absolute && api.isAbsolute(recorded) ? api.normalize(recorded) : undefined;
  const inWorkspace = native !== undefined && workspaces.some(folder => isInside(native, folder, api));
  if (native && inWorkspace) candidates.push(native);
  // Only an absolute path is split at `/./`; a relative path is relative to the run directory as a whole.
  const marker = absolute ? /[\\/]\.[\\/]/.exec(recorded) : null;
  const relative = marker ? recorded.slice(marker.index + marker[0].length) : absolute ? undefined : recorded;
  if (relative !== undefined) {
    const parts = relative.split(/[\\/]/).filter(part => part !== '' && part !== '.');
    if (parts.length > 0) {
      for (const dir of [pdfDir, ...parentDirs]) candidates.push(api.join(dir, ...parts));
    }
  }
  if (native && !inWorkspace) candidates.push(native);
  return [...new Set(candidates)];
}

function isInside(file: string, dir: string, api: PathApi): boolean {
  const relative = api.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative);
}
