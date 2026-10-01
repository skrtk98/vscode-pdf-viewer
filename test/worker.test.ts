import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import mupdf from 'mupdf';

function encryptedPdf() {
  const doc = mupdf.Document.openDocument(readFileSync('test/fixtures/simple.pdf'), 'application/pdf') as mupdf.PDFDocument;
  const buffer = doc.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
  const bytes = new Uint8Array(buffer.asUint8Array());
  buffer.destroy(); doc.destroy();
  return bytes;
}

async function runWorker(password?: string) {
  const messages: any[] = [];
  let receive: Function;
  let pixels: Uint8ClampedArray | undefined;
  const context = createContext({
    engine: mupdf, Uint8Array, Uint8ClampedArray,
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    self: { addEventListener: (_: string, listener: Function) => { receive = listener; }, postMessage: (msg: any) => messages.push(msg) },
    ImageData: class { constructor(public data: Uint8ClampedArray) {} },
    OffscreenCanvas: class {
      getContext() { return { putImageData(image: any) { pixels = image.data; } }; }
      async convertToBlob() { return { type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(0) }; }
    },
  });
  const source = readFileSync('src/worker.ts', 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('await import(/* @vite-ignore */ mupdfUri)', 'await Promise.resolve(engine)');
  runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), context);
  await receive!({ data: { type: 'init', mupdfUri: '', wasmUri: '', data: encryptedPdf(), password } });
  if (messages.some(m => m.type === 'ready')) await receive!({ data: { type: 'render', page: 0 } });
  runInContext('doc?.destroy();', context);
  return { messages, pixels };
}

describe('encrypted thumbnails', () => {
  it('renders nonblank pixels after authenticating', async () => {
    const { messages, pixels } = await runWorker('secret');
    expect(messages[0]).toEqual({ type: 'ready' });
    expect(messages[1]).toMatchObject({ type: 'thumb', page: 0 });
    expect(pixels?.some(value => value !== 255)).toBe(true);
  });
  it.each([undefined, 'wrong'])('rejects authentication with password %s', async password => {
    const { messages, pixels } = await runWorker(password);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(pixels).toBeUndefined();
  });
});
