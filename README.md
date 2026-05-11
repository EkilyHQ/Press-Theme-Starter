# Press Theme Starter

Use this repository as a GitHub template when creating a Press theme repository.

The starter contains a minimal Press theme that passes the current theme contract, plus a release workflow that publishes installable theme ZIP files for Press Theme Manager.

## Create a Theme

1. Click **Use this template**.
2. Name the new repository, for example `Press-Theme-Example`.
3. Edit `theme-repo.json`:
   - `slug` is the installed folder name under `assets/themes/<slug>`.
   - `label` is the name shown in Press Theme Manager.
4. Edit `theme/theme.json` and change `name`. Keep `engines.press` aligned with the Press versions your theme supports.
5. Build your theme in `theme/`.

Do not edit `.github/workflows/theme-release.yml` for ordinary theme metadata. The workflow reads `theme-repo.json`.

## Repository Layout

- `theme-repo.json` - release metadata for this theme repository.
- `theme/theme.json` - Press runtime manifest for the theme, including `engines.press` compatibility.
- `theme/theme.css` - theme stylesheet.
- `theme/modules/starter.js` - minimal contract-compatible theme module.
- `theme-release.json` - latest release manifest consumed by Press Theme Manager.
- `.github/workflows/theme-release.yml` - package, verify, publish, and manifest workflow.

## Release Flow

Pushes to `main` that change `theme/**` or `theme-repo.json` automatically publish a patch release. Use **Actions > Theme Release > Run workflow** when you need to publish a specific tag such as `v0.2.0`.

Each release publishes:

- `press-theme-<slug>-vX.Y.Z.zip` on the GitHub Release.
- A browser-fetchable ZIP copy on the `release-artifacts` branch.
- A root `theme-release.json` manifest with the ZIP URL, size, SHA-256 digest, file inventory, and `engines.press` range.

Press only consumes the released ZIP and installs it into a site under `assets/themes/<slug>/`.

## Contract Checks

The release workflow checks out `EkilyHQ/Press`, copies this repository's `theme/` folder into the Press theme directory, and runs the Press theme contract tests. Keep `theme/theme.json` aligned with the current Press theme contract.
