# Desktop file lifecycle E2E

This suite drives a development-only Tauri 2 window and validates the product's existing React lifecycle and Rust save pipeline. It does not start the normal Hanul window or use the browser fallback.

## Run on Windows

From `apps/desktop`:

```powershell
npm run test:e2e:desktop
```

Requirements: Windows, Node/npm dependencies already installed, Rust/Cargo, and the Tauri Windows build prerequisites. The runner uses a separate app id (`org.hanul.word.e2e`), window title (`Hanul V1-02c E2E`), Vite port `1422`, WebDriver port `4445`, and a fresh `$TEMP\hanul-v102c-e2e-*` data directory. Override `HANUL_E2E_WEBDRIVER_PORT` if port 4445 is occupied. Build artifacts use `$TEMP\hanul-v102c-cargo-target` (override with `HANUL_E2E_CARGO_TARGET`). The `webdriver-e2e` feature and its fault-injection commands exist only in debug E2E builds; the application has a compile-time release guard.

Tauri's embedded WebDriver plugin drives the WebView using W3C WebDriver. `tauri-plugin-wdio-webdriver` 1.5.0 is MIT-licensed; its inspected server binds to loopback on Windows/Linux. A separate PowerShell UI Automation helper addresses only the named E2E app and its owned native Windows file dialog; it sets the common-dialog filename field through its native control and independently reads the value back through UI Automation. It does not enumerate or interact with unrelated user windows. The E2E capability grants filesystem access only below its generated temp directory. WebDriver and its `allow-destroy` permission are enabled only by the optional `webdriver-e2e` debug feature and E2E configuration; a compile-time guard in the application crate rejects release builds with that feature, and the normal app uses only `default` capability. `cargo check --release --features webdriver-e2e --locked` was verified to fail at that guard.

The repeatable native-dialog GUI runner remains Windows-only. On 2026-10-16, separate WSLg Ubuntu 26.04 GUI checks used the Linux `xdg-portal` backend and portal AT-SPI controls. The dialog was a separate Wayland client and did not appear in the X11 window tree; xdotool events sent to the X11 Hanul window could not operate it. AT-SPI checks selected HWP/HWPX fixtures, used product Open/Save commands, and exercised Linux write failure, the real pre-atomic-replace save gate, and exit Save followed by fresh-process reopen. See V1-02e below. This explains the earlier xdotool focus failure in this WSLg setup; it does not establish a general Linux X11/Wayland issue or certify all Linux file-dialog flows.

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
- **Linux/WSLg GUI smoke:** In Ubuntu 26.04 WSLg, a WebDriver-enabled Tauri app was launched with its X11 window and the actual GTK portal dialog was addressed through AT-SPI. The Save dialog callback returned a selected path; trace events showed the app proceeded to `save-export-requested` and `save-finished-for-pending-action(saved=true)`. The HWPX output under `$TEMP\hanul-v102c-e2e-portal-smoke\wslg-save.hwpx` was 7,275 bytes and reopened through Recent with the marker rendered. Dirty-exit Cancel retained the editor state; Discard terminated the app and did not write the unsaved marker to the saved file. The Open portal was shown and cancellation returned `selected=false`.
- **V1-02e WSLg follow-up (2026-10-16):** From a separate test app, AT-SPI selected `/home/competitor/hanul-v102e-e2e-6e5e74c9a30b/open-source.hwp` and `open-source.hwpx` from the portal's `Files` table. The HWP fixture body/textbox text and HWPX marker appeared in Hanul with their formats identified. Canceling Open while dirty retained active content and dirty state. A mode-000 file failed with OS read `Permission denied`; the prior HWPX remained active. Permissions were restored to `600`; source fixture hashes were unchanged. HWP/HWPX Recent reopen, dirty Recent Cancel/Discard and Save As cancel retained the expected document state. A real HWP parse was held at the E2E post-parse gate; a newer Recent HWPX opened while held, and releasing the old parse did not replace it. The Document Information dialog showed filename/path/format/size/pages/sections/engine version/encryption/font, but no title/author/created/modified fields.
- **Linux OS write failure:** We first attempted a chmod-restricted destination outside the E2E capability scope. Tauri rejected it with `forbidden path`, before the OS attempted the write; this is a capability failure, not `EACCES`. Then the app was restarted with its E2E temp scope under `/home/competitor`. In an isolated directory owned by `competitor:competitor`, mode `700` was changed to `500`; actual product Save failed to create its staged `.tmp` file with `Permission denied (os error 13)`. The existing HWPX SHA-256 (`086e140880a29398aa1a2ad99a4ae2f7f4e65baf3cad547588367b2ab4ecc0db`) was identical before/after, the dirty marker remained visible, and the test directory mode was restored to `700` with owner unchanged; the file remained mode `600`.
- **Linux save commit race:** The existing E2E-only delay gate ran after product staged write, compatibility inspection/reparse, and immediately before atomic replacement. In a first run, snapshot A was saved while edit B happened after snapshot capture: the output had A but not B and the live document stayed dirty. In a second run, A+B was saved while C was edited: Save/New/Open/Close/Exit menu actions were disabled during the gate; the committed snapshot contained A+B, not C, and the live document remained dirty. A follow-up product Save cleared dirty and the re-parsed HWPX contained A+B+C. This was a manual WSLg GUI check using existing E2E hooks, not a repeatable Linux test suite.
- **Linux dirty-exit Save/reopen:** In a dirty HWPX, End → Save completed product save and the app process exited with code 0. A fresh app process opened the same HWPX through native Open and displayed `LINUX_EXIT_SAVE_REOPEN_20261016` in the page. The app was then closed cleanly. This confirms the tested graceful close/save path only, not forced-termination or power-loss durability.
- **Still unverified:** A repeatable Linux native-dialog E2E runner, ordinary Linux X11/Wayland desktops, Linux IBus/Fcitx5 IME, and Hanword 2024 file lifecycle are not covered by these WSLg checks. General Linux desktop and IME support are tracked by V1-15/V1-04, not as V1-02 blockers. WSLg does not certify those environments.

If Linux native-dialog automation is unavailable, perform this minimum manual WSLg check in a disposable test folder: create a new document, type a unique marker, Save As HWPX, confirm the file exists and is nonempty, close and reopen it and confirm the marker renders; then open a disposable HWP fixture, edit and Save As another path, reopen, and verify the marker. Repeat close with Save, Discard, and Cancel, then check Recent reopen and a missing Recent path. Record each filesystem path and outcome. This does not test ordinary X11/Wayland desktops or Linux IME unless those are separately exercised.

Linux unit/build validation is run separately in Ubuntu 26.04 WSL2. WSL2 frontend/Rust tests are not evidence for ordinary X11 or Wayland desktops.

## Platform run recorded 2026-10-16

- **Windows 11:** `npm test -- --reporter=dot` passed 111/111; `npm run build` passed; Rust workspace tests passed 16 with 1 ignored; `cargo fmt --check` passed; `npm run tauri build -- --no-bundle` passed and produced `target/release/hanul-desktop.exe`; the existing native desktop E2E passed 16 scenarios / 38 assertions in V1-02d (not rerun because no product code changed).
- **Ubuntu 26.04 WSL2/WSLg:** Linux frontend copy passed 111/111 and `npm run build` on Node 22.22.1. Linux Rust workspace tests passed 16 with 1 ignored; `cargo build --workspace --locked` had passed during V1-02d, and the WebDriver-feature Tauri debug build launched under WSLg. For this follow-up, Cargo was first pointed at the Windows-mounted temp target, where native linking made no progress; that process was stopped and tests were rerun successfully with the isolated Linux target `/home/competitor/hanul-v102e-cargo-target`. `/tmp` had about 131 MiB free (99% used). `cargo fmt --check` is unavailable because this WSL toolchain has no `cargo-fmt` component. WSLg AT-SPI checks passed for portal Open/Recent, OS read and write permission errors, dirty preservation, actual save commit delay/race, and dirty-exit Save followed by fresh-process reopen. The Linux debug E2E binary was an existing build; a fresh Tauri link was not completed in this follow-up. There is no repeatable Linux native-dialog suite, and ordinary Linux desktop verification remains unclaimed.

## V1-02e WSLg result (2026-10-16)

This follow-up used the isolated Linux Tauri E2E debug app and real GTK/portal UI. The portal was controlled with AT-SPI, not direct file-path injection into the app. It is a manual WSLg GUI run using existing WebDriver and E2E-only lifecycle gates, not a repeatable Linux native-dialog test runner.

| Scenario | Result |
| --- | --- |
| Native Open → HWP fixture | Selected `open-source.hwp` from the portal table; Hanul displayed the HWP body and textbox reproduction text, with `hwp · Hanul 엔진` status. |
| Native Open → HWPX fixture | Selected `open-source.hwpx`; Hanul displayed `V102D_WSLG_PORTAL_SMOKE` with `hwpx · Hanul 엔진` status. |
| Open cancel while dirty | Portal Cancel returned `selected=false`; current title/content/dirty indicator stayed. |
| Open access failure | Selected a separate mode-000 HWPX file; the OS returned read `Permission denied`. The prior active file/content and dirty state remained. Test mode was restored to 600. |
| Recent reopen and dirty protection | HWP and HWPX were reopened from Recent. Cancel retained the dirty current document; Discard opened the requested file. |
| Save As cancel | Portal Cancel returned `selected=false`; active path, content and dirty state were unchanged. |
| Late parse result | Held a valid HWP parse after engine parsing, opened a newer HWPX from Recent, then released the old HWP result. The active format/content remained the newer HWPX. |
| Document Information | HWP/HWPX dialog showed filename, path, format, size, page/section count, engine version, encryption state and used font. Title, author and created/modified timestamps are not present in the model/UI; no synthetic values were supplied. |
| Save write failure | The initial out-of-scope attempt returned Tauri `forbidden path`, which was distinguished from OS access denial. An in-scope Linux directory changed from mode `700` to `500`; product stage-file creation returned OS `Permission denied (os error 13)`. Existing HWPX SHA-256 remained `086e140880a29398aa1a2ad99a4ae2f7f4e65baf3cad547588367b2ab4ecc0db`; dirty state remained. Mode/owner and file mode were restored/preserved. |
| Delayed save commit | Existing E2E gate paused the product save after stage write/validation and before atomic replace. Post-snapshot edits were excluded from the saved snapshot and retained dirty state; a follow-up save and reopen contained all edits. Save/New/Open/Close/Exit actions were disabled while the gate was held. |
| Dirty-exit Save and fresh-process reopen | End → Save wrote the HWPX, the app exited with code 0, and a new process opened the file through native Open and rendered `LINUX_EXIT_SAVE_REOPEN_20261016`. |

The mode-000 file was restored to 600. The write-denial directory was restored to mode 700; its owner remained `competitor:competitor`, and its file remained mode 600. HWP/HWPX source fixture hashes were unchanged. The WSLg GUI evidence covers V1-02's remaining Linux lifecycle checks, but does not establish ordinary Linux X11/Wayland, IME, a repeatable native-dialog suite, or Hanword 2024 compatibility.
