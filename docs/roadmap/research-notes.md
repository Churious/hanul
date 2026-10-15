# 조사 기록과 근거

## 조사 목적과 시점

- 기준일: 2026-10-15.
- 목적: 한글 2024의 메뉴/문서 편집 경험과 현재 Hanul 소스·테스트를 비교해 제품 범위와 순서를 세운다.
- 조사 범위: 파일, 편집, 보기, 입력, 서식, 쪽, 표, 그림, 도형/글상자, 검토, 도구, 보안, 공통 입력·저장·출력.
- 한글 2024 설치 실행 파일: C:\Program Files (x86)\HNC\Office 2024\HOffice130\Bin\Hwp.exe. 설치 여부/경로는 Windows 앱 목록 조사에서 직접 확인했다.
- 독점 리소스를 추출하거나 프로젝트에 복사하지 않았다. 기존 문서에 입력하거나 저장하지 않았다.

## Computer Use 직접 관찰

Computer Use skill의 Windows 앱 제어 절차로 현재 실행 중인 한글 창을 관찰했다. 이미 열려 있던 창이므로 원본 문서의 내용을 바꾸지 않는 방식으로 탭/메뉴를 살펴봤다.

### 직접 확인한 UI 항목

1. 상단 메뉴 분류: 파일, 편집, 보기, 입력, 서식, 쪽, 보안, 검토, 도구, 도형. 공식 메뉴 도움말은 기본 메뉴 9개를 설명하고, 도형은 선택 상황에 따라 나타나는 문맥 탭이다.
2. 파일 메뉴: 새 문서, 문서마당, 시작 도우미, 불러오기, PDF/그림 변환, XML 문서, 저장/다른 이름 저장, PDF/모바일 저장, 문서 정보, DAISY, CCL/공공누리/점자, 보내기, 편집 용지, 미리 보기, 인쇄, 최근 문서, 닫기, 끝내기 항목을 확인했다. 화면 표시 확인은 실제 각 명령 실행과 다르다.
3. 편집 리본: 실행 취소/다시 실행, 잘라내기/복사/붙이기, 서식 복사·지우기, 찾기/바꾸기 및 서식·정렬 관련 컨트롤을 관찰했다.
4. 보기 리본: 쪽 보기/윤곽, 표시 항목 전환, 눈금자, 격자/안내선, 작업 창, 창 분할·배열, 배율 관련 컨트롤을 관찰했다.
5. 입력 리본: 표·그림·도형·글상자·차트·수식, 각주/미주, 메모, 책갈피, 하이퍼링크, 문자표/한자 관련 컨트롤을 관찰했다. 선택 개체 문맥 때문에 일부 컨트롤은 비활성으로 표시됐다.
6. 서식 리본/글자 모양: 글자 크기와 글꼴, 굵게/기울임/밑줄·취소선, 정렬, 문단 옵션을 관찰했다. 글자 모양 대화상자에는 기본·확장·테두리/배경 탭이 있었고, 기본 탭에서 글꼴·크기·장평·위치·자간·장식·색상·미리보기를 확인했다.
7. 선택 개체 문맥: 기존 검증 문서에 선택된 글상자/도형이 보이는 화면을 확인했다. 개체를 이동·수정하거나 저장하지 않았다. 우클릭 컨텍스트 메뉴는 직접 열어 확인하지 못했다.

### 중단한 조사

글자 모양 대화상자의 후속 GUI 조작에서 Computer Use가 캡처 창 활성화 오류인 “failed to activate captured window”를 반환했다. 현재 창을 다시 선택하고 한 차례 재시도했지만 같은 오류가 반복되어 GUI 조작을 중단했다. 대화상자에서 값을 변경하지 않았고 저장 명령도 내리지 않았다. 닫기/취소 동작은 확인되지 않아 창의 현재 표시 상태는 불확실하다.

따라서 다음 항목은 이번 직접 GUI 조사에서 완료하지 못했다.

- 쪽·보안·검토·도구 리본의 하위 메뉴를 모두 펼쳐서 옵션별 배치와 동작 확인
- 표/그림/글상자 컨텍스트 메뉴를 각각 열고 명령 실행
- 실제 새 조사 문서에서 한글 입력, 표/개체 수정, 인쇄 설정과 저장을 끝까지 실행
- 모든 설정 대화상자 값과 단축키를 실행하여 검증

해당 내용은 공식 도움말로 메뉴 기능을 기록하되 GUI 직접 확인으로 표시하지 않았다. 상세 인벤토리에는 근거 등급을 각 행마다 적었다.

## 공식 도움말 조사

한컴 공식 HOffice 2024 도움말을 메뉴 트리와 기능 상세의 1차 출처로 사용했다. 도움말은 기능의 존재 및 설명을 뒷받침하지만 현재 설치판의 화면 배치, 기본 단축키가 사용자 설정에서 바뀌었는지, 모든 파일 조합에서 저장되는지는 보증하지 않는다.

### 메뉴 분류와 기능 도움말

- [메뉴/리본 구조](https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/view/toolbar/menu.htm): 주 메뉴, 동적 리본, 컨텍스트에 따른 우클릭 메뉴, Alt 메뉴 접근.
- [파일](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/file.htm)
- [편집](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/edit.htm)
- [보기](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/view.htm)
- [입력](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/insert.htm)
- [서식](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/format.htm)
- [쪽](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/Page.htm)
- [보안](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/security.htm)
- [검토](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/review.htm)
- [도구](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/tools.htm)
- [표](https://help.hancom.com/hoffice130/ko-KR/Hwp/menu/table.htm)

### 상세 대화상자/객체 도움말

- [글자 모양](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/font/fonts.htm)
- [문단 모양](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/paragraph/paragraph.htm)
- [스타일](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/style/style.htm)
- [편집 용지](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/setting_paper/setting_paper.htm)
- [용지 크기](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/setting_paper/setting_paper(paper_sizes).htm)
- [머리말/꼬리말](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/header/header.htm)
- [다단](https://help.hancom.com/hoffice130/ko-KR/Hwp/format/columns/columns.htm)
- [표 만들기](https://help.hancom.com/hoffice130/ko-KR/Hwp/table/table.htm)
- [표/셀 속성](https://help.hancom.com/hoffice130/ko-KR/Hwp/table/tableattribute/tableattribute.htm)
- [셀 나누기](https://help.hancom.com/hoffice130/ko-KR/Hwp/table/table(divide).htm)
- [셀 합치기](https://help.hancom.com/hoffice130/ko-KR/Hwp/table/table(merge).htm)
- [그림 삽입·속성](https://help.hancom.com/hoffice130/ko-KR/Hwp/insert/figure/figure.htm)
- [글상자](https://help.hancom.com/hoffice130/ko-KR/Hwp/insert/textbox/textbox.htm)
- [수식](https://help.hancom.com/hoffice130/ko-KR/Hwp/insert/equation/equation.htm)
- [하이퍼링크](https://help.hancom.com/hoffice130/ko-KR/Hwp/insert/hyperlink/hyperlink.htm)
- [문서 암호](https://help.hancom.com/hoffice130/ko-KR/Hwp/file/password/password.htm)
- [변경 내용 추적](https://help.hancom.com/hoffice130/ko-KR/Hwp/review/track_changes/track_changes.htm)
- [맞춤법 검사](https://help.hancom.com/hoffice130/ko-KR/Hwp/tools/speller/spelling.htm)
- [차례/목차](https://help.hancom.com/hoffice130/ko-KR/Hwp/tools/index/index(order).htm)

## Hanul 소스·테스트 조사

확인한 주요 코드:

- [App.tsx](../../apps/desktop/src/App.tsx): 리본 탭 활성/비활성, 파일 메뉴 명령 연결, 문서 대화상자, 검색, 표·개체 편집 UI, 인쇄 미리보기, Tauri PDF 내보내기, 단축키 처리.
- [document-engine.ts](../../apps/desktop/src/document-engine.ts): UI가 소비하는 문서 세션 인터페이스. React는 RHWP 내부 구조를 직접 호출하지 않는다.
- [text-document-engine.ts](../../apps/desktop/src/text-document-engine.ts): Hanul 독립 문단/표/객체 모델, 편집, 증분 조판/캐시 및 호환성 보고.
- [hwp-engine.ts](../../apps/desktop/src/hwp-engine.ts): RHWP 기반 호환 세션과 import/export adapter.
- [document-compatibility.ts](../../apps/desktop/src/document-compatibility.ts): 구조별 HWP/HWPX 허용 여부 및 이슈 판정.
- Tauri [lib.rs](../../apps/desktop/src-tauri/src/lib.rs): 파일 저장 호환성 검사, 임시 파일 및 원자적 교체, PDF export 명령.

테스트는 다음 파일을 확인했다.

- text engine: 문서 편집·삭제·Undo/Redo·찾기/바꾸기·쪽 나누기·표 셀 조판·페이지 캐시·한글 모델 반영.
- RHWP engine: HWP/HWPX serialization round-trip, 서식, 표, 개체, 머리말/꼬리말/필드, 하이퍼링크, 저장 호환성.
- serializer: 지원 표 구조 import, unsupported floating table의 RHWP 경로 유지.
- IME: composition 선행 문자열과 확정/취소 중복 억제. OS 네이티브 IME 전체 검증과는 구분.
- object drag: 미리보기 중 문서 geometry를 바꾸지 않고 포인터 프레임 단위 갱신.
- Tauri: HWP/HWPX 제품 저장 경로의 파일 검사 및 원자 교체, PDF 페이지 수/실패 보호 관련 테스트.

자동 테스트는 모델/API 및 생성 fixture에 대한 근거다. 실제 마우스/키 입력이나 한글 2024 호환을 증명하지 않으면 GUI 완료 증거로 확장하지 않았다.

### 기존 문서의 날짜/범위 주의

docs/compatibility/matrix.md, docs/architecture/overview.md, docs/research/hanword-ux.md와 여러 성능/호환성 기록은 서로 다른 작업 시점에 작성됐다. 이번 문서 작성을 위해 현재 소스와 테스트를 직접 대조했다. 특히 일부 아키텍처 설명은 최신 독립 모델의 표/그림/도형 표현보다 오래된 문단 전용 설명을 포함하므로, 이번 격차 판단에서는 현재 코드/테스트를 우선했다. 과거 성능 숫자는 합성 fixture 수치이며 실제 GUI 입력 지연과 구분했다.

## REA/Ghidra 사용 여부

이번에는 REA/Ghidra를 호출하지 않았다. 목표는 사용자 관찰 가능한 메뉴/대화상자와 현재 Hanul 기능의 계획 비교이며, 공식 도움말과 직접 GUI 관찰, Hanul 소스/테스트로 필요한 사실을 확인할 수 있었다. 독점 바이너리 분석은 이번 기능 인벤토리나 구현 상태 판단에 추가 신뢰를 주지 않으므로 실행하지 않았다.

앞으로 HWP/HWPX 직렬화, 표·개체 앵커 또는 조판 동작이 공개 규격과 통제된 정상 fixture만으로 해소되지 않을 때, 해당 모듈의 제한된 분석을 검토한다. 조사 산출물은 관찰 사실·추정·미확인 영역을 분리하고 독점 코드나 리소스를 복제하지 않는다.

## 조사에서 확인하지 않은 사실

- 한글 2024의 모든 메뉴 버튼이 직접 작동하는 것을 검증하지 않았다.
- 공식 도움말을 통한 목록화는 현재 UI의 모든 사용자 정의 또는 버전 패치 차이를 증명하지 않는다.
- 이 작업에서 빌드나 테스트를 다시 실행하지 않았다. 코드를 변경하지 않은 문서 작업이며, 소스·기존 테스트와 날짜가 명시된 저장소 검증 기록을 근거로 삼았다.
- 이 문서만으로 HWP/HWPX 전체 호환률, GUI 완성률, Windows/Linux 동등성을 주장할 수 없다.
