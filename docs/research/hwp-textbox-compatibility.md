# HWP 글상자 저장 호환성 조사

**상태: Hanword 2024에서 확인한 단순 단일 글상자 HWP 제품 저장 허용; 복합 글상자 구조는 계속 차단**
조사일: 2026-10-15

## 결론

제품 저장 경로를 별도로 검증했다. 독립 모델 세션의 일반 `exportWithReport("hwp")`가 생성한 출력 바이트를 앱 저장과 같은 Tauri `commit_document_save_blocking` 검증기(형식 확인 → RHWP 재파싱 → 글상자 범위 검사 → 같은 폴더에서 원자적 rename)에 전달했다. 제품 출력 재열기 테스트와 Golden 구조 commit 테스트를 자동화했다. 제품 serializer가 직접 생성한 본문+단일 사각형 글상자 출력은 Hanword 2024에서 경고 없이 열리고 본문 및 글상자가 표시됐다. 글상자 내용을 GUI에서 수정한 뒤 Hanword 별도 저장 파일을 다시 열어 수정 문자열을 확인했다. 검증 범위에 한해 제품 HWP 저장을 복구했다.

허용 범위는 한 구역에 본문과 단일 사각형 글상자 하나, 글상자 안 단일 일반 문단, 그리고 다른 개체·필드·범위 태그가 없는 구조다. 제품 serializer로 만든 80×35 mm, 37/28 mm 위치 출력도 Hanword에서 경고 없이 열고 편집한 뒤 Save As까지 확인했다. 하지만 그 제품 출력의 Hanword 재열기는 이번 세션에서 대상 문서임을 확정하지 못해 geometry 왕복은 미검증으로 남긴다. 여러 문단 글상자, 표/그림 등 다른 개체와의 혼합, 중첩 구조, 필드/범위 태그가 있는 문서는 UI 및 Tauri 저장 검증기에서 계속 차단한다. HWPX 저장은 변경하지 않았다.

그림+글상자 진단 후보는 글상자 편집 및 Hanword 왕복이 됐지만 그림은 글상자에 겹쳐 가려지고 대부분 잘려 표시/편집이 확인되지 않았다. 그러므로 그림+글상자 제품 저장은 허용하지 않는다. `flip` 비트 차이는 여전히 손상 원인으로 확정되지 않아 추측 변경하지 않았다.

`flip` 필드의 차이는 손상 원인으로 확정되지 않았다. 오히려 값이 다른 Hanword 생성 파일과 Hanul 후보가 모두 Hanword 2024 자동화 API에서 열렸으므로, 차이만으로 원인을 단정할 수 없다. 기존에 손상 오류가 보고된 Hanul 후보와 새 후보는 SHA-256이 같은 바이트 파일이었고, 새 확인에서는 열기와 한글 텍스트 조회가 성공했다. 과거 거부 결과는 동일 파일에서 재현되지 않았다.

초기 검증은 격리된 글상자에 한정됐지만, 2026-10-15 추가 GUI 검증으로 본문+단일 글상자와 크기·위치를 바꾼 단일 글상자 후보를 넓혔다. 두 후보 모두 Hanword 2024에서 경고 없이 열렸고, 한글 글상자 내용을 직접 수정해 별도 HWP로 저장한 후 다시 열었다. 재열기한 본문+글상자 파일에서 Hanword 속성 대화상자로 50×24 mm, 위치 77.24/20.00 mm, 네 면 2 mm 여백을 확인했다. 크기·위치 변경 파일에서는 80×35 mm, 위치 37/28 mm와 네 면 2 mm 여백을 확인했다. 두 별도 저장 파일에서 수정된 한글 내용이 재열기 후 보였다.

그림+글상자 후보도 열기·글상자 편집·별도 저장·재열기는 성공했으나, 그림과 글상자가 같은 위치에 겹쳐 있고 그림의 약 98.8%가 잘려 있어 그림 표시와 편집은 검증되지 않았다. 따라서 복합 그림 구조는 미검증이다. 이 후보들은 진단용 HWPX→HWP 출력이었다. 제품 저장 경로는 별도로 검증해 제한된 단일 글상자 범위만 허용한다. 손상 원인은 여전히 확정되지 않았다. Tauri 저장 검증, HWPX 경로, 임시 파일 검증 및 원자적 교체는 유지한다.

요청에 적힌 `%LOCALAPPDATA%\Temp\HanulValidation20261015`에는 현재 세 후보 파일이 없었다. 실제 후보는 `%LOCALAPPDATA%\HanulValidation20261015`에서 찾아 별도 `hanword-verification-copies` 폴더로 복사했다. GUI 작업 전후에 세 원본 후보와 작업용 복사본의 SHA-256이 일치했다. Hanword에서 편집한 결과는 각각 별도 `*-hanword-saved.hwp`로 저장했다.

## 2026-10-15 Hanword GUI 왕복 검증

| 후보 | 손상 경고 없이 열기/표시 | Hanword 편집 | 별도 저장 후 재열기 | 추가 확인 / 한계 |
|---|---|---|---|---|
| 본문 + 글상자, 제품 serializer + Tauri commit 출력 | 경고 없이 열리고 본문과 글상자 표시 | 글상자 내용을 GUI에서 수정 | Hanword 별도 저장 파일을 재열어 수정 문자열 확인 | 제품 경로 저장 허용 범위. 50×24 mm, 77.24/20 mm, 여백 2 mm. Golden 및 serializer export/reopen 테스트 포함 |
| 크기·위치 변경 글상자, 제품 출력 | 경고 없이 열리고 글상자 표시 | 글상자 내부 문구 수정 | Save As 성공; 재열기 대상 문서는 이번 세션에서 확정 못함 | 80×35 mm, 37/28 mm. Hanword 재열기 결과는 미검증으로 기록 |
| 여러 문단 글상자 | UI/backend 저장 검사에서 차단 | 미시도 | 미시도 | 계속 차단 |
| 표 + 글상자 | UI/backend 저장 검사에서 차단 | 미시도 | 미시도 | 계속 차단 |
| 그림 + 글상자 | UI/backend 저장 검사에서 차단 | 미시도 | 미시도 | 기존 진단 후보의 그림 표시/편집 미확인. 계속 차단 |

진단 경로와 제품 경로 파일은 별도 복사본으로 검증했다. 제품 출력의 본문+단일 글상자는 실제 serializer와 Tauri commit 검증기를 거쳐 Hanword 편집·별도 저장·재열기까지 확인했다. 크기·위치 변경 제품 출력의 Hanword 재열기와 복합 구조는 미확인 또는 차단 상태다.

앞선 여백 보존 수정에서 Hanul 모델의 2 mm 글상자 안 여백을 RHWP HWPX→HWP 출력에 네 면 모두 전달했다. RHWP 재파싱 테스트와 제품 serializer 테스트에서 각 면 567 HU(2 mm 반올림값)를 확인했다. 이것은 별도 손상 오류 원인을 확정하거나 전체 호환성을 뜻하지 않는다. 진단 파일 검증과 이번 제품 serializer/Tauri commit 검증은 각각 구분해 기록한다.

## 재현 파일과 근거

초기 테스트 산출물 일부는 `%LOCALAPPDATA%\Temp\HanulValidation20261015`에 보관했다. 이번 세 후보는 해당 하위 폴더가 아니라 `%LOCALAPPDATA%\HanulValidation20261015`에 있어 별도 검증 폴더에 복사했다. 저장소에 상용 바이너리, 한글 리소스, 또는 비공개 사용자 문서는 추가하지 않았다. 저장소의 작은 HWP golden fixture는 Hanul 진단 코드가 생성한 테스트 문서다.

| 산출물 | 생성/확인 방법 | 결과 및 범위 |
|---|---|---|
| `hanword-reference-textbox-korean.hwp` | Hanword 2024 `HWPFrame.HwpObject.2` COM(13.0.0.711)으로 사각형 글상자를 만들고 텍스트를 입력해 저장. 같은 COM API로 재열기 | `Open` 성공, `GetTextFile("TEXT")`에서 `HWP5 글상자 구조 후보` 확인. Hanword 생성·재열기 기준 파일임 |
| `hanword-reference-textbox-only-automation.hwp` | Hanword 2024 COM 생성 후 재열기 | ASCII 글상자 참고 사례. 한국어 레코드 비교 기준은 위 문서 |
| `hanul-matched-textbox-korean-50x24.hwp` | Hanul/RHWP 진단 후보. 여백 직렬화 수정 전 생성본 | Hanword COM `Open` 성공, `GetTextFile("TEXT")`에 한국어 문자열 확인. 과거 `hanul-textbox-hwp-candidate.hwp`와 SHA-256이 동일(`5e3a9deafef75e3df1953cc7f469262af14114bacec361441f8ab5c7b87559e9`)하여 과거의 동일 파일 손상 주장은 재현되지 않음 |
| 동일 경로의 여백 수정 후 후보 | 같은 테스트 생성기로 수정 코드 반영 후 재생성 | RHWP 재파싱에서 네 면 여백 567 HU 확인. 이번 별도 복사본 GUI 왕복에서는 본문과 글상자 표시, 글상자 편집, Hanword Save As, 재열기, 크기·위치·여백 대화상자 확인까지 완료. 정상 Hanul 사용자 저장 경로와 기준 파일 픽셀 일치는 미검증 |
| `gui-textbox-only.hwp` | 과거 GUI 임시 산출물 | OLE `BinData/BIN0001.png`가 있어 글상자만 든 기준 문서로 볼 수 없음. 현재 비교의 정상 대조군으로 사용하지 않음 |

COM 성공은 문서 구조를 Hanword가 열고 텍스트 API로 읽었다는 근거다. 이번 GUI 확인에서는 각 복사본의 본문/글상자 표시, 글상자 편집, Hanword Save As, 재열기까지 직접 확인했다. 본문+글상자와 크기 변경 후보는 Hanword 속성 대화상자에서 기하와 네 여백도 읽었다. 독립 Hanword 생성 기준과의 시각적 픽셀 일치, 그림+글상자에서 그림 표시·편집은 확인하지 않았다.

## 구조 비교

다음은 Hanword COM 생성 기준 파일과 여백 수정 전 Hanul 후보의 임시 바이너리 검사 결과다. 두 문서는 글상자 내용은 비슷하지만 페이지 설정, 개체 위치·크기, 설명, 문서 메타데이터를 완전히 맞춘 쌍은 아니다.

| 항목 | Hanword 기준 | Hanul 후보 | 해석 |
|---|---:|---:|---|
| OLE 파일 크기 | 13,312 B | 6,656 B | 컨테이너 스트림과 문서 메타데이터가 달라 직접 등가 비교 불가 |
| `CTRL_HEADER` (`gso `) | 62 B | 52 B | 컨트롤 설명 문자열 길이가 다르며 가변 길이 차이와 부합. 크기 오류 증거 아님 |
| `SHAPE_COMPONENT` (`$rec`) | 239 B | 252 B | 레코드 내부 부가 필드 차이. 이 차이 자체로 손상 여부를 판정할 수 없음 |
| 글상자 `LIST_HEADER` | 33 B | 33 B | 크기와 레코드 계층은 같음 |
| 글상자 문단 | 중첩 문단/텍스트/서식 레코드 존재 | 동일 계열의 중첩 문단/텍스트/서식 레코드 존재 | 텍스트와 속성 값은 다름 |
| 개체 크기/위치 | 14000×8000 HU, x=0,y=0 | 약 50×24 mm, x=25,y=20 mm | 좌표와 크기가 일치하는 재현 쌍이 아님 |
| `flip` | `0x01080000` | `0x01000000` | 값이 다르지만 두 파일 모두 Hanword COM에서 열림. 원인 후보로도 확정할 수 없음 |
| 글상자 여백 | 각 283 HU (약 1 mm) | 수정 전 0 HU, 수정 후 각 567 HU (약 2 mm) | Hanul 모델의 2 mm 여백을 수정 전 출력에서 잃던 별도 결함을 수정 |

공개 규격은 글상자 개체 속성 및 글상자 내부의 리스트/문단 레코드 계층을 설명하지만, 여기서 관찰한 상위 `flip` 값의 의미를 규정하지 않는다. 따라서 규격에 없는 비트를 강제 변경하지 않았다. 자세한 규격 출처는 Hancom의 [HWP 5.0 revision 1.3 명세](https://cdn.hancom.com/link/docs/%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C%ED%8C%8C%EC%9D%BC%ED%98%95%EC%8B%9D_5.0_revision1.3.pdf)이며, RHWP v0.8.7의 `src/parser/hwpx/section.rs`는 `TextBoxDrawing`에 `0x01000000`을 넣는 HWPX→HWP 저장 기본값을 사용한다. Upstream 동작 관찰도 그 비트의 규범적 정의나 Hanword 손상 원인을 증명하지 않는다.

## 수정 코드 및 회귀 테스트

`serializePlainTextObject`는 Hanul 글상자의 `textMarginsMm`을 RHWP `setShapeProperties`의 네 `tbMargin*` 값으로 HWP 단위 변환한다. 2 mm는 각각 567 HU다. [`hanul-textbox-body-50x24-hanword-gui-verified.hwp`](../../apps/desktop/test-fixtures/hanul-textbox-body-50x24-hanword-gui-verified.hwp)는 검증 구조 Golden이며 frontend 제품 serializer 재열기 테스트와 Rust의 atomic product-commit 테스트에서 사용한다. fixture SHA-256은 `C658F930B50D89B6FDAE9D39810D5BE668426C5EE7F42A87082DE1F9A7B46561`이다. UI와 Tauri 저장 검증기에 같은 제한 범위를 적용하고, 이를 넘는 글상자 문서는 HWPX 저장을 안내한다.

안전 저장 파이프라인은 대상 폴더의 임시 파일에 내보내고 다시 파싱한 뒤 형식/페이지 구조와 글상자 허용 범위를 확인해 원자적으로 교체한다. 검증 실패 시 기존 파일을 대체하지 않는다. 별도 무제한 진단 export helper는 제거했다. 제품 serializer 출력은 테스트 환경변수 아래에서만 격리 파일로 만들고, Rust 테스트는 일반 commit 함수를 실행한다.

이번 변경 최종 자동화 결과: Windows 11에서 `npm test -- --reporter=dot` 92/92, `npm run build`, `cargo test --workspace --locked` 12 passed/1 ignored, `cargo fmt --check`, `git diff --check`가 통과했다. Ubuntu 26.04 WSL2에서 Linux용 `npm test` 92/92, `npm run build`, `cargo test --workspace --locked` 12 passed/1 ignored가 통과했다. Linux Rust 빌드는 기존 `/tmp`가 7.8 GiB 중 약 7.5 GiB 사용 중이어서 이번 작업 소유의 Windows 임시 디렉터리로 `TMPDIR`과 `CARGO_TARGET_DIR`을 돌려 완료했다. 기존 `/tmp` 파일은 삭제하지 않았다. WSL에는 `rustup`/`rustfmt` 명령이 없어 Linux `cargo fmt --check`와 패키징은 수행하지 않았다. 이 실행은 WSLg GUI/IME를 검증하지 않는다.

## 최소 재현 상태

| 조건 | Hanword 생성/재열기 | Hanul 후보 Hanword 확인 | 상태 |
|---|---|---|---|
| 글상자 하나, 한국어 내용 | COM으로 생성 및 재열기 성공 | 제품 serializer + Tauri commit 출력이 경고 없이 열리고 표시됨 | Hanword 편집→별도 저장→재열기 성공. 허용 범위는 단일 사각형/단일 문단 구조 |
| 글상자와 본문 | Hanword 생성 기준 쌍은 미검증 | 제품 serializer + Tauri commit 출력에서 본문과 글상자 모두 표시 | Hanword 편집→별도 저장→재열기 성공; 50×24 mm, 위치 77.24/20 mm, 2 mm 여백 |
| 글상자 안 한글 | COM 기준 및 후보에서 확인 | 두 단일 글상자 후보에서 한글 수정 후 저장·재열기 성공 | 검증된 두 후보 범위에 한정 |
| 글상자 크기·위치 변경 | Hanword 생성 기준은 별도 변경 통제 없음 | 제품 출력이 열리고 편집 및 Save As 성공 | 80×35 mm, 37/28 mm. 제품 출력 재열기는 미확인; 진단 파일 왕복과 구분 |
| 글상자와 그림 | 미검증 | 파일은 열렸고 글상자 편집·Save As·재열기는 성공 | 그림은 글상자 뒤에 겹치고 약 98.8% 잘림. 그림 표시/편집 불가로 복합 구조는 미검증, 차단 유지 |

과거 여백 수정 후 COM 시도는 `Open` 결과를 반환하지 않았지만, 일반 UI에서는 진단 후보를 열 수 있었다. 이후 본문+단일 글상자 제품 출력은 실제 serializer와 Tauri commit을 거쳐 Hanword 편집·Save As·재열기까지 확인했다. 크기·위치 변경 제품 출력은 열기·편집·Save As까지만 확인됐고 재열기는 이 세션에서 확정되지 않았다.

## 남은 검증 및 저장 정책

1. Hanword가 자체 생성한 파일과 동일한 본문·개체 속성의 통제 쌍을 만들어 HWP 레코드 차이를 계속 분석한다.
2. 그림+글상자 후보의 그림 crop/겹침을 바로잡은 별도 최소 fixture로 그림과 글상자 양쪽의 렌더링·편집·재열기를 검증한다.
3. 크기·위치 변경 제품 출력의 Hanword Save As 사본을 다시 열어 geometry와 여백을 확인한다.
4. 단일 글상자 allowlist 밖의 복합·중첩 구조는 별도 검증한다.

- UI와 Tauri backend는 한 구역, 본문+단일 일반 사각형 글상자, 글상자 안 단일 일반 문단만 허용한다.
- 여러 문단, 표/그림 등 다른 개체 혼합, 중첩 구조, 필드/범위 태그가 있으면 계속 차단한다.
- HWPX 글상자 저장은 기존 회귀 테스트 범위에서 유지하지만 모든 복합 레이아웃을 보장하지 않는다.
- 실패한 저장은 임시 파일에서 검증되며 원본을 보호한다.
- 지원하지 않는 구조를 조용히 삭제하거나 공백으로 대체하는 저장 경로는 추가하지 않는다.
- Windows/Linux는 같은 RHWP 기반 직렬화 경로와 단위 변환을 사용한다. 이번 Linux GUI 및 IME 확인은 수행하지 않았다. Linux 자동화 테스트와 빌드 결과는 호환성 매트릭스의 최신 검증 기록에 추가한다.
