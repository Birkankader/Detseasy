import { useEffect, useMemo, useRef, useState } from 'react'

// Header button + slide-in report panel for the daily closed-unit watcher
// (electron/closures.cjs). Renders nothing outside Electron (no preload bridge).
export default function ClosuresPanel() {
  const api = typeof window !== 'undefined' ? window.DETSEASY?.closures : null
  const [snap, setSnap] = useState(null)
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(null) // null = newest report
  const [viewedBefore, setViewedBefore] = useState('') // lastViewedAt when the panel opened
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
    const offs = [api.onState(setSnap), api.onOpen(() => openPanel())]
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
    const closed = items.filter((i) => i.durum !== 'degisti')
    return {
      idare: closed.filter((i) => i.idare),
      other: closed.filter((i) => !i.idare),
      changed: items.filter((i) => i.durum === 'degisti'),
    }
  }, [report])

  if (!api) return null

  const isNew = (r) => !r.initial && (!viewedBefore || r.createdAt > viewedBefore)

  function reportLabel(r) {
    const changed = r.items.filter((i) => i.durum === 'degisti').length
    const idare = r.items.filter((i) => i.idare && i.durum !== 'degisti').length
    return [
      fmtDateTime(r.createdAt),
      `${(r.items.length - changed).toLocaleString('tr-TR')} kapanış`,
      changed ? `${changed} değişti` : null,
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
        ? `ilk tarama, ${n.toLocaleString('tr-TR')} kapanış`
        : n
        ? `${n.toLocaleString('tr-TR')} yeni kapanış`
        : 'yeni kapanış yok')
    )
  }

  async function checkNow() {
    try {
      const s = await api.check()
      setSnap(s)
      setSelectedId(null)
    } catch {}
  }

  function fileBase() {
    return `kapanan-birimler_${report.createdAt.slice(0, 16).replace(/[:T]/g, '-')}`
  }

  function downloadCsv() {
    const headers = [
      'Durum',
      'Kapanış Tarihi',
      'DETSİS No',
      'Birim Adı',
      'İngilizce Adı',
      'İdare Düzeyi',
      'Kategori',
      'Statü',
      'Hiyerarşi',
      'Adres',
      'Güncel Ad',
      'Güncel DETSİS No',
      'Güncel Hiyerarşi',
      'Değişiklikler',
      'Durum Kontrolü',
    ]
    const rows = report.items.map((i) => [
      i.durum === 'degisti' ? 'Değişti' : 'Kapandı',
      fmtDay(i.kapanisTarihi),
      i.detsisNo,
      i.birimAdi,
      i.ingilizceAdi,
      i.idare ? 'Evet' : 'Hayır',
      i.kategori,
      i.statu,
      i.hiyerarsi,
      i.adres,
      i.guncel?.birimAdi,
      i.guncel?.detsisNo,
      i.guncel?.hiyerarsi,
      (i.degisiklikler || []).map((d) => `${d.alan}: ${d.eski} → ${d.yeni}`).join('; '),
      fmtDateTime(i.durumKontrol),
    ])
    const csv = '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileBase() + '.csv')
  }

  function downloadJson() {
    const payload = { source: 'yetkiliapi.detsis.gov.tr · kapatilanbirimler', ...report }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    triggerDownload(blob, fileBase() + '.json')
  }

  return (
    <>
      <button
        type="button"
        className={'closures-btn' + (snap?.unreadCount ? ' has-new' : '')}
        onClick={() => openPanel()}
        title="DETSİS'te kapanan birimler · günlük otomatik kontrol"
      >
        Kapanan Birimler
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
          <div className="cl-panel" role="dialog" aria-modal="true" aria-label="Kapanan birimler raporu">
            <div className="cl-head">
              <div>
                <h2>Kapanan Birimler</h2>
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

            <p className="cl-note">
              Uygulama çalıştığı sürece (pencere kapalıyken de, sistem tepsisinde) DETSİS
              "Kapatılan Birimler" listesi günde bir kez taranır. Daha önce raporlanmamış kapanışlar
              yeni rapor olarak eklenir ve masaüstü bildirimi gönderilir. İdare düzeyindeki
              kapanışlar her raporda en üstte listelenir. Son 30 günün kapanışları her kontrolde
              yeniden sorgulanır; DETSİS'te aynı birim yeniden açılmışsa (adı, üst birimi veya
              statüsü değişmiş olabilir) Değişen grubuna taşınır. Bilgisayar açılınca başlatmak için
              tepsi simgesinin menüsünü kullanın.
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
                    İlk tarama: son {report.windowDays} günde kapanan birimler. Bundan sonra
                    yalnızca yeni kapanışlar raporlanır.
                  </div>
                )}

                <ClosureGroup
                  title="İdare düzeyi"
                  items={groups.idare}
                  empty="Bu raporda idare düzeyinde kapanış yok."
                  idare
                />
                <ChangedGroup items={groups.changed} />
                <ClosureGroup
                  title="Diğer birimler"
                  items={groups.other}
                  empty="Bu raporda başka kapanış yok."
                />
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
        Değişen (yeniden açılan) <span className="cl-count">{items.length.toLocaleString('tr-TR')}</span>
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
