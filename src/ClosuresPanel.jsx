import { useEffect, useMemo, useRef, useState } from 'react'

// "Değişen Birimler": header button + slide-in panel for the daily watcher
// (electron/closures.cjs) — closures, reopened units, moves — and the DETSİS
// no lookup. Renders nothing outside Electron (no preload bridge).
export default function ClosuresPanel() {
  const api = typeof window !== 'undefined' ? window.DETSEASY?.closures : null
  const [snap, setSnap] = useState(null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('reports') // reports | lookup
  const [selectedId, setSelectedId] = useState(null) // null = newest report
  const [viewedBefore, setViewedBefore] = useState('') // lastViewedAt when the panel opened
  const [lookupNo, setLookupNo] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupProgress, setLookupProgress] = useState(null)
  const snapRef = useRef(null)
  snapRef.current = snap

  function openPanel(viewedAt = snapRef.current?.lastViewedAt) {
    setViewedBefore(viewedAt || '')
    setSelectedId(null)
    setOpen(true)
  }

  useEffect(() => {
    if (!api) return
    api
      .get()
      .then((s) => {
        setSnap(s)
        if (s?.openRequested) openPanel(s.lastViewedAt)
      })
      .catch(() => {})
    const offs = [
      api.onState(setSnap),
      api.onOpen(() => openPanel()),
      api.onLookupProgress?.(setLookupProgress),
    ]
    return () => offs.forEach((off) => off && off())
  }, [])

  // Opening the panel, or a report landing while it is open, marks it read.
  useEffect(() => {
    if (!api || !open || !snap?.unreadCount) return
    api.markViewed().then(setSnap).catch(() => {})
  }, [open, snap?.unreadCount])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const reports = snap?.reports || []
  const report = reports.find((r) => r.id === selectedId) || reports[0] || null
  const groups = useMemo(() => {
    const items = report?.items || []
    const closed = items.filter((i) => i.tur !== 'tasima' && i.durum !== 'degisti')
    return {
      idare: closed.filter((i) => i.idare),
      other: closed.filter((i) => !i.idare),
      changed: items.filter((i) => i.tur !== 'tasima' && i.durum === 'degisti'),
      moved: items.filter((i) => i.tur === 'tasima'),
    }
  }, [report])

  if (!api) return null

  const isNew = (r) => !r.initial && (!viewedBefore || r.createdAt > viewedBefore)

  function reportLabel(r) {
    const moved = r.items.filter((i) => i.tur === 'tasima').length
    const changed = r.items.filter((i) => i.tur !== 'tasima' && i.durum === 'degisti').length
    const closed = r.items.length - moved - changed
    const idare = r.items.filter((i) => i.idare && i.durum !== 'degisti').length
    return [
      fmtDateTime(r.createdAt),
      closed ? `${closed.toLocaleString('tr-TR')} kapanış` : null,
      changed ? `${changed} yeniden açılan` : null,
      moved ? `${moved.toLocaleString('tr-TR')} yer değişikliği` : null,
      idare ? `${idare} idare` : null,
      r.initial ? `ilk tarama (son ${r.windowDays} gün)` : null,
      isNew(r) ? 'YENİ' : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  function statusText() {
    if (!snap) return ''
    if (snap.running) return 'DETSİS kontrol ediliyor…'
    if (!snap.lastSuccessAt) {
      return snap.lastError
        ? 'İlk kontrol yapılamadı.'
        : 'İlk kontrol birkaç saniye içinde başlayacak.'
    }
    const n = snap.lastNewCount
    const baseline = reports[0]?.initial && reports[0].createdAt === snap.lastSuccessAt
    return (
      `Son kontrol: ${fmtDateTime(snap.lastSuccessAt)} · ` +
      (baseline
        ? `ilk tarama, ${reports[0].items.length.toLocaleString('tr-TR')} kayıt`
        : n
        ? `${n.toLocaleString('tr-TR')} yeni değişiklik`
        : 'yeni değişiklik yok')
    )
  }

  async function runLookup(e) {
    e.preventDefault()
    if (!lookupNo.trim() || lookupBusy) return
    setLookupBusy(true)
    setLookupError('')
    setLookupProgress(null)
    try {
      const res = await api.lookup(lookupNo.trim())
      if (res?.ok) {
        setLookupResult(res.result)
      } else {
        setLookupResult(null)
        setLookupError(res?.error || 'Sorgu başarısız.')
      }
    } catch (err) {
      setLookupResult(null)
      setLookupError(err?.message || String(err))
    } finally {
      setLookupBusy(false)
      setLookupProgress(null)
    }
  }

  async function checkNow() {
    try {
      const s = await api.check()
      setSnap(s)
      setSelectedId(null)
    } catch {}
  }

  function fileBase() {
    return `degisen-birimler_${report.createdAt.slice(0, 16).replace(/[:T]/g, '-')}`
  }

  function downloadCsv() {
    const headers = [
      'Tür',
      'Durum',
      'Tarih',
      'DETSİS No',
      'Birim Adı',
      'İngilizce Adı',
      'İdare Düzeyi',
      'Kategori',
      'Statü',
      'Hiyerarşi',
      'Adres',
      'Eski Üst Birim',
      'Yeni Üst Birim',
      'Eski Hiyerarşi',
      'Güncel Ad',
      'Güncel DETSİS No',
      'Güncel Hiyerarşi',
      'Değişiklikler',
      'Durum Kontrolü',
    ]
    const rows = report.items.map((i) => {
      const move = i.tur === 'tasima'
      return [
        move ? 'Yer değişikliği' : 'Kapanış',
        move ? '' : i.durum === 'degisti' ? 'Yeniden açıldı' : 'Kapandı',
        fmtDay(move ? i.tarih : i.kapanisTarihi),
        i.detsisNo,
        i.birimAdi,
        i.ingilizceAdi,
        i.idare ? 'Evet' : 'Hayır',
        i.kategori,
        i.statu,
        i.hiyerarsi,
        i.adres,
        i.eskiUst,
        i.yeniUst,
        i.eskiHiyerarsi,
        i.guncel?.birimAdi,
        i.guncel?.detsisNo,
        i.guncel?.hiyerarsi,
        (i.degisiklikler || []).map((d) => `${d.alan}: ${d.eski} → ${d.yeni}`).join('; '),
        fmtDateTime(i.durumKontrol),
      ]
    })
    const csv = '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileBase() + '.csv')
  }

  function downloadJson() {
    const payload = {
      source: 'yetkiliapi.detsis.gov.tr · kapatilanbirimler + guncellenenbirimler',
      ...report,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    triggerDownload(blob, fileBase() + '.json')
  }

  return (
    <>
      <button
        type="button"
        className={'closures-btn' + (snap?.unreadCount ? ' has-new' : '')}
        onClick={() => openPanel()}
        title="DETSİS'te kapanan, yeniden açılan ve yeri değişen birimler · DETSİS no sorgusu"
      >
        Değişen Birimler
        {snap?.unreadCount > 0 && (
          <span className={'cl-badge' + (snap.unreadIdareCount ? ' idare' : '')}>
            {snap.unreadCount.toLocaleString('tr-TR')}
          </span>
        )}
        {snap?.running && <span className="cl-dot" />}
      </button>

      {open && (
        <div
          className="cl-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div className="cl-panel" role="dialog" aria-modal="true" aria-label="Değişen birimler">
            <div className="cl-head">
              <div>
                <h2>Değişen Birimler</h2>
                <div className="cl-status">{statusText()}</div>
              </div>
              <div className="cl-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={checkNow}
                  disabled={!snap || snap.running}
                >
                  {snap?.running ? 'Kontrol ediliyor…' : 'Şimdi kontrol et'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setOpen(false)}
                  aria-label="Kapat"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="cl-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'reports'}
                className={tab === 'reports' ? 'active' : ''}
                onClick={() => setTab('reports')}
              >
                Günlük raporlar
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'lookup'}
                className={tab === 'lookup' ? 'active' : ''}
                onClick={() => setTab('lookup')}
              >
                DETSİS No sorgula
              </button>
            </div>

            {tab === 'lookup' ? (
              <LookupView
                no={lookupNo}
                setNo={setLookupNo}
                onSubmit={runLookup}
                busy={lookupBusy}
                error={lookupError}
                result={lookupResult}
                progress={lookupProgress}
              />
            ) : (
              <>
                <p className="cl-note">
                  Uygulama çalıştığı sürece (pencere kapalıyken de, sistem tepsisinde) DETSİS günde bir
                  kez taranır: kapanan birimler ve üst birimi değişen (taşınan) birimler yeni rapor
                  olarak eklenir, masaüstü bildirimi gönderilir. İdare düzeyindeki kapanışlar en üstte
                  listelenir. Son 30 günün kapanışları her kontrolde yeniden sorgulanır; DETSİS'te aynı
                  birim yeniden açılmışsa Yeniden açılan grubuna geçer. Bilgisayar açılınca başlatmak
                  için tepsi simgesinin menüsünü kullanın.
                </p>

                {snap?.lastError && (
                  <div className="error">
                    Son kontrol başarısız ({fmtDateTime(snap.lastCheckAt)}): {snap.lastError} · 30 dk
                    içinde yeniden denenecek.
                  </div>
                )}

                {!report ? (
                  <div className="empty">
                    {snap?.running ? 'İlk tarama yapılıyor…' : 'Henüz rapor yok.'}
                  </div>
                ) : (
                  <>
                    <div className="cl-toolbar">
                      <select value={report.id} onChange={(e) => setSelectedId(e.target.value)}>
                        {reports.map((r) => (
                          <option key={r.id} value={r.id}>
                            {reportLabel(r)}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="ghost" onClick={downloadCsv}>
                        CSV (Excel) indir
                      </button>
                      <button type="button" className="ghost" onClick={downloadJson}>
                        JSON indir
                      </button>
                    </div>

                    {report.initial && (
                      <div className="hint">
                        İlk tarama: son {report.windowDays} günün kayıtları. Bundan sonra yalnızca yeni
                        değişiklikler raporlanır.
                      </div>
                    )}

                    <ClosureGroup
                      title="İdare düzeyi kapananlar"
                      items={groups.idare}
                      empty="Bu raporda idare düzeyinde kapanış yok."
                      idare
                    />
                    <ChangedGroup items={groups.changed} />
                    <MovedGroup items={groups.moved} />
                    <ClosureGroup
                      title="Diğer kapananlar"
                      items={groups.other}
                      empty="Bu raporda başka kapanış yok."
                    />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function ClosureGroup({ title, items, empty, idare = false }) {
  return (
    <section className={'cl-group' + (idare ? ' idare' : '')}>
      <h3>
        {title} <span className="cl-count">{items.length.toLocaleString('tr-TR')}</span>
      </h3>
      {items.length === 0 ? (
        <div className="cl-empty">{empty}</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kapanış</th>
                <th>DETSİS No</th>
                <th>Birim Adı</th>
                <th>Kategori</th>
                <th>Statü</th>
                <th>Hiyerarşi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.key}>
                  <td className="mono">{fmtDay(i.kapanisTarihi)}</td>
                  <td className="mono">{i.detsisNo}</td>
                  <td>
                    {i.birimAdi}
                    {i.kunyeError && <em className="muted-inline"> · künye alınamadı</em>}
                  </td>
                  <td>{i.kategori}</td>
                  <td>{i.statu}</td>
                  <td className="hier" title={i.hiyerarsi}>
                    {i.hiyerarsi}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// Closures DETSİS has since reopened under the same unit id: closing-time unit
// next to the current one. Name and DETSİS no changes show in their columns.
function ChangedGroup({ items }) {
  return (
    <section className="cl-group changed">
      <h3>
        Yeniden açılan <span className="cl-count">{items.length.toLocaleString('tr-TR')}</span>
      </h3>
      <p className="cl-group-note">
        Kapandı olarak listelenip sonra aynı birim kimliğiyle yeniden açılan birimler.
      </p>
      {items.length === 0 ? (
        <div className="cl-empty">Bu raporda yeniden açılan birim yok.</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kapanış</th>
                <th>DETSİS No</th>
                <th>Kapanan birim</th>
                <th>Şimdiki birim</th>
                <th>Değişenler</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const diffs = i.degisiklikler || []
                const nameChanged = diffs.some((d) => d.alan === 'Ad')
                const rest = diffs.filter((d) => d.alan !== 'Ad' && d.alan !== 'DETSİS No')
                const newNo = i.guncel?.detsisNo
                return (
                  <tr key={i.key}>
                    <td className="mono">{fmtDay(i.kapanisTarihi)}</td>
                    <td className="mono">
                      {i.detsisNo}
                      {newNo && String(newNo) !== String(i.detsisNo) && <> → {newNo}</>}
                    </td>
                    <td>
                      {i.birimAdi}
                      {i.idare && <span className="cl-tag">idare</span>}
                      <div className="cl-sub" title={i.hiyerarsi}>
                        {i.hiyerarsi}
                      </div>
                    </td>
                    <td>
                      {i.guncel?.birimAdi}
                      <div className="cl-sub" title={i.guncel?.hiyerarsi}>
                        {i.guncel?.hiyerarsi}
                      </div>
                    </td>
                    <td>
                      {rest.length > 0 ? (
                        <ul className="cl-diff">
                          {rest.map((d) => (
                            <li key={d.alan}>
                              <b>{d.alan}:</b> {d.eski} → {d.yeni}
                            </li>
                          ))}
                        </ul>
                      ) : nameChanged ? (
                        'Yalnızca adı değişti'
                      ) : (
                        'Aynı haliyle yeniden açıldı'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// Units moved under another parent (parent id changed, not just renamed).
function MovedGroup({ items }) {
  return (
    <section className="cl-group moved">
      <h3>
        Yeri değişen <span className="cl-count">{items.length.toLocaleString('tr-TR')}</span>
      </h3>
      <p className="cl-group-note">
        Başka bir üst birime bağlanan birimler. Yalnızca üst birimin adı değiştiyse listelenmez.
      </p>
      {items.length === 0 ? (
        <div className="cl-empty">Bu raporda yeri değişen birim yok.</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>DETSİS No</th>
                <th>Birim</th>
                <th>Eski üst birim → Yeni üst birim</th>
                <th>Başka değişiklik</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.key}>
                  <td className="mono">{fmtDay(i.tarih)}</td>
                  <td className="mono">{i.detsisNo}</td>
                  <td>
                    {i.birimAdi}
                    {i.idare && <span className="cl-tag">idare</span>}
                    <div className="cl-sub" title={i.hiyerarsi}>
                      {i.hiyerarsi}
                    </div>
                  </td>
                  <td>
                    {i.eskiUst} → <b>{i.yeniUst}</b>
                    <div className="cl-sub" title={i.eskiHiyerarsi}>
                      önce: {i.eskiHiyerarsi}
                    </div>
                  </td>
                  <td>
                    {i.degisiklikler?.length ? (
                      <ul className="cl-diff">
                        {i.degisiklikler.map((d) => (
                          <li key={d.alan}>
                            <b>{d.alan}:</b> {d.eski} → {d.yeni}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function LookupView({ no, setNo, onSubmit, busy, error, result, progress }) {
  return (
    <div className="cl-lookup">
      <p className="cl-note">
        Artık bulunamayan ya da değişmiş bir DETSİS numarasına ne olduğunu gösterir: 2016'dan bu
        yana kapanış kaydı, ad / üst birim / statü değişiklikleri, yeniden açılma ve numaranın şu
        an hangi birimde olduğu.
      </p>
      <form className="cl-lookup-form" onSubmit={onSubmit}>
        <input
          inputMode="numeric"
          placeholder="DETSİS No (ör. 38382425)"
          value={no}
          onChange={(e) => setNo(e.target.value)}
          aria-label="DETSİS numarası"
        />
        <button type="submit" disabled={busy || !no.trim()}>
          {busy ? 'Sorgulanıyor…' : 'Sorgula'}
        </button>
      </form>
      {busy && progress?.phase === 'archive' && (
        <div className="cl-status">
          Kapanış arşivi indiriliyor (ilk seferlik, 1–2 dk): {progress.rows.toLocaleString('tr-TR')} /{' '}
          {progress.total.toLocaleString('tr-TR')} kayıt
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {result && <LookupResult result={result} />}
    </div>
  )
}

function LookupResult({ result }) {
  return (
    <div className="cl-lookup-result">
      <div className="cl-ozet">
        <div className="cl-ozet-no">DETSİS No {result.no}</div>
        {result.ozet.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {result.units.map((u) => (
        <LookupUnit key={u.id} unit={u} no={result.no} />
      ))}
      <div className="cl-lookup-meta">
        Kapanış arşivi: {result.arsivKayit.toLocaleString('tr-TR')} kayıt (
        {fmtDateTime(result.arsivTarihi)}) · sorgu: {fmtDateTime(result.sorgulandi)}
      </div>
    </div>
  )
}

function LookupUnit({ unit, no }) {
  const events = [
    ...unit.kapanislar.map((k) => ({
      tarih: k.tarih,
      olay: 'Kapatıldı',
      detay: k.hiyerarsi || k.birimAdi,
    })),
    ...unit.gecmis.olaylar.map((e) =>
      e.olay === 'Açıldı'
        ? { tarih: e.tarih, olay: 'Açıldı', detay: '' }
        : { tarih: e.tarih, olay: `${e.alan} değişti`, detay: `${e.eski || '—'} → ${e.yeni || '—'}` }
    ),
  ].sort((a, b) => b.tarih.localeCompare(a.tarih))
  const g = unit.guncel
  return (
    <section className="cl-unit">
      <h4>
        Birim kimliği {unit.id}
        {String(unit.id) !== no && <span className="cl-muted"> · numarayı şu an taşıyan birim</span>}
        <span className={'cl-state ' + (g ? 'on' : 'off')}>{g ? 'Aktif' : 'Kapalı'}</span>
      </h4>
      {g && (
        <div className="cl-unit-now">
          <b>{g.birimAdi}</b> · DETSİS No {g.detsisNo}
          {g.statu && ` · ${g.statu}`}
          {g.kategori && ` · ${g.kategori}`}
          <div className="cl-wrap">{g.hiyerarsi}</div>
        </div>
      )}
      {events.length === 0 ? (
        <div className="cl-empty">Değişiklik kaydı yok.</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Olay</th>
                <th>Ayrıntı</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{fmtDay(e.tarih)}</td>
                  <td>{e.olay}</td>
                  <td className="cl-wrap">{e.detay}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unit.gecmis.gizli > 0 && (
        <div className="cl-lookup-meta">
          +{unit.gecmis.gizli} iletişim / bütçe / tüzel kişilik alanı değişikliği gösterilmiyor.
        </div>
      )}
    </section>
  )
}

// 'YYYY-MM-DD' -> 'DD.MM.YYYY'
function fmtDay(day) {
  const [y, m, d] = String(day || '').split('-')
  return d ? `${d}.${m}.${y}` : ''
}

function fmtDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function csvCell(v) {
  if (v == null) return ''
  let s = String(v).replace(/\r\n|\n|\r/g, ' ').replace(/\t/g, ' ')
  if (s.includes(';') || s.includes('"')) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

function triggerDownload(blob, fname) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
