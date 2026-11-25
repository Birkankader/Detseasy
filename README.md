# Detseasy

DETSİS (Devlet Teşkilatı Merkezi Kayıt Sistemi) birimlerini filtreleyip incelemek için React + Electron tabanlı masaüstü uygulaması.

## Özellikler

- İl / İlçe / Kategori / Statü / Üst Birim / Bütçe Türü filtreleri
- Hızlı ön ayar chip'leri (Bakanlıklar, Belediyeler, Şirketler, Üniversiteler, …)
- Hiyerarşik ağaç ile görsel birim seçimi (lazy-load)
- Çoklu **ata kategori** filtresi
  - ✓ pozitif chip'ler aralarında OR (biri ata olsa yeter)
  - ✗ negatif chip'ler aralarında AND (hiçbiri ata olmamalı)
- Sonuçlar geldikçe ekrana akar (streaming, paralel 5 worker)
- Tüm sayfalar önden çekilir, sayfalama anlık (client-side slice)
- Tablo sıralaması, sonuçlarda metin arama (tr locale)
- CSV (Excel uyumlu, UTF-8 BOM, `;` ayraç) ve JSON indirme
- **Kapanan birim takibi**: günde bir kez DETSİS'te kapanan birimler taranır; yeni kapanış
  varsa masaüstü bildirimi + rapor paneli (idare düzeyindekiler en üstte)
- **Sistem tepsisi**: pencere kapanınca uygulama tepside çalışmaya devam eder; isteğe bağlı
  bilgisayar açılınca (gizli) başlatma

## Geliştirme

### Tarayıcı

```bash
npm install
npm run dev
```

`http://localhost:5173` adresine git. Vite, `/detsis` isteklerini yetkiliapi.detsis.gov.tr'ye proxy yapar (gov başlıkları enjekte edilir).

### Electron (masaüstü)

```bash
npm install
npm run electron:dev
```

## Production build

```bash
npm run electron:build         # mevcut platform için installer
npm run electron:build:mac     # macOS (.dmg + .zip)
npm run electron:build:win     # Windows (NSIS .exe + portable + zip)
npm run electron:build:linux   # Linux (.AppImage + .deb)
```

Çıktılar `release/` altında.

> Çapraz platform build (Mac'ten Win exe vb.) electron-builder Wine'ı kendi indirir. Sağlam ürün için her platformda yerelde build veya GitHub Actions kullanmak önerilir.

## Mimari

- **Renderer**: React 18 + Vite, `src/` altında.
- **Main process**: `electron/main.cjs` — uygulama açılırken localhost'ta rastgele portta HTTP proxy başlatır: `/detsis/...` → `https://yetkiliapi.detsis.gov.tr/...`. Detsis'in talep ettiği `Origin`, `Referer`, `User-Agent` başlıklarını enjekte eder.
- **Preload**: `electron/preload.cjs` — port bilgisini renderer'a `window.DETSIS_PROXY_BASE` olarak verir. `src/api.js` bunu okur; tarayıcı dev modunda fallback olarak `/detsis` (Vite proxy) kullanır.

## Kapanan Birim Takibi

Header'daki **Kapanan Birimler** butonu raporu açar; rozet okunmamış yeni kapanış sayısını
gösterir (kırmızı = aralarında idare düzeyinde kapanış var).

- **Kaynak**: DETSİS "Birim Değişiklikleri" sayfasının kullandığı uç noktalar:
  `kapatilanbirimler/{gün}` (son N günde kapananlar) + `birimislemkunye/{birimTarihceId}`
  (hiyerarşi, kategori, statü, adres).
- **Zamanlama**: main process (`electron/closures.cjs`) uygulama açılışından birkaç saniye sonra
  ve sonra her 30 dk'da bakar; o takvim gününde başarılı kontrol yoksa tarar. Yani günde bir
  kontrol; hata olursa 30 dk sonra tekrar dener. Panelde **Şimdi kontrol et** ile elle tetiklenir.
- **Fark alma**: her kontrol son 30 günü çeker (uzun süre kapalı kaldıysa 90 güne kadar),
  daha önce raporlanmış kapanışları eler. Geriye tarihli girilen kapanışlar da yakalanır.
  Kapanış birim id + kapanış günü ile tanımlanır.
- **İlk çalıştırma**: son 30 günün kapanışları "ilk tarama" raporu olarak gelir; bildirim
  gönderilmez, rozete sayılmaz.
- **İdare düzeyi**: DETSİS'in "ANA KURUM VE KURULUŞ" grubundaki kategoriler (Bakanlık,
  Belediye, Bağlı/İlgili/İlişkili Kuruluş, Yükseköğretim Kurumu, İl Özel İdaresi, …) + Şirket,
  Mahalli Birlik, Mülki İdare Teşkilatı. Liste: `IDARE_KATEGORILERI` (`electron/closures.cjs`).
- **Durum dosyası**: `userData/kapanan-birimler.json` (son 60 rapor + görülen kapanışlar).
- **Kısıt**: yalnızca uygulama çalışırken kontrol eder (pencere kapalıyken tepside çalışma için
  aşağıya bakın). Kapalı geçen günler bir sonraki açılışta telafi edilir. Açık API ileri
  tarihli kapanış göstermiyor (negatif gün sorgusu boş döner); kapanış listeye kapanış tarihi
  gelince düşer.

### Sistem tepsisi

Windows ve macOS'ta tepside (macOS: menü çubuğunda) Detseasy simgesi durur; kapanan birim
kontrolü pencere kapalıyken de sürer.

- **Pencereyi kapatmak** uygulamayı kapatmaz (Windows): pencere kapanır, uygulama tepside
  çalışır. İlk seferde bunu anlatan bir bildirim çıkar. Tamamen kapatmak: tepsi menüsü →
  **Çıkış**. Bu davranış menüdeki **Pencere kapanınca tepside çalış** ile kapatılabilir.
  macOS'ta uygulama zaten pencere kapansa da çalışmaya devam eder.
- **Tepsi menüsü**: Detseasy'yi aç, Kapanan Birimler (okunmamış sayısıyla), Şimdi kontrol et,
  Bilgisayar açılınca başlat, indirilmiş güncelleme varsa Güncellemeyi yükle, Çıkış.
  Windows'ta simgeye sol tıklamak pencereyi açar; okunmamış kapanış varsa simgede kırmızı nokta
  belirir (macOS'ta simgenin yanında sayı).
- **Bilgisayar açılınca başlat**: yalnızca kurulu sürümde (dev/portable'da yok). Windows'ta
  `HKCU\…\Run` kaydına `--hidden` ile eklenir, açılışta pencere açılmadan tepside başlar.
  macOS'ta Giriş Öğeleri'ne eklenir (macOS 13+ onay isteyebilir) ve pencereyle açılır.
  Uygulama kaldırılırken bu kayıt silinmez; kaldırmadan önce menüden kapatın.
- **Tek örnek**: uygulama tepsideyken kısayoldan yeniden açmak yeni kopya başlatmaz, mevcut
  pencereyi açar.
- **Güncelleme**: tepsideyken indirilen güncelleme bildirimle haber verilir; tıklayınca ya da
  menüden yüklenir.
- **Ayarlar**: `userData/settings.json`.

## Otomatik Güncelleme

NSIS Setup ile kurulu sürümlerde tam **auto-update**:

1. App açılışta + her 30 dk'da GitHub Releases'ı kontrol eder (`electron-updater`)
2. Yeni sürüm varsa **arka planda otomatik indirir** (progress banner üstte)
3. İndirme bitince banner **"Yükle ve yeniden başlat"** butonuna döner
4. Tıkla → installer çalışır, app yeniden başlar (kullanıcı dosya kopyalamaz)

Sağ alt köşede her zaman sürüm rozeti vardır; tıklayınca anlık kontrol tetikler.
Portable veya dev modunda rozet sarı nokta ile işaretlenir (auto-update yok).

### Yeni sürüm yayınlama (geliştirici tarafı)

`electron-builder` GH_TOKEN ile GitHub release'i kendi oluşturur, `latest.yml`
metadata dosyası dahil tüm artefaktları yükler. `latest.yml` olmadan istemci
auto-update tetiklenmez — bu yüzden manuel `gh release create` YERİNE
electron-builder'ı kullanın:

```bash
# 1. Versiyonu artır
npm version patch       # 0.1.0 -> 0.1.1, otomatik commit + tag
git push --follow-tags

# 2. GitHub Personal Access Token (repo scope) export et
export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# 3. Build + publish (release otomatik, taslak olarak oluşur)
npm run electron:build:win -- --publish always
```

Sonra GitHub'da release'i "Draft" → "Published" yapın. Açık olan tüm Detseasy
örnekleri 30 dk içinde otomatik tetiklenir; banner indirme progress'i gösterir,
kullanıcı tek tıkla yükler.

## Lisans

MIT.
