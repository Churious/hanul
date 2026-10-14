# Build and environment

## Environment checked

| Tool or requirement | Result |
| --- | --- |
| OS / architecture | Windows 11 Education, AMD64 |
| Rust / Cargo | rustc 1.99.0, Cargo 1.99.0 |
| Node / npm | Node 24.16.0, npm 11.13.0 |
| Git | 2.54.0 |
| Codex CLI | Installed |
| WebView2 Runtime | Present |
| Hancom Office | 한글 2024 installed |
| Microsoft C++ Build Tools | cl.exe was not found on PATH during inspection; Tauri build nevertheless completed on this host |
| Linux distribution | WSL reports Docker Desktop only; no Ubuntu development distro was confirmed |
| Ghidra / Hopper / IDA | No supported analysis engine available |

## Windows setup

Install the Microsoft Visual Studio 2022 Build Tools from the [official download page](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select **Desktop development with C++**. Tauri also requires the WebView2 Runtime; Windows 11 normally includes it.

If using WinGet, review the workload and installer prompts:

~~~powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact
~~~

Then open a fresh terminal, verify cl.exe from a Visual Studio Developer Command Prompt, and run:

~~~powershell
cd apps/desktop
npm install
npm run tauri dev
npm run tauri build
~~~

Despite cl.exe not being discoverable in this shell, npm run tauri build -- --bundles nsis completed successfully on this Windows host. It produced target/release/hanul-desktop.exe and target/release/bundle/nsis/한울 문서_0.1.0_x64-setup.exe (4.99 MiB). This observed build is the authority for this machine; a clean Windows development host should still follow the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and install the documented Visual Studio C++ workload if required by its toolchain.

## Linux setup

For Ubuntu, install the platform packages described by the [official Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/), including WebKitGTK 4.1, a C/C++ compiler, GTK development headers, and librsvg2. Then install Rust and Node 24, and run the commands above.

The GitHub Actions workflow is configured to build Windows installers and Linux .deb and AppImage packages. No Linux runner result or local Linux build has been observed yet; this is configuration, not build evidence. A local desktop-session, IME, print, and Wayland/X11 test remains necessary.

