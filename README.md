# DroidBridge

AnLink 스타일의 Android 제어 데스크탑 앱 (Electron + scrcpy/adb 기반)
Windows / macOS / Linux 지원

## 기능
| 기능 | 백엔드 | 비고 |
|------|--------|------|
| 화면 미러링 | scrcpy | 별도 scrcpy 창에서 마우스/키보드 제어 |
| 화면 캡처 | adb screencap | PNG 저장 다이얼로그 |
| 화면 녹화 | adb screenrecord | MP4, 1회 최대 3분 (Android 제한) |
| APK 설치 | adb install | 드래그 앤 드롭 / 다중 선택 |
| 파일 전송 | adb push/pull | PC ↔ /sdcard |
| 클립보드 공유 | adb + Clipper | 폰에 Clipper 앱 필요 (아래 참고) |
| 기기 버튼 | adb input keyevent | 홈/뒤로/볼륨/전원 등 |

## 빠른 시작

### ⚡ 원클릭 자동 세팅 (권장)

**Windows**: 폴더 안의 **`Windows에서_시작.bat`** 을 더블클릭하세요.
Node 확인 → 패키지 설치 → adb/scrcpy 자동 다운로드(Windows_setup.ps1) → 기기 확인 → 앱 실행까지 한 번에 됩니다.

**macOS**: **`Mac_Linux에서_시작.command`** 을 더블클릭하세요.
처음엔 "확인되지 않은 개발자" 경고가 뜰 수 있는데, 그럴 땐 파일을 **우클릭 → 열기**를 누르면 됩니다.

**Linux**: 터미널에서
```bash
chmod +x Mac_Linux에서_시작.command   # 최초 1회
./Mac_Linux에서_시작.command
```
brew/apt로 adb·scrcpy까지 자동 설치 후 앱이 실행됩니다.

> 앱 실행 후에도 빠진 항목이 있으면 화면 상단에 노란 배너로 안내되고, 5초마다 자동으로 재확인합니다.

### 수동 설치

### 1. 의존성 설치
```bash
cd droidbridge
npm install
```

### 2. adb / scrcpy 바이너리 준비 (필수!)

`bin/` 폴더에 플랫폼별 바이너리를 넣어주세요:

**Windows**
1. https://dl.google.com/android/repository/platform-tools-latest-windows.zip → 압축 풀어 `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`을 `bin/`에 복사
2. https://github.com/Genymobile/scrcpy/releases 에서 `scrcpy-win64-*.zip` → `scrcpy.exe`와 `scrcpy-server` 파일을 `bin/`에 복사

**macOS**
```bash
brew install android-platform-tools scrcpy
# 심볼릭 링크로 연결
ln -s $(which adb) bin/adb
ln -s $(which scrcpy) bin/scrcpy
```

**Linux**
```bash
sudo apt install adb scrcpy
ln -s $(which adb) bin/adb
ln -s $(which scrcpy) bin/scrcpy
```

### 3. Android 기기 설정
1. 설정 → 휴대전화 정보 → **빌드 번호 7번 탭** → 개발자 모드 활성화
2. 설정 → 개발자 옵션 → **USB 디버깅** 켜기
3. USB 연결 후 폰에 뜨는 "USB 디버깅 허용" 팝업에서 **허용**

### 4. 실행
```bash
npm start        # 일반 실행
npm run dev      # 개발자 도구 포함
```

### 5. 배포용 빌드 (선택)
* **Windows**: `npm run build:win` 명령을 실행하거나 패키지 설정을 마친 설치 파일을 배포합니다.
* **macOS**: 터미널 명령을 쓸 필요 없이, 폴더 내의 **`Mac_설치파일_만들기.command`** 파일을 더블클릭(우클릭 -> 열기)하시면 자동으로 Node.js 등 필요 빌드 패키지 세팅 후 `dist/` 폴더에 `.dmg` 설치 파일이 최종 생성됩니다.
* **수동 명령 빌드**:
```bash
npm run build:win    # Windows .exe 설치 파일
npm run build:mac    # macOS .dmg (macOS 환경 필요)
npm run build:linux  # Linux AppImage
```
빌드 결과물은 `dist/` 폴더에 생성됩니다. `bin/`의 바이너리가 자동으로 패키지에 포함됩니다.

## Wi-Fi 연결 방법
1. 먼저 USB로 한 번 연결한 뒤 터미널에서: `adb tcpip 5555`
2. USB를 뽑고 앱에서 "Wi-Fi로 연결" → 폰의 IP 주소 입력
   (IP는 설정 → Wi-Fi → 연결된 네트워크에서 확인)

## 클립보드 공유 참고
Android 10+는 보안상 백그라운드 클립보드 접근을 차단합니다.
폰에 [Clipper](https://github.com/majido/clipper) 앱을 설치하면 양방향 공유가 가능하고,
없으면 "PC → Android" 방향은 scrcpy 미러링 창에서 Ctrl+V로 대신할 수 있습니다.

## macOS 설치 (배포본 받는 사람용)

터미널에 아래 한 줄을 붙여넣으면 받기·열기가 한 번에 됩니다. 열린 창에서 앱을 **응용 프로그램(Applications)** 폴더로 끌어다 놓으면 끝입니다.

```bash
curl -L -o ~/Downloads/DroidBridge.dmg <배포주소> && open ~/Downloads/DroidBridge.dmg
```

`<배포주소>` 는 사내 배포 담당자에게 받으세요. 버전이 올라갈 때마다 파일명이 바뀌므로 README 에 적어두지 않습니다.

> **아키텍처를 맞춰 받아야 합니다.** arm64(Apple Silicon)와 x64(Intel) dmg 가 따로 있고, 잘못 받으면 실행 시 Rosetta 설치 창이 뜹니다. 내 맥 확인: **Apple 메뉴 → 이 Mac에 관하여** 에서 "칩: Apple M…" 이면 arm64, "프로세서: Intel…" 이면 x64. 터미널로는 `uname -m` → `arm64` / `x86_64`.

**반드시 터미널(`curl`)로 받으세요.** 같은 주소라도 Safari·Chrome·Slack·메일로 받으면 macOS 가 파일에 quarantine 플래그를 붙여 게이트키퍼 경고가 뜹니다. `curl`·`scp`·USB·파일서버로 받으면 플래그가 붙지 않아 경고 없이 바로 실행됩니다. 플래그 확인은 `xattr -l ~/Downloads/DroidBridge.dmg` — `com.apple.quarantine` 이 없으면 정상입니다.

## 문제 해결
- **macOS: 게이트키퍼가 실행을 막을 때**:
  브라우저·Slack·메일로 받으면 quarantine 플래그가 붙어 차단됩니다. 파일이 손상된 것이 아닙니다. 애초에 위 **macOS 설치** 항목처럼 `curl` 로 받으면 이 문제가 생기지 않습니다.
  - *"Apple은 … 악성 코드가 없음을 확인할 수 없습니다"* — `npm run release:mac` 으로 만든 **서명 O / 공증 X** 빌드입니다. **"휴지통으로 이동"을 누르지 마세요.** "완료"를 누른 뒤 **시스템 설정 → 개인정보 보호 및 보안** 에서 아래로 스크롤해 **"그래도 열기"** 를 누릅니다. (macOS 15 부터는 우클릭 → 열기로는 통과되지 않습니다.)
  - *"손상되었기 때문에 열 수 없습니다"* — 서명이 아예 없거나 깨진 빌드입니다(`npm run build:mac`, CI 아티팩트). 이 경우 위 방법으로도 안 되고 아래가 필요합니다.
  - 어느 쪽이든 터미널 한 줄로 해결됩니다. 설치(응용 프로그램 폴더로 드래그) 후:
    ```bash
    xattr -cr /Applications/DroidBridge.app
    ```
  - 경고 자체를 없애려면 배포 담당자가 `npm run notarize:mac` 으로 공증된 빌드를 올려야 합니다.
- **기기가 안 보일 때**: `bin/adb devices`로 직접 확인. `unauthorized`면 폰에서 디버깅 허용 팝업 확인
- **scrcpy 창이 안 뜰 때**: `bin/scrcpy --serial <시리얼>`로 직접 실행해 오류 메시지 확인
- **Windows에서 adb.exe 실행 오류**: `AdbWinApi.dll` 두 개가 같은 폴더에 있는지 확인


## 프로젝트 구조
```
droidbridge/
├── package.json          # Electron 설정 + 빌드 구성
├── bin/                  # adb / scrcpy 바이너리 (직접 추가)
├── src/
│   ├── main.js           # 메인 프로세스: adb/scrcpy 실행, IPC 핸들러
│   └── preload.js        # 보안 IPC 브리지 (contextBridge)
└── public/
    ├── index.html        # UI 마크업
    ├── style.css         # 다크 테마 스타일
    └── renderer.js       # UI 로직 (window.db.* API 호출)
```
# zerosoft-mirroring
