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

Both registries publish from GitHub Actions without personal access tokens.
Never put tokens in tracked files, command arguments, or logs.

### Visual Studio Marketplace

Publishing uses Microsoft Entra ID through GitHub OIDC federation ([Azure Login](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended), `vsce --azure-credential`; see the [Microsoft publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)).

- A dedicated single-tenant Entra application has no client secret and one federated credential:
  - Issuer: `https://token.actions.githubusercontent.com`
  - Subject: `repo:skrtk98/vscode-pdf-viewer:environment:marketplace`
  - Audience: `api://AzureADTokenExchange`
- The GitHub environment `marketplace` allows branch `main` and tags `v*`, and stores `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` as environment secrets.
- The application's Azure DevOps identity is a **Contributor** of Marketplace publisher `skrtk98`.
  The [authentication verification workflow](../.github/workflows/verify-marketplace-auth.yml) reports that identity ID and, with `verify_permissions` checked, confirms publishing rights without uploading a package.

If the repository's OIDC subject format changes, update the federated credential to match.

### Open VSX

Publishing uses [Trusted Publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).
Extension `mupdf-viewer` is registered with provider GitHub Actions, repository `skrtk98/vscode-pdf-viewer`, workflow `release.yml`, and no environment.
Registering requires owner access to the `skrtk98` namespace.
Only one trusted publisher can be registered per extension, and the registration is not bound to a branch or tag, so keep changes to `release.yml` controlled.
If you restrict the registration to an environment, add that `environment:` to the `verify-open-vsx` and `publish-open-vsx` jobs.

## Tag release

Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the next release, then commit the changes.
The CHANGELOG section becomes the GitHub Release notes, so write it for users: open with one or two sentences on what improved, describe each item by its visible effect, and put changes users cannot see under `### Internal`.
Preview the notes with `node scripts/release-notes.mjs X.Y.Z`; the script appends installation links and the full changelog link.
Create and push a stable tag matching the package version exactly, such as `v1.0.1` for version `1.0.1`.

The [release workflow](../.github/workflows/release.yml) publishes to both registries on `v*` tag pushes and rejects mismatched or prerelease versions.
It type-checks, tests, builds, and packages one VSIX, then publishes that artifact independently to Visual Studio Marketplace and Open VSX.
After both succeed, it creates a GitHub Release from the CHANGELOG section, marks it Latest, and attaches the same VSIX.
The package job fails before publishing if the CHANGELOG has no section for the tagged version.
README links in release packages point to the release tag.

If a registry fails, correct its credentials or namespace access and rerun failed jobs in GitHub Actions.
The publish commands skip versions already present, allowing a partially completed release to be retried.
Do not move an already published tag or reuse a version for changed contents; publish a new version.

After a release, check the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=skrtk98.mupdf-viewer), the [Open VSX listing](https://open-vsx.org/extension/skrtk98/mupdf-viewer), and the GitHub Release asset.
Open VSX can take several minutes to show a new version.

## Verifying trusted publishing

Pushing changes to `release.yml`, `package.json`, or `package-lock.json` on `main` runs `verify-open-vsx` and `publish-marketplace` against already published packages.
It downloads the latest already-published VSIX from Open VSX and submits it with `--trusted-publishing --skip-duplicate`.
`ovsx` exchanges the OIDC token before attempting the upload; success followed by “already published” confirms the registered workflow can authenticate without creating a new version.
The Marketplace job downloads its existing 1.0.0 VSIX, verifies Entra publishing rights, and invokes publication with duplicate skipping. Neither check packages the development checkout or creates a new version.

## Publishing an existing release to Open VSX

Use the [Release workflow](../.github/workflows/release.yml) from the GitHub Actions tab.
Choose **Run workflow** on `main` and enter an existing stable release tag, such as `v1.0.0`.
The package job checks out that tag, validates it, and builds its VSIX.
The Open VSX job uses the workflow revision's locked CLI so older tags still publish through trusted publishing.
Manual runs skip Marketplace and attach the VSIX to the corresponding GitHub Release after Open VSX succeeds.
Tags before v1.0.0 lack `scripts/release-notes.mjs`, so manual runs for them fail.

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
