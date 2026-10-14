# Third-party notices

Hanul is distributed under the MIT License in `LICENSE`. It bundles the RHWP WebAssembly parser/renderer and Tauri runtime. It does not copy RHWP Rust source into Hanul's crates.

## Direct web runtime dependencies

| Package | Version | Declared license |
| --- | --- | --- |
| `@rhwp/core` | 0.8.7 | MIT |
| `@tauri-apps/api` | 2.12.3 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | 2.8.2 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-fs` | 2.7.0 | MIT OR Apache-2.0 |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 |
| `react` | 19.3.0 | MIT |
| `react-dom` | 19.3.0 | MIT |
| `react-virtuoso` | 4.18.19 | MIT |

The exact `LICENSE*`, `COPYING*`, and `NOTICE*` files from all ten resolved npm production packages are under `licenses/npm-production/`. The complete installed npm dependency inventory, including dev dependencies, is `licenses/npm-dependencies.csv` (122 packages; no package had a missing license expression in its manifest). `package-lock.json` pins the versions used for these counts.

## Tauri and RHWP Rust dependencies

`tauri` 2.12.3 and `tauri-build` 2.7.2 are declared Apache-2.0 OR MIT. The directly used `tauri-plugin-dialog` and `tauri-plugin-fs` crates are also MIT OR Apache-2.0. Cargo metadata inventories are included for 249 Windows-target and 287 Linux-target external crates, plus 156 external crates in the RHWP source tree's `wasm32-unknown-unknown` dependency graph. No package in these three resolved graphs had a missing Cargo license expression. The combined inventory has 432 distinct Rust packages; 778 upstream `LICENSE*`, `COPYING*`, `NOTICE*`, and `COPYRIGHT*` files are retained under `licenses/rust-crates/`.

- [Windows Tauri graph](licenses/tauri-windows-dependencies.csv)
- [Linux Tauri graph](licenses/tauri-linux-dependencies.csv)
- [RHWP WASM graph](licenses/rhwp-wasm-dependencies.csv)
- [Rust package license files](licenses/rust-crates/)

The RHWP graph comes from source commit `1a76570e833917d15817415a53c09ad61ab3203f`, whose workspace version is 0.8.7. This is a conservative source-based inventory; the published npm Wasm binary does not identify its exact build commit. `licenses/npm-production/` preserves the package license files shipped in the npm packages.

The resolved Rust expressions include MIT, Apache-2.0, BSD-3-Clause, Unicode-3.0, Zlib, Unlicense, CC0, and MPL-2.0 terms or alternatives. Their package-specific license files are retained where shipped. Eleven Rust packages had a declared license but no separate license file in their source package; their declared terms are represented by matching license texts retained from other packages. The only MPL-2.0 dependencies are unmodified upstream crates. No GPL or AGPL expression appeared in these resolved graphs.

## Attribution and source

- `@rhwp/core`: Copyright Edward Kim and RHWP contributors; MIT; [source](https://github.com/edwardkim/rhwp).
- React and React DOM: Copyright Meta Platforms, Inc. and affiliates; MIT; notices are retained with their package license files.
- `react-virtuoso`: Copyright Petyo Ivanov; MIT.
- Tauri: Copyright Tauri Apps contributors; Apache-2.0 OR MIT.
- DOMPurify: MPL-2.0 OR Apache-2.0; both package license texts are retained.

This inventory checks declared metadata and preserves package license files; it does not replace a legal review before publishing a release.

