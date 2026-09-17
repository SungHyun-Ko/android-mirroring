/**
 * hid-keyboard.js — UHID 물리 키보드용 순수 로직
 *
 * 브라우저의 KeyboardEvent.code(물리 키 위치)를 HID usage code 로 옮기고
 * 8바이트 부트 키보드 리포트를 만든다. 소켓·Electron·adb 의존이 없어 단독 실행된다:
 *
 *   node src/hid-keyboard.js     ← 자가진단
 *
 * e.key(문자)가 아니라 e.code(위치)를 쓰므로 PC 쪽 키보드 레이아웃이나 IME 상태와
 * 무관하게 동작한다. 문자 조합은 단말의 IME 가 한다.
 */
'use strict'

// 리포트 byte 0 의 모디파이어 비트필드
const MODIFIER_BITS = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
}

// HID Keyboard/Keypad usage page (0x07)
const CODE_TO_USAGE = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
  NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
  Numpad0: 0x62, NumpadDecimal: 0x63,
  ContextMenu: 0x65,

  // 한/영·한자. 기본 디스크립터 범위(0x65) 밖이라 EXTENDED_MAX_USAGE 로 만든
  // 디스크립터에서만 유효하다. 브라우저/OS 마다 code 이름이 갈려 별칭을 함께 둔다.
  Lang1: 0x90, Lang2: 0x91,
  HangulMode: 0x90, HanjaMode: 0x91,
  NonConvert: 0x90, Convert: 0x91,
}

for (let i = 0; i < 26; i++) CODE_TO_USAGE['Key' + String.fromCharCode(65 + i)] = 0x04 + i
for (let i = 1; i <= 9; i++) CODE_TO_USAGE['Digit' + i] = 0x1e + (i - 1)
CODE_TO_USAGE.Digit0 = 0x27
for (let i = 1; i <= 12; i++) CODE_TO_USAGE['F' + i] = 0x3a + (i - 1)
for (let i = 1; i <= 9; i++) CODE_TO_USAGE['Numpad' + i] = 0x59 + (i - 1)

const REPORT_SIZE = 8
const MAX_KEYS = 6            // 부트 키보드 동시 입력 슬롯
const ERROR_ROLL_OVER = 0x01  // 슬롯 초과 시 USB HID 규격상 채워 넣는 값

const STOCK_MAX_USAGE = 0x65     // scrcpy v4.1 기본값 — 한/영(0x90) 이 범위 밖
const EXTENDED_MAX_USAGE = 0x91  // Lang1/Lang2 를 포함하도록 넓힌 값

/**
 * HID 리포트 디스크립터를 만든다.
 *
 * Logical Maximum(0x25)은 부호 있는 1바이트라 127 을 넘기면 음수로 읽힌다.
 * 0x91(145)을 쓰려면 2바이트 형식(0x26 lo hi)이 필요하다. 이걸 놓치면 디스크립터가
 * 조용히 망가진다.
 */
function buildReportDesc(maxUsage = EXTENDED_MAX_USAGE) {
  const logicalMax = maxUsage > 0x7f
    ? [0x26, maxUsage & 0xff, (maxUsage >> 8) & 0xff]  // 2바이트
    : [0x25, maxUsage]                                  // 1바이트

  return Buffer.from([
    0x05, 0x01,             // Usage Page (Generic Desktop)
    0x09, 0x06,             // Usage (Keyboard)
    0xa1, 0x01,             // Collection (Application)
    0x05, 0x07,             //   Usage Page (Keyboard/Keypad)
    0x19, 0xe0,             //   Usage Minimum (LeftControl)
    0x29, 0xe7,             //   Usage Maximum (RightGUI)
    0x15, 0x00,             //   Logical Minimum (0)
    0x25, 0x01,             //   Logical Maximum (1)
    0x75, 0x01,             //   Report Size (1)
    0x95, 0x08,             //   Report Count (8)
    0x81, 0x02,             //   Input (Data,Var,Abs)   — byte 0 모디파이어
    0x75, 0x08,             //   Report Size (8)
    0x95, 0x01,             //   Report Count (1)
    0x81, 0x01,             //   Input (Cnst)           — byte 1 예약
    0x05, 0x08,             //   Usage Page (LED)
    0x19, 0x01,             //   Usage Minimum (NumLock)
    0x29, 0x05,             //   Usage Maximum (Kana)
    0x75, 0x01,             //   Report Size (1)
    0x95, 0x05,             //   Report Count (5)
    0x91, 0x02,             //   Output (Data,Var,Abs)
    0x75, 0x03,             //   Report Size (3)
    0x95, 0x01,             //   Report Count (1)
    0x91, 0x01,             //   Output (Cnst)
    0x05, 0x07,             //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,             //   Usage Minimum (0)
    0x29, maxUsage,         //   Usage Maximum (부호 없음 — 1바이트로 충분)
    0x15, 0x00,             //   Logical Minimum (0)
    ...logicalMax,          //   Logical Maximum
    0x75, 0x08,             //   Report Size (8)
    0x95, MAX_KEYS,         //   Report Count (6)
    0x81, 0x00,             //   Input (Data,Ary)       — byte 2..7 키 슬롯
    0xc0,                   // End Collection
  ])
}

/**
 * 현재 눌려 있는 KeyboardEvent.code 집합 → 8바이트 리포트.
 * 매핑에 없는 code 는 조용히 버린다 (모르는 키를 보내면 단말이 거부한다).
 */
function buildReport(pressedCodes) {
  const buf = Buffer.alloc(REPORT_SIZE)
  const keys = []
  let modifiers = 0

  for (const code of pressedCodes) {
    const bit = MODIFIER_BITS[code]
    if (bit) { modifiers |= bit; continue }
    const usage = CODE_TO_USAGE[code]
    if (usage !== undefined) keys.push(usage)
  }

  buf[0] = modifiers
  if (keys.length > MAX_KEYS) buf.fill(ERROR_ROLL_OVER, 2, 2 + MAX_KEYS)
  else keys.forEach((usage, i) => { buf[2 + i] = usage })
  return buf
}

module.exports = {
  MODIFIER_BITS, CODE_TO_USAGE,
  REPORT_SIZE, MAX_KEYS, ERROR_ROLL_OVER,
  STOCK_MAX_USAGE, EXTENDED_MAX_USAGE,
  buildReportDesc, buildReport,
}

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')
  const hex = b => Buffer.from(b).toString('hex')

  // 매핑: 경계값이 USB HID 표에 맞는지
  assert.strictEqual(CODE_TO_USAGE.KeyA, 0x04)
  assert.strictEqual(CODE_TO_USAGE.KeyZ, 0x1d)
  assert.strictEqual(CODE_TO_USAGE.Digit1, 0x1e)
  assert.strictEqual(CODE_TO_USAGE.Digit9, 0x26)
  assert.strictEqual(CODE_TO_USAGE.Digit0, 0x27)
  assert.strictEqual(CODE_TO_USAGE.F1, 0x3a)
  assert.strictEqual(CODE_TO_USAGE.F12, 0x45)
  assert.strictEqual(CODE_TO_USAGE.Numpad1, 0x59)
  assert.strictEqual(CODE_TO_USAGE.Numpad9, 0x61)
  assert.strictEqual(CODE_TO_USAGE.Lang1, 0x90)

  // 리포트: 빈 상태 / 단일 키 / 모디파이어 조합
  // 레이아웃은 [모디파이어][예약][키6슬롯] — 키는 byte 2 부터다
  assert.strictEqual(hex(buildReport([])), '0000000000000000')
  assert.strictEqual(hex(buildReport(['KeyA'])), '0000040000000000')
  assert.strictEqual(hex(buildReport(['ShiftLeft', 'KeyA'])), '0200040000000000')
  assert.strictEqual(hex(buildReport(['ControlLeft', 'ShiftLeft'])), '0300000000000000')
  assert.strictEqual(hex(buildReport(['Lang1'])), '0000900000000000')

  // 모르는 code 는 버린다
  assert.strictEqual(hex(buildReport(['Bogus', 'KeyA'])), '0000040000000000')

  // 6키까지는 슬롯에 담고, 7키부터는 전부 ErrorRollOver
  const six = ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF']
  assert.strictEqual(hex(buildReport(six)), '0000040506070809')
  assert.strictEqual(hex(buildReport([...six, 'KeyG'])), '0000010101010101')

  // 모디파이어는 슬롯을 먹지 않는다
  assert.strictEqual(hex(buildReport([...six, 'ShiftLeft'])), '0200040506070809')

  // 디스크립터: 0x7f 초과 시 Logical Maximum 이 2바이트로 바뀌어야 한다.
  // 1바이트(0x25)로 두면 0x91 이 -111 로 읽혀 디스크립터가 망가진다.
  const stock = buildReportDesc(STOCK_MAX_USAGE)
  const ext = buildReportDesc(EXTENDED_MAX_USAGE)
  assert.ok(stock.includes(Buffer.from([0x25, 0x65])), '기본: 1바이트 Logical Max')
  assert.ok(ext.includes(Buffer.from([0x26, 0x91, 0x00])), '확장: 2바이트 Logical Max')
  assert.ok(!ext.includes(Buffer.from([0x25, 0x91])), '확장: 1바이트 Logical Max 가 남으면 안 됨')
  assert.strictEqual(ext.length, stock.length + 1, '확장본은 1바이트만 길어야 한다')
  assert.strictEqual(stock[stock.length - 1], 0xc0, 'End Collection 으로 끝나야 한다')
  assert.strictEqual(ext[ext.length - 1], 0xc0)

  // 한/영 키는 확장 디스크립터의 사거리 안에 있어야 의미가 있다
  assert.ok(CODE_TO_USAGE.Lang1 <= EXTENDED_MAX_USAGE)
  assert.ok(CODE_TO_USAGE.Lang1 > STOCK_MAX_USAGE, '기본 디스크립터로는 한/영 전송 불가')

  console.log('hid-keyboard 자가진단 통과')
  console.log(`  기본 디스크립터 ${stock.length}B (maxUsage=0x${STOCK_MAX_USAGE.toString(16)})`)
  console.log(`  확장 디스크립터 ${ext.length}B (maxUsage=0x${EXTENDED_MAX_USAGE.toString(16)})`)
}
