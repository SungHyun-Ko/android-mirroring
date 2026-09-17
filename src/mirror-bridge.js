/**
 * mirror-bridge.js — scrcpy v4.x 프로토콜 구현 (수정판)
 *
 * v4.0 와이어 프로토콜 (send_frame_meta=true 기준):
 *   [연결 후 서버가 전송]
 *   1. deviceName   : 64 bytes (UTF-8, null-padded)
 *   2. codec_id     : 4 bytes uint32 BE  (0x68323634 = "h264")
 *   3. initial_meta : 8 bytes  → width(4) + height(4) BE  ← v4.0: flags 필드 없음!
 *   4. 이후 프레임  : pts(8 bytes int64 BE) + size(4 bytes) + H.264 access unit
 *
 * [수정 사항]
 *  - SESSION_META_LEN: 12→8  (flags 필드 제거, v4.0 실제 포맷 반영)
 *  - send_frame_meta: false→true  (프레임 단위 파싱으로 안정성 향상)
 *  - max_fps 파라미터 추가
 *  - _pipe 상태 머신 완전 재작성 (frameHeader / frameData 상태 추가)
 *  - switch case 내 const 블록 명시화
 */
'use strict'

const net = require('net')
const { WebSocketServer } = require('ws')
const { execFile, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const hid = require('./hid-keyboard')

const FALLBACK_VER = '4.1'
const H264_CODEC_ID = 0x68323634  // ASCII "h264"

// UHID 가상 키보드 식별자. Android 는 이 조합을 키로 물리 키보드 레이아웃 설정을
// 저장하므로 바꾸면 사용자가 레이아웃을 매번 다시 잡아야 한다. 고정할 것.
const UHID_ID = 1
const UHID_VENDOR_ID = 0x1209
const UHID_PRODUCT_ID = 0xdb01
const UHID_NAME = 'DroidBridge Keyboard'

// 해상도로 말이 되는 값의 상한. scrcpy 는 max_size 로 축소해 보내므로 실제로는
// 수천 이하지만, 8K 세로까지는 열어 둔다.
const MAX_DIM = 8192
const plausibleDim = v => v > 0 && v <= MAX_DIM

/**
 * codec_id 직후의 session_meta 에서 width/height 를 뽑는다.
 *
 * 길이를 상수로 박지 않는 이유: 서버 빌드마다 레이아웃이 다른 것이 실측으로 확인됐다.
 *   - 8B  형태: [width][height]              (SM-G981N 에서 관측)
 *   - 12B 형태: [flags][width][height]       (다운로드본 v4.1 + SM-G973N 에서 관측)
 * 오프셋을 고정하면 한쪽을 맞추는 순간 다른 쪽이 깨진다. 해상도는 값 범위가 좁고
 * flags 는 최상위 비트가 서 있어(0x80000000) 값만 보고도 구분된다.
 *
 * 12B 이상 들어온 뒤에 부를 것. 판별 불가면 null (호출부가 세션을 끊는다).
 */
function parseSessionMeta(buf) {
  if (buf.length < 12) return null
  const at0 = buf.readUInt32BE(0), at4 = buf.readUInt32BE(4), at8 = buf.readUInt32BE(8)
  // 8B 형태를 먼저 본다. 뒤의 4B 는 프레임 헤더 PTS 상위라 보통 0x80000000/0x40000000 이다.
  if (plausibleDim(at0) && plausibleDim(at4)) return { width: at0, height: at4, consumed: 8 }
  if (plausibleDim(at4) && plausibleDim(at8)) return { width: at4, height: at8, consumed: 12 }
  return null
}

class MirrorBridge {
  constructor({ adbPath, binDir, onLog }) {
    this.adbPath = adbPath
    this.binDir = binDir
    this.log = msg => onLog?.('[bridge] ' + msg)
    this.wss = null
    this.wsClient = null
    this.adbSock = null
    this.controlSock = null
    this.srvProc = null
    this.serial = null
    this.running = false
    this._metaJson = null   // 캐싱: 늦게 연결된 WS 클라이언트에게 전송
    this._frameCnt = 0
    this.keyboardMode = 'clipboard'   // 'uhid' | 'clipboard' — start() 에서 판정
  }

  // UHID 는 API 레벨이 아니라 /dev/uhid 에 대한 SELinux 정책에 달려 있다.
  // (AOSP 기준 Android 11~12 무렵 shell 도메인 접근이 열렸다)
  async _detectKeyboardMode(serial) {
    try {
      const out = await this.adb(['-s', serial, 'shell', 'ls', '-l', '/dev/uhid'], 8000)
      return /no such file|not found|denied/i.test(out) ? 'clipboard' : 'uhid'
    } catch {
      return 'clipboard'
    }
  }

  // ── adb 헬퍼 ─────────────────────────────────────────────────
  adb(args, ms = 25000) {
    return new Promise((res, rej) => {
      execFile(this.adbPath, args, { timeout: ms }, (err, out, err2) => {
        if (err) rej(new Error((err2 || err.message).trim()))
        else res(out.trim())
      })
    })
  }

  // ── WSS 시작 ─────────────────────────────────────────────────
  startWss() {
    if (this.wss) return Promise.resolve(this.wsPort)
    return new Promise((res, rej) => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      wss.once('listening', () => {
        this.wsPort = wss.address().port
        this.log(`WSS ready :${this.wsPort}`)
        this.wss = wss
        res(this.wsPort)
      })
      wss.once('error', e => {
        rej(e)
      })
      wss.on('connection', ws => {
        this.wsClient = ws
        this.log('★ renderer WS 연결됨')
        // 이미 meta가 캐싱되어 있으면 즉시 전송 (늦은 연결 복구)
        if (this._metaJson) {
          try { ws.send(this._metaJson) } catch { }
          this.log('  → 캐시된 meta 전송: ' + this._metaJson)
        }
        if (this._modeJson) {
          try { ws.send(this._modeJson) } catch { }
        }
        ws.on('message', data => {
          try {
            const msg = JSON.parse(data)
            if (msg.type === 'touch') {
              this.injectTouch(msg)
            } else if (msg.type === 'keycode') {
              this.injectKeycode(msg)
            } else if (msg.type === 'text') {
              this.injectText(msg)
            } else if (msg.type === 'hid') {
              // 렌더러는 nodeIntegration=false 라 hid-keyboard 를 require 할 수 없다.
              // 눌린 KeyboardEvent.code 목록만 보내고 리포트 조립은 여기서 한다.
              this.uhidInput(hid.buildReport(msg.codes || []))
            } else if (msg.type === 'rotate') {
              this.rotateDevice()
            } else if (msg.type === 'openKeyboardSettings') {
              this.openHardKeyboardSettings()
            }
          } catch (e) {
            this.log('WS 수신 메시지 처리 오류: ' + e.message)
          }
        })
        ws.on('close', () => { this.wsClient = null; this.log('★ renderer WS 끊김') })
        ws.on('error', e => { this.wsClient = null; this.log('★ renderer WS 오류: ' + e.message) })
      })
    })
  }

  // ── jar 확보 ─────────────────────────────────────────────────
  async ensureJar() {
    // 1. 시스템 설치 경로 탐색 (macOS / Linux)
    for (const p of [
      '/usr/share/scrcpy/scrcpy-server',
      '/usr/local/share/scrcpy/scrcpy-server',
      '/opt/homebrew/share/scrcpy/scrcpy-server',
    ]) { if (fs.existsSync(p)) { this.log('jar: system ' + p); return { path: p, ver: null } } }

    // 2. 로컬 binDir에 이미 캐싱된 scrcpy-server-v* 또는 scrcpy-server 파일이 있는지 우선 스캔 (오프라인 실행 보장)
    try {
      if (fs.existsSync(this.binDir)) {
        const files = fs.readdirSync(this.binDir)
        // scrcpy-server-v4.0 등 버전명이 명시된 캐시파일 우선 검색
        const jarFile = files.find(f => f.startsWith('scrcpy-server-v'))
        if (jarFile) {
          const cached = path.join(this.binDir, jarFile)
          const ver = this._jarVer(jarFile)
          this.log(`jar: found local cached ${jarFile} (v${ver})`)
          return { path: cached, ver }
        }
        // 일반 scrcpy-server 파일 검색
        const plainJar = files.find(f => f === 'scrcpy-server')
        if (plainJar) {
          const cached = path.join(this.binDir, plainJar)
          this.log(`jar: found local plain scrcpy-server`)
          return { path: cached, ver: null }
        }
      }
    } catch (e) {
      this.log('로컬 캐시 스캔 중 예외: ' + e.message)
    }

    // 3. 로컬에 없을 경우에만 GitHub 최신 버전 확인 및 다운로드 시도
    let ver = FALLBACK_VER
    try {
      const r = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest',
        { headers: { 'User-Agent': 'droidbridge' } })
      const j = await r.json()
      ver = j.tag_name.replace(/^v/, '')
      this.log(`GitHub latest: v${ver}`)
    } catch { this.log('GitHub API 제한 또는 오프라인 — v' + ver + ' 사용') }

    const cached = path.join(this.binDir, `scrcpy-server-v${ver}`)
    if (fs.existsSync(cached)) { this.log(`jar: cache (v${ver})`); return { path: cached, ver } }

    const url = `https://github.com/Genymobile/scrcpy/releases/download/v${ver}/scrcpy-server-v${ver}`
    this.log(`downloading v${ver}...`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`jar HTTP ${res.status}`)
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()))
    this.log(`jar v${ver} saved`)
    return { path: cached, ver }
  }

  // ── 메인 시작 ────────────────────────────────────────────────
  async start({ serial, maxSize, videoBitrate, fps }) {
    if (this.running) await this.stop()
    this.serial = serial
    this.running = true

    try {
      // ─ 기존 좀비 scrcpy 프로세스 제거 (이전 세션 찌꺼기가 소켓을 점거하는 문제 방지)
      this.log('기존 scrcpy 프로세스 정리 중...')
      await this.adb(['-s', serial, 'shell', 'pkill', '-f', 'com.genymobile.scrcpy']).catch(() => { })
      await new Promise(r => setTimeout(r, 1200))  // Android 프로세스 종료 대기

      this.log('STEP 1: WSS 시작...')
      await this.startWss()

      this.log('STEP 2: jar 확보...')
      const { path: jarPath, ver: rawVer } = await this.ensureJar()
      let ver = rawVer || this._jarVer(jarPath)
      this.log(`jar @ ${jarPath}${ver ? ` (v${ver})` : ' — 버전 미상'}`)

      this.log('STEP 3: adb push...')
      await this.adb(['-s', serial, 'push', jarPath, '/data/local/tmp/scrcpy-server.jar'])
      this.log('push OK')

      // 파일명에 버전이 없는 jar (Windows_setup.ps1 이 zip 에서 복사한 것, brew 설치본 등)
      // 은 여기서 서버에게 직접 물어본다. FALLBACK_VER 로 찍어 맞히면 scrcpy 가 새 버전을
      // 낼 때마다 버전 불일치로 미러링이 통째로 죽는다.
      if (!ver) {
        this.log('STEP 3-1: jar 버전 조회...')
        ver = await this._probeJarVer(serial)
        this.log(ver ? `서버가 보고한 버전: v${ver}` : `조회 실패 — v${FALLBACK_VER} 로 진행`)
        ver = ver || FALLBACK_VER
      }

      this.log('STEP 4: adb forward...')
      const forwardOut = await this.adb(['-s', serial, 'forward', 'tcp:0', 'localabstract:scrcpy'])
      this.forwardPort = parseInt(forwardOut.trim(), 10)
      this.log(`forward OK → tcp:${this.forwardPort}`)

      this.log(`STEP 5: scrcpy-server v${ver} 실행...`)
      await this._runServer(serial, ver, maxSize, videoBitrate, fps)

      this.log('STEP 6: 소켓 연결...')
      await this._connectWithRetry()

      this.log('STEP 7: 키보드 모드 판정...')
      this.keyboardMode = await this._detectKeyboardMode(serial)
      if (this.keyboardMode === 'uhid' && !this.uhidCreate()) this.keyboardMode = 'clipboard'
      this.log(this.keyboardMode === 'uhid'
        ? '키보드: UHID (물리 키보드 에뮬레이션) — 클립보드를 건드리지 않음'
        : '키보드: 클립보드 방식 (UHID 사용 불가)')
      // meta 는 _pipe 가 먼저 쏠 수 있어 경합한다. 모드는 별도 메시지로 보내고,
      // 늦게 붙는 WS 클라이언트를 위해 캐시해 둔다 (_metaJson 과 같은 방식).
      this._modeJson = JSON.stringify({ type: 'keyboardMode', mode: this.keyboardMode })
      this._wsSend(this._modeJson)

      this.log('STEP 8: 스트리밍 시작!')
    } catch (e) {
      this.log('ERROR: ' + e.message)
      this.running = false
      throw e
    }
  }

  // ── 서버 실행 ────────────────────────────────────────────────
  async _runServer(serial, ver, maxSize, videoBitrate, fps) {
    const args = [
      '-s', serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/',
      'com.genymobile.scrcpy.Server',
      ver,
      'log_level=verbose',
      `max_size=${maxSize || 0}`,
      `video_bit_rate=${(videoBitrate || 8) * 1_000_000}`,
      `max_fps=${fps || 60}`,
      'tunnel_forward=true',
      'send_frame_meta=true',   // ← 핵심 수정: 프레임 단위 메타데이터로 안정적 파싱
      'control=true',
      'video_codec=h264',
      'audio=false',
      'cleanup=true',
    ]

    this.log('server args: ' + args.slice(5).join(' '))
    this.srvProc = spawn(this.adbPath, args)

    const logLine = d => d.toString().split('\n').filter(Boolean).forEach(l => {
      this.log(l)
      // UHID 생성은 성공/실패가 비동기로 돌아오므로 서버 로그로 뒤늦게 감지해 되돌린다
      if (this.keyboardMode === 'uhid' && /uhid/i.test(l) && /error|fail|exception|denied/i.test(l)) {
        this.keyboardMode = 'clipboard'
        this.log('⚠ UHID 실패 감지 — 클립보드 방식으로 전환')
        this._wsSend(JSON.stringify({ type: 'keyboardMode', mode: 'clipboard' }))
      }
    })
    this.srvProc.stdout.on('data', logLine)
    this.srvProc.stderr.on('data', logLine)
    this.srvProc.on('close', code => {
      this.log(`server exited (${code})`)
      this.running = false
      this._wsSend(JSON.stringify({ type: 'stopped', code }))
    })

    // 서버 기동 대기
    // Device: 출력 이후 추가 1.5초 대기 — abstract socket 바인딩 완료까지 시간 필요
    await new Promise(res => {
      let done = false
      const finish = () => { if (!done) { done = true; res() } }
      const onData = d => {
        const s = d.toString()
        if (s.includes('Device:') || s.includes('READY') || s.includes('send_frame_meta')) {
          this.log('서버 준비 신호 감지 — 소켓 바인딩 대기 중 (1.5초)...')
          setTimeout(finish, 1500)  // abstract socket이 완전히 열릴 때까지 대기
        }
      }
      this.srvProc.stderr.on('data', onData)
      this.srvProc.stdout.on('data', onData)
      setTimeout(finish, 8000)  // 최대 8초 타임아웃
    })
    this.log('서버 기동 대기 완료')
  }

  // ── 소켓 연결 (재시도) ───────────────────────────────────────
  _connectWithRetry(maxTries = 15, delay = 800) {
    return new Promise((res, rej) => {
      let n = 0
      const attempt = () => {
        n++
        this.log(`소켓 연결 시도 ${n}/${maxTries}`)
        const videoSock = net.connect(this.forwardPort, '127.0.0.1')
        videoSock.setTimeout(3000)

        videoSock.on('connect', () => {
          videoSock.setTimeout(0)
          this.adbSock = videoSock
          this.log('비디오 소켓 연결 성공')

          // 즉시 제어 소켓 연결 시도
          const controlSock = net.connect(this.forwardPort, '127.0.0.1')
          controlSock.setTimeout(3000)

          controlSock.on('connect', () => {
            controlSock.setTimeout(0)
            this.controlSock = controlSock
            this.log('제어 소켓 연결 성공')

            this._pipe(videoSock)
            res()
          })

          const controlFail = e => {
            this.log(`제어 소켓 연결 실패: ${e?.message}`)
            controlSock.destroy()
            videoSock.destroy()
            if (!this.running) { rej(new Error('stopped')); return }
            if (n < maxTries) setTimeout(attempt, delay)
            else rej(new Error(`제어 소켓 ${maxTries}회 연결 실패: ${e?.message}`))
          }
          controlSock.on('error', controlFail)
          controlSock.on('timeout', () => controlFail(new Error('timeout')))
        })

        const fail = e => {
          videoSock.destroy()
          if (!this.running) { rej(new Error('stopped')); return }
          if (n < maxTries) setTimeout(attempt, delay)
          else rej(new Error(`비디오 소켓 ${maxTries}회 연결 실패: ${e?.message}`))
        }
        videoSock.on('error', fail)
        videoSock.on('timeout', () => fail(new Error('timeout')))
      }
      attempt()
    })
  }

  // ── v4.0 프로토콜 파싱 (send_frame_meta=true) → WebSocket 전송 ─────────────────────
  //
  // 헤더 구조 (실측 분석, SM-G991N / Android 15):
  //   deviceName  : 65 bytes (UTF-8, null-padded  ← v4.0 변경: 64 + 1 byte separator)
  //   codec_id    : 4 bytes  uint32 BE  (0x68323634 = "h264")
  //   flags       : 4 bytes  uint32 BE  ← session_meta 선두 (무시)
  //   width       : 4 bytes  uint32 BE  (offset 4)
  //   height      : 4 bytes  uint32 BE  (offset 8)
  //   → SESSION_META_LEN = 12 bytes
  //
  // 이후 프레임 (send_frame_meta=true):
  //   pts         : 8 bytes  int64 BE   (pts=0x4000... 등, config 패킷은 pts 특수값)
  //   size        : 4 bytes  uint32 BE
  //   data        : size bytes (H.264 access unit, Annex B 포맷)
  //
  _pipe(sock) {
    let state = 'deviceName'
    let buf = Buffer.alloc(0)
    let pendingFrameSize = 0
    const meta = {}

    // ── scrcpy 프로토콜 헤더 상수 ──────────────────────────────────────
    //   누적 65B 후 코덱(h264) 4B 수신 → device name field = 65 bytes
    //   session_meta 길이는 서버 빌드마다 달라서 상수로 두지 않는다 (parseSessionMeta 참고)
    const DEVICE_NAME_LEN = 65   // 더미 1B + 이름 64B
    const CODEC_ID_LEN = 4
    const SESSION_META_PEEK = 12  // 판별에 필요한 최대 길이
    const FRAME_HEADER_LEN = 12   // pts(8) + size(4)

    let totalReceived = 0

    sock.on('data', chunk => {
      totalReceived += chunk.length
      if (totalReceived <= 160) {
        this.log(`[raw] 수신 ${chunk.length}B (누적 ${totalReceived}B): ${chunk.slice(0, Math.min(20, chunk.length)).toString('hex')}`)
      }
      buf = Buffer.concat([buf, chunk])
      let go = true

      while (go) {
        switch (state) {

          case 'deviceName': {
            if (buf.length < DEVICE_NAME_LEN) { go = false; break }
            meta.deviceName = buf.subarray(0, DEVICE_NAME_LEN)
              .toString('utf8').replace(/\0/g, '').trim()
            this.log(`기기 이름: "${meta.deviceName}"`)
            buf = buf.subarray(DEVICE_NAME_LEN)
            state = 'codecId'
            break
          }

          case 'codecId': {
            if (buf.length < CODEC_ID_LEN) { go = false; break }
            const codecId = buf.readUInt32BE(0)
            meta.codec = codecId === H264_CODEC_ID ? 'h264' : `0x${codecId.toString(16)}`
            this.log(`코덱: ${meta.codec} (0x${codecId.toString(16)})`)
            buf = buf.subarray(CODEC_ID_LEN)
            state = 'sessionMeta'
            break
          }

          case 'sessionMeta': {
            if (buf.length < SESSION_META_PEEK) { go = false; break }
            const m = parseSessionMeta(buf)
            if (!m) {
              this.log(`해상도 파싱 실패 — 헤더 앞 12B: ${buf.subarray(0, 12).toString('hex')}`)
              sock.destroy()
              go = false
              break
            }
            meta.width = m.width
            meta.height = m.height
            this.log(`해상도: ${meta.width}×${meta.height} (meta ${m.consumed}B)`)
            buf = buf.subarray(m.consumed)
            state = 'frameHeader'
            this._metaJson = JSON.stringify({ type: 'meta', ...meta })
            this._frameCnt = 0
            this._wsSend(this._metaJson)
            break
          }

          case 'frameHeader': {
            if (buf.length < FRAME_HEADER_LEN) { go = false; break }
            // pts: int64 BE — BigInt으로 읽음 (pts=-1 이면 config 패킷)
            // const pts = buf.readBigInt64BE(0)  ← 사용하지 않으나 구조상 존재
            pendingFrameSize = buf.readUInt32BE(8)
            buf = buf.subarray(FRAME_HEADER_LEN)
            state = 'frameData'
            break
          }

          case 'frameData': {
            if (buf.length < pendingFrameSize) { go = false; break }
            // 완전한 H.264 access unit을 그대로 WS 클라이언트에 전송
            const frame = buf.subarray(0, pendingFrameSize)
            this._wsSend(Buffer.from(frame), true)
            this._frameCnt++
            if (this._frameCnt <= 5 || this._frameCnt % 30 === 0) {
              this.log(`프레임 #${this._frameCnt}: ${pendingFrameSize}B → WS client=${this.wsClient ? '연결됨' : '없음'}`)
            }
            buf = buf.subarray(pendingFrameSize)
            pendingFrameSize = 0
            state = 'frameHeader'
            break
          }

          default:
            go = false
        }
      }
    })

    sock.on('error', e => {
      this.log(`소켓 오류 (수신 누적 ${totalReceived}B): ${e.message}`)
      this._wsSend(JSON.stringify({ type: 'stopped', error: e.message }))
    })
    sock.on('close', () => {
      this.log(`소켓 종료 — 총 수신: ${totalReceived}B / 파싱 상태: ${state} / 서버 생존: ${this.srvProc != null && !this.srvProc.killed}`)
      if (this.running) this._wsSend(JSON.stringify({ type: 'stopped' }))
    })
  }

  // ── WebSocket 전송 ───────────────────────────────────────────
  _wsSend(data, binary = false) {
    const ws = this.wsClient
    if (!ws || ws.readyState !== 1) {
      if (!binary && this._frameCnt === 0) {
        this.log(`⚠ WS 전송 실패 (client=${ws ? 'state=' + ws.readyState : '없음'}): ${typeof data === 'string' ? data.slice(0, 80) : data.length + 'B binary'}`)
      }
      return
    }
    try { binary ? ws.send(data, { binary: true }) : ws.send(data) } catch (e) {
      this.log(`⚠ WS send 예외: ${e.message}`)
    }
  }

  injectTouch({ action, x, y, screenWidth, screenHeight }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const buf = Buffer.alloc(32)
    buf.writeUInt8(2, 0) // TYPE_INJECT_TOUCH_EVENT = 2
    buf.writeUInt8(action, 1) // action
    buf.writeBigInt64BE(-1n, 2) // pointerId
    buf.writeInt32BE(x, 10)
    buf.writeInt32BE(y, 14)
    buf.writeUInt16BE(screenWidth, 18)
    buf.writeUInt16BE(screenHeight, 20)
    buf.writeUInt16BE(action === 1 ? 0 : 0xffff, 22) // pressure
    buf.writeInt32BE(0, 24) // actionButton
    buf.writeInt32BE(action === 1 ? 0 : 1, 28) // buttons

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('터치 이벤트 전송 실패: ' + e.message)
    }
  }

  injectKeycode({ action, keycode }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const buf = Buffer.alloc(14)
    buf.writeUInt8(0, 0) // TYPE_INJECT_KEYCODE = 0
    buf.writeUInt8(action, 1) // action: 0=DOWN, 1=UP
    buf.writeInt32BE(keycode, 2)
    buf.writeInt32BE(0, 6) // repeat
    buf.writeInt32BE(0, 10) // metaState

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('키코드 이벤트 전송 실패: ' + e.message)
    }
  }

  injectText({ text }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const textBytes = Buffer.from(text, 'utf8')
    // TYPE_SET_CLIPBOARD = 9
    // sequence: 8 bytes (0n)
    // paste: 1 byte (1 = true)
    // length: 4 bytes
    // text: variable
    const buf = Buffer.alloc(14 + textBytes.length)
    buf.writeUInt8(9, 0) // TYPE_SET_CLIPBOARD = 9
    buf.writeBigInt64BE(0n, 1) // sequence: 0
    buf.writeUInt8(1, 9) // paste: true
    buf.writeUInt32BE(textBytes.length, 10) // length
    textBytes.copy(buf, 14) // text

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('텍스트 이벤트 전송 실패: ' + e.message)
    }
  }

  // 파일명에서만 버전을 찾는다. 전체 경로를 훑으면 상위 폴더명의 숫자(예: proj-v2.0)를
  // 버전으로 오인한다.
  // ── UHID (물리 키보드 에뮬레이션) ────────────────────────────
  //
  // 와이어 포맷은 scrcpy v4.1 태그의 app/src/control_msg.c 기준:
  //   UHID_CREATE (12): type(1) id(2BE) vendorId(2BE) productId(2BE)
  //                     nameLen(1) name descSize(2BE) desc
  //   UHID_INPUT  (13): type(1) id(2BE) size(2BE) data
  //   UHID_DESTROY(14): type(1) id(2BE)

  uhidCreate(maxUsage = hid.EXTENDED_MAX_USAGE) {
    if (!this.controlSock || this.controlSock.destroyed) return false
    const desc = hid.buildReportDesc(maxUsage)
    const name = Buffer.from(UHID_NAME, 'utf8')
    const buf = Buffer.alloc(8 + name.length + 2 + desc.length)
    let o = 0
    buf.writeUInt8(12, o); o += 1
    buf.writeUInt16BE(UHID_ID, o); o += 2
    buf.writeUInt16BE(UHID_VENDOR_ID, o); o += 2
    buf.writeUInt16BE(UHID_PRODUCT_ID, o); o += 2
    buf.writeUInt8(name.length, o); o += 1
    name.copy(buf, o); o += name.length
    buf.writeUInt16BE(desc.length, o); o += 2
    desc.copy(buf, o)
    try {
      this.controlSock.write(buf)
      this.log(`UHID 키보드 생성 요청 (desc ${desc.length}B, maxUsage 0x${maxUsage.toString(16)})`)
      return true
    } catch (e) {
      this.log('UHID 생성 실패: ' + e.message)
      return false
    }
  }

  uhidInput(report) {
    if (!this.controlSock || this.controlSock.destroyed) return
    const buf = Buffer.alloc(5 + report.length)
    buf.writeUInt8(13, 0)
    buf.writeUInt16BE(UHID_ID, 1)
    buf.writeUInt16BE(report.length, 3)
    report.copy(buf, 5)
    try { this.controlSock.write(buf) } catch (e) { this.log('UHID 입력 전송 실패: ' + e.message) }
  }

  uhidDestroy() {
    if (!this.controlSock || this.controlSock.destroyed) return
    const buf = Buffer.alloc(3)
    buf.writeUInt8(14, 0)
    buf.writeUInt16BE(UHID_ID, 1)
    try { this.controlSock.write(buf) } catch { }
  }

  // 화면 회전 토글. 예전 UI 는 '회전' 버튼에 KEYCODE_MENU(82) 를 연결해 두어 실제로는
  // 회전하지 않았다. scrcpy 의 ROTATE_DEVICE(11) 가 제대로 된 경로다.
  rotateDevice() {
    if (!this.controlSock || this.controlSock.destroyed) return
    try { this.controlSock.write(Buffer.from([11])) } catch (e) {
      this.log('회전 요청 실패: ' + e.message)
    }
  }

  // 단말의 물리 키보드 레이아웃 설정 화면을 연다. UHID 최초 사용 시 1회 필요하다.
  openHardKeyboardSettings() {
    if (!this.controlSock || this.controlSock.destroyed) return
    try { this.controlSock.write(Buffer.from([15])) } catch { }
  }

  _jarVer(p) {
    const m = path.basename(p || '').match(/v?(\d+\.\d+(?:\.\d+)?)/)
    return m ? m[1] : null
  }

  // 버전을 불가능한 값으로 주고 서버를 띄우면, 서버가 자기 버전을 에러에 실어 거부한다:
  //   "The server version (4.1) does not match the client (0)"
  // 이걸 되받아 실제 버전을 알아낸다. 릴리스마다 상수를 갱신할 필요가 없어진다.
  _probeJarVer(serial) {
    return new Promise(resolve => {
      execFile(this.adbPath, [
        '-s', serial, 'shell',
        'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
        'app_process', '/', 'com.genymobile.scrcpy.Server', '0',
      ], { timeout: 10000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}${err?.message || ''}`
        const m = out.match(/server version \((\d+\.\d+(?:\.\d+)?)\)/i)
        resolve(m ? m[1] : null)
      })
    })
  }

  // ── 중지 ─────────────────────────────────────────────────────
  async stop() {
    this.running = false
    if (this.keyboardMode === 'uhid') this.uhidDestroy()   // 소켓 닫기 전에 보내야 한다
    this.keyboardMode = 'clipboard'
    // 캐시를 비우지 않으면 다음 세션에서 이전 해상도/모드가 먼저 전송된다
    this._metaJson = null
    this._modeJson = null
    this.adbSock?.destroy(); this.adbSock = null
    this.controlSock?.destroy(); this.controlSock = null
    this.srvProc?.kill(); this.srvProc = null
    if (this.serial && this.forwardPort) {
      await this.adb(['-s', this.serial, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => { })
      this.serial = null
      this.forwardPort = null
    }
    this.log('중지됨')
  }

  destroy() {
    this.stop()
    this.wss?.close(); this.wss = null
  }
}

module.exports = MirrorBridge
module.exports.parseSessionMeta = parseSessionMeta

// ── 자가진단: node src/mirror-bridge.js ───────────────────────
if (require.main === module) {
  const assert = require('assert')
  const hex = s => Buffer.from(s.replace(/\s/g, ''), 'hex')

  // 실측값 1 — iMac / SM-G981N: 코덱 뒤가 곧바로 [w][h], 이어서 프레임 헤더 PTS(0x80000000)
  assert.deepStrictEqual(
    parseSessionMeta(hex('00000240 00000500 80000000')),
    { width: 576, height: 1280, consumed: 8 }, '8B 레이아웃(576×1280) 판별 실패')

  // 실측값 2 — 다운로드본 v4.1 / SM-G973N: 앞에 flags(0x80000000)가 붙는다
  assert.deepStrictEqual(
    parseSessionMeta(hex('80000000 0000025e 00000500')),
    { width: 606, height: 1280, consumed: 12 }, '12B 레이아웃(606×1280) 판별 실패')

  // 키프레임 PTS(0x40000000)가 뒤따르는 8B 형태도 같아야 한다
  assert.deepStrictEqual(
    parseSessionMeta(hex('00000240 00000500 40000000')),
    { width: 576, height: 1280, consumed: 8 })

  // 12B 미만이면 판단하지 않는다 (더 받아야 한다)
  assert.strictEqual(parseSessionMeta(hex('00000240 00000500')), null)

  // 양쪽 다 말이 안 되면 null — 호출부가 세션을 끊어 조용한 오작동을 막는다
  assert.strictEqual(parseSessionMeta(hex('80000000 80000000 80000000')), null)
  // flags 가 0 이어도 (0 은 해상도가 될 수 없으므로) 12B 로 넘어가야 한다
  assert.deepStrictEqual(
    parseSessionMeta(hex('00000000 0000025e 00000500')),
    { width: 606, height: 1280, consumed: 12 })

  console.log('mirror-bridge 자가진단 통과 — session_meta 8B/12B 레이아웃 판별')
}
