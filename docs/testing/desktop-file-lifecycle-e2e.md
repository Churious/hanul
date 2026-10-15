# Desktop file lifecycle E2E

This suite drives a development-only Tauri 2 window and validates the product's existing React lifecycle and Rust save pipeline. It does not start the normal Hanul window or use the browser fallback.

## Run on Windows

From `apps/desktop`:

```powershell
npm run test:e2e:desktop
```

Requirements: Windows, Node/npm dependencies already installed, Rust/Cargo, and the Tauri Windows build prerequisites. The runner uses a separate app id (`org.hanul.word.e2e`), window title (`Hanul V1-02c E2E`), Vite port `1422`, WebDriver port `4445`, and a fresh `$TEMP\hanul-v102c-e2e-*` data directory. Override `HANUL_E2E_WEBDRIVER_PORT` if port 4445 is occupied. Build artifacts use `$TEMP\hanul-v102c-cargo-target` (override with `HANUL_E2E_CARGO_TARGET`). The `webdriver-e2e` feature and its fault-injection commands exist only in debug E2E builds; the application has a compile-time release guard.

Tauri's embedded WebDriver plugin drives the WebView using W3C WebDriver. `tauri-plugin-wdio-webdriver` 1.5.0 is MIT-licensed; its inspected server binds to loopback on Windows/Linux. A separate PowerShell UI Automation helper addresses only the named E2E app and its owned native Windows file dialog; it sets the common-dialog filename field through its native control and independently reads the value back through UI Automation. It does not enumerate or interact with unrelated user windows. The E2E capability grants filesystem access only below its generated temp directory. WebDriver and its `allow-destroy` permission are enabled only by the optional `webdriver-e2e` debug feature and E2E configuration; a compile-time guard in the application crate rejects release builds with that feature, and the normal app uses only `default` capability. `cargo check --release --features webdriver-e2e --locked` was verified to fail at that guard.

The repeatable native-dialog GUI runner remains Windows-only. On 2026-10-16, a separate WSLg Ubuntu 26.04 smoke test used the Linux `xdg-portal` backend and the portal's AT-SPI controls. The dialog was a separate Wayland client and did not appear in the X11 window tree; xdotool events sent to the X11 Hanul window could not operate it. Selecting Save through AT-SPI returned the path to Hanul, invoked the product save pipeline, created the HWPX file, and showed the saved marker after reopening it from Recent. This explains the earlier xdotool focus failure in this WSLg setup; it does not establish a general Linux X11/Wayland issue or certify all Linux file-dialog flows.

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
| App exit | Cancel keeps the document; Discard closes the E2E app window; Save commits, terminates the native process, and the output reopens with its saved text |
| Real parse-completion race | Uses the checked-in valid HWP fixture; pauses after RHWP/Hanul parsing and before session commit, then tests newer normal open, Recent open, and document close |
| Delayed atomic save commit | Pauses after staged-file compatibility validation and before the actual atomic replacement; verifies post-snapshot edits remain dirty and open/close/exit/duplicate Save cannot replace the active document |
| Actual Windows filesystem permission failure | Applies a scoped NTFS ACL to the generated test directory to deny stage-file creation; verifies the original file bytes and dirty editor remain unchanged, then restores the ACL |

The passing Windows 11 run on 2026-10-16 executed 16 scenarios and 38 GUI assertions with zero failed scenarios. Assertions check rendered reopened document text and file bytes where relevant; the suite is not a general raw-format compatibility test. The HWP round-trip uses the checked-in single-textbox compatibility fixture; the suite does not claim broad Hanword interoperability.

## Test layers and limits

- **Frontend/unit:** `npm test`; includes request-generation, stale parsed-session disposal, unsaved-choice resolution, save lock, and edit-revision policy tests.
- **Tauri IPC/backend:** Rust workspace tests cover the staged-file compatibility inspection, atomic commit, and failure/original-file preservation. The E2E app invokes the same registered product commands and file-system plugin used by the desktop UI.
- **Native desktop GUI:** `npm run test:e2e:desktop` above. Windows 11 passed 16 scenarios / 38 assertions, including the product save-commit gate, actual HWP parse races, NTFS ACL write denial, and exit Save followed by process termination and reopen.
- **Linux/WSLg GUI smoke:** In Ubuntu 26.04 WSLg, a WebDriver-enabled Tauri app was launched with its X11 window and the actual GTK portal dialog was addressed through AT-SPI. The Save dialog callback returned a selected path; trace events showed the app proceeded to `save-export-requested` and `save-finished-for-pending-action(saved=true)`. The HWPX output under `$TEMP\hanul-v102c-e2e-portal-smoke\wslg-save.hwpx` was 7,275 bytes and reopened through Recent with the marker rendered. Dirty-exit Cancel retained the editor state; Discard terminated the app and did not write the unsaved marker to the saved file. The Open portal was shown and cancellation returned `selected=false`; file open itself was verified through Recent, not through selecting the native Open dialog.
- **Still unverified:** repeatable Linux native-dialog E2E automation, file selection through the Linux Open dialog, Linux actual filesystem permission denial, delayed-save/late-parse GUI races on Linux, dirty-exit Save on Linux, ordinary Linux X11/Wayland desktops, Fcitx5/IBus IME, and Hanword 2024 open/save in this lifecycle run. Do not infer them from the Windows suite or WSLg smoke.

If Linux native-dialog automation is unavailable, perform this minimum manual WSLg check in a disposable test folder: create a new document, type a unique marker, Save As HWPX, confirm the file exists and is nonempty, close and reopen it and confirm the marker renders; then open a disposable HWP fixture, edit and Save As another path, reopen, and verify the marker. Repeat close with Save, Discard, and Cancel, then check Recent reopen and a missing Recent path. Record each filesystem path and outcome. This does not test ordinary X11/Wayland desktops or Linux IME unless those are separately exercised.

Linux unit/build validation is run separately in Ubuntu 26.04 WSL2. WSL2 frontend/Rust tests are not evidence for ordinary X11 or Wayland desktops.

## Platform run recorded 2026-10-16

- **Windows 11:** `npm test -- --reporter=dot` passed 111/111; `npm run build` passed; Rust workspace tests passed 16 with 1 ignored; `cargo fmt --check` passed; `npm run tauri build -- --no-bundle` produced the E2E-tested Windows release executable in the isolated temp target; the native desktop E2E passed 16 scenarios / 38 assertions.
- **Ubuntu 26.04 WSL2/WSLg:** Linux frontend copy passed 111/111 and `npm run build` on Node 22.22.1. Linux Rust workspace tests passed 16 with 1 ignored; `cargo build --workspace --locked` succeeded; the WebDriver-feature Tauri debug build launched under WSLg. Both used `CARGO_TARGET_DIR` and `TMPDIR` under the Windows temp volume because WSL `/tmp` had about 131 MiB free (99% used). `cargo fmt --check` is unavailable because this WSL toolchain has no `cargo-fmt` component. The portal Save + Recent reopen and dirty-exit Cancel/Discard smoke passed as detailed above. The normal runner still exits early on Linux; no repeatable Linux full lifecycle suite or ordinary Linux desktop verification is claimed.
