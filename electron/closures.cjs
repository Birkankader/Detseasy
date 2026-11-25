// Kapanan birim takibi — daily DETSİS closure watcher.
//
// DETSİS's public "Birim Değişiklikleri" page reads closures from
// /kapatilanbirimler/{days} (closures whose islemTarihi falls within the last
// N days). Once per local calendar day this module pulls a rolling window,
// diffs it against closures already reported (seen set, persisted as JSON) and
// enriches the new ones via /birimislemkunye/{birimTarihceId} (hierarchy,
// kategori, statü). Closures in institution-level categories get `idare: true`
// so the report can list them first.
//
// Plain Node, no Electron imports, so it can be exercised outside the app.

const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { URL } = require('node:url')

const API_PREFIX = '/api/backoffice/unauthorizedaccessdata'
const PAGE_SIZE = 100 // DETSİS rejects anything larger
const WINDOW_DAYS = 30 // rolling look-back; also catches back-dated closures
const MAX_WINDOW_DAYS = 90 // catch-up cap after the app stayed closed for long
const SEEN_RETENTION_DAYS = MAX_WINDOW_DAYS + 30
const MAX_REPORTS = 60
const KUNYE_CONCURRENCY = 4
const LIST_PASSES = 3
const RETRIES = 3
const REQUEST_TIMEOUT_MS = 25_000
const TICK_MS = 30 * 60 * 1000
const STARTUP_DELAY_MS = 8_000
const DAY_MS = 24 * 60 * 60 * 1000
const STATE_VERSION = 1

// Leaf kategori names DETSİS files under "ANA KURUM VE KURULUŞ", plus Şirket
// (together: ROOT_CATEGORIES in src/api.js), Mahalli Birlik and Mülki İdare
// Teşkilatı (valilik / kaymakamlık).
const IDARE_KATEGORILERI = new Set([
  'TBMM BAŞKANLIĞI',
  'CUMHURBAŞKANLIĞI',
  'BAŞBAKANLIK',
  'BAKANLIK',
  'YÜKSEK YARGI KURULUŞU',
  'BAĞIMSIZ/DÜZENLEYİCİ DENETLEYİCİ KURULUŞ',
  'BAĞLI KURULUŞ',
  'İLGİLİ KURULUŞ',
  'İLİŞKİLİ KURULUŞ',
  'KOORDİNE KURULUŞ',
  'YÜKSEKÖĞRETİM KURUMU',
  'ÖZELLEŞTİRME KAPSAMINDAKİ KURULUŞ',
  'TASFİYE HALİNDE KURULUŞ',
  'BELEDİYE',
  'İL ÖZEL İDARESİ',
  'MAHALLİ İDARELERE BAĞLI KURULUŞ',
  'MÜLKİ İDAREYE BAĞLI KURULUŞ',
  'ŞİRKET',
  'MAHALLİ BİRLİK',
  'MÜLKİ İDARE TEŞKİLATI',
])

function isIdareKategori(kategori) {
  const leaf = String(kategori || '').split('>').pop()
  return IDARE_KATEGORILERI.has(leaf.replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr'))
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function localDay(date) {
  const d = new Date(date)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayOf(row) {
  return String(row.islemTarihi || '').slice(0, 10)
}

// birimTarihceId is not stable for the same closure across requests, so a
// closure is identified by unit id + closure day.
function rowKey(row) {
  return `${row.id}:${dayOf(row)}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function toItem(row, kunye, kunyeError) {
  const kategori = kunye?.kategori || ''
  return {
    key: rowKey(row),
    detsisNo: kunye?.detsisNo ?? row.id,
    birimAdi: kunye?.birimAdi || row.birimAdi || '',
    ingilizceAdi: kunye?.ingilizceAdi || row.ingilizceAdi || '',
    kapanisTarihi: dayOf(row),
    kategori,
    statu: kunye?.statu || '',
    hiyerarsi: kunye?.kurumHiyerarsi || '',
    adres: kunye?.acikAdres || '',
    idare: isIdareKategori(kategori),
    ...(kunyeError ? { kunyeError } : {}),
  }
}

function sortItems(items) {
  return items.sort(
    (a, b) =>
      Number(b.idare) - Number(a.idare) ||
      b.kapanisTarihi.localeCompare(a.kapanisTarihi) ||
      a.birimAdi.localeCompare(b.birimAdi, 'tr')
  )
}

function emptyState() {
  return {
    version: STATE_VERSION,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastNewCount: null,
    lastError: null,
    lastViewedAt: null,
    seen: {}, // rowKey -> closure day (YYYY-MM-DD), for diffing and pruning
    reports: [], // newest first
  }
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s?.version === STATE_VERSION && s.seen && Array.isArray(s.reports)) {
      return { ...emptyState(), ...s }
    }
  } catch {}
  return emptyState()
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

/**
 * opts:
 *   statePath   JSON file holding seen set + reports
 *   upstream    e.g. https://yetkiliapi.detsis.gov.tr
 *   origin      Origin/Referer DETSİS expects
 *   userAgent
 *   onChange    (snapshot) => void — after every state change
 *   onReport    (report, { manual }) => void — when a check found new closures
 */
function createClosureWatcher(opts) {
  const { statePath, upstream, origin, userAgent, onChange, onReport, log = console } = opts
  const state = loadState(statePath)
  let running = null
  let started = false

  function request(apiPath) {
    return new Promise((resolve, reject) => {
      const target = new URL(API_PREFIX + apiPath, upstream)
      const req = https.request(
        {
          method: 'GET',
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          headers: {
            Origin: origin,
            Referer: origin + '/',
            'User-Agent': userAgent,
            Accept: 'application/json',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('error', reject)
          res.on('end', () => {
            let body = null
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {}
            if (res.statusCode >= 200 && res.statusCode < 300 && body) return resolve(body)
            const msg = String(body?.Message || `HTTP ${res.statusCode}`)
            const err = new Error(msg.replace(/^Detsis Exception -->\s*/, ''))
            err.status = res.statusCode
            reject(err)
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('DETSİS yanıt vermedi (zaman aşımı)')))
      req.on('error', reject)
      req.end()
    })
  }

  async function get(apiPath) {
    let lastErr
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        return await request(apiPath)
      } catch (e) {
        lastErr = e
        if (e.status >= 400 && e.status < 500) break
        if (attempt < RETRIES) await sleep(500 * 2 ** attempt + Math.random() * 250)
      }
    }
    throw lastErr
  }

  async function fetchClosedRows(days) {
    const byKey = new Map()
    const add = (rows) => {
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r?.id != null && !byKey.has(rowKey(r))) byKey.set(rowKey(r), r)
      }
    }
    const page = (n) => get(`/kapatilanbirimler/${days}?Page=${n}&PageSize=${PAGE_SIZE}`)

    for (let pass = 0; pass < LIST_PASSES; pass++) {
      const first = await page(1)
      if (!Array.isArray(first?.data)) {
        throw new Error('Beklenmeyen DETSİS yanıtı (kapatilanbirimler)')
      }
      add(first.data)
      const total = Number(first.totalCount) || 0
      const pages = Math.ceil(total / PAGE_SIZE)
      for (let n = 2; n <= pages; n++) add((await page(n))?.data)
      // Rows sharing a date come back in no fixed order, so one can slide
      // across a page boundary between requests. Re-read and union until the
      // unique count reaches totalCount.
      if (pages <= 1 || byKey.size >= total) break
    }
    return [...byKey.values()]
  }

  async function enrich(rows) {
    const items = new Array(rows.length)
    let cursor = 0
    async function worker() {
      while (cursor < rows.length) {
        const i = cursor++
        let kunye = null
        let kunyeError = null
        try {
          kunye = await get(`/birimislemkunye/${rows[i].birimTarihceId}`)
        } catch (e) {
          kunyeError = e?.message || String(e)
        }
        items[i] = toItem(rows[i], kunye, kunyeError)
      }
    }
    const workers = Math.min(KUNYE_CONCURRENCY, rows.length)
    await Promise.all(Array.from({ length: workers }, worker))
    return items
  }

  function pruneSeen(now) {
    const cutoff = localDay(now.getTime() - SEEN_RETENTION_DAYS * DAY_MS)
    for (const [key, day] of Object.entries(state.seen)) {
      if (day < cutoff) delete state.seen[key]
    }
  }

  function persist() {
    try {
      saveState(statePath, state)
    } catch (e) {
      log.error('[closures] state save failed:', e)
    }
  }

  function snapshot() {
    const viewedAt = state.lastViewedAt ? Date.parse(state.lastViewedAt) : 0
    let unreadCount = 0
    let unreadIdareCount = 0
    for (const r of state.reports) {
      if (r.initial || Date.parse(r.createdAt) <= viewedAt) continue
      unreadCount += r.items.length
      unreadIdareCount += r.items.filter((i) => i.idare).length
    }
    return {
      running: Boolean(running),
      lastCheckAt: state.lastCheckAt,
      lastSuccessAt: state.lastSuccessAt,
      lastNewCount: state.lastNewCount,
      lastError: state.lastError,
      lastViewedAt: state.lastViewedAt,
      unreadCount,
      unreadIdareCount,
      reports: state.reports,
    }
  }

  function changed() {
    try {
      onChange?.(snapshot())
    } catch (e) {
      log.error('[closures] onChange failed:', e)
    }
  }

  async function runCheck(manual) {
    const now = new Date()
    state.lastCheckAt = now.toISOString()
    try {
      // First run reports the whole window as a baseline ("ilk tarama").
      const initial = !state.lastSuccessAt
      const gapDays = initial ? 0 : Math.ceil((now - Date.parse(state.lastSuccessAt)) / DAY_MS)
      const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(WINDOW_DAYS, gapDays + 2))

      const rows = await fetchClosedRows(windowDays)
      const fresh = rows.filter((r) => !state.seen[rowKey(r)])
      const items = sortItems(await enrich(fresh))

      for (const r of rows) state.seen[rowKey(r)] = dayOf(r) || localDay(now)
      pruneSeen(now)

      let report = null
      if (items.length > 0) {
        report = {
          id: now.getTime().toString(36),
          createdAt: now.toISOString(),
          windowDays,
          initial,
          items,
        }
        state.reports = [report, ...state.reports].slice(0, MAX_REPORTS)
      }
      state.lastSuccessAt = now.toISOString()
      state.lastNewCount = items.length
      state.lastError = null
      persist()

      if (report) {
        try {
          onReport?.(report, { manual })
        } catch (e) {
          log.error('[closures] onReport failed:', e)
        }
      }
      return { ok: true, newCount: items.length }
    } catch (e) {
      state.lastError = e?.message || String(e)
      persist()
      log.error('[closures] check failed:', state.lastError)
      return { ok: false, error: state.lastError }
    }
  }

  // Concurrent callers share the in-flight check.
  function check({ manual = false } = {}) {
    if (!running) {
      running = runCheck(manual).finally(() => {
        running = null
        changed()
      })
      changed()
    }
    return running
  }

  // Once per local calendar day; a failed check is retried on the next tick.
  function tick() {
    if (running) return
    if (state.lastSuccessAt && localDay(state.lastSuccessAt) === localDay(Date.now())) return
    check()
  }

  function start() {
    if (started) return
    started = true
    setTimeout(tick, STARTUP_DELAY_MS)
    setInterval(tick, TICK_MS)
  }

  function markViewed() {
    state.lastViewedAt = new Date().toISOString()
    persist()
    changed()
    return snapshot()
  }

  return { start, check, markViewed, snapshot }
}

module.exports = { createClosureWatcher, isIdareKategori }
