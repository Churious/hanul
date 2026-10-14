# RHWP analysis

## Evidence reviewed

- Public RHWP repository README and English README, accessed 2026-10-13.
- Public Export API wiki page.
- @rhwp/core npm package version 0.8.7 metadata, README, declaration files, and MIT license, inspected from its published tarball.
- The upstream repository was cloned and its source tree inspected at commit 1a76570e833917d15817415a53c09ad61ab3203f (2026-10-13). Inspection focused on src/document_core, parser/renderer module boundaries, src/wasm_api.rs, Cargo.toml, and Cargo.lock; this is a targeted architecture/API review, not a line-by-line audit of the full repository.

References: [RHWP repository](https://github.com/edwardkim/rhwp), [English README](https://github.com/edwardkim/rhwp/blob/main/README_EN.md), [Export API guide](https://github.com/edwardkim/rhwp/wiki/Export-API-%EC%82%AC%EC%9A%A9-%EA%B0%80%EC%9D%B4%EB%93%9C), [npm package](https://www.npmjs.com/package/@rhwp/core).

Pinned source references: [DocumentCore](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/document_core/mod.rs), [WASM API](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/src/wasm_api.rs), and [renderer](https://github.com/edwardkim/rhwp/tree/1a76570e833917d15817415a53c09ad61ab3203f/src/renderer).

## Observed upstream implementation

Source inspection confirms a Rust DocumentCore domain model, separate parser and renderer modules, and adapters including the Wasm API. Parsing paths are divided by format and body/control concerns; rendering code has composition, layout, pagination, SVG, and Canvas areas. The published README additionally claims HWP 5.x/HWPX parsing and rendering for tables, equations, images, charts, pagination, headers/footers, and notes. These upstream claims do not establish that every file in Hanul's corpus renders correctly.

Version 0.8.7 publishes @rhwp/core as an MIT-licensed Wasm parser/renderer with TypeScript declarations and an 11.8 MB Wasm module. The declarations and inspected implementation expose:

- new HwpDocument(bytes)
- pageCount()
- renderPageSvg(pageIndex)
- getSourceFormat()
- HWP/HWPX export methods and numerous edit commands
- DocumentExport.contentLoss() and one-shot takeBytes() for a save result that carries a content-loss report

HwpDocument wraps DocumentCore; the native API also exposes from_bytes, and SVG rendering delegates to the native rendering path. The separate @rhwp/editor package offers a complete web UI inside an iframe. Hanul does not use that UI: it calls the low-level core package through an adapter and provides its own desktop shell.

## Integration decision

The app uses @rhwp/core 0.8.7 as a pinned major/minor dependency. `DocumentSession` isolates React from RHWP classes and wraps hit testing, page rendering, body/cell text edits, character/paragraph formatting, selection geometry, table creation, edit history, and loss-aware export. This lets the UI use the RHWP document as its source of truth without depending on internal model types. The page rendering API is synchronous, so large pages may still block the WebView while rendering; virtualization limits the number of pages rendered at once but does not make a single-page render asynchronous.

RHWP also exposes many additional editing operations that Hanul has not connected yet. The currently wired table, formatting, selection, and clipboard workflows are early implementation and still need desktop interaction and HWP/HWPX round-trip verification. Earlier text-only HWPX smoke evidence does not establish those newer workflows or general preservation.

## Licensing

The package metadata lists MIT and identifies Edward Kim as the author. Its packaged license is retained under licenses/npm-production/. A Cargo metadata inventory of the inspected RHWP WASM dependency graph is in licenses/rhwp-wasm-dependencies.csv; that inventory comes from the cloned source lockfile and does not prove the published Wasm binary's exact build provenance. The RHWP source is not copied into this repository.

