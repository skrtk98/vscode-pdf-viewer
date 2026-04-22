import type * as MupdfTypes from 'mupdf';
import { toCanvasCoord, toPdfCoord, buildOutlineTree, OutlineNode } from './coords';

declare global {
  interface Window {
    WASM_URI: string;
    MUPDF_JS_URI: string;
    WORKER_URI: string;
  }
}

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

let mupdf: typeof MupdfTypes | null = null;

type ViewMode = 'single' | 'scroll';

let doc: MupdfTypes.Document | null = null;
let currentPage = 0;
let totalPages = 0;
let scale = 1.0;
let dpr = window.devicePixelRatio || 1;
let pageRotations: Map<number, number> = new Map();
let searchHits: MupdfTypes.Quad[][][] = [];
let searchQuery = '';
let searchHitIndex = -1;
let searchIdleHandle: number | null = null;
let worker: Worker | null = null;
let renderScale = 1.0;

/**
 * A single character extracted from a MuPDF structured-text walk,
 * positioned in canvas device-pixel space.
 */
interface CharInfo {
  /** Eight-value quad `[ulX, ulY, urX, urY, llX, llY, lrX, lrY]` in canvas device pixels. */
  quad: [number, number, number, number, number, number, number, number];
  /** The Unicode character at this position. */
  c: string;
  /** Zero-based index of the text block that contains this character. */
  blockIdx: number;
  /** Zero-based index of the line within its block. */
  lineIdx: number;
}

let selectionPageChars: CharInfo[] = [];
let selectionStartIdx = -1;
let selectionEndIdx = -1;
let isDragging = false;
let thumbObserver: IntersectionObserver | null = null;
let defaultSettings: { defaultZoom?: number; renderResolution?: number } = {};
let rafHandle: number | null = null;
const pageDimensionsCache = new Map<number, { width: number; height: number }>();
type FitMode = 'none' | 'width' | 'page';

/**
 * Cached tile geometry for a scroll-mode page canvas.
 *
 * Tracks which CSS sub-region of the page was rendered so the overlay can
 * apply the matching translation offset and so scroll events can detect when
 * the visible area has moved outside the tile and a re-render is needed.
 */
interface PageTileInfo {
  /** CSS pixel offset of the tile's left edge within the page wrapper. */
  cssLeft: number;
  /** CSS pixel offset of the tile's top edge within the page wrapper. */
  cssTop: number;
  /** CSS pixel offset of the tile's right edge within the page wrapper. */
  cssRight: number;
  /** CSS pixel offset of the tile's bottom edge within the page wrapper. */
  cssBottom: number;
  /** Render scale (`renderScale`) used when the tile was drawn. */
  rs: number;
  /** UI `scale` value at the time the tile was drawn, used to rescale CSS dimensions on zoom. */
  renderedAtScale: number;
}

let viewMode: ViewMode = 'scroll';
let fitMode: FitMode = 'none';
let scrollObserver: IntersectionObserver | null = null;
const renderedScrollPages = new Set<number>();
let sidebarVisible = false;
let thumbsSidebarVisible = false;
let selectionPage = 0;
let zoomDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pageRenderScales = new Map<number, number>();
const MAX_RENDER_SCALE = 8;
const MAX_PIXMAP_DIM = 8192;
const TILE_MARGIN_CSS = 600;
const pageTiles = new Map<number, PageTileInfo>();
let scrollTileTimer: ReturnType<typeof setTimeout> | null = null;
const stextCache = new Map<number, MupdfTypes.StructuredText>();

/**
 * Return the cached structured text for a page, loading it on first access.
 *
 * Results are stored in {@link stextCache} so that repeated selection and search
 * operations on the same page do not re-parse the PDF stream each time.
 *
 * @param pageIndex - Zero-based page index.
 * @returns The structured text object, or `null` if the document is not loaded.
 */
function getPageSText(pageIndex: number): MupdfTypes.StructuredText | null {
  if (!doc || !mupdf) return null;
  if (stextCache.has(pageIndex)) return stextCache.get(pageIndex)!;
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText('preserve-whitespace');
  page.destroy();
  stextCache.set(pageIndex, stext);
  return stext;
}

/**
 * Convert a point from MuPDF stext space to canvas device pixels.
 *
 * Stext space has its origin at the top-left (y-DOWN) because MuPDF's
 * `page_ctm` flips the y-axis; `toCanvasCoord` expects PDF user space
 * (y-UP), so the y coordinate is mirrored through `pageH` first.
 *
 * @param sx - X in stext space.
 * @param sy - Y in stext space.
 * @param pageW - Unrotated page width in PDF user-space units.
 * @param pageH - Unrotated page height in PDF user-space units.
 * @param rs - Combined render scale (renderScale).
 * @param rot - Page rotation in degrees clockwise.
 * @returns Canvas device-pixel coordinate.
 */
function stextPtToCanvas(
  sx: number, sy: number,
  pageW: number, pageH: number,
  rs: number, rot: number,
): { x: number; y: number } {
  return toCanvasCoord(sx, pageH - sy, pageW, pageH, rs, 1, rot);
}

/**
 * Walk the structured text of a page and return every character as a
 * {@link CharInfo} with its quad pre-converted to canvas device pixels.
 *
 * @param pageIndex - Zero-based page index.
 * @param rs - Render scale to use for the coordinate conversion.
 * @param rot - Page rotation in degrees clockwise.
 * @returns Flat array of characters in document order.
 */
function buildCharList(pageIndex: number, rs: number, rot: number): CharInfo[] {
  const stext = getPageSText(pageIndex);
  if (!stext) return [];
  const { width: pageW, height: pageH } = getPageDimensions(pageIndex);
  const chars: CharInfo[] = [];
  let bi = 0, li = 0;
  stext.walk({
    beginTextBlock() { li = 0; },
    onChar(c: string, _o: unknown, _f: unknown, _s: unknown, quad: MupdfTypes.Quad) {
      const ul = stextPtToCanvas(quad[0], quad[1], pageW, pageH, rs, rot);
      const ur = stextPtToCanvas(quad[2], quad[3], pageW, pageH, rs, rot);
      const ll = stextPtToCanvas(quad[4], quad[5], pageW, pageH, rs, rot);
      const lr = stextPtToCanvas(quad[6], quad[7], pageW, pageH, rs, rot);
      chars.push({ quad: [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y], c, blockIdx: bi, lineIdx: li });
    },
    endLine() { li++; },
    endTextBlock() { bi++; },
  });
  return chars;
}

/**
 * Find the index of the character whose centroid is nearest to a canvas point.
 *
 * Uses squared Euclidean distance so no `Math.sqrt` is needed.
 *
 * @param chars - Character list produced by {@link buildCharList}.
 * @param devX - X position in canvas device pixels.
 * @param devY - Y position in canvas device pixels.
 * @returns Index into `chars`, or `-1` if the array is empty.
 */
function findClosestChar(chars: CharInfo[], devX: number, devY: number): number {
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < chars.length; i++) {
    const q = chars[i].quad;
    const mx = (q[0] + q[2] + q[4] + q[6]) / 4;
    const my = (q[1] + q[3] + q[5] + q[7]) / 4;
    const d = (mx - devX) ** 2 + (my - devY) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Compute merged highlight quads for the current selection range.
 *
 * Characters on the same block+line are merged into a single spanning quad
 * so the highlight appears as one rectangle per line rather than per glyph.
 *
 * @param chars - Character list produced by {@link buildCharList}.
 * @param startIdx - Index of the selection anchor character.
 * @param endIdx - Index of the selection focus character.
 * @returns Array of eight-value quad arrays in canvas device pixels.
 */
function computeSelectionQuads(chars: CharInfo[], startIdx: number, endIdx: number): number[][] {
  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const selected = chars.slice(lo, hi + 1);
  if (!selected.length) return [];
  const lines = new Map<string, CharInfo[]>();
  for (const ch of selected) {
    const key = `${ch.blockIdx}-${ch.lineIdx}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push(ch);
  }
  const quads: number[][] = [];
  for (const group of lines.values()) {
    const f = group[0].quad, l = group[group.length - 1].quad;
    quads.push([f[0], f[1], l[2], l[3], f[4], f[5], l[6], l[7]]);
  }
  return quads;
}

/**
 * Concatenate the characters in a selection range into a plain string.
 *
 * @param chars - Character list produced by {@link buildCharList}.
 * @param startIdx - Index of the selection anchor character.
 * @param endIdx - Index of the selection focus character.
 * @returns The selected text.
 */
function extractSelectedText(chars: CharInfo[], startIdx: number, endIdx: number): string {
  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  return chars.slice(lo, hi + 1).map(ch => ch.c).join('');
}

/**
 * Expand a character index outward to word boundaries on the same line.
 *
 * A "word" is a contiguous run of non-whitespace characters within the same
 * block and line.  Expansion does not cross line or block boundaries.
 *
 * @param chars - Character list produced by {@link buildCharList}.
 * @param idx - The seed character index.
 * @returns `[lo, hi]` indices of the word, or `[-1, -1]` if `idx` is invalid.
 */
function expandWordAtChar(chars: CharInfo[], idx: number): [number, number] {
  if (idx < 0 || idx >= chars.length) return [-1, -1];
  const { blockIdx, lineIdx } = chars[idx];
  let lo = idx, hi = idx;
  while (lo > 0 && chars[lo - 1].blockIdx === blockIdx && chars[lo - 1].lineIdx === lineIdx && !/\s/.test(chars[lo - 1].c)) lo--;
  while (hi < chars.length - 1 && chars[hi + 1].blockIdx === blockIdx && chars[hi + 1].lineIdx === lineIdx && !/\s/.test(chars[hi + 1].c)) hi++;
  return [lo, hi];
}

const canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlayCanvas = document.getElementById('search-overlay') as HTMLCanvasElement;
const overlayCtx = overlayCanvas.getContext('2d')!;
const canvasContainer = document.getElementById('canvas-container')!;
const canvasWrapper = document.getElementById('canvas-wrapper')!;
const scrollContainer = document.getElementById('scroll-container')!;
const outlinePanel = document.getElementById('outline-panel')!;
const thumbsPanel = document.getElementById('thumbs-panel')!;
const sidebar = document.getElementById('sidebar')!;
const pageInput = document.getElementById('page-input') as HTMLInputElement;
const pageCount = document.getElementById('page-count')!;
const zoomInput = document.getElementById('zoom-input') as HTMLInputElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchInfo = document.getElementById('search-info')!;
const tabOutline = document.getElementById('tab-outline') as HTMLButtonElement;
const thumbsSidebar = document.getElementById('thumbs-sidebar')!;
const btnThumbs = document.getElementById('btn-thumbs') as HTMLButtonElement;
const btnViewMode = document.getElementById('btn-view-mode') as HTMLButtonElement;
const btnSidebar = document.getElementById('btn-sidebar') as HTMLButtonElement;
const btnFitWidth = document.getElementById('btn-fit-width') as HTMLButtonElement;
const btnFitPage = document.getElementById('btn-fit-page') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;

let statusTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Display a transient status message at the bottom of the viewer.
 *
 * The message fades out automatically after 2.5 seconds.  Calling this
 * function again before the timer fires resets the countdown.
 *
 * @param msg - The text to display.
 */
function showStatus(msg: string): void {
  statusEl.textContent = msg;
  statusEl.classList.add('visible');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 2500);
}

/**
 * Compute the combined render scale from the current UI scale, device pixel
 * ratio, and the user-configured render resolution setting.
 *
 * @returns `scale * dpr * (renderResolution / 96)`.
 */
function computeRenderScale(): number {
  return scale * dpr * ((defaultSettings.renderResolution ?? 96) / 96);
}

/**
 * Clamp a render scale so the resulting pixmap does not exceed engine limits.
 *
 * The scale is capped at {@link MAX_RENDER_SCALE} and at whatever value would
 * make either dimension of the page reach {@link MAX_PIXMAP_DIM} pixels.
 *
 * @param rs - Unclamped render scale candidate.
 * @param w - Page display width in PDF user-space units.
 * @param h - Page display height in PDF user-space units.
 * @returns The clamped render scale.
 */
function clampRenderScale(rs: number, w: number, h: number): number {
  return Math.min(rs, MAX_RENDER_SCALE, MAX_PIXMAP_DIM / w, MAX_PIXMAP_DIM / h);
}

/**
 * Calculate the CSS-pixel tile region to render for a scroll-mode page.
 *
 * Returns the visible area of the page expanded by {@link TILE_MARGIN_CSS} on
 * all sides, clamped to the page bounds.  If the page is not in the viewport
 * the full page bounds are returned as a fallback.
 *
 * @param pageIndex - Zero-based page index.
 * @param displayW - Page display width in PDF user-space units (after rotation).
 * @param displayH - Page display height in PDF user-space units (after rotation).
 * @returns `{ left, top, right, bottom }` in CSS pixels relative to the page wrapper.
 */
function getScrollPageTileCSS(
  pageIndex: number,
  displayW: number,
  displayH: number,
): { left: number; top: number; right: number; bottom: number } {
  const pageCssW = displayW * scale;
  const pageCssH = displayH * scale;
  const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
  if (!wrapper) return { left: 0, top: 0, right: pageCssW, bottom: pageCssH };

  const containerRect = canvasContainer.getBoundingClientRect();
  const wrapperRect   = wrapper.getBoundingClientRect();

  const visLeft   = Math.max(0,        containerRect.left   - wrapperRect.left);
  const visTop    = Math.max(0,        containerRect.top    - wrapperRect.top);
  const visRight  = Math.min(pageCssW, containerRect.right  - wrapperRect.left);
  const visBottom = Math.min(pageCssH, containerRect.bottom - wrapperRect.top);

  if (visRight <= visLeft || visBottom <= visTop) {
    return { left: 0, top: 0, right: pageCssW, bottom: pageCssH };
  }

  return {
    left:   Math.max(0,        visLeft   - TILE_MARGIN_CSS),
    top:    Math.max(0,        visTop    - TILE_MARGIN_CSS),
    right:  Math.min(pageCssW, visRight  + TILE_MARGIN_CSS),
    bottom: Math.min(pageCssH, visBottom + TILE_MARGIN_CSS),
  };
}

/**
 * Return the clockwise rotation (degrees) for a page.
 *
 * @param pageIndex - Zero-based page index; defaults to `currentPage`.
 * @returns Rotation value from {@link pageRotations}, or `0` if none was set.
 */
function getRotation(pageIndex = currentPage): number {
  return pageRotations.get(pageIndex) ?? 0;
}

/**
 * Return the display dimensions of a page in PDF user-space units.
 *
 * Results are cached in {@link pageDimensionsCache}.  Width and height are
 * swapped when the page rotation is 90° or 270°.
 *
 * @param pageIndex - Zero-based page index.
 * @returns `{ width, height }` in PDF user-space units after rotation.
 */
function getPageDimensions(pageIndex: number): { width: number; height: number } {
  const cached = pageDimensionsCache.get(pageIndex);
  if (cached) return cached;
  if (!doc) return { width: 612, height: 792 };
  const page = doc.loadPage(pageIndex);
  const b = page.getBounds();
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  page.destroy();
  const rot = getRotation(pageIndex);
  const dims = rot === 90 || rot === 270
    ? { width: h, height: w }
    : { width: w, height: h };
  pageDimensionsCache.set(pageIndex, dims);
  return dims;
}

/**
 * Render the current page onto the single-page canvas.
 *
 * Computes the pixmap at the current render scale and rotation, writes the
 * image data to both the page canvas and the overlay canvas, then redraws
 * highlights and syncs sidebar state.
 */
function renderPage(): void {
  if (!doc || !mupdf) return;

  const page = doc.loadPage(currentPage);
  const b = page.getBounds();
  const pageW = b[2] - b[0];
  const pageH = b[3] - b[1];
  const rot = getRotation();

  const displayW = rot === 90 || rot === 270 ? pageH : pageW;
  const displayH = rot === 90 || rot === 270 ? pageW : pageH;
  renderScale = clampRenderScale(computeRenderScale(), displayW, displayH);
  const rotMatrix = mupdf.Matrix.rotate(rot);
  const matrix = mupdf.Matrix.concat(rotMatrix, mupdf.Matrix.scale(renderScale, renderScale));

  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
  const rgb = pixmap.getPixels();
  const pw = pixmap.getWidth();
  const ph = pixmap.getHeight();

  const rgba = new Uint8ClampedArray(pw * ph * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
  }

  canvas.width = pw;
  canvas.height = ph;
  canvas.style.width = `${Math.round(displayW * scale)}px`;
  canvas.style.height = `${Math.round(displayH * scale)}px`;

  overlayCanvas.width = pw;
  overlayCanvas.height = ph;
  overlayCanvas.style.width = canvas.style.width;
  overlayCanvas.style.height = canvas.style.height;

  ctx.putImageData(new ImageData(rgba, pw, ph), 0, 0);

  pixmap.destroy();
  page.destroy();

  drawHighlights();
  updateOutlineHighlight();
  syncThumbActive();
}

/**
 * Redraw all highlights (search and selection) on the appropriate overlay canvases.
 *
 * In scroll mode, refreshes the overlay for every rendered page.
 * In single-page mode, clears the overlay canvas and redraws both search and
 * selection highlights for the current page.
 */
function drawHighlights(): void {
  if (viewMode === 'scroll') {
    for (const pageIndex of renderedScrollPages) {
      refreshScrollPageOverlay(pageIndex);
    }
    return;
  }
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  drawSearchHighlights();
  drawSelectionHighlight();
}

/**
 * Paint search hit quads on the single-page overlay canvas.
 *
 * The active hit is rendered in a brighter orange; all others in translucent yellow.
 * Does nothing when there is no active search query or no hits on the current page.
 */
function drawSearchHighlights(): void {
  if (!searchQuery) return;
  const { width: pageW, height: pageH } = getPageDimensions(currentPage);
  const rot = getRotation();
  const hits = searchHits[currentPage];
  if (!hits?.length) return;

  for (let i = 0; i < hits.length; i++) {
    const isActive = i === getPageHitIndex();
    overlayCtx.fillStyle = isActive
      ? 'rgba(255, 120, 0, 0.45)'
      : 'rgba(255, 200, 0, 0.30)';
    for (const quad of hits[i]) {
      fillQuad(quad, pageW, pageH, rot);
    }
  }
}

/**
 * Map the global `searchHitIndex` to a page-local hit index for the current page.
 *
 * @returns The zero-based hit index within the current page's hit array,
 *          or `-1` if the active hit is on a different page.
 */
function getPageHitIndex(): number {
  if (searchHitIndex < 0) return -1;
  let idx = 0;
  for (let p = 0; p < currentPage; p++) {
    idx += searchHits[p]?.length ?? 0;
  }
  const local = searchHitIndex - idx;
  if (local < 0 || local >= (searchHits[currentPage]?.length ?? 0)) return -1;
  return local;
}

/**
 * Fill a single MuPDF quad on the single-page overlay canvas using the current fill style.
 *
 * Coordinates are in PDF user space and are converted to canvas device pixels
 * via {@link toCanvasCoord}.
 *
 * @param quad - Eight-value MuPDF quad `[ulX, ulY, urX, urY, llX, llY, lrX, lrY]` in PDF user space.
 * @param pageW - Unrotated page width in PDF user-space units.
 * @param pageH - Unrotated page height in PDF user-space units.
 * @param rot - Page rotation in degrees clockwise.
 */
function fillQuad(quad: MupdfTypes.Quad, pageW: number, pageH: number, rot: number): void {
  const ul = toCanvasCoord(quad[0], quad[1], pageW, pageH, renderScale, 1, rot);
  const ur = toCanvasCoord(quad[2], quad[3], pageW, pageH, renderScale, 1, rot);
  const ll = toCanvasCoord(quad[4], quad[5], pageW, pageH, renderScale, 1, rot);
  const lr = toCanvasCoord(quad[6], quad[7], pageW, pageH, renderScale, 1, rot);
  overlayCtx.beginPath();
  overlayCtx.moveTo(ul.x, ul.y);
  overlayCtx.lineTo(ur.x, ur.y);
  overlayCtx.lineTo(lr.x, lr.y);
  overlayCtx.lineTo(ll.x, ll.y);
  overlayCtx.closePath();
  overlayCtx.fill();
}

/**
 * Fill an array of pre-computed canvas-space quads onto a 2D context.
 *
 * Each quad is an eight-value array `[ulX, ulY, urX, urY, llX, llY, lrX, lrY]`
 * in canvas device pixels.  `tileAdjX`/`tileAdjY` shift all coordinates to
 * account for the tile's position within the page wrapper.
 *
 * @param ctx2d - The 2D rendering context to draw into.
 * @param quads - Array of eight-value quad arrays in canvas device pixels.
 * @param tileAdjX - Horizontal tile offset in canvas device pixels.
 * @param tileAdjY - Vertical tile offset in canvas device pixels.
 */
function drawCanvasQuads(
  ctx2d: CanvasRenderingContext2D,
  quads: number[][],
  tileAdjX = 0, tileAdjY = 0,
): void {
  ctx2d.fillStyle = 'rgba(0, 120, 215, 0.25)';
  for (const q of quads) {
    ctx2d.beginPath();
    ctx2d.moveTo(q[0] - tileAdjX, q[1] - tileAdjY);
    ctx2d.lineTo(q[2] - tileAdjX, q[3] - tileAdjY);
    ctx2d.lineTo(q[6] - tileAdjX, q[7] - tileAdjY);
    ctx2d.lineTo(q[4] - tileAdjX, q[5] - tileAdjY);
    ctx2d.closePath();
    ctx2d.fill();
  }
}

/**
 * Draw the current text selection highlight on the single-page overlay canvas.
 *
 * Does nothing when there is no active selection or when both indices are equal
 * (i.e. a zero-length selection from a click).
 */
function drawSelectionHighlight(): void {
  if (selectionStartIdx < 0 || selectionEndIdx < 0 || selectionStartIdx === selectionEndIdx) return;
  const chars = buildCharList(currentPage, renderScale, getRotation());
  const quads = computeSelectionQuads(chars, selectionStartIdx, selectionEndIdx);
  drawCanvasQuads(overlayCtx, quads);
}

/**
 * Open and display a PDF document from raw bytes.
 *
 * Handles password authentication, resets per-document state (rotations,
 * stext cache, search), applies default zoom from settings, builds the outline
 * tree, and starts the thumbnail worker.  Posts a `requestPassword` message to
 * the host when the document is encrypted and no password is provided.
 *
 * @param data - Raw PDF file bytes.
 * @param password - Optional decryption password.
 * @param settings - Optional viewer settings from the host (`defaultZoom`, `renderResolution`).
 */
function loadDocument(data: Uint8Array, password?: string, settings?: { defaultZoom?: number; renderResolution?: number }): void {
  if (!mupdf) return;
  if (doc) {
    doc.destroy();
    doc = null;
  }

  if (settings) defaultSettings = settings;

  try {
    const newDoc = mupdf.Document.openDocument(data, 'application/pdf');

    if (newDoc.needsPassword()) {
      if (!password) {
        vscode.postMessage({ type: 'requestPassword' });
        newDoc.destroy();
        return;
      }
      const result = newDoc.authenticatePassword(password);
      if (result === 0) {
        vscode.postMessage({ type: 'error', message: 'Incorrect PDF password.' });
        newDoc.destroy();
        return;
      }
    }

    doc = newDoc;
    totalPages = doc.countPages();
    pageRotations = new Map();
    pageDimensionsCache.clear();
    stextCache.forEach(s => s.destroy());
    stextCache.clear();

    const zoom = (settings ?? defaultSettings).defaultZoom;
    if (zoom && zoom > 0) {
      scale = zoom;
      zoomInput.value = `${Math.round(scale * 100)}%`;
    }

    if (currentPage >= totalPages) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;

    pageInput.max = String(totalPages);
    pageInput.value = String(currentPage + 1);
    pageCount.textContent = String(totalPages);

    const rawOutline = doc.loadOutline();
    if (rawOutline && rawOutline.length > 0) {
      const outlineNodes = buildOutlineTree(rawOutline);
      renderOutlineDOM(outlineNodes, outlinePanel, 0);
    } else {
      outlinePanel.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--vscode-descriptionForeground)">No outline</div>';
    }

    clearSearch();
    if (viewMode === 'scroll') {
      const savedScrollTop = canvasContainer.scrollTop;
      buildScrollContainer(savedScrollTop > 0 ? savedScrollTop : undefined);
    } else {
      renderPage();
    }
    startThumbnails(data);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.postMessage({ type: 'error', message: `Failed to open PDF: ${msg}` });
    showStatus(`Error: ${msg}`);
  }
}

/**
 * Render an {@link OutlineNode} tree into the sidebar as clickable DOM elements.
 *
 * Each node is a `div.outline-node` with an inline toggle arrow when it has
 * children.  Clicking a node navigates to its target page.
 *
 * @param nodes - Array of outline nodes to render.
 * @param container - The DOM element to render into (cleared first).
 * @param depth - Current nesting depth, used to compute left padding.
 */
function renderOutlineDOM(nodes: OutlineNode[], container: HTMLElement, depth: number): void {
  container.innerHTML = '';
  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = 'outline-node';
    item.style.paddingLeft = `${depth * 12 + 4}px`;
    item.dataset.page = String(node.page);

    const toggle = document.createElement('span');
    toggle.className = 'outline-toggle';
    if (node.children.length > 0) {
      toggle.textContent = '▶';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const childDiv = item.nextElementSibling as HTMLElement | null;
        if (childDiv?.classList.contains('outline-children')) {
          const hidden = childDiv.style.display === 'none';
          childDiv.style.display = hidden ? '' : 'none';
          toggle.textContent = hidden ? '▼' : '▶';
        }
      });
    }
    item.appendChild(toggle);

    const label = document.createElement('span');
    label.textContent = node.title;
    item.appendChild(label);

    item.addEventListener('click', () => goToPage(node.page));
    container.appendChild(item);

    if (node.children.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'outline-children';
      renderOutlineDOM(node.children, childContainer, depth + 1);
      container.appendChild(childContainer);
    }
  }
}

/**
 * Highlight the outline node that best matches the current page.
 *
 * Selects the node whose page number is the greatest value ≤ `currentPage`.
 * All other nodes have the `active` class removed.
 */
function updateOutlineHighlight(): void {
  const allNodes = outlinePanel.querySelectorAll<HTMLElement>('.outline-node[data-page]');
  let best: HTMLElement | null = null;
  let bestPage = -1;
  for (const n of allNodes) {
    const p = parseInt(n.dataset.page ?? '-1');
    if (p <= currentPage && p > bestPage) {
      bestPage = p;
      best = n;
    }
  }
  for (const n of allNodes) n.classList.remove('active');
  if (best) best.classList.add('active');
}

/**
 * Navigate to a page by zero-based index, clamping to the valid range.
 *
 * Updates `currentPage`, the page-number input, and either scrolls to the
 * page (scroll mode) or re-renders (single-page mode).
 *
 * @param pageIndex - Target zero-based page index.
 */
function goToPage(pageIndex: number): void {
  if (!doc) return;
  const clamped = Math.max(0, Math.min(totalPages - 1, pageIndex));
  currentPage = clamped;
  pageInput.value = String(clamped + 1);
  if (viewMode === 'scroll') {
    scrollToPage(clamped);
  } else {
    renderPage();
  }
}

/**
 * Compute the scale that makes the current page fill the container width.
 *
 * @returns The fit-width scale, or the current `scale` if no document is loaded.
 */
function fitWidthScale(): number {
  if (!doc) return scale;
  const { width } = getPageDimensions(currentPage);
  return (canvasContainer.clientWidth - 32) / width;
}

/**
 * Compute the scale that makes the current page fit entirely within the container.
 *
 * @returns The fit-page scale (minimum of fit-width and fit-height), or the
 *          current `scale` if no document is loaded.
 */
function fitPageScale(): number {
  if (!doc) return scale;
  const { width, height } = getPageDimensions(currentPage);
  const fw = (canvasContainer.clientWidth - 32) / width;
  return Math.min(fw, (canvasContainer.clientHeight - 32) / height);
}

const BASE_ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0, 48.0, 64.0];

/**
 * Build the list of discrete zoom step values, including fit-width and fit-page.
 *
 * Merges {@link BASE_ZOOM_STEPS} with the two computed fit scales, deduplicates
 * values that are within 0.01 of each other, and clamps everything to [0.05, 64].
 *
 * @returns Sorted, deduplicated array of zoom step values.
 */
function buildZoomSteps(): number[] {
  const extras = doc ? [fitWidthScale(), fitPageScale()] : [];
  const all = [...BASE_ZOOM_STEPS, ...extras]
    .map(s => Math.max(0.05, Math.min(64,s)))
    .sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > 0.01);
}

/**
 * Step the zoom level one increment in the given direction.
 *
 * Finds the next/previous value in the {@link buildZoomSteps} list relative
 * to the current scale and calls {@link applyScale}.
 *
 * @param dir - `1` to zoom in, `-1` to zoom out.
 */
function stepScale(dir: 1 | -1): void {
  const steps = buildZoomSteps();
  let idx = -1;
  if (dir > 0) {
    idx = steps.findIndex(s => s > scale + 0.0001);
  } else {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i] < scale - 0.0001) { idx = i; break; }
    }
  }
  if (idx >= 0) applyScale(steps[idx]);
}

/**
 * Apply a new zoom scale, update the toolbar input, detect fit-mode changes,
 * and re-render the current view.
 *
 * @param newScale - The target scale value (clamped to [0.05, 64]).
 */
function applyScale(newScale: number): void {
  scale = Math.max(0.05, Math.min(64,newScale));
  zoomInput.value = `${Math.round(scale * 100)}%`;
  const fw = doc ? fitWidthScale() : -1;
  const fp = doc ? fitPageScale() : -1;
  const detected: FitMode = scale === fp ? 'page' : scale === fw ? 'width' : 'none';
  if (detected !== fitMode) {
    fitMode = detected;
    btnFitWidth.classList.toggle('active', fitMode === 'width');
    btnFitPage.classList.toggle('active', fitMode === 'page');
  }
  if (viewMode === 'scroll') updateScrollModeZoom();
  else renderPage();
}

/**
 * Set the zoom scale.  Alias for {@link applyScale}.
 *
 * @param newScale - The target scale value.
 */
function setScale(newScale: number): void {
  applyScale(newScale);
}

/** Zoom to fit the current page width in the container. */
function fitWidth(): void {
  if (!doc) return;
  const { width } = getPageDimensions(currentPage);
  applyScale((canvasContainer.clientWidth - 32) / width);
}

/** Zoom to fit the entire current page in the container. */
function fitPage(): void {
  if (!doc) return;
  const { width, height } = getPageDimensions(currentPage);
  applyScale(Math.min(
    (canvasContainer.clientWidth - 32) / width,
    (canvasContainer.clientHeight - 32) / height,
  ));
}

/**
 * Re-apply the current fit mode, if any.
 *
 * Called by the `ResizeObserver` when the container changes size so that
 * fit-width and fit-page modes track the new dimensions.
 */
function applyFit(): void {
  if (fitMode === 'width') fitWidth();
  else if (fitMode === 'page') fitPage();
}

/**
 * Set the active fit mode and update toolbar button states.
 *
 * @param mode - The fit mode to activate (`'none'`, `'width'`, or `'page'`).
 */
function setFitMode(mode: FitMode): void {
  fitMode = mode;
  btnFitWidth.classList.toggle('active', mode === 'width');
  btnFitPage.classList.toggle('active', mode === 'page');
}

/**
 * Execute a function and then adjust the scroll position so that a chosen
 * viewport point appears to stay fixed in place.
 *
 * Records the content coordinate under the anchor point before calling `fn`,
 * then computes how far that coordinate moved and scrolls to compensate.
 * Used to keep the area under the mouse cursor stable during zoom operations.
 *
 * @param anchorViewportX - X position of the anchor in container-relative CSS pixels.
 * @param anchorViewportY - Y position of the anchor in container-relative CSS pixels.
 * @param fn - The operation to execute (typically a scale change).
 */
function withScrollAnchor(anchorViewportX: number, anchorViewportY: number, fn: () => void): void {
  if (!doc) { fn(); return; }
  const oldScale = scale;

  const containerRect = canvasContainer.getBoundingClientRect();
  const absX = containerRect.left + anchorViewportX;
  const absY = containerRect.top + anchorViewportY;

  let anchorWrapper: HTMLElement | null = null;
  let hFraction = 0;
  let vFraction = 0;

  if (viewMode === 'scroll' && totalPages > 0) {
    for (let i = 0; i < totalPages; i++) {
      const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${i}"]`);
      if (!wrapper) continue;
      const rect = wrapper.getBoundingClientRect();
      if (absY <= rect.bottom || i === totalPages - 1) {
        anchorWrapper = wrapper;
        hFraction = rect.width  > 0 ? (absX - rect.left) / rect.width  : 0;
        vFraction = rect.height > 0 ? (absY - rect.top)  / rect.height : 0;
        break;
      }
    }
  }

  fn();

  if (scale === oldScale) return;

  if (viewMode === 'scroll' && anchorWrapper) {
    const newRect = anchorWrapper.getBoundingClientRect();
    const newAbsX = newRect.left + hFraction * newRect.width;
    const newAbsY = newRect.top  + vFraction * newRect.height;
    canvasContainer.scrollLeft += newAbsX - absX;
    canvasContainer.scrollTop  += newAbsY - absY;
  } else {
    const ratio = scale / oldScale;
    canvasContainer.scrollLeft = (canvasContainer.scrollLeft + anchorViewportX) * ratio - anchorViewportX;
    canvasContainer.scrollTop  = (canvasContainer.scrollTop  + anchorViewportY) * ratio - anchorViewportY;
  }
}

/**
 * Clear the active search, cancelling any pending idle-callback searches.
 *
 * Resets `searchQuery`, `searchHits`, `searchHitIndex`, and the info label,
 * and erases search highlights from the overlay canvas.
 */
function clearSearch(): void {
  searchQuery = '';
  searchHits = [];
  searchHitIndex = -1;
  searchInfo.textContent = '';
  if (searchIdleHandle !== null) {
    cancelIdleCallback(searchIdleHandle);
    searchIdleHandle = null;
  }
  clearSearchHighlights();
}

/** Erase all search highlights from the single-page overlay canvas. */
function clearSearchHighlights(): void {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

/**
 * Start an incremental search for `query` across the document.
 *
 * Searches the current page synchronously so highlights appear immediately,
 * then schedules the remaining pages via `requestIdleCallback` to avoid
 * blocking the main thread.
 *
 * @param query - The search string.  An empty string clears the search.
 */
function startSearch(query: string): void {
  clearSearch();
  if (!query || !doc) return;
  searchQuery = query;
  searchHits = Array.from({ length: totalPages }, () => []);

  searchPageNow(currentPage);
  updateSearchInfo();
  drawHighlights();

  let pageToSearch = 0;
  const tick = (deadline: IdleDeadline) => {
    while (deadline.timeRemaining() > 1 && pageToSearch < totalPages) {
      if (pageToSearch !== currentPage) searchPageNow(pageToSearch);
      pageToSearch++;
    }
    if (pageToSearch < totalPages) {
      searchIdleHandle = requestIdleCallback(tick);
    } else {
      searchIdleHandle = null;
      updateSearchInfo();
    }
  };
  searchIdleHandle = requestIdleCallback(tick);
}

/**
 * Search a single page and store the results in `searchHits[pageIndex]`.
 *
 * Silently ignores errors (e.g. pages with no text layer).
 *
 * @param pageIndex - Zero-based page index to search.
 */
function searchPageNow(pageIndex: number): void {
  if (!doc || !searchQuery) return;
  const page = doc.loadPage(pageIndex);
  try {
    searchHits[pageIndex] = page.search(searchQuery);
  } catch (_e) {
    searchHits[pageIndex] = [];
  } finally {
    page.destroy();
  }
}

/**
 * Return the total number of search hits across all pages.
 *
 * @returns Sum of hit counts for every page.
 */
function getTotalHits(): number {
  return searchHits.reduce((s, h) => s + h.length, 0);
}

/**
 * Update the search-info label with the current hit count and active index.
 *
 * Shows `"No matches"` when the query yields no results, `"- / N"` before
 * the user has navigated to any hit, or `"M / N"` when a specific hit is active.
 */
function updateSearchInfo(): void {
  const total = getTotalHits();
  if (!searchQuery) { searchInfo.textContent = ''; return; }
  searchInfo.textContent = total === 0
    ? 'No matches'
    : searchHitIndex < 0
      ? `- / ${total}`
      : `${searchHitIndex + 1} / ${total}`;
}

/**
 * Move to the next or previous search hit, wrapping around the document.
 *
 * Navigates to the page containing the target hit and redraws overlays.
 *
 * @param dir - `1` for the next hit, `-1` for the previous hit.
 */
function navigateSearch(dir: 1 | -1): void {
  const total = getTotalHits();
  if (total === 0) return;
  const base = searchHitIndex < 0 ? (dir > 0 ? -1 : total) : searchHitIndex;
  searchHitIndex = ((base + dir) % total + total) % total;
  updateSearchInfo();

  let idx = 0;
  for (let p = 0; p < totalPages; p++) {
    const n = searchHits[p]?.length ?? 0;
    if (idx + n > searchHitIndex) {
      if (viewMode === 'scroll') {
        if (p !== currentPage) {
          currentPage = p;
          pageInput.value = String(p + 1);
          scrollToPage(p);
        }
        refreshScrollPageOverlay(p);
      } else {
        if (p !== currentPage) {
          currentPage = p;
          pageInput.value = String(p + 1);
          renderPage();
        } else {
          drawHighlights();
        }
      }
      return;
    }
    idx += n;
  }
}

/**
 * Convert a CSS-pixel position on the single-page canvas to PDF user-space.
 *
 * @param cssX - X in CSS pixels relative to the canvas element.
 * @param cssY - Y in CSS pixels relative to the canvas element.
 * @returns A MuPDF `Point` `[x, y]` in PDF user space.
 */
function canvasToPdf(cssX: number, cssY: number): MupdfTypes.Point {
  const { width: w, height: h } = getPageDimensions(currentPage);
  const pt = toPdfCoord(cssX * renderScale / scale, cssY * renderScale / scale, w, h, renderScale, 1, getRotation());
  return [pt.x, pt.y];
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  selectionPage = currentPage;
  selectionStartIdx = -1;
  selectionEndIdx = -1;
  const r = canvas.getBoundingClientRect();
  const devX = (e.clientX - r.left) * renderScale / scale;
  const devY = (e.clientY - r.top)  * renderScale / scale;
  selectionPageChars = buildCharList(currentPage, renderScale, getRotation());
  selectionStartIdx = findClosestChar(selectionPageChars, devX, devY);
  selectionEndIdx = selectionStartIdx;
  isDragging = true;
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const r = canvas.getBoundingClientRect();
  const devX = (e.clientX - r.left) * renderScale / scale;
  const devY = (e.clientY - r.top)  * renderScale / scale;
  selectionEndIdx = findClosestChar(selectionPageChars, devX, devY);
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    clearSearchHighlights();
    drawSearchHighlights();
    drawSelectionHighlight();
  });
});

canvas.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  if (e.button === 0 && selectionStartIdx === selectionEndIdx) {
    selectionStartIdx = -1;
    selectionEndIdx = -1;
    selectionPageChars = [];
    handleLinkClick(e);
  }
});

scrollContainer.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const wrapper = (e.target as HTMLElement).closest('.scroll-page') as HTMLElement | null;
  if (!wrapper) return;
  const pageIndex = parseInt(wrapper.dataset.page!);
  const prevPage = selectionPage;
  selectionPage = pageIndex;
  selectionStartIdx = -1;
  selectionEndIdx = -1;
  selectionPageChars = [];
  if (prevPage !== pageIndex) refreshScrollPageOverlay(prevPage);
  const r = wrapper.getBoundingClientRect();
  const rs = pageRenderScales.get(pageIndex) ?? computeRenderScale();
  const rot = getRotation(pageIndex);
  const devX = (e.clientX - r.left) * rs / scale;
  const devY = (e.clientY - r.top)  * rs / scale;
  selectionPageChars = buildCharList(pageIndex, rs, rot);
  selectionStartIdx = findClosestChar(selectionPageChars, devX, devY);
  selectionEndIdx = selectionStartIdx;
  isDragging = true;
});

scrollContainer.addEventListener('mousemove', (e) => {
  if (!isDragging || viewMode !== 'scroll') return;
  const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${selectionPage}"]`);
  if (!wrapper) return;
  const r = wrapper.getBoundingClientRect();
  const rs = pageRenderScales.get(selectionPage) ?? computeRenderScale();
  const devX = (e.clientX - r.left) * rs / scale;
  const devY = (e.clientY - r.top)  * rs / scale;
  selectionEndIdx = findClosestChar(selectionPageChars, devX, devY);
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    refreshScrollPageOverlay(selectionPage);
  });
});

scrollContainer.addEventListener('mouseup', (e) => {
  if (!isDragging || viewMode !== 'scroll') return;
  isDragging = false;
  if (e.button === 0 && selectionStartIdx === selectionEndIdx) {
    selectionStartIdx = -1;
    selectionEndIdx = -1;
    selectionPageChars = [];
    refreshScrollPageOverlay(selectionPage);
  }
});

document.addEventListener('keydown', async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    await copySelection();
  }
});

/**
 * Copy the currently selected text to the clipboard.
 *
 * Does nothing when there is no active selection.  Shows a status message on
 * success and posts an error message to the host on failure.
 */
async function copySelection(): Promise<void> {
  if (selectionStartIdx < 0 || selectionEndIdx < 0 || selectionStartIdx === selectionEndIdx) return;
  const text = extractSelectedText(selectionPageChars, selectionStartIdx, selectionEndIdx);
  if (text.trim()) {
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Copied to clipboard');
    } catch (_e) {
      vscode.postMessage({ type: 'error', message: 'Failed to copy text' });
    }
  }
}

/**
 * Return the PNG bytes of the image block that contains a given stext-space point.
 *
 * Re-parses the page with `preserve-images` to obtain image bounding boxes in
 * stext coordinates, then tests each image block against `(stextX, stextY)`.
 *
 * @param pageIndex - Zero-based page index.
 * @param stextX - X coordinate in stext space.
 * @param stextY - Y coordinate in stext space.
 * @returns PNG bytes of the first matching image, or `null` if none found.
 */
function extractImagePngAtPoint(pageIndex: number, stextX: number, stextY: number): Uint8Array | null {
  if (!doc || !mupdf) return null;
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText('preserve-images');
  page.destroy();
  let result: Uint8Array | null = null;
  stext.walk({
    onImageBlock(bbox: MupdfTypes.Rect, _transform: MupdfTypes.Matrix, image: MupdfTypes.Image) {
      if (result) return;
      const x0 = Math.min(bbox[0], bbox[2]);
      const y0 = Math.min(bbox[1], bbox[3]);
      const x1 = Math.max(bbox[0], bbox[2]);
      const y1 = Math.max(bbox[1], bbox[3]);
      if (stextX >= x0 && stextX <= x1 && stextY >= y0 && stextY <= y1) {
        const pixmap = image.toPixmap();
        result = pixmap.asPNG();
        pixmap.destroy();
      }
    },
  });
  stext.destroy();
  return result;
}

/**
 * Convert a wrapper-relative CSS position to stext space for a scroll-mode page.
 *
 * Converts CSS pixels → canvas device pixels via the page render scale, then
 * calls {@link toPdfCoord} (PDF user space, y-UP), and finally mirrors the
 * y-axis to produce stext space (y-DOWN).
 *
 * @param cssX - X in CSS pixels relative to the page wrapper.
 * @param cssY - Y in CSS pixels relative to the page wrapper.
 * @param pageIndex - Zero-based page index.
 * @param rs - Render scale in effect for the page.
 * @returns `[stextX, stextY]` in stext coordinate space.
 */
function cssToStext(cssX: number, cssY: number, pageIndex: number, rs: number): [number, number] {
  const { width: pageW, height: pageH } = getPageDimensions(pageIndex);
  const rot = getRotation(pageIndex);
  const pt = toPdfCoord(cssX * rs / scale, cssY * rs / scale, pageW, pageH, rs, 1, rot);
  return [pt.x, pageH - pt.y];
}

/**
 * Write PNG bytes to the system clipboard as an image.
 *
 * Shows a status message on success and posts an error to the host on failure.
 *
 * @param pngBytes - Raw PNG image data.
 */
async function copyPngToClipboard(pngBytes: Uint8Array): Promise<void> {
  const blob = new Blob([pngBytes], { type: 'image/png' });
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showStatus('Image copied to clipboard');
  } catch (_e) {
    vscode.postMessage({ type: 'error', message: 'Failed to copy image' });
  }
}

const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.style.display = 'none';
document.body.appendChild(ctxMenu);

/**
 * Show a custom context menu at the given viewport position.
 *
 * The menu is repositioned if it would overflow the viewport edges.
 * A `mousedown` on any item fires its action and hides the menu.
 *
 * @param x - Viewport X position for the menu's top-left corner.
 * @param y - Viewport Y position for the menu's top-left corner.
 * @param items - Menu items, each with a `label` and an `action` callback.
 */
function showContextMenu(x: number, y: number, items: { label: string; action: () => void }[]): void {
  ctxMenu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-menu-item';
    el.textContent = item.label;
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      hideContextMenu();
      item.action();
    });
    ctxMenu.appendChild(el);
  }
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top  = `${y}px`;
  requestAnimationFrame(() => {
    const r = ctxMenu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  ctxMenu.style.left = `${x - r.width}px`;
    if (r.bottom > window.innerHeight) ctxMenu.style.top  = `${y - r.height}px`;
  });
}

/** Hide the custom context menu. */
function hideContextMenu(): void {
  ctxMenu.style.display = 'none';
}

document.addEventListener('mousedown', () => hideContextMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

/**
 * Handle a right-click on a page canvas.
 *
 * If the click lands on an image block, shows a context menu with a
 * "Copy Image" option.  Does nothing when no image is found at the point.
 *
 * @param e - The original `contextmenu` event.
 * @param pageIndex - Zero-based page index where the click occurred.
 * @param stextX - Click X in stext space.
 * @param stextY - Click Y in stext space.
 */
function handleContextMenu(e: MouseEvent, pageIndex: number, stextX: number, stextY: number): void {
  const pngBytes = extractImagePngAtPoint(pageIndex, stextX, stextY);
  if (!pngBytes) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Copy Image', action: () => copyPngToClipboard(pngBytes) },
  ]);
}

/**
 * Handle a double-click on a page canvas by selecting the word under the cursor.
 *
 * Uses {@link expandWordAtChar} to extend the selection to word boundaries and
 * then redraws the appropriate overlay.
 *
 * @param pageIndex - Zero-based page index where the double-click occurred.
 * @param devX - Click X in canvas device pixels.
 * @param devY - Click Y in canvas device pixels.
 * @param isScrollMode - `true` when the event originated from the scroll container.
 */
async function handleDoubleClick(
  pageIndex: number,
  devX: number, devY: number,
  isScrollMode: boolean,
): Promise<void> {
  const rs = isScrollMode ? (pageRenderScales.get(pageIndex) ?? computeRenderScale()) : renderScale;
  const rot = getRotation(pageIndex);
  const chars = buildCharList(pageIndex, rs, rot);
  const idx = findClosestChar(chars, devX, devY);
  if (idx < 0) return;
  const [lo, hi] = expandWordAtChar(chars, idx);
  if (lo < 0) return;

  const prevPage = selectionPage;
  selectionPage = pageIndex;
  selectionPageChars = chars;
  selectionStartIdx = lo;
  selectionEndIdx = hi;

  if (isScrollMode) {
    if (prevPage !== pageIndex) refreshScrollPageOverlay(prevPage);
    refreshScrollPageOverlay(pageIndex);
  } else {
    drawHighlights();
  }
}

canvas.addEventListener('contextmenu', (e) => {
  if (!doc) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const cssX = e.clientX - r.left;
  const cssY = e.clientY - r.top;
  const [sx, sy] = cssToStext(cssX, cssY, currentPage, renderScale);
  handleContextMenu(e, currentPage, sx, sy);
});

canvas.addEventListener('dblclick', async (e) => {
  if (!doc) return;
  const r = canvas.getBoundingClientRect();
  const cssX = e.clientX - r.left;
  const cssY = e.clientY - r.top;
  const devX = cssX * renderScale / scale;
  const devY = cssY * renderScale / scale;
  await handleDoubleClick(currentPage, devX, devY, false);
});

scrollContainer.addEventListener('contextmenu', (e) => {
  if (!doc) return;
  const wrapper = (e.target as HTMLElement).closest('.scroll-page') as HTMLElement | null;
  if (!wrapper) return;
  const pageIndex = parseInt(wrapper.dataset.page!);
  const r = wrapper.getBoundingClientRect();
  const cssX = e.clientX - r.left;
  const cssY = e.clientY - r.top;
  const rs = pageRenderScales.get(pageIndex) ?? computeRenderScale();
  const [sx, sy] = cssToStext(cssX, cssY, pageIndex, rs);
  handleContextMenu(e, pageIndex, sx, sy);
});

scrollContainer.addEventListener('dblclick', async (e) => {
  if (!doc) return;
  const wrapper = (e.target as HTMLElement).closest('.scroll-page') as HTMLElement | null;
  if (!wrapper) return;
  const pageIndex = parseInt(wrapper.dataset.page!);
  const r = wrapper.getBoundingClientRect();
  const cssX = e.clientX - r.left;
  const cssY = e.clientY - r.top;
  const rs = pageRenderScales.get(pageIndex) ?? computeRenderScale();
  const devX = cssX * rs / scale;
  const devY = cssY * rs / scale;
  await handleDoubleClick(pageIndex, devX, devY, true);
});

/**
 * Resolve a left-click on the single-page canvas as a link activation.
 *
 * Converts the click position to PDF user space and tests it against every
 * link on the current page.  External URIs are opened in the default browser
 * via the host; internal destinations navigate to the target page.
 *
 * @param e - The original `mouseup` event.
 */
function handleLinkClick(e: MouseEvent): void {
  if (!doc) return;
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * renderScale / scale;
  const cy = (e.clientY - r.top) * renderScale / scale;
  const { width: pw, height: ph } = getPageDimensions(currentPage);
  const pt = toPdfCoord(cx, cy, pw, ph, renderScale, 1, getRotation());

  const page = doc.loadPage(currentPage);
  const links = page.getLinks();
  page.destroy();

  for (const link of links) {
    const b = link.getBounds();
    if (pt.x >= Math.min(b[0], b[2]) && pt.x <= Math.max(b[0], b[2]) &&
        pt.y >= Math.min(b[1], b[3]) && pt.y <= Math.max(b[1], b[3])) {
      const uri = link.getURI();
      if (link.isExternal()) {
        vscode.postMessage({ type: 'openExternal', url: uri });
      } else {
        try {
          const dest = doc.resolveLinkDestination(uri);
          goToPage(dest.page);
        } catch (_e) {
          const match = uri.match(/#page=(\d+)/i);
          if (match) goToPage(parseInt(match[1]) - 1);
        }
      }
      return;
    }
  }
}

/**
 * Initialise (or reinitialise) the thumbnail worker and sidebar panel.
 *
 * Terminates any existing worker, clears the thumbnail panel, creates
 * placeholder elements for every page, fetches the worker script as a blob URL
 * to work around VS Code webview CSP restrictions, and starts an
 * `IntersectionObserver` that dispatches render requests as thumbnails scroll
 * into view.
 *
 * @param data - Raw PDF file bytes to send to the worker.
 */
function startThumbnails(data: Uint8Array): void {
  if (worker) { worker.terminate(); worker = null; }
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  thumbsPanel.innerHTML = '';

  for (let i = 0; i < totalPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.page = String(i);
    item.dataset.rendered = 'false';
    if (i === currentPage) item.classList.add('active');

    const placeholder = document.createElement('div');
    placeholder.className = 'thumb-placeholder';
    item.appendChild(placeholder);

    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = String(i + 1);
    item.appendChild(label);

    item.addEventListener('click', () => goToPage(i));
    thumbsPanel.appendChild(item);
  }

  fetch(window.WORKER_URI)
    .then((r) => r.blob())
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl, { type: 'module' });
      URL.revokeObjectURL(blobUrl);
      worker.postMessage({
        type: 'init',
        mupdfUri: window.MUPDF_JS_URI,
        wasmUri: window.WASM_URI,
        data,
      });

      worker.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          thumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const el = entry.target as HTMLElement;
              if (el.dataset.rendered === 'true') continue;
              el.dataset.rendered = 'true';
              thumbObserver!.unobserve(el);
              worker!.postMessage({ type: 'render', page: parseInt(el.dataset.page!) });
            }
          }, { root: null, rootMargin: '200px' });

          for (const child of thumbsPanel.children) {
            thumbObserver.observe(child);
          }
        } else if (msg.type === 'thumb' && typeof msg.page === 'number' && typeof msg.dataUrl === 'string') {
          applyThumbnail(msg.page, msg.dataUrl);
        }
      });

      worker.addEventListener('error', (e) => {
        console.error('Thumbnail worker error:', e.message);
      });
    })
    .catch((err) => {
      console.error('[pdf-viewer] Failed to load worker:', err);
    });
}

/**
 * Replace the placeholder for a thumbnail item with the rendered image.
 *
 * @param pageIndex - Zero-based page index.
 * @param dataUrl - Base64 JPEG data URL produced by the thumbnail worker.
 */
function applyThumbnail(pageIndex: number, dataUrl: string): void {
  const item = thumbsPanel.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
  if (!item) return;
  item.innerHTML = '';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = `Page ${pageIndex + 1}`;
  item.appendChild(img);

  const label = document.createElement('span');
  label.className = 'thumb-label';
  label.textContent = String(pageIndex + 1);
  item.appendChild(label);
}

/**
 * Update the `active` CSS class on thumbnail items to reflect `currentPage`.
 */
function syncThumbActive(): void {
  const all = thumbsPanel.querySelectorAll<HTMLElement>('.thumb-item');
  for (const el of all) {
    el.classList.toggle('active', el.dataset.page === String(currentPage));
  }
}

document.addEventListener('keydown', (e) => {
  if (
    document.activeElement === searchInput ||
    document.activeElement === pageInput
  ) return;

  switch (e.key) {
    case 'PageDown': case 'ArrowRight': goToPage(currentPage + 1); break;
    case 'PageUp':   case 'ArrowLeft':  goToPage(currentPage - 1); break;
    case '+': case '=': withScrollAnchor(0, 0, () => stepScale(1)); break;
    case '-':           withScrollAnchor(0, 0, () => stepScale(-1)); break;
  }
});

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = canvasContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  withScrollAnchor(mouseX, mouseY, () => stepScale(e.deltaY > 0 ? -1 : 1));
}, { passive: false });

let pageScrollCooldown = false;
canvasContainer.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  if (viewMode !== 'single') return;
  e.preventDefault();
  if (pageScrollCooldown) return;
  goToPage(currentPage + (e.deltaY > 0 ? 1 : -1));
  pageScrollCooldown = true;
  setTimeout(() => { pageScrollCooldown = false; }, 200);
}, { passive: false });

pageInput.addEventListener('wheel', (e) => {
  e.preventDefault();
  goToPage(currentPage + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

zoomInput.addEventListener('wheel', (e) => {
  e.preventDefault();
  withScrollAnchor(0, 0, () => stepScale(e.deltaY > 0 ? -1 : 1));
}, { passive: false });

document.getElementById('btn-prev')!.addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('btn-next')!.addEventListener('click', () => goToPage(currentPage + 1));

pageInput.addEventListener('change', () => goToPage(parseInt(pageInput.value) - 1));
pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToPage(parseInt(pageInput.value) - 1); });

document.getElementById('btn-zoom-in')!.addEventListener('click', () => withScrollAnchor(0, 0, () => stepScale(1)));
document.getElementById('btn-zoom-out')!.addEventListener('click', () => withScrollAnchor(0, 0, () => stepScale(-1)));
btnFitWidth.addEventListener('click', () => {
  setFitMode(fitMode === 'width' ? 'none' : 'width');
  applyFit();
});
btnFitPage.addEventListener('click', () => {
  setFitMode(fitMode === 'page' ? 'none' : 'page');
  applyFit();
});

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
new ResizeObserver(() => {
  if (fitMode === 'none') return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyFit, 50);
}).observe(canvasContainer);

/**
 * Parse and apply the value entered in the zoom input field.
 *
 * Accepts either a percentage string (e.g. `"150%"`) or a decimal (e.g.
 * `"1.5"`).  Values ≤ 2 are treated as scale multipliers; values > 2 are
 * treated as percentages and divided by 100.  Invalid input restores the
 * current zoom.
 */
function applyZoomInput(): void {
  const raw = zoomInput.value.trim().replace('%', '');
  const v = parseFloat(raw);
  if (!isFinite(v) || v <= 0) {
    zoomInput.value = `${Math.round(scale * 100)}%`;
    return;
  }
  withScrollAnchor(0, 0, () => setScale(v <= 2 ? v : v / 100));
}

zoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyZoomInput(); zoomInput.blur(); }
  else if (e.key === 'Escape') { zoomInput.value = `${Math.round(scale * 100)}%`; zoomInput.blur(); }
});
zoomInput.addEventListener('blur', applyZoomInput);
zoomInput.addEventListener('focus', () => {
  zoomInput.value = String(Math.round(scale * 100));
  zoomInput.select();
});

document.getElementById('btn-rotate')!.addEventListener('click', () => {
  pageRotations.set(currentPage, (getRotation() + 90) % 360);
  pageDimensionsCache.delete(currentPage);
  stextCache.get(currentPage)?.destroy();
  stextCache.delete(currentPage);
  if (viewMode === 'scroll') {
    renderedScrollPages.delete(currentPage);
    renderScrollPage(currentPage);
  } else {
    renderPage();
  }
});

btnThumbs.addEventListener('click', () => {
  setThumbsSidebarVisible(!thumbsSidebarVisible);
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => startSearch(searchInput.value.trim()), 300);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1); }
});
document.getElementById('btn-search-prev')!.addEventListener('click', () => navigateSearch(-1));
document.getElementById('btn-search-next')!.addEventListener('click', () => navigateSearch(1));

btnViewMode.addEventListener('click', () => {
  setViewMode(viewMode === 'single' ? 'scroll' : 'single');
});

btnSidebar.addEventListener('click', () => {
  setSidebarVisible(!sidebarVisible);
});

/**
 * Show or hide the outline sidebar and update the toolbar button state.
 *
 * @param visible - `true` to show, `false` to hide.
 */
function setSidebarVisible(visible: boolean): void {
  sidebarVisible = visible;
  sidebar.classList.toggle('hidden', !visible);
  btnSidebar.classList.toggle('active', visible);
}

/**
 * Show or hide the thumbnails sidebar and update the toolbar button state.
 *
 * @param visible - `true` to show, `false` to hide.
 */
function setThumbsSidebarVisible(visible: boolean): void {
  thumbsSidebarVisible = visible;
  thumbsSidebar.classList.toggle('hidden', !visible);
  btnThumbs.classList.toggle('active', visible);
}

canvasWrapper.style.display = 'none';
scrollContainer.style.display = '';
canvasContainer.style.justifyContent = 'flex-start';
canvasContainer.style.alignItems = 'flex-start';
btnViewMode.classList.add('active');
btnViewMode.title = 'Switch to single page view';
sidebar.classList.add('hidden');

canvasContainer.addEventListener('scroll', () => {
  if (viewMode !== 'scroll' || !doc) return;
  const containerRect = canvasContainer.getBoundingClientRect();
  const midY = containerRect.top + containerRect.height / 2;
  let bestPage = currentPage;
  let bestDist = Infinity;
  for (const child of scrollContainer.children) {
    const el = child as HTMLElement;
    const rect = el.getBoundingClientRect();
    const dist = Math.abs(rect.top + rect.height / 2 - midY);
    if (dist < bestDist) { bestDist = dist; bestPage = parseInt(el.dataset.page!); }
  }
  if (bestPage !== currentPage) {
    currentPage = bestPage;
    pageInput.value = String(bestPage + 1);
    updateOutlineHighlight();
    syncThumbActive();
  }
  if (scrollTileTimer) clearTimeout(scrollTileTimer);
  scrollTileTimer = setTimeout(checkAndRetileOnScroll, 100);
});

/**
 * Switch between single-page and continuous-scroll view modes.
 *
 * Swaps the visible container, resets observer state, and renders the current
 * page in the new mode.
 *
 * @param mode - The target view mode (`'single'` or `'scroll'`).
 */
function setViewMode(mode: ViewMode): void {
  if (viewMode === mode) return;
  viewMode = mode;
  if (mode === 'scroll') {
    canvasWrapper.style.display = 'none';
    scrollContainer.style.display = '';
    canvasContainer.style.justifyContent = 'flex-start';
    canvasContainer.style.alignItems = 'flex-start';
    btnViewMode.classList.add('active');
    btnViewMode.title = 'Switch to single page view';
    if (doc) buildScrollContainer();
  } else {
    scrollContainer.style.display = 'none';
    canvasWrapper.style.display = '';
    canvasContainer.style.justifyContent = '';
    canvasContainer.style.alignItems = '';
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
    renderedScrollPages.clear();
    btnViewMode.classList.remove('active');
    btnViewMode.title = 'Switch to scroll view';
    if (doc) renderPage();
  }
}

/**
 * (Re)build the scroll-mode page list from scratch.
 *
 * Creates a `div.scroll-page` wrapper with a canvas and overlay for every
 * page, attaches an `IntersectionObserver` to trigger lazy rendering, and
 * restores the previous scroll position when provided.
 *
 * @param restoreScrollTop - Optional `scrollTop` to restore after building,
 *   used when reloading a document while scroll mode is active.
 */
function buildScrollContainer(restoreScrollTop?: number): void {
  scrollContainer.innerHTML = '';
  renderedScrollPages.clear();
  pageTiles.clear();
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  for (let i = 0; i < totalPages; i++) {
    const { width: dimW, height: dimH } = getPageDimensions(i);
    const cssW = `${Math.round(dimW * scale)}px`;
    const cssH = `${Math.round(dimH * scale)}px`;

    const wrapper = document.createElement('div');
    wrapper.className = 'scroll-page';
    wrapper.dataset.page = String(i);
    wrapper.style.width = cssW;
    wrapper.style.height = cssH;

    const mc = document.createElement('canvas');
    mc.className = 'scroll-page-canvas';
    mc.style.position = 'absolute';
    mc.style.left = '0px'; mc.style.top = '0px';
    mc.style.width = cssW; mc.style.height = cssH;
    mc.width = Math.round(dimW);
    mc.height = Math.round(dimH);

    const oc = document.createElement('canvas');
    oc.className = 'scroll-page-overlay';
    oc.style.width = cssW; oc.style.height = cssH;
    oc.width = mc.width;
    oc.height = mc.height;

    wrapper.appendChild(mc);
    wrapper.appendChild(oc);
    scrollContainer.appendChild(wrapper);
  }

  scrollObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      const pageIndex = parseInt(el.dataset.page!);
      if (!renderedScrollPages.has(pageIndex)) {
        renderScrollPage(pageIndex);
      }
    }
  }, { root: canvasContainer, rootMargin: '400px' });

  for (const child of scrollContainer.children) {
    scrollObserver.observe(child as Element);
  }
  if (restoreScrollTop !== undefined) {
    canvasContainer.scrollTop = restoreScrollTop;
  } else {
    scrollToPage(currentPage);
  }
}

/**
 * Render a single scroll-mode page using a tile that covers the visible area
 * plus {@link TILE_MARGIN_CSS} pixels of margin on every side.
 *
 * Uses MuPDF's `DrawDevice` with a clipped pixmap so only the required region
 * is rasterised, keeping memory usage low at high zoom levels.  Stores
 * tile metadata in {@link pageTiles} and triggers an overlay refresh.
 *
 * @param pageIndex - Zero-based page index to render.
 */
function renderScrollPage(pageIndex: number): void {
  if (!doc || !mupdf) return;
  const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
  if (!wrapper) return;

  const page = doc.loadPage(pageIndex);
  const b = page.getBounds();
  const pageW = b[2] - b[0];
  const pageH = b[3] - b[1];
  const rot = getRotation(pageIndex);
  const displayW = rot === 90 || rot === 270 ? pageH : pageW;
  const displayH = rot === 90 || rot === 270 ? pageW : pageH;

  const tileCSS = getScrollPageTileCSS(pageIndex, displayW, displayH);
  const tileCssW = tileCSS.right  - tileCSS.left;
  const tileCssH = tileCSS.bottom - tileCSS.top;

  const rsBase = computeRenderScale();
  const rs = Math.min(
    rsBase,
    (MAX_PIXMAP_DIM / tileCssW) * scale,
    (MAX_PIXMAP_DIM / tileCssH) * scale,
  );
  pageRenderScales.set(pageIndex, rs);

  const matrix = mupdf.Matrix.concat(mupdf.Matrix.rotate(rot), mupdf.Matrix.scale(rs, rs));

  const fullDevBounds = mupdf.Rect.transform([b[0], b[1], b[2], b[3]] as MupdfTypes.Rect, matrix);
  const devScale = rs / scale;
  const tileDevBbox: MupdfTypes.Rect = [
    Math.floor(fullDevBounds[0] + tileCSS.left   * devScale),
    Math.floor(fullDevBounds[1] + tileCSS.top    * devScale),
    Math.ceil( fullDevBounds[0] + tileCSS.right  * devScale),
    Math.ceil( fullDevBounds[1] + tileCSS.bottom * devScale),
  ];

  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, tileDevBbox, false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(matrix, pixmap);
  page.runPageContents(device, mupdf.Matrix.identity);
  page.runPageAnnots(device, mupdf.Matrix.identity);
  device.close();
  device.destroy();

  const rgb = pixmap.getPixels();
  const pw  = pixmap.getWidth();
  const ph  = pixmap.getHeight();
  pixmap.destroy();
  page.destroy();

  const rgba = new Uint8ClampedArray(pw * ph * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
  }

  const mc = wrapper.querySelector<HTMLCanvasElement>('.scroll-page-canvas')!;
  const oc = wrapper.querySelector<HTMLCanvasElement>('.scroll-page-overlay')!;

  const tileW = `${Math.round(tileCssW)}px`;
  const tileH = `${Math.round(tileCssH)}px`;
  const tileL = `${Math.round(tileCSS.left)}px`;
  const tileT = `${Math.round(tileCSS.top)}px`;

  mc.width = pw; mc.height = ph;
  mc.style.position = 'absolute';
  mc.style.left = tileL; mc.style.top = tileT;
  mc.style.width = tileW; mc.style.height = tileH;

  oc.width = pw; oc.height = ph;
  oc.style.position = 'absolute';
  oc.style.left = tileL; oc.style.top = tileT;
  oc.style.width = tileW; oc.style.height = tileH;

  wrapper.style.width  = `${Math.round(displayW * scale)}px`;
  wrapper.style.height = `${Math.round(displayH * scale)}px`;

  mc.getContext('2d')!.putImageData(new ImageData(rgba, pw, ph), 0, 0);

  pageTiles.set(pageIndex, {
    cssLeft: tileCSS.left, cssTop: tileCSS.top,
    cssRight: tileCSS.right, cssBottom: tileCSS.bottom,
    rs,
    renderedAtScale: scale,
  });
  renderedScrollPages.add(pageIndex);
  refreshScrollPageOverlay(pageIndex);
}

/**
 * Redraw the search and selection highlights on a scroll-mode page's overlay canvas.
 *
 * Applies the tile offset (from {@link pageTiles}) so highlight coordinates
 * align with the clipped tile canvas.  Rebuilds the char list at the current
 * render scale rather than using a cached one so that rotation changes are
 * reflected immediately.
 *
 * @param pageIndex - Zero-based page index whose overlay to refresh.
 */
function refreshScrollPageOverlay(pageIndex: number): void {
  const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
  if (!wrapper) return;
  const oc = wrapper.querySelector<HTMLCanvasElement>('.scroll-page-overlay')!;
  const ctx2d = oc.getContext('2d')!;
  ctx2d.clearRect(0, 0, oc.width, oc.height);

  const { width: pageW, height: pageH } = getPageDimensions(pageIndex);
  const rot = getRotation(pageIndex);
  const rs = pageRenderScales.get(pageIndex) ?? computeRenderScale();

  const tileInfo = pageTiles.get(pageIndex);
  const tileAdjX = tileInfo ? tileInfo.cssLeft * rs / scale : 0;
  const tileAdjY = tileInfo ? tileInfo.cssTop  * rs / scale : 0;

  if (searchQuery) {
    const hits = searchHits[pageIndex];
    if (hits?.length) {
      let globalBase = 0;
      for (let p = 0; p < pageIndex; p++) globalBase += searchHits[p]?.length ?? 0;
      for (let i = 0; i < hits.length; i++) {
        const isActive = (globalBase + i) === searchHitIndex;
        ctx2d.fillStyle = isActive ? 'rgba(255,120,0,0.45)' : 'rgba(255,200,0,0.30)';
        for (const quad of hits[i]) {
          const ul = toCanvasCoord(quad[0], quad[1], pageW, pageH, rs, 1, rot);
          const ur = toCanvasCoord(quad[2], quad[3], pageW, pageH, rs, 1, rot);
          const ll = toCanvasCoord(quad[4], quad[5], pageW, pageH, rs, 1, rot);
          const lr = toCanvasCoord(quad[6], quad[7], pageW, pageH, rs, 1, rot);
          ctx2d.beginPath();
          ctx2d.moveTo(ul.x - tileAdjX, ul.y - tileAdjY);
          ctx2d.lineTo(ur.x - tileAdjX, ur.y - tileAdjY);
          ctx2d.lineTo(lr.x - tileAdjX, lr.y - tileAdjY);
          ctx2d.lineTo(ll.x - tileAdjX, ll.y - tileAdjY);
          ctx2d.closePath();
          ctx2d.fill();
        }
      }
    }
  }

  if (pageIndex === selectionPage && selectionStartIdx >= 0 && selectionEndIdx >= 0 && selectionStartIdx !== selectionEndIdx) {
    const chars = buildCharList(pageIndex, rs, rot);
    const quads = computeSelectionQuads(chars, selectionStartIdx, selectionEndIdx);
    drawCanvasQuads(ctx2d, quads, tileAdjX, tileAdjY);
  }
}

/**
 * Convert a wrapper-relative CSS position on a scroll-mode page to PDF user space.
 *
 * Accounts for the tile offset stored in {@link pageTiles} so that the result
 * is correct even when only a sub-region of the page has been rendered.
 *
 * @param pageIndex - Zero-based page index.
 * @param cssX - X in CSS pixels relative to the page wrapper.
 * @param cssY - Y in CSS pixels relative to the page wrapper.
 * @returns A MuPDF `Point` `[x, y]` in PDF user space.
 */
function scrollPageToPdf(pageIndex: number, cssX: number, cssY: number): MupdfTypes.Point {
  const { width: w, height: h } = getPageDimensions(pageIndex);
  const rot = getRotation(pageIndex);
  const rs = pageRenderScales.get(pageIndex) ?? computeRenderScale();
  const tileInfo = pageTiles.get(pageIndex);
  const tileAdjX = tileInfo ? tileInfo.cssLeft * rs / scale : 0;
  const tileAdjY = tileInfo ? tileInfo.cssTop  * rs / scale : 0;
  const pt = toPdfCoord(cssX * rs / scale + tileAdjX, cssY * rs / scale + tileAdjY, w, h, rs, 1, rot);
  return [pt.x, pt.y];
}

/**
 * Re-render any scroll-mode pages whose tile no longer covers the visible area.
 *
 * Called 100 ms after a scroll event.  For each rendered page, checks whether
 * the currently visible region extends outside the cached tile bounds and
 * triggers a fresh render if so.
 */
function checkAndRetileOnScroll(): void {
  scrollTileTimer = null;
  if (!doc) return;
  for (const pageIndex of Array.from(renderedScrollPages)) {
    const tileInfo = pageTiles.get(pageIndex);
    if (!tileInfo) continue;
    const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
    if (!wrapper) continue;
    const { width: dW, height: dH } = getPageDimensions(pageIndex);
    const rot = getRotation(pageIndex);
    const displayW = rot === 90 || rot === 270 ? dH : dW;
    const displayH = rot === 90 || rot === 270 ? dW : dH;
    const containerRect = canvasContainer.getBoundingClientRect();
    const wrapperRect   = wrapper.getBoundingClientRect();
    const visLeft   = Math.max(0,             containerRect.left   - wrapperRect.left);
    const visTop    = Math.max(0,             containerRect.top    - wrapperRect.top);
    const visRight  = Math.min(displayW * scale, containerRect.right  - wrapperRect.left);
    const visBottom = Math.min(displayH * scale, containerRect.bottom - wrapperRect.top);
    if (visRight <= visLeft || visBottom <= visTop) continue;
    if (visLeft   < tileInfo.cssLeft   ||
        visTop    < tileInfo.cssTop    ||
        visRight  > tileInfo.cssRight  ||
        visBottom > tileInfo.cssBottom) {
      renderedScrollPages.delete(pageIndex);
      pageTiles.delete(pageIndex);
      renderScrollPage(pageIndex);
    }
  }
}

/**
 * Scroll the given page into view at the top of the container.
 *
 * @param pageIndex - Zero-based page index to scroll to.
 */
function scrollToPage(pageIndex: number): void {
  const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`);
  wrapper?.scrollIntoView({ block: 'start' });
}

/**
 * Update all scroll-page wrapper and canvas sizes after a zoom change.
 *
 * Immediately rescales the CSS dimensions of existing tile canvases proportionally
 * so the layout updates without a full re-render, then schedules a debounced
 * re-render of all pages 150 ms later to produce a sharp image at the new scale.
 */
function updateScrollModeZoom(): void {
  for (let i = 0; i < totalPages; i++) {
    const wrapper = scrollContainer.querySelector<HTMLElement>(`[data-page="${i}"]`);
    if (!wrapper) continue;
    const { width: dimW, height: dimH } = getPageDimensions(i);
    const cssW = `${Math.round(dimW * scale)}px`;
    const cssH = `${Math.round(dimH * scale)}px`;
    wrapper.style.width = cssW;
    wrapper.style.height = cssH;
    const mc = wrapper.querySelector<HTMLCanvasElement>('.scroll-page-canvas');
    const oc = wrapper.querySelector<HTMLCanvasElement>('.scroll-page-overlay');
    const tileInfo = pageTiles.get(i);
    if (tileInfo && mc && oc) {
      const ratio = scale / tileInfo.renderedAtScale;
      const l = `${Math.round(tileInfo.cssLeft   * ratio)}px`;
      const t = `${Math.round(tileInfo.cssTop    * ratio)}px`;
      const w = `${Math.round((tileInfo.cssRight  - tileInfo.cssLeft) * ratio)}px`;
      const h = `${Math.round((tileInfo.cssBottom - tileInfo.cssTop)  * ratio)}px`;
      mc.style.left = l; mc.style.top = t; mc.style.width = w; mc.style.height = h;
      oc.style.left = l; oc.style.top = t; oc.style.width = w; oc.style.height = h;
    } else {
      if (mc) { mc.style.width = cssW; mc.style.height = cssH; }
      if (oc) { oc.style.width = cssW; oc.style.height = cssH; }
    }
  }
  if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    zoomDebounceTimer = null;
    renderedScrollPages.clear();
    pageTiles.clear();
    if (scrollObserver) {
      scrollObserver.disconnect();
      for (const child of scrollContainer.children) {
        scrollObserver.observe(child as Element);
      }
    }
  }, 150);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    const raw = msg.data;
    let data: Uint8Array;
    if (raw instanceof Uint8Array) {
      data = raw;
    } else if (Array.isArray(raw)) {
      data = new Uint8Array(raw);
    } else if (raw && raw.type === 'Buffer' && Array.isArray(raw.data)) {
      data = new Uint8Array(raw.data as number[]);
    } else {
      data = new Uint8Array(Object.values(raw as Record<string, number>));
    }
    loadDocument(
      data,
      msg.password as string | undefined,
      { defaultZoom: msg.defaultZoom, renderResolution: msg.renderResolution }
    );
  }
});

/**
 * Watch for device-pixel-ratio changes (e.g. moving the window to a different
 * monitor) and re-render the page when the DPR updates.
 *
 * Re-registers itself after each change so monitoring continues indefinitely.
 */
function watchDpr(): void {
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    .addEventListener('change', () => {
      dpr = window.devicePixelRatio || 1;
      if (doc) renderPage();
      watchDpr();
    }, { once: true });
}
watchDpr();

(async () => {
  try {
    const m = await import(/* @vite-ignore */ window.MUPDF_JS_URI) as
      { default?: typeof MupdfTypes } & typeof MupdfTypes;
    mupdf = (m.default ?? m) as typeof MupdfTypes;
    vscode.postMessage({ type: 'ready' });
  } catch (err) {
    vscode.postMessage({ type: 'error', message: `Failed to load PDF engine: ${String(err)}` });
  }
})();
