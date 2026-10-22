# Changelog

## [1.0.0]

The first stable release of MuPDF Viewer. It updates the bundled MuPDF engine with security fixes for crafted PDFs; there are no other user-visible changes from 0.0.8.
Versions 0.0.1–0.0.8 were pre-stable development releases.

### What's included
- Read PDFs in a VS Code editor tab, rendered by MuPDF compiled to WebAssembly.
- Zoom around the mouse cursor with `Ctrl+Wheel` or `Right mouse button+Wheel`.
- Switch between continuous scrolling and single-page reading.
- Reload automatically when the PDF changes on disk — keep LaTeX or Typst output beside its source.
- Navigate with the outline, thumbnails, page numbers, and internal or external links.
- Search incrementally, select and copy text, copy images as PNG, rotate pages, and open password-protected PDFs.

### Security
- Updated MuPDF from 1.27.0 to 1.28.1, which includes upstream fixes for memory-safety issues triggered by crafted PDFs (including CVE-2026-25556 and CVE-2026-3308).

### Internal
- Applied available security fixes to development dependencies.

---

## [0.0.8]

A reliability release: highlights, selections, and link clicks now line up with what is drawn on screen — including rotated and zoomed pages — and reloading keeps your zoom.

### Fixed
- Search highlights, text selection, and image right-click targets line up with the rendered page, including rotated pages and fractional zoom levels.
- Links work in both continuous-scroll and single-page views.
- Reloading a changed PDF keeps your zoom level and resolution settings, including while you enter a password.
- Old selections are cleared when the document is reloaded.
- Search highlights clear correctly in continuous view, and moving between results while a search is still running no longer skips matches.
- Thumbnails appear for password-protected PDFs and stay correct after rapid reloads.
- Page rendering recovers cleanly when a tile fails to render.

### Internal
- Expanded regression tests to 60, covering real MuPDF rendering output, rotation, fractional zoom, reloads, links, search, and encrypted thumbnails.

---

## [0.0.7]

Documentation and release-process update; no changes to the viewer itself.

### Changed
- Rewrote the English and Japanese READMEs around reading PDFs and working with generated documents, with screenshots and zoom and reload demos.
- Improved the Marketplace description, categories, keywords, and project links so the extension is easier to find.

### Internal
- Releases are now built, tested, and published automatically from tags through GitHub Actions.
- Fixed a TypeScript type error in the image-copy code; behavior is unchanged.

---

## [0.0.6]

Documentation update; no changes to the viewer itself.

### Changed
- The READMEs now cover zooming with the right mouse button, link navigation, and automatic reload, and use the current name "MuPDF Viewer".

---

## [0.0.5]

Zoom without reaching for the keyboard.

### Added
- Hold the right mouse button and scroll to zoom around the cursor, in addition to `Ctrl+Wheel`.

---

## [0.0.4]

The extension now has its own icon.

### Added
- Extension icon in the Extensions view and Marketplace.
- Marketplace keywords `pdf` and `viewer` so the extension shows up in searches.

---

## [0.0.3]

Search highlights now appear on the matching text.

### Fixed
- Search highlights were drawn at the wrong vertical position on the page.

---

## [0.0.2]

The extension is now called MuPDF Viewer, and two reload and zoom bugs are fixed.

### Changed
- Renamed from "PDF Previewer" to "MuPDF Viewer".
- License changed from MIT to AGPL-3.0, as required by MuPDF's license.

### Fixed
- Automatic reload no longer fails with a "key not in dict" error on PDFs whose outline contains web links.
- The Fit Width button no longer also highlights Fit Page when both give the same zoom level.

---

## [0.0.1]

The first public release: a MuPDF-powered PDF viewer inside VS Code.

### Added
- PDF rendering with MuPDF compiled to WebAssembly, sharp on HiDPI and Retina displays.
- Continuous scrolling and single-page modes.
- Zoom with the mouse wheel, toolbar buttons, Fit Width, Fit Page, or a typed percentage.
- Text selection and copy with `Ctrl+C`.
- Incremental search with previous and next navigation.
- Collapsible outline sidebar and a thumbnail sidebar.
- Rotate individual pages by 90°.
- Internal and external link navigation.
- Copy images as PNG from the right-click menu.
- Password-protected PDFs.
- Automatic reload when the file changes on disk.
- Settings `pdfViewer.defaultZoom` and `pdfViewer.renderResolution`.
