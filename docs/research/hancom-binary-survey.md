# Hancom Hanword 2024 binary survey

## Scope and method

Survey date: 2026-10-13. The installed product is under C:\Program Files (x86)\HNC\Office 2024\HOffice130. The Bin directory contains 242 EXE and DLL files.

The survey used read-only PE header, import, export, and embedded-string inspection with the Visual Studio Build Tools dumpbin utility. REA 6.4.0 and Ghidra 12.1.4 were used for native binary analysis. The Hanword installation was not modified, and no executable, DLL, private document, or proprietary resource was added to the repository.

PE exports and strings are observations about a particular installed build. They do not prove that a feature is invoked in a given workflow or that a format is fully supported. Interpretations are labeled as such.

## Installed binaries

All native files listed below are 32-bit x86 PE files from the same Office 2024 installation. File versions reported by Windows resources are 13.0.0.711 unless otherwise stated.

| File | Size | Observed structure |
| --- | ---: | --- |
| Hwp.exe | 1,868,200 bytes | x86 PE with a CLR/COM descriptor; file version 13.0.0.711, description HWP 2024, company Hancom Inc. Its import table lists mscoree.dll. REA's managed static provider and ILSpy confirm .NET Framework 4.8; the Windows Ghidra native provider does not admit managed PE files, so no Ghidra function analysis is claimed for this executable. Embedded names include .hwp, .hwpx, .xml, and managed UI/save-related identifiers. |
| HwpAppModule.dll | 4,672,936 bytes | x86 PE with a CLR descriptor. Imports HwpApp.dll, HwpImeUI.dll, HwpViewUI.dll, HwpUIFilter.dll, HncOOXML.dll, HncOfficeEngine.dll, HncDrawingEngine.dll and other shared components. This dependency set is consistent with a managed module bridging into native editor, input, view and filter components; that role is an inference from the names and imports. |
| HwordAppModule.dll | 5,203,368 bytes | x86 PE with a CLR descriptor. Imports HwordApp.dll, HncOOXML.dll, HncDrawingEngine.dll, HncVfs.dll, HncIMM.dll, HncOfficeEngine.dll, HncTranslator.dll and other shared components. Windows version-resource lookup returned no file-version string for this module. |
| HwpApp.dll | 9,287,592 bytes | Native x86 PE, 54 exported symbols. Exports include CHncOfficeEngine, CDRMModuleLoaderImpl, and notification methods named NotifyDocumentOpened, NotifyDocumentSaved and NotifyDocumentPreview. Imports include HncVfs, HncBaseDraw, HncDrawingEngine, HncOOXML, HncODF, HncFilterFoundation, HncChartBase, HncOfficeFoundation and HncBidiEngine. |
| HwordApp.dll | 23,667,624 bytes | Native x86 PE, 50 exported symbols; Windows version-resource lookup returned no file-version string. Its dependencies include HncODF, HncIMM, HncDrawingEngine, HncVfs, HncOfficeEngine, HncOfficeFoundation, HncImageIO, HncOOXML, ChartHandler and HncBidiEngine. Export names include CHncAABase accessibility/COM methods. Embedded diagnostic-style strings include childBlockIndex(para or table), paraFormatIndex, runFormatIndex, mergeFormat, layoutInCell, and AbstractParagraphReader. These names suggest structured paragraph/table formatting and accessibility plumbing, but do not by themselves establish the runtime feature path. |
| HncOOXML.dll | 5,694,888 bytes | Native x86 PE, file description HncOOXML 13.0. Imports HncFoundation and HncFilterFoundation plus Windows and C runtime libraries. Exported C++ names include OOXML::DRAWING::WORDML enum-value objects and ReadNodeValue/WriteElement methods. REA/Ghidra completed analysis of this module. |
| HncDrawingEngine.dll | 8,139,688 bytes | Native x86 PE, file description HncDrawingEngine 13.0. Imports GDI/GDI+, OpenGL/GLU, HncBidiEngine, HncOOXML, HncBaseDraw, HncImageIO, HncVfs and HncIMM. The imports indicate drawing and graphics integration; feature behavior was not dynamically tested. |
| HncIMM.dll | 598,952 bytes | Native x86 PE, file description HncIMM 13.0. Imports IMM32.dll, USER32.dll and HncBaseDraw.dll. This is direct evidence of a Windows IME-related dependency, not evidence that Hanword's complete Korean composition behavior was reproduced or tested here. |

HwpApp.dll imports the native office engine and document-format/drawing modules. HwordApp.dll adds the paragraph/table, accessibility, input-method, image and drawing dependencies seen above. The main executable and app-module DLLs include CLR metadata, while these component DLLs are native x86. This mixed managed/native structure is directly observed from PE headers and import tables.

## REA/Ghidra results

### Follow-up: managed entry point and targeted filter analysis (2026-10-14)

The active REA target is the installed Hancom product, not Hanul. REA reported JDK 21 and Ghidra 12.1.4, and the selected native target was `HwpUIFilter.dll` (PE32 x86, SHA-256 `869a8d9a735d5e2783c65d4dd66f062519cab7c3bd7144346e6b3404fc46c8ae`). The earlier Hanul binary session was closed before this survey.

REA's managed metadata provider confirmed that `Hwp.exe` is an IL-only x86 .NET Framework 4.8 executable. It reports 1,812 TypeDefs, 4,849 MethodDefs and 21 AssemblyRefs, including WPF and Hancom application modules such as `Hnc.Foundation.UI`, `HncOfficeModule`, `HwpEngineWrapper`, `HwpAppModule`, `Hwp.Dlg` and `HwpDialogModule`. Its native-boundary inventory lists 19 P/Invoke declarations in Kernel32, User32, Advapi32 and DbgHelp, plus 32 methods marked native; these are declarations/metadata observations, not verified runtime call paths.

ILSpy 9.1.0.7988 (self-contained x64 release, .NET 8) opened the installed `Hwp.exe` without executing it. The decompiled `Hwp.HwpAppMain` entry class shows a WPF application startup path: it parses command-line arguments, applies single-instance/process handoff logic, initializes the frame and app engines, and delegates document shell commands to the Hwp application layer. This confirms that `Hwp.exe` is an application/bootstrap layer, not the native document engine. No decompiled source or proprietary resource was saved into the repository. REA's full member inventory for `Hwp.exe` exceeded its 64 MiB metadata representation budget, so ILSpy was used for a focused entry-point inspection rather than a full source export.

The native `HwpApp.dll` remains the likely core-app candidate by its exports and dependencies, but full Ghidra inventory timed out after 300 seconds. To keep analysis bounded, Ghidra completed default analysis of the smaller `HwpUIFilter.dll`. In `FUN_10038f70` (1,120 bytes), the decompiler shows a `WM_COMMAND` handler that reads the current filter/list text, searches it for `hwpx`, and sets an internal HWPX-related flag. Its resolved callees include string helpers and UI/resource callbacks; Ghidra returned the caller/callee addresses, while computed indirect calls remain unresolved. This is evidence of format/filter UI logic, not proof of HWPX parsing or serialization. The earlier `FUN_100363b0` string-reference result also locates HWPX-related command handling in this module.

The managed `HwpAppModule.dll` metadata inventory includes names such as `IHwpDocument`, `IHwpUndoManager`, and frame proxy methods `OpenDocument`, `SaveAsDocument` and `SaveActiveDocument`; these names help identify the application/session boundary. They do not establish public or supported APIs, and Hanul must not bind to these private interfaces.

After Codex restarted, a fresh REA `binary_session` check confirmed `open: false`, no target selected, and an available Ghidra candidate at `C:\tools\ghidra_12.1.4_PUBLIC` using the 64-bit JDK at `C:\tools\jdk-21.0.12.1+1`. No Hanul binary was opened for REA analysis. The prior HwpUIFilter result remains the actual Hancom native analysis evidence.

### Controlled native PE validation

A small x64 Windows PE was built locally with exported probe_leaf and probe_compose functions. REA opened it as PE/x86-64. Ghidra listed both functions, returned disassembly for probe_compose, and decompiled it to the equivalent of:

    iVar1 = probe_leaf(param_1);
    return iVar1 * param_2;

The call graph showed 0x140001020 (probe_compose) calling 0x140001000 (probe_leaf). This verifies more than provider connectivity: function discovery, assembly, decompilation and call relationships all worked. The test files remain under the Windows temporary directory and are not project assets.

### Hanword modules

REA opened HncOOXML.dll as a 32-bit PE and completed default Ghidra analysis. A search found the exported OOXML::CSDEnumValueObject<OOXML::DRAWING::WORDML::ST_AlignH> constructor and its ReadNodeValue and WriteElement members. At 0x10004180, Ghidra returned x86 instructions and decompiled pseudocode for the copy constructor; the visible operations copy object fields and invoke a helper. The call graph reported one external target at EXTERNAL:0x48, whose identity was not resolved in this query.

This is an OOXML class, not proof of HWP or HWPX parsing. The evidence is limited to the named exported class and one function's analysis.

The other targets had explicit limits:

- Hwp.exe is now inspected as managed metadata and with a focused ILSpy entry-point view. The Windows Ghidra native provider still does not admit managed PE files.
- HwpApp.dll opened as native x86, but Ghidra's full document/function inventory request timed out (the current follow-up hit the 300-second request limit).
- HwordApp.dll opened as native x86, but its analysis request was cancelled while waiting after HwpApp.dll had exceeded the 330-second analysis timeout. No Ghidra function result is claimed for it.

The 2026-10-14 targeted `HwpUIFilter.dll` analysis, Hwp.exe managed inventory, P/Invoke declarations and ILSpy entry-point observation are described above; they do not remove these full-analysis limits.

## Hanul implications

- Preserve a managed/native boundary in compatibility research. The observed Hwp.exe and app-module layers are not interchangeable with the native document/drawing DLLs.
- The installed editor integrates Windows IME, drawing, bidi, image, virtual-file-system, OOXML and ODF components. Use these as investigation leads, not as undocumented APIs or compatibility guarantees.
- Prefer public HWP/HWPX format documentation and RHWP's licensed document model for Hanul. Do not bind Hanul to Hancom-private DLL exports or reproduce proprietary implementation code.
- Keep Hanul's adapter and content-loss reporting as the source of truth. Static binary labels do not upgrade any Hanul compatibility-matrix status.

## Limits

This was static analysis of the local installed binaries and one Ghidra function analysis. It did not exercise Hanword's open/save/edit/IME workflows at runtime, inspect protected content, or validate HWP/HWPX round trips. Large native modules may require different Ghidra analysis settings or a provider/runtime path that completes within REA's Windows analysis limits.
