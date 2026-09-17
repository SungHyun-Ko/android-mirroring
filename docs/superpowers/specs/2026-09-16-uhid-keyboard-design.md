# UHID 물리 키보드 입력 — 설계

- 작성일: 2026-09-16
- 대상: DroidBridge (`android-mirroring`)
- 상태: 설계 확정 대기

## 1. 배경

미러링 화면에서 타이핑한 글자를 단말로 보낼 때, 현재는 **클립보드를 경유**한다.
[`mirror-bridge.js`](../../../src/mirror-bridge.js)의 `injectText()` 가 scrcpy 제어 메시지
`TYPE_SET_CLIPBOARD(9)` 를 `paste: true` 로 보내 단말 클립보드에 쓰고 곧바로 붙여넣는다.

scrcpy 기본 텍스트 주입(`TYPE_INJECT_TEXT`)이 ASCII만 지원해 한글을 넣지 못하기 때문에
택한 우회로이고, **기능적으로는 지금도 정상 동작한다.** Android 16 / SM-S926N 실측에서
키코드·ASCII·한글 주입이 모두 성공했고 `Device clipboard set` 외 예외는 없었다.

문제는 부작용이다.

1. **글자를 칠 때마다 단말 클립보드가 덮어써진다.** Android 13+ 는 클립보드 쓰기마다
   "복사되었습니다" 안내를 띄우므로, 타이핑 내내 토스트가 반복된다. 이것이 이번 작업의
   직접적인 발단이다.
2. **비밀번호 입력란·보안 필드는 붙여넣기를 거부**하므로 입력 자체가 불가능하다.
3. 조합 중 레이스 컨디션을 피하려고 렌더러에 60ms 디바운스 + 공통 접두사 diff +
   백스페이스 재전송이라는 취약한 로직([`renderer.js`](../../../public/renderer.js)의
   `syncText()`)이 얹혀 있다.

## 2. 목표 / 비목표

**목표**

- 타이핑이 클립보드를 경유하지 않고 단말에 전달된다. 토스트가 사라진다.
- 한글을 포함한 모든 문자를 입력할 수 있다.
- 비밀번호 필드에도 입력된다.
- UHID를 쓸 수 없는 기기에서는 기존 클립보드 방식으로 **자동 폴백**한다.

**비목표**

- 마우스 UHID 전환 (현행 `TYPE_INJECT_TOUCH_EVENT` 로 충분, 건드리지 않는다)
- 클립보드 탭 기능(`clipboardSend` / `clipboardGet`) 변경
- 게임 패드·멀티 디스플레이 등 scrcpy의 여타 UHID 용도

## 3. 접근

UHID(`/dev/uhid`)로 **물리 HID 키보드를 흉내** 낸다. Android API 주입 경로를 타지 않으므로
클립보드를 건드리지 않고, 한글 조합은 단말의 IME가 담당한다. 실제 USB 키보드를 꽂았을 때와
동일한 동작이다.

결과적으로 **PC는 스캔코드만 보내고 문자 조합은 단말이 한다.** 사용자는 Windows 한글 IME를
끄고 영문 상태로 타이핑하며, 단말의 삼성/구글 키보드가 `ㅎ+ㅏ+ㄴ` → `한` 을 만든다.

## 4. 구성

### 4.1 신규 `src/hid-keyboard.js`

순수 함수만 둔다. 소켓·Electron·adb 의존 없음 → 단독 실행 자가진단이 가능하다.

| 내보내기 | 역할 |
|---|---|
| `REPORT_DESC` | HID 리포트 디스크립터 바이트 배열 |
| `CODE_TO_USAGE` | `KeyboardEvent.code` → HID usage code 매핑 |
| `MODIFIER_BITS` | `ControlLeft` 등 → 모디파이어 비트 |
| `buildReport(pressedCodes)` | 8바이트 리포트 `Buffer` 생성 |

리포트 형식(8바이트):

```
byte 0   모디파이어 비트필드
         LCtrl 0x01 LShift 0x02 LAlt 0x04 LGui 0x08
         RCtrl 0x10 RShift 0x20 RAlt 0x40 RGui 0x80
byte 1   예약 (항상 0x00)
byte 2-7 동시 입력 키 6슬롯 (HID usage code, 빈 슬롯은 0x00)
```

6키를 초과하면 USB HID 규격대로 6슬롯을 전부 `0x01`(ErrorRollOver)로 채운다.

### 4.2 `src/mirror-bridge.js` 변경

제어 메시지 3종을 추가한다. 바이트 레이아웃은 **scrcpy v4.1 태그 소스에서 확인**했다
(`app/src/control_msg.c`).

```
UHID_CREATE  (12)  type(1) id(2BE) vendorId(2BE) productId(2BE)
                   nameLen(1) name(nameLen) descSize(2BE) desc(descSize)
UHID_INPUT   (13)  type(1) id(2BE) size(2BE) data(size)
UHID_DESTROY (14)  type(1) id(2BE)
```

추가 메서드: `uhidCreate()`, `uhidInput(report)`, `uhidDestroy()`.
`injectText()`(클립보드)는 **삭제하지 않고 폴백으로 남긴다.**

`id` 는 `1`, `vendor_id` 는 `0x1209`(오픈소스 프로젝트용 공용 VID), `product_id` 는
`0xDB01`, 이름은 `DroidBridge Keyboard` 로 **고정한다.** Android 는 이 식별자를 키로
물리 키보드 레이아웃 설정을 저장하므로, 값이 바뀌면 사용자가 매번 레이아웃을 다시 잡아야
한다. 임의로 바꾸지 말 것.

### 4.3 `public/renderer.js` 변경

`setupCanvasEvents()` 의 키보드 핸들러를 모드별로 분기한다.

UHID 모드에서는 숨은 `textarea`, 60ms 디바운스, 공통 접두사 diff, 백스페이스 재전송이
**전부 불필요해진다.** 조합을 단말이 하므로 `keydown`/`keyup`에서 `e.code`로 눌린 키 집합을
갱신해 리포트를 보내면 끝이다. 클립보드 모드에서는 기존 로직을 그대로 쓴다.

WS 메시지 타입 `hid` 를 추가한다. `preload.js` 는 변경 없다 — 미러링 WS 로 직접 나가는
경로라 IPC 를 거치지 않는다.

## 5. 모드 판정과 폴백

1. 미러링 시작 시 `adb shell ls -l /dev/uhid` 로 노드 존재·권한을 확인한다.
   없으면 `clipboard` 모드로 확정한다.
2. 있으면 `uhid` 모드로 `UHID_CREATE` 를 보낸다.
3. 이후 scrcpy-server 로그에 UHID 실패가 찍히면 런타임에 `clipboard` 로 되돌린다.
   로그 수집은 `onLog` 로 이미 되어 있어 배선 추가가 없다.

확정된 모드는 렌더러에 `meta` 메시지로 실어 보내고, 로그 패널에 어느 방식인지 남긴다.
사용자가 고르는 설정은 두지 않는다.

UHID 는 API 레벨이 아니라 `/dev/uhid` 에 대한 SELinux 정책에 달려 있다. AOSP 기준
Android 11~12 무렵 shell 도메인 접근이 열렸으므로 그 이전 기기와 일부 커스텀 ROM 이
폴백 대상이다.

## 6. 한/영 전환 — 해결됨 (2026-09-16 실측)

**결론: A안(디스크립터 확장) 채택. 다만 진짜 걸림돌은 디스크립터가 아니라 포커스 대상이었다.**

Android 16 / SM-S926N 실측 결과:

- 확장 디스크립터(64B, Usage Max `0x91`)를 단말이 정상 수락했다
  (`dumpsys input` 에 `DroidBridge Keyboard` 등록 확인). B안은 불필요.
- `Lang1`(0x90) 전송 시 단말 IME 가 한/영 전환된다. 누를 때마다 매번 전환됨을 확인.

구현 중 드러난 함정 세 가지를 기록해 둔다. 모두 디스크립터와 무관하며, 앞의 둘은
**틀린 원인을 고치게 만든** 것들이다.

1. **Logical Maximum 은 부호 있는 1바이트다.** `0x25 0x91` 로 쓰면 145 가 -111 로
   읽혀 디스크립터가 조용히 망가진다. 127 을 넘기면 2바이트 형식(`0x26 lo hi`)이
   필요하다. `hid-keyboard.js` 자가진단이 이걸 검사한다.
2. **동일한 리포트를 다시 보내면 새 입력으로 치지 않는다.** HID 에서 같은 리포트는
   "계속 눌림"이다. 토글 키는 반드시 down/up 두 리포트를 따로 보내야 한다.
3. **포커스 대상이 키 이벤트의 내용을 바꾼다.** 이것이 실제 원인이었다.

   | 포커스 대상 | 한/영 키가 오는 형태 |
   |---|---|
   | 편집 불가 요소(canvas) | `code=AltRight` `key=HangulMode` `keyCode=21` |
   | `<textarea>` | `code=AltRight` `key=Process` `keyCode=229` |

   편집 요소에 포커스가 있으면 Windows 한글 IME 가 키를 먼저 삼켜 `key` 와 `keyCode`
   가 모두 뭉개진다. 어떤 매핑을 해도 식별이 불가능해진다. 그래서 UHID 모드에서는
   `<textarea>` 대신 `tabindex` 를 준 캔버스로 포커스를 돌린다. 부수 효과로 **PC 한글
   IME 를 꺼야 한다는 제약이 사라졌다** — 캔버스에는 IME 가 붙지 않는다.

   참고로 `code` 는 어느 쪽이든 `AltRight` 다. 한국어 키보드에는 별도의 오른쪽 Alt 가
   없고 그 자리가 곧 한/영 키이기 때문이다. `code` 만 보면 모디파이어로 오인한다.

한/영은 **토글**이라 현재 상태를 앱이 알 수 없다. 실제 물리 키보드와 같은 동작이므로
눌러보고 화면으로 확인하는 수밖에 없다.

---

### (원래 기록) 착수 전 미해결 리스크

아래는 실측 전에 세워둔 계획이다. 결과는 위 절에 있다.

scrcpy v4.1 의 기본 리포트 디스크립터는 키 Usage 범위가 `0x00`–`0x65`(101)로 잘려 있다:

```
0x19, 0x00,   Usage Minimum (0)
0x29, 0x65,   Usage Maximum (101)   ← SC_HID_KEYBOARD_KEYS - 1
```

한/영 키 `Lang1` 은 **0x90(144)**, 한자 키 `Lang2` 는 **0x91(145)** 로 이 범위 밖이다.
즉 scrcpy 기본 디스크립터로는 한/영 키를 보낼 수 없다.

대응 두 가지를 순서대로 시도한다.

- **A안 — 디스크립터 확장.** 우리는 scrcpy 클라이언트가 아니라 디스크립터를 직접 만들어
  `UHID_CREATE` 로 보내므로, Usage/Logical Maximum 을 `0x91` 로 늘려 `Lang1`/`Lang2` 를
  사거리에 넣을 수 있다. Report Size 8비트로 145까지 충분하다.
  Android HID 파서가 확장 디스크립터를 받아주는지는 실측이 필요하다.
- **B안 — Shift+Space.** 디스크립터를 건드리지 않는다. 삼성 키보드는 물리 키보드에서
  Shift+Space 로 한/영을 전환하며, 두 키 모두 기본 범위 안에 있다.

A안이 되면 A안, 안 되면 B안으로 간다. 둘 다 실패하면 UHID 모드에서 한글 입력이 막히므로
**폴백 조건에 "한/영 전환 불가"를 추가하고 클립보드 모드로 되돌린다.**

부수적으로, Windows 한글 IME 가 켜져 있으면 브라우저가 조합 이벤트를 만들어 `keydown` 을
가로챌 수 있다. UHID 모드에서는 PC IME 를 끄는 것을 전제로 하며, 조합 이벤트가 감지되면
로그로 안내한다.

## 7. 최초 1회 설정 UX

UHID 는 단말에 물리 키보드 레이아웃이 잡혀 있어야 정상 동작한다. 안내 없이 두면
사용자는 왜 한글이 안 되는지 알 수 없다.

scrcpy 제어 메시지 `OPEN_HARD_KEYBOARD_SETTINGS(15)` 로 설정 화면을 앱에서 바로 띄운다.
설정 탭에 버튼 하나를 두고, UHID 모드로 처음 붙었을 때 로그 패널에도 안내를 남긴다.

UHID 연결 중에는 단말의 **화면 키보드가 뜨지 않는다.** 물리 키보드가 꽂힌 것과 같은
상태이므로 정상 동작이며, 같은 설정 화면에서 사용자가 화면 키보드를 다시 켤 수 있다.

## 8. 검증

| 대상 | 방법 |
|---|---|
| `hid-keyboard.js` | `node src/hid-keyboard.js` — assert 기반 자가진단. 매핑 누락과 리포트 바이트 레이아웃을 검사한다. 프레임워크는 쓰지 않는다 (이 저장소에 테스트 러너가 없다) |
| 와이어 포맷 | `MirrorBridge` 를 직접 호출해 `UHID_CREATE` 전송 후 scrcpy-server 로그에 오류가 없는지 확인 |
| 실제 입력 | 단말에 텍스트 필드를 띄우고 영문·한글을 주입한 뒤 `adb shell screencap` 결과를 눈으로 판독 |
| 폴백 | `/dev/uhid` 탐지를 강제로 실패시켜 클립보드 모드로 떨어지는지 확인 |
| 회귀 | 클립보드 모드에서 기존 한글 입력이 그대로 동작하는지 확인 |

실기기 검증은 이번 조사에서 `ahello한글입력` 을 화면으로 확인한 절차를 그대로 쓴다.

## 9. 영향 범위

```
신규  src/hid-keyboard.js
수정  src/mirror-bridge.js   제어 메시지 3종, 모드 판정
수정  public/renderer.js     키보드 핸들러 분기
수정  public/index.html      설정 탭에 레이아웃 설정 버튼
무변경 src/preload.js, src/main.js
```

`injectText()` 와 `syncText()` 는 폴백 경로로 남으므로 삭제하지 않는다.
