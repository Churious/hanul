# Hanul project instructions

- Refer to the user as "주인님".
- Keep claims about HWP/HWPX support tied to tests and documented upstream behavior.
- Never discard unsupported document content silently. Do not add save or conversion paths until they can report content loss.
- Keep the desktop UI behind a small document-engine adapter. Do not couple React components to RHWP internals.
- Do not add Hancom binaries, proprietary assets, commercial fonts, or private documents to the repository.
- Preserve third-party license and copyright notices. Review dependency licenses before adding packages.
- Keep core document work offline. Do not add analytics, accounts, remote APIs, or runtime font downloads.
- Run the build and tests when changing code. Record platform limits accurately.
- Follow the upstream RHWP contribution and license terms if its Rust source is ever copied or modified.

