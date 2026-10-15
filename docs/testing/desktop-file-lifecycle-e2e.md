# Desktop file lifecycle E2E

This suite drives a development-only Tauri 2 window and validates the product's existing React lifecycle and Rust save pipeline. It does not start the normal Hanul window or use the browser fallback.

## Run on Windows

From `apps/desktop`:

```powershell
npm run test:e2e:desktop
```

Requirements: Windows, Node/npm dependencies already installed, Rust/Cargo, and the Tauri Windows build prerequisites. The runner uses a separate app id (`org.hanul.word.e2e`), window title (`Hanul V1-02c E2E`), Vite port `1422`, WebDriver port `4445`, and a fresh `$TEMP\hanul-v102c-e2e-*` data directory. Override `HANUL_E2E_WEBDRIVER_PORT` if port 4445 is occupied. Build artifacts use `$TEMP\hanul-v102c-cargo-target` (override with `HANUL_E2E_CARGO_TARGET`).

Tauri's embedded WebDriver plugin drives the WebView using W3C WebDriver. `tauri-plugin-wdio-webdriver` 1.5.0 is MIT-licensed; its inspected server binds to loopback on Windows/Linux. A separate PowerShell UI Automation helper addresses only the named E2E app and its owned native Windows file dialog; it sets the common-dialog filename field through its native control and independently reads the value back through UI Automation. It does not enumerate or interact with unrelated user windows. The E2E capability grants filesystem access only below its generated temp directory. WebDriver and its `allow-destroy` permission are enabled only by the optional `webdriver-e2e` debug feature and E2E configuration; a compile-time guard in the application crate rejects release builds with that feature, and the normal app uses only `default` capability. `cargo check --release --features webdriver-e2e --locked` was verified to fail at that guard.

The current native-dialog GUI runner is Windows-only. On other platforms it exits before launching a test window rather than reporting a false pass. WSLg can build and start the WebDriver-enabled Tauri app, but the Linux GTK/portal Save picker did not return focus after the test path was entered, leaving the product in its normal pending-save state and creating no file. The WSLg attempt verified app rendering and the typed marker in the live page; it did not verify save, reopen, Recent, or close flows. Linux front-end and Rust test results are recorded below, but they do not replace native GUI validation.

## What the current suite covers

| Scenario | Evidence |
| --- | --- |
| New document → type → HWPX Save As → close → open | Native Save/Open dialogs; file is parsed again by the app and marker text is visible after reopening |
| Existing HWP → edit → Save As HWP → reopen | Uses a checked-in HWP fixture copied into the isolated temp directory; checks reopened marker text |
| Recent document and stale path | Reopens the saved HWP from Recent; moving the test copy makes the entry fail, report an error, and be removed from local storage |
| Unsaved close: Cancel / Save | Cancel retains rendered content and dirty status; Save writes a file, closes the document, and reopening shows the marker |
| Unsaved new document: Discard | Replaces the dirty document with a clean blank one |
| Native save-dialog cancel | Leaves the unsaved prompt, editor content, and dirty status intact |
| Save failure | The test capability denies a temp path outside its narrow scope; no output appears and the document remains dirty. This exercises Tauri permission rejection, not a Windows ACL/NTFS permission denial. |
| Native window close | Cancel retains the active document |
| Close while save transaction is active | Requests native window close while the native Save picker is open; the app remains available, then the deferred close continues after Save and the output reopens with its text |
| App exit | Cancel keeps the document; Discard closes the E2E app window |

Assertions check the rendered reopened document text as well as disk output size; the suite is not a raw byte-equality test. The HWP round-trip uses the checked-in single-textbox compatibility fixture; the suite does not claim broad Hanword interoperability.

## Test layers and limits

- **Frontend/unit:** `npm test`; includes request-generation, stale parsed-session disposal, unsaved-choice resolution, save lock, and edit-revision policy tests.
- **Tauri IPC/backend:** Rust workspace tests cover the staged-file compatibility inspection, atomic commit, and failure/original-file preservation. The E2E app invokes the same registered product commands and file-system plugin used by the desktop UI.
- **Native desktop GUI:** `npm run test:e2e:desktop` above. The passing run on 2026-10-16 executed 11 scenarios and 20 GUI assertions on Windows 11; it included native Windows file dialogs and exited with zero failed scenarios.
- **Not covered by this run:** actual NTFS ACL denial, editing while the disk commit itself is delayed, two overlapping real file parses resolving out of order in the GUI, exit via Save, Linux/WSLg native dialogs, IME, and Hanword 2024 open/save. Those remain unit/model-only or unverified and must not be inferred from this suite.

If Linux native-dialog automation is unavailable, perform this minimum manual WSLg check in a disposable test folder: create a new document, type a unique marker, Save As HWPX, confirm the file exists and is nonempty, close and reopen it and confirm the marker renders; then open a disposable HWP fixture, edit and Save As another path, reopen, and verify the marker. Repeat close with Save, Discard, and Cancel, then check Recent reopen and a missing Recent path. Record each filesystem path and outcome. This does not test ordinary X11/Wayland desktops or Linux IME unless those are separately exercised.

Linux unit/build validation is run separately in Ubuntu 26.04 WSL2. WSL2 frontend/Rust tests are not evidence for ordinary X11 or Wayland desktops.

## Platform run recorded 2026-10-16

- **Windows 11:** `npm test -- --reporter=dot` passed 111/111; `npm run build` passed; `cargo test --workspace --locked` passed 16 with 1 ignored; `cargo fmt --check` passed; `npm run tauri build -- --no-bundle` produced `target/release/hanul-desktop.exe`.
- **Ubuntu 26.04 WSL2:** Linux frontend copy passed 111/111 and `npm run build` on Node 22.22.1. Linux `cargo test --workspace --locked` passed 16 with 1 ignored, and `cargo build --workspace --locked` produced the debug Tauri binary. Both used `CARGO_TARGET_DIR` and `TMPDIR` under the Windows temp volume because WSL `/tmp` had 133 MiB free (99% used). `cargo fmt --check` is unavailable because this WSL toolchain has no `cargo fmt` subcommand. A WSLg Tauri E2E build launched and rendered the editor; WebDriver-entered marker text appeared in the live page. In the GTK/portal Save picker, the test path was entered and confirmation keys were sent, but the picker did not return focus to Hanul; Save stayed pending and no output file appeared. No Linux lifecycle scenario passed. The runner is therefore gated to Windows until a Linux-native dialog driver is verified. This does not certify ordinary Linux X11/Wayland desktop behavior.
