const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, nativeImage } = require('electron')
const path = require('path')
const { spawn, execFile, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const MirrorBridge = require('./mirror-bridge')
const iosDevice = require('./ios-device')
const CertManager = require('./cert-manager')
const ProxyServer = require('./proxy-server')
const jira = require('./jira')

const isDev = process.argv.includes('--dev')
let binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', 'bin')

if (app.isPackaged) {
  try {
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })
    fs.accessSync(binDir, fs.constants.W_OK)
  } catch (e) {
    const userBin = path.join(app.getPath('userData'), 'bin')
    if (!fs.existsSync(userBin)) fs.mkdirSync(userBin, { recursive: true })
    
    if (fs.existsSync(binDir)) {
      fs.readdirSync(binDir).forEach(f => {
        const src = path.join(binDir, f)
        const dst = path.join(userBin, f)
        if (!fs.existsSync(dst)) {
          try { fs.copyFileSync(src, dst) } catch(err) {}
        }
      })
    }
    binDir = userBin
  }
}

const platform = process.platform
const adbBin = platform === 'win32' ? 'adb.exe' : 'adb'

// ── 바이너리 자동 탐색: bin/ 폴더 → 시스템 PATH 순서로 검색 ──
function resolveBin(name) {
  const cleanName = name.replace('.exe', '')
  const local = path.join(binDir, name)
  if (fs.existsSync(local)) return local

  // macOS / Linux - GUI 환경에서 터미널 PATH($PATH) 유실 문제 보완을 위해 표준 설치 경로 직접 탐색
  if (platform === 'darwin' || platform === 'linux') {
    const standardPaths = [
      `/opt/homebrew/bin/${cleanName}`, // Apple Silicon Homebrew
      `/usr/local/bin/${cleanName}`,    // Intel Mac Homebrew / Standard Local
      `/usr/bin/${cleanName}`,
      `/bin/${cleanName}`,
    ]
    for (const p of standardPaths) {
      if (fs.existsSync(p)) return p
    }
  }

  try {
    const cmd = platform === 'win32' ? `where ${name}` : `which ${cleanName}`
    const found = execSync(cmd, { encoding: 'utf8' }).split('\n')[0].trim()
    if (found && fs.existsSync(found)) return found
  } catch { }
  return null
}


let adbPath = resolveBin(adbBin)

let mainWindow = null
let mirror = null   // MirrorBridge 인스턴스
let recordingProcess = null
let proxyServer = null
let certManager = null

// 미러링 로그를 파일로도 남긴다. 사용자가 "안 된다"고 할 때 이 파일 하나면 원인이
// 잡힌다. 앱 시작마다 비우므로 한 세션치를 넘어 자라지 않는다.
const MIRROR_LOG = path.join(app.getPath('userData'), 'mirror.log')
try { fs.writeFileSync(MIRROR_LOG, '') } catch { }

// 미러링 로그 채널. 화면 패널과 로그 파일 양쪽으로 보낸다.
function logMirror(msg) {
  mainWindow?.webContents.send('mirror:log', msg)
  try { fs.appendFileSync(MIRROR_LOG, `${new Date().toISOString()} ${msg}\n`) } catch { }
}

function getMirror() {
  if (!mirror) {
    mirror = new MirrorBridge({ adbPath, binDir, onLog: logMirror })
  }
  return mirror
}

// ── 윈도우 생성 ────────────────────────────────────────────────
// 실행 크기이자 최소 크기. 화면이 작으면 작업 영역에 맞춰 줄인다 — 안 그러면 최소 크기가
// 화면보다 커져 창을 아예 못 쓴다.
function pickLaunchSize() {
  try {
    const { screen } = require('electron')
    const avail = screen.getPrimaryDisplay().workAreaSize
    return {
      width: Math.min(1600, Math.max(1100, avail.width - 60)),
      height: Math.min(900, Math.max(600, avail.height - 60)),
    }
  } catch {
    return { width: 1600, height: 900 }
  }
}

// 처음 뜬 창 너비 = 최소 너비의 하한. 렌더러가 레이아웃을 재서 더 큰 값을 요구할 수는
// 있어도(디바이스가 넓으면) 이보다 좁게는 못 내려간다.
let launchWidth = 0

function createWindow() {
  const launch = pickLaunchSize()
  launchWidth = launch.width
  mainWindow = new BrowserWindow({
    // 처음 뜬 크기를 그대로 최소 크기로 삼는다 — 가로·세로 모두 더 줄일 수 없다.
    // (가로 최소치는 레이아웃이 더 넓게 요구하면 window:set-min-size 로 올라가기만 한다)
    width: launch.width, height: launch.height,
    minWidth: launch.width, minHeight: launch.height,
    autoHideMenuBar: true,   // Alt 를 눌러도 메뉴바가 나타나지 않게
    backgroundColor: '#0e0e10',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 렌더러 예외는 DevTools 에만 남아 조용히 사라진다(핸들러가 통째로 죽어도 UI 는
  // 멀쩡해 보인다). 경고 이상을 로그 파일로 끌어내 원인 추적이 가능하게 한다.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    try {
      fs.appendFileSync(MIRROR_LOG,
        `${new Date().toISOString()} [renderer] ${message}  (${sourceId}:${line})\n`)
    } catch { }
  })

  // 상단 메뉴바(File/Edit/View/…)를 화면에서만 감춘다. 메뉴 자체는 살아 있어서
  // Ctrl+R(새로고침) 같은 기본 단축키는 그대로 동작한다.
  // 다시 보이게 하려면 아래 한 줄을 주석 처리하면 된다.
  mainWindow.setMenuBarVisibility(false)

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'))
  if (isDev) mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => {
    mirror?.destroy()
    stopLogcat()   // 창이 닫혀도 adb logcat 이 남아 돌지 않게
    mainWindow = null
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── ADB 유틸 ──────────────────────────────────────────────────
function runAdb(args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message)
      else resolve(stdout.trim())
    })
  })
}

// ── IPC 핸들러들 ──────────────────────────────────────────────

// 기기 목록
ipcMain.handle('adb:devices', async () => {
  try {
    const out = await runAdb(['devices', '-l'])
    return out.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('List of devices'))
      // 상태가 'device'인 줄만 (offline/unauthorized 제외)
      .filter(l => /\s+device\b/.test(l))
      .map(line => {
        const parts = line.split(/\s+/)
        const serial = parts[0]
        const model = (line.match(/model:(\S+)/) || [])[1] || serial
        const product = (line.match(/product:(\S+)/) || [])[1] || ''
        return { serial, model: model.replace(/_/g, ' '), product }
      })
  } catch { return [] }
})

// Wi-Fi 연결
ipcMain.handle('adb:connect', async (_, ip, port = 5555) => {
  try {
    const r = await runAdb(['connect', `${ip}:${port}`])
    return { ok: r.includes('connected'), message: r }
  } catch (e) { return { ok: false, message: String(e) } }
})

// Wi-Fi(TCP) 연결 해제. USB 는 끊는 개념이 없어 이 호출이 필요 없다.
ipcMain.handle('adb:disconnect', async (_, target) => {
  try {
    return { ok: true, message: await runAdb(['disconnect', target]) }
  } catch (e) { return { ok: false, message: String(e) } }
})

// ── 미러링 IPC (MirrorBridge 사용) ────────────────────────────
ipcMain.handle('mirror:start', async (_, { serial, maxSize, videoBitrate, fps }) => {
  try {
    adbPath = resolveBin(adbBin) // 재탐색 (setup 이후 변경 대응)
    await getMirror().start({ serial, maxSize, videoBitrate, fps })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e.message }
  }
})

ipcMain.handle('mirror:stop', async () => {
  await mirror?.stop()
  return { ok: true }
})

ipcMain.handle('mirror:init', async () => {
  return await getMirror().startWss()
})

// ── 화면 캡처 ──────────────────────────────────────────────────
// 미리보기 → 저장/취소 흐름이라 캡처 시점에는 파일을 만들지 않는다.
// 버퍼를 들고 있다가 사용자가 '저장'을 누를 때만 디스크에 쓴다.
let lastCapture = null

// exec-out 은 PNG 를 stdout 으로 바로 준다 — sdcard 경유·pull·rm 이 전부 불필요하다
function screencap(serial) {
  return new Promise(resolve => {
    const proc = spawn(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'])
    const chunks = []
    let err = ''
    proc.stdout.on('data', d => chunks.push(d))
    proc.stderr.on('data', d => { err += d })
    proc.on('error', e => resolve({ ok: false, message: `adb 실행 실패: ${e.message}` }))
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      if (buf.length < 8 || buf.subarray(1, 4).toString() !== 'PNG') {
        resolve({ ok: false, message: err.trim() || '캡처 결과가 PNG 가 아닙니다' })
        return
      }
      resolve({ ok: true, buf })
    })
  })
}

ipcMain.handle('adb:screenshot', async (_, serial) => {
  const r = await screencap(serial)
  if (!r.ok) return r
  lastCapture = r.buf
  return { ok: true, dataUrl: 'data:image/png;base64,' + r.buf.toString('base64') }
})

ipcMain.handle('capture:save', async () => {
  if (!lastCapture) return { ok: false, message: '저장할 캡처가 없습니다' }
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '캡처 저장',
    defaultPath: `screenshot_${Date.now()}.png`,
    filters: [{ name: 'PNG 이미지', extensions: ['png'] }],
  })
  if (!filePath) return { ok: false, canceled: true }
  try {
    fs.writeFileSync(filePath, lastCapture)
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 이미지 클립보드는 렌더러의 ClipboardItem 보다 Electron 네이티브 쪽이 확실하다
// (버퍼가 이미 메인에 있어서 왕복도 없다)
ipcMain.handle('capture:copy', () => {
  if (!lastCapture) return { ok: false, message: '복사할 캡처가 없습니다' }
  const img = nativeImage.createFromBuffer(lastCapture)
  if (img.isEmpty()) return { ok: false, message: '이미지를 읽지 못했습니다' }
  clipboard.writeImage(img)
  return { ok: true }
})

ipcMain.handle('capture:discard', () => { lastCapture = null; return { ok: true } })

// ── Jira ───────────────────────────────────────────────────────
// API 토큰은 OS 키체인(Windows 는 DPAPI)으로 암호화해 userData 에 둔다. 평문으로 굴리면
// userData 를 읽을 수 있는 아무 프로세스나 계정 토큰을 가져갈 수 있다.
// 토큰은 렌더러로 절대 돌려보내지 않는다 — 저장 여부(hasToken)만 알려준다.
const JIRA_CFG = path.join(app.getPath('userData'), 'jira.json')

function loadJiraCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(JIRA_CFG, 'utf8'))
    c.site = c.site || jira.DEFAULT_SITE       // 사이트는 입력받지 않고 고정값을 쓴다
    if (c.token) {
      if (c.enc && safeStorage.isEncryptionAvailable()) {
        try { c.token = safeStorage.decryptString(Buffer.from(c.token, 'base64')) } catch { c.token = '' }
      }
    }
    return c
  } catch { return { site: jira.DEFAULT_SITE } }
}

function saveJiraCfg(cfg) {
  const out = { ...cfg, enc: false }
  if (out.token && safeStorage.isEncryptionAvailable()) {
    out.token = safeStorage.encryptString(out.token).toString('base64')
    out.enc = true
  }
  fs.writeFileSync(JIRA_CFG, JSON.stringify(out, null, 2), { mode: 0o600 })
}

ipcMain.handle('jira:load', () => {
  const c = loadJiraCfg()
  return {
    site: c.site || '', email: c.email || '',
    project: c.project || '', projectName: c.projectName || '',
    issueType: c.issueType || '버그',
    fieldDefs: c.fieldDefs || [], fieldValues: c.fieldValues || {},
    hasToken: !!c.token, encrypted: !!c.enc,
  }
})

// token 이 빈 문자열이면 기존 토큰을 그대로 둔다 (설정만 고칠 때 매번 다시 넣지 않도록)
ipcMain.handle('jira:save', (_, cfg) => {
  const prev = loadJiraCfg()
  // 빈 값은 '안 보냈다'는 뜻으로 본다 — 연결 테스트 전이라 아직 못 고른 항목이 기존 설정을 지우면 안 된다
  const keep = (v, old) => (v === undefined || v === '' ? old : v)
  const next = {
    site: keep(cfg.site, prev.site), email: keep(cfg.email, prev.email),
    project: keep(cfg.project, prev.project), projectName: keep(cfg.projectName, prev.projectName),
    issueType: keep(cfg.issueType, prev.issueType), token: keep(cfg.token, prev.token),
    // 고정 필드는 '없애기'도 가능해야 하므로 보낸 그대로 덮어쓴다
    fieldDefs: cfg.fieldDefs ?? prev.fieldDefs, fieldValues: cfg.fieldValues ?? prev.fieldValues,
  }
  try {
    saveJiraCfg(next)
    return { ok: true, encrypted: safeStorage.isEncryptionAvailable() }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

ipcMain.handle('jira:test', () => jira.testConn(loadJiraCfg()))

ipcMain.handle('jira:ping', () => jira.pingAuth(loadJiraCfg()))

ipcMain.handle('jira:issue-types', (_, projectKey) => jira.listIssueTypes(loadJiraCfg(), projectKey))


ipcMain.handle('jira:assignable', (_, { projectKey, query }) =>
  jira.searchAssignable(loadJiraCfg(), projectKey, query))

ipcMain.handle('jira:fields', (_, { projectKey, issueTypeId }) =>
  jira.listCreateFields(loadJiraCfg(), projectKey, issueTypeId))

ipcMain.handle('jira:create', async (_, issue) => {
  const cfg = loadJiraCfg()
  // 등록 팝업에서 고른 추가 필드를 Jira 모양으로 바꿔 같이 보낸다
  const extra = jira.buildExtraFields(issue.fieldDefs, issue.fieldValues)
  if (issue.assigneeId) extra.assignee = { accountId: issue.assigneeId }
  const r = await jira.createIssue(cfg, { ...issue, project: issue.project || cfg.project, extra })
  if (!r.ok) return r

  // 이슈는 이미 만들어졌으니, 첨부가 실패해도 성공으로 돌려주고 사유만 같이 준다
  if (issue.attachShot && issue.serial) {
    const shot = await screencap(issue.serial)
    if (shot.ok) {
      const a = await jira.attachFile(cfg, r.key, `screenshot_${Date.now()}.png`, shot.buf)
      if (!a.ok) r.warn = '스크린샷 첨부 실패: ' + a.message
    } else {
      r.warn = '스크린샷 촬영 실패: ' + shot.message
    }
  }
  if (issue.attachLog && issue.logText) {
    const a = await jira.attachFile(cfg, r.key, `logcat_${Date.now()}.txt`,
      Buffer.from(issue.logText, 'utf8'))
    if (!a.ok) r.warn = (r.warn ? r.warn + ' / ' : '') + '로그 첨부 실패: ' + a.message
  }
  if (issue.videoPath) {
    try {
      const buf = fs.readFileSync(issue.videoPath)
      const a = await jira.attachFile(cfg, r.key, path.basename(issue.videoPath), buf)
      if (!a.ok) r.warn = (r.warn ? r.warn + ' / ' : '') + '영상 첨부 실패: ' + a.message
    } catch (e) {
      r.warn = (r.warn ? r.warn + ' / ' : '') + '영상 파일을 읽지 못했습니다: ' + e.message
    }
  }
  return r
})

// 외부 브라우저로 여는 주소는 Atlassian 것만 허용한다 (이슈 링크 + 토큰 발급 페이지)
ipcMain.handle('jira:open', (_, url) => {
  if (!/^https:\/\/([\w.-]+\.atlassian\.net|id\.atlassian\.com)\//.test(url || '')) return { ok: false }
  shell.openExternal(url)
  return { ok: true }
})

// 디바이스와 LogCat 이 잘리지 않는 선까지만 창을 줄일 수 있게 한다. 필요한 크기는 렌더러가
// 실제 레이아웃을 재서 넘겨준다(디바이스 너비가 창 높이에 따라 달라지기 때문).
// 최소 '너비'만 갱신한다. 최소 높이는 실행 시 높이로 고정되어 있으므로 건드리지 않는다.
ipcMain.handle('window:set-min-size', (_, width) => {
  if (!mainWindow || !Number.isFinite(width)) return { ok: false }
  // 렌더러가 보내는 값은 '콘텐츠' 기준인데 setMinimumSize 는 창 테두리를 포함한 크기다.
  // 그 차이를 안 더하면 콘텐츠가 그만큼 모자라 마지막 컬럼이 창 끝에 붙는다.
  const [winW] = mainWindow.getSize()
  const [contentW] = mainWindow.getContentSize()
  const frameW = Math.max(0, winW - contentW)

  // 실행 시 너비가 하한이다 — 레이아웃이 더 넓게 요구할 때만 올라간다.
  const w = Math.max(launchWidth, Math.round(width) + frameW)
  const [, minH] = mainWindow.getMinimumSize()
  mainWindow.setMinimumSize(w, minH)
  // 이미 그보다 좁으면 넓혀 준다 (setMinimumSize 만으로는 기존 창이 안 바뀐다)
  const [cw, ch] = mainWindow.getSize()
  if (cw < w) mainWindow.setSize(w, ch)
  return { ok: true, frameW }
})

// 녹화 시작
ipcMain.handle('adb:record-start', async (_, { serial, bitrate, size }) => {
  const args = ['-s', serial, 'shell', 'screenrecord',
    '--bit-rate', String((bitrate || 4) * 1000000),
    '--time-limit', '180'] // screenrecord 최대 한도 (3분). 그 이상은 자동 종료됨
  if (size) args.push('--size', size)
  args.push('/sdcard/_db_rec.mp4')
  recordingProcess = spawn(adbPath, args)
  recordingProcess.on('close', () => { recordingProcess = null })
  return { ok: true }
})

// SIGINT 를 받은 screenrecord 가 mdat flush → moov atom 기록 → mdat 크기 패치까지
// 마치고 스스로 종료할 때까지 대기한다. 여기서 로컬 adb 를 먼저 kill 하면 shell 세션이
// 끊기며 그 마무리가 중단되어 moov 없는 미완결 mp4(재생 불가)가 남는다.
// ponytail: pkill 이 실패하면 타임아웃까지 기다린 뒤 강제 종료 — 그 경우 파일은 여전히
// 깨진다. 필요해지면 pkill 성공 여부를 확인해 사용자에게 알리는 쪽으로 올릴 것.
function waitRecordingExit(timeoutMs = 15000) {
  const proc = recordingProcess
  if (!proc) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => { proc.kill(); resolve() }, timeoutMs)
    proc.once('close', () => { clearTimeout(timer); resolve() })
  })
}

// 녹화 중지 + 저장
ipcMain.handle('adb:record-stop', async (_, serial) => {
  try {
    // 기기에서 실행 중인 screenrecord 프로세스에 SIGINT 전송 (정상 종료 → 파일 무결성 보장)
    await runAdb(['-s', serial, 'shell', 'pkill', '-2', 'screenrecord']).catch(() => { })
    await waitRecordingExit()
    recordingProcess = null
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '녹화 파일 저장',
      defaultPath: `recording_${Date.now()}.mp4`,
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    })
    if (!filePath) return { ok: false, message: '취소됨' }
    await runAdb(['-s', serial, 'pull', '/sdcard/_db_rec.mp4', filePath])
    await runAdb(['-s', serial, 'shell', 'rm', '/sdcard/_db_rec.mp4'])
    return { ok: true, path: filePath }
  } catch (e) { return { ok: false, message: String(e) } }
})

// APK 선택 다이얼로그
ipcMain.handle('dialog:openApk', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'APK 파일 선택',
    filters: [{ name: 'APK', extensions: ['apk', 'xapk'] }],
    properties: ['openFile', 'multiSelections'],
  })
  return filePaths || []
})

// 일반 파일 선택 다이얼로그 (파일 전송용)
ipcMain.handle('dialog:openFile', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '파일 선택 (Android로 전송)',
    properties: ['openFile', 'multiSelections'],
  })
  return filePaths || []
})

ipcMain.handle('dialog:openVideo', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '첨부할 영상 선택',
    properties: ['openFile'],
    filters: [{ name: '영상', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'gif'] }],
  })
  return (filePaths && filePaths[0]) || ''
})

// APK 설치
ipcMain.handle('adb:install', (_, { serial, apkPath }) => {
  return new Promise(resolve => {
    const proc = spawn(adbPath, ['-s', serial, 'install', '-r', apkPath])
    let output = ''
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    proc.stdout.on('data', d => { output += d; mainWindow?.webContents.send('adb:install-log', output) })
    proc.stderr.on('data', d => { output += d })
    // 핸들러가 없으면 spawn 실패 시 처리되지 않은 'error' 로 메인 프로세스가 죽고,
    // resolve 도 안 되어 렌더러는 영영 "설치 중" 상태로 남는다.
    proc.on('error', e => finish({ ok: false, output: `adb 실행 실패: ${e.message}` }))
    proc.on('close', () => finish({ ok: output.includes('Success'), output }))
  })
})

// 파일 push (PC → 기기)
ipcMain.handle('adb:push', async (_, { serial, localPath, remotePath }) => {
  try {
    return { ok: true, result: await runAdb(['-s', serial, 'push', localPath, remotePath]) }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 파일 pull (기기 → PC)
ipcMain.handle('adb:pull', async (_, { serial, remotePath }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.basename(remotePath),
    })
    if (!filePath) return { ok: false }
    await runAdb(['-s', serial, 'pull', remotePath, filePath])
    return { ok: true, path: filePath }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 클립보드 전송
ipcMain.handle('adb:clipboard-send', async (_, { serial, text }) => {
  try {
    const escaped = text.replace(/'/g, "'\\''")
    await runAdb(['-s', serial, 'shell', `am broadcast -a clipper.set -e text '${escaped}'`])
    return { ok: true }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 클립보드 가져오기
ipcMain.handle('adb:clipboard-get', async (_, serial) => {
  try {
    return { ok: true, text: await runAdb(['-s', serial, 'shell', 'clipper']) }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 키 이벤트
ipcMain.handle('adb:keyevent', async (_, { serial, keycode }) => {
  try {
    await runAdb(['-s', serial, 'shell', 'input', 'keyevent', String(keycode)]); return { ok: true }
  } catch (e) { return { ok: false, message: String(e) } }
})

// 현재 액티비티(화면명) 조회
ipcMain.handle('adb:current-activity', async (_, serial) => {
  try {
    let out = await runAdb(['-s', serial, 'shell', 'dumpsys window displays'])
    let match = out.match(/mCurrentFocus=Window\{[^\s]+\s+[^\s]+\s+([^\s\}]+)/)
    if (match && match[1] && match[1] !== 'null') {
      return { ok: true, activity: match[1] }
    }

    out = await runAdb(['-s', serial, 'shell', 'dumpsys activity activities'])
    match = out.match(/mResumedActivity:.*?([a-zA-Z0-9_\.]+\/[a-zA-Z0-9_\.]+)/)
    if (match && match[1]) {
      return { ok: true, activity: match[1] }
    }

    out = await runAdb(['-s', serial, 'shell', 'dumpsys activity top'])
    match = out.match(/ACTIVITY\s+([a-zA-Z0-9_\.]+\/[a-zA-Z0-9_\.]+)/)
    if (match && match[1]) {
      return { ok: true, activity: match[1] }
    }

    return { ok: false, message: 'Not found' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 현재 액티비티 상세 정보 조회
ipcMain.handle('adb:activity-info', async (_, { serial, activityName }) => {
  try {
    const out = await runAdb(['-s', serial, 'shell', `dumpsys activity ${activityName}`])
    return { ok: true, info: out }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// ── 현재 앱 / 기기 정보 ────────────────────────────────────────

// 포그라운드 앱의 버전과 PID. PID 는 LogCat 을 이 앱만 보이게 거르는 데 쓴다.
ipcMain.handle('app:info', async (_, { serial, pkg }) => {
  if (!pkg) return { ok: false, message: '패키지를 알 수 없습니다' }
  try {
    const out = await runAdb(['-s', serial, 'shell', 'dumpsys', 'package', pkg])
    const pick = re => (out.match(re) || [])[1] || null
    // pidof 는 앱이 안 떠 있으면 비어 있다 — 실패해도 정보 조회는 계속한다
    const pid = await runAdb(['-s', serial, 'shell', 'pidof', '-s', pkg]).catch(() => '')
    return {
      ok: true,
      pkg,
      versionName: pick(/versionName=(\S+)/),
      versionCode: pick(/versionCode=(\d+)/),
      lastUpdate: pick(/lastUpdateTime=(.+)/),
      pid: (pid || '').trim() || null,
    }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 현재 앱에 대한 동작. QA 에서 손이 가장 자주 가는 것들만 추렸다.
const APP_ACTIONS = {
  'force-stop': pkg => ['shell', 'am', 'force-stop', pkg],
  'clear': pkg => ['shell', 'pm', 'clear', pkg],
  'restart': pkg => ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
  'settings': pkg => ['shell', 'am', 'start', '-a',
    'android.settings.APPLICATION_DETAILS_SETTINGS', '-d', 'package:' + pkg],
}

ipcMain.handle('app:action', async (_, { serial, pkg, action }) => {
  const build = APP_ACTIONS[action]
  if (!build || !pkg) return { ok: false, message: '알 수 없는 동작입니다' }
  try {
    const out = await runAdb(['-s', serial, ...build(pkg)])

    // pm clear 는 데이터를 지우면서 앱을 죽인다. QA 흐름에서는 지운 직후 다시 띄워
    // 초기 상태를 보는 일이 대부분이라 바로 실행까지 이어준다.
    // (clear 직후에는 패키지가 아직 준비되지 않아 잠깐 기다려야 monkey 가 먹는다)
    if (action === 'clear') {
      await new Promise(r => setTimeout(r, 700))
      await runAdb(['-s', serial, ...APP_ACTIONS.restart(pkg)]).catch(() => { })
    }
    return { ok: true, output: out }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 전화번호. iphonesubinfo 의 트랜잭션 번호는 Android 버전마다 달라서 몇 개를 훑는다.
// 응답은 바인더 parcel 덤프라 '...' 조각을 이어 붙여야 문자열이 나온다.
// SIM 에 번호가 안 적힌 기기도 흔해서 못 읽는 게 정상인 경우도 많다.
async function readPhoneNumber(serial) {
  for (const code of [15, 19, 16, 13]) {
    try {
      const out = await runAdb(['-s', serial, 'shell', 'service', 'call', 'iphonesubinfo', String(code)], 8000)
      const joined = (out.match(/'[^']*'/g) || []).join('')
      const num = joined.replace(/[^\d+]/g, '')
      if (/^\+?\d{9,15}$/.test(num)) return num
    } catch { }
  }
  return null
}

// 티켓에 붙일 환경 정보. getprop 한 번으로 대부분 나온다.
ipcMain.handle('device:info', async (_, serial) => {
  try {
    const props = await runAdb(['-s', serial, 'shell', 'getprop'])
    const p = k => (props.match(new RegExp('\\[' + k + '\\]: \\[(.*?)\\]')) || [])[1] || null
    const size = await runAdb(['-s', serial, 'shell', 'wm', 'size']).catch(() => '')
    const density = await runAdb(['-s', serial, 'shell', 'wm', 'density']).catch(() => '')
    const battery = await runAdb(['-s', serial, 'shell', 'dumpsys', 'battery']).catch(() => '')
    const phone = await readPhoneNumber(serial)
    return {
      ok: true,
      model: p('ro.product.model'),
      manufacturer: p('ro.product.manufacturer'),
      release: p('ro.build.version.release'),
      sdk: p('ro.build.version.sdk'),
      buildId: p('ro.build.display.id'),
      serial,
      // Override 가 있으면 그게 실제 사용 해상도다 (Physical 은 패널 원본)
      resolution: (size.match(/Override size:\s*(\S+)/) || size.match(/Physical size:\s*(\S+)/) || [])[1] || null,
      density: (density.match(/Physical density:\s*(\S+)/) || [])[1] || null,
      battery: (battery.match(/level:\s*(\d+)/) || [])[1] || null,
      phone,
    }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// ── LogCat 스트리밍 ────────────────────────────────────────────
let logcatProcess = null

// Android logcat 과 iOS syslog 는 같은 logcat:data 채널을 쓴다. 둘이 동시에
// 흐르면 두 기기 로그가 섞이므로 한쪽을 멈출 때 다른 쪽도 같이 멈춘다.
function stopLogcat() {
  if (logcatProcess) { logcatProcess.kill(); logcatProcess = null }
  ios?.stopSyslog()
}

ipcMain.handle('logcat:start', async (_, serial) => {
  stopLogcat()
  try {
    // -T 200: 버퍼 전체(수만 줄)가 아니라 최근 200줄부터 흘린다
    const proc = spawn(adbPath, ['-s', serial, 'logcat', '-v', 'threadtime', '-T', '200'])
    logcatProcess = proc
    const send = d => mainWindow?.webContents.send('logcat:data', d.toString())
    proc.stdout.on('data', send)
    proc.stderr.on('data', send)
    // 핸들러가 없으면 spawn 실패 시 처리되지 않은 'error' 로 메인 프로세스가 죽는다
    proc.on('error', e => {
      mainWindow?.webContents.send('logcat:data', `[logcat 실행 실패] ${e.message}\n`)
      if (logcatProcess === proc) logcatProcess = null
      mainWindow?.webContents.send('logcat:stopped')
    })
    proc.on('close', () => {
      if (logcatProcess === proc) logcatProcess = null
      mainWindow?.webContents.send('logcat:stopped')
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

ipcMain.handle('logcat:stop', async () => {
  stopLogcat()
  return { ok: true }
})

// ── iOS (libimobiledevice) ────────────────────────────────────
// 화면·입력은 다루지 않는다. 화면은 AirPlay 수신기 창을 렌더러가 desktopCapturer 로
// 가져오고, 입력은 iOS 에 주입 경로가 없다 (WebDriverAgent 는 별도 과제).
let ios = null
function getIos() {
  if (!ios) ios = iosDevice.create({ resolveBin, onLog: logMirror })
  return ios
}

ipcMain.handle('ios:devices', () => getIos().devices())
ipcMain.handle('ios:info', (_, udid) => getIos().info(udid))

// syslog 는 모듈에서 logcat threadtime 형식으로 변환되어 나오므로 **기존
// logcat:data / logcat:stopped 채널을 그대로 쓴다.** 렌더러의 LogCat 패널과
// 필터·검색이 손대지 않고 동작하고, 새 리스너를 등록할 일도 없다.
ipcMain.handle('ios:syslog-start', (_, { udid, process: proc, quiet }) => {
  stopLogcat()   // Android logcat 과 동시에 흐르면 두 기기 로그가 섞인다
  return getIos().startSyslog(udid, { process: proc, quiet },
    chunk => mainWindow?.webContents.send('logcat:data', chunk),
    () => mainWindow?.webContents.send('logcat:stopped'))
})

ipcMain.handle('ios:syslog-stop', () => getIos().stopSyslog())

// 지금 화면에 보이는 로그(필터 적용분)를 txt 로 저장한다. 내용은 렌더러가 만들어 넘긴다.
ipcMain.handle('logcat:save', async (_, text) => {
  if (!text) return { ok: false, message: '저장할 로그가 없습니다' }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'LogCat 저장',
    defaultPath: `logcat_${stamp}.txt`,
    filters: [{ name: '텍스트 파일', extensions: ['txt'] }],
  })
  if (!filePath) return { ok: false, canceled: true }
  try {
    fs.writeFileSync(filePath, text, 'utf8')
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// ── 세팅 체크 ──────────────────────────────────────────────────
ipcMain.handle('setup:check', async () => {
  adbPath = resolveBin(adbBin)  // 재탐색

  let adbVersion = null, deviceCount = 0
  const serverJarExists = fs.existsSync(path.join(binDir, 'scrcpy-server'))

  if (adbPath) {
    try { adbVersion = (await runAdb(['--version'])).split('\n')[0] } catch { }
    try {
      const out = await runAdb(['devices'])
      deviceCount = out.split('\n').slice(1).filter(l => /\s+device\b/.test(l.trim())).length
    } catch { }
  }
  return {
    adb: { found: !!adbPath, path: adbPath, version: adbVersion },
    scrcpy: { found: true, version: `server jar ${serverJarExists ? '있음(캐시)' : '없음(자동 다운로드)'}` },
    deviceCount,
    platform,
  }
})

// ── 패킷 분석 프록시 IPC ────────────────────────────────────────
ipcMain.handle('proxy:start', async (_, port) => {
  try {
    if (proxyServer) await proxyServer.stop()

    const certDir = path.join(app.getPath('userData'), 'proxy-certs')
    certManager = new CertManager(certDir)
    proxyServer = new ProxyServer(certManager, (packet) => {
      mainWindow?.webContents.send('proxy:packet', packet)
    })
    const actualPort = await proxyServer.start(port || 8888)
    return { ok: true, port: actualPort }
  } catch (e) {
    return { ok: false, message: e.message }
  }
})

ipcMain.handle('proxy:stop', async () => {
  if (proxyServer) {
    await proxyServer.stop()
    proxyServer = null
  }
  return { ok: true }
})

// 기기에 프록시 설정 (ADB)
ipcMain.handle('proxy:setup-device', async (_, { serial, proxyPort }) => {
  try {
    // PC의 로컬 IP 획득
    const nets = os.networkInterfaces()
    let pcIp = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          pcIp = net.address
          break
        }
      }
    }
    await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', `${pcIp}:${proxyPort}`])
    return { ok: true, pcIp, proxyPort }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// 기기에서 프록시 해제
ipcMain.handle('proxy:clear-device', async (_, serial) => {
  try {
    await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// CA 인증서를 기기에 push
ipcMain.handle('proxy:install-cert', async (_, serial) => {
  try {
    if (!certManager) {
      const certDir = path.join(app.getPath('userData'), 'proxy-certs')
      certManager = new CertManager(certDir)
    }
    const certPath = certManager.getCACertPath()
    await runAdb(['-s', serial, 'push', certPath, '/sdcard/Download/DroidBridge_CA.crt'])
    // 인증서 파일 경로 권한(Scoped Storage) 문제 회피를 위해, Android 내장 '인증서 설치 파일 선택기' 호출
    await runAdb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.credentials.INSTALL'])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})

// PC의 로컬 IP 조회
ipcMain.handle('proxy:get-pc-ip', async () => {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
})

// APK 패치 및 설치 (apk-mitm)
ipcMain.handle('proxy:patch-and-install-apk', async (_, serial) => {
  try {
    // 1. Java 설치 확인
    try {
      await new Promise((resolve, reject) => {
        require('child_process').exec('java -version', (err) => {
          if (err) reject(new Error('Java가 설치되어 있지 않습니다. PC에 Java(JRE)를 설치해 주세요. (apk-mitm 필수 요구사항)'))
          else resolve()
        })
      })
    } catch (e) {
      return { ok: false, message: e.message }
    }

    // 2. APK 파일 선택
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
      title: '패치할 원본 APK 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'APK Files', extensions: ['apk'] }]
    })
    
    if (canceled || filePaths.length === 0) return { ok: false, message: '취소됨', isCancel: true }
    
    const originalApkPath = filePaths[0]
    
    // 3. npx apk-mitm 실행
    const patchedApkPath = await new Promise((resolve, reject) => {
      // apk-mitm은 실행된 위치에 '파일명-patched.apk'를 생성함
      const targetDir = path.dirname(originalApkPath)
      const apkName = path.basename(originalApkPath)
      const patchedName = apkName.replace(/\.apk$/i, '-patched.apk')
      const expectedPatchedPath = path.join(targetDir, patchedName)

      // 이전 패치 파일이 있다면 삭제
      if (fs.existsSync(expectedPatchedPath)) {
        fs.unlinkSync(expectedPatchedPath)
      }

      const execProcess = require('child_process').exec(`npx apk-mitm "${apkName}"`, { cwd: targetDir }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`패치 실패: ${error.message}\n${stderr}`))
        } else {
          resolve(expectedPatchedPath)
        }
      })
    })

    // 4. 생성된 패치 파일을 기기에 설치
    if (!fs.existsSync(patchedApkPath)) {
      throw new Error('패치된 파일이 생성되지 않았습니다.')
    }
    
    await runAdb(['-s', serial, 'install', '-r', patchedApkPath])
    
    return { ok: true, message: '패치 및 기기 설치가 완료되었습니다!' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
})
