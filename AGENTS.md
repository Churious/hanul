# Hanul 개발 에이전트 규칙

## 제품과 범위

- 사용자를 **주인님**이라고 부른다.
- Hanul은 Windows와 Linux를 대상으로 하는 오픈소스 HWP/HWPX 워드프로세서다. 한글 2024는 기능, 사용 흐름, 파일 호환성을 관찰하는 참고 대상이다. 소스코드·아이콘·폰트·상용 리소스를 복제하지 말고 동작을 독립적으로 구현한다.
- Windows와 Linux를 동등한 공식 지원 대상으로 다룬다. macOS는 현재 우선순위 및 검증 대상에서 제외한다.
- 앱은 Tauri 2 데스크톱 셸, React/TypeScript UI, Rust 백엔드로 구성된다. HWP/HWPX 처리에는 현재 `@rhwp/core` WASM과 Rust `rhwp`가 쓰인다.
- Hanul 독립 문서 엔진을 장기 핵심 엔진으로 발전시킨다. RHWP는 현재 복잡하거나 지원 범위 밖인 문서의 호환 세션과 파싱·직렬화 기능에 활용한다. Hanul 엔진의 HWP/HWPX 직렬화도 현재 RHWP 배치 직렬화기를 사용하므로 완전히 독립된 파일 형식 구현이라고 설명하지 않는다.

## 코드 계층과 수정 위치

- `apps/desktop/src/document-engine.ts`: UI가 사용하는 `DocumentEngine`, `DocumentSession` 계약과 문서·편집·호환성 타입. React 코드에서 RHWP 전용 타입이나 API를 직접 사용하지 않는다.
- `apps/desktop/src/hwp-engine.ts`: RHWP WASM 초기화, 파일 파싱, import feature gate, `hanulDocumentEngine`과 `rhwpDocumentEngine` 연결 및 호환 세션. 문서가 독립 모델로 안전하게 변환되지 않으면 RHWP 세션에 남긴다.
- `apps/desktop/src/text-document-engine.ts`: Hanul 독립 문서 모델과 편집·Undo/Redo·증분 조판·Display List·페이지 SVG 생성. 현재 모델에는 문단, 표, 그림·도형·글상자 표현이 있으나, 모델에 구조가 있다는 이유만으로 모든 기존 문서가 손실 없이 import/export된다고 가정하지 않는다.
- `apps/desktop/src/rhwp-plain-text-serializer.ts`: 지원되는 Hanul 문서 모델을 RHWP 배치 API로 직렬화하는 어댑터.
- `apps/desktop/src/document-compatibility.ts`: TypeScript 쪽의 엔진·형식별 저장 호환성 판정과 serializer 손실 보고 병합.
- `apps/desktop/src/document-lifecycle.ts` 및 `apps/desktop/src/App.tsx`: 비동기 열기 버전 관리, 미저장 변경 확인, 저장 잠금·revision 보호와 제품 명령 흐름. UI에서 이 안전장치를 우회하는 별도 파일 경로를 만들지 않는다.
- `apps/desktop/src/App.tsx`, `apps/desktop/src/components/`: 리본, 편집 화면, 커서·선택·IME 오버레이 등 데스크톱 UI. 새 UI 기능은 문서 엔진 계약을 통해 실제 모델 명령과 연결한다.
- `apps/desktop/src-tauri/src/lib.rs`: 파일 선택 후 저장 백엔드. 임시 파일 검사, RHWP 재파싱, 호환성 검사, 원자 교체 및 PDF 파일 출력을 담당한다. UI 사전 판정만으로 저장 안전성을 대체하지 않는다.
- `apps/desktop/e2e/`: Windows 네이티브 앱 파일 수명주기 E2E. `webdriver-e2e`와 장애 주입 명령은 격리된 디버그 테스트에서만 사용한다. 릴리스 빌드 가드를 제거하지 않는다.

기능을 수정하기 전에 위 경로와 해당 테스트를 읽고, 이미 있는 명령·모델·컨트롤러를 재사용한다. UI와 RHWP 내부를 직접 결합하거나 같은 문서 명령을 두 군데서 따로 구현하지 않는다.

## HWP/HWPX 데이터 보존 규칙 — 최우선

- 사용자 문서의 내용과 구조를 보존한다. 지원하지 않는 컨트롤·필드·구역·서식·개체를 조용히 삭제, 공백 치환, 단순 텍스트 변환하지 않는다.
- `document-compatibility.ts`의 판정과 Rust 저장 경계의 판정을 모두 따른다. 결과는 `SUPPORTED`, `UNSUPPORTED`, `LOSSY`, `UNKNOWN`으로 구분하고, 형식과 엔진 경로별 근거 및 영향을 받는 요소를 유지한다.
- `SUPPORTED`는 현재 내부 구조 정책과 재파싱 범위의 판정이다. 한글 2024 호환성을 뜻하지 않는다. `LOSSY`는 손실 항목을 사용자에게 알리고 명시적 승인을 받는 기존 흐름을 따른다. `UNSUPPORTED`와 `UNKNOWN`은 우회하지 않는다.
- 지원되지 않는 문서는 Hanul 독립 엔진으로 강제 전환하지 않는다. RHWP 경로를 유지하거나, 안전한 저장 판정이 나오지 않으면 저장을 차단한다.
- 제품 저장은 같은 대상 폴더의 임시 파일을 쓰고 형식 서명·RHWP 재파싱·구조 정책을 검사한 뒤 원자 교체하는 기존 경로를 유지한다. 실패하면 기존 파일과 dirty 상태를 보호한다. 저장 기능을 추가할 때 임시 검증·원자 교체를 건너뛰지 않는다.
- HWP의 글상자 저장 allow-list는 현재의 좁은 조건을 유지한다. 제품 경로에서 검증된 단일 구역의 단순 사각형 글상자 하나와 내부 단일 문단 범위만 허용하며, 여러 글상자, 다중 문단·중첩 내용, 표·그림 등 혼합 개체, 필드·범위 태그 또는 미지원 속성은 계속 차단한다. 한글 2024 GUI에서 열기·편집·저장·재열기까지 검증하지 않은 범위를 임의로 허용하지 않는다.
- RHWP 재파싱 성공, 자동 fixture 왕복, 한글 2024에서 직접 연 결과를 각각 구분해 기록한다. serializer 손실 0건이나 파일이 다시 파싱된다는 사실만으로 무손실 또는 한글 2024 호환을 주장하지 않는다.

## 엔진·조판·편집 성능 규칙

- 모델, 편집 명령, 조판, Display List/SVG 렌더링, 저장·포맷 어댑터의 책임을 분리한다. 엔진 간 변경은 `DocumentEngine`/`DocumentSession` 계약 뒤에서 수행한다.
- Hanul 독립 경로에서는 문단·표·페이지의 변경 범위와 캐시 무효화를 유지하고 증분 조판을 우선한다. 편집마다 동기식 전체 문서 조판이나 전체 페이지 SVG 재생성을 추가하지 않는다.
- RHWP 호환 경로의 조판 비용은 독립 엔진의 성능으로 포장하지 않는다. 두 엔진의 편집·조판 경로와 지원 범위를 따로 측정한다.
- 커서·선택·IME preedit은 페이지 SVG에서 분리된 오버레이로 유지한다. 개체 드래그 중에는 `pointer-frame.ts`의 Pointer Events/`requestAnimationFrame` 경로처럼 화면 미리보기만 갱신하고 pointer-up에서 문서 모델에 한 번 반영한다.
- 엔진 연산, 조판, 페이지 SVG, React/WebView 반영, 실제 입력부터 화면까지의 시간을 분리한다. 합성 Node 벤치마크를 실 GUI 응답 시간으로 표현하지 않는다. 성능 개선 주장은 동일 조건의 전후 측정으로 뒷받침한다.
- 35·98·500쪽 성능 목표와 현재 한계는 [편집 성능 기록](docs/performance/editing-benchmark.md)을 참고한다. Worker는 실제 병목과 UI 차단이 측정된 뒤 선택하며, 단순히 작업을 옮긴 것만으로 계산량이 줄었다고 주장하지 않는다.

## 로드맵 및 구현 절차

다음 문서를 제품 범위와 우선순위의 기준으로 사용한다.

- [제품 목표와 범위](docs/roadmap/README.md)
- [V1 마일스톤](docs/roadmap/v1-milestones.md)
- [한글 2024 기능 인벤토리](docs/roadmap/hanword-2024-feature-inventory.md)
- [기능 격차 분석](docs/roadmap/feature-gap-analysis.md)
- [호환성 매트릭스](docs/compatibility/matrix.md)

모든 작업에서 다음 순서를 따른다.

1. 관련 마일스톤과 기능 ID, 완료 조건을 확인한다.
2. 제품 코드, 기존 테스트, 저장 호환성 정책을 조사한다.
3. 이미 구현된 기능을 재사용하고 요청 범위만 수정한다.
4. 동작 경로에 맞는 회귀 테스트를 추가하거나 기존 테스트를 확장한다.
5. 코드 결과와 증거에 맞춰 상태·호환성·테스트 문서를 갱신한다.
6. 실제로 검증하지 않은 기능·플랫폼·파일 구조는 완료로 표시하지 않는다. 모든 마일스톤 완료 조건을 충족했을 때만 `COMPLETE`로 바꾼다.

기능 수보다 문서 보존, 실제 GUI 사용성, 편집 반응성, HWP/HWPX 저장·재열기 및 플랫폼별 안정성을 우선한다. 상세 요구와 조사 근거는 위 로드맵 문서에서 관리하고 이 파일에 복제하지 않는다.

## 플랫폼별 검증

- **Windows 11:** Tauri 네이티브 앱과 실제 파일 대화상자를 검증한다. IME 기능은 Microsoft IME 조합 입력으로 확인하고, HWP/HWPX 호환성 주장은 필요할 때 설치된 한글 2024에서 직접 열기·편집·저장·재열기까지 검사한다. 기존 Windows UI Automation 및 E2E 하네스를 우선 사용한다.
- **Linux:** 실제 접근 가능한 네이티브 Linux 노트북/데스크톱에서 GUI 검증을 우선한다. X11/Wayland, IBus/Fcitx, GTK/portal 대화상자, OS 파일 권한 및 패키징을 환경별로 기록한다. 네이티브 환경에 접근할 수 없으면 미검증으로 남긴다.
- **WSL2/WSLg:** 보조 빌드·테스트 및 GUI 환경이다. WSLg 통과를 일반 Linux X11/Wayland 또는 IME 전체 지원으로 간주하지 않는다. 환경과 입력기 이름을 기록한다.
- Windows/Linux 결과를 한 항목으로 합치지 않는다. 빌드·단위 테스트 통과는 해당 OS의 GUI·IME·파일 대화상자 검증 완료와 다르다.

## 실제 명령과 테스트

Node 버전은 CI의 Node 24 설정을 기준으로 한다. JavaScript 명령은 `apps/desktop`에서 실행하고 Rust workspace 명령은 저장소 루트에서 실행한다.

```powershell
# apps/desktop — 의존성, 프런트엔드 테스트와 빌드
npm ci
npm test
npm run build

# Tauri 앱 실행 및 플랫폼 패키징
npm run tauri dev
npm run tauri build -- --bundles nsis       # Windows
npm run tauri build -- --bundles deb,appimage # Linux

# 기존 Windows 네이티브 GUI 파일 수명주기 E2E
npm run test:e2e:desktop

# 기존 성능 도구: 결과는 해당 스크립트가 측정하는 범위로만 해석
npm run benchmark:editor-engine
npm run benchmark:open
npm run benchmark:render

# 저장소 루트 — Rust 테스트 및 형식 검사
cargo test --workspace --locked
cargo fmt --check
```

- Tauri 번들 빌드에는 각 OS의 공식 Tauri 선행 패키지가 필요하다. CI 설정과 빌드 안내는 [desktop workflow](.github/workflows/desktop.yml), [빌드 안내](docs/development/build.md)를 확인한다.
- `npm run test:e2e:desktop`은 현재 실행기에서 Windows 전용으로 명시되어 있다. Linux에서는 성공한 것처럼 보고하지 말고, 수동 AT-SPI/WSLg 검증은 재현 가능한 Windows E2E와 구분해 기록한다.
- `npm test`에는 HWP/HWPX 편집·직렬화·재열기 및 호환성 테스트가 포함되지만, 테스트된 fixture와 내부 파서 범위만 증명한다. 실제 한글 2024 검사나 실 GUI IME 검사를 대신하지 않는다.
- 변경 범위에 맞는 프런트엔드/Rust 테스트와 빌드를 실행한다. 실행하지 못한 명령은 환경과 이유를 결과에 남긴다. 사용하지 않은 플랫폼의 성공을 추측하지 않는다.

## Computer Use, REA, 의존성

- 실제 메뉴·포커스·OS IME·파일 대화상자 동작을 확인해야 할 때 Computer Use 또는 기존 UI 자동화를 사용한다. 사용자의 화면을 조작하는 요청이 없으면 반복 시도나 불필요한 포커스 이동을 피한다. GUI 자동화가 반복 실패하면 같은 조작을 되풀이하지 말고 원인과 미검증 범위를 기록한다.
- REA/Ghidra는 한글 2024의 내부 구조가 공개 문서와 GUI 관찰만으로 해결되지 않을 때에만 사용한다. Hanul 소스 분석에 REA를 쓰지 않는다. REA 관찰도 한글 2024의 독점 코드·리소스를 복제하는 근거로 사용하지 않는다.
- 새 의존성을 추가하기 전에 라이선스와 유지보수 상태를 확인하고 기존 패키지로 가능한지 판단한다. RHWP 코드를 복사·수정할 때는 upstream 기여 조건과 저작권·라이선스를 보존한다.
- 문서 처리는 오프라인에서 수행한다. 분석·텔레메트리·계정·원격 API·런타임 폰트 다운로드를 추가하지 않는다.

## Git과 작업 결과

- 요청한 범위 밖의 파일은 수정하지 않는다. 기존 변경, 사용자 문서 및 미추적 검증 폴더를 덮어쓰거나 임의로 삭제·커밋하지 않는다. 특히 `.linux-validation-objects-20261015/`는 사용자 승인 없이 정리하거나 추적하지 않는다.
- 테스트 산출물, 빌드 결과, 임시 파일은 소스 및 사용자 데이터와 분리한다. `.gitignore`와 테스트 정리 스크립트가 실제 대상에 어떤 영향을 주는지 확인한 뒤 사용한다.
- 검증된 변경만 의미 있는 단위로 커밋한다. 사용자가 명시적으로 요청하지 않는 한 원격 저장소에 push하지 않는다.
- 작업 종료 시 변경 파일, 실행한 테스트와 결과, GUI/플랫폼 제한, 미검증 범위, 커밋 해시를 보고한다.
