# Hanul Desktop

The Tauri 2 desktop application for Hanul Document. It uses React and TypeScript for the interface and the RHWP WebAssembly package behind a small document-session adapter.

From this directory:

~~~powershell
npm ci
npm test
npm run build
npm run tauri dev
npm run tauri build
~~~

The current editing scope is main-body paragraphs. Tables, text boxes, fields, headers/footers, notes, formatting, print, and PDF export remain outside the implemented editor scope. See the repository [compatibility matrix](../../docs/compatibility/matrix.md) and [test status](../../docs/development/testing.md).
