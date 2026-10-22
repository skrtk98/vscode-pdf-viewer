// Prints GitHub Release notes for a version from its CHANGELOG.md section.
// Usage: node scripts/release-notes.mjs <version> [changelog]
import * as fs from 'fs';

const [version, changelogPath = 'CHANGELOG.md'] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/release-notes.mjs <X.Y.Z> [changelog]');
}

const repo = 'https://github.com/skrtk98/vscode-pdf-viewer';
const headings = [...fs.readFileSync(changelogPath, 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*\n/gm)];
const index = headings.findIndex((h) => h[1] === version);
if (index < 0) {
  throw new Error(`CHANGELOG has no section for ${version}`);
}

const start = headings[index].index + headings[index][0].length;
const end = headings[index + 1]?.index ?? Infinity;
const body = headings[0].input.slice(start, end).replace(/\n---\s*$/, '').trim();
if (!body) {
  throw new Error(`CHANGELOG section for ${version} is empty`);
}

// Sections are ordered newest first, so the next heading is the previous release.
const previous = headings[index + 1]?.[1];
const fullChangelog = previous
  ? `${repo}/compare/v${previous}...v${version}`
  : `${repo}/commits/v${version}`;

process.stdout.write(`${body}

### Install
- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=skrtk98.mupdf-viewer) · [Open VSX](https://open-vsx.org/extension/skrtk98/mupdf-viewer)
- Or download \`mupdf-viewer.vsix\` below and run **Extensions: Install from VSIX…**

**Full Changelog**: ${fullChangelog}
`);
