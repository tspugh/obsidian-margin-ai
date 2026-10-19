# Margin AI public specification

## Status and scope

Margin AI is an experimental, desktop-only Obsidian plugin in active development. It combines PDF++-derived document tooling with source-linked annotations and ChatGPT conversations. It is not an official Obsidian, OpenAI, or Codex product.

## Document capture

- A capture refers to a Markdown or PDF source and may contain a selected passage, source position, PDF page/geometry, and source-version information where available.
- Conversations may be attached to a passage or the whole document.
- Saved annotations are Markdown files in a configurable vault-relative annotation folder.
- Source links and anchors allow navigation back to the captured location.

## Conversations and context

- Users can create, reopen, continue, cancel, retry, delete, summarize, and export conversations.
- Responses stream into the active matching conversation without overwriting a different conversation or draft.
- Request context is bounded and user-selectable. It can include the captured passage, surrounding or whole-document text, selected vault notes, and optional rendered PDF page images.
- Context paths must be vault-relative, and configured exclusions prevent matching folders from contributing AI context.
- Long conversations require a valid summary or a new conversation once request limits are reached.
- Automatic summaries are optional and can make additional model requests when enabled.

## Authentication and network behavior

- ChatGPT sign-in uses an authorization-code flow with state, nonce, PKCE, issued-client, identity, and granted-scope validation.
- Tokens and session credentials are memory-only and are not written to plugin settings or the vault. Plugin or application reload requires sign-in again.
- Sign-out clears local credentials and attempts remote token revocation when the provider exposes a revocation endpoint.
- Questions, enabled context, and optional personalization data are sent to OpenAI only as needed to perform the requested model operation.

## Personalization

- Output styles are stored in a plugin-owned Markdown profile inside the annotation folder.
- Approved memory is disabled by default. When enabled, only enabled entries are added as bounded, untrusted user context.
- Automatic memory suggestions are separately disabled by default. When enabled, a bounded completed conversation is sent in an additional request to propose durable user-stated facts or preferences.
- Suggested entries remain pending until approved. Users may reject, disable, edit, or remove memory entries.
- Personalization content must not contain secrets.

## Native PDF highlights

- Native highlight writing is an explicit PDF-editing operation and supports color updates.
- The implementation checks that the PDF version still matches the captured selection before writing.
- Before the first modification of a PDF version, the plugin attempts to create a copy in `<annotation folder>/PDF backups/`. If backup creation fails, it does not write the highlight.
- Encrypted or password-protected PDFs must be unlocked in a copy before editing. Users should maintain independent backups for important files.

## PDF++ foundation

The project retains substantial PDF++ functionality, including PDF navigation and links, backlink visualization, outlines and page labels, selections and embeds, PDF composition, viewer context menus, and related workspace integrations. PDF++ is MIT-licensed work by Ryota Ushio; its attribution and copyright notice are retained.

Margin AI and PDF++ should not be enabled simultaneously because they patch overlapping Obsidian PDF viewer internals.

## Non-goals and safety boundaries

- Margin AI is not a general autonomous agent or full Codex implementation.
- It must not claim endorsement by Obsidian or OpenAI.
- Credentials, private keys, vault data, generated backups, local profiles, and private development artifacts do not belong in the public repository.
- Model output and stored context are untrusted data. Users remain responsible for reviewing generated text and file changes.
