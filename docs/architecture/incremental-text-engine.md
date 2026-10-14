# Hanul incremental text engine PoC

Date: 2026-10-15

## What is implemented

- `text-document-engine.ts` owns a paragraph-sequence implicit treap. A text edit replaces only the affected paragraph node(s); locating a paragraph is logarithmic and does not clone the document.
- Each paragraph has its own wrapping result and page placements. A line-count change recalculates subsequent paragraph placements until an unchanged paragraph receives the same pagination input state. If the edited paragraph keeps the same flow, no later paragraph is laid out again.
- A page Display List holds text lines. SVG is generated and cached by page; caret, selection, and IME preedit are overlays rather than SVG content regeneration.
- Undo/redo stores paragraph-local before/after data. Continuous insertion coalesces. Paragraph split/merge, page-break insertion, formatting, search/replace, and Korean IME commit are covered by tests.
- Blank documents and eligible existing HWP/HWPX documents use this session in the desktop UI. The RHWP adapter converts only single-section body text whose controls, fields, bookmarks, headers/footers, styles, page properties, paragraph properties, and character properties pass a positive feature gate. It transfers paragraph text/runs, basic character formatting, alignment/indent, page breaks, and page size/margins. A document containing a table is tested to remain on the RHWP compatibility session. New-model table/object/section/header/footer commands remain disabled.
- `rhwp-plain-text-serializer.ts` is a file-format adapter only. It builds a fresh RHWP document in batch mode, writes the supported text model and supported formatting, then exports with a loss report. HWP and HWPX output are reopened in tests. The tested fixture includes paragraph alignment, bold/size, and a hard page break.

This PoC intentionally does not claim layout equivalence with Hancom. Line measurement is a deterministic approximation; paragraph line spacing, paragraph spacing, font shaping, bidirectional layout, tables, objects, fields, headers/footers, multi-section documents, and custom styles are not represented. Such documents stay on RHWP. The supported subset's HWP/HWPX outputs are tested for text, common character formatting, paragraph alignment, page breaks, page dimensions/margins, and zero RHWP-reported export loss; byte-for-byte file fidelity and Hancom GUI rendering are not established. The IME test drives Hanul's existing composition gate with a committed Korean syllable; it does not verify Microsoft IME, IBus/Fcitx, or desktop preedit rendering.

## Windows synthetic benchmark

Command: `npm run benchmark:editor-engine` from `apps/desktop` on Windows 11 x64, Node v24.16.0. Each document size runs in a fresh process. Documents contain 44 one-line Korean paragraphs (about 32 characters) per synthetic page; this exercises document size and pagination, not HWP parser work or complex layout. Values are synchronous engine times. `editToSvgMs` is insertion through generating the affected page SVG; it excludes React DOM commit and physical display latency.

| Pages | Paragraphs | Build model | RSS delta after build | Model mutation range | Incremental layout range | Page SVG range | Edit through SVG range | Paragraphs laid out per edit |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 44 | 1.79 ms | RSS noisy (-1.9 MiB) | 0.007–0.078 ms | 0.009–0.043 ms | 0.066–0.170 ms | 0.119–0.765 ms | 1 |
| 35 | 1,540 | 12.17 ms | 11.6 MiB | 0.013–0.123 ms | 0.010–0.050 ms | 0.058–0.141 ms | 0.152–0.810 ms | 1 |
| 98 | 4,312 | 24.82 ms | 22.1 MiB | 0.040–0.127 ms | 0.019–0.053 ms | 0.123–0.243 ms | 0.506–0.974 ms | 1 |
| 500 | 22,000 | 98.10 ms | 75.2 MiB | 0.018–0.127 ms | 0.025–0.086 ms | 0.067–0.138 ms | 0.493–1.715 ms | 1 |

The 1-page RSS delta is negative because process RSS is noisy under GC. Other RSS numbers are process resident-memory deltas, not exact engine heap allocation. A same-page text insertion in this synthetic corpus stayed below 2.1 ms including SVG generation, and the synchronous engine operation did not approach 16 ms. This is not a browser keyboard-to-paint or GUI benchmark.

The baseline RHWP tests remain much slower: the recorded synthetic 35-page RHWP single-character insertion was about 1.0–1.2 seconds, and the 98-page insertion about 8.6–9.6 seconds. This import step does not speed complex files; they deliberately remain on the compatibility path to avoid silently losing tables, objects, styles, or metadata. Eligible simple imports now edit on the Hanul path.

## Platform validation

| Platform | Build | Automated tests | Scope limits |
| --- | --- | --- | --- |
| Windows 11 x64, Node 24.16.0 | Pass | Latest full run recorded in the compatibility matrix | No GUI/physical IME run in this task |
| Ubuntu 26.04 WSL2, Node 22.22.1 | Pass | Latest full run recorded in the compatibility matrix | Current dependencies request Node 22.22.2 or newer and emitted engine-version warnings. No WSLg, standalone X11/Wayland, IBus, or Fcitx GUI test was run. |

The WSL run used an isolated temporary copy so Linux optional packages would not alter the Windows `node_modules`. The HWP/HWPX serializer tests use RHWP WASM and reopen the output; they verify generated text documents only, not cross-platform Hancom fidelity.

## Next integration gates

1. Grow the feature inventory and import/export round-trip checks before admitting styles, paragraph spacing, fields, objects, or tables to the Hanul model.
2. Keep complex HWP/HWPX files on RHWP until every unsupported node can round-trip exactly or is represented by an explicit preservation layer.
3. Replace approximate glyph widths with a cross-platform shaping/measurement backend and compare page breaks against reference documents.
4. Add model mutation tests with long paragraphs, Unicode combining sequences, mixed fonts, and line-count convergence over a 500-page corpus.
5. Measure actual Tauri key-to-render/commit timing on Windows and Linux before claiming 16 ms UI response. Worker scheduling is not justified for the current pure-text synthetic layout timings; it should be revisited when richer layout work crosses the UI budget.
