import type * as MupdfModule from 'mupdf';

let mupdf: typeof MupdfModule | null = null;
let doc: MupdfModule.Document | null = null;
const pendingRenders: number[] = [];

/** Thumbnail render scale relative to the original page size. */
const THUMB_SCALE = 0.2;

/** Message sent from the host to initialize the worker with a PDF document. */
interface InitMessage {
  type: 'init';
  /** Webview URI of the MuPDF JS module. */
  mupdfUri: string;
  /** Webview URI of the MuPDF WASM binary. */
  wasmUri: string;
  /** Raw PDF file bytes. */
  data: Uint8Array;
}

/** Message sent from the host to request a thumbnail for a single page. */
interface RenderMessage {
  type: 'render';
  /** Zero-based page index. */
  page: number;
}

self.addEventListener('message', async (event: MessageEvent<InitMessage | RenderMessage>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    const { mupdfUri, wasmUri, data } = msg;
    try {
      (globalThis as Record<string, unknown>)['$libmupdf_wasm_Module'] = {
        locateFile: (filename: string) =>
          filename === 'mupdf-wasm.wasm' ? wasmUri : filename,
      };

      const m = await import(/* @vite-ignore */ mupdfUri) as { default?: typeof MupdfModule } & typeof MupdfModule;
      mupdf = (m.default ?? m) as typeof MupdfModule;

      doc = mupdf.Document.openDocument(data, 'application/pdf');
      self.postMessage({ type: 'ready' });
      for (const page of pendingRenders) {
        await renderThumb(page);
      }
      pendingRenders.length = 0;
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }

  if (msg.type === 'render') {
    if (!doc || !mupdf) {
      pendingRenders.push(msg.page);
    } else {
      await renderThumb(msg.page);
    }
  }
});

/**
 * Render a single page as a JPEG thumbnail and post the result back to the host.
 *
 * The page is rendered at {@link THUMB_SCALE} and the resulting pixels are
 * encoded as a JPEG data URL sent via a `{ type: 'thumb', page, dataUrl }` message.
 * On failure a `{ type: 'error', message }` message is posted instead.
 *
 * @param pageIndex - Zero-based index of the page to render.
 */
async function renderThumb(pageIndex: number): Promise<void> {
  if (!doc || !mupdf) return;
  try {
    const page = doc.loadPage(pageIndex);
    const matrix = mupdf.Matrix.scale(THUMB_SCALE, THUMB_SCALE);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    const rgb = pixmap.getPixels();
    const w = pixmap.getWidth();
    const h = pixmap.getHeight();

    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
    }

    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d')!;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);

    pixmap.destroy();
    page.destroy();

    const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const dataUrl = await blobToDataUrl(blob);
    self.postMessage({ type: 'thumb', page: pageIndex, dataUrl });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
}

/**
 * Convert a `Blob` to a base64-encoded data URL string.
 *
 * Reads the blob as an `ArrayBuffer`, encodes it in chunks to avoid call-stack
 * overflow from large `String.fromCharCode` spreads, and returns a data URL of
 * the form `data:<mime>;base64,<data>`.
 *
 * @param blob - The blob to encode.
 * @returns A data URL containing the blob's contents.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
