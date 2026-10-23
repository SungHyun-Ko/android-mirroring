/**
 * device-hub.js — 여러 Android 기기를 붙여 두고 기기마다 LogCat 을 파일로 저장한다.
 *
 * 화면과 따로 메인 프로세스에서 돈다. 미러링과 실시간 LogCat 은 지금처럼 '고른 1대'만
 * 렌더러가 다루고, 여기는 연결된 **모든** 기기의 연결 유지와, 저장을 켠 기기의 저장을 맡는다
 * (새로 연결한 기기는 저장 꺼짐 — 카드의 ● 로 기기마다 켠다). 렌더러는 상태
 * 스냅샷(device:update)만 받아 바둑판을 그린다.
 *
 *   - 같은 폰이 USB 와 Wi-Fi 로 동시에 잡히면 ro.serialno 로 한 대로 합친다
 *   - 끊김은 연결 방식이 아니라 adb 목록의 상태로 판단한다 (offline → reconnect)
 *   - Wi-Fi 는 고정 주소(IP:5555)를 기억하고, 재부팅으로 포트가 풀린 폰이 USB 로 꽂히면
 *     tcpip 를 다시 건다
 *   - **adb kill-server 는 자동으로 쓰지 않는다** — 모든 기기 연결이 한꺼번에 끊긴다
 *
 * 설계와 근거: docs/MULTI-DEVICE-PLAN.md
 * 순수 함수와 상태 흐름은 Electron 없이 돈다: node src/device-hub.js  ← 자가진단
 */
'use strict'
const fs = require('fs')
const path = require('path')

// ── 순수 함수 ───────────────────────────────────────────────────

// Wi-Fi 기기의 시리얼은 IP:포트, mDNS 로 붙으면 adb-<시리얼>-xxxx._adb-tls-connect._tcp 다.
// 나머지는 USB 로 본다. (`adb devices -l` 의 usb: 항목은 Windows 에서 안 나올 수 있어 쓰지 않는다)
const WIFI_SERIAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/
const MDNS_SERIAL_RE = /\._adb-tls-connect\._tcp/
function transportOf(serial) {
  return WIFI_SERIAL_RE.test(serial) || MDNS_SERIAL_RE.test(serial) ? 'wifi' : 'usb'
}

// `adb devices -l` → [{ serial, state, model, transport }]. offline·unauthorized 도 남긴다 —
// 목록에서 사라진 것(케이블 뽑힘)과 목록에 있지만 꼬인 것(offline)은 처리가 다르다.
function parseDevices(out) {
  const list = []
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue
    const [serial, state0] = line.split(/\s+/)
    if (!serial || !state0) continue
    const state = /no permissions/.test(line) ? 'nopermission' : state0
    const model = ((line.match(/\bmodel:(\S+)/) || [])[1] || '').replace(/_/g, ' ')
    list.push({ serial, state, model, transport: transportOf(serial) })
  }
  return list
}

// adb connect 는 실패해도 종료 코드가 0 이고 결과를 표준 출력에 쓴다 (실측, adb 37).
// 문구는 OS 언어를 따른다 — Windows 한국어 실측:
//   "cannot connect to 127.0.0.1:5599: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (10061)"
// 그래서 문구가 아니라 소켓 오류 코드로 가른다. 10061 거부 / 10060 시간 초과 /
// 10065·10051 경로 없음 (10061 만 실측, 나머지는 Windows 소켓 오류 코드표 기준).
function connectResult(out) {
  const s = String(out || '')
  if (/\bconnected to\b/.test(s)) return { ok: true }   // "already connected to" 포함
  if (/\(10061\)|connection refused/i.test(s)) return { ok: false, kind: 'refused' }
  if (/\(10060\)|\(10065\)|\(10051\)|timed out|no route to host|unreachable/i.test(s)) {
    return { ok: false, kind: 'unreachable' }
  }
  return { ok: false, kind: 'other' }
}

function connectHint(kind, raw) {
  if (kind === 'refused') {
    return '폰의 Wi-Fi 디버깅 포트가 닫혀 있습니다 (재부팅하면 풀립니다). USB 로 한 번 꽂고 카드의 "Wi-Fi 로 전환"을 누르거나, 폰에서 무선 디버깅을 켜 주세요'
  }
  if (kind === 'unreachable') return '폰을 찾을 수 없습니다 — 같은 Wi-Fi 에 있는지, IP 가 맞는지 확인해 주세요'
  return String(raw || '연결 실패').trim()
}

const pad2 = n => String(n).padStart(2, '0')
const dayKeyOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// 파일을 나누는 단위. 하루 폴더 안에서 주기의 시작 시각을 파일 이름으로 쓴다.
//   60분 → 14-00.log, 30분 → 14-30.log, 하루(1440) → 00-00.log
function periodKey(d, intervalMin) {
  const mins = d.getHours() * 60 + d.getMinutes()
  const start = intervalMin >= 1440 ? 0 : Math.floor(mins / intervalMin) * intervalMin
  return { day: dayKeyOf(d), file: `${pad2(Math.floor(start / 60))}-${pad2(start % 60)}` }
}

// threadtime 줄 머리 "MM-DD HH:MM:SS.mmm". 연도가 없어서 지금 연도를 붙이고, 그게 미래로
// 하루 넘게 가 있으면(12월 로그를 1월에 받는 경우) 작년으로 본다.
const STAMP_RE = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})/
function lineStamp(line) {
  const m = STAMP_RE.exec(line)
  return m ? m[0] : null
}
function lineTime(line, now = new Date()) {
  const m = STAMP_RE.exec(line)
  if (!m) return null
  const d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +m[5], +m[6])
  if (d - now > 86400000) d.setFullYear(d.getFullYear() - 1)
  return d
}

// 기기 폴더 이름. Wi-Fi 시리얼(ip:port)이 아니라 ro.serialno 를 쓴다 — 포트가 바뀌어도 같은
// 폴더로 가야 하고, ':' 는 Windows 파일 이름에 못 쓴다.
function folderName(model, id) {
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return `${clean(model) || 'device'}_${clean(id) || 'unknown'}`
}

// 재연결 간격: 5초 → 10초 → 30초 → 1분에서 고정
const BACKOFF_MS = [5000, 10000, 30000, 60000]
const backoffMs = attempt => BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)]

// 렌더러의 ISSUE_PATTERNS 와 같은 기준이다 — 바둑판 배지와 화면 안 감지가 어긋나지 않게.
function issueOf(line) {
  if (/FATAL EXCEPTION/.test(line)) return 'crash'
  if (/\bANR in\b/.test(line)) return 'anr'
  return null
}

// 보관 기간이 지난 날짜 폴더 이름들. 0 이면 지우지 않는다.
function expiredDays(names, retentionDays, now = new Date()) {
  if (!retentionDays) return []
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays)
  const cut = dayKeyOf(cutoff)
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < cut)
}

// 로그를 받을 길. 지금 길이 살아 있으면 그대로 둔다 — USB 가 다시 꽂혔다고 Wi-Fi 에서 굳이
// 옮기지 않는다(오가며 흔들리지 않게). 넘어가야 할 때만 USB 를 먼저 고른다.
function pickActive(dev, current) {
  const ok = t => dev[t] && dev[t].state === 'device'
  if (current && ok(current)) return current
  if (ok('usb')) return 'usb'
  if (ok('wifi')) return 'wifi'
  return null
}

const FAIL_AFTER_MS = 10 * 60 * 1000

// 카드 상태. 순서가 우선순위다.
function statusOf(dev, now) {
  const slots = [dev.usb, dev.wifi].filter(Boolean)
  if (slots.some(s => s.state === 'device')) return 'online'
  if (slots.some(s => s.state === 'unauthorized')) return 'unauthorized'
  const failed = dev.badSince != null && now - dev.badSince > FAIL_AFTER_MS
  if (slots.length) return failed ? 'failed' : 'reconnecting'   // 목록엔 있는데 offline 등
  if (dev.remembered) {
    if (dev.wifiErr === 'refused') return 'port-closed'
    return failed ? 'failed' : 'reconnecting'
  }
  return 'unplugged'   // USB 로만 보이던 기기가 목록에서 사라짐 = 케이블 뽑힘
}

// offline 기기를 되살리는 순서. 시도할 때마다 한 칸씩 넘어간다.
//   ① PC 쪽에서 끊었다 붙이기 ② 기기 쪽에서 ③ offline·unauthorized 만 골라 전부
//   ④ (Wi-Fi) 끊고 다시 connect
// ③ 은 정상 기기를 건드리지 않는다는 것이 도움말 문구 기준이다 — 여러 대로 실측할 것.
function reconnectPlan(attempt, serial, remembered) {
  const wifi = transportOf(serial) === 'wifi'
  const step = attempt % (wifi ? 4 : 3)
  if (step === 0) return [['-s', serial, 'reconnect']]
  if (step === 1) return [['-s', serial, 'reconnect', 'device']]
  if (step === 2) return [['reconnect', 'offline']]
  const addr = remembered ? `${remembered.ip}:${remembered.port}` : serial
  return [['disconnect', serial], ['connect', addr]]
}

// `ip -f inet addr show wlan0` → "inet 192.168.0.12/24 ..." 의 주소
function parseWlanIp(out) {
  const m = /\binet (\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(out || ''))
  return m ? m[1] : null
}

const cleanProp = s => {
  const v = String(s || '').trim()
  return v && !/\s/.test(v) && v !== 'unknown' ? v : null
}

// ── 실행부 ──────────────────────────────────────────────────────

const POLL_MS = 3000
const PUSH_THROTTLE_MS = 1000
const CLEANUP_EVERY_MS = 60 * 60 * 1000
// 우리가 만든 기기 폴더 표시. 보관 기간 정리는 **이 파일이 있는 폴더 안만** 건드린다 —
// 사용자가 저장 위치를 문서 폴더처럼 다른 것이 섞인 곳으로 골라도 남의 폴더를 지우지 않게.
const MARKER = '.droidbridge'
const INTERVALS = [10, 30, 60, 1440]
const RETENTIONS = [0, 1, 3, 7, 14, 30]

/**
 * @param {object} o
 * @param {(args:string[]) => Promise<{code:number,out:string,err:string}>} o.exec  — 절대 reject 하지 않는다
 * @param {(args:string[]) => import('child_process').ChildProcess} o.spawnLogcat
 * @param {string} o.userDir       — 설정 파일(multi-device.json) 위치
 * @param {string} o.defaultLogDir — 저장 위치 기본값
 */
function create({ exec, spawnLogcat, userDir, defaultLogDir, onUpdate, onLog,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const log = m => onLog?.('[멀티] ' + m)
  const devices = new Map()     // id → 기기. 처음 본 순서대로 — 카드 순서가 흔들리지 않는다
  const serialToId = new Map()  // adb 시리얼 → ro.serialno
  // 모델명은 기기에서 직접 읽은 ro.product.model 만 믿는다. `adb devices -l` 의 model: 은 표기가
  // 다르다(SM_G973N → 'SM G973N' vs 'SM-G973N'). 폴더 이름에 들어가므로 둘이 섞이면 같은 폰의
  // 로그가 두 폴더로 갈리고 다시 켰을 때 이어 받기도 끊긴다 — 자가진단이 실제로 잡은 버그다.
  const modelOf = new Map()
  const pending = new Set()     // 진행 중인 재연결 (자가진단이 끝나기를 기다릴 때 쓴다)
  const cfgPath = path.join(userDir, 'multi-device.json')
  const cfg = loadCfg()
  let timer = null, ticking = false, lastCleanup = 0, pushTimer = null

  function loadCfg() {
    const def = {
      // autoNew: 기기마다 고른 적이 없을 때의 기본값. **기본은 꺼짐**(사용자 요청, 2026-10-23) —
      // 붙이는 기기마다 저장이 돌면 원치 않는 로그가 쌓인다. 카드의 ● 로 기기마다 켠다.
      recording: { autoNew: false, dir: defaultLogDir, intervalMin: 60, retentionDays: 7 },
      wifi: [],          // [{ id, model, ip, port }] — 기억해 둔 고정 주소
      deviceRec: {},     // { [id]: true|false } — 기기마다 켜고 끈 값. 다시 연결해도 유지된다
    }
    try {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const merged = { ...def, ...c, recording: { ...def.recording, ...(c.recording || {}) } }
      // 기본값을 '켬'으로 두던 때의 항목 — 지금은 쓰지 않는다
      delete merged.recording.enabled
      delete merged.recordingOff
      return merged
    } catch { return def }
  }
  function saveCfg() {
    try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)) } catch (e) { log('설정 저장 실패: ' + e.message) }
  }

  function devOf(id, model) {
    let d = devices.get(id)
    if (!d) {
      d = {
        id, model: model || id, usb: null, wifi: null, remembered: null, active: null,
        rec: null, recErr: null, recRetryAt: 0, recStartedAt: 0, lastStamp: null,
        bytesToday: 0, bytesDay: null, lastAt: null, crash: 0, anr: 0, countDay: null,
        badSince: null, attempts: 0, nextTryAt: 0, wifiErr: null, busy: false, tcpipTried: null,
        resumeFails: 0, noResume: false,
      }
      devices.set(id, d)
    }
    if (modelOf.has(id)) d.model = modelOf.get(id)
    else if (model && d.model === d.id) d.model = model
    return d
  }
  for (const w of cfg.wifi) devOf(w.id, w.model).remembered = { ip: w.ip, port: w.port }

  // 아직 ro.serialno 를 못 읽은 시리얼(offline·unauthorized)을 어느 기기로 볼지
  function guessId(e) {
    if (e.transport === 'wifi') {
      const w = cfg.wifi.find(w => `${w.ip}:${w.port}` === e.serial)
      if (w) return w.id
      const m = /^adb-(.+?)-[^.-]+\._adb-tls-connect/.exec(e.serial)
      if (m) return m[1]
    }
    return e.serial   // USB 시리얼은 보통 ro.serialno 와 같다
  }

  const todayKey = () => dayKeyOf(new Date(now()))
  const recordingOn = d => d.id in cfg.deviceRec ? cfg.deviceRec[d.id] : cfg.recording.autoNew
  const devDir = d => path.join(cfg.recording.dir, folderName(d.model, d.id))

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const entries = parseDevices((await exec(['devices', '-l'])).out)
      const present = new Set(entries.map(e => e.serial))
      // 사라진 시리얼은 잊는다 — DHCP 로 같은 IP 를 다른 폰이 받으면 엉뚱한 기기로 붙지 않게
      for (const s of [...serialToId.keys()]) if (!present.has(s)) serialToId.delete(s)

      // 처음 보는 '정상' 시리얼은 ro.serialno 로 기기를 알아낸다 — USB·Wi-Fi 를 합치는 열쇠
      for (const e of entries) {
        if (e.state !== 'device' || serialToId.has(e.serial)) continue
        const id = cleanProp((await exec(['-s', e.serial, 'shell', 'getprop', 'ro.serialno'])).out) || guessId(e)
        const model = String((await exec(['-s', e.serial, 'shell', 'getprop', 'ro.product.model'])).out || '').trim()
        serialToId.set(e.serial, id)
        if (model) modelOf.set(id, model)
        // 인증 전에 시리얼로 짐작해 만든 카드가 있으면 진짜 기기로 흡수한다
        const ghost = devices.get(e.serial)
        if (ghost && e.serial !== id && !ghost.remembered && !ghost.rec) devices.delete(e.serial)
      }

      const seen = new Set()
      for (const e of entries) {
        const d = devOf(serialToId.get(e.serial) || guessId(e), e.model)
        d[e.transport] = { serial: e.serial, state: e.state }
        seen.add(d.id + '|' + e.transport)
      }
      for (const d of devices.values()) {
        for (const t of ['usb', 'wifi']) if (d[t] && !seen.has(d.id + '|' + t)) d[t] = null
        step(d)
      }
      if (now() - lastCleanup > CLEANUP_EVERY_MS) { lastCleanup = now(); cleanup() }
    } catch (e) {
      log('기기 점검 실패: ' + (e.message || e))
    } finally {
      ticking = false
      push()
    }
  }

  function step(d) {
    const t = now()
    const st = statusOf(d, t)
    if (st === 'online') { d.badSince = null; d.attempts = 0; d.nextTryAt = 0 } else if (d.badSince == null) d.badSince = t
    if (!d.usb) d.tcpipTried = null   // 다시 꽂히면 한 번 더 시도할 수 있게

    // 저장 — 붙어 있고 켜져 있으면 돌리고, 아니면 내린다. 받던 길이 바뀌면 새 길로 다시 붙는다.
    d.active = st === 'online' ? pickActive(d, d.active) : null
    const want = d.active && recordingOn(d) ? d[d.active].serial : null
    if (d.rec && d.rec.serial !== want) stopRecorder(d)
    if (want && !d.rec && t >= d.recRetryAt) startRecorder(d, want)

    // 연결 복구. 온라인이어도 기억해 둔 Wi-Fi 가 안 붙어 있으면 다시 붙여 둔다 — 케이블을 뽑는
    // 순간 넘어갈 길을 미리 만들어 두는 것이다.
    const needWifi = d.remembered && !d.wifi
    if (!d.busy && t >= d.nextTryAt && st !== 'unauthorized' && (st !== 'online' || needWifi)) recover(d)
  }

  function recover(d) {
    d.busy = true
    const attempt = d.attempts++
    d.nextTryAt = now() + backoffMs(attempt)
    const p = (async () => {
      const stuck = [d.usb, d.wifi].find(s => s && s.state !== 'device' && s.state !== 'unauthorized')
      if (stuck) {
        // 미러링이 끊겼을 때 이 재연결 탓인지 가릴 수 있게 남긴다 (드물게만 일어난다)
        const plan = reconnectPlan(attempt, stuck.serial, d.remembered)
        log(`${d.model}: ${stuck.serial} 가 ${stuck.state} — 재연결 ${attempt + 1}회째 (adb ${plan.map(a => a.join(' ')).join(' → ')})`)
        for (const args of plan) await exec(args)
        return
      }
      if (!d.remembered || d.wifi) return
      // 포트가 풀린 Wi-Fi 기기가 USB 로 꽂혀 있으면 tcpip 를 다시 건다. 꽂힐 때마다 한 번만 —
      // tcpip 는 기기의 adb 를 재시작해서 그 순간 USB 미러링도 끊기기 때문이다.
      if (d.wifiErr === 'refused' && d.usb?.state === 'device' && d.tcpipTried !== d.usb.serial) {
        d.tcpipTried = d.usb.serial
        log(`${d.model}: 재부팅으로 Wi-Fi 포트가 풀려 USB 로 다시 엽니다 (tcpip ${d.remembered.port})`)
        await exec(['-s', d.usb.serial, 'tcpip', String(d.remembered.port)])
        await sleep(2500)   // adbd 가 TCP 로 다시 뜨는 시간
      }
      const addr = `${d.remembered.ip}:${d.remembered.port}`
      const c = connectResult((await exec(['connect', addr])).out)
      if (c.ok && d.wifiErr) log(`${d.model}: Wi-Fi 다시 연결됨 — ${addr}`)
      d.wifiErr = c.ok ? null : c.kind
    })().catch(e => log(`${d.model}: 재연결 실패 — ${e.message || e}`)).finally(() => {
      d.busy = false
      pending.delete(p)
      push()
    })
    pending.add(p)
  }

  // ── 저장 ──

  function startRecorder(d, serial) {
    const dir = devDir(d)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, MARKER), '')
    } catch (e) {
      d.recErr = '저장 폴더를 만들 수 없습니다: ' + e.message
      d.recRetryAt = now() + 30000
      return
    }
    if (!d.lastStamp) d.lastStamp = lastStampIn(dir)   // 앱을 다시 켜도 이어 받는다
    if (d.bytesDay !== todayKey()) { d.bytesToday = dayBytes(dir, todayKey()); d.bytesDay = todayKey() }

    const args = ['-s', serial, 'logcat', '-v', 'threadtime']
    // 이어 받을 시각이 있으면 거기부터 — 같은 줄이 두 번 저장되지 않게. 없으면(처음) 기기
    // 버퍼에 남은 것부터 전부 받는다. 시각에 공백이 있지만 adb logcat 이 인자를 따옴표로 감싸
    // 기기 셸에 넘기므로 그대로 넘긴다 — 실측 확인(SM-S926N, Android 16): 경계 시각의 한 줄만
    // 겹치고(-T 는 그 시각을 포함한다) 빠진 줄은 없었다. 다른 기종에서 인자가 거부되면 곧바로
    // 끝나므로 endRecorder 가 그걸 보고 이어 받기를 끈다 — 줄이 겹칠지언정 빠지지는 않게.
    const resume = d.lastStamp && !d.noResume
    if (resume) args.push('-T', d.lastStamp)
    let proc
    try { proc = spawnLogcat(args) } catch (e) {
      d.recErr = e.message
      d.recRetryAt = now() + 10000
      return
    }
    const rec = { proc, serial, pending: '', fd: null, key: null, lastTime: null, resume, gotLine: false }
    d.rec = rec
    d.recErr = null
    d.recStartedAt = now()
    log(`${d.model}: 저장 시작 — ${serial}${d.lastStamp ? ` (${d.lastStamp} 부터 이어 받기)` : ''}`)
    proc.stdout.on('data', chunk => onData(d, rec, chunk))
    proc.stderr?.on('data', c => { d.recErr = String(c).trim().slice(0, 200) || d.recErr })
    // 핸들러가 없으면 spawn 실패가 처리되지 않은 이벤트로 올라와 메인 프로세스가 죽는다
    proc.on('error', e => { d.recErr = e.message; endRecorder(d, rec) })
    proc.on('close', () => endRecorder(d, rec))
  }

  function closeFile(rec) {
    if (rec.fd != null) { try { fs.closeSync(rec.fd) } catch { } rec.fd = null; rec.key = null }
  }

  function endRecorder(d, rec) {
    if (d.rec !== rec) return
    if (rec.pending) { writeLines(d, rec, [rec.pending]); rec.pending = '' }
    closeFile(rec)
    d.rec = null
    const quick = now() - d.recStartedAt < 5000
    // -T 로 붙었는데 한 줄도 못 받고 바로 끝나는 일이 두 번 이어지면 이어 받기 인자가 거부된
    // 것으로 본다. 한 번은 마침 끊긴 것일 수 있어서 두 번을 기다린다.
    if (rec.resume) {
      if (quick && !rec.gotLine) d.resumeFails = (d.resumeFails || 0) + 1
      else if (rec.gotLine) d.resumeFails = 0
      if (d.resumeFails >= 2 && !d.noResume) {
        d.noResume = true
        log(`${d.model}: 이어 받기(-T)가 거부되어 이 기기는 처음부터 받습니다 — 일부 줄이 겹칠 수 있습니다`)
      }
    }
    // 시작하자마자 죽는 경우(권한·기기 문제)에 점검마다 다시 띄우지 않게 잠깐 쉰다
    d.recRetryAt = now() + (quick && !rec.gotLine && !d.noResume ? 10000 : 1000)
    push()
  }

  function stopRecorder(d) {
    const rec = d.rec
    if (!rec) return
    d.rec = null
    if (rec.pending) { writeLines(d, rec, [rec.pending]); rec.pending = '' }
    closeFile(rec)
    try { rec.proc.kill() } catch { }
  }

  function onData(d, rec, chunk) {
    const lines = (rec.pending + String(chunk)).split('\n')
    rec.pending = lines.pop()
    writeLines(d, rec, lines)
  }

  // 줄의 시각(기기 시계)으로 파일을 고른다 — 끊겼다 이어 받은 지난 줄도 제 시간 파일로 간다.
  // 같은 파일로 가는 줄은 모아서 한 번에 쓴다.
  function writeLines(d, rec, lines) {
    const nowD = new Date(now())
    let buf = [], bufKey = null
    const flush = () => {
      if (buf.length) write(d, rec, bufKey, buf.join('\n') + '\n')
      buf = []
    }
    for (let line of lines) {
      line = line.replace(/\r+$/, '')
      if (!line) continue
      const t = lineTime(line, nowD)
      if (t) rec.lastTime = t
      const k = periodKey(t || rec.lastTime || nowD, cfg.recording.intervalMin)
      const key = k.day + '/' + k.file
      if (key !== bufKey) { flush(); bufKey = key }
      buf.push(line)
      const stamp = lineStamp(line)
      if (stamp) { d.lastStamp = stamp; rec.gotLine = true }
      const issue = issueOf(line)
      if (issue) {
        if (d.countDay !== todayKey()) { d.crash = 0; d.anr = 0; d.countDay = todayKey() }
        d[issue]++
      }
    }
    flush()
    d.lastAt = now()
    pushSoon()
  }

  function write(d, rec, key, text) {
    try {
      if (rec.key !== key) {
        closeFile(rec)
        const [day, file] = key.split('/')
        const dir = path.join(devDir(d), day)
        fs.mkdirSync(dir, { recursive: true })
        rec.fd = fs.openSync(path.join(dir, file + '.log'), 'a')
        rec.key = key
      }
      fs.writeSync(rec.fd, text)
      if (d.bytesDay !== todayKey()) { d.bytesToday = 0; d.bytesDay = todayKey() }
      if (key.startsWith(todayKey() + '/')) d.bytesToday += Buffer.byteLength(text)
    } catch (e) {
      d.recErr = '저장 실패: ' + e.message
      closeFile(rec)
    }
  }

  // 마지막으로 저장된 줄의 시각 — 가장 최근 날짜 폴더의 가장 최근 파일 꼬리에서 찾는다
  function lastStampIn(dir) {
    try {
      const days = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()
      for (const day of days) {
        const files = fs.readdirSync(path.join(dir, day)).filter(n => n.endsWith('.log')).sort().reverse()
        for (const f of files) {
          const p = path.join(dir, day, f)
          const size = fs.statSync(p).size
          const len = Math.min(size, 16384)
          const buf = Buffer.alloc(len)
          const fd = fs.openSync(p, 'r')
          try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
          const lines = buf.toString('utf8').split('\n')
          for (let i = lines.length - 1; i >= 0; i--) {
            const s = lineStamp(lines[i])
            if (s) return s
          }
        }
      }
    } catch { }
    return null
  }

  function dayBytes(dir, day) {
    try {
      return fs.readdirSync(path.join(dir, day))
        .reduce((sum, f) => sum + fs.statSync(path.join(dir, day, f)).size, 0)
    } catch { return 0 }
  }

  function cleanup() {
    const root = cfg.recording.dir
    let names = []
    try { names = fs.readdirSync(root) } catch { return }
    for (const n of names) {
      const devPath = path.join(root, n)
      if (!fs.existsSync(path.join(devPath, MARKER))) continue
      let days = []
      try { days = fs.readdirSync(devPath) } catch { continue }
      for (const day of expiredDays(days, cfg.recording.retentionDays, new Date(now()))) {
        try {
          fs.rmSync(path.join(devPath, day), { recursive: true, force: true })
          log(`보관 기간이 지난 로그 삭제: ${n}/${day}`)
        } catch (e) { log(`로그 삭제 실패: ${n}/${day} — ${e.message}`) }
      }
    }
  }

  // ── 렌더러로 보내는 상태 ──

  function snapshot() {
    const t = now(), today = todayKey()
    return [...devices.values()].map(d => ({
      id: d.id,
      model: d.model,
      status: statusOf(d, t),
      transports: ['usb', 'wifi'].filter(k => d[k]),
      usbSerial: d.usb?.serial || null,
      wifiSerial: d.wifi?.serial || null,
      usbOnline: d.usb?.state === 'device',   // 'Wi-Fi 로 전환'은 USB 가 살아 있을 때만 된다
      activeSerial: d.active ? d[d.active].serial : null,
      address: d.remembered ? `${d.remembered.ip}:${d.remembered.port}`
        : (d.wifi && WIFI_SERIAL_RE.test(d.wifi.serial) ? d.wifi.serial : null),
      remembered: !!d.remembered,
      recording: {
        on: recordingOn(d), running: !!d.rec, error: d.recErr,
        bytesToday: d.bytesDay === today ? d.bytesToday : 0, lastAt: d.lastAt,
      },
      crash: d.countDay === today ? d.crash : 0,
      anr: d.countDay === today ? d.anr : 0,
      badSince: d.badSince,
    }))
  }
  function push() { onUpdate?.(snapshot()) }
  function pushSoon() {
    if (pushTimer) return
    pushTimer = setTimeout(() => { pushTimer = null; push() }, PUSH_THROTTLE_MS)
  }

  // ── 화면에서 부르는 동작 ──

  function remember(d, ip, port) {
    d.remembered = { ip, port }
    cfg.wifi = cfg.wifi.filter(w => w.id !== d.id && !(w.ip === ip && w.port === port))
    cfg.wifi.push({ id: d.id, model: d.model, ip, port })
    saveCfg()
  }

  async function addWifi(ip, port = 5555) {
    const addr = `${ip}:${port}`
    const r = await exec(['connect', addr])
    const c = connectResult(r.out)
    if (!c.ok) return { ok: false, kind: c.kind, message: connectHint(c.kind, r.out) }
    const id = cleanProp((await exec(['-s', addr, 'shell', 'getprop', 'ro.serialno'])).out) || addr
    const model = String((await exec(['-s', addr, 'shell', 'getprop', 'ro.product.model'])).out || '').trim() || ip
    if (model !== ip) modelOf.set(id, model)
    const d = devOf(id, model)
    remember(d, ip, port)
    d.wifiErr = null
    serialToId.set(addr, id)
    await tick()
    return { ok: true, id, model: d.model, serial: addr }
  }

  // USB 로 꽂힌 폰을 Wi-Fi 로 — IP 조회 → tcpip → connect → 고정 주소로 기억
  async function toWifi(id, port = 5555) {
    const d = devices.get(id)
    if (!d?.usb || d.usb.state !== 'device') return { ok: false, message: 'USB 로 연결된 상태에서만 할 수 있습니다' }
    const s = d.usb.serial
    const ip = parseWlanIp((await exec(['-s', s, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'])).out)
    if (!ip) return { ok: false, message: '폰이 Wi-Fi 에 연결돼 있지 않습니다' }
    await exec(['-s', s, 'tcpip', String(port)])
    let c = { ok: false, kind: 'other' }, out = ''
    for (let i = 0; i < 5 && !c.ok; i++) {   // adbd 가 TCP 로 다시 뜨는 데 1~2초 걸린다
      await sleep(1500)
      out = (await exec(['connect', `${ip}:${port}`])).out
      c = connectResult(out)
    }
    if (!c.ok) return { ok: false, message: connectHint(c.kind, out) }
    remember(d, ip, port)
    d.wifiErr = null
    d.tcpipTried = s
    serialToId.set(`${ip}:${port}`, d.id)
    await tick()
    return { ok: true, address: `${ip}:${port}` }
  }

  async function remove(id) {
    const d = devices.get(id)
    if (!d) return { ok: true }
    stopRecorder(d)
    cfg.wifi = cfg.wifi.filter(w => w.id !== id)
    saveCfg()
    if (d.wifi) await exec(['disconnect', d.wifi.serial])
    devices.delete(id)
    push()
    return { ok: true }
  }

  function setRecording(id, on) {
    cfg.deviceRec[id] = !!on
    saveCfg()
    const d = devices.get(id)
    if (d) { d.recRetryAt = 0; step(d) }
    push()
    return { ok: true }
  }

  function folderOf(id) {
    const d = devices.get(id)
    const dir = d && fs.existsSync(devDir(d)) ? devDir(d) : cfg.recording.dir
    try { fs.mkdirSync(dir, { recursive: true }) } catch { }
    return dir
  }

  function getSettings() { return { ...cfg.recording } }

  function setSettings(s) {
    const r = cfg.recording
    const next = {
      autoNew: s.autoNew === undefined ? r.autoNew : !!s.autoNew,
      dir: typeof s.dir === 'string' && s.dir.trim() ? s.dir.trim() : r.dir,
      intervalMin: INTERVALS.includes(+s.intervalMin) ? +s.intervalMin : r.intervalMin,
      retentionDays: RETENTIONS.includes(+s.retentionDays) ? +s.retentionDays : r.retentionDays,
    }
    const dirChanged = next.dir !== r.dir
    cfg.recording = next
    saveCfg()
    for (const d of devices.values()) {
      // 위치가 바뀌면 새 위치에 다시 연다. 이어 받을 시각은 기억해 두므로 중복 없이 이어진다.
      if (dirChanged) { stopRecorder(d); d.bytesDay = null }
      d.recRetryAt = 0
      step(d)
    }
    lastCleanup = now()
    cleanup()
    push()
    return { ok: true, settings: { ...next } }
  }

  // 수동 전용. 모든 기기 연결이 끊기므로 자동 복구에는 절대 쓰지 않는다.
  async function restartServer() {
    for (const d of devices.values()) stopRecorder(d)
    await exec(['kill-server'])
    await exec(['start-server'])
    serialToId.clear()
    for (const d of devices.values()) { d.attempts = 0; d.nextTryAt = 0; d.recRetryAt = 0 }
    log('adb 서버를 다시 시작했습니다 — Wi-Fi 기기는 기억해 둔 주소로 다시 붙습니다')
    await tick()
    return { ok: true }
  }

  function start() {
    if (timer) return
    timer = setInterval(tick, POLL_MS)
    tick()
  }
  function stop() {
    clearInterval(timer)
    timer = null
    clearTimeout(pushTimer)
    pushTimer = null
    for (const d of devices.values()) stopRecorder(d)
  }

  return {
    start, stop, tick, snapshot, addWifi, toWifi, remove, setRecording, folderOf,
    getSettings, setSettings, restartServer,
    whenIdle: () => Promise.all([...pending]),   // 자가진단용
  }
}

module.exports = {
  transportOf, parseDevices, connectResult, periodKey, lineStamp, lineTime, folderName,
  backoffMs, issueOf, expiredDays, pickActive, statusOf, reconnectPlan, parseWlanIp, MARKER,
  create,
}

// ── 자가진단: node src/device-hub.js ────────────────────────────
if (require.main === module) {
  const assert = require('assert')
  const os = require('os')
  const { EventEmitter } = require('events')
  let n = 0
  const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++ }

  // 연결 방식
  eq(transportOf('R39M30ABCDE'), 'usb')
  eq(transportOf('192.168.0.12:5555'), 'wifi')
  eq(transportOf('adb-R39M30ABCDE-Ab1Cd2._adb-tls-connect._tcp'), 'wifi')
  eq(transportOf('emulator-5554'), 'usb')

  // adb devices -l
  const dl = parseDevices([
    '* daemon not running; starting now at tcp:5037',
    'List of devices attached',
    'R39M30ABCDE            device usb:1-1 product:beyond1lteks model:SM_G973N device:beyond1 transport_id:3',
    '192.168.0.12:5555      device product:a52qnsxx model:SM_A525N device:a52q transport_id:5',
    'R58N1234               unauthorized usb:1-2 transport_id:6',
    '192.168.0.18:5555      offline transport_id:7',
    '',
  ].join('\r\n'))
  eq(dl.map(e => [e.serial, e.state, e.transport, e.model]), [
    ['R39M30ABCDE', 'device', 'usb', 'SM G973N'],
    ['192.168.0.12:5555', 'device', 'wifi', 'SM A525N'],
    ['R58N1234', 'unauthorized', 'usb', ''],
    ['192.168.0.18:5555', 'offline', 'wifi', ''],
  ])

  // adb connect 결과 — 한국어 Windows 문구는 실측 그대로
  eq(connectResult('connected to 192.168.0.12:5555'), { ok: true })
  eq(connectResult('already connected to 192.168.0.12:5555'), { ok: true })
  eq(connectResult('cannot connect to 127.0.0.1:5599: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (10061)').kind, 'refused')
  eq(connectResult('failed to connect to 10.0.0.9:5555: Connection refused').kind, 'refused')
  eq(connectResult('cannot connect to 10.0.0.9:5555: 연결된 구성원으로부터 응답이 없어 연결하지 못했거나 ... (10060)').kind, 'unreachable')
  eq(connectResult('failed to connect to 10.0.0.9:5555: Operation timed out').kind, 'unreachable')
  eq(connectResult('failed to authenticate to 10.0.0.9:5555').kind, 'other')

  // 파일 나누기
  const at = (h, m) => new Date(2026, 9, 23, h, m, 5)
  eq(periodKey(at(14, 59), 60), { day: '2026-10-23', file: '14-00' })
  eq(periodKey(at(14, 59), 30), { day: '2026-10-23', file: '14-30' })
  eq(periodKey(at(14, 9), 10), { day: '2026-10-23', file: '14-00' })
  eq(periodKey(at(23, 59), 1440), { day: '2026-10-23', file: '00-00' })

  // 줄 시각
  const L = '10-23 14:02:11.123  1955  2092 I flutter: 로그인'
  eq(lineStamp(L), '10-23 14:02:11.123')
  eq(lineStamp('--------- beginning of main'), null)
  eq(lineTime(L, new Date(2026, 9, 23, 15, 0)).getTime(), new Date(2026, 9, 23, 14, 2, 11, 123).getTime())
  eq(lineTime('12-31 23:59:59.000  1 1 I x: y', new Date(2027, 0, 1, 0, 0, 5)).getFullYear(), 2026, '연말 줄은 작년으로')

  eq(folderName('SM G973N', 'R39M30ABCDE'), 'SM_G973N_R39M30ABCDE')
  eq(folderName('a:b*c', '192.168.0.12:5555'), 'a_b_c_192.168.0.12_5555')
  eq([0, 1, 2, 3, 9].map(backoffMs), [5000, 10000, 30000, 60000, 60000])
  eq(issueOf('E AndroidRuntime: FATAL EXCEPTION: main'), 'crash')
  eq(issueOf('E ActivityManager: ANR in com.zerosoft.app'), 'anr')
  eq(issueOf('I flutter: ANRS are fine'), null)
  eq(expiredDays(['2026-10-15', '2026-10-16', '2026-10-23', 'notes', '.droidbridge'], 7, new Date(2026, 9, 23)), ['2026-10-15'])
  eq(expiredDays(['2020-01-01'], 0), [])

  // 받을 길 — 살아 있으면 그대로, 넘어가야 할 때만 USB 먼저
  const both = { usb: { state: 'device' }, wifi: { state: 'device' } }
  eq(pickActive(both, 'wifi'), 'wifi')
  eq(pickActive(both, null), 'usb')
  eq(pickActive({ usb: null, wifi: { state: 'device' } }, 'usb'), 'wifi')
  eq(pickActive({ usb: { state: 'offline' }, wifi: null }, 'usb'), null)

  // 카드 상태
  const T = 1e12
  eq(statusOf({ usb: { state: 'device' }, wifi: { state: 'offline' } }, T), 'online')
  eq(statusOf({ usb: { state: 'unauthorized' }, wifi: null }, T), 'unauthorized')
  eq(statusOf({ usb: { state: 'offline' }, wifi: null, badSince: T - 1000 }, T), 'reconnecting')
  eq(statusOf({ usb: { state: 'offline' }, wifi: null, badSince: T - 11 * 60000 }, T), 'failed')
  eq(statusOf({ usb: null, wifi: null, remembered: { ip: 'x', port: 5555 }, wifiErr: 'refused' }, T), 'port-closed')
  eq(statusOf({ usb: null, wifi: null, remembered: { ip: 'x', port: 5555 }, wifiErr: 'unreachable', badSince: T }, T), 'reconnecting')
  eq(statusOf({ usb: null, wifi: null }, T), 'unplugged')

  // offline 복구 순서
  eq([0, 1, 2, 3].map(a => reconnectPlan(a, 'R1')), [
    [['-s', 'R1', 'reconnect']], [['-s', 'R1', 'reconnect', 'device']], [['reconnect', 'offline']], [['-s', 'R1', 'reconnect']]])
  eq(reconnectPlan(3, '192.168.0.12:5555', { ip: '192.168.0.12', port: 5555 }),
    [['disconnect', '192.168.0.12:5555'], ['connect', '192.168.0.12:5555']])
  eq(parseWlanIp('29: wlan0: <BROADCAST>\n    inet 192.168.0.12/24 brd 192.168.0.255 scope global wlan0'), '192.168.0.12')
  eq(parseWlanIp(''), null)

  // ── 상태 흐름: 가짜 adb 로 기기 꽂기·합치기·넘어가기·복구·이어 받기 ──
  const flow = async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-'))
    const logDir = path.join(tmp, 'logs')
    let clock = new Date(2026, 9, 23, 14, 59, 50).getTime()
    let devicesOut = ''
    const calls = [], procs = []
    const answers = {
      'getprop ro.serialno': 'R1\n', 'getprop ro.product.model': 'SM-G973N\n',
      'connect 192.168.0.12:5555': 'cannot connect to 192.168.0.12:5555: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (10061)',
    }
    const exec = async args => {
      calls.push(args.join(' '))
      if (args[0] === 'devices') return { code: 0, out: devicesOut, err: '' }
      const key = Object.keys(answers).find(k => args.join(' ').endsWith(k))
      return { code: 0, out: key ? answers[key] : '', err: '' }
    }
    const spawnLogcat = args => {
      const p = new EventEmitter()
      p.stdout = new EventEmitter()
      p.stderr = new EventEmitter()
      p.args = args
      p.kill = () => p.emit('close')
      procs.push(p)
      return p
    }
    const mk = () => create({
      exec, spawnLogcat, userDir: tmp, defaultLogDir: logDir,
      now: () => clock, sleep: async () => { }, onUpdate: () => { },
    })
    let hub = mk()

    // 1) USB 로 꽂힘 → 기본은 저장 꺼짐. 카드에서 켜면 그때 시작 (처음이라 -T 없이)
    devicesOut = 'List of devices attached\nR1  device usb:1-1 model:SM_G973N\n'
    await hub.tick()
    eq([procs.length, hub.snapshot()[0].recording.on], [0, false], '새로 연결한 기기는 저장 꺼짐')
    hub.setRecording('R1', true)
    await hub.tick()
    eq(procs.length, 1, '켜면 저장 시작')
    eq(procs[0].args, ['-s', 'R1', 'logcat', '-v', 'threadtime'])
    // 시간 경계를 넘는 줄 + 줄 중간에서 끊긴 청크 + 크래시
    procs[0].stdout.emit('data', '--------- beginning of main\n10-23 14:59:58.100  1 1 I a: 하나\n10-23 15:00:')
    procs[0].stdout.emit('data', '01.200  1 1 E AndroidRuntime: FATAL EXCEPTION: main\r\n')
    // 모델명은 getprop 값(SM-G973N) — devices -l 의 SM_G973N 이 아니다
    const devFolder = path.join(logDir, 'SM-G973N_R1')
    eq(fs.readFileSync(path.join(devFolder, '2026-10-23', '14-00.log'), 'utf8'),
      '--------- beginning of main\n10-23 14:59:58.100  1 1 I a: 하나\n')
    eq(fs.readFileSync(path.join(devFolder, '2026-10-23', '15-00.log'), 'utf8'),
      '10-23 15:00:01.200  1 1 E AndroidRuntime: FATAL EXCEPTION: main\n', '줄 시각으로 다음 시간 파일')
    let s = hub.snapshot()
    eq([s.length, s[0].status, s[0].crash, s[0].recording.running], [1, 'online', 1, true])
    eq(s[0].recording.bytesToday > 0, true)
    assert.ok(fs.existsSync(path.join(devFolder, MARKER))); n++

    // 2) 같은 폰이 Wi-Fi 로도 잡힘 → 카드 한 장, 받는 길은 USB 그대로
    devicesOut += '192.168.0.12:5555  device model:SM_G973N\n'
    await hub.tick()
    s = hub.snapshot()
    eq([s.length, s[0].transports, s[0].activeSerial, procs.length], [1, ['usb', 'wifi'], 'R1', 1], 'USB·Wi-Fi 합치기')

    // 3) 케이블 뽑힘 → Wi-Fi 로 넘어가 마지막 시각부터 이어 받기
    devicesOut = 'List of devices attached\n192.168.0.12:5555  device model:SM_G973N\n'
    await hub.tick()
    eq(procs.length, 2, 'Wi-Fi 로 다시 붙음')
    eq(procs[1].args, ['-s', '192.168.0.12:5555', 'logcat', '-v', 'threadtime', '-T', '10-23 15:00:01.200'])
    eq(hub.snapshot()[0].activeSerial, '192.168.0.12:5555')

    // 4) Wi-Fi 가 offline → 재연결 ① 실행
    devicesOut = 'List of devices attached\n192.168.0.12:5555  offline\n'
    await hub.tick()
    await hub.whenIdle()
    eq(hub.snapshot()[0].status, 'reconnecting')
    eq(calls.includes('-s 192.168.0.12:5555 reconnect'), true, 'offline 이면 reconnect')

    // 5) 고정 주소를 기억해 둔 상태에서 목록에서 사라지고 연결 거부 → 포트 풀림
    //    (설정 파일은 덮어쓰지 않고 주소만 더한다 — 1) 에서 켠 값이 재시작 뒤에도 남는지 같이 본다)
    hub.stop()
    const cfgFile = path.join(tmp, 'multi-device.json')
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    eq(saved.deviceRec, { R1: true }, '기기마다 켠 값이 파일에 남음')
    saved.wifi = [{ id: 'R1', model: 'SM-G973N', ip: '192.168.0.12', port: 5555 }]
    fs.writeFileSync(cfgFile, JSON.stringify(saved))
    hub = mk()
    devicesOut = 'List of devices attached\n'
    await hub.tick()
    await hub.whenIdle()
    eq(hub.snapshot()[0].status, 'port-closed', '연결 거부 = 포트 풀림')

    // 6) 그 폰이 USB 로 꽂히면 tcpip 5555 를 한 번 다시 건다 + 앱을 다시 켜도 이어 받기
    devicesOut = 'List of devices attached\nR1  device usb:1-1 model:SM_G973N\n'
    clock += 60000
    await hub.tick()
    await hub.whenIdle()
    eq(calls.filter(c => c === '-s R1 tcpip 5555').length, 1, '포트 풀림 + USB → tcpip')
    const last = procs[procs.length - 1]
    eq(last.args.slice(-2), ['-T', '10-23 15:00:01.200'], '재시작 후에도 마지막 시각부터')
    clock += 60000
    await hub.tick()
    await hub.whenIdle()
    eq(calls.filter(c => c === '-s R1 tcpip 5555').length, 1, '꽂혀 있는 동안 tcpip 는 한 번만')

    // 7) -T 가 거부되면(한 줄도 못 받고 곧바로 끝남) 두 번째에 이어 받기를 끄고 처음부터 받는다
    let cur = procs[procs.length - 1]
    cur.emit('close')                       // 한참 돈 뒤 끝남 — 거부로 치지 않는다
    clock += 2000
    await hub.tick()
    cur = procs[procs.length - 1]
    eq(cur.args.includes('-T'), true, '다시 이어 받기로 시작')
    cur.emit('close')                       // 곧바로 끝남 ①
    clock += 11000
    await hub.tick()
    cur = procs[procs.length - 1]
    eq(cur.args.includes('-T'), true, '한 번은 마침 끊긴 것일 수 있어 다시 -T')
    cur.emit('close')                       // 곧바로 끝남 ②
    clock += 2000
    await hub.tick()
    eq(procs[procs.length - 1].args.includes('-T'), false, '두 번 거부되면 처음부터 받는다')

    // 8) 보관 기간 — 표시 파일이 있는 기기 폴더 안의 오래된 날짜만 지운다
    fs.mkdirSync(path.join(devFolder, '2026-10-01'), { recursive: true })
    const foreign = path.join(logDir, 'Photos', '2026-10-01')
    fs.mkdirSync(foreign, { recursive: true })
    hub.setSettings({ retentionDays: 7 })
    eq(fs.existsSync(path.join(devFolder, '2026-10-01')), false, '오래된 로그 삭제')
    eq(fs.existsSync(path.join(devFolder, '2026-10-23')), true, '최근 로그 보존')
    eq(fs.existsSync(foreign), true, '우리 폴더가 아니면 건드리지 않음')

    // 9) 저장 끄기 → 프로세스 내림
    const before = procs.length
    hub.setRecording('R1', false)
    eq(hub.snapshot()[0].recording.on, false)
    await hub.tick()
    eq(procs.length, before, '꺼진 기기는 다시 띄우지 않음')

    hub.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  flow().then(() => console.log(`device-hub 자가진단 통과 — ${n}개`))
    .catch(e => { console.error('device-hub 자가진단 실패:', e); process.exit(1) })
}
