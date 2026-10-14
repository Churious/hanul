# Hanul 문서 열기 성능 측정

## 방법

`apps/desktop/scripts/benchmark-open.mjs`가 RHWP로 작은 문서(2쪽)와 큰 문서(98쪽)를 생성하고, HWP와 HWPX 각각을 임시 파일로 저장한 뒤 다시 읽어 측정한다. 파일 읽기, WebAssembly 초기화, RHWP 문서 구성·초기 조판, 쪽 정보 조회, 대표 쪽 SVG 생성 시간을 따로 기록한다. Node 메모리 수치에는 RSS, JS heap, WASM을 포함한 external memory를 남긴다.

RHWP WASM 공개 API에서 `HwpDocument` 생성은 파싱, 모델 생성, 문단 재구성, 전체 초기 페이지네이션을 한 번에 수행한다. 이 API에는 그 내부 단계를 나누는 계측 지점이 없어 이를 `RHWP parse/model/layout` 한 항목으로 보고한다. 페이지 SVG를 만드는 동안의 DOMPurify 정화 및 React 반영 시간은 앱 개발 모드의 `[Hanul performance]` 로그로 별도 관찰한다.

수치는 Windows x64/Node 24.16.0 및 Ubuntu 26.04 WSL x64/Node 22.22.1에서 생성 문서로 얻었다. 레이아웃은 Node용 `measureTextWidth` 대체 함수로 계산하므로 WebView와 설치 글꼴에 따른 실제 페이지 배치 및 절대 시간과 다를 수 있다. 실제 한글 문서 표본이나 GUI를 사용하지 않았다.

## Windows 기준 측정

| 문서 | 파일 크기 | 페이지 | 파일 읽기 | RHWP 파싱·모델·초기 조판 | 0·중간·마지막 쪽 SVG | 전체 쪽 SVG 생성 | 캐시된 SVG / JS heap / RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 작은 HWP | 15 KB | 2 | 1.2 ms | 11.6 ms | 57.8 ms | 12.9 ms | 캐시 1.35 MB, 전체 페이지 테스트는 heap 11.5 MB / RSS 141 MB |
| 작은 HWPX | 8 KB | 2 | 1.4 ms | 22.7 ms | 16.1 ms | 10.4 ms | 캐시 1.35 MB, 전체 페이지 테스트는 heap 11.6 MB / RSS 175 MB |
| 큰 HWP | 41 KB | 98 | 1.1 ms | 829 ms | 243 ms | 8.79 s | 제한 전 90.15 MB / heap 164.3 MB / RSS 285.5 MB |
| 큰 HWPX | 40 KB | 98 | 1.7 ms | 965 ms | 277 ms | 9.20 s | 제한 전 90.15 MB / heap 163.0 MB / RSS 306.7 MB |

WASM 첫 초기화는 53.3 ms였다. 앱 코드는 모듈 범위 Promise 하나로 초기화 결과를 공유하므로 이후 문서마다 WASM을 다시 초기화하지 않는다.

## 변경 후 측정

Windows에서 같은 픽스처로 12쪽 LRU 캐시 적용 후 큰 HWP/HWPX의 모든 98쪽을 방문했다. 생성한 전체 SVG는 여전히 약 90.15 MB였지만 캐시에 남는 데이터는 10.68 MB로 줄었다(88.2% 감소). HWP 실행의 JS heap은 164.3→27.8 MB, RSS는 285.5→149.5 MB였다. HWPX의 JS heap은 163.0→26.5 MB, RSS는 306.7→168.0 MB였다. RSS에는 WASM 메모리와 런타임 변동이 포함된다.

| 환경 / 문서 | 파일 읽기 | RHWP 파싱·모델·초기 조판 | 0·중간·마지막 쪽 SVG | 전체 98쪽 SVG | 12쪽 캐시 |
|---|---:|---:|---:|---:|---:|
| Windows 큰 HWP | 1.4 ms | 923 ms | 274 ms | 10.06 s | 10.68 MB |
| Windows 큰 HWPX | 1.7 ms | 1,074 ms | 390 ms | 10.21 s | 10.68 MB |
| WSL 큰 HWP | 0.6 ms | 780 ms | 253 ms | 8.13 s | 10.68 MB |
| WSL 큰 HWPX | 0.9 ms | 738 ms | 243 ms | 8.11 s | 10.68 MB |

첫 WASM 초기화는 Windows 57.5 ms, WSL 59.8 ms였다. 작은 파일의 파싱은 Windows에서 HWP 14 ms/HWPX 25.5 ms, WSL에서 HWP 9.5 ms/HWPX 12.8 ms였다. 샘플과 런타임이 작아서 실행 간 수십 퍼센트 변동이 있어 파싱 시간의 개선으로 해석하지 않는다.

## 병목 및 코드 변경

- 파일 I/O는 이 샘플에서 0.4–2 ms로 병목이 아니었다. Tauri `readFile` 반환 바이트는 기존 경로에서 그대로 사용하며 중복 전체 복사는 없음을 확인했다.
- 큰 문서의 주된 열기 비용은 RHWP 동기 생성 단계였다. 98쪽 문서에서 약 0.74–1.07초이며, 이 단계는 현재 WASM API상 메인 스레드에서 실행된다. 열기 상태 표시를 먼저 그리도록 이벤트 루프에 양보한다.
- 화면은 `react-virtuoso`로 이미 가상화되어 있었지만, 방문한 모든 쪽 SVG를 영구 보관했다. 문서 세션 캐시를 최근 12쪽 LRU로 제한했다.
- 초기 쪽 주변의 사전 렌더 범위를 `increaseViewportBy` 700 px에서 320 px로 줄여 처음 열 때 오프스크린 쪽 작업을 줄인다.
- 개발 모드에서 파일 읽기, WASM 초기화, RHWP 처리, 초기 hit-test, 페이지 SVG 생성, SVG 정화, React 반영 시간을 출력한다.

## 실행

```sh
npm run benchmark:open
npm run benchmark:open -- --cache-limit=0
```

GUI/WebView E2E, OS IME, 일반 Linux 데스크톱은 이 측정 범위에 포함하지 않았다. RHWP 문서 생성·편집·실행 취소/다시 실행·HWP/HWPX 저장 및 재열기 기존 회귀 테스트는 계속 실행한다.
