# Architecture overview

## Current runtime

The desktop shell is Tauri 2 with React and TypeScript. The editor selects a session behind `DocumentSession`: new blank files and positively identified single-section text documents use Hanul's paragraph-oriented model; documents with tables, objects, fields, bookmarks, headers/footers, multiple sections, custom styles, or unsupported formatting remain in the RHWP compatibility session. The independent model uses an implicit-treap paragraph sequence, paragraph-local line layout, page display lists, and page SVG caches. Its HWP/HWPX output is materialized through RHWP's batch serializer.

`DocumentSession` owns edit operations, caret/selection geometry, undo/redo, page rendering, and report-aware export. React renders page-local SVG and separate caret, selection, and IME preedit overlays. The RHWP adapter inspects imported HWP/HWPX structure and copies supported body paragraphs, character runs, basic paragraph properties, hard page breaks, and single-section page definitions into the Hanul model. Unknown or unsupported nodes keep the original RHWP session. IME preedit remains transient until the OS commits text, then the active document model changes once.

The current UI includes Home/Insert ribbons, a horizontal page ruler, a page canvas, and a status bar. The Hanul text session handles body paragraph editing for documents admitted by the feature gate. Tables, images, shapes, headers/footers, footnotes, fields, text boxes, and other unsupported structures continue to use the RHWP compatibility session; they are not yet represented by the independent text model.

SVG output passes through DOMPurify and a local-reference check before insertion into the page DOM. Page rendering is virtualized. Export uses the source format and displays RHWP's content-loss report before saving when the report contains entries. A zero-entry report does not prove that every document construct round-trips exactly.

## Layers

| Layer | Responsibility | Current limit |
| --- | --- | --- |
| Format adapter | RHWP Wasm parse and positive feature gate; batch RHWP serialization for Hanul text documents | Controls, custom styles, unsupported formatting, fields, and complex sections still use RHWP |
| Document session | Shared `DocumentSession`; RHWP compatibility adapter and independent Hanul text model | Hanul model represents body paragraphs, supported character/paragraph formats, page breaks, and one page definition |
| Layout/render | RHWP rendering for complex imports; Hanul paragraph layout, justified-line display lists and cached page SVG for eligible documents | Glyph metrics, line spacing, and paragraph spacing remain approximate; complex HWP/HWPX layouts stay on RHWP |
| Desktop | Tauri open/save dialogs, keyboard input, clipboard, ribbons, rulers, status | Native IME and clipboard behavior require desktop verification |
| Verification | TypeScript build and automated model/export/reopen tests | The new import path is not yet covered by a broad real-world corpus or GUI/IME validation |

## Data and security boundaries

- The user chooses each file through the Tauri file dialog; there is no background directory scan.
- Files over 200 MiB are rejected before reading into memory.
- Pages are rendered lazily and cached for the active session.
- SVG script, foreign-object, active content, and external references are removed.
- The packaged Content Security Policy allows local resources, Tauri IPC, and development origins.
- Core document work runs locally; no account, analytics, or remote font service is used.
- Every save checks RHWP's content-loss report before writing output.

## Editing contract

The active session is the single source of truth. Hanul text edits invalidate the affected paragraph and page cache; if the paragraph's line count changes, pagination continues only until the incoming page/line state matches an unchanged paragraph. The import gate checks controls, fields, bookmarks, headers/footers, section count, styles, and unsupported format properties before conversion. Tests cover HWP and HWPX import/edit/export/reopen for the supported subset and confirm table documents stay on RHWP. This is a narrow compatibility gate, not a guarantee for untested Hancom-specific data outside RHWP's exposed inspection APIs.
