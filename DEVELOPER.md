# DroidBridge 개발자 레퍼런스 가이드 (DEVELOPER.md)

이 문서는 DroidBridge 프로젝트의 전체 아키텍처, 핵심 기능 구현 로직 및 빌드 배포 설정을 개발자(또는 AI 개발 에이전트) 관점에서 기술한 개발 참고 문서입니다. 차후 추가 기능 구현 및 버그 수정 시 이 문서를 먼저 읽고 컨텍스트를 파악할 수 있도록 구성되었습니다.

---

## 1. 아키텍처 개요 (Architecture Overview)

DroidBridge는 **Electron** 프레임워크를 기반으로 안드로이드 기기를 원격 제어 및 미러링하는 데스크톱 애플리케이션입니다.

* **메인 프로세스 (Main Process - `src/main.js`)**: 
  - Electron 윈도우 제어, 기기 상태 모니터링, IPC 통신 조율 및 ADB 명령어 포장 및 실행.
  - GUI 환경 구동 시 `$PATH`가 손실되는 macOS의 특성을 해결하기 위해, 시스템 탐색 외에 Homebrew 및 시스템 표준 경로(`/opt/homebrew/bin/`, `/usr/local/bin/` 등)를 직접 순회하며 adb 바이너리를 확보하는 `resolveBin` 로직 탑재.
* **프리로드 스크립트 (Preload Script - `src/preload.js`)**:
  - 메인 프로세스와 렌더러 프로세스 간의 안전한 다리 역할을 하는 보안 브리지 (`contextBridge`).
* **렌더러 프로세스 (Renderer Process - `public/renderer.js`, `index.html`)**:
  - HTML5 캔버스를 이용한 화면 렌더링 및 UI 로직 처리.
  - 마우스 이벤트 캡처, 키보드 입력 및 IME 조합 감지, UI 제어(화면 조절 등).
* **미러링 통신 브리지 (Mirror Bridge - `src/mirror-bridge.js`)**:
  - **scrcpy v4.0 프로토콜**을 직접 JavaScript 수준에서 파싱하여 로컬 WebSocket 서버로 스트리밍 데이터를 중계하는 백엔드 코어 모듈.

```
[Android 단말] --(adb push / app_process)--> [scrcpy-server.jar]
                                                      |
                                           (adb forward/tcp:27183)
                                                      v
[Electron Renderer (Canvas)] <-- (WSS/7183) <-- [MirrorBridge (mirror-bridge.js)]
```

---

## 2. 핵심 기능 구현 세부 정보 (Core Implementation Details)

### 2.1 마우스 터치 좌표 보정 및 역산 알고리즘
화면 캔버스의 CSS 비율 조절로 인해 화면 왜곡이 있더라도 기기의 실제 픽셀 좌표와 1:1 정밀하게 매핑되도록 보정 알고리즘이 설계되었습니다.
* **구현 위치**: `public/renderer.js`의 `phoneScreen` 이벤트 핸들러.
* **매핑 원리**:
  1. 기기로부터 전달된 디바이스 해상도(`width`, `height`)를 수신하여 `state.aspectRatio`를 갱신합니다.
  2. 렌더러 화면 슬라이더 크기에 맞춰 `#phoneScreen` (캔버스 부모)의 가로/세로 길이를 비례 조정합니다.
  3. 마우스 클릭/드래그 발생 시 `canvas.getBoundingClientRect()`를 통해 캔버스의 현재 렌더링 크기 및 시작 위치(Offset)를 구합니다.
  4. 레터박스(Letterbox) 및 필라박스(Pillarbox)에 의한 공백을 계산하여 마우스 좌표에서 제외합니다.
  5. 최종 유효 영역 내의 비율 값을 바탕으로 안드로이드 단말 해상도에 비례하도록 정교하게 역산하여 `INJECT_TOUCH_EVENT` 바이너리 패킷(32바이트)을 소켓으로 전송합니다.

### 2.2 한글/다국어 타이핑 및 조합 버그 완벽 제어
Android 단말과 scrcpy의 기본 텍스트 주입방식(`TYPE_INJECT_TEXT = 1`)은 ASCII 문자 외의 다국어(한글 등) 문자에 대해 `Could not inject char u+XXXX` 경고를 내며 입력이 불가능한 한계가 존재합니다.

* **동적 클립보드 주입 방식 도입 (`src/mirror-bridge.js`)**:
  - 이를 우회하기 위해 단말로 텍스트 입력 요청 시 scrcpy-server의 클립보드 주입 프로토콜(`TYPE_SET_CLIPBOARD = 9`) 및 자동 붙여넣기(`paste: true`) 기능을 사용합니다. 단말기의 클립보드에 문자열을 쓰고 곧바로 붙여넣기 키 이벤트를 날리는 구조입니다.
* **확정음절 선별 주입(Finalized Syllable Buffer) 알고리즘 (`public/renderer.js`)**:
  - 한글 자모가 타이핑될 때 실시간으로 텍스트 영역을 비교하여 매 입력마다 클립보드 동기화 명령을 보내면, 단말기 OS의 복사 지연(50~100ms)으로 인해 백스페이스 삭제 타이핑과 붙여넣기 순서가 뒤엉키는 심각한 레이스 컨디션이 발생합니다. (예: "여기서" 입력 시 "기서서" 등으로 꼬임)
  - **해결책**: 조합 중인 한글 자모의 마지막 글자는 렌더러 화면(`textarea`)에만 대기시키고 Android 단말로는 전송하지 않습니다.
  - 사용자가 입력을 계속하여 다음 글자가 완성되는 순간(즉, 이전 음절이 '확정(Finalized)'되어 변화하지 않는 상태가 됨)에만 해당 글자를 클립보드로 정확히 단 한 번 밀어 넣어(Paste) 중복 타이핑 및 지우기 동작의 순서 꼬임을 완벽하게 방지합니다.

### 2.3 화면 크기 조절 및 상태 보존
* 설정 패널의 슬라이더(`range`) 조절 값을 기기의 화면비(Aspect Ratio)와 매치시켜 CSS 너비/높이를 비례 연동합니다.
* 사용자가 조절한 최종 너비 값은 브라우저의 `localStorage` (`db_screen_width`)에 저장되어 앱 재기동 시 자동 복원됩니다.

### 2.4 오프라인/폐쇄망 환경 안정성 강화
* `src/mirror-bridge.js`의 `ensureJar()` 함수는 미러링 구동 시 깃허브 API를 우선 호출하도록 설계되어 있어, 인터넷이 불가능한 기기에서는 네트워크 연결 지연(Hang) 및 에러로 구동되지 못했습니다.
* **개선**: `bin/` 디렉토리 내에 버전명이 포함된 `scrcpy-server-v4.0` 혹은 `scrcpy-server` 일반 파일이 있는지 **로컬 파일 시스템을 우선적으로 스캔**하는 로직을 추가하여 오프라인 환경에서도 인터넷 조회 없이 즉각 미러링을 실행하도록 개선하였습니다.

---

## 3. 설치 및 빌드 배포 시스템 (Packaging & Build System)

### 3.1 Windows 패키징 및 NSIS 마법사 설정
* **빌드 설정 (`package.json`)**:
  - `"oneClick": false` 로 설정하여 프로그램 설치 시 사용자에게 단계별 윈도우 설치 창을 제공합니다.
  - `"allowToChangeInstallationDirectory": true` 를 부여해 설치 경로를 변경할 수 있도록 합니다.
  - `"runAfterFinish": true` 를 연동하여 설치 마지막 페이지("설치가 완료되었습니다")에서 바로 실행 체크박스와 완료 버튼을 클릭 시 DroidBridge 앱이 즉시 기동되도록 구성했습니다.

### 3.2 GitHub Actions 자동 빌드 시스템 (`.github/workflows/build.yml`)
* 코드를 푸시하거나 깃허브 웹 화면에서 직접 빌드를 실행할 시 클라우드 가상 머신(Windows, macOS)이 동시에 켜져 릴리즈 빌드를 진행합니다.
* 빌드 단계 전 윈도우 환경용 바이너리 다운로드 스크립트(`./Windows_setup.ps1`)를 자동으로 돌려, 빌드 시 필요한 ADB 및 scrcpy 바이너리 세트를 자동으로 수급한 후 설치형 패키지에 패키징하도록 환경을 완비했습니다.
* CI 감지 시 발생할 수 있는 릴리즈 토큰 누락 중단을 해결하기 위해 `package.json` 스크립트에 `--publish never` 인자를 명시하여 오로지 빌드 결과물(Artifacts)만 깃허브에 보관하도록 조율했습니다.

### 3.3 macOS 설치 파일 빌드 도우미 (`Mac_설치파일_만들기.command`)
* Mac 보안 제한 상 윈도우에서 `.dmg` 크로스 빌드가 불가하므로 맥 환경 빌드 파일을 더블클릭 만으로 작성해주는 스크립트 파일입니다.
* Xcode 개발자 툴, Homebrew, Node.js 유무를 순서대로 체크해 부재 시 자동 설치하며 빌드 완료 후 결과물이 포함된 `dist/` 폴더를 자동으로 파인더에 팝업하여 사용자의 터미널 명령 조작을 0회로 간소화시켰습니다.

---

## 4. 차후 개발자를 위한 팁 (Troubleshooting & Tips)

1. **macOS 게이트키퍼(Gatekeeper)**:
   - 증상은 **어떤 스크립트로 빌드했는지**에 따라 갈립니다. 원인은 둘 다 인터넷 다운로드 격리 속성(`com.apple.quarantine`)이고, 앱의 결함이 아닙니다.

     | 빌드 | 서명 | 공증 | 받는 쪽 증상 |
     |---|---|---|---|
     | `npm run build:mac` (CI 아티팩트) | ✗ | ✗ | *"손상되었기 때문에 열 수 없습니다"* — 우클릭 열기도 안 통함 |
     | `npm run release:mac` | Developer ID | ✗ | *"악성 코드가 없음을 확인할 수 없습니다"* — 시스템 설정에서 통과 가능 |
     | `npm run notarize:mac` | Developer ID | ✓ | 경고 없음 |

   - 두 번째 경우는 **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"** 로 넘어갑니다. macOS 15 부터 우클릭 → 열기 경로는 막혔습니다.
   - 어느 쪽이든 터미널 한 줄로도 해결됩니다:
     ```bash
     xattr -cr /Applications/DroidBridge.app
     ```
   - **애초에 격리 속성이 안 붙게 주는 방법이 가장 깔끔합니다.** `curl`·`scp`·USB·사내 파일서버로 받으면 플래그가 붙지 않아 경고 자체가 없습니다. 반대로 브라우저·Slack·메일·에어드롭은 붙입니다. 사용자 안내는 README 의 **macOS 설치** 절에 있습니다.
2. **바이너리 변경 시**:
   - `bin/` 폴더 내에 탑재되는 `scrcpy-server` 바이너리는 **버전 무관하게 그대로 교체해도 됩니다.** 파일명에 버전이 없으면 `_probeJarVer()` 가 서버를 불가능한 버전(`0`)으로 한 번 띄워 거부 메시지에 실려 오는 실제 버전을 읽어냅니다.
   - 이 조회가 없던 시절에는 파일명 파싱에 실패하면 상수 `FALLBACK_VER` 를 그대로 믿었고, `Windows_setup.ps1` 이 zip 에서 복사해 넣는 `scrcpy-server` 는 파일명에 버전이 없어 항상 이 경로를 탔습니다. 즉 **scrcpy 가 새 버전을 내는 순간 버전 불일치로 미러링이 죽는** 구조였습니다(CI 빌드도 매번 최신 바이너리를 받으므로 동일). 현재는 해소되었습니다.
