# 기여 안내

한울 문서의 코드는 아직 초기 단계입니다. 작은 변경도 실제 지원 범위와 문서 보존 특성을 명확히 기록해 주세요.

## 개발

1. Node.js 24, Rust/Cargo, Tauri 플랫폼 의존성을 준비합니다.
2. apps/desktop에서 npm install을 실행합니다.
3. npm test, npm run build를 실행합니다.
4. 데스크톱 셸을 바꾸면 npm run tauri dev도 확인합니다.

문서 처리 코드는 apps/desktop/src/hwp-engine.ts의 어댑터를 통해 접근합니다. 편집·저장 기능을 추가할 때는 먼저 RHWP의 지원 범위와 저장 전 content-loss 보고서를 조사하고, 유실 가능성이 있는 요소를 조용히 제거하지 않도록 설계해야 합니다.

## 호환성 변경

- 실제 HWP/HWPX 샘플을 사용할 때 공개 배포 권한과 개인정보를 확인합니다.
- 상용 글꼴, 한컴 설치 파일, 사용자의 문서, 라이선스가 불명확한 파일을 커밋하지 않습니다.
- 관찰, 추론, 미검증 가설을 구분해 docs/research/에 기록합니다.
- 지원 상태를 docs/compatibility/matrix.md에 함께 갱신합니다.

## 의존성

새 런타임 또는 개발 의존성을 추가하기 전에 라이선스를 확인하고 THIRD_PARTY_NOTICES.md를 갱신합니다. 앱 실행 중 원격 서비스를 추가하지 않습니다.

