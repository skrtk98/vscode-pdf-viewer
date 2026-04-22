import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const mediaDir = 'media';
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}
const distDir = 'dist';
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy mupdf distribution files to media/
const mupdfDist = new URL('./node_modules/mupdf/dist', import.meta.url).pathname;

const filesToCopy = [
  ['mupdf-wasm.wasm', 'mupdf.wasm'],
  ['mupdf.js', 'mupdf.js'],
  ['mupdf-wasm.js', 'mupdf-wasm.js'],
];

for (const [src, dest] of filesToCopy) {
  const srcPath = path.join(mupdfDist, src);
  const destPath = path.join(mediaDir, dest);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied ${src} → media/${dest}`);
  } else {
    console.warn(`Not found: ${srcPath}`);
  }
}

const commonOptions = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

// Extension Host bundle (CJS, Node.js)
const extensionBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
});

// WebView main script — mupdf excluded (loaded dynamically at runtime via media/mupdf.js)
const viewerBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/viewer.ts'],
  outfile: 'media/viewer.js',
  format: 'esm',
  platform: 'browser',
  external: ['mupdf'],
});

// WebView worker script — mupdf excluded (loaded dynamically at runtime)
const workerBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/worker.ts'],
  outfile: 'media/worker.js',
  format: 'esm',
  platform: 'browser',
  external: ['mupdf'],
});

await Promise.all([extensionBuild, viewerBuild, workerBuild]);
console.log('Build complete.');
