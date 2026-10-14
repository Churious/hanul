# Hancom Hanword 2024 UI inventory

## Machine and method

- Application: Hancom 한글 2024 / HOffice130.
- Executable: `C:\Program Files (x86)\HNC\Office 2024\HOffice130\Bin\Hwp.exe`.
- Inspection date: 2026-10-13 (Windows 11).
- GUI method: Windows Computer Use (`@oai/sky`) screenshots and accessibility trees. We opened the app already running with the Hanul compatibility-check HWPX, inspected the ribbon tabs, File menu, text context menu, ruler, page, quick-access toolbar, and status bar. No document content was intentionally changed during menu inspection.
- Binary research: REA 6.4.0 with Ghidra 12.1.4 was configured and verified on a locally authored native PE sample. The installed Hanword binary survey is documented in [hancom-binary-survey.md](hancom-binary-survey.md). Hanword Hwp.exe is managed and not accepted by the current Windows Ghidra provider; one native module was analyzed and larger modules exceeded REA analysis timeout. No protected resources or proprietary code were copied.
- The list below combines direct UI observations with the official Hanword help pages linked at the end. Individual dialogs and context menus for every object type were not all opened; those details remain unverified.

### Follow-up observation (2026-10-14)

The running Hancom 한글 2024 installation was reconfirmed at `HOffice130\Bin` (Hwp.exe 13.0.0.711). The accessibility-tree review from the prior GUI session remains the basis for the menu inventory below; the native window screenshot capture can include the wrong underlying window, so screenshot-only interpretation is not used as evidence for the Hancom window. The focused binary follow-up used ILSpy on Hwp.exe and Ghidra on HwpUIFilter.dll, as recorded in [the binary survey](hancom-binary-survey.md). No installed Hancom document was edited or saved during this follow-up.

## Main editor frame

Directly observed:

- Menu/ribbon tabs: **파일, 편집, 보기, 입력, 서식, 쪽, 보안, 검토, 도구**. A context-sensitive **도형** tab is disabled until a drawable object is selected.
- The ribbon shows grouped, icon-led commands with text labels and Alt access hints. Tabs change ribbon content without switching to a separate document view.
- The page canvas is centered between horizontal and vertical rulers, with a document tab strip beneath it. The title bar, quick-access toolbar, scroll bars, and zoom are visible.
- Quick-access/format toolbar: new, open, save, print, preview, undo, redo, style, language, font family, font size, bold, italic, underline, strike-through, and font color.
- Status bar: page count; column, line, cell, and character counts; input state; section count; insert/overwrite state; change-tracking state; typing count; page-outline/width/page-fit view controls; zoom slider and percentage.
- Text context menu observed at a body caret: paste, character table, print, character shape, paragraph shape, styles, bullets/numbering, hyperlink, new memo, fill, correction marks, personal-information protection, translation, change tracking, and word lookup.

## Directly observed ribbon commands

| Tab | Visible groups and commands |
| --- | --- |
| **편집** | Undo/redo, cut/copy/paste, format painter, clear layout marks, character shape, paragraph shape, styles, vertical/horizontal text orientation, page margins, master page, columns, shapes, picture, table, chart, select/protect objects, find, replace, alignment. Commands can be disabled when the current selection does not support them. |
| **보기** | Page outline/document view; paragraph marks, grid, layout guides, transparent lines, correction marks, memo, Hanja readings, ruler/grid/guides, work-window tools, pane split, window arrangement/switching, zoom. |
| **입력** | Shape gallery (text boxes, rectangle, ellipse, line, arc, polygon, curve, freehand, connectors); picture, table, chart, WordArt, equation, OLE, form object, field, footnote, endnote, memo, correction marks, bookmark, cross-reference, hyperlink, character table, input helper, Hanja. |
| **서식** | Style gallery, character and paragraph formatting, font-size adjustment, style selection, bullets/numbering, character/paragraph options. |
| **쪽** | Page setup, portrait/landscape, margins, text direction, master page, header, footer, page border/background, page numbering/restart/hide, line numbers, page and column breaks, columns, section split/settings, label, manuscript paper. |
| **보안** | Document password; distribution-copy save/edit; selected-text protection; personal-information find/protect/unprotect/password; document security settings. Several actions were disabled in the inspected document. |
| **검토** | Correction marks, document history, compare, change tracking, annotations/memo display, original/final views, accept/reject changes, previous/next change, new memo and memo settings. |
| **도구** | Index, table of contents, citations/bibliography, script macros, spell check, quick proofing, dictionary, translation, presentation, keyboard layout, user preferences, application options, personal-information replace, Hancom Asset, Office Talk. Some controls were disabled in the inspected document. |

## File menu observed

New document/templates/start assistant; open; PDF and image-to-office conversion; XML documents; save, Save As, PDF and mobile-optimized save; document information; DAISY; CCL and public-license insertion; braille conversion; send; edit-page setup; print preview; print; recent documents; close; exit. Official help expands XML, DAISY, braille, and send into subordinate commands.

## Official menu/help inventory

Hancom's official help lists detailed commands and keyboard shortcuts. The app's current ribbon presentation differs from classic menu pages, so help is used to expand subcommands, not as a claim that every command was visible in this session.

- [Hanword 2024 File menu](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/file.htm)
- [Hanword 2024 Edit menu](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/edit.htm)
- [Hanword 2024 View menu](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/view.htm)
- [Hanword 2024 Help index](https://help.hancom.com/hoffice130/ko-KR/Hwp/file/password/password.htm) (menu families, tables, drawing, add-ins, and shortcuts)
- [Hancom Office 2024 product lineup](https://www.hancom.com/support/faqCenter/faq/detail/2849)
- [Official table creation help](https://help.hancom.com/hoffice130/ko-KR/Hwp/table/table.htm)
- [Official search/format help](https://help.hancom.com/hoffice130/ko-KR/Hwp/edit/find/find%28format%29.htm)
- [Official memo help](https://help.hancom.com/hoffice130/ko-KR/Hwp/insert/memo/memo.htm)

## Hanul implications

Hanul uses its own React/Tauri ribbon and page canvas, RHWP model mutations, rulers, document tabs, and status bar. The feature matrix is explicit about which observed functions are connected, partial, missing, or unverified. This inventory describes reference behavior only; it does not claim Hanul already implements it.
