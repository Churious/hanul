# 한울 문서

한울 문서는 HWP와 HWPX 파일을 열어 문서 모델을 직접 편집하고 원래 형식으로 저장하는 독립 오픈소스 데스크톱 워드프로세서 프로젝트입니다. Windows/Linux용 편집기를 만들고 있으며 RHWP 문서 모델과 조판 결과를 중심으로 기능을 확장합니다. 현재 기능은 초기 편집 범위이며, 한글 문서 전체와의 호환성은 별도 파일 모음과 왕복 저장 검증이 필요합니다.

## 현재 구현

- Windows/Linux용 Tauri 2 + React + TypeScript 데스크톱 편집기
- RHWP Wasm 코어로 HWP/HWPX 파일 파싱 및 SVG 페이지 렌더링
- 새 HWP 문서 생성, OS 파일 선택기, 가상 페이지 목록, 페이지 이동, 확대·축소
- 페이지에서 커서 이동, 드래그 선택, 한글 IME 입력, 문자 삽입·삭제, 문단 나누기·병합
- 글꼴·크기·굵게·기울임·밑줄·정렬, 표 삽입 및 표 셀 텍스트 입력
- 선택 텍스트 복사·잘라내기·붙여넣기, 문서 변경의 실행 취소·다시 실행
- HWP/HWPX 형식 유지 저장, 저장 전에 RHWP 내용 손실 보고서 확인
- 홈/삽입 리본, 페이지 눈금자, 페이지 기반 편집 화면, 상태 표시줄
- 입력 파일 크기 제한, 페이지 SVG 정화, CSP, 네트워크 글꼴 미사용
- 자체 제작 한울 UI 표식과 한국어 시작 화면

파싱·렌더링·편집·내보내기는 RHWP의 공개 API를 문서 세션 어댑터를 통해 호출합니다. 본문 편집과 HWPX 저장 왕복은 앞선 단일 페이지 문서에서 확인했습니다. 이번 편집기 확장분의 표·서식·선택·클립보드 동작과 실제 Windows IME 입력은 아직 데스크톱에서 검증하지 않았습니다. HWP 바이너리와 복합 객체가 있는 문서, Linux 네이티브 빌드도 검증이 필요합니다. 편집 범위와 근거는 [호환성 표](docs/compatibility/matrix.md)를 참고하세요.

## 개발 환경

- Rust/Cargo
- Node.js 24 LTS와 npm
- Windows: Microsoft C++ Build Tools의 "Desktop development with C++", WebView2 Runtime
- Linux: Tauri 2의 WebKitGTK 개발 패키지와 빌드 도구

이 작업 환경은 Windows 11 x64이며 Rust 1.99, Node 24.16, npm 11.13을 확인했습니다. WebView2 Runtime이 있고, cl.exe를 찾지 못했지만 Tauri 네이티브 빌드와 NSIS 설치 프로그램 생성까지 완료했습니다. 자세한 환경 및 Linux 미검증 항목은 [빌드 안내](docs/development/build.md)를 참고하세요.

## 시작

~~~powershell
cd apps/desktop
npm ci
npm run tauri dev
~~~

브라우저에서 UI만 확인할 때는 npm run dev를 실행합니다. 이 미리보기는 Tauri 네이티브 패키지 검증을 대체하지 않습니다.

## 검증 명령

~~~powershell
cd apps/desktop
npm test
npm run build
npm run tauri build
~~~

현재 편집기 변경 후 `npm run build`가 통과했습니다. 앞선 구현의 테스트 7건과 Windows Tauri 릴리스 빌드 기록은 있지만, 이번 편집기 확장 뒤에는 테스트와 데스크톱 패키지를 다시 검증해야 합니다. Linux 패키지는 CI에서 빌드하도록 설정했지만 로컬 검증은 아직 하지 않았습니다.

## 프로젝트 문서

- [아키텍처 개요](docs/architecture/overview.md)
- [RHWP 분석](docs/research/rhwp-analysis.md)
- [REA 설치와 진단](docs/research/rea-setup.md)
- [한글 UX 관찰](docs/research/hanword-ux.md)
- [호환성 표](docs/compatibility/matrix.md)
- [개발 빌드](docs/development/build.md)
- [테스트 상태](docs/development/testing.md)
- [로드맵](docs/roadmap.md)
- [기여 안내](CONTRIBUTING.md)

## 라이선스

프로젝트 코드는 MIT 라이선스입니다. RHWP 코어는 MIT 라이선스의 별도 패키지 의존성으로 사용합니다. 앱 배포본을 만들 때는 [제3자 고지](THIRD_PARTY_NOTICES.md)를 함께 포함하세요. 한울은 한컴과 무관한 독립 구현입니다.

