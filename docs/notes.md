# Design notes

The plugin implements a written features and API specification that is not published here. These notes record where the plugin differs from it, what it adds, and what was checked during the build. The engine's notes are in the [trova repository](https://github.com/ibimal/trova): its README and `docs/spikes.md`.

## Deviations from the spec

- **Bases.** Obsidian's Bases API has no way to register custom functions. `trova_score()` and `trova_related()` ship as a Bases view named "Trova related" with a Score column and a Related column.
- **Ask lives in the Connections pane.** The spec has separate Connections and Ask panes. They share one pane: with an empty search box it lists related notes; a typed question replaces them with answers, and Esc goes back.

## Additions beyond the spec

- **Similarity graph.** The command "Open similarity graph" draws the active note, its related notes and the edges between related notes on one canvas. Shift+click expands a note; double-click opens it. The graph holds at most 400 notes. A smaller copy sits in a resizable drawer at the bottom of the Connections pane, with its selection kept in step with the list.
- **Vault care tab.** Near-duplicates, orphans and Rediscover in one editor tab. "Not a duplicate" and "Keep unlinked" are remembered across scans, with Undo and a list to restore them.
- **Where notes open.** Every list and graph follows Obsidian's own rule; the README describes it. The similarity graph, Vault care and the topic map open in the current tab and keep their state in the tab's history.
- **Deep time limit and "Rerank now".** Deep mode's time limit is a setting (15 seconds by default). When a rerank still runs out of time, the pane offers to rerank that question again with a long limit.
- **Topic map on canvas.** The topic map uses the same canvas, so it pans and zooms with thousands of notes.
- **Ask without the engine.** When the engine is off, Ask returns keyword matches from the worker and says so.
- **Query history.** Alt+Up and Alt+Down walk through earlier Instant search queries.
- **Live overlay.** The editor's text reaches the worker 250 ms after the last keystroke, before Obsidian saves the note.

## Not built

- Mobile runs Instant search from the worker and nothing else. Semantic search on mobile waits for the planned Rust engine and its WebAssembly build.
- The end-to-end layer of the test plan (a scripted Obsidian instance). The plugin's logic is tested with a mocked `obsidian` module. Its views have no automated tests in this repository; they were checked in a running Obsidian.

## Findings

### Bases custom functions

**Not supported.** The typings expose `Plugin.registerBasesView(viewId, registration)` and the `BasesView` class. They expose nothing that registers a formula function. Package 14 therefore ships as a custom Bases view (`src/features/bases.ts`): a table with the note, its similarity score to the active note, and its top three related notes. The view registers only when `registerBasesView` exists, so the plugin still loads on Obsidian 1.9.

### Worker timings on 10,000 generated notes

`test/extras.test.ts` builds 10,000 notes of about 300 words each and times the worker's index on Node 24 (M-series Mac). The vocabulary has only 40 words, so every query word matches thousands of notes; a real vault is easier.

| Measurement | Result |
| --- | --- |
| Metadata pass, 10,000 files | 78 ms |
| Body pass, per 50-file batch | 6.9 ms |
| Search, title lane and overlay (engine running), p50 / p95 | 1.7 ms / 6.2 ms |
| Search, title lane and all bodies (no engine), p50 / p95 | 13.6 ms / 23.9 ms |
| Typo rescue, slowest of three queries | 31.8 ms |
| Fresh edit indexed | 0.2 ms |

These times exclude the message hop to the worker and the DOM render. They were not measured inside Obsidian.
