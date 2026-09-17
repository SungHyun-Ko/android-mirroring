/**
 * ios-device.js — libimobiledevice CLI 래퍼 (iOS QA 지원)
 *
 * Android 쪽과 달리 화면·입력은 다루지 않는다. iOS 는 입력 주입 경로가
 * WebDriverAgent 밖에 없고(맥+Xcode 서명 필수), 화면은 AirPlay 수신기 창을
 * Electron 의 desktopCapturer 로 가져오는 방식이라 메인 프로세스가 할 일이 없다.
 * 여기서 맡는 것은 기기 탐색 / 정보 / 실시간 syslog 뿐이다.
 *
 * 필요한 외부 도구:
 *   macOS        : brew install libimobiledevice
 *   Windows      : Apple Devices 앱(또는 iTunes) — Apple Mobile Device Service 가
 *                  usbmuxd 역할을 한다. 그 위에서 idevice*.exe 가 동작한다.
 *
 * 순수 파싱 함수는 Electron 의존이 없어 단독 실행된다:
 *   node src/ios-device.js     ← 자가진단
 */
'use strict'

const { execFile, spawn } = require('child_process')

// ── syslog 한 줄 파싱 ────────────────────────────────────────────
//
// 실측 형식 (iOS 26.6, idevicesyslog):
//   Sep 17 16:53:38.200645 backboardd(CoreMotion)[70] <Debug>: CMDeviceMotion: ...
//
// 괄호 안 서브시스템은 없을 수도 있다. idevicesyslog 자신이 뱉는
// `[connected:UDID]` 같은 줄은 이 형식에 맞지 않아 null 이 된다.
const SYSLOG_RE =
  /^(\w{3}\s+\d+\s+[\d:.]+)\s+(\S+?)(?:\(([^)]*)\))?\[(\d+)\]\s+<(\w+)>:\s?([\s\S]*)$/

// iOS 레벨 → logcat 레벨 문자. 렌더러의 레벨 필터·색상을 그대로 재사용하려고 맞춘다.
// (logcat 은 V/D/I/W/E/F, iOS 는 Debug/Info/Notice/Default/Warning/Error/Fault)
const LEVEL_MAP = {
  Debug: 'D',
  Info: 'I', Notice: 'I', Default: 'I',
  Warning: 'W',
  Error: 'E',
  Fault: 'F', Critical: 'F',
}

function parseSyslogLine(line) {
  const m = SYSLOG_RE.exec(line)
  if (!m) return null
  const [, time, process, subsystem, pid, level, message] = m
  return {
    time,
    process,
    subsystem: subsystem || '',
    pid: Number(pid),
    level: LEVEL_MAP[level] || 'I',
    rawLevel: level,
    message,
  }
}

/**
 * syslog 줄을 logcat threadtime 형식으로 바꾼다.
 *
 * 렌더러의 LogCat 패널은 `LOGCAT_PARSE_RE` 하나로 모든 줄을 읽는다. iOS 전용
 * 파서를 렌더러에 또 심는 대신 여기서 형식을 맞춰 보내면 레벨 필터·태그 필터·
 * PID 필터·검색이 전부 그대로 동작한다.
 *
 * logcat: `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`
 */
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

function toLogcatLine(line) {
  const p = parseSyslogLine(line)
  if (!p) return null
  // 'Sep 17 16:53:38.200645' → '09-17 16:53:38.200'
  const [mon, day, clock] = p.time.split(/\s+/)
  const mm = MONTHS[mon] || '01'
  const dd = String(day).padStart(2, '0')
  const ms = clock.replace(/(\.\d{3})\d*$/, '$1')
  // TID 는 syslog 에 없다. PID 를 그대로 넣어 형식만 맞춘다.
  const tag = p.subsystem ? `${p.process}/${p.subsystem}` : p.process
  return `${mm}-${dd} ${ms} ${p.pid} ${p.pid} ${p.level} ${tag}: ${p.message}`
}

// ── 기기 목록 / 정보 ─────────────────────────────────────────────

// `idevice_id -l` 은 UDID 를 한 줄에 하나씩 뱉는다. 빈 줄과 안내문은 버린다.
function parseDeviceList(stdout) {
  return String(stdout || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => /^[0-9A-Fa-f-]{20,}$/.test(s))
}

// `idevicesyslog pidlist` 는 `<pid> <name>` 을 줄마다 뱉는다 (실측 566줄).
// 렌더러에서 프로세스를 골라 필터를 걸 수 있게 목록으로 만든다.
function parsePidList(stdout) {
  const out = []
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), name: m[2] })
  }
  return out
}

// `ideviceinfo` 는 `Key: value` 를 줄마다 뱉는다.
function parseInfo(stdout) {
  const out = {}
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/**
 * syslog 인자 조립. iOS syslog 는 Android logcat 과 물량이 다르다 — 실측으로
 * 필터 없이 초당 약 1,300줄, `--quiet`(시끄러운 시스템 프로세스 제외 내장 목록)로도
 * 초당 약 390줄이 나온다. 렌더러 보관 한도가 3,000줄이라 필터 없이는 몇 초 만에
 * 넘친다. 그래서 `--quiet` 는 기본으로 켜고, 프로세스 지정을 권한다.
 *
 * **`-p` 와 `-q` 는 같이 못 쓴다** — `idevicesyslog` 가
 * `ERROR: -p and -e/-q cannot be used together.` 로 거부한다(실측). `-q` 는 제외
 * 필터, `-p` 는 포함 필터라 상호배타적이다. 프로세스를 지정하면 그게 이미 가장
 * 좁은 필터이므로 `-q` 를 떼는 것이 맞다.
 */
function syslogArgs(udid, { process: proc, quiet = true } = {}) {
  const args = ['-u', udid]
  if (proc) args.push('-p', proc)   // 여러 개는 "a|b" 로 넘긴다
  else if (quiet) args.push('-q')
  return args
}

module.exports = {
  SYSLOG_RE, LEVEL_MAP,
  parseSyslogLine, toLogcatLine, parseDeviceList, parseInfo, parsePidList, syslogArgs,
  create,
}

/**
 * 실행부. 바이너리 경로 탐색은 호출부(main.js 의 resolveBin)에 맡긴다 —
 * macOS GUI 실행 시 $PATH 가 비는 문제를 그쪽이 이미 처리하고 있다.
 */
function create({ resolveBin, onLog }) {
  const log = msg => onLog?.('[ios] ' + msg)
  let syslogProc = null

  const bin = name => {
    const p = resolveBin(process.platform === 'win32' ? name + '.exe' : name)
    if (!p) throw new Error(`${name} 을 찾을 수 없습니다. ${process.platform === 'win32'
      ? 'Apple Devices 앱(또는 iTunes)을 설치해 주세요.'
      : 'brew install libimobiledevice 로 설치해 주세요.'}`)
    return p
  }

  const run = (name, args, ms = 10000) => new Promise((res, rej) => {
    let path
    try { path = bin(name) } catch (e) { return rej(e) }
    execFile(path, args, { timeout: ms }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message).trim()))
      else res(stdout)
    })
  })

  return {
    // 연결된 iOS 기기 목록. 실패해도 예외를 던지지 않는다 (코드베이스 규약).
    async devices() {
      try {
        const udids = parseDeviceList(await run('idevice_id', ['-l']))
        const list = []
        for (const udid of udids) {
          let name = udid, model = '', version = ''
          try {
            const info = parseInfo(await run('ideviceinfo', ['-u', udid]))
            name = info.DeviceName || udid
            model = info.ProductType || ''
            version = info.ProductVersion || ''
          } catch { /* 잠김·미신뢰 상태면 정보 조회가 막힌다 — UDID 만이라도 보여준다 */ }
          list.push({ udid, name, model, version })
        }
        return { ok: true, devices: list }
      } catch (e) {
        return { ok: false, message: e.message, devices: [] }
      }
    },

    async info(udid) {
      try {
        return { ok: true, info: parseInfo(await run('ideviceinfo', ['-u', udid])) }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    },

    // 기기에서 돌고 있는 프로세스 목록. syslog 필터를 고르는 데 쓴다.
    async processes(udid) {
      try {
        return { ok: true, processes: parsePidList(await run('idevicesyslog', ['-u', udid, 'pidlist'])) }
      } catch (e) {
        return { ok: false, message: e.message, processes: [] }
      }
    },

    // syslog 를 logcat 형식으로 바꿔 흘린다 (렌더러 LogCat 패널 재사용).
    startSyslog(udid, opts, onData, onStop) {
      this.stopSyslog()
      let path
      try { path = bin('idevicesyslog') } catch (e) { return { ok: false, message: e.message } }

      const proc = spawn(path, syslogArgs(udid, opts))
      syslogProc = proc
      let pending = ''   // 청크가 줄 중간에서 끊긴다 — logcat 쪽과 같은 문제다

      const feed = chunk => {
        pending += chunk.toString()
        const lines = pending.split('\n')
        pending = lines.pop()
        const out = lines.map(l => toLogcatLine(l) ?? l).join('\n')
        if (out) onData(out + '\n')
      }
      proc.stdout.on('data', feed)
      proc.stderr.on('data', feed)
      // 핸들러가 없으면 spawn 실패가 처리되지 않은 'error' 로 메인 프로세스를 죽인다
      proc.on('error', e => {
        onData(`[syslog 실행 실패] ${e.message}\n`)
        if (syslogProc === proc) syslogProc = null
        onStop?.()
      })
      proc.on('close', () => {
        if (syslogProc === proc) syslogProc = null
        onStop?.()
      })
      log(`syslog 시작 (${udid})`)
      return { ok: true }
    },

    stopSyslog() {
      if (syslogProc) { syslogProc.kill(); syslogProc = null }
      return { ok: true }
    },
  }
}

// ── 자가진단: node src/ios-device.js ─────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // 실측 줄 (iOS 26.6) — 서브시스템 있음
  const l1 = 'Sep 17 16:53:38.200645 backboardd(CoreMotion)[70] <Debug>: CMDeviceMotion: x'
  const p1 = parseSyslogLine(l1)
  assert.strictEqual(p1.process, 'backboardd')
  assert.strictEqual(p1.subsystem, 'CoreMotion')
  assert.strictEqual(p1.pid, 70)
  assert.strictEqual(p1.level, 'D')
  assert.strictEqual(p1.message, 'CMDeviceMotion: x')

  // 서브시스템 없는 줄도 받아야 한다
  const p2 = parseSyslogLine('Sep 17 16:53:38.200645 SpringBoard[120] <Error>: boom')
  assert.strictEqual(p2.subsystem, '')
  assert.strictEqual(p2.level, 'E')
  assert.strictEqual(p2.message, 'boom')

  // 레벨 매핑 — logcat 문자로 접혀야 렌더러 필터가 그대로 먹는다
  const lv = s => parseSyslogLine(`Sep 1 00:00:00.000000 p[1] <${s}>: m`).level
  assert.strictEqual(lv('Notice'), 'I')
  assert.strictEqual(lv('Default'), 'I')
  assert.strictEqual(lv('Warning'), 'W')
  assert.strictEqual(lv('Fault'), 'F')
  assert.strictEqual(lv('Bogus'), 'I', '모르는 레벨은 I 로 떨어뜨린다')

  // idevicesyslog 자신의 안내 줄은 형식이 달라 null
  assert.strictEqual(parseSyslogLine('[connected:00008150-0006636C1E33401C]'), null)
  assert.strictEqual(parseSyslogLine(''), null)

  // logcat 형식 변환 — 렌더러의 LOGCAT_PARSE_RE 가 읽을 수 있어야 한다
  const conv = toLogcatLine(l1)
  assert.strictEqual(conv, '09-17 16:53:38.200 70 70 D backboardd/CoreMotion: CMDeviceMotion: x')
  const LOGCAT_PARSE_RE = /^\d{2}-\d{2} [\d:.]+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?):\s?([\s\S]*)$/
  const m = LOGCAT_PARSE_RE.exec(conv)
  assert.ok(m, '변환한 줄을 렌더러 파서가 읽지 못한다: ' + conv)
  assert.strictEqual(m[1], '70')
  assert.strictEqual(m[3], 'D')
  assert.strictEqual(m[4], 'backboardd/CoreMotion')
  assert.strictEqual(m[5], 'CMDeviceMotion: x')

  // 마이크로초는 밀리초로 잘라야 logcat 형식에 맞는다
  assert.ok(toLogcatLine('Jan 5 01:02:03.456789 p[9] <Info>: m').startsWith('01-05 01:02:03.456 '))
  // 한 자리 일자는 0 을 채운다
  assert.ok(toLogcatLine('Jan 5 01:02:03.456789 p[9] <Info>: m').startsWith('01-05'))
  // 형식에 안 맞는 줄은 null → 호출부가 원문을 그대로 흘린다
  assert.strictEqual(toLogcatLine('[connected:X]'), null)

  // 기기 목록: UDID 만 골라낸다
  assert.deepStrictEqual(
    parseDeviceList('00008150-0006636C1E33401C\n\n'),
    ['00008150-0006636C1E33401C'])
  // 구형 40자 UDID 도 받아야 한다
  assert.deepStrictEqual(parseDeviceList('a'.repeat(40)), ['a'.repeat(40)])
  // 안내문·빈 출력은 버린다
  assert.deepStrictEqual(parseDeviceList('No device found.'), [])
  assert.deepStrictEqual(parseDeviceList(''), [])

  // ideviceinfo 파싱 — 값에 콜론이 있어도 첫 콜론만 기준으로 쪼갠다
  const info = parseInfo('DeviceName: 내 아이폰\nProductVersion: 26.6\nWiFiAddress: aa:bb:cc\n')
  assert.strictEqual(info.DeviceName, '내 아이폰')
  assert.strictEqual(info.ProductVersion, '26.6')
  assert.strictEqual(info.WiFiAddress, 'aa:bb:cc')

  // pidlist — `<pid> <name>`. 이름에 공백이 있을 수 있으니 뒤쪽을 통째로 받는다
  assert.deepStrictEqual(
    parsePidList('1 launchd\n 35 SpringBoard\n\n허튼 줄\n'),
    [{ pid: 1, name: 'launchd' }, { pid: 35, name: 'SpringBoard' }])

  // syslog 인자: --quiet 가 기본이어야 한다 (필터 없이는 초당 1,300줄)
  assert.deepStrictEqual(syslogArgs('U'), ['-u', 'U', '-q'])
  assert.deepStrictEqual(syslogArgs('U', { quiet: false }), ['-u', 'U'])
  // -p 와 -q 를 같이 넘기면 idevicesyslog 가 거부한다. -p 가 있으면 -q 를 빼야 한다
  assert.deepStrictEqual(syslogArgs('U', { process: 'MyApp' }), ['-u', 'U', '-p', 'MyApp'])
  assert.deepStrictEqual(
    syslogArgs('U', { process: 'A|B', quiet: false }), ['-u', 'U', '-p', 'A|B'])
  assert.ok(!syslogArgs('U', { process: 'X' }).includes('-q'), '-p 와 -q 동시 사용 금지')

  console.log('ios-device 자가진단 통과 — syslog 파싱/logcat 변환/기기목록/프로세스/인자')
}
