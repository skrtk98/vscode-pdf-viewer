import type * as MuPDF from 'mupdf';

/** Render a clipped page and copy its pixels before releasing WASM memory. */
export function renderTile(
  engine: typeof MuPDF, page: MuPDF.Page, matrix: MuPDF.Matrix, bounds: MuPDF.Rect,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const pixmap = new engine.Pixmap(engine.ColorSpace.DeviceRGB, bounds, false);
  try {
    pixmap.clear(255);
    const device = new engine.DrawDevice(matrix, pixmap);
    try {
      page.run(device, engine.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    const rgb = pixmap.getPixels();
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      data[j] = rgb[i]; data[j + 1] = rgb[i + 1]; data[j + 2] = rgb[i + 2]; data[j + 3] = 255;
    }
    return { data, width, height };
  } finally {
    pixmap.destroy();
  }
}
