# Editing latency and data preservation

Measurement date: 2026-10-15

## Editing latency

The adapter test builds a synthetic HWP document from 1,400 repeated Korean/Latin paragraphs (35 pages), reopens it, then times one synchronous edit command. The Node test uses RHWP's WASM build and a fallback text-width callback (`8 px × character count`); these are engine-command timings, not physical keyboard-to-paint latency or real-file results.

| Command | Windows 11 x64 / Node 24.16 (2 runs) | Ubuntu 26.04 WSL2 / Node 22.22 (2 runs) | Snapshot pair time (Win, Linux) |
| --- | ---: | ---: | ---: |
| Single-character model insertion (`가`) | 1,051.38–1,059.55 ms | 1,121.14–1,141.04 ms | 0 / 0 ms |
| Paragraph alignment change | 1,019.09–1,116.35 ms | 1,080.83–1,111.44 ms | 0.30–0.32 ms / 0.33–0.43 ms |
| Add one table row | 150.93–159.31 ms | 147.25–159.53 ms | 0.20–0.25 ms / 0.24–0.35 ms |
| Move a rectangle by 1 mm | 85.06–96.21 ms | 79.61–79.91 ms | 0.09–0.10 ms / 0.08–0.11 ms |

A second late-page insertion probe measured 1,051.63–1,139.97 ms on Windows and 1,138.54–1,156.48 ms on WSL2. It then measured an unchanged first-page SVG cache lookup at 0.19–0.21 ms / 0.35–0.43 ms and changed last-page SVG generation at 0.93–0.94 ms / 1.10–1.19 ms. The generated SVG was 124,444 characters; the retained unchanged page SVG was 832,447 characters.

The previous benchmark run recorded 1,143.53 ms / 1,210.61 ms for late-page insertion. No layout algorithm changed in this work; run-to-run timing variation is not evidence of a code speedup. Process RSS snapshots ranged from 108.7–184.3 MiB on Windows and 221.2–321.1 MiB on WSL2 while the WASM allocator retained or released pages. These process-wide readings do not establish per-command memory use; per-edit allocation is unverified.

### What is doing the work

- `insertText` does not create document snapshots. Paragraph formatting, table structure changes, and object property changes each create before/after snapshots, but the measured pair took 0.09–0.33 ms, far below the 80–151 ms edit command time. Snapshot copying is not the measured typing bottleneck.
- RHWP's text-edit path reflows and recomposes the changed paragraph, then calls `paginate_if_needed`. The pagination implementation selectively reuses paragraph/table measurements when possible, but it rebuilds page composition for the dirty section. In a one-section, 35-page document, a one-character insertion and paragraph format therefore take about one second.
- RHWP's `beginBatch` skips pagination during edits, but `endBatch` synchronously paginates. Its deferred-pagination API is restricted to supported table-cell flow edits and does not cover ordinary text insertion. Deferring this work or moving it to a Worker would change responsiveness, not the measured computation.
- The SVG cache already retains unchanged earlier pages. In this probe the changed page SVG takes around 1–2 ms; it is not responsible for the one-second edit delay.

No Worker or full engine rewrite was introduced: neither is supported by the current measurement as a way to reduce total edit computation. These timings measure RHWP model commands, not physical key-to-paint latency. A real speedup requires paragraph/page-level incremental page composition in RHWP or a separately validated Hanul layout path. That larger change needs page-boundary convergence tests for wrapping, tables, floats, headers/footers, sections, and cross-page objects before it can replace the current paginator.

### 2026-10-15 interaction and 100-page follow-up

The follow-up adds a UI-only drag preview for selected objects. Pointer Events are coalesced through `requestAnimationFrame`; intermediate move/resize samples update the existing selection outline, and pointer-up commits one `updateObject` call. Pointer cancellation clears the preview without changing the document. Text selection hit-testing is likewise capped at one sample per animation frame. The generated document SVG is now a stable sibling layer: caret, selection, and object-selection overlays no longer concatenate into and reparse the entire SVG string on each React update. Unit tests verify latest-sample coalescing, cancellation, move/resize bounds, and minimum object size.

The current synthetic model-command measurements remain slow:

| Probe | Windows 11 x64 / Node 24 | Ubuntu 26.04 WSL2 / Node 22 |
| --- | ---: | ---: |
| 35-page character insert | 1,113.39 ms | 1,223.59 ms |
| 35-page paragraph alignment | 1,076.12 ms | 1,118.35 ms |
| 35-page table-row insertion | 170.00 ms | 150.10 ms |
| 35-page object move model update | 93.22 ms | 82.71 ms |
| 98-page character insert | 9,475.39 ms | 9,628.87 ms |
| 98-page character insert in batch mode | 9,159.63 ms | 9,941.25 ms |
| 98-page synchronous batch finalization | 174.58 ms | 176.73 ms |

The 35-page timings are a synthetic RHWP/WASM fixture, not actual physical key-to-paint input. The 98-page case is also synthetic (4,000 repeated lines; generated page count was 98), not a real customer file. They show that pagination alone is not the dominant 98-page cost: skipping pagination during the edit still leaves 9.2–10.0 seconds of synchronous work, while the final batch pagination takes under 0.21 seconds. Exact subphase timing inside RHWP is not exposed by the WASM API, so this does not identify which of text insertion, paragraph reflow, vertical-position recalculation, or recomposition dominates.

Upstream RHWP source at commit [`1a76570e`](https://github.com/edwardkim/rhwp/tree/1a76570e833917d15817415a53c09ad61ab3203f) confirms the path: `insert_text_native` reflows the edited paragraph, recalculates section vertical positions, recomposes that paragraph, and invokes pagination; it may repeat the sequence up to twice if the paragraph changes columns. `recompose_paragraph` composes one paragraph and marks paragraph/section dirty, while `paginate_if_needed` skips the page pass in batch mode. `recalculate_section_vpos` walks from the changed paragraph through the remaining paragraphs. The source has paragraph-level reuse, but no evidence that page composition is bounded to only the changed page. The measured batch experiment is consistent with significant work before the final page pass. Source references: [`insert_text_native`](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/document_core/commands/text_editing.rs#L1422), [`recompose_paragraph` and pagination](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/document_core/queries/rendering.rs#L4279), and [`recalculate_section_vpos`](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/renderer/composer/line_breaking.rs#L4833).

The page SVG cache remained cheap in the changed-page probe: Windows late-page model edit 1,258.16 ms, unchanged page lookup 0.21 ms, changed-page SVG render 3.16 ms; WSL2 edit/reflow 1,208.98 ms, unchanged lookup 0.45 ms, changed SVG 1.59 ms. SVG generation and React SVG replacement were not the one-second model-command bottleneck. Windows GUI smoke testing on a disposable document verified table row add/Undo/Redo, shape move/resize, drag Undo/Redo, and HWP save/reopen with object coordinates retained. Final WSLg release testing verified table row insertion, shape drag, Undo/Redo, GTK save to `/tmp/hanul-linux-perf-final-20261015.hwp`, and reopen with the three-row table and X/Y coordinates retained. These GUI checks are functional smoke tests, not frame-time measurements; standalone X11/Wayland were not verified. Development builds emit per-gesture raw move count, processed frame count, maximum frame gap, duration, and final model-commit time; no 60 FPS result is claimed until those traces are collected on representative hardware.

**Outcome:** the interaction path now avoids applying a full document edit and rebuilding the page SVG for every drag event, but the 35-page text insertion target is not met and the model-command measurements did not improve. A Worker could keep this synchronous computation from blocking paint, but would not reduce its 9–12 second cost. The next performance step must instrument RHWP's inner stages or implement a validated page/paragraph incremental layout slice; a Worker alone is not a compute optimization.

## Header/footer field preservation

Hanul currently inserts page number, total-page, and file-name markers into the RHWP header/footer model as U+0015, U+0016, and U+0017 control characters. These markers are not complete field records with their original field command/reference metadata. RHWP's HWPX text writer filters other control characters below U+0020 from `<hp:t>`; the HWP and HWPX round-trip tests also show that the marker does not return as the same field after export/reopen.

Hanul checks header/footer paragraphs before offering the exported bytes for saving, reopens the generated bytes to verify each marker at its original paragraph index, and reports the precise section/page scope/field when it is missing. Save UI requires an explicit “continue despite possible loss” action. If inspection or reopen verification fails, it reports that preservation could not be verified. This is a loss warning, not field preservation; no lossless save claim is made for these generated marker fields. The regression test covers all three marker kinds in both HWP and HWPX. A corpus test using imported Hanword field records and checking their reference metadata remains necessary.

## Linux GUI validation scope

The Linux test/build target is Ubuntu 26.04 under WSL2/WSLg (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, IBus `hangul`). This does not establish compatibility on a standalone X11 or Wayland desktop. GUI results for object edits, file dialogs, IBus model commit, save, and reopen are recorded in `docs/compatibility/matrix.md` after the current WSLg test run.
