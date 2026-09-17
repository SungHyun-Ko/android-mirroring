# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DroidBridge — scrcpy/adb 기반 Android 제어 데스크탑 앱 (Electron). UI 문자열·로그·주석은 모두 한국어이며, 새 코드도 한국어로 유지한다.

## 명령어

```bash
npm install
npm start            # 실행
npm run dev          # DevTools 포함 (--dev 플래그)
npm run build:win    # NSIS 설치파일 → dist/
npm run build:mac    # dmg (x64/arm64, macOS 환경 필요)
npm run build:linux  # AppImage
```

- **테스트·린트·빌드 스텝이 없다.** 번들러도 없다. 검증은 `npm run dev` 로 실행해서 직접 확인하는 방식뿐이다.
- **`bin/` 의 adb / scrcpy 바이너리가 없으면 앱은 거의 아무것도 못 한다.** `bin/` 은 gitignore 대상이므로 클론 직후 한 번 채워야 한다: Windows 는 `powershell -File ./Windows_setup.ps1`, macOS/Linux 는 `brew`/`apt` 설치 후 `bin/` 에 심볼릭 링크 (README 참고).
- `scrcpy-server` jar 은 `bin/` 에 없으면 미러링 첫 실행 시 GitHub 에서 자동 다운로드된다 (폐쇄망이면 미리 넣어둘 것).

## 아키텍처

Electron 3-프로세스 구조에, **서로 독립적인 백엔드 3개**가 물려 있다.

```
public/renderer.js ──(window.db.*)──> src/preload.js ──(ipcRenderer)──> src/main.js
                                                                           │
                          ┌────────────────────────────────────────────────┼──────────────────┐
                          │                                                │                  │
                  MirrorBridge                                      ProxyServer          adb 직접 호출
             (src/mirror-bridge.js)                            (src/proxy-server.js)     (runAdb / spawn)
                          │                                     + CertManager
        adb forward tcp → scrcpy 소켓 파싱 → 로컬 WSS           (src/cert-manager.js)
                          │
        renderer: WebSocket → WebCodecs VideoDecoder → <canvas>
```

### 1. 미러링 (`src/mirror-bridge.js` ↔ `public/renderer.js`)

**scrcpy 실행파일을 띄우지 않는다.** `scrcpy-server.jar` 만 기기에 push 해서 `app_process` 로 직접 구동하고, 와이어 프로토콜을 JS 로 파싱해 로컬 WebSocket 으로 중계한다. 렌더러가 WebCodecs 로 디코딩해 canvas 에 그린다. (README 의 "별도 scrcpy 창" 표기는 옛 구현 기준 — 현재는 앱 내부 canvas 다.)

주의할 점:

- **프로토콜 상수는 실측값이다.** `_pipe()` 안의 `DEVICE_NAME_LEN = 65`, `SESSION_META_LEN = 12` 가 실제 동작하는 값이고, 같은 파일 상단의 파일 주석(64 / 8)은 낡았다. 바꾸기 전에 `[raw]` 로그로 바이트를 다시 재보라.
- 비디오 소켓과 제어 소켓은 **같은 forward 포트로 순서대로 두 번 connect** 해서 얻는다. 둘 다 성공해야 스트리밍이 시작된다.
- 디코더 코덱이 `avc1.640020` 으로 하드코딩되어 있고, config 패킷(SPS+PPS)은 `configNalBuffer` 에 캐시해뒀다가 IDR 앞에 수동으로 붙여야 한다 (`feedFrame()`). VideoDecoder 는 description 없이 config 만으로는 디코딩하지 못한다.
- jar 버전 문자열은 `app_process` 인자로 그대로 넘어가고 **서버가 자기 버전과 다르면 기동을 거부한다** (`IllegalArgumentException: The server version (4.1) does not match the client (...)`). 버전은 ① `ensureJar()` 의 다운로드 경로가 알려준 값 → ② `_jarVer()` 의 파일명 파싱 → ③ `_probeJarVer()` 가 서버에 직접 물어본 값 순으로 정해진다. ③ 덕분에 파일명에 버전이 없는 jar(`Windows_setup.ps1` 이 zip 에서 복사한 것, brew 설치본)도 그냥 동작하므로 **리네임은 필요 없다.** `FALLBACK_VER` 는 ③까지 실패했을 때만 쓰이는 최후값이라 정확할 필요가 없다.
- 시작 시 기기의 좀비 scrcpy 프로세스를 `pkill` 로 정리하고, 서버 기동 후 abstract socket 바인딩까지 1.5초를 더 기다린다 — 이 대기를 줄이면 소켓 연결이 간헐적으로 실패한다.

### 2. 입력 주입 (터치 / 키 / 텍스트)

렌더러가 JSON 으로 WS 에 보내면 브리지가 scrcpy 제어 패킷으로 바꿔 쓴다 (`injectTouch` 32B / `injectKeycode` 14B / `injectText`).

- **좌표는 렌더러에서 기기 픽셀로 환산해서 보낸다.** `sendTouchEvent()` 가 letterbox/pillarbox 여백을 빼고 역산하므로, 캔버스 크기 로직을 건드리면 터치 정확도가 같이 깨진다.
- **텍스트는 keycode 가 아니라 클립보드로 넣는다.** scrcpy 의 `TYPE_INJECT_TEXT` 는 한글을 주입하지 못하므로 `TYPE_SET_CLIPBOARD(9) + paste:true` 를 쓴다. 렌더러는 숨은 `textarea` 값을 60ms 디바운스 후 이전 전송분과 공통 접두사 비교 → 차이만큼 백스페이스 + 나머지 붙여넣기 (`syncText()`). **이 디바운스와 순서가 한글 조합 레이스 컨디션(“기서서” 현상)의 핵심이므로 임의로 줄이지 말 것.**

### 3. 패킷 분석 프록시 (`src/proxy-server.js`, `src/cert-manager.js`)

MITM HTTP/HTTPS 프록시. CONNECT 터널을 가로채 node-forge 로 호스트별 인증서를 즉석 발급(CA 는 `userData/proxy-certs` 에 영속)하고, 복호화한 요청/응답을 `proxy:packet` 이벤트로 렌더러에 흘린다. 기기 설정은 adb(`settings put global http_proxy`) 로 자동 주입한다.
`proxy:patch-and-install-apk` 는 **PC 에 Java 가 설치돼 있어야** 하고 `npx apk-mitm` 을 그때그때 실행한다 (번들 아님).

### 4. 그 외 기능

캡처·녹화·APK 설치·파일 전송·클립보드·키이벤트는 `main.js` 에서 adb 를 직접 호출한다. 결과는 예외를 던지지 않고 **`{ ok, message }` 객체로 반환**하는 것이 이 코드베이스 전체의 규약이다.

## 코드 수정 시 알아야 할 규칙

- **IPC 를 추가하면 반드시 3곳을 같이 고친다**: `main.js` 의 `ipcMain.handle` → `preload.js` 의 `contextBridge` 노출 → `renderer.js` 의 `window.db.*` 호출. 채널 접두사는 `adb:` / `mirror:` / `proxy:` / `dialog:` / `setup:`.
- **렌더러에 모듈 시스템이 없다.** `renderer.js` 는 클래식 `<script>` 한 개이고 모든 함수가 전역이며, `index.html` 이 인라인 `onclick="fn()"` 으로 호출한다. UI 동작 추가 = 전역 함수 + onclick. (`src/` 는 CommonJS.)
- **바이너리 경로는 `resolveBin()` 을 통해서만 얻는다.** `bin/` → macOS/Linux 표준 경로(`/opt/homebrew/bin` 등) → `where`/`which` 순으로 탐색한다. macOS GUI 실행 시 `$PATH` 가 비어 있는 문제 때문에 필요한 로직이다. 패키징 상태에서 `resourcesPath/bin` 이 쓰기 불가면 `userData/bin` 으로 복사 후 전환한다 (`main.js` 상단).
- UI 설정값은 `localStorage` 에 `db_` 접두사로 저장한다 (`db_screen_width`, `db_bitrate`, `db_fps`).

## 빌드 / 배포

- `.github/workflows/build.yml` — main/master push 또는 수동 실행 시 windows+macos 매트릭스 빌드. Windows 잡은 빌드 전에 `Windows_setup.ps1` 로 바이너리를 받아 패키지에 포함시킨다. `--publish never` 라 릴리스는 만들지 않고 아티팩트만 올린다.
- macOS dmg 는 **서명되지 않는다.** 다운로드 후 "손상되었기 때문에 열 수 없습니다" 가 뜨는 것은 정상이며 `xattr -cr /Applications/DroidBridge.app` 로 해결한다. 이 안내는 README 와 DEVELOPER.md 양쪽에 있으니 관련 변경 시 같이 갱신할 것.
- `bin/` 은 `extraResources` 로 패키지에 통째로 들어간다.
