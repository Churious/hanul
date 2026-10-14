# Testing and verification

## Local checks completed

From apps/desktop:

- `npm test -- --reporter=verbose` passes 11 tests. They cover document validation, zoom/size helpers, SVG sanitization, Korean text edits, paragraph undo/redo, HWP and HWPX export/reopen with zero-loss reports, whole-document find/replace with one undo, and table row insertion/cell merge with snapshot undo/redo and HWP reopen. HWPX tests verify source text, inserted text, formatted body text, and newly created table-cell text after reopening.
- `npm run build` passes TypeScript and Vite production build. The output includes the RHWP Wasm asset.
- Before the editor expansion, `npm run tauri build -- --bundles nsis` produced a Windows x64 release executable and 4.99 MiB NSIS installer. The app package has not been rebuilt after the editor changes.
- The current Windows development desktop shows the Hanul ribbon, a blank HWP page, ruler, and page-count/status UI. A GUI typing attempt through Computer Use opened a `localhost:1420` clipboard-read permission prompt before text entry could be verified. Per the Computer Use safety instructions, no choice was made on that privacy prompt; desktop typing, save, and reopen therefore remain unverified.
- Hanword 2024 reference UX — Computer Use captured the File menu, Edit/View/Insert/Format/Page/Security/Review/Tools ribbons, body-text context menu, rulers, quick-access toolbar, page canvas, document tabs, and status bar. See [hanword-ux.md](../research/hanword-ux.md).
- HWP compatibility tests use `createNewHwpDocumentSession`, the same initialized blank-template path as the desktop app. Raw `HwpDocument.createEmpty()` has no default character-shape records; inserting text into it directly fails in RHWP layout and is not the app's new-document path.

## Not yet verified

- Native Windows installer launch, reliable visual capture, and file association.
- Linux .deb/AppImage local build and launch, X11/Wayland, Linux IME, and printing. GitHub Actions is configured, but has not run in this workspace.
- HWP binary sample parsing.
- Multi-page, table, image, shape, header/footer, note, and mixed-font HWPX render.
- Native Windows Hanul IME composition, selection, formatting, table editing, clipboard, keyboard-only workflows, and GUI save/reopen. The UI shell launches, but the typing attempt was stopped at the clipboard permission prompt described above.
- Preservation of pre-existing tables, images, shapes, and other mixed objects through HWP/HWPX edits; PDF and print. HWPX round-trip currently covers formatted body text and a newly created table, not preservation of a complex user document.
- Fuzzing, malformed ZIP/OLE cases, and memory limits under stress.

The smoke document was created locally and is not committed. No Hancom-generated document or user document is included in the repository.

