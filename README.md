# PDF Viewer

A VS Code extension that renders PDF files using [MuPDF](https://github.com/ArtifexSoftware/mupdf) compiled to WebAssembly.

---

## Usage

Open any `.pdf` file in VS Code — the viewer opens automatically as a custom editor.

### View modes

Click the **scroll/page** toggle button in the toolbar to switch between:

- **Scroll mode** (default) — all pages rendered continuously
- **Single-page mode** — one page at a time

### Zoom

| Action | Result |
|--------|--------|
| `Ctrl+Wheel` | Zoom in/out anchored to the mouse position |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| Fit Width button | Scale to fill the container width |
| Fit Page button | Scale to fit the entire page |
| Zoom input field | Type a percentage (e.g. `150%`) or a decimal (e.g. `1.5`) |

### Navigation

| Action | Result |
|--------|--------|
| `PageDown` / `ArrowRight` | Next page |
| `PageUp` / `ArrowLeft` | Previous page |
| Page number input | Jump to a specific page |
| Outline sidebar entry | Jump to the bookmarked page |
| Thumbnail | Jump to the corresponding page |

### Text selection and copy

- **Click and drag** to select text.
- **Double-click** to select a word.
- **Ctrl+C** to copy the selected text to the clipboard.

### Search

Type in the search box to find text across the document.  
Press **Enter** / **Shift+Enter** or use the arrow buttons to navigate between hits.

### Context menu

Right-click on an image to copy it as PNG.

### Rotation

Click the rotate button to rotate the current page 90° clockwise.

---

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pdfViewer.defaultZoom` | number | `1.0` | Initial zoom level (1.0 = 100%). |
| `pdfViewer.renderResolution` | number | `96` | Render resolution in DPI. Higher values produce sharper output at the cost of more memory. |
