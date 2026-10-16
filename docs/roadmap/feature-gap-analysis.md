# 한글 2024 ↔ Hanul 기능 격차 분석

기준일: 2026-10-15. 기능 ID는 [한글 2024 기능 인벤토리](hanword-2024-feature-inventory.md)를 따른다. 분류는 README의 다섯 상태를 사용한다. 상태는 현재 코드와 테스트가 뒷받침하는 지원 범위에 대한 것이며, Hanword와의 동등성을 뜻하지 않는다.

## 분류 결과

| 상태 | ID 수 | 해석 |
| --- | ---: | --- |
| COMPLETED | 1 | 확인 가능한 좁은 범위의 기능 동작과 회귀 테스트가 있음 |
| PARTIAL | 53 | 일부 엔진/문서/플랫폼 경로만 동작하거나 실제 GUI·저장 검증이 제한됨 |
| NOT_IMPLEMENTED | 78 | 실행 가능한 Hanul 기능 경로를 확인하지 못함 |
| BROKEN | 0 | 이번 조사에서 현재 재현된 결함을 기능 상태로 확정하지 않음 |
| UNKNOWN | 0 | 소스에서 기능 경로 존재 여부를 확인하지 못한 항목은 없음. 플랫폼별 실제 동작은 별도 UNKNOWN으로 남김 |
| **합계** | **132** | 인벤토리의 모든 조사 단위 |

UNKNOWN이 0인 이유는 기능이 미확인일 때 소스/테스트의 작동 경로가 없으면 NOT_IMPLEMENTED로 분류했기 때문이다. 이는 Hanword 기능 자체를 GUI로 모두 조사했다는 뜻이 아니다. 한글 2024 GUI에서 조작하지 못한 기능은 인벤토리에서 공식 도움말 근거로만 열거했다.

## 기능 ID별 상태

| ID | Hanul 상태 | 확인된 Hanul 범위와 한계 |
| --- | --- | --- |
| FIL-01, FIL-04, FIL-07 | PARTIAL | 새 문서, HWP/HWPX 열기, 저장/다른 이름 저장 명령이 연결됨. V1-02a의 열기 generation gate와 V1-02b의 저장 중 문서 전환 방지·저장 snapshot 이후 edit revision 보호가 있다. Windows 11 Tauri GUI E2E는 16개 시나리오/38개 단언을 통과했다. WSLg GTK/portal AT-SPI에서 HWP/HWPX 열기·최근 재열기·실제 파싱 경합, POSIX 저장 권한 거부(OS `EACCES`), 제품 저장 commit gate 경합, dirty 종료 Save 후 새 프로세스 재열기를 확인했다. 실패 시 기존 파일 바이트와 dirty 상태가 유지됐다. 일반 X11/Wayland는 별도 V1-15 검증 대상이다. 가져오기와 저장은 지원 구조 게이트를 거치며 형식 전반의 무손실 호환성은 검증되지 않음. |
| FIL-02, FIL-03, FIL-05, FIL-06, FIL-08, FIL-10, FIL-11, FIL-12 | NOT_IMPLEMENTED | 템플릿·문서 도우미, 상호 변환, XML 도구, DAISY, 라이선스/점자, 외부 전송 기능의 제품 경로를 확인하지 못함. |
| FIL-09, FIL-13 | PARTIAL | 문서 정보 대화상자는 파일명·경로·형식·크기·쪽/구역·엔진 버전·암호화 정보·사용 글꼴을 표시한다. WSLg에서 native-open한 HWP/HWPX에서 이 기본 필드 표시를 확인했고 이는 V1-02의 기본 문서 정보 조건을 충족한다. 문서 모델/UI에는 제목·작성자·문서 내부 생성·수정 시각 필드가 없고 포맷별 round-trip도 없다. 조사한 HWPX의 title/created/modified는 비어 있었고 creator=`rhwp`는 사용자 작성자로 오인하지 않았다. 값을 임의 생성하지 않는다. 전체 FIL-09 메타데이터 기능과 Hanword의 모든 용지 옵션은 구현되지 않음. 용지 설정 대화상자와 일부 페이지 설정 모델 테스트가 있음. |
| FIL-14 | PARTIAL | 앱 내부 인쇄 미리보기와 WebView 시스템 인쇄 경로가 있음. 실제 프린터와 PDF 가상 프린터별 출력 정확도는 폭넓게 검증되지 않음. |
| FIL-15 | PARTIAL | 최근 경로 저장·중복 제거·끊어진 경로 정리에는 자동화 테스트가 있다. Windows Tauri GUI E2E에서 최근 파일, dirty close/exit, Save/Discard/Cancel, 저장·파싱 경합을 확인했다. WSLg에서는 native Open과 최근 메뉴의 HWP/HWPX 재열기, dirty 보호, POSIX `EACCES` 저장 실패 시 원본·dirty 유지, 제품 저장 commit gate 경합, dirty 종료 Save 후 새 프로세스에서 재열기를 확인했다. 반복 가능한 Linux native-dialog E2E 및 일반 Linux 데스크톱은 미검증이다. |

V1-02a–V1-02e의 상세 플랫폼 증거와 미검증 경계는 [마일스톤 기록](v1-milestones.md#v1-02-진행-기록)과 [데스크톱 파일 수명주기 테스트](../testing/desktop-file-lifecycle-e2e.md)를 참조한다. V1-02는 원래 범위에서 COMPLETE이며, FIL-01/04/07/09/15의 더 넓은 기능 상태는 PARTIAL이다. WSLg는 일반 Linux 데스크톱을 대표하지 않는다.
| EDT-01, EDT-02, EDT-03, EDT-05, EDT-09 | PARTIAL | 실행 취소/다시 실행, 기본 텍스트 클립보드, 일부 선택/정렬 작업이 있음. 서식이 포함된 복사, 임의 범위·개체·문단 동작과 플랫폼 클립보드 동등성은 제한됨. |
| EDT-04, EDT-07, EDT-08, EDT-10 | NOT_IMPLEMENTED | 메뉴의 레이아웃 표시/제거, 범용 찾아가기, 문자 체계 변환, OLE 연결 관리 등은 제품 명령 경로가 없음. |
| EDT-06 | COMPLETED | 지원 문단 텍스트의 찾기/바꾸기, 대소문자 옵션, 다음/이전 및 모두 바꾸기 흐름에 UI와 모델 테스트가 있음. 한글 전체 기능의 범위 검색/필드/주석까지 완료했다는 뜻은 아님. |
| VW-01, VW-02, VW-05 | PARTIAL | 배율 조절, 연속/한 쪽 보기, 페이지 탐색, 수평·수직 눈금자 표시가 있음. 눈금자에서 여백/탭 위치를 끌어 편집하거나 격자/안내선을 조정하는 기능은 없음. |
| VW-03, VW-04, VW-06, VW-07–VW-12 | NOT_IMPLEMENTED | 문단/조판 부호 표시, 변경 추적 표시, 화면 색, 발음 표시, Hanword 작업 창과 창 관리 등 해당 명령군의 제품 기능을 확인하지 못함. |
| INS-01 | PARTIAL | 표 삽입 및 셀 텍스트 편집, 행/열 추가·삭제, 셀 합치기/나누기, 일부 속성이 구현됨. 복잡한 셀 병합/속성과 레이아웃의 HWP/HWPX 보존은 제한됨. |
| INS-02 | PARTIAL | 그림 삽입과 기본 개체 조작 테스트/GUI가 있음. 형식 교환과 모든 배치 속성은 제한됨. |
| INS-03, INS-04 | NOT_IMPLEMENTED | 그림 OCR/캡처 및 차트 편집 제품 경로가 없음. |
| INS-05, INS-06 | PARTIAL | 글상자와 사각형/타원 등 제한된 도형을 모델·UI에서 편집하고 Undo/Redo하는 경로가 있음. HWP 저장은 검증된 단일 글상자 구조만 허용되며 복합 개체는 차단됨. |
| INS-07, INS-08 | NOT_IMPLEMENTED | 수식 입력기, 일반 OLE·양식·멀티미디어 편집 경로가 확인되지 않음. |
| INS-09 | PARTIAL | RHWP 세션의 각주/미주 관련 편집 API 및 필드 테스트가 있음. Hanul 독립 엔진에서는 관련 UI가 비활성화되어 있고, 필드/주석 왕복 보존이 제한됨. |
| INS-10, INS-11, INS-12 | NOT_IMPLEMENTED | 일반 메모, 책갈피 편집, 상호 참조 생성·갱신의 사용자 기능 경로를 확인하지 못함. 문서 가져오기에서 구조를 감지하거나 보존 경로를 유지하는 것만으로 편집 기능을 지원한다고 분류하지 않음. |
| INS-13 | PARTIAL | 하이퍼링크를 RHWP 경로에서 추가·삭제하고 재열기하는 테스트가 있음. Hanul 독립 엔진 UI에서는 비활성화됨. |
| INS-14 | PARTIAL | 기본 기호 입력용 UI와 텍스트 삽입 경로가 있으나 Hanword 문자표의 전체 문자/분류·글꼴 동작은 아님. |
| INS-15, INS-16, INS-18 | NOT_IMPLEMENTED | 한자 변환, 상용구/입력기 보조, OCR·캡처·문서 변환 등 제품 기능은 확인되지 않음. |
| INS-17 | PARTIAL | 쪽 번호/각주 필드 일부가 RHWP 경로에서 모델 테스트됨. 날짜/파일명/문단 띠/캡션 등의 범용 생성·편집은 없음. |
| FMT-01, FMT-02 | PARTIAL | 글꼴/크기와 굵게·기울임·밑줄·취소선이 인터페이스, UI, 일부 모델 테스트에 있음. 언어별 글꼴, 장평·자간·기준선과 장식 확장은 제한됨. |
| FMT-03, FMT-04 | NOT_IMPLEMENTED | 독립 엔진의 문자 모양 계약에 글자색·강조/테두리/배경 또는 확장 문자 속성이 없다. 기본 글자 모양 대화상자에도 연결되지 않음. |
| FMT-05, FMT-07, FMT-11 | PARTIAL | 정렬, 기본 여백/들여쓰기, 문서 스타일 및 개체 속성의 일부가 모델/API에 있음. 줄 간격·고급 문단 대화상자는 새 독립 엔진에서 비활성화된 항목이 있고, 개체 속성 적용 범위도 제한됨. |
| FMT-06, FMT-08, FMT-09, FMT-10, FMT-12 | NOT_IMPLEMENTED | 탭 정지·문단 경계/배경, 글머리표/개요 번호 시스템, 첫 글자 장식, 범용 스타일 적용 규칙은 확인되지 않음. |
| PAG-01, PAG-02 | PARTIAL | 단일 구역 용지 크기·방향·여백 설정이 모델/API와 UI에 있음. 구역마다 다른 설정, 제본·홀짝 쪽 상세 옵션은 제한됨. |
| PAG-03, PAG-04, PAG-05, PAG-06 | NOT_IMPLEMENTED | 쪽 테두리/배경, 다단, 다중 구역 설정, 바탕쪽을 위한 완전한 제품 흐름이 없음. |
| PAG-07, PAG-09 | PARTIAL | RHWP 세션에서 머리말/꼬리말과 쪽 번호 필드 편집 및 형식 round-trip 테스트가 있음. 독립 엔진은 미지원이며 필드 손실 위험은 경고/호환 게이트로 처리됨. |
| PAG-08 | PARTIAL | 쪽 나누기 삽입 및 HWP/HWPX 재열기 테스트가 있음. 단 나누기와 구역 나누기의 별도 동작은 미구현. |
| PAG-10, PAG-11, PAG-12, PAG-13 | NOT_IMPLEMENTED | 줄 번호, 원고지, 레이블, 페이지 단위 삭제 도구를 확인하지 못함. |
| TBL-01, TBL-02, TBL-03, TBL-04, TBL-05, TBL-06 | PARTIAL | 표 생성, 셀 편집, Tab 이동, 행/열 조작, 셀 합치기·나누기, 폭/높이/여백/색상 일부와 Undo/Redo가 있음. 간단한 Hanword 확인 사례는 있으나 모든 셀 속성·테두리와 복합 표의 HWP/HWPX 보존은 미완료. |
| TBL-07, TBL-08, TBL-09, TBL-10, TBL-11, TBL-12 | NOT_IMPLEMENTED | 표 쪼개기·붙이기, 선 그리기/지우개·문자 변환, 표 스타일, 균등 분배, 수식/계산 및 숫자 표시 기능은 없음. |
| PIC-01, PIC-02, PIC-03, PIC-04 | PARTIAL | 그림 삽입/선택·이동·크기 조절, 일부 배치와 비율 유지가 구현됨. 크롭/배치·앵커·클리핑의 형식 교환과 복합 문서 보존은 제한됨. |
| PIC-05, PIC-06 | NOT_IMPLEMENTED | 그림 캡션/EXIF·셀 맞춤, 그림마당·OCR·전체 그림 형식 변환 기능을 확인하지 못함. |
| OBJ-01, OBJ-02, OBJ-03, OBJ-04 | PARTIAL | 기본 도형/글상자 삽입과 일부 선·채우기·이동·크기·삭제/Undo/Redo UI/API가 있음. 회전, 그룹, 글 배치의 모든 경우와 HWP 혼합 개체 저장은 제한됨. |
| OBJ-05 | NOT_IMPLEMENTED | 개체의 그룹/그룹 해제, 정렬·배포와 보호의 완전한 기능을 확인하지 못함. |
| REV-01, REV-02, REV-03, REV-04, REV-05 | NOT_IMPLEMENTED | 변경 추적/적용·거부, 문서 비교·병합 및 완전한 검토 메모 모델이 없음. 일반 메모/주석 API는 이 범주의 추적·검토 동등성을 충족하지 않음. |
| TLS-01–TLS-14 | NOT_IMPLEMENTED | 맞춤법·사전·번역, 메일 머지, 매크로, 차례/색인, 개인정보 도구, 발표/키보드 환경 및 플러그인 관리의 Hanul 제품 경로가 없음. |
| SEC-01–SEC-04 | NOT_IMPLEMENTED | 문서 암호화, 배포용 보호, 개인정보 가림/보호의 사용자 기능 경로가 없음. |
| XPL-01 | PARTIAL | 커서·범위 선택·선택 사각형·다중 문단 편집이 모델 테스트됨. 플랫폼 GUI의 드래그/캐럿 좌표 일치와 모든 개체 선택은 미완료. |
| XPL-02 | PARTIAL | React composition 이벤트를 모델 변경과 분리하는 코드 및 IME 단위 테스트가 있음. WSLg IBus에서 물리 r/k 입력으로 가를 화면에 조합한 과거 확인이 있지만 저장 재열기/Undo를 포함한 전체 실GUI 과정, 실제 Microsoft IME, 일반 Linux/Fcitx5는 미검증. |
| XPL-03 | PARTIAL | 일반 텍스트 복사/붙이기 UI가 있으나 서식 있는 클립보드·이미지·표·외부 워드프로세서 데이터 교환은 보장되지 않음. |
| XPL-04 | PARTIAL | HWP/HWPX 저장·재열기와 손실/구조 호환성 판정이 있음. HWP는 단일 구역의 검증된 단순 글상자 범위 등 제한적이고, HWPX도 모든 개체/필드의 무손실을 뜻하지 않음. |
| XPL-05 | PARTIAL | Tauri PDF export와 PDF 페이지 수 검사 테스트, React 인쇄 미리보기와 WebView 인쇄 호출이 있음. 동일 문서의 인쇄·PDF 시각 충실도, 프린터별 결과는 충분히 검증되지 않음. |
| XPL-06 | PARTIAL | Ctrl+N/O/S/Shift+S/P/Z/Y/Enter 등의 연결이 있으나 한글 2024 전체 기본 키맵·사용자 지정은 없음. 단축키 충돌과 Linux 키보드 레이아웃도 완전 검증되지 않음. |

### 집계 근거

- COMPLETED 1: EDT-06, 지원 텍스트 범위에 한정.
- PARTIAL 53: 위 표에서 PARTIAL로 명시한 ID. 여러 ID 묶음 행은 나열된 각 ID를 각각 센다.
- NOT_IMPLEMENTED 78: 위 표의 남은 명시 ID 및 ID 범위.
- BROKEN 0, UNKNOWN 0: 아래 플랫폼 표의 UNKNOWN은 기능 자체가 아니라 검증 환경별 증거 상태다.

## 플랫폼 및 문서 형식 축

여기서 형식 상태는 편집기에서 파일을 열 수 있는지보다 보존과 왕복 편집 수준을 뜻한다. 각 항목의 엔진 선택은 [아키텍처 개요](../architecture/overview.md), 구조별 HWP 판정은 [호환성 매트릭스](../compatibility/matrix.md)와 document-compatibility.ts에 정의되어 있다. 오래된 아키텍처 문서 중 독립 엔진을 문단 전용으로 설명하는 문구는 현재 text-document-engine.ts의 표/개체 모델과 테스트보다 뒤처져 있어 현행 근거로 채택하지 않았다.

| 기능 영역 | Windows | Linux WSLg | 일반 Linux X11 | 일반 Linux Wayland | HWP 저장·재열기 | HWPX 저장·재열기 | 엔진/한계 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 열기 및 기본 편집 | PARTIAL | PARTIAL | UNKNOWN | UNKNOWN | PARTIAL | PARTIAL | 단일 구역 지원 구조는 Hanul 엔진, 복잡 구조는 RHWP 호환 엔진. 전체 문서 무손실 아님 |
| 본문 텍스트/서식 | PARTIAL | PARTIAL | UNKNOWN | UNKNOWN | PARTIAL | PARTIAL | 자동 모델 테스트 강함, 실제 GUI·한글 IME 양쪽 종단 검증 부족 |
| 표 | PARTIAL | UNKNOWN | UNKNOWN | UNKNOWN | PARTIAL | PARTIAL | Windows 일부 GUI에서 생성·행열/병합 작업 확인. Linux GUI와 모든 복합 표 미검증 |
| 그림·도형·글상자 | PARTIAL | UNKNOWN | UNKNOWN | UNKNOWN | PARTIAL | PARTIAL | Windows GUI 개체 편집 테스트가 있음. HWP 단순 글상자 범위만 한글 2024 검증, 그림 혼합은 미검증 |
| 머리말·꼬리말·필드 | PARTIAL | UNKNOWN | UNKNOWN | UNKNOWN | PARTIAL | PARTIAL | RHWP 엔진 API/round-trip 테스트, Hanul 독립 편집 경로는 제한 |
| PDF 및 인쇄 | PARTIAL | UNKNOWN | UNKNOWN | UNKNOWN | 해당 없음 | 해당 없음 | PDF API·페이지 검사 테스트와 WebView print UI. 실제 인쇄 환경 검증 제한 |
| OS 한글 입력 | UNKNOWN | PARTIAL | UNKNOWN | UNKNOWN | 해당 없음 | 해당 없음 | WSLg IBus GUI에서 조합 표시 확인 기록은 있으나 조합부터 저장 파일 재열기까지 전체 검증은 아님. Microsoft IME/Fcitx5 미검증 |

## 중요 격차 10개

| 순위 | ID | 격차와 사용자 영향 |
| ---: | --- | --- |
| 1 | XPL-02 | Microsoft IME, IBus, Fcitx5에서 조합·취소·Backspace·Undo까지 같은 편집 결과로 이어지는 전체 실GUI 검증이 부족하다. 입력은 워드프로세서의 기본 동작이다. |
| 2 | XPL-04 | 알 수 없는 HWP/HWPX 구조를 안전하게 지키는 가져오기·저장 범위가 좁다. 한글 2024 왕복 사용과 데이터 보존이 핵심 신뢰 요건이다. |
| 3 | FMT-01–FMT-07 | 글자·문단 속성과 스타일이 기본 기능에 머문다. 학교 과제/보고서의 혼합 서식 및 문서 내 스타일 일관성을 제한한다. |
| 4 | TBL-01–TBL-06 | 기본 표 작업은 가능하나 속성·병합·페이지 걸침·복합 테두리의 실제 호환성과 GUI 검증이 부분적이다. 표 중심 문서에서 큰 격차다. |
| 5 | PIC-01–PIC-04, OBJ-01–OBJ-04 | 그림/도형의 앵커, 클리핑, 배치, 글상자 혼합 문서에서 한글 2024와의 저장 호환성이 부족하다. HWP 저장 허용 범위가 의도적으로 제한됨. |
| 6 | PAG-03–PAG-07, PAG-09 | 다단, 구역, 바탕쪽, 홀짝 머리말/꼬리말과 쪽 번호가 제한돼 공문서/보고서 레이아웃이 부족하다. |
| 7 | VW-03–VW-09 | 인쇄 부호, 격자·안내선, 보기 패널, 개체 탐색과 문서 구조 탐색이 부족해 긴 문서를 편집하기 어렵다. |
| 8 | XPL-01, EDT-02 | 캐럿/선택 좌표와 서식·개체 클립보드의 실제 GUI 정확도 및 플랫폼 동등성이 충분히 검증되지 않았다. |
| 9 | XPL-05, FIL-14 | PDF 페이지 수 검사와 인쇄 UI는 존재하지만 시각 레이아웃, 글꼴 대체, 그림·표·쪽 나누기 및 장치별 인쇄 결과 검증이 제한된다. |
| 10 | XPL-01, XPL-02, 성능 축 | 35–500쪽 실제 문서에서 키 입력부터 WebView 화면 표시까지의 체감 지연을 플랫폼별로 측정하지 않았다. 합성 모델 벤치마크가 실GUI를 대체하지 못한다. |

## 데이터 보존 및 호환성 평가 원칙

- exportWithReport의 손실 보고가 비어 있어도 전체 HWP/HWPX 충실성을 증명하지 않는다.
- 가져오기 게이트에 걸리는 요소를 텍스트로 풀어 저장하거나 조용히 삭제하지 않는다.
- 단일 글상자 HWP 허용 범위는 별도 Golden 및 한글 2024 확인에 한정된다. 표+글상자, 그림+글상자, 여러 문단/개체 등은 이 증거를 확장할 수 없다.
- Windows에서 한글 2024가 검증한 결과를 Linux의 포맷 호환성 증거로 대체하지 않는다. 반대로 WSLg는 일반 Linux 배포판의 GUI·IME 증거가 아니다.
- 일반 X11/Wayland GUI, Fcitx5, 실제 프린터는 현재 UNKNOWN이다.

## 근거 위치

- 현재 API: [document-engine.ts](../../apps/desktop/src/document-engine.ts), [text-document-engine.ts](../../apps/desktop/src/text-document-engine.ts), [document-compatibility.ts](../../apps/desktop/src/document-compatibility.ts)
- UI 명령/기능 제한: [App.tsx](../../apps/desktop/src/App.tsx)
- 자동 회귀: [text-document-engine.test.ts](../../apps/desktop/src/text-document-engine.test.ts), [hwp-engine.test.ts](../../apps/desktop/src/hwp-engine.test.ts), [rhwp-plain-text-serializer.test.ts](../../apps/desktop/src/rhwp-plain-text-serializer.test.ts), [ime-input.test.ts](../../apps/desktop/src/ime-input.test.ts), [object-drag.test.ts](../../apps/desktop/src/object-drag.test.ts), Tauri [lib.rs](../../apps/desktop/src-tauri/src/lib.rs)
- 기능·플랫폼별 기존 상세 기록: [compatibility/matrix.md](../compatibility/matrix.md), [editing-benchmark.md](../performance/editing-benchmark.md), [Hanword UX 조사](../research/hanword-ux.md), [글상자 HWP 호환성](../research/hwp-textbox-compatibility.md)
