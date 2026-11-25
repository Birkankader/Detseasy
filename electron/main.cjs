// Electron main process. Boots a tiny HTTP proxy on a random localhost port
// that mirrors the Vite dev proxy, then loads the built React app from disk.
//
// Uses electron-updater + GitHub Releases for automatic update download &
// install on Windows NSIS builds. The renderer drives the install UX via
// IPC messages.
//
// Also runs the daily closed-unit watcher (closures.cjs) and raises a desktop
// notification when DETSİS reports new closures. On Windows and macOS a tray
// icon keeps the app (and the watcher) running after the window is closed and
// can register the app to start at login.

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  shell,
  dialog,
  Notification,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')
const { autoUpdater } = require('electron-updater')
const { createClosureWatcher } = require('./closures.cjs')

const APP_ID = 'com.birkankader.detseasy'
const UPSTREAM = 'https://yetkiliapi.detsis.gov.tr'
const ORIGIN = 'https://yetkili.detsis.gov.tr'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const UPDATE_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const HIDDEN_ARG = '--hidden' // login launch: start in the tray, no window
// Linux tray support depends on the desktop (vanilla GNOME has none), so Linux
// keeps quitting when the window closes.
const TRAY_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin'

const isDev = process.env.ELECTRON_DEV === '1'

let proxyPort = 0
let mainWin = null
let lastUpdateState = null // last payload pushed to renderer (for re-emits)
let pendingUpdate = null // update:downloaded payload once an update is ready
let closureWatcher = null
let notifications = [] // keep refs: a GC'd notification drops its click handler
let openClosuresOnLoad = false // notification clicked while no window was open
let tray = null
let trayUnread = false
let settings = { background: true, backgroundHintShown: false }

// ---- HTTP proxy --------------------------------------------------------------

function startProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (!req.url.startsWith('/detsis/')) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const upstreamPath = req.url.replace(/^\/detsis/, '')
      const target = new URL(upstreamPath, UPSTREAM)
      const upReq = https.request(
        {
          method: req.method,
          host: target.hostname,
          path: target.pathname + target.search,
          headers: {
            Host: target.hostname,
            Origin: ORIGIN,
            Referer: ORIGIN + '/',
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
          },
          timeout: 30_000,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          upRes.pipe(res)
        }
      )
      upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')))
      upReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
        }
        res.end(JSON.stringify({ Message: `Proxy hatası: ${err.code || err.message}` }))
      })
      req.pipe(upReq)
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      proxyPort = server.address().port
      console.log('[proxy] listening on 127.0.0.1:' + proxyPort)
      resolve(proxyPort)
    })
  })
}

// ---- Auto-updater ------------------------------------------------------------

function sendUpdate(channel, payload) {
  lastUpdateState = { channel, payload }
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload || {})
  }
}

function configureUpdater() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => sendUpdate('update:checking', {}))

  autoUpdater.on('update-available', (info) =>
    sendUpdate('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes:
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note || '').join('\n\n')
          : '',
      currentVersion: app.getVersion(),
    })
  )

  autoUpdater.on('update-not-available', (info) =>
    sendUpdate('update:not-available', {
      version: info?.version,
      currentVersion: app.getVersion(),
    })
  )

  autoUpdater.on('download-progress', (p) =>
    sendUpdate('update:download-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  )

  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = { version: info.version, currentVersion: app.getVersion() }
    sendUpdate('update:downloaded', pendingUpdate)
    updateTray()
    // Running in the tray: no window, no banner.
    if (!mainWin || mainWin.isDestroyed()) {
      notify(
        `Detseasy v${info.version} hazır`,
        'Yüklemek ve yeniden başlatmak için tıklayın.',
        installUpdate
      )
    }
  })

  autoUpdater.on('error', (err) =>
    sendUpdate('update:error', { message: err?.message || String(err) })
  )
}

function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE)
}

function canAutoUpdate() {
  if (isDev) return false
  if (!app.isPackaged) return false
  if (isPortable()) return false
  return true
}

async function checkForUpdates(userTriggered = false) {
  if (!canAutoUpdate()) {
    if (userTriggered) {
      sendUpdate('update:unsupported', {
        reason: isPortable()
          ? 'Portable çalışıyor — auto-update için NSIS kurulum sürümü gerekli.'
          : 'Dev ortamı, güncelleme devre dışı.',
      })
    }
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    sendUpdate('update:error', { message: err?.message || String(err) })
  }
}

function installUpdate() {
  if (!canAutoUpdate()) return false
  // Silent install: NSIS runs with /S, no wizard window. App quits then
  // installer restarts the new binary. isForceRunAfter=true ensures relaunch.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  if (onClick) notification.on('click', () => onClick())
  notification.show()
  notifications = [notification, ...notifications].slice(0, 5)
}

// ---- Kapanan birim takibi ----------------------------------------------------

function showClosures() {
  if (mainWin && !mainWin.isDestroyed()) {
    showWindow()
    mainWin.webContents.send('closures:open')
  } else {
    // Renderer picks this up via closures:get once it mounts.
    openClosuresOnLoad = true
    createWindow()
  }
}

function nameList(names, total) {
  return names.join(', ') + (total > names.length ? ` ve ${total - names.length} birim daha` : '')
}

// Real closures first; reopened-at-report-time items (durum 'degisti') and
// moves (tur 'tasima') are counted apart.
function notifyClosures(report) {
  const moved = report.items.filter((i) => i.tur === 'tasima')
  const closures = report.items.filter((i) => i.tur !== 'tasima')
  const closed = closures.filter((i) => i.durum !== 'degisti')
  const changed = closures.length - closed.length
  const parts = []
  if (closed.length) {
    const idare = closed.filter((i) => i.idare).length
    parts.push(`${closed.length} birim kapandı` + (idare ? ` (${idare} idare)` : ''))
  }
  if (changed) parts.push(`${changed} birim değişti`)
  if (moved.length) parts.push(`${moved.length} birimin yeri değişti`)

  let body
  if (closed.length) {
    const idare = closed.filter((i) => i.idare)
    body = nameList((idare.length ? idare : closed).slice(0, 3).map((i) => i.birimAdi), closed.length)
  } else if (changed) {
    body = nameList(closures.slice(0, 3).map((i) => i.birimAdi), changed)
  } else {
    body = nameList(moved.slice(0, 2).map((i) => `${i.birimAdi} → ${i.yeniUst}`), moved.length)
  }
  notify(`DETSİS: ${parts.join(' · ')}`, body, showClosures)
}

function notifyReopened(items) {
  notify(
    `DETSİS: kapandı bildirilen ${items.length} birim yeniden açıldı`,
    nameList(
      items.slice(0, 3).map((i) => `${i.birimAdi} → ${i.guncel?.birimAdi || '?'}`),
      items.length
    ),
    showClosures
  )
}

function startClosureWatcher() {
  closureWatcher = createClosureWatcher({
    statePath: path.join(app.getPath('userData'), 'kapanan-birimler.json'),
    archivePath: path.join(app.getPath('userData'), 'kapanis-arsivi.json'),
    upstream: UPSTREAM,
    origin: ORIGIN,
    userAgent: UA,
    onChange: (snapshot) => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('closures:state', snapshot)
      }
      updateTray()
    },
    // The first-ever check is a baseline, and a manual check happens with the
    // panel open; neither needs a desktop notification.
    onReport: (report, { manual }) => {
      if (!manual && !report.initial) notifyClosures(report)
    },
    onStatusChange: (items, { manual }) => {
      if (!manual) notifyReopened(items)
    },
  })
  closureWatcher.start()
}

// ---- Sistem tepsisi ----------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    for (const key of Object.keys(settings)) {
      if (typeof saved?.[key] === typeof settings[key]) settings[key] = saved[key]
    }
  } catch {}
}

function saveSettings() {
  const file = settingsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(settings))
    fs.renameSync(file + '.tmp', file)
  } catch (err) {
    console.error('[settings] save failed:', err?.message || err)
  }
}

// Dev runs would register the bare Electron binary and portable runs a temp
// path, so only installed builds offer start-at-login. On Windows the Run
// entry carries --hidden so a login start stays in the tray.
function loginItemSupported() {
  return TRAY_SUPPORTED && app.isPackaged && !isPortable()
}

function loginItemOptions() {
  return process.platform === 'win32' ? { args: [HIDDEN_ARG] } : {}
}

function getOpenAtLogin() {
  if (!loginItemSupported()) return null
  try {
    const s = app.getLoginItemSettings(loginItemOptions())
    // Windows: an entry disabled in Task Manager's Startup tab does not run.
    return s.openAtLogin && s.executableWillLaunchAtLogin !== false
  } catch {
    return null
  }
}

function setOpenAtLogin(openAtLogin) {
  if (!loginItemSupported()) return
  app.setLoginItemSettings({ openAtLogin, ...loginItemOptions() })
  // macOS 13+ may hold a new login item until the user approves it.
  if (openAtLogin && app.getLoginItemSettings().status === 'requires-approval') {
    notify(
      'Detseasy açılışta başlatma onay bekliyor',
      "Sistem Ayarları › Genel › Giriş Öğeleri'nden Detseasy'ye izin verin."
    )
  }
}

function trayImage(unread) {
  const name =
    process.platform === 'darwin' ? 'trayTemplate.png' : unread ? 'tray-unread.png' : 'tray.png'
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name))
}

function createTray() {
  if (!TRAY_SUPPORTED) return
  const image = trayImage(false)
  if (image.isEmpty()) {
    console.error('[tray] icon missing; running without tray')
    return
  }
  tray = new Tray(image)
  // macOS opens the context menu on click; Windows opens it on right click.
  if (process.platform === 'win32') tray.on('click', () => showWindow())
  updateTray()
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return
  const snap = closureWatcher.snapshot()
  const unread = snap.unreadCount
  const openAtLogin = getOpenAtLogin()

  const template = [
    { label: "Detseasy'yi aç", click: () => showWindow() },
    {
      label: unread ? `Değişen Birimler (${unread} yeni)` : 'Değişen Birimler',
      click: () => showClosures(),
    },
    {
      label: snap.running ? 'Kontrol ediliyor…' : 'Şimdi kontrol et',
      enabled: !snap.running,
      click: () => checkFromTray(),
    },
    { type: 'separator' },
  ]
  if (process.platform === 'win32') {
    template.push({
      label: 'Pencere kapanınca tepside çalış',
      type: 'checkbox',
      checked: settings.background,
      click: (item) => {
        settings.background = item.checked
        saveSettings()
      },
    })
  }
  if (openAtLogin !== null) {
    template.push({
      label: 'Bilgisayar açılınca başlat',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => {
        setOpenAtLogin(item.checked)
        updateTray()
      },
    })
  }
  if (pendingUpdate) {
    template.push(
      { type: 'separator' },
      { label: `Güncellemeyi yükle (v${pendingUpdate.version})`, click: () => installUpdate() }
    )
  }
  template.push({ type: 'separator' }, { label: 'Çıkış', click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(template))

  const status = snap.running
    ? 'kontrol ediliyor…'
    : snap.lastError
    ? 'son kontrol başarısız'
    : snap.lastSuccessAt
    ? `son kontrol ${fmtTime(snap.lastSuccessAt)}`
    : 'ilk kontrol bekleniyor'
  tray.setToolTip(`Detseasy · ${status}` + (unread ? ` · ${unread} yeni değişiklik` : ''))
  if (process.platform === 'darwin') {
    tray.setTitle(unread ? String(unread) : '')
  } else if (trayUnread !== unread > 0) {
    trayUnread = unread > 0
    tray.setImage(trayImage(trayUnread))
  }
}

async function checkFromTray() {
  const result = await closureWatcher.check()
  // New closures and reopenings raise their own notifications.
  if (!result.ok) notify('DETSİS kontrolü başarısız', result.error)
  else if (!result.newCount && !result.reopenedCount) {
    notify('DETSİS kontrol edildi', 'Yeni değişiklik yok.')
  }
}

// ---- App lifecycle -----------------------------------------------------------

function showWindow() {
  if (!mainWin || mainWin.isDestroyed()) return createWindow()
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  return mainWin
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'Detseasy',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [
        `--detsis-proxy-port=${proxyPort}`,
        `--detseasy-version=${app.getVersion()}`,
        `--detseasy-can-auto-update=${canAutoUpdate() ? '1' : '0'}`,
      ],
    },
  })

  const win = mainWin
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const loaded = isDev
    ? win.loadURL('http://localhost:5173')
    : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  if (isDev) win.webContents.openDevTools({ mode: 'detach' })

  loaded.then(
    () => {
      // Window opened from the tray after an update finished downloading.
      if (pendingUpdate) win.webContents.send('update:downloaded', pendingUpdate)
      // Re-emit cached state on reload so the banner survives renderer reloads.
      win.webContents.on('did-finish-load', () => {
        if (lastUpdateState) {
          win.webContents.send(lastUpdateState.channel, lastUpdateState.payload)
        }
      })
    },
    (err) => console.error('[window] load failed:', err?.message || err)
  )
  return win
}

// IPC: manual check, quit-and-install, open external (release page).
ipcMain.handle('update:check', () => checkForUpdates(true))
ipcMain.handle('update:install', () => installUpdate())
ipcMain.handle('update:open', (_evt, url) => {
  if (typeof url === 'string') shell.openExternal(url)
})

// IPC: closed-unit reports.
ipcMain.handle('closures:get', () => {
  const snapshot = closureWatcher.snapshot()
  if (openClosuresOnLoad) {
    openClosuresOnLoad = false
    snapshot.openRequested = true
  }
  return snapshot
})
ipcMain.handle('closures:check', async () => {
  await closureWatcher.check({ manual: true })
  return closureWatcher.snapshot()
})
ipcMain.handle('closures:mark-viewed', () => closureWatcher.markViewed())
// Errors come back as data: an invoke rejection would prefix the message.
ipcMain.handle('closures:lookup', async (event, no) => {
  try {
    const result = await closureWatcher.lookup(no, {
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('closures:lookup-progress', p)
      },
    })
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

async function startup() {
  // Windows only shows toasts for an AppUserModelID matching the installer's
  // shortcut (electron-builder uses appId). The login item is keyed by it too.
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)
  }
  // Drop default File/Edit/View/Window/Help menu. On Windows/Linux this hides
  // the menu bar entirely; on macOS the system menu shrinks to app-name only
  // (full removal requires platform-specific overrides we don't need).
  Menu.setApplicationMenu(null)
  loadSettings()
  await startProxy()
  configureUpdater()
  startClosureWatcher()
  createTray()
  // A login start (--hidden) stays in the tray; without a tray there would be
  // no way back into the app.
  if (!tray || !process.argv.includes(HIDDEN_ARG)) createWindow()

  // Initial + periodic checks (only when auto-update is supported).
  if (canAutoUpdate()) {
    setTimeout(() => checkForUpdates(false), 4_000)
    setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS)
  }
}

// One instance owns the proxy, the watcher's state file and the tray; a second
// launch (e.g. the desktop shortcut while running in the tray) shows its window.
const gotLock = app.requestSingleInstanceLock()
const started = gotLock ? app.whenReady().then(startup) : null
if (!gotLock) app.quit()

app.on('second-instance', (_event, argv) => {
  if (!argv.includes(HIDDEN_ARG)) started.then(() => showWindow())
})

app.on('window-all-closed', () => {
  // macOS apps stay alive without windows; Windows keeps running in the tray
  // unless the user turned that off.
  if (process.platform === 'darwin') return
  if (tray && settings.background) {
    if (!settings.backgroundHintShown) {
      settings.backgroundHintShown = true
      saveSettings()
      notify(
        'Detseasy tepside çalışmaya devam ediyor',
        'Kapanan birim kontrolü sürüyor. Açılışta başlatmak ya da tamamen kapatmak için tepsi simgesine sağ tıklayın.',
        showWindow
      )
    }
    return
  }
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) started?.then(() => showWindow())
})
