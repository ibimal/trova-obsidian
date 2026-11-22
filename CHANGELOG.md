# Changelog

All notable changes to the Trova plugin for Obsidian. Versions follow [semantic versioning](https://semver.org).

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
