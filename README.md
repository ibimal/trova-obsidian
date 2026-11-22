# Trova for Obsidian

Trova searches your vault by keyword and by meaning, on your own machine. It adds four surfaces on one local index: Instant search, a Connections and Ask pane, a Context basket, and Vault care. Semantic search comes from the [Trova engine](https://github.com/ibimal/trova) (`trova-cli`), a separate program that runs on your computer.

## What it does

- **Instant search.** A search modal that answers as you type, with typo correction, exact words, phrases, `in:title` and exclusions. Alt+Up and Alt+Down walk through earlier queries.
- **Connections and Ask.** A side pane that lists the notes and sections related to the active note, or to the text you select. Type a question in its search box and it answers with the passages that match, ranked by keyword and meaning; Esc goes back to the related notes.
- **Similarity graph.** The active note, its related notes and the links between them on one canvas. A smaller copy sits in a drawer at the bottom of the Connections pane.
- **Context basket.** Collect notes and sections, then copy them as one block of text, for example to paste into an AI chat. It shows the estimated token count.
- **Vault care.** Near-duplicate notes, orphan notes and a daily Rediscover pick (off until you turn it on in the settings), in one tab. "Not a duplicate" and "Keep unlinked" are remembered, with Undo.
- **Topic map.** Your notes grouped by topic on a canvas that pans and zooms with thousands of notes.
- **Bases view.** A Bases view named "Trova related" adds a similarity Score column and a Related column.

## Requirements

- Obsidian 1.13.4 or later, on a computer. This version is desktop only: Obsidian on phones and tablets does not offer it.
- For everything except Instant search: the Trova engine, `trova-cli`, on the same computer. It needs Node 22 or later; Node 24 is the verified version.
- The plugin and the engine are checked on macOS on Apple Silicon. Windows and Linux are not tested yet.

Without the engine, Instant search still works from the plugin's own keyword index, and Ask falls back to keyword matches and says so. Related notes, semantic results, the similarity graph, the topic map and the near-duplicate scan need the engine.

## Install

1. Install the engine:

   ```bash
   npm install -g trova-cli
   ```

2. Install the plugin. Until it is listed in Obsidian's community plugins, download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ibimal/trova-obsidian/releases), put them in `<vault>/.obsidian/plugins/trova/`, and enable Trova under Settings → Community plugins.

The plugin looks for `trova` on your `PATH` and in the usual install folders. If it does not find it, set the path under Settings → Trova → Engine binary path.

The plugin starts the engine when the vault opens, so the welcome screen can show what will be indexed and whether the models still need downloading. Nothing is indexed or downloaded until you click Start. "Continue without engine" disconnects the plugin, which then does not start the engine again until you choose "Show welcome screen"; an engine it already started exits by itself after 30 minutes with no client.

## Commands

Open the command palette and type "Trova". You can give any command a hotkey under Settings → Hotkeys; the plugin sets none itself.

| Command                                                                     | What it does                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Instant search                                                              | Search the vault as you type                               |
| In-file search                                                              | Search the open note                                       |
| Ask, Ask about selection                                                    | Ask a question about the vault, or about the selected text |
| Open Connections and Ask                                                    | Open the side pane                                         |
| Connections for selection                                                   | Related notes for the selected text                        |
| Random strong connection                                                    | Open a note closely related to the active one              |
| Open Context basket, Copy basket                                            | Show the basket, or copy its contents                      |
| Add current note to Context basket, Add section at cursor to Context basket | Fill the basket                                            |
| Open Vault care (duplicates, orphans, Rediscover), Open Rediscover          | Open Vault care, or its Rediscover pick                    |
| Open topic map, Open similarity graph                                       | Open the canvases                                          |
| Reindex now, Pause or resume indexing                                       | Control the index                                          |
| Show welcome screen                                                         | Show the first-run screen again                            |

All settings are under Settings → Trova, and Obsidian's settings search finds each of them.

## Update

Update the plugin from Settings → Community plugins once it is listed there, or replace its three files with those of a newer release. Update the engine in a terminal:

```bash
npm install -g trova-cli@latest
```

If the plugin needs a newer engine, the welcome screen says so and shows this command.

## Uninstall

1. Disable and uninstall Trova under Settings → Community plugins.
2. Remove the engine:

   ```bash
   npm uninstall -g trova-cli
   ```

3. Delete the engine's index, `~/.cache/trova/`. The models are in qmd's model cache, `~/.cache/qmd/models/`; delete them too, unless you also use [qmd](https://github.com/tobi/qmd) itself, which shares that folder.

## Troubleshooting

- **The welcome screen says the engine is not installed, but it is.** Obsidian started from the Dock does not see your terminal's `PATH`. The plugin also searches the usual install folders; if it still misses `trova`, run `which trova` (`where trova` on Windows) in a terminal and paste the result under Settings → Trova → Engine binary path.
- **The engine does not start, or stops.** Run `trova doctor` in a terminal. It checks the Node version, SQLite, the models and the index. Node 22.12.0 crashes in the SQLite library the engine uses; update Node.
- **Something else.** Click Trova in the status bar. When the engine is off or has failed, the popover has a "Copy debug info" button; paste its output into a [GitHub issue](https://github.com/ibimal/trova-obsidian/issues).

## What the plugin does on your computer

Obsidian asks plugins to state these things.

- **It runs a separate program.** The plugin starts the `trova` engine that you installed, as a background process. It never downloads or installs programs itself.
- **Network.** The plugin talks only to the engine, on `127.0.0.1`, with a token that only your user account can read. The engine downloads its models from Hugging Face once, after you click Start (about 330 MB, and about 1.7 GB more for Deep mode, which the plugin downloads only after you confirm). The models have their own licences, listed in the [engine's README](https://github.com/ibimal/trova#models). Your notes never leave the computer.
- **No telemetry.** The plugin and the engine collect no usage data and send nothing anywhere.
- **Files outside the vault.** Only if you add folders under Settings → Trova → Outside folders. The engine then indexes those folders, and Instant search shows their files.
- **Optional local HTTP API.** Off by default. When you turn it on, the plugin serves read-only search, Ask and related-notes endpoints on `127.0.0.1`, protected by a token shown in the settings.
- **Image text.** If the Text Extractor plugin is installed and image attachments are indexed, Trova asks it for the text in your images and sends that text to the engine.

## Where notes open

Every list and graph follows Obsidian's own rule. A click opens a note in the current tab; with Cmd (Ctrl on Windows and Linux) in a new tab, with Cmd+Alt in a split, and with Cmd+Alt+Shift in a new window. A middle-click opens a new tab. Enter takes the same modifiers in Instant search, the Connections pane, Vault care and the two graphs. The similarity graph, Vault care and the topic map keep their state in the tab's history, so Back returns to them as they were. To keep one of them in place while notes open beside it, pin its tab.

## Where data lives

| Data                                                                                      | Location                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine index and models                                                                   | Managed by the engine; see its [README](https://github.com/ibimal/trova#where-data-lives)                                                       |
| Settings, pins, hides, pane filters, folder context, Vault care choices                   | The plugin's `data.json`, synced with the vault. When the plugin repairs damaged entries, it first copies the file to `data.backup-<time>.json` |
| Query history, last-opened times, basket, today's Rediscover pick, pane layout            | Obsidian's local storage, per device                                                                                                            |
| State of open tabs: the similarity graph's centre note, size and lock; Vault care's group | Obsidian's workspace layout, per device                                                                                                         |

## Development

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

`npm run lint` checks the code against Obsidian's own ESLint rules (`eslint-plugin-obsidianmd`), the rules Obsidian's review uses. `npm run format` formats the code with [Oxfmt](https://oxc.rs/docs/guide/usage/formatter), at the version and settings the engine repository uses, so the shared contract stays identical; `npm run format:check` checks it, as CI does. Update Oxfmt only together with the engine's Vite+, as [its `docs/development.md`](https://github.com/ibimal/trova/blob/main/docs/development.md#updating-vite) describes.

`npm run dev` rebuilds `main.js` on every change. To try a build, copy `main.js`, `manifest.json` and `styles.css` into a vault's `.obsidian/plugins/trova/` folder and reload Obsidian. A git-ignored `test-vault/` folder in this repository is a convenient place for that vault.

`docs/notes.md` records where the plugin differs from its specification, what it adds, and what was measured. `src/contract/` is a copy of the engine's `/v1` contract from the [trova repository](https://github.com/ibimal/trova/tree/main/src/contract); keep the two identical, and copy any change across. `test/contract.test.ts` and the notes in `test/fixture.ts` are copied from there too; the contract test differs only in its test import (`vitest` here, `vite-plus/test` there). The plugin connects only to an engine that serves its API major version; [the engine's `docs/api.md`](https://github.com/ibimal/trova/blob/main/docs/api.md) gives the rules. The plugin's logic is tested with a mocked `obsidian` module; the views are checked in a running Obsidian.

To release a version, run `npm version` with `patch`, `minor` or `major`, then push the commit and the tag:

```bash
npm version patch
```

```bash
git push --follow-tags
```

`npm version` sets the version in `package.json`, `manifest.json` and `versions.json` (with the lowest Obsidian version it supports, from `manifest.json`'s `minAppVersion`), commits them, and tags the commit with the bare version, as Obsidian requires. GitHub Actions then check that the tag matches `manifest.json` and `versions.json`, run the tests, build the plugin, and create a draft release with `main.js`, `manifest.json` and `styles.css` attached. Review the draft on GitHub and publish it.

The first release, 0.1.0, already has its version everywhere; tag it directly:

```bash
git tag 0.1.0
```

```bash
git push origin 0.1.0
```

## Licence

MIT; see `LICENSE`. `main.js` includes [MiniSearch](https://github.com/lucaong/minisearch) by Luca Ongaro (MIT), whose notice is at the top of the file. No code is copied from Smart Connections or Omnisearch.
