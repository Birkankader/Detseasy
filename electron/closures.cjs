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
// Moves ("yeri değişen"): /guncellenenbirimler/{days} lists every edited unit;
// /guncellenenbirimbilgi/{id} tells which fields changed. A renamed parent
// also rewrites its children's HiyerarsikUstBirimAdi, so a candidate counts as
// moved only when the parent's id differs between /birimkunye of the day
// before and of the day of the change. Moves become `tur: 'tasima'` items.
//
// Lookups ("Bu DETSİS no'ya ne oldu?") combine the closures archive (every
// closure DETSİS lists, back to 2016, cached in archivePath), the unit's change
// log and whichever unit currently carries the number.
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
const ARCHIVE_DAYS = 3650 // closures DETSİS still lists reach back to 2016
// Rows sharing a date shift between requests; later passes use other page
// sizes so the rows that slid across a boundary land inside a page.
const ARCHIVE_PAGE_SIZES = [100, 97, 93]
const ARCHIVE_CONCURRENCY = 6
const ARCHIVE_VERSION = 1
const HISTORY_DAYS = 3650
// Change-log fields shown in a lookup; the rest (phone, e-mail, budget, ...)
// is only counted.
const HISTORY_FIELDS = {
  BirimAdi: 'Ad',
  HiyerarsikUstBirimAdi: 'Üst birim',
  StatuAdi: 'Statü',
  KategoriAdi: 'Kategori',
  AcikAdres: 'Adres',
}
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

async function pool(list, fn, concurrency = KUNYE_CONCURRENCY) {
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++
      await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker))
}

// "12.11.2026 tarihinde güncellendi." -> "2026-11-12"
function dayFromText(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(text || ''))
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ''
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return localDay(d)
}

function fmtDay(day) {
  const [y, m, d] = String(day || '').split('-')
  return d ? `${d}.${m}.${y}` : ''
}

function parentOf(kunye) {
  const list = kunye?.kurumHiyerarsiList
  return Array.isArray(list) && list.length > 1 ? list[list.length - 2] : null
}

// before/after: /birimkunye data the day before and the day of the move.
function moveItem(id, day, before, after) {
  const b = currentFields(before)
  const a = currentFields(after)
  return {
    key: `${id}:${day}:tasima`,
    tur: 'tasima',
    birimId: id,
    tarih: day,
    detsisNo: a.detsisNo,
    birimAdi: a.birimAdi,
    kategori: a.kategori,
    statu: a.statu,
    hiyerarsi: a.hiyerarsi,
    eskiHiyerarsi: b.hiyerarsi,
    eskiUst: parentOf(before)?.birimAdi || '',
    yeniUst: parentOf(after)?.birimAdi || '',
    idare: isIdareKategori(a.kategori),
    // Besides the move itself (name, statü, kategori, DETSİS no).
    degisiklikler: diffItem({ ...b, hiyerarsi: '' }, { ...a, hiyerarsi: '' }),
  }
}

// /guncellenenbirimbilgi rows -> lookup timeline events.
function historyEvents(list) {
  const olaylar = []
  let gizli = 0
  for (const e of Array.isArray(list) ? list : []) {
    const tarih = dayFromText(e?.aciklama)
    if (!e?.adi) {
      if (/açıldı/i.test(e?.aciklama || '')) olaylar.push({ tarih, olay: 'Açıldı' })
      continue
    }
    const alan = HISTORY_FIELDS[e.adi]
    if (!alan) {
      gizli++
      continue
    }
    olaylar.push({ tarih, olay: 'Güncellendi', alan, eski: e.eskiDeger ?? '', yeni: e.yeniDeger ?? '' })
  }
  return { olaylar, gizli }
}

function summarize(no, holder, units) {
  const lines = []
  if (holder && String(holder.id) !== no) {
    lines.push(
      `Bu numara şu an "${holder.birimAdi}" biriminde kullanılıyor (birim kimliği ${holder.id}).`
    )
  }
  const own = units.find((u) => String(u.id) === no)
  if (own) {
    const last = own.kapanislar[0]
    if (own.guncel && last) {
      lines.push(
        `${fmtDay(last.tarih)} tarihinde kapatılmış, sonra aynı kimlikle yeniden açılmış. Şu an: ${own.guncel.birimAdi}.`
      )
    } else if (own.guncel) {
      lines.push(`Birim aktif: ${own.guncel.birimAdi}.`)
    } else if (last) {
      lines.push(
        `${fmtDay(last.tarih)} tarihinde kapatıldı. Kapanıştaki hali: ${last.birimAdi}` +
          (last.hiyerarsi ? ` (${last.hiyerarsi}).` : '.')
      )
    } else {
      lines.push("Birim şu an DETSİS'te yok ve kapanış kaydı bulunamadı.")
    }
  } else if (!holder) {
    lines.push("Bu numarayla aktif bir birim ya da 2016'dan bu yana bir kapanış kaydı yok.")
  }
  return lines
}

function sortItems(items) {
  const day = (i) => i.kapanisTarihi || i.tarih || ''
  return items.sort(
    (a, b) =>
      Number(b.idare) - Number(a.idare) ||
      day(b).localeCompare(day(a)) ||
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
    seenUpdates: {}, // rowKey -> day, rows of the updated feed already checked for moves
    movesInitAt: null, // first move scan; that one is a baseline like the first closure scan
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
 *   archivePath JSON file caching the closures archive used by lookup()
 */
function createClosureWatcher(opts) {
  const {
    statePath,
    archivePath,
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

  // feed: kapatilanbirimler | guncellenenbirimler
  async function fetchFeedRows(feed, days) {
    const byKey = new Map()
    const add = (rows) => {
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r?.id != null && !byKey.has(rowKey(r))) byKey.set(rowKey(r), r)
      }
    }
    const page = (n) => get(`/${feed}/${days}?Page=${n}&PageSize=${PAGE_SIZE}`)

    for (let pass = 0; pass < LIST_PASSES; pass++) {
      const first = await page(1)
      if (!Array.isArray(first?.data)) {
        throw new Error(`Beklenmeyen DETSİS yanıtı (${feed})`)
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

  // A unit's künye as of `day`, or null when DETSİS does not list it then.
  async function kunyeAt(birimId, day) {
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
    return res.data
  }

  // Current künye fields of a unit, or null once DETSİS no longer lists it.
  async function fetchCurrent(birimId, day) {
    const d = await kunyeAt(birimId, day)
    return d ? currentFields(d) : null
  }

  // rows: fresh rows of the updated feed. Units whose log or künye could not
  // be read come back in `failed` so their rows are retried next check.
  async function detectMoves(rows, windowDays) {
    const daysById = new Map()
    for (const r of rows) {
      if (!daysById.has(r.id)) daysById.set(r.id, new Set())
      daysById.get(r.id).add(dayOf(r))
    }
    const failed = new Set()
    const candidates = new Map()
    await pool([...daysById.keys()], async (id) => {
      let log
      try {
        log = await get(`/guncellenenbirimbilgi/${id}?untilDaysAgo=${windowDays}`)
      } catch {
        failed.add(id)
        return
      }
      for (const e of Array.isArray(log) ? log : []) {
        const day = dayFromText(e?.aciklama)
        if (e?.adi === 'HiyerarsikUstBirimAdi' && daysById.get(id).has(day)) {
          candidates.set(`${id}:${day}`, { id, day })
        }
      }
    })
    const items = []
    await pool([...candidates.values()], async ({ id, day }) => {
      let before
      let after
      try {
        ;[before, after] = await Promise.all([kunyeAt(id, addDays(day, -1)), kunyeAt(id, day)])
      } catch {
        failed.add(id)
        return
      }
      const from = parentOf(before)
      const to = parentOf(after)
      // Missing the day before: opened/reopened that day (closure reports
      // cover it). Same parent id: only the parent was renamed.
      if (from && to && from.id !== to.id) items.push(moveItem(id, day, before, after))
    })
    return { items, failed }
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
        if (item.tur === 'tasima' || item.kapanisTarihi < since) continue
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
    for (const seen of [state.seen, state.seenUpdates]) {
      for (const [key, day] of Object.entries(seen)) {
        if (day < cutoff) delete seen[key]
      }
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

      const rows = await fetchFeedRows('kapatilanbirimler', windowDays)
      const fresh = rows.filter((r) => !state.seen[rowKey(r)])
      const closureItems = await enrich(fresh, now)
      // Before the new report is added: its items were just checked.
      const reopened = await refreshStatuses(now)

      // Installs from before move tracking get their first move scan as a
      // baseline too, so the backlog does not arrive as one big notification.
      const movesInitial = !state.movesInitAt
      const updatedRows = await fetchFeedRows('guncellenenbirimler', windowDays)
      const freshUpdates = updatedRows.filter((r) => !state.seenUpdates[rowKey(r)])
      const { items: moveItems, failed } = await detectMoves(freshUpdates, windowDays)

      for (const r of rows) state.seen[rowKey(r)] = dayOf(r) || localDay(now)
      for (const r of updatedRows) {
        if (!failed.has(r.id)) state.seenUpdates[rowKey(r)] = dayOf(r) || localDay(now)
      }
      pruneSeen(now)
      state.movesInitAt = state.movesInitAt || now.toISOString()

      const makeReport = (items, isInitial, n) => ({
        id: now.getTime().toString(36) + (n ? `-${n}` : ''),
        createdAt: now.toISOString(),
        windowDays,
        initial: isInitial,
        items: sortItems(items),
      })
      // Newest first: the regular report goes ahead of a move baseline.
      const added = []
      if (initial) {
        const all = [...closureItems, ...moveItems]
        if (all.length) added.push(makeReport(all, true))
      } else {
        const regular = [...closureItems, ...(movesInitial ? [] : moveItems)]
        if (regular.length) added.push(makeReport(regular, false))
        if (movesInitial && moveItems.length) added.push(makeReport(moveItems, true, 1))
      }
      state.reports = [...added, ...state.reports].slice(0, MAX_REPORTS)
      const report = added.find((r) => !r.initial) || null
      state.lastSuccessAt = now.toISOString()
      state.lastNewCount = report ? report.items.length : 0
      state.lastError = null
      persist()
      // Have the lookup archive ready (or topped up) before anyone asks.
      if (archivePath) {
        ensureArchive().catch((e) => log.error('[closures] archive update failed:', e?.message || e))
      }

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
      return {
        ok: true,
        newCount: report ? report.items.length : 0,
        reopenedCount: reopened.length,
        baselineCount: added.filter((r) => r.initial).reduce((n, r) => n + r.items.length, 0),
      }
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

  // ---- Closures archive (lookups) ----
  // File: { version, builtAt, rows: [[unitId, day, birimTarihceId, birimAdi], ...] }

  let archive = null // { builtAt, rows, byId: Map<unitId, rows> }
  let archiveJob = null
  // A lookup may join a build started in the background; every caller's
  // onProgress hears it.
  const archiveListeners = new Set()
  let archiveProgress = null

  function reportArchiveProgress(p) {
    archiveProgress = p
    for (const listener of archiveListeners) {
      try {
        listener(p)
      } catch {}
    }
  }

  function indexArchive(builtAt, rows) {
    const byId = new Map()
    for (const r of rows) {
      if (!byId.has(r[0])) byId.set(r[0], [])
      byId.get(r[0]).push(r)
    }
    for (const list of byId.values()) list.sort((a, b) => b[1].localeCompare(a[1]))
    return { builtAt, rows, byId }
  }

  function readArchive() {
    try {
      const a = JSON.parse(fs.readFileSync(archivePath, 'utf8'))
      if (a?.version === ARCHIVE_VERSION && Array.isArray(a.rows)) return indexArchive(a.builtAt, a.rows)
    } catch {}
    return null
  }

  function compact(row) {
    return [row.id, dayOf(row), row.birimTarihceId, row.birimAdi || '']
  }

  // Whole feed, several passes with different page sizes (see ARCHIVE_PAGE_SIZES).
  async function fetchArchive() {
    const onProgress = reportArchiveProgress
    const byKey = new Map()
    let done = 0
    let planned = 0
    for (const size of ARCHIVE_PAGE_SIZES) {
      const first = await get(`/kapatilanbirimler/${ARCHIVE_DAYS}?Page=1&PageSize=${size}`)
      if (!Array.isArray(first?.data)) throw new Error('Beklenmeyen DETSİS yanıtı (kapatilanbirimler)')
      const total = Number(first.totalCount) || 0
      const pages = Math.ceil(total / size)
      planned += pages
      const add = (data) => {
        for (const r of Array.isArray(data) ? data : []) {
          if (r?.id != null) byKey.set(rowKey(r), compact(r))
        }
        done++
        onProgress?.({ phase: 'archive', done, planned, rows: byKey.size, total })
      }
      add(first.data)
      const rest = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2)
      await pool(
        rest,
        async (n) => add((await get(`/kapatilanbirimler/${ARCHIVE_DAYS}?Page=${n}&PageSize=${size}`))?.data),
        ARCHIVE_CONCURRENCY
      )
      if (byKey.size >= total) break
    }
    return [...byKey.values()]
  }

  // Built once (about two minutes), then topped up with the days since builtAt.
  function ensureArchive(onProgress) {
    if (onProgress) {
      archiveListeners.add(onProgress)
      if (archiveJob && archiveProgress) onProgress(archiveProgress)
    }
    if (!archiveJob) {
      archiveJob = (async () => {
        if (!archive) archive = readArchive()
        const now = new Date()
        if (archive && localDay(archive.builtAt) === localDay(now)) return archive
        let rows
        if (archive) {
          const gap = Math.ceil((now - Date.parse(archive.builtAt)) / DAY_MS) + 2
          const recent = await fetchFeedRows(
            'kapatilanbirimler',
            Math.min(ARCHIVE_DAYS, Math.max(WINDOW_DAYS, gap))
          )
          const byKey = new Map(archive.rows.map((r) => [`${r[0]}:${r[1]}`, r]))
          for (const r of recent) byKey.set(rowKey(r), compact(r))
          rows = [...byKey.values()]
        } else {
          rows = await fetchArchive()
        }
        archive = indexArchive(now.toISOString(), rows)
        try {
          saveState(archivePath, { version: ARCHIVE_VERSION, builtAt: archive.builtAt, rows })
        } catch (e) {
          log.error('[closures] archive save failed:', e)
        }
        return archive
      })().finally(() => {
        archiveJob = null
        archiveProgress = null
        archiveListeners.clear()
      })
    }
    return archiveJob
  }

  // "Bu DETSİS no'ya ne oldu?" — the unit with that id (closures, change log,
  // current künye) plus whichever unit carries the number today.
  async function lookup(input, { onProgress } = {}) {
    const no = String(input ?? '').replace(/\D/g, '')
    if (no.length < 5 || no.length > 12) throw new Error('Geçerli bir DETSİS numarası girin.')
    const now = new Date()
    const day = localDay(now)
    const arch = await ensureArchive(onProgress)
    onProgress?.({ phase: 'lookup' })

    let holder = null
    try {
      const res = await get(`/tumbirimler/${no}`)
      const hit = (Array.isArray(res?.data) ? res.data : []).find((x) => String(x.detsisNo) === no)
      if (hit) holder = { id: hit.id, birimAdi: hit.birimAdi || '', hiyerarsi: hit.kurumHiyerarsisi || '' }
    } catch {}

    const ids = [...new Set([Number(no), holder?.id].filter((x) => Number.isFinite(x) && x > 0))]
    const units = []
    for (const id of ids) {
      const [current, log] = await Promise.all([
        fetchCurrent(id, day).catch(() => null),
        get(`/guncellenenbirimbilgi/${id}?untilDaysAgo=${HISTORY_DAYS}`).catch(() => []),
      ])
      const kapanislar = []
      for (const [, tarih, tarihceId, ad] of arch.byId.get(id) || []) {
        const k = await get(`/birimislemkunye/${tarihceId}`).catch(() => null)
        kapanislar.push({
          tarih,
          birimAdi: k?.birimAdi || ad,
          hiyerarsi: k?.kurumHiyerarsi || '',
          statu: k?.statu || '',
          kategori: k?.kategori || '',
          detsisNo: k?.detsisNo != null ? String(k.detsisNo) : '',
        })
      }
      const gecmis = historyEvents(log)
      if (!current && !kapanislar.length && !gecmis.olaylar.length) continue
      units.push({ id, guncel: current, kapanislar, gecmis })
    }
    return {
      no,
      sorgulandi: now.toISOString(),
      arsivTarihi: arch.builtAt,
      arsivKayit: arch.rows.length,
      holder,
      units,
      ozet: summarize(no, holder, units),
    }
  }

  return { start, check, markViewed, snapshot, lookup }
}

module.exports = { createClosureWatcher, isIdareKategori }
