# Margin AI

Margin AI is an experimental, desktop-only Obsidian plugin for keeping document-linked notes and ChatGPT conversations beside Markdown files and PDFs. It is in active development; interfaces, stored formats, and behavior may change.

Margin AI is an independent fork of [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) by Ryota Ushio. It retains PDF++'s extensive PDF navigation, linking, selection, outline, embed, and annotation tooling while adding a margin-oriented conversation workflow. It is not an official Obsidian or OpenAI product and is not endorsed by either company.

## Current features

- Capture text selections from Markdown and PDF documents as source-linked annotations.
- Hold multiple passage-level or whole-document conversations and reopen them from the Margin AI sidebar.
- Send bounded passage, document, vault-note, and optional rendered-PDF-image context with a question.
- Stream ChatGPT responses, cancel or retry requests, choose available models, and create or refresh conversation summaries.
- Export an annotation and its conversation to an ordinary Markdown note.
- Write native PDF highlights, including synchronized colors and recovery of already-written annotations.
- Use optional output styles and approved profile memory. Memory and automatic memory suggestions are off by default; suggestions stay pending until explicitly approved.
- Use inherited PDF++ tools for PDF links, backlinks, outlines, embeds, page labels, composition, and viewer workflows.

This plugin provides focused document conversation features, not a general-purpose Codex or autonomous coding agent.

## Privacy and safety

ChatGPT authorization credentials are held in memory only. Reloading Obsidian or the plugin clears the session, so you must sign in again. Do not place passwords, API keys, access tokens, private keys, or other secrets in prompts, annotations, profile memory, or repository files.

Questions can include the selected passage plus context that you explicitly enable. Approved memory entries may be included with later questions only when **Enable approved memory** is on. **Suggest memory updates** makes an additional model request over a bounded completed conversation; it is off by default, and proposed entries are not used as memory until approved. Review annotations, context-note selections, memory, and export files before sharing a vault.

Automatic conversation summaries can also make additional model requests when enabled. Keep that setting off if you do not want those requests.

Native PDF highlighting edits the PDF file. Before the first edit of a particular PDF version, Margin AI attempts to copy that version to `<annotation folder>/PDF backups/`; if backup creation fails, the highlight is not written. Backups reduce risk but are not a substitute for your own versioned backups. Test the feature on copies, especially with important, signed, unusual, or encrypted PDFs.

## Build

Requirements: Node.js with npm, plus Obsidian 1.5.8 or newer for use.

```sh
npm ci
npm test
npm run build
```

The production build creates `main.js` in the project root. It is intentionally ignored by Git.

## Manual installation

1. Build the plugin.
2. Create `<vault>/.obsidian/plugins/margin-ai/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into that directory.
4. Reload Obsidian and enable **Margin AI** under Community plugins.

Do not enable Margin AI and PDF++ at the same time. Margin AI retains and patches many of the same Obsidian PDF viewer internals, so running both can cause conflicting behavior.

This repository does not currently represent a Community Plugins marketplace release. Review the active-development warning and privacy notes before use.

## Development

```sh
npm run dev
```

The development build watches source files. Other useful checks are `npm test` and `npm run lint`.

## License and attribution

Margin AI is distributed under the MIT License. The upstream PDF++ copyright notice remains in [LICENSE](LICENSE), and additional dependency notices are in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
