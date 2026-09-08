# Releasing MuPDF Viewer

## Local validation

Use Node.js 22 and install the locked dependencies:

```sh
npm ci
npm run check
npm test
npm run package
```

`npm run package` invokes `vscode:prepublish` to build the extension before creating the VSIX.
The extension bundles its host code and copies the MuPDF runtime into `media/`, so packaging uses `--no-dependencies`.
Install the resulting VSIX with **Extensions: Install from VSIX…** and check opening a PDF, zoom, search, and reload after a file update.

## Registry setup

For Visual Studio Marketplace, configure a publishing token for the existing `skrtk98` publisher and save it as the GitHub repository secret `VSCE_PAT`.
Follow the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for token permissions and publisher access.

For Open VSX:

1. Sign in to [Open VSX](https://open-vsx.org/) with GitHub, connect an Eclipse account, and accept the publisher agreement.
2. Create an access token in the Open VSX user settings and save it as the GitHub repository secret `OVSX_PAT`.
3. With that token available locally as `OVSX_PAT`, run `npx --no-install ovsx create-namespace skrtk98` once. If the namespace already exists, confirm publishing access instead.
4. Request ownership verification using the [namespace access instructions](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

See [Publishing Extensions](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions) for the Open VSX account and agreement requirements.
Store tokens in repository secrets or local environment variables; do not put them in tracked files or command arguments.

## Tag release

Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the next release, then commit the changes.
Create and push a stable tag matching the package version exactly, such as `v0.0.7` for version `0.0.7`.

The [release workflow](../.github/workflows/release.yml) runs only on `v*` tag pushes and rejects mismatched or prerelease versions.
It type-checks, tests, builds, and packages one VSIX, then publishes that artifact independently to Visual Studio Marketplace and Open VSX.
After both succeed, it creates a GitHub Release and attaches the same VSIX.
README links in release packages point to the release tag.

If a registry fails, correct its credentials or namespace access and rerun failed jobs in GitHub Actions.
The publish commands skip versions already present, allowing a partially completed release to be retried.
Do not move an already published tag or reuse a version for changed contents; publish a new version.

After the first Open VSX release, verify the [listing](https://open-vsx.org/extension/skrtk98/mupdf-viewer), namespace ownership status, and installation from an Open VSX client.
Add its installation link and badge to both READMEs once the listing is available.
Check the Marketplace listing and GitHub Release asset as well.

## Demo assets

The sample document source is [demo/reading-notes.typ](demo/reading-notes.typ).
Compile it with Typst:

```sh
typst compile docs/demo/reading-notes.typ docs/demo/reading-notes.pdf
```

Capture VS Code at 1440 pixels wide (900–1000 pixels high) with the extension loaded and the generated PDF open.
For the overview, show Explorer, the outline, and the PDF toolbar.
For search, search for `document` with the outline visible.
Record zoom around an equation with the right mouse button held while scrolling.
For reload, split the Typst source and PDF, change the title from `From source\ to PDF` to `From source\ to revision`, save, and recompile the PDF.
Keep each GIF focused on one operation and approximately 4–8 seconds long.

## Measuring impact

Record the date, Marketplace installs, GitHub stars and forks, and Open VSX downloads before a release and monthly afterward.
Use those observations to assess discovery and adoption.
Performance claims require separate measurements across text, vector, image, and scanned documents, with document size, machine, viewer version, and measurement method recorded.
