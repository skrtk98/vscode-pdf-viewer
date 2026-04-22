/** 2-D point in any coordinate space. */
export interface Point {
  x: number;
  y: number;
}

/** A node in the rendered outline tree. */
export interface OutlineNode {
  title: string;
  page: number;
  children: OutlineNode[];
}

/** Raw outline item as returned by MuPDF. */
export interface OutlineItem {
  title: string | undefined;
  uri: string | undefined;
  open: boolean;
  down?: OutlineItem[];
  page?: number;
}

/**
 * Convert a PDF user-space coordinate to a canvas device-pixel coordinate.
 *
 * PDF space: origin at bottom-left, y-axis pointing up.
 * Canvas space: origin at top-left, y-axis pointing down.
 *
 * Pass `renderScale` (= `scale * dpr * renderResolution/96`) as `scale` and `1` as `dpr`
 * so the result maps directly to canvas physical pixels.
 * Rotation is applied before the y-flip; supported values: 0, 90, 180, 270 (degrees CW).
 *
 * @param pdfX - X coordinate in PDF user space.
 * @param pdfY - Y coordinate in PDF user space.
 * @param pageWidth - Unrotated page width in PDF user-space units.
 * @param pageHeight - Unrotated page height in PDF user-space units.
 * @param scale - Combined render scale (renderScale).
 * @param dpr - Device pixel ratio (pass 1 when scale already includes dpr).
 * @param rotation - Page rotation in degrees clockwise (0 | 90 | 180 | 270).
 * @returns Canvas-space point in device pixels.
 */
export function toCanvasCoord(
  pdfX: number,
  pdfY: number,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  dpr: number,
  rotation: number
): Point {
  const s = scale * dpr;
  let x = pdfX;
  let y = pdfY;
  let w = pageWidth;
  let h = pageHeight;

  const r = ((rotation % 360) + 360) % 360;
  if (r === 90) {
    [x, y] = [h - y, x];
    [w, h] = [h, w];
  } else if (r === 180) {
    x = w - x;
    y = h - y;
  } else if (r === 270) {
    [x, y] = [y, w - x];
    [w, h] = [h, w];
  }

  return {
    x: x * s,
    y: (h - y) * s,
  };
}

/**
 * Convert a canvas device-pixel coordinate back to PDF user-space.
 *
 * Exact inverse of {@link toCanvasCoord}.
 *
 * @param canvasX - X coordinate in canvas device pixels.
 * @param canvasY - Y coordinate in canvas device pixels.
 * @param pageWidth - Unrotated page width in PDF user-space units.
 * @param pageHeight - Unrotated page height in PDF user-space units.
 * @param scale - Combined render scale (renderScale).
 * @param dpr - Device pixel ratio (pass 1 when scale already includes dpr).
 * @param rotation - Page rotation in degrees clockwise (0 | 90 | 180 | 270).
 * @returns PDF user-space point.
 */
export function toPdfCoord(
  canvasX: number,
  canvasY: number,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  dpr: number,
  rotation: number
): Point {
  const s = scale * dpr;
  const r = ((rotation % 360) + 360) % 360;

  let w = pageWidth;
  let h = pageHeight;
  if (r === 90 || r === 270) {
    [w, h] = [h, w];
  }

  let x = canvasX / s;
  let y = h - canvasY / s;

  if (r === 90) {
    const origH = pageHeight;
    [x, y] = [y, origH - x];
  } else if (r === 180) {
    x = pageWidth - x;
    y = pageHeight - y;
  } else if (r === 270) {
    const origW = pageWidth;
    [x, y] = [origW - y, x];
  }

  return { x, y };
}

/**
 * Recursively convert the raw MuPDF outline list into an {@link OutlineNode} tree.
 *
 * @param items - Flat or nested list of raw MuPDF outline items.
 * @returns Typed outline tree suitable for rendering in the sidebar.
 */
export function buildOutlineTree(items: OutlineItem[]): OutlineNode[] {
  return items.map((item) => ({
    title: item.title ?? '',
    page: item.page ?? 0,
    children: item.down ? buildOutlineTree(item.down) : [],
  }));
}
