# Changelog

## [0.0.2]

### Changed
- Extension renamed from "PDF Previewer" to "MuPDF Viewer".
- License changed from MIT to AGPL-3.0 to comply with MuPDF's license.

### Fixed
- Auto-reload error ("key not in dict") when opening a PDF with outline items that have URI destinations.
- Fit-width button incorrectly activating the fit-page button when fit-width and fit-page scales coincide.

---

## [0.0.1] — Initial release

### Added
- PDF rendering via MuPDF WebAssembly.
- Continuous scroll mode and single-page mode.
- Zoom controls: mouse wheel, toolbar buttons, fit-width, fit-page, free-text input.
- Text selection with clipboard copy (Ctrl+C).
- Incremental full-text search with prev/next navigation.
- Outline (bookmark) sidebar with collapsible tree.
- Thumbnail sidebar rendered by a Web Worker.
- Per-page 90° clockwise rotation.
- Internal and external link navigation.
- Right-click context menu to copy images as PNG.
- Password-protected PDF support.
- Auto-reload when the file changes on disk.
- HiDPI / Retina rendering with device-pixel-ratio tracking.
- `pdfViewer.defaultZoom` and `pdfViewer.renderResolution` settings.
