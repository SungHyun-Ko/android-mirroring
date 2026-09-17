# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DroidBridge — scrcpy/adb 기반 Android 제어 데스크탑 앱 (Electron). UI 문자열·로그·주석은 모두 한국어이며, 새 코드도 한국어로 유지한다.

## 명령어

```bash
npm install
npm start            # 실행
npm run dev          # DevTools 포함 (--dev 플래그)
npm run build:win    # NSIS 설치파일 → dist/
npm run build:mac    # dmg (x64/arm64) — 미서명. CI 가 쓰는 것
npm run build:linux  # AppImage

npm run release:mac  # dmg + Developer ID 서명 (사내 배포용, 약 2분)
npm run notarize:mac # 위 + Apple 공증 + staple (외부 배포용, 20분+)

node src/jira.js          # Jira 모듈 자가진단 (fetch 를 가짜로 바꿔 끼운 assert 스위트)
node src/hid-keyboard.js  # HID 리포트/디스크립터 자가진단
```

- **테스트 러너·린트·번들러가 없다.** 검증 수단은 두 가지뿐이다: 위 두 자가진단(`require.main === module` 가드 안의 `assert`)과 `npm run dev` 로 직접 실행. 순수 로직을 새로 추가하면 같은 방식으로 자가진단을 붙이는 것이 이 저장소의 관행이다(Electron 의존이 없어야 단독 실행된다).
- **런타임 문제는 `app.getPath('userData')/mirror.log` 를 먼저 본다.** 미러링 로그뿐 아니라 **렌더러의 console warn/error 까지** 이 파일로 끌어내 둔다(`main.js` 의 `console-message` 핸들러). 렌더러가 클래식 스크립트 한 덩어리라 예외 하나로 이후 핸들러가 통째로 죽는데, 화면상으로는 멀쩡해 보이기 때문이다. 앱 시작마다 비워진다.
- **`bin/` 의 adb 바이너리가 없으면 앱은 거의 아무것도 못 한다.** `bin/` 은 gitignore 대상이므로 클론 직후 한 번 채워야 한다: Windows 는 `powershell -File ./Windows_setup.ps1`, macOS/Linux 는 `brew`/`apt` 설치 후 `bin/` 에 심볼릭 링크 (README 참고).
- `scrcpy-server` jar 은 `bin/` 에 없으면 미러링 첫 실행 시 GitHub 에서 자동 다운로드된다 (폐쇄망이면 미리 넣어둘 것).
- `docs/TODO.md` 에 **알려진 결함과 미완 작업**이 정리돼 있다 (예: `adb:record-start` 가 실패를 감지하지 못함, 접근 경로 없이 남은 죽은 마크업·CSS). 관련 영역을 건드리기 전에 확인할 것.

## 아키텍처

Electron 3-프로세스 구조에, **서로 독립적인 백엔드 4개**가 물려 있다.

```
public/renderer.js ──(window.db.*)──> src/preload.js ──(ipcRenderer)──> src/main.js
                                                                         │
┌─────────────────┬────────────────────┬───────────────┬─────────────────┘
│                 │                    │               │
MirrorBridge      ProxyServer          jira.js         adb 직접 호출
mirror-bridge.js  proxy-server.js      Jira Cloud      runAdb / spawn:
+hid-keyboard.js  +cert-manager.js     REST v2         캡처·녹화·APK·파일·기기정보
│                                                      + LogCat (→ logcat:data)
adb forward tcp → scrcpy 소켓 파싱 → 로컬 WS
│
renderer: WebSocket → WebCodecs VideoDecoder → <canvas>
```

UI 는 **3컬럼**이다: 도구 패널 · 디바이스(canvas) · LogCat. 마크업 순서는 device → logcat → tool 이고 **CSS `order` 로 재배치**하므로(`style.css` 의 `.tool-col{order:1}` …) 화면 위치와 DOM 순서가 다르다.

### 1. 미러링 (`src/mirror-bridge.js` ↔ `public/renderer.js`)

**scrcpy 실행파일을 띄우지 않는다.** `scrcpy-server.jar` 만 기기에 push 해서 `app_process` 로 직접 구동하고, 와이어 프로토콜을 JS 로 파싱해 로컬 WebSocket 으로 중계한다. 렌더러가 WebCodecs 로 디코딩해 canvas 에 그린다. (README 의 "별도 scrcpy 창" 표기는 옛 구현 기준 — 현재는 앱 내부 canvas 다.)

주의할 점:

- **프로토콜 상수는 `[raw]` 로그로 실측해서 정한다. 그리고 scrcpy-server 버전마다 다를 수 있다.** 코드의 `DEVICE_NAME_LEN = 65`(더미 1B + 이름 64B), `CODEC_ID_LEN = 4`, `SESSION_META_LEN = 12`(offset 4=width, 8=height)는 **다운로드본 v4.1 + SM-G973N 조합에서 실측 확인**했다. 반면 파일 상단 주석은 v4.0 기준으로 `flags 없이 8B` 라고 적혀 있다 — **둘 다 실제로 관측된 적이 있다.**
  - v4.1 실측: 코덱 뒤 12B = `80000000 | 0000025e(606) | 00000500(1280)` → 앞 4B 는 flags, 그래서 offset 4/8 이 맞다.
  - 다른 기기(iMac, SM-G981N)에서는 코덱 뒤가 `00000240(576) | 00000500(1280)` 8B 로 관측됐다 — flags 가 없다. 이때 offset 4/8 로 읽으면 width 에 height 가, height 에 프레임 헤더 PTS 상위 4B 인 `0x80000000`(=2147483648)이 들어간다.
  - **증상: 해상도 로그에 `×2147483648` 또는 `2147483648×` 이 보이면 이 오프셋 문제다.** 프레임 경계까지 밀려 SPS/PPS 가 깨지므로 겉으로는 디코더 쪽 `A key frame is required after configure()` 로 나타나 원인을 놓치기 쉽다.
  - 원인 후보 1순위는 **jar 출처**다. `ensureJar()` 는 `/opt/homebrew/share/scrcpy/scrcpy-server` 등 **시스템 설치본을 GitHub 다운로드본보다 먼저** 집는다(`mirror-bridge.js:131-135`). brew 로 scrcpy 를 깐 기기는 다른 버전의 jar 를 쓰게 되므로 헤더 레이아웃이 달라질 수 있다. 문제가 생기면 로그의 `jar @ ...` 줄로 어느 jar 를 썼는지부터 확인할 것.
- 비디오 소켓과 제어 소켓은 **같은 forward 포트로 순서대로 두 번 connect** 해서 얻는다. 둘 다 성공해야 스트리밍이 시작된다. `controlSock` 은 현재 **쓰기 전용**이다 — 역방향 스트림(기기 클립보드 응답 등)은 아직 아무도 읽지 않는다.
- 디코더 코덱이 `avc1.640020` 으로 하드코딩되어 있고, config 패킷(SPS+PPS)은 `configNalBuffer` 에 캐시해뒀다가 IDR 앞에 수동으로 붙여야 한다 (`feedFrame()`). VideoDecoder 는 description 없이 config 만으로는 디코딩하지 못한다.
- jar 버전 문자열은 `app_process` 인자로 그대로 넘어가고 **서버가 자기 버전과 다르면 기동을 거부한다** (`IllegalArgumentException: The server version (4.1) does not match the client (...)`). 버전은 ① `ensureJar()` 의 다운로드 경로가 알려준 값 → ② `_jarVer()` 의 파일명 파싱 → ③ `_probeJarVer()` 가 서버에 직접 물어본 값 순으로 정해진다. ③ 덕분에 파일명에 버전이 없는 jar(`Windows_setup.ps1` 이 zip 에서 복사한 것, brew 설치본)도 그냥 동작하므로 **리네임은 필요 없다.** `FALLBACK_VER` 는 ③까지 실패했을 때만 쓰이는 최후값이라 정확할 필요가 없다.
- 시작 시 기기의 좀비 scrcpy 프로세스를 `pkill` 로 정리하고, 서버 기동 후 abstract socket 바인딩까지 1.5초를 더 기다린다 — 이 대기를 줄이면 소켓 연결이 간헐적으로 실패한다.
- **보기 회전은 기기를 돌리지 않는다.** `state.viewRot` 으로 우리 렌더링만 90°씩 돌린다(앱이 세로 고정이면 기기 회전은 거부당한다). `rotTransform()`(그리기)과 `unrotate()`(터치 역변환)는 **한 쌍**이라 한쪽만 고치면 즉시 터치가 어긋난다. 기기 자체를 돌리는 경로는 별도로 `rotateDevice()` = scrcpy `ROTATE_DEVICE(11)` 다.

### 2. 입력 주입 (터치 / 키 / 텍스트)

렌더러가 JSON 으로 WS 에 보내면 브리지가 scrcpy 제어 패킷으로 바꿔 쓴다 (`injectTouch` 32B / `injectKeycode` 14B / `uhidInput` / `injectText`).

- **좌표는 렌더러에서 기기 픽셀로 환산해서 보낸다.** `sendTouchEvent()` 가 letterbox/pillarbox 여백과 보기 회전을 빼고 역산하므로, 캔버스 크기 로직을 건드리면 터치 정확도가 같이 깨진다.
- **키보드는 UHID 가 기본, 클립보드가 폴백이다.** 브리지가 시작 시 `/dev/uhid` 접근 가능 여부로 판정해(`keyboardMode`) WS 메시지로 렌더러에 알려준다. 서버 로그에 UHID 오류가 뒤늦게 보이면 런타임에 클립보드로 되돌린다.
  - UHID 경로: 렌더러가 눌린 `KeyboardEvent.code` 집합을 `{type:'hid', codes:[...]}` 로 보내고 브리지가 `hid.buildReport()` 로 8바이트 부트 키보드 리포트를 만든다. **`e.key`(문자)가 아니라 `e.code`(물리 위치)** 를 쓰므로 PC 레이아웃·IME 상태와 무관하다. 문자 조합은 단말 IME 가 한다. 렌더러가 `nodeIntegration=false` 라 `hid-keyboard` 를 직접 require 하지 못해 코드 집합만 넘기는 구조다.
  - 한/영·한자(`Lang1`/`Lang2` = 0x90/0x91)는 scrcpy 기본 디스크립터 범위(0x65) 밖이라 `EXTENDED_MAX_USAGE` 디스크립터를 직접 만들어 쓴다. 이때 **Logical Maximum 은 2바이트 형식(`0x26 lo hi`)이어야 한다** — 1바이트(`0x25`)로 두면 0x91 이 음수로 읽혀 디스크립터가 조용히 망가진다. Windows 는 이 토글 키에 `keyup` 을 주지 않아 눌림 집합에서 직접 떼어낸다(`TAP_ONLY`).
  - 클립보드 폴백: scrcpy 의 `TYPE_INJECT_TEXT` 는 한글을 주입하지 못하므로 `TYPE_SET_CLIPBOARD(9) + paste:true` 를 쓴다. 숨은 `textarea` 값을 60ms 디바운스 후 이전 전송분과 공통 접두사 비교 → 차이만큼 백스페이스 + 나머지 붙여넣기 (`syncText()`). **이 디바운스와 순서가 한글 조합 레이스 컨디션("기서서" 현상)의 핵심이므로 임의로 줄이지 말 것.** 저장소에서 가장 취약한 로직이며 폐기 검토 중이다 (`docs/TODO.md` 2번).

### 3. LogCat / 현재 앱 / Jira (QA 고리)

`adb logcat -v threadtime -T 200` 을 spawn 해 `logcat:data` 청크로 흘린다. 렌더러 쪽 제약이 촘촘하다:

- 청크는 **줄 중간에서 끊긴다** — `logcatPending` 에 꼬리를 물려 처리한다. 화면 보관은 `LOGCAT_MAX_LINES = 3000` 까지(넘으면 앞에서 버림, DOM 이 감당 못 함).
- 레벨·프리셋·쿼리(`tag:` / `level:` / `pid:` …) 필터와 현재 패키지 PID 필터가 겹쳐 걸린다. 파싱은 `LOGCAT_PARSE_RE` 한 곳이다.
- Activity 폴링으로 얻은 포그라운드 패키지를 기준으로 `app:info` / `app:action`(force-stop·clear·재실행)이 동작한다.

Jira(`src/jira.js`)는 **REST API v2** 를 쓴다 — v3 는 description 을 ADF JSON 으로만 받아 QA 리포트 평문을 넣을 수 없다. 토큰은 `safeStorage` 로 암호화해 `userData/jira.json`(mode 0600)에 두고 **렌더러로는 절대 돌려보내지 않는다**(`hasToken` 불리언만). `jira:open` 은 atlassian.net / id.atlassian.com 만 허용하는 화이트리스트가 걸려 있다. 스코프형 토큰이면 사이트 주소가 401 이라 `api.atlassian.com/ex/jira/<cloudId>` 게이트웨이로 폴백하고 그 경로를 캐시한다 — 이 분기는 자가진단이 덮고 있다.

### 4. 패킷 분석 프록시 (`src/proxy-server.js`, `src/cert-manager.js`)

MITM HTTP/HTTPS 프록시. CONNECT 터널을 가로채 node-forge 로 호스트별 인증서를 즉석 발급(CA 는 `userData/proxy-certs` 에 영속)하고, 복호화한 요청/응답을 `proxy:packet` 이벤트로 렌더러에 흘린다. 기기 설정은 adb(`settings put global http_proxy`) 로 자동 주입한다.
`proxy:patch-and-install-apk` 는 **PC 에 Java 가 설치돼 있어야** 하고 `npx apk-mitm` 을 그때그때 실행한다 (번들 아님).

### 5. 그 외 기능

캡처·녹화·APK 설치·파일 전송·클립보드·키이벤트는 `main.js` 에서 adb 를 직접 호출한다. 결과는 예외를 던지지 않고 **`{ ok, message }` 객체로 반환**하는 것이 이 코드베이스 전체의 규약이다 (`{ ok:false, canceled:true }` 로 사용자 취소를 구분하기도 한다).

## 코드 수정 시 알아야 할 규칙

- **IPC 를 추가하면 반드시 3곳을 같이 고친다**: `main.js` 의 `ipcMain.handle` → `preload.js` 의 `contextBridge` 노출 → `renderer.js` 의 `window.db.*` 호출. 채널 접두사는 `adb:` / `mirror:` / `proxy:` / `dialog:` / `setup:` / `capture:` / `logcat:` / `jira:` / `app:` / `device:` / `window:`.
- **메인 → 렌더러 푸시 이벤트(`mirror:log`, `logcat:data`, `logcat:stopped`, `proxy:packet`)는 preload 에서 `removeAllListeners` 후 등록한다.** 재연결마다 리스너가 쌓이면 같은 줄이 여러 번 그려진다.
- **렌더러에 모듈 시스템이 없다.** `renderer.js` 는 클래식 `<script>` 한 개이고 모든 함수가 전역이며, `index.html` 이 인라인 `onclick="fn()"` 으로 호출한다. UI 동작 추가 = 전역 함수 + onclick. (`src/` 는 CommonJS.) DOM 요소가 없어도 죽지 않도록 `setText()` / `$()` 를 거치는 관행이 있다 — 탭에서 내려간 페이지의 마크업이 그대로 남아 있기 때문이다.
- **레이아웃 상수가 CSS 와 JS 양쪽에 있다.** `renderer.js` 의 `LOGCAT_MIN_WIDTH(720)` / `TOOL_WIDTH(290)` / `TOOL_COLLAPSED_WIDTH(18)` / `LAYOUT_GAP` / `LAYOUT_PAD` 는 `style.css` 값을 그대로 옮겨 적은 것이고, 이 합으로 `window:set-min-size` 최소 창 너비를 계산한다. 한쪽만 고치면 마지막 컬럼이 잘린다. 최소 **높이**는 실행 시 높이로 고정(`pickLaunchHeight()`)이라 렌더러가 건드리지 않는다.
- **바이너리 경로는 `resolveBin()` 을 통해서만 얻는다.** `bin/` → macOS/Linux 표준 경로(`/opt/homebrew/bin` 등) → `where`/`which` 순으로 탐색한다. macOS GUI 실행 시 `$PATH` 가 비어 있는 문제 때문에 필요한 로직이다. 패키징 상태에서 `resourcesPath/bin` 이 쓰기 불가면 `userData/bin` 으로 복사 후 전환한다 (`main.js` 상단).
- **`spawn` 하는 곳에는 `proc.on('error')` 를 반드시 단다.** 핸들러가 없으면 spawn 실패가 처리되지 않은 이벤트로 올라와 메인 프로세스가 통째로 죽는다.
- UI 설정값은 `localStorage` 에 `db_` 접두사로 저장한다: `db_screen_width`, `db_bitrate`, `db_fps`, `db_logcat_font`, `db_log_app_only`, `db_tools_collapsed`, `db_jira_draft`, `db_jira_pins`, `db_jira_projects`.

## 빌드 / 배포

- `.github/workflows/build.yml` — main/master push 또는 수동 실행 시 windows+macos 매트릭스 빌드. Windows 잡은 빌드 전에 `Windows_setup.ps1` 로 바이너리를 받아 패키지에 포함시키고, macOS 잡은 빈 `bin/` 만 만든다(=배포된 dmg 는 사용자 PC 의 brew adb 에 의존한다). `--publish never` 라 릴리스는 만들지 않고 아티팩트만 올린다.
- `bin/` 은 `extraResources` 로 패키지에 통째로 들어간다.

### macOS 서명 / 공증

로컬 배포용 스크립트가 셋으로 갈려 있다. **용도를 섞지 말 것.**

| 스크립트 | 서명 | 공증 | 소요 | 쓰는 곳 |
|---|---|---|---|---|
| `build:mac` | ✗ | ✗ | ~2분 | CI (`build.yml:50`) |
| `release:mac` | Developer ID | ✗ | ~2분 | 사내 배포 |
| `notarize:mac` | Developer ID | ✓ | 20분+ | 외부 배포 |

- **`build:mac` 에 `CSC_IDENTITY_AUTO_DISCOVERY=false` 가 박혀 있다. 빼지 말 것.** 빼면 electron-builder 가 키체인에서 아무 인증서나 주워 서명하는데, `Apple Development` 인증서가 걸리면 프로비저닝 프로파일이 없어 **실행 자체가 안 되는 앱**이 나온다(SIGTRAP). CI 는 인증서가 없으므로 어차피 미서명이고, 이 플래그는 로컬에서 실수로 서명되는 것을 막는 용도다.
- `release:mac` 은 `CSC_NAME` 으로 Developer ID 인증서를 **이름으로 고정**한다. 접두사 `Developer ID Application:` 을 붙이면 electron-builder 가 거부하므로 빼고 쓴다.
- `notarize:mac` 은 **gitignore 된 `.notarize.env`** 를 읽어 `APPLE_API_KEY`(.p8 경로) / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` 를 넘긴다. **저장소가 공개라 이 값들을 `package.json` 에 넣지 말 것.** 클론 직후에는 파일이 없으므로 직접 만들어야 한다:
  ```bash
  cat > .notarize.env <<'EOF'
  APPLE_API_KEY=$HOME/private_keys/AuthKey_<KEYID>.p8
  APPLE_API_KEY_ID=<KEYID>
  APPLE_API_ISSUER=<ISSUER-UUID>
  EOF
  ```
  파일이 없으면 스크립트가 **에러로 멈춘다** — 의도된 동작이다. 반대로 env 만 비어 있으면 electron-builder 는 `skipped macOS notarization` 경고만 남기고 서명본을 그냥 내놓으므로(조용한 성공) 그 경로를 피하려고 파일 없으면 실패하게 해 뒀다.
- 공증은 **빌드마다** 해야 한다. 티켓이 바이너리 해시에 묶여 있어 코드 한 줄만 고쳐도 무효다. 인증서(약 5년)와 .p8(만료 없음)만 1회성이다.
- 공증 상태를 보는 웹페이지는 없다. `xcrun notarytool history|info|log --key … --key-id … --issuer …` 가 유일한 경로다.
- **서명 여부에 따라 받는 쪽 증상이 다르다.** 미서명 → "손상되었기 때문에 열 수 없습니다"(우클릭 열기도 안 먹힘, `xattr -cr` 필요). Developer ID 서명 + 공증 없음 → "확인할 수 없음"(우클릭 → 열기 1회로 통과). 공증까지 → 경고 없음. 단 quarantine 이 안 붙는 경로(USB·파일서버·scp)로 주면 어느 쪽이든 그냥 열린다.
- README 와 DEVELOPER.md 에 `xattr -cr` 안내가 있다. 앱 이름이 `DroidBridge.app` 으로 바뀌었으므로 관련 변경 시 같이 갱신할 것.

### macOS 로컬 빌드에서 실측으로 걸린 것들 (2026-09-17)

- **`productName` 을 한글로 되돌리지 말 것.** 한때 `"안드로이드 미러링"` 이었고, 그 상태로 만든 .app 은 기동 즉시 SIGTRAP(exit 133)으로 죽었다. 메시지는 `FATAL:electron_main_delegate_mac.mm(67)] Unable to find helper app` — Electron 이 **CFBundleName** 으로 헬퍼 앱 경로를 조립하는데 비ASCII 이름이 디스크상 이름과 맞지 않는다. `npm start`(개발 실행)는 멀쩡하므로 **패키징해서 실행해 보기 전에는 드러나지 않는다.**
  지금은 `productName: "DroidBridge"` 로 두고 표시 이름만 한글로 준다 — macOS 는 `mac.extendInfo.CFBundleDisplayName`, Windows 는 `nsis.shortcutName`. `CFBundleName` 까지 한글로 덮으면 같은 이유로 다시 죽으므로 **`CFBundleDisplayName` 만** 바꿔야 한다. (`userData` 경로는 `package.json` 의 `name`(=`droidbridge`)에서 오므로 이 변경에 영향받지 않는다.)
- **npm 11 은 `electron` 의 postinstall 을 차단한다.** `npm install` 이 exit 0 여도 `node_modules/electron/dist/` 에 라이선스 파일만 남고 바이너리가 없다. `node node_modules/electron/install.js` 로 따로 받아야 하는데, 이때 `extract-zip` 이 첫 파일에서 멈추므로 캐시된 zip(`~/Library/Caches/electron/*/electron-v*.zip`)을 `ditto -x -k` 로 직접 풀고 `path.txt` 에 `Electron.app/Contents/MacOS/Electron` 을 써 주면 된다.
