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

/** MuPDF page coordinates are the common space for text, links and images. */
export type Matrix = import('mupdf').Matrix;
export type Rect = import('mupdf').Rect;
type GeometryEngine = Pick<typeof import('mupdf'), 'Matrix' | 'Rect'>;

export interface PageTransform {
  matrix: Matrix;
  inverse: Matrix;
  width: number;
  height: number;
}

export function transformPoint(matrix: Matrix, x: number, y: number): Point {
  return {
    x: x * matrix[0] + y * matrix[2] + matrix[4],
    y: x * matrix[1] + y * matrix[3] + matrix[5],
  };
}

/** Compose rotation, scale and origin translation using MuPDF's matrix order. */
export function createPageTransform(
  engine: GeometryEngine, bounds: Rect, scale: number, rotation: number,
): PageTransform {
  // Eliminate trig roundoff at right angles without branching on rotation.
  const rotationMatrix = engine.Matrix.rotate(rotation).map(
    value => Math.abs(value) < 1e-12 ? 0 : value,
  ) as Matrix;
  const scaled = engine.Matrix.concat(rotationMatrix, engine.Matrix.scale(scale, scale));
  const box = engine.Rect.transform(bounds, scaled);
  const matrix = engine.Matrix.concat(scaled, engine.Matrix.translate(-box[0], -box[1]));
  return { matrix, inverse: engine.Matrix.invert(matrix), width: box[2] - box[0], height: box[3] - box[1] };
}

/** Convert the page transform to the actual pixmap's local pixel coordinates. */
export function tileTransform(engine: GeometryEngine, page: PageTransform, box: Rect): PageTransform {
  const matrix = engine.Matrix.concat(page.matrix, engine.Matrix.translate(-box[0], -box[1]));
  return { matrix, inverse: engine.Matrix.invert(matrix), width: box[2] - box[0], height: box[3] - box[1] };
}

/** Map a pointer through the rendered canvas, including CSS resizing and tiling. */
export function canvasPointToPage(
  transform: PageTransform, x: number, y: number,
  cssWidth: number, cssHeight: number, pixelWidth: number, pixelHeight: number,
): Point {
  return transformPoint(transform.inverse, x * pixelWidth / cssWidth, y * pixelHeight / cssHeight);
}

/**
 * Recursively convert the raw MuPDF outline list into an {@link OutlineNode} tree.
 *
 * @param items - Flat or nested list of raw MuPDF outline items.
 * @returns Typed outline tree suitable for rendering in the sidebar.
 */
export function buildOutlineTree(items: OutlineItem[]): OutlineNode[] {
  return items.map((item) => {
    let page = 0;
    try {
      page = item.page ?? 0;
    } catch {
      // URI or named destination — no page index
    }
    return {
      title: item.title ?? '',
      page,
      children: item.down ? buildOutlineTree(item.down) : [],
    };
  });
}
