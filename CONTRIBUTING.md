# Contributing

This file describes how to build, test and release the Trova plugin. The [README](README.md) describes the plugin for its users.

## Build and test

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run lint
```

`npm run lint` checks the code against Obsidian's own ESLint rules (`eslint-plugin-obsidianmd`), with two stricter local rules where Obsidian's review is stricter than the published rules, and checks `styles.css` with Stylelint as the review does (no `!important`, and browser features of the Chromium versions Obsidian runs on). The review can still find more than these checks, so run it before each release, as below. `npm run format` formats the code with [Oxfmt](https://oxc.rs/docs/guide/usage/formatter), at the version and settings the engine repository uses, so the shared contract stays identical; `npm run format:check` checks it, as CI does. Update Oxfmt only together with the engine's Vite+, as [its `docs/development.md`](https://github.com/ibimal/trova/blob/main/docs/development.md#updating-vite) describes.

`npm run dev` rebuilds `main.js` on every change. To try a build, copy `main.js`, `manifest.json` and `styles.css` into a vault's `.obsidian/plugins/trova/` folder and reload Obsidian. A git-ignored `test-vault/` folder in this repository is a convenient place for that vault.

The README's images are in `docs/images/`. They were taken in a git-ignored `demo-vault/` folder: a vault of invented notes about coffee, baking, travel, reading, projects and learning, opened in Obsidian's dark theme with the window at 1440 × 900. Never take them in a vault with real notes. The engine computes the topic map over every vault it indexes, so take the topic map image with an engine that holds only the demo vault: start one with its own data folder (`TROVA_HOME=<empty folder> trova watch`), and point the demo vault at it under Settings → Trova: set Engine to External, and Engine address and Engine token from `daemon.json` in that folder. Set Engine back to Managed afterwards. The README links each image by its full `raw.githubusercontent.com` address, so the images also show on Obsidian's plugin page.

`docs/notes.md` records where the plugin differs from its specification, what it adds, and what was measured. `src/contract/` is a copy of the engine's `/v1` contract from the [trova repository](https://github.com/ibimal/trova/tree/main/src/contract); keep the two identical, and copy any change across. `test/contract.test.ts` and the notes in `test/fixture.ts` are copied from there too; the contract test differs only in its test import (`vitest` here, `vite-plus/test` there). The plugin connects only to an engine that serves its API major version; [the engine's `docs/api.md`](https://github.com/ibimal/trova/blob/main/docs/api.md) gives the rules. The plugin's logic is tested with a mocked `obsidian` module; the views are checked in a running Obsidian.

Each release's files carry a GitHub build provenance attestation, which shows they were built from this repository by its release workflow. To check one, download it and run `gh attestation verify main.js --repo ibimal/trova-obsidian`.

## Releasing

To release a version:

1. Push your changes to `main` and let CI pass.
2. On the plugin's page in the [Obsidian community directory](https://community.obsidian.md), choose **Review branch** for `main`, and fix anything it reports. This runs Obsidian's own review before anything is published.
3. Run `npm version` with `patch`, `minor` or `major`, then push the commit and the tag:

```bash
npm version patch
```

```bash
git push --follow-tags
```

`npm version` sets the version in `package.json`, `manifest.json` and `versions.json` (with the lowest Obsidian version it supports, from `manifest.json`'s `minAppVersion`), commits them, and tags the commit with the bare version, as Obsidian requires. GitHub Actions then check that the tag matches `manifest.json` and `versions.json`, run the type check, lint, format check and tests, build the plugin, attest the build, and create a draft release with `main.js`, `manifest.json` and `styles.css` attached. Review the draft on GitHub and publish it.
