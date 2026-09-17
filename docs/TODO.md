# 남은 작업

2026-09-16 UI 개편 작업 중 미룬 것들. 위에서부터 우선순위 순.

---

## 1. 클립보드 양방향 자동 동기화 (요청됨, 미구현)

**원하는 동작**

- 디바이스 영역에 포커스가 있는 상태에서 `Ctrl+C` → 단말에서 복사한 내용이 **Windows 클립보드**로 들어온다
- 단말에서 복사한 내용을 PC 에서 `Ctrl+V` 로 바로 붙여넣을 수 있다

**지금 상태**

UI 의 클립보드 탭은 내렸다(`index.html` 의 tool-tabs 주석 참고). `page-clipboard` 마크업과
`sendClipboard()` / `fetchClipboard()` 는 남아 있지만 **도달 경로가 없다.** 즉 이 작업이
끝날 때까지 클립보드 기능은 사실상 비활성이다.

**구현 단서**

- scrcpy 제어 메시지 `GET_CLIPBOARD(8)` 로 단말 클립보드를 요청할 수 있다. 응답은 비디오가
  아닌 **제어 소켓의 역방향 스트림**으로 오므로, 현재 읽지 않고 있는 그 경로를 열어야 한다
  (`mirror-bridge.js` 의 `controlSock` 은 지금 쓰기 전용으로만 쓰인다).
- PC → 단말 방향은 이미 `TYPE_SET_CLIPBOARD(9)` 로 동작한다(`injectText`).
- Android 10+ 는 포커스 없는 앱의 클립보드 **읽기**를 막지만, scrcpy-server 는 shell 권한으로
  돌아 우회된다. Android 16 / SM-S926N 에서 `Device clipboard set` 이 정상 동작함을 확인했다.
- 단말 클립보드가 바뀔 때 scrcpy-server 가 먼저 알려주는 경로도 있다. 폴링보다 이쪽이 낫다.

---

## 2. 클립보드 폴백을 유지할지 결정 (UHID)

키보드 입력은 현재 UHID(물리 키보드 에뮬레이션)로 동작하고, `/dev/uhid` 를 못 쓰는 기기를
위해 예전 클립보드 주입 방식이 폴백으로 남아 있다.

**팀 기기가 전부 Android 11 이상이면 폴백을 버리는 편이 훨씬 깔끔하다.** 버릴 경우 사라지는 것:

- `mirror-bridge.js` 의 `injectText()` (클립보드 주입)
- `renderer.js` 의 `syncText()` — 60ms 디바운스 + 공통 접두사 diff + 백스페이스 재전송.
  이 저장소에서 가장 취약한 로직이다
- 숨은 `textarea` 와 모드 판정·전환 전부

설계 문서: [2026-09-16-uhid-keyboard-design.md](superpowers/specs/2026-09-16-uhid-keyboard-design.md)

---

## 3. `adb:record-start` 가 실패를 감지하지 못한다

[`main.js`](../src/main.js) 의 `adb:record-start` 는 `spawn` 직후 **무조건 `{ ok: true }`** 를
반환한다. stderr 를 아무도 읽지 않아 `screenrecord` 가 시작조차 못 해도 UI 에는 "녹화 시작됨"
으로 뜬다.

녹화 파일이 재생되지 않던 버그(moov atom 누락)를 오래 못 잡은 이유이기도 하다. `adb:install`
에는 같은 종류의 결함을 이미 고쳐 두었으니(`proc.on('error')` + 초기 출력 검사) 그 패턴을
그대로 쓰면 된다.

---

## 4. 녹화 저장 수정의 UI 검증

`screenrecord` 정지 시 로컬 adb 를 먼저 죽여 mp4 가 미완결로 남던 문제를 고쳤다
(`waitRecordingExit`). **명령 단위로는 실기기에서 검증했지만(40B → 834KB, moov 정상)
앱 UI 를 통한 경로는 아직 확인하지 않았다.** 녹화 → 중지 → 저장 후 파일이 재생되는지 볼 것.

---

## 5. 접근 경로가 없어진 화면 정리

탭에서 내렸지만 마크업은 남아 있는 것들:

| 페이지 | 상태 |
|---|---|
| `page-install` | APK 설치는 미러링 탭 버튼으로 이동. 설치 진행 목록(`installQueue`)은 화면에서 볼 수 없고 토스트로만 알린다 |
| `page-clipboard` | 위 1번이 끝나면 삭제 |
| `page-packet` | 기능 유지, 탭만 `display:none` (요청) |

죽은 CSS 도 같이 남아 있다: `nav`, `.sidebar`, `.nav-item`, `.content`, `.page-header`,
`.header-actions`, `.mirror-layout`, `.mirror-controls`, `.record-*`, `.conn-badge`.

---

## 6. 커밋

이 세션의 변경이 전부 미커밋 상태다. 커밋 단위 제안:

1. `fix: 화면녹화 mp4 미완결 문제 — screenrecord 종료 대기 후 pull`
2. `fix: scrcpy-server 버전을 서버에 직접 조회 — 릴리스마다 깨지던 문제 해소`
3. `feat: UHID 물리 키보드 입력 — 클립보드 경유 제거`
4. `feat: 미러링 화면 APK 드래그드랍 설치 + 진행/오류 표시`
5. `refactor: 3컬럼 UI 개편 (도구·디바이스·LogCat) + LogCat 스트리밍`

Jira 티켓 번호는 커밋별로 지정 필요.
