# Hanul 렌더링 아키텍처 조사

조사일: 2026-10-14  
대상: 현재 설치된 한글 2024, Hanul 데스크톱 앱, Windows x64 headless Edge PoC

## 결론

이번 단계에서는 Hanul 렌더러를 교체하지 않았다. 한글 2024와 Hanul에서 같은 196쪽 생성 HWPX 스트레스 문서를 실제로 열고 스크롤·확대를 확인했다. 같은 내용의 HWP와 HWPX 파일은 Linux Node/WASM 계층에서도 각각 계측했다. 읽기는 0.5–0.6ms, RHWP 파싱·모델·초기 조판은 4.98–5.14초, 대표 3쪽 SVG는 약 0.58초, 모든 페이지 SVG 생성은 35.76–36.27초였다. 화면은 페이지 가상화를 사용하므로 전체 36초는 문서 첫 화면 표시 시간이 아니다. 생성 fixture는 48만 텍스트 문자로 된 단일 문단이라 일반 문서와 조판 특성이 다르다.

WSLg 확대 시 빈 화면이 보이는 회귀를 실제로 재현했고, 확대율을 React Virtuoso의 `key`로 사용해 페이지 목록을 강제 재마운트하는 원인을 제거했다. 수정 후 Linux GUI에서 페이지를 유지한 채 확대·스크롤을 확인했다. Canvas로 즉시 전환할 근거는 여전히 없다. 다음 단계는 RHWP SVG API 뒤에 renderer-neutral 페이지 Display List 경계를 만들되, 실제 조판과 PDF 출력이 같은 문서 geometry를 공유하도록 점진적으로 옮기는 것이다. 한글 2024는 GDI 기반 그리기/글리프 코드의 정적 근거가 있으나, 이번 런타임 계측은 Windows 프로파일링 정책에서 막혀 실제 문서 페이지의 최종 API는 아직 미확인이다.

## 조사 범위와 증거 원칙

- 한글 2024와 Hanul을 직접 실행해 생성 HWPX를 열고 페이지 렌더, 스크롤, 확대를 관찰했다. Hanul에서는 시험 문자를 삽입한 뒤 Undo로 되돌렸다. 이 입력은 OS IME 검증이 아니다.
- Ghidra/REA는 설치 파일의 PE 메타데이터, import/export, 문자열 참조와 선택한 함수만 조사했다. `HwpApp.dll`의 전체 자동 분석은 REA 300초 호출 제한에 걸렸으므로 재실행하지 않았다. 이후 Ghidra 세션에서 선택 함수와 작은 공통 그리기 DLL을 조사했다.
- 정적 import나 로드된 DLL만으로 런타임의 문서 페이지 렌더링 경로를 단정하지 않았다. `wpr -start CPU -start GPU -start DotNET -start DesktopComposition -filemode`는 `0xc5585011` 정책 오류로 시작되지 않았다. 따라서 ETW API 추적은 확보하지 못했고, 모듈 목록과 GUI 화면 관찰만 런타임 근거로 기록한다.
- REA Evidence ID는 해당 결과를 다시 찾기 위한 식별자다. 표의 “확인”은 Evidence에 나타난 정적·관찰 사실만 뜻한다.

### 한글 2024 바이너리 및 런타임

실제 설치 경로는 `C:\Program Files (x86)\HNC\Office 2024\HOffice130\Bin\Hwp.exe`다. 실행 파일은 x86 관리형 PE이며 .NET Framework 4.8, CIL/IL-only 메타데이터와 WPF 어셈블리 참조가 확인됐다. 네이티브 문서/그리기 후보로 `HwpApp.dll`, `HwpAppModule.dll`, `HwpEngineWrapper.dll`, `HncBaseDraw.dll`, `HncDrawingEngine.dll`이 확인됐다. `HwpEngineWrapper.dll`은 혼합 CLR/네이티브 x86 모듈이다.

| 분류 | 확인 결과 | 근거 및 제한 |
|---|---|---|
| 직접 확인 — 앱 호스트 | `Hwp.exe`는 x86 .NET Framework 4.8 관리형 PE다. `PresentationFramework`, `PresentationCore`, `WindowsBase`, `System.Drawing` 참조가 있다. | REA 관리형 분류 Evidence `ev_7cbf3476be82f53fb492e7406a2449974b2fdc937c31afb5bf738a633e1956bb4`. 메서드/형식 수는 PE 메타데이터 통계이며 내부 기능 의미를 설명하지 않는다. |
| 직접 확인 — 네이티브 편집 후보 | `HwpApp.dll`은 x86 네이티브 PE다. `HwpEngineWrapper.dll`은 mixed-mode, `HncBaseDraw.dll` 및 `HncDrawingEngine.dll`은 네이티브 모듈이다. | `HwpApp.dll`: `ev_736ca62b725904d7a43cbe666d52ccbcc27d90726b65d91d87f7ca4eda363090`; wrapper: `ev_258d8d95a614aa7e8357b7ea7f2a88fe7ee8dc0748f126caea88b39bb7997eeb`; drawing engine: `ev_5361e95a83a539e0735a03f67300dfa6f2fd1a1cc0a8765d63da2b5fd208ea25`. |
| 직접 관찰 — 현재 프로세스 모듈 | WPF 그래픽 런타임(`wpfgfx_v0400.dll`, PresentationCore), `GDI32`, `gdiplus`, `dwrite`, `d3d9`, `opengl32`, `HwpApp`, `HncBaseDraw`, `HncDrawingEngine` 등이 로드돼 있었다. 필터링한 모듈 목록에는 `d2d1.dll`, Skia, Cairo가 나타나지 않았다. | 사용자가 이미 실행한 Hwp 프로세스 모듈 스냅샷. 모듈 로드는 사용 여부/문서 페이지에서의 사용을 증명하지 않는다. 스냅샷 시점·동적 지연 로드에 한계가 있다. |
| 직접 확인 — GDI/문자 경로 | `HncBaseDraw.dll`은 `GetGlyphOutlineW`, `GetTextMetricsW`, `GetTextExtentPoint32W`, `TextOutW`, `ExtTextOutW`, `DrawTextW`, `BitBlt`, 경로 API를 import한다. `HncDrawingEngine.dll`은 `GetGlyphOutlineW`, `CreateFontIndirectW`, Uniscribe `ScriptItemize`/`ScriptShape`, GDI+와 `HncImageIO::loadSvg` 계열을 import한다. | PE import 분석. SVG 로더는 SVG 이미지 입력 가능성을 보일 뿐, 문서 페이지가 SVG로 렌더링된다는 뜻이 아니다. Uniscribe import는 문서 전체의 한국어 shaping 구현을 특정하지 않는다. |
| 직접 확인 — 선택 함수 | `HncBaseDraw::CHncDrawContext::DrawImageToLineBuffer`는 이미지 크기와 바이트를 내부 라인 버퍼에 기록하고, `BitBltLineBuffer`의 하위 함수는 compatible DC/bitmap을 만들고 `SetBitmapBits`와 GDI `BitBlt`로 청크를 복사한다. `CHncImageCache::_Find/_Add`는 별도의 이미지 캐시 경로다. | 함수 Evidence: `DrawImageToLineBuffer` `ev_b04ba6cdd48e90eaa13e8d4ec5994b275c3db460a490e6835be2c2e2d928b3a1`; `BitBltLineBuffer` `ev_7e4fb97e4a4e52acf2eff794b1d0dadeae2931c65416e74302cb0867fcbc1727`; 복사 루틴 `ev_190f2c61a4a3bf6fbc7db8ebb67b610e6976fca66c1f691ebfe043680049de80`; 이미지 캐시 `_Find` `ev_01e725ebd462df9201051c4524b5cfb81fed0185619eaf0d3804800006180208`, `_Add` `ev_4255df6a99b35e31936c427b5fe5e53abff39f10d7a39f4254bccf08d89657ce`. 확인된 것은 라인 버퍼 전송과 이미지 캐시이며, 페이지 캐시/dirty-region 정책은 아니다. |
| 직접 확인 — 글리프/문자 처리 | `HwpApp.dll` 함수 `FUN_104de0b0`는 `GetGlyphOutlineW(..., GGO_NATIVE, ...)`로 글리프 외곽선을 가져오고 경로 데이터를 처리한다. 별도 함수 `FUN_10503af0`는 Bidi/Arabic shaping 경로에서 `GetBidiShape` 등을 호출한다. | `FUN_104de0b0` `ev_bd2c8e79ba495da6a3744d240513bf64a0fb6cea6740a6f388c46f11345913fc`; Bidi `ev_b124f9f900b830576ad88c8f5831dec31cefaf435d62745e8cb80166c2f8f210`. 특정 glyph outline 함수가 모든 본문 텍스트의 정상 화면 그리기 경로라는 증거는 없다. |
| 강한 추정 | WPF가 앱 UI 호스트이고 네이티브 GDI/GDI+ 기반 그리기 계층이 문서/개체 렌더링에 참여한다. 라인 버퍼와 이미지 캐시가 적어도 해당 그리기 경로에 사용된다. `HncDrawingEngine` import/export는 텍스트·표·이미지·셀 속성 렌더링 책임을 가진 계층임을 시사한다. | `HncDrawingEngine.dll` export에는 `Text@Shape@Hnc`, `Table@Shape@Hnc`, `Render@Shape@Hnc`, `Image`, `CellProperty`, `CellTextStyle` 계열이 있다. `HncBaseDraw`에서 `ShapeString` 참조 함수 `FUN_10070560`은 UTF-16 입력을 복사해 `HncFoundation::ShapeString`을 호출한다(`ev_9ae1b8515cd53fdd9ce977299addb3c50320ec8a5c9deeffe0ab69f9f0ea02b4`). API 이름과 import/export는 역할의 강한 단서지만 호출 그래프 전체 및 런타임 화면 경로를 증명하지 않는다. |
| 미확인 | 실제 본문 페이지의 최종 백엔드가 GDI, GDI+, DirectWrite/WPF, Direct3D 또는 조합 중 무엇인지; `dwrite`/`d3d9`/`wpfgfx`의 문서 본문 사용 여부; shaping의 한국어 적용 지점; 쪽 단위 캐시·부분 무효화·스크롤 렌더 정책; 표/수식/도형의 실제 최종 그리기 호출 흐름. | 이들을 확정할 런타임 API 호출 추적과 사용자 조작 재현은 하지 않았다. 정적 근거만으로 결론 내리지 않는다. |

한글 2024 전체 `HwpApp.dll` 분석은 Ghidra 분석 완료 후에도 REA의 전체 overview 호출이 300초 제한에 걸렸다. 작은 `HncBaseDraw.dll`은 선택 함수 분석을 수행할 수 있었고, 큰 모듈도 알려진 import/xref 함수는 개별 조사할 수 있었다. 이후 더 조사한다면 `HncDrawingEngine.dll`에서 표·이미지·텍스트의 외부 호출자를 제한적으로 찾아야 하며, 사용자 세션을 건드리는 계측은 별도 허가된 테스트 환경에서만 해야 한다.

## 실제 문서 GUI 및 단계별 벤치마크

### 동일 HWP/HWPX 스트레스 문서

비공개 사용자 문서를 저장소나 벤치마크에 쓰지 않았다. RHWP로 생성한 시험 파일을 로컬 임시 디렉터리에서 사용했다. HWP는 70,656 bytes, HWPX는 72,889 bytes다. HWPX의 `Contents/section0.xml`에는 긴 단일 문단이 있으며 텍스트 노드 합은 약 480,000자다. Hancom의 상태 표시줄은 `420,000글자`, `3/5쪽(근사값)`을 표시했다. Hanul/RHWP는 두 파일을 각각 196쪽으로 계산했다. Hancom 쪽 수치는 “근사값” 표시이므로 확정 쪽 수로 보지 않는다. 이 차이는 스트레스 fixture의 긴 단일 문단에서 생긴 조판 호환성 차이 후보이며 일반 문서의 페이지 수 차이라고 일반화할 수 없다.

Windows GUI에서 두 프로그램 모두 HWPX 본문을 정상적으로 그렸고 한글·영문 혼합 문장과 페이지를 확인했다. Hancom에는 리본/눈금자/페이지 화면이, Hanul에는 페이지 가상화 화면이 보였다. Hanul에서 확대와 스크롤은 동작했고, 한 글자 시험 입력 후 실행 취소로 화면을 원래 문자열로 복구했다. 입력 호출 시간 약 150ms와 Undo 호출 약 108ms는 자동화 호출 시간으로 렌더 프레임 시간이 아니다. 실제 Microsoft IME 조합은 시험하지 않았다.

WSLg Ubuntu 26.04에서 Linux Tauri 앱을 빌드해 띄웠다. 환경은 `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, WebKitGTK 4.1이며 IBus 엔진 조회는 `hangul`이었다. 화면은 검게 나오지 않았고 동일 HWPX의 본문·눈금자·196쪽 표시를 확인했다. WSLg/Mesa에서 EGL/Zink 장치 선택 경고가 콘솔에 있었지만 화면 렌더는 성공했다. 세션은 Wayland와 X11 변수를 모두 제공하므로 이번 실행에서 WebKit의 실제 선택 백엔드를 강제·확정하지 않았다. 일반 Ubuntu 데스크톱, X11 단독, Fcitx5는 검증하지 않았다.

Linux GUI의 `sky.type_text` 입력은 WebKitGTK가 클립보드 붙여넣기를 현재 컨텍스트에서 허용하지 않아 실패했다. 키 이벤트 실험에서 미확정 조합과 Escape 취소는 UI 진단에 나타났지만 RHWP 모델에 확정된 한글이 저장됐는지 확인하지 못했으므로 IBus 편집 완료로 계산하지 않는다. Linux에서 실제 편집·저장·재열기는 미검증이다. 원본 시험 파일은 저장하지 않았다.

### RHWP 단계 측정

`npm run benchmark:open -- --input=<.hwp 또는 .hwpx>`를 추가해 기존 로컬 파일을 읽기 전용으로 계측할 수 있게 했다. 같은 파일 바이트를 Windows x64/Node 24.16.0과 WSLg Ubuntu 26.04 x64/Node 22.22.1에서 순차 측정했다. Node는 테스트용 `measureTextWidth` 콜백(문자 수 × 8)을 사용하므로 조판 폭과 절대 시간이 실제 WebView 글꼴과 다르다. `allPagesRender`는 화면을 열 때 수행되는 작업이 아니라 모든 쪽을 명시적으로 순회한 비용이다.

| 단계 | Win HWP | Win HWPX | Linux HWP | Linux HWPX | 비고 |
|---|---:|---:|---:|---:|---|
| WASM 최초 초기화 | 56.3 ms | 61.7 ms | 73.6 ms | 60.3 ms | 프로세스별 1회 |
| 파일 읽기 | 1.0 ms | 1.1 ms | 0.5 ms | 0.6 ms | OS/파일 캐시 영향 가능 |
| RHWP parse + model + initial layout | 5,401.9 ms | 5,503.7 ms | 5,137 ms | 4,981.5 ms | 공개 API가 내부 단계를 분리하지 않음 |
| 첫·중간·마지막 쪽 SVG 합계 | 615.7 ms | 689.7 ms | 579.5 ms | 578.2 ms | 세 대표 쪽의 순차 생성 |
| 전체 196쪽 SVG 생성 | 37,432.5 ms | 37,705 ms | 36,270.6 ms | 35,761.5 ms | UI 초기 화면 비용이 아님 |
| 파싱 후 Node RSS | 95.3 MiB | 93.6 MiB | 176.4 MiB | 177.5 MiB | 순간 프로세스 RSS |
| 대표 3쪽 렌더 뒤 Node RSS | 98.4 MiB | 97.9 MiB | 262.0 MiB | 255.7 MiB | 대표 SVG 총 2.04 MB |
| 전체 순회 후 Node RSS | 167.9 MiB | 167.4 MiB | 343.0 MiB | 302.3 MiB | V8 allocator 포함, 앱 RSS 아님 |
| 12쪽 LRU 보관 SVG | 10.65 MB | 10.65 MB | 10.65 MB | 10.65 MB | 전체 생성 SVG 합계는 186.84 MB |

동일한 입력 안에서 두 포맷의 RHWP 시간은 비슷했고 OS/Node 조합도 parse·전체 SVG 결과가 근접했다. OS 간 RSS 차이는 Node 버전, allocator, 페이지 캐시 차이를 포함하므로 제품 성능 순위로 해석하지 않는다. 시간이 드는 곳은 파일 디스크 I/O가 아니라 긴 본문 파싱/조판과 전체 쪽 SVG를 전부 만드는 경로다. 제품 화면은 최근 12쪽 캐시와 Virtuoso viewport 가상화를 적용하므로 전체 출력 경로를 열기 성능으로 오해하지 않아야 한다. 파일 열기 시작부터 WebView 첫 paint까지의 벽시계 시간을 자동화에서 정확히 분리하지 못했고, React commit 진단 로그는 있지만 이번 GUI 캡처에 DevTools 로그를 연결하지 못했다.

### GUI 반응 및 프로세스 표본

| 환경 | 관찰 |
|---|---|
| Windows 11, Hancom 2024 | HWPX 화면 렌더 정상. Hancom 상태는 `3/5쪽(근사값)`, 420,000글자. WPF/GDI/GDI+/DirectWrite/D3D9 모듈은 앞서 수집한 정적/모듈 목록 근거이며 문서 페이지 API 호출 증거는 아님. |
| Windows 11, Hanul | HWPX 196쪽, 화면 편집/스크롤/110% 확대, 입력 후 Undo를 관찰. 문서 로딩의 정확한 앱 내부 벽시계는 GUI 자동화 지연과 분리하지 못해 미보고. |
| WSLg Ubuntu 26.04 | Linux Tauri/WebKitGTK 창과 HWPX 196쪽 렌더 성공. 확대/스크롤 후 문서 페이지 유지. Node/웹 계층 입력 자동화가 클립보드 권한 오류를 반환해 모델 편집/저장 완료는 미검증. |

Windows에서 Hwp 프로세스 트리(Hwp, HwpApi, tray)의 표본 RSS 합은 약 324 MiB, Hanul Tauri와 WebView2 자식 프로세스의 합은 약 607 MiB였다. WSLg에서 Hanul 프로세스 약 225 MiB, WebKitWebProcess 약 729 MiB로 표본 합은 약 953 MiB였다. 이 값은 문서가 열린 한 시점의 프로세스별 working set 합이다. 공유 페이지/그래픽 메모리를 중복 계산하고 시작 기준선이 없으며, OS·WebView 개발 모드가 다르므로 제품 간 메모리 순위로 해석하지 않는다. 2초 유휴 구간의 CPU 증가 표본은 Linux Hanul 약 0.02 CPU초, WebKit 약 0.22 CPU초였다. 이 한 번의 유휴 표본으로 스크롤 CPU를 추정하지 않는다.

### 확대 시 페이지 소실 수정

WSLg 실험 전에는 확대 직후 문서 viewport가 회색으로 비고, 다음 캡처에서 최대 약 1초 뒤 페이지가 나타나는 현상을 관찰했다. 원인은 확대율을 Virtuoso 컴포넌트의 React `key`로 사용해 100%, 110%처럼 배율이 바뀔 때마다 전체 페이지 목록과 SVG 항목이 언마운트되는 구조였다. `App.tsx`에서 해당 key를 제거했다. 이후 Linux dev 앱에서 확대·스크롤을 재확인했을 때 기존 페이지가 남아 렌더링됐고 화면이 빈 상태로 유지되지 않았다. 이는 관찰된 깜박임/재마운트의 수정이지 RHWP 파싱 시간을 줄인 것은 아니다. 재측정 가능한 GUI frame p50/p95는 아직 확보하지 못했다.

### 런타임 API 추적 제한

`wpr -status`는 추적 중이 아니라고 응답했다. CPU/GPU/DotNET/DesktopComposition 프로파일을 시작하려 한 WPR 호출은 `0xc5585011 Failed to enable the policy to profile system performance`로 실패했다. Process Monitor/Process Explorer도 설치된 실행 파일에서 찾지 못했다. 따라서 화면 동작·프로세스 메모리/CPU 표본은 관찰했지만 GDI/DirectWrite/Direct2D 호출을 프레임별로 계측하지 않았다. DLL의 정적 import, 함수 분석, 로드 모듈은 이 보고서의 바이너리 표에 구분해 기록했으며, 실제 페이지 백엔드의 확정 근거로 사용하지 않는다.

## 기술 비교

비교는 기술의 일반적 성질을 바탕으로 한 설계 평가다. PoC에서 측정한 것은 SVG와 Canvas 2D만이다. 실제 HWP 문서 조판 품질, Windows/Linux GUI, 인쇄 결과는 이 표의 가설을 별도 검증해야 한다.

| 기술 | 장점 | 비용/위험 | 화면·인쇄 관점 |
|---|---|---|---|
| SVG DOM | 벡터 확대, 개별 요소 DOM, hit-test·접근성·CSS 오버레이가 간단하고 Tauri WebView에 바로 들어간다. 기존 RHWP API 재사용이 쉽다. | 요소 수가 많은 페이지는 DOM/문자열·sanitizer 비용이 커진다. 엔진별 텍스트 shaping/글꼴 차이와 React DOM 비용이 남는다. 영역 단위 재렌더는 직접 관리해야 한다. | 브라우저 인쇄/PDF 경로로 접근이 쉽다. 픽셀 일치성은 WebView/OS 글꼴에 영향받는다. SVG 2는 벡터 및 래스터·동적 그래픽 모델이다. |
| HTML Canvas 2D / OffscreenCanvas | 단일 캔버스에 명령을 그리므로 DOM 노드를 줄이고 페이지 단위/타일 단위 repaint가 가능하다. OffscreenCanvas는 worker에서 사용할 수 있다. | 화면이 즉시 비트맵이어서 선택·링크·접근성 hit-test를 별도로 구현해야 한다. 캔버스별 픽셀 버퍼가 큰 문서의 메모리를 증가시킨다. TextMetrics만으로 문서 shaping/줄 나눔 엔진이 되지 않는다. | 동일 display list를 이용한 출력은 가능하지만 Canvas bitmap 기반 인쇄는 해상도·글꼴 문제를 피하려면 벡터/PDF 경로가 필요하다. |
| WebGL / WebGPU | 대량의 동일한 GPU 도형·텍스처 합성, 확대·스크롤에서 raster tile 재사용에 적합할 수 있다. WebGPU는 렌더링 pipeline 제어가 넓다. | 문서 텍스트의 편집 caret, glyph raster/cache, 클리핑, 접근성, PDF/인쇄 출력까지 직접 구축해야 한다. 문서 페이지의 불규칙한 도형/문자 장면에서는 업로드·동기화 복잡도가 이득을 상쇄할 수 있다. | 출력 경로가 별도 필요하므로 현재 단계에서 직접 선택할 근거가 부족하다. |
| Skia (+ HarfBuzz) | Windows/Linux 공통 2D raster/vector API, 텍스트·path·image·PDF 등 백엔드 후보를 한 계층에 묶을 수 있다. retained display list는 아니므로 Hanul이 조판/캐시 정책을 설계할 수 있다. | Skia는 텍스트 shaping을 제공하지 않는다. HarfBuzz 또는 동등한 shaping 계층, 글꼴 탐색/임베딩 정책과 Rust FFI/배포 빌드 관리가 추가된다. 바이너리/패키지 크기와 플랫폼별 배포 검증 부담이 있다. | 화면/PDF를 같은 drawing API로 맞출 잠재력이 높다. 정확한 glyph/Unicode shaping은 HarfBuzz와 함께 설계해야 한다. |
| Cairo (+ HarfBuzz/Pango) | 경로·이미지·폰트/텍스트를 포함한 성숙한 2D API. image, Win32, PDF, SVG 등 출력 surface를 제공하고 CPU 기반 공통 경로가 있다. | 복잡한 shaping과 문단 조판은 Cairo 단독 책임이 아니다. Pango/HarfBuzz 조합, Windows 패키징과 Linux 네이티브 의존성을 관리해야 한다. 대형 장면 GPU 가속 기대는 제한적이다. | PDF/SVG surface로 같은 vector 명령 재사용이 가능하다. 출력 surface별 차이를 테스트해야 한다. |
| Qt Graphics View / Qt Quick | 네이티브 scene/view 구조, 입력/이벤트, 인쇄·view transform이 갖춰져 있다. Graphics View는 대형 item scene의 탐색/interaction에 장점이 있다. Qt Quick은 GPU scene graph와 threaded render loop가 가능하다. | Tauri/React UI·파일 플러그인·기존 CSS 리본을 다시 구현하는 비용이 크다. Graphics View의 아이템 수가 매우 많을 때 scene overhead를 조절해야 한다. 상용/오픈소스 배포 라이선스 조항을 별도로 검토해야 한다. | 단일 Qt 화면/scene의 인쇄 API는 통합에 유리하나, 새 조판 엔진과 플랫폼 배포 작업을 병행해야 한다. |
| Direct2D / DirectWrite | Windows에서 고성능 2D와 고급 텍스트 layout/shaping을 제공하며 서로 결합된다. DirectWrite는 glyph 위치가 포함된 layout을 캐시할 수 있다. | Direct2D는 Windows 전용이므로 Linux와 공통 코드로 쓰기 어렵다. 플랫폼별 렌더러를 유지하면 PDF/화면의 차이와 테스트 부담이 증가한다. | Windows 최적화 백엔드에는 유력하지만, 공통 포맷의 canonical output으로 선택하면 안 된다. |

| 판단 기준 | SVG | Canvas 2D | Skia + shaping | Cairo + shaping | Qt Scene/Quick | D2D/DWrite |
|---|---|---|---|---|---|---|
| 첫 쪽 표시 | 현재 구현 재사용성이 가장 높음 | PoC에서 명령별 draw 비용이 큼 | 초기 라이브러리/바인딩 비용을 측정해야 함 | 비교 측정 안 함 | UI 전환 초기 비용 큼 | Windows는 강하지만 Linux 미지원 |
| 100–500쪽 | 가상화와 12쪽 LRU가 이미 있음; 조판/전체 SVG 비용이 별도 병목 | 페이지별 canvas라면 DOM은 작지만 픽셀 버퍼/전체 draw 비용 | display list·tile 캐시 시 유력; 아직 측정 없음 | CPU 벡터 출력으로 안정적이나 큰 페이지 실측 없음 | viewport scene query로 후보; UI 마이그레이션 비용 | Windows only |
| 스크롤/줌 | 벡터 확대; visible SVG만 mount | rerasterize 비용; 타일 캐시로 개선 가능 | raster cache/GPU로 유력 | 보통 CPU raster | GPU/scene graph로 후보 | Windows에 적합 |
| 커서/선택/IME | DOM 오버레이와 편집 UI 통합이 쉽다 | hit-test/선택 geometry를 별도 구현 | glyph/run geometry를 엔진 모델에 추가해야 함 | 동일 | 기본 이벤트는 좋지만 편집 모델 연결 필요 | 플랫폼별 구현 필요 |
| 한글/혼합 조판 | RHWP 결과를 그대로 표시하면 파서 배치 유지; 브라우저별 글꼴 렌더 | Canvas text만으로 조판 정확성 보장 안 됨 | HarfBuzz/문단 조판을 함께 구현해야 공통화 가능 | Pango/HarfBuzz 조합 필요 | Qt text stack 검증 필요 | DirectWrite 품질 높지만 플랫폼 종속 |
| 표/도형/이미지/수식 | 현재 SVG primitive로 표현 가능한 것 재사용 | primitive 표시 목록 구현 필요 | 공통 scene primitives에 적합 | primitives에 적합 | QGraphicsItem/scene에 적합 | 네이티브 primitives |
| 부분 다시 그리기 | DOM 요소 수준 업데이트 가능하나 React/SVG 비용 존재 | dirty rect/타일 관리에 적합 | dirty tiles/display list 캐시에 적합 | dirty rectangle 직접 관리 | item update/scene invalidation 가능 | native invalidation |
| 메모리 | 문자열·DOM과 12쪽 LRU | 픽셀 크기에 대략 비례(현재 PoC 6쪽 21.4 MB) | 정책에 따라 glyph/page/tile 캐시 | CPU surface·glyph cache | scene item 및 backing store | native surface/cache |
| PDF/인쇄 | 브라우저 SVG 출력을 기존 경로로 재사용 | raster 출력은 주의, vector PDF backend 별도 | PDF backend 후보가 있음 | PDF surface 내장 | scene render/print 활용 | Direct2D print path Windows 전용 |
| 구현·유지보수 | 현행에서 가장 낮은 전환 비용 | 중간; 텍스트/접근성 수작업 | 높음; 장기 플랫폼 공통화 이점 | 중간~높음 | 매우 높음(기존 UI 이식) | Windows 구현은 중간, 양 플랫폼은 매우 높음 |

참고: SVG 사양은 벡터/래스터 그래픽 표현을 정의하지만 문서 편집/조판 엔진은 아니다. HTML Canvas 표준은 2D 등 context와 OffscreenCanvas를 정의한다. Skia 문서는 Skia 자체가 text shaping을 하지 않으며 HarfBuzz 같은 shaping engine과 함께 쓰는 모델을 설명한다. HarfBuzz는 Unicode를 글리프 ID와 위치로 shaping하지만 줄바꿈·문단 조판은 별도 계층이다. Cairo는 여러 출력 surface(PDF/SVG 포함)를 제공한다. Qt Graphics View와 Qt Quick은 별도 UI 플랫폼 선택을 의미한다. [출처](#공식-기술-자료).

## Hanul 현재 구조 및 병목

현재 페이지 표시 경로는 다음과 같다.

```text
HWP/HWPX bytes
  → @rhwp/core WASM HwpDocument (parse + model + initial pagination/layout)
  → renderPageSvg(pageIndex)
  → DocumentSession 12-page SVG LRU
  → React Virtuoso visible-page list
  → DOMPurify + SVG innerHTML
  → SVG caret / selection overlay
```

앱은 React UI를 Tauri WebView 안에서 실행한다. `DocumentSession`은 `renderPage(): string`으로 SVG를 노출하고, `RhwpDocumentSession`이 RHWP의 `renderPageSvg`를 호출한다. `App.tsx`는 `react-virtuoso`로 쪽을 가상화하고, 페이지 컴포넌트에서 SVG 정화 및 DOM 반영을 한다. 캐시 제한은 12쪽이며 편집 시 무효화한다. 인쇄 미리보기/PDF 경로는 출력 페이지들을 순회하므로 화면과 다른 전체 문서 비용을 갖는다.

`docs/performance/opening-benchmark.md`의 기존 측정은 합성 파일(작은 2쪽, 큰 98쪽; 큰 압축 파일 약 40 KB)과 Node 런타임을 사용했다. 실제 HWP/HWPX 표본, WebView 조판, GUI paint를 측정한 것이 아니다.

| 항목 | 이전 측정/구조 | 해석 |
|---|---|---|
| 파일 읽기 | 0.4–2 ms | 생성된 작은 압축 fixture에서는 병목이 아님. 실제 대형/비압축 파일은 다를 수 있다. |
| WASM 초기화 | 최초 53–60 ms, 모듈 Promise 공유 | 문서마다 반복 초기화되지 않는다. |
| 파싱+모델+초기 조판 | 98쪽 0.738–1.074초 | RHWP 공개 API 내부를 분리 계측하지 못했고, 앱 메인 스레드에서 동기 실행된다. 열기 첫 화면 이전에 UI 정지를 만들 가능성이 가장 큰 확인된 단계다. |
| 대표 SVG 생성 | 쪽 0/중간/마지막 0.24–0.39초(대표 3쪽 합계) | 전체 페이지 생성보다 작지만, WebView의 정화/commit 포함 여부가 측정 방법에 따라 다르다. |
| 98쪽 전부 SVG 생성 | 8.1–10.2초 | 모든 페이지를 생성하는 출력·전체 탐색 경로의 큰 비용. 화면은 페이지 가상화를 사용한다. |
| SVG 캐시 | 90.15 MB 전량 방문 후 → 10.68 MB/12쪽 LRU | 큰 문서 방문 후 heap/RSS가 줄어드는 증거. 현재 12쪽은 고정 개수 제한이라 줌/DPR/표시 크기별 바이트 관리가 아니다. |
| React 반영 | `first-page-svg`, sanitize, React commit 개발 진단이 존재 | GUI 첫 paint 및 paint completion 로그는 이번 실행에서 분리 회수하지 못했다. |

### 독립 SVG/Canvas PoC

파일: `apps/desktop/scripts/rendering-poc.html`, 실행기 `apps/desktop/scripts/rendering-benchmark.mjs`, 명령 `npm run benchmark:render`.

양쪽 backend가 같은 자바스크립트 객체형 Display List(쪽당 84 연산, 한글/영문 텍스트·선·표·그림)를 사용한다. 페이지 크기 794×1123 CSS px, 100쪽, 화면 window 6쪽으로 고정했다. 각 backend는 별도 headless Edge 프로세스 3회 실행했고 순서를 교차했으며 중앙값을 보고한다. `--disable-gpu`로 소프트웨어 경로를 사용했다.

| 지표(3회 중앙값) | SVG | Canvas 2D |
|---|---:|---:|
| 첫 쪽 동기 DOM/명령 제출 | 3.0 ms | 25.2 ms |
| 6쪽 window 생성 | 5.4 ms | 10.4 ms |
| 반복 6쪽 window 평균 제출 | 3.48 ms | 11.58 ms |
| 100쪽을 6쪽씩 window 교체하며 순회 | 48.1 ms | 207.6 ms |
| 페이지당 SVG 직렬화 데이터 | 43,563 bytes | 해당 없음 |
| 6쪽 표시 DOM element 수 | 522 | 12 |
| Canvas 6개 backing store 추정 | 해당 없음 | 21,399,888 bytes (약 20.4 MiB) |
| Chromium JS heap 보고값 | 10 MB | 10 MB |

이 결과는 이 특정 간단한 장면에서 DOM SVG 경로가 headless software Canvas보다 첫 쪽 제출 및 100쪽 window 순회에서 더 빨랐음을 보인다(각 지표의 중앙값은 SVG 약 8배/4.3배 낮음). 반복 viewport 제출의 차이는 약 3.3배다. Canvas의 장점은 DOM 수가 적다는 점이고, 비용은 캔버스 backing store의 메모리다. 실행간 편차가 있으므로 배수는 방향성으로만 읽어야 한다. JS heap은 Chromium의 거친 `performance.memory` 값이고 OS 프로세스 working set은 아니다. SVG native memory 및 GPU 메모리는 측정하지 않았다.

**PoC 한계:** 시간은 브라우저 시작, 글꼴 로드·장면 준비 후 렌더 함수 호출/DOM 교체를 잰다. 실제 화면 paint 완료, Tauri/React, RHWP 조판, 실제 문서, IME, 줌/DPR 변화, OS 메모리 및 물리 스크롤 프레임 시간은 포함되지 않는다. 100쪽 순회는 매 window의 동기 제출을 재며 실제 사용자가 스크롤할 때의 frame time이 아니다. 테스트 페이지는 RHWP가 만든 페이지가 아니다. 따라서 이 수치를 제품 성능/문서 정확성 결론으로 일반화하지 않는다. 현재 증거는 Canvas wholesale swap을 뒷받침하지 않는다.

**플랫폼 검증:** Windows 11 x64에서 `npm run build` 및 `npm test`가 통과했다(5개 파일, 38개 테스트). Ubuntu 26.04 WSL2의 독립 Linux `node_modules`로 같은 명령이 통과했고, `npm run tauri dev`의 Rust 빌드도 완료되어 WSLg GUI 화면을 확인했다. WSLg에는 EGL/Zink 경고가 있었지만 첫 페이지, 눈금자, 확대, 스크롤은 보였다. 이 검증은 WSLg 한 세션에 한정된다. IBus 한글 조합을 모델에 확정하고 저장·재열기하는 과정, 일반 Linux 배포판, X11만 강제한 실행, Fcitx5는 완료로 표시하지 않는다. Windows/Linux 전체 GUI 동등성과 HWP/HWPX 편집·저장 교차 검증도 아직 남아 있다.

## 권장 Hanul 아키텍처

렌더러 API가 페이지 SVG 문자열을 반환하는 현 상태를 즉시 없애지 않고, 앱 UI에서 RHWP 타입을 숨기는 경계를 먼저 확장한다.

```text
HWP/HWPX adapters
  └─ Canonical editable document model + unknown-content preservation
       ├─ Editing transactions / selection / undo history
       └─ Layout engine (page, line, glyph runs, table/object geometry)
            └─ immutable page Display List + hit-test map
                 ├─ current RHWP-SVG adapter (compatibility)
                 ├─ SVG/Canvas/Skia screen backend candidates
                 └─ PDF/print backend
```

권장 인터페이스 초안:

```ts
interface DocumentEngine {
  layout(request: LayoutRequest, revision: number, cancel: AbortSignal): Promise<LayoutSnapshot>;
  renderPage(page: PageId, target: RenderTarget, viewport: Viewport): RenderResult;
  hitTest(page: PageId, point: Point): TextPosition | ObjectPosition;
  selectionGeometry(range: DocumentRange): readonly SelectionShape[];
}

interface PageDisplayList {
  pageId: PageId;
  revision: number;
  bounds: Rect;
  commands: readonly DisplayCommand[]; // clip, transform, fill, path, glyph-run, image, table-cell, object
  hitRegions: readonly HitRegion[];
}
```

이 계약은 구체 코드 대신 계층 간 책임을 나타낸다. `DocumentSession`이 현재 가진 편집 메서드를 한 번에 교체할 필요는 없다. 화면 caret/selection 위치도 `LayoutSnapshot`의 같은 geometry를 사용하고, 사용자 입력은 해당 문서 revision에 대한 transaction으로 기록해야 렌더 좌표와 모델 위치가 엇갈리지 않는다.

### 캐시/작업 스케줄링

- 페이지 조판 결과와 화면 raster 결과를 분리한다. 키는 문서 revision, 페이지 ID, section/page format, font metrics version, zoom, device-pixel-ratio, renderer backend를 포함한다.
- 열린 문서 전체 페이지를 eager하게 rasterize하지 않는다. 화면 viewport 및 작은 overscan 범위의 layout/display list만 우선 준비한다. 썸네일/인쇄는 별도의 낮은 우선순위 작업 큐를 사용한다.
- 화면 확대율은 같은 vector display list를 다시 rasterize하거나 SVG scale로 처리한다. 고정 해상도 raster만 보관해 글자 품질이 깨지지 않게 한다.
- text layout cache는 shaping 결과 glyph IDs/positions와 줄 경계를 캐시하고, 폰트/크기/기능/언어/방향/revision을 key로 삼는다. 폰트 대체·한글 조합 및 줄바꿈 변경 시 관련 문단 이후 페이지를 무효화한다.
- 문서 변경은 영향받는 문단/표와 이후 pagination만 dirty로 표시한다. 페이지 간 이동에 영향 없는 문단 포맷 변경이면 해당 페이지를 우선 갱신한다. 실제 incremental layout 가능성은 RHWP API의 변경 범위와 별도 측정 후 결정한다.
- worker는 레이아웃/Display List 생성에 우선 사용한다. DOM 접근과 IME 이벤트는 UI thread에 남긴다. 문서 revision이 바뀌면 이전 작업을 취소하고 stale 결과를 화면에 반영하지 않는다.
- dirty rectangle은 화면 backend optimization으로 도입할 수 있지만, 문서 모델/조판의 canonical 결과가 아니다. 우선 viewport culling과 페이지 LRU의 바이트 상한을 구현하고 이후 타일 크기를 프로파일링한다.
- GPU 가속은 장면/글리프 캐시가 CPU를 실제로 병목으로 확인한 뒤 적용한다. WebGL/WebGPU를 문서 조판 엔진으로 오인하지 않는다.

### 화면과 인쇄/PDF 공통성

공통 Display List의 geometry, glyph placement, object bounds, clipping을 화면과 PDF/인쇄가 공유하면 페이지 구성의 차이를 줄일 수 있다. 출력 backend가 glyph outline/image를 지원하는지, 글꼴 임베딩/대체 정책을 어떻게 처리하는지 검증해야 한다. 화면에서 사용하는 CSS/WebView 글꼴 shaping 결과를 PDF가 자동으로 동일하게 재사용한다고 가정하면 안 된다. 향후 Skia 후보는 display list consumer와 PDF surface를 같은 라이브러리로 연결할 수 있는지 prototype에서 확인한다. Skia 자체는 shaping을 맡지 않으므로 HarfBuzz 등과의 경계가 필요하다.

## 권장 기술 선택

1. **지금:** Tauri + React를 유지한다. 창/리본/대화상자와 편집 UI 이식 비용은 크고, 현재 측정에서 SVG 출력 자체를 교체해야 할 성능 증거가 없다.
2. **단계적 엔진화:** RHWP adapter의 `renderPage(): string`을 내부 `PageDisplayList`/layout artifact 및 output backend 인터페이스 뒤로 이동한다. 당분간 SVG backend가 RHWP 결과를 제공해 기존 기능을 보존한다. HWP/HWPX 파서·저장 기능을 renderer migration 때문에 줄이지 않는다.
3. **다음 후보 비교:** Canvas 2D는 worker/bitmap cache 및 dirty region이 적용된 경우에 한정해 다시 비교한다. CPU/공통 PDF vector가 중요한 장기 후보로 Skia + HarfBuzz 조합을 독립 adapter로 구현하고, Rust/Windows/Linux 빌드·메모리·PDF 일관성을 측정한다. Cairo/Pango는 더 낮은 통합 비용과 설치 패키지 의존성이 수용 가능한지 대안 실험한다.
4. **Qt 전환 보류:** 문서 엔진과 UI 프레임워크 전환을 동시에 하면 IME, 리본, 파일 대화상자, 배포, 자동화 테스트를 중복 검증해야 한다. 렌더링 이점이 기존 Tauri 대비 측정되기 전까지 UI 플랫폼 전환을 권고하지 않는다.

## RHWP 의존 축소 마이그레이션

| 단계 | 구현 | 진입/완료 기준 |
|---|---|---|
| 0 — 현상 계측 | 현재 RHWP/WASM parse+layout, renderPageSvg, sanitize, React commit, paint를 실제 sample 문서로 분리 측정 | GUI 없이 재현 가능한 headless/desktop 벤치와 실제 HWP/HWPX fixture 준비. 사용자의 비공개 문서는 저장소에 넣지 않는다. |
| 1 — 계약 분리 | `DocumentEngine`·`LayoutSnapshot`·renderer-neutral page artifact 도입. 기존 RHWP SVG는 compatibility backend | 기존 편집·undo·selection·저장 테스트 동일 통과, 손실 보고 변화 없음 |
| 2 — 공통 geometry | glyph run/table/image/path geometry 및 hit-test map을 편집 커서/선택에 연결 | 페이지 screenshot/golden, caret/선택 위치, Windows/Linux IME 회귀 테스트 |
| 3 — 백엔드 PoC | 동일한 실제 document artifact를 SVG, Canvas worker/tiled, Skia(+shaping)로 출력 | 첫 쪽, 100–500쪽 traversal, viewport frame p50/p95, RSS/GPU/JS heap, 확대, PDF 출력 비교 |
| 4 — 점진 전환 | backend feature flag로 일부 장면/문서에 적용 후 확대 | 표/수식/개체 및 미지원 content 보존, 화면/인쇄 일치, Windows/Linux 동등성 기준 통과 |
| 5 — RHWP 출력 의존 제거 검토 | 새 layout/display list가 HWP/HWPX 모든 지원 요소를 보존할 때만 SVG 출력 기능 의존을 축소 | 구조화된 content-loss report, HWP/HWPX round-trip, 수동 검수 및 성능 이점 확인 |

미지원 HWP/HWPX 데이터는 renderer backend가 알지 못하더라도 문서 모델/원본 패키지에 보존해야 한다. 새 경로는 손실 항목을 보고하고, 변환·저장이 안전하지 않으면 기존 출력을 유지하거나 명시적으로 차단해야 한다.

## 공식 기술 자료

- [W3C SVG 2](https://www.w3.org/TR/SVG/) — SVG 그래픽 모델. 이 문서의 판본은 2026-10-06 Candidate Recommendation 상태로 확인했다.
- [WHATWG HTML Canvas](https://html.spec.whatwg.org/multipage/canvas.html) — Canvas 2D, OffscreenCanvas 및 canvas context 정의.
- [Skia Documentation](https://skia.org/docs/) 및 [Skia Tips and FAQ](https://skia.org/docs/user/tips/) — 플랫폼 지원, Skia의 shaping 비포함과 HarfBuzz 조합.
- [HarfBuzz: What does HarfBuzz do?](https://harfbuzz.github.io/what-does-harfbuzz-do.html), [Why do I need a shaping engine?](https://harfbuzz.github.io/why-do-i-need-a-shaping-engine.html) — 유니코드 문자를 glyph ID와 position으로 shaping하는 책임.
- [Cairo Manual](https://cairographics.org/manual/), [Cairo Graphics](https://www.cairographics.org/) — 2D vector surfaces 및 PDF/SVG 출력 경로.
- [Qt Graphics View Framework](https://doc.qt.io/qt-6.11/graphicsview.html), [Qt Quick Scene Graph](https://doc.qt.io/qt-6/qtquick-visualcanvas-scenegraph.html) — scene item 및 GPU scene graph 동작.
- [Direct2D Overview](https://learn.microsoft.com/en-us/windows/win32/direct2d/direct2d-overview), [DirectWrite Introduction](https://learn.microsoft.com/en-us/windows/win32/directwrite/introducing-directwrite), [Direct2D and DirectWrite](https://learn.microsoft.com/en-us/windows/win32/direct2d/direct2d-and-directwrite) — Windows 전용 2D/텍스트 stack.
- [Unicode Line Breaking Algorithm (UAX #14)](https://www.unicode.org/reports/tr14/) — 문자 경계에서 가능한 줄바꿈 규칙. 실제 문서 조판은 문단·한글 문서 규칙과 함께 판단해야 한다.
