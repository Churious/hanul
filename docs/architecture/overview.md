# Architecture overview

## Current runtime

The desktop shell is Tauri 2 with React and TypeScript. The page view is RHWP's current layout of the HWP/HWPX document model. Hanul does not keep a second plain-text document: pointer hit tests, text edits, paragraph changes, character formatting, paragraph alignment, and table creation call RHWP's model APIs through `apps/desktop/src/hwp-engine.ts`.

`DocumentSession` owns RHWP Wasm and exposes edit operations, caret/selection geometry, undo/redo, page rendering, and report-aware export. React renders the latest RHWP SVG after model changes. An invisible textarea only receives OS keyboard and IME composition events; the visible caret, selection, page layout, and saved bytes come from the RHWP document model.

The current UI includes Home/Insert ribbons, a horizontal page ruler, a page canvas, and a status bar. Text selection is restricted to one paragraph within the body or one table cell. Table creation and basic cell text editing are wired. Row/column commands, nested-table paragraph formatting, images and other object editing remain future work. Header/footer, footnote, field, and text-box locations are not editable yet.

SVG output passes through DOMPurify and a local-reference check before insertion into the page DOM. Page rendering is virtualized. Export uses the source format and displays RHWP's content-loss report before saving when the report contains entries. A zero-entry report does not prove that every document construct round-trips exactly.

## Layers

| Layer | Responsibility | Current limit |
| --- | --- | --- |
| Format adapter | RHWP Wasm parse, render, edit, and report-aware HWP/HWPX export | Compatibility evidence is still limited to a one-page HWPX text-edit smoke |
| Document session | Model positions, page hit tests, same-paragraph selections, edit history, and formatting commands | No full-document rich clipboard or cross-paragraph selection history yet |
| Layout/render | RHWP page SVG and virtual page list | Page format controls and print/PDF are not wired |
| Desktop | Tauri open/save dialogs, keyboard input, clipboard, ribbons, rulers, status | Native IME and clipboard behavior require desktop verification |
| Verification | TypeScript build plus existing focused model tests | The editor expansion needs round-trip and UI coverage |

## Data and security boundaries

- The user chooses each file through the Tauri file dialog; there is no background directory scan.
- Files over 200 MiB are rejected before reading into memory.
- Pages are rendered lazily and cached for the active session.
- SVG script, foreign-object, active content, and external references are removed.
- The packaged Content Security Policy allows local resources, Tauri IPC, and development origins.
- Core document work runs locally; no account, analytics, or remote font service is used.
- Every save checks RHWP's content-loss report before writing output.

## Editing contract

The RHWP document remains the single source of truth. Editing commands invalidate the page cache so the next rendered page reflects model changes. Undo/redo stores text operations, character-shape runs, paragraph alignment, and table insertion data in the session. Extending commands to other document objects must preserve their underlying RHWP data and add a tested undo/export path before the UI enables them.
