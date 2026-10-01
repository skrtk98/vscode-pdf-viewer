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

Marketplace currently uses `VSCE_PAT`; changing its authentication is separate from Open VSX trusted publishing.
Microsoft has announced retirement of Azure DevOps global PATs on December 1, 2026; follow the publishing guide above when migrating Marketplace authentication.

### Marketplace OIDC migration

The locked `@vscode/vsce` 4.0.0 includes `publish --oidc`, although this option is hidden from CLI help.
The [upstream trusted publishing documentation](https://github.com/microsoft/vscode-vsce#trusted-publishing) requires a Marketplace trusted publishing policy for the GitHub repository and workflow.
CLI support alone does not establish that this policy can be configured for the publisher.

Before switching the release job:

1. Confirm that [publisher management](https://marketplace.visualstudio.com/manage/publishers/skrtk98) offers trusted publishing and register `skrtk98/vscode-pdf-viewer` with workflow `release.yml`. Record any required environment or ref restrictions before changing the workflow.
2. Confirm the released CLI supports the Marketplace token exchange in use. Version 4.0.0's implementation differs from the current upstream source; pin a compatible released version if an update is needed.
3. Grant `id-token: write` to `publish-marketplace`, remove its `VSCE_PAT` environment variable, and add `--oidc` to its publish command.
4. Verify authentication in GitHub Actions using an unchanged version already published to Marketplace and `--skip-duplicate`. Only after this succeeds, remove any unused Marketplace publishing secret and revoke its token if it is not used elsewhere.

Until these checks succeed, the Marketplace release job retains its existing authentication.
Microsoft Entra ID with workload identity federation remains an alternative if direct trusted publishing is unavailable.

### Open VSX

For Open VSX, use [Trusted Publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing):

1. Sign in to Open VSX, accept the Publisher Agreement, and ensure your account is an **owner** of the `skrtk98` namespace. Contributor access is insufficient for registering a trusted publisher.
2. In [Settings → Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers), register extension `mupdf-viewer` with provider GitHub Actions, owner `skrtk98`, repository `vscode-pdf-viewer`, and workflow filename `release.yml`.
3. Leave the environment field empty for the current workflow. If you restrict the registration to an environment, add that exact `environment:` to both `verify-open-vsx` and `publish-open-vsx` jobs and configure its branch/tag rules accordingly.
4. The workflow uses locked `ovsx` 1.2.0, grants `id-token: write` only to the Open VSX jobs, and publishes with `--trusted-publishing`. It does not pass `OVSX_PAT` or fall back to PAT authentication.

The extension and namespace already exist. Trusted publishing requires an active version and cannot bootstrap a new extension or create a namespace.
A single trusted publisher can be registered per extension, so both tag and manual publication use `release.yml`.
Registrations are not bound to a branch/tag; keep changes to the registered workflow controlled.
After verifying trusted publishing, remove the unused `OVSX_PAT` repository secret and revoke its Open VSX token if it is not used elsewhere.
Delete the secret under [repository Settings → Secrets and variables → Actions](https://github.com/skrtk98/vscode-pdf-viewer/settings/secrets/actions).
Deleting a GitHub secret does not revoke the underlying token: remove that token separately in Open VSX account settings.
Never put tokens in tracked files, command arguments, or logs.

## Tag release

Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the next release, then commit the changes.
Create and push a stable tag matching the package version exactly, such as `v0.0.9` for version `0.0.9`.

The [release workflow](../.github/workflows/release.yml) publishes to both registries on `v*` tag pushes and rejects mismatched or prerelease versions.
It type-checks, tests, builds, and packages one VSIX, then publishes that artifact independently to Visual Studio Marketplace and Open VSX.
After both succeed, it creates a GitHub Release and attaches the same VSIX.
README links in release packages point to the release tag.

If a registry fails, correct its credentials or namespace access and rerun failed jobs in GitHub Actions.
The publish commands skip versions already present, allowing a partially completed release to be retried.
Do not move an already published tag or reuse a version for changed contents; publish a new version.

After the first Open VSX release, verify the [listing](https://open-vsx.org/extension/skrtk98/mupdf-viewer), namespace ownership status, and installation from an Open VSX client.
Check the Marketplace listing and GitHub Release asset as well.

## Verifying trusted publishing

Pushing changes to `release.yml`, `package.json`, or `package-lock.json` on `main` runs only the `verify-open-vsx` job.
It downloads the latest already-published VSIX from Open VSX and submits it with `--trusted-publishing --skip-duplicate`.
`ovsx` exchanges the OIDC token before attempting the upload; success followed by “already published” confirms the registered workflow can authenticate without creating a new version.
This check does not publish the development checkout or invoke Marketplace publication.

## Publishing an existing release to Open VSX

Use the [Release workflow](../.github/workflows/release.yml) from the GitHub Actions tab.
Choose **Run workflow** on `main` and enter an existing stable release tag, such as `v0.0.8`.
The package job checks out that tag, validates it, and builds its VSIX.
The Open VSX job uses the workflow revision's locked CLI so older tags still publish through trusted publishing.
Manual runs skip Marketplace and attach the VSIX to the corresponding GitHub Release after Open VSX succeeds.
The former `publish-open-vsx.yml` workflow has been consolidated into `release.yml` to use the same trusted publisher registration.

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
