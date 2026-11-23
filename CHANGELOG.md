# Changelog

All notable changes to the Trova plugin for Obsidian. Versions follow [semantic versioning](https://semver.org).

## 0.1.3

- Downloading the Deep models from the Ask pane shows the download's progress, and the question runs again in Deep mode by itself when the models are ready. If the download stops, the pane says so and offers to try again.
- Related notes are ordered by the similarity the pane shows. The engine's ranking adds a bonus for further matching sections, which made the list look out of order; it now only breaks ties.
- The Note, Section and Selection tabs are drawn from the theme's own colours: a track like the search field, and the selected tab in the accent-tinted highlight Obsidian uses for active items.
- The notice at the end of the first index is clearer: what was indexed, the suggested hotkeys with this platform's key symbols, and a Set hotkeys button that opens the Hotkeys settings filtered to Trova's commands.
- The README describes installing and updating from Obsidian's community plugins.

## 0.1.2

- Fixes the error in Obsidian's review of 0.1.1: the Connections pane's room for the status bar now passes through a CSS custom property, which the stylesheet turns into padding.
- Merges a duplicated style rule for the Vault care tags. Nothing changes in how the plugin looks or works.

## 0.1.1

Fixes from Obsidian's automated plugin review:

- The Connections pane no longer clears heights by assigning inline styles; it removes the property instead.
- The stylesheet has no `!important` left. More specific selectors give the same result, checked in Obsidian for the inputs, the search box and every pane.
- The search worker uses its own timer.
- Release files carry a GitHub build provenance attestation.
- The README states that the plugin lists the vault's files to index them, and that it only writes to the clipboard, when you choose a copy action.

## 0.1.0

- First release: Instant search, the Connections and Ask pane, the similarity graph, the Context basket, Vault care, the topic map and a Bases view, on one local index. Semantic search needs the Trova engine, `trova-cli`, with HTTP API 1.x. Desktop only; requires Obsidian 1.13.4 or later.
