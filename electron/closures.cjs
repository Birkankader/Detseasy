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
// DETSİS sometimes reopens a closed unit days later under the same id (renamed,
// moved under another parent or re-graded, e.g. müdürlük -> şeflik). Each
// check therefore re-queries closures from the last STATUS_RECHECK_DAYS via
// /birimkunye (current künye; 404 = still closed) and marks reopened ones
// `durum: 'degisti'` with the current fields and what changed.
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
const STATUS_RECHECK_DAYS = 30 // re-query closures this recent on every check
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
    birimId: row.id,
    durum: 'kapandi',
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

// Items saved before birimId existed carry it in their key only.
function itemBirimId(item) {
  return item.birimId ?? String(item.key).split(':')[0]
}

function sameText(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleUpperCase('tr')
  return norm(a) === norm(b)
}

function parentPath(hiyerarsi) {
  return String(hiyerarsi || '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, -1)
}

// /birimkunye data -> the fields a reopened item is compared on.
function currentFields(d) {
  const list = Array.isArray(d.kurumHiyerarsiList) ? d.kurumHiyerarsiList : []
  const hiyerarsi = d.kurumHiyerarsi || list.map((x) => x.birimAdi).join(' > ')
  return {
    detsisNo: d.detsisNo != null ? String(d.detsisNo) : '',
    birimAdi: d.birimAdi || list[list.length - 1]?.birimAdi || hiyerarsi.split('>').pop().trim(),
    statu: d.statu || '',
    kategori: d.kategori || '',
    hiyerarsi,
  }
}

// What differs between the unit at closure and the reopened unit.
function diffItem(item, cur) {
  const out = []
  const add = (alan, eski, yeni) => {
    if (eski && yeni && !sameText(eski, yeni)) out.push({ alan, eski: String(eski), yeni: String(yeni) })
  }
  add('Ad', item.birimAdi, cur.birimAdi)
  const ep = parentPath(item.hiyerarsi)
  const yp = parentPath(cur.hiyerarsi)
  if (ep.length && yp.length && !sameText(ep.join(' > '), yp.join(' > '))) {
    const e = ep[ep.length - 1]
    const y = yp[yp.length - 1]
    if (sameText(e, y)) add('Üst hiyerarşi', ep.join(' > '), yp.join(' > '))
    else add('Üst birim', e, y)
  }
  add('Statü', item.statu, cur.statu)
  add('Kategori', item.kategori, cur.kategori)
  add('DETSİS No', item.detsisNo, cur.detsisNo)
  return out
}

// cur: current fields, or null when the unit is still closed. Returns true
// when the item went from closed to reopened.
function applyStatus(item, cur, now) {
  const wasClosed = item.durum !== 'degisti'
  item.durumKontrol = now.toISOString()
  if (cur) {
    item.durum = 'degisti'
    item.guncel = cur
    item.degisiklikler = diffItem(item, cur)
  } else {
    item.durum = 'kapandi'
    delete item.guncel
    delete item.degisiklikler
  }
  return wasClosed && item.durum === 'degisti'
}

async function pool(list, fn) {
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++
      await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(KUNYE_CONCURRENCY, list.length) }, worker))
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
 *   onStatusChange (items, { manual }) => void — reported closures DETSİS has
 *               since reopened (one item per closure)
 */
function createClosureWatcher(opts) {
  const {
    statePath,
    upstream,
    origin,
    userAgent,
    onChange,
    onReport,
    onStatusChange,
    log = console,
  } = opts
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

  // Current künye fields of a unit, or null once DETSİS no longer lists it.
  async function fetchCurrent(birimId, day) {
    let res
    try {
      res = await get(`/birimkunye?birimId=${birimId}&kilometreTasiTarih=${day}`)
    } catch (e) {
      if (e?.status === 404) return null
      throw e
    }
    if (!res?.data || typeof res.data !== 'object') {
      throw new Error('Beklenmeyen DETSİS yanıtı (birimkunye)')
    }
    return currentFields(res.data)
  }

  async function enrich(rows, now) {
    const day = localDay(now)
    const items = new Array(rows.length)
    await pool(rows, async (row, i) => {
      let kunye = null
      let kunyeError = null
      try {
        kunye = await get(`/birimislemkunye/${row.birimTarihceId}`)
      } catch (e) {
        kunyeError = e?.message || String(e)
      }
      items[i] = toItem(row, kunye, kunyeError)
      try {
        applyStatus(items[i], await fetchCurrent(row.id, day), now)
      } catch {} // stays 'kapandi' until the next check gets an answer
    })
    return items
  }

  // Re-queries closures from the last STATUS_RECHECK_DAYS in stored reports and
  // returns the ones that turned from closed to reopened.
  async function refreshStatuses(now) {
    const since = localDay(now.getTime() - STATUS_RECHECK_DAYS * DAY_MS)
    const day = localDay(now)
    const byKey = new Map()
    for (const report of state.reports) {
      for (const item of report.items) {
        if (item.kapanisTarihi < since) continue
        if (!byKey.has(item.key)) byKey.set(item.key, [])
        byKey.get(item.key).push(item)
      }
    }
    const reopened = []
    await pool([...byKey.values()], async (items) => {
      let cur
      try {
        cur = await fetchCurrent(itemBirimId(items[0]), day)
      } catch {
        return // keep the last known status
      }
      let flipped = false
      for (const item of items) flipped = applyStatus(item, cur, now) || flipped
      if (flipped) reopened.push(items[0])
    })
    return reopened
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
      unreadIdareCount += r.items.filter((i) => i.idare && i.durum !== 'degisti').length
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
      const items = sortItems(await enrich(fresh, now))
      // Before the new report is added: its items were just checked.
      const reopened = await refreshStatuses(now)

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
      if (reopened.length > 0) {
        try {
          onStatusChange?.(reopened, { manual })
        } catch (e) {
          log.error('[closures] onStatusChange failed:', e)
        }
      }
      return { ok: true, newCount: items.length, reopenedCount: reopened.length }
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
