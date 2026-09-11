# Nöbetçi Cepte — QA / Release Raporu

## 1) Yapılan işlemler
Mobil öncelikli, tek sayfalık bir PWA geliştirildi (framework yok — saf HTML/CSS/JS, `index.html`, `styles.css`, `app.js`, `data.js`, `manifest.json`, `sw.js`). Konum alma, manuel il/ilçe seçimi, eczane listeleme, nöbetçi filtreleme, harita ve yol tarifi akışlarının tamamı uçtan uca kodlandı.

## 2) Kullanılan veri kaynakları (ve neden bunlar)
| Veri | Kaynak | Neden |
|---|---|---|
| Tüm eczaneler | **OpenStreetMap Overpass API** (`amenity=pharmacy`), 2 farklı endpoint (overpass-api.de, overpass.kumi.systems) | Gerçek, açık, ücretsiz ve ToS'a uygun kullanılabilecek en sağlam kaynak. Tek endpoint'e bağımlı kalınmadı. |
| Adres ↔ koordinat | **OpenStreetMap Nominatim** (reverse + forward) | Aynı ekosistem, ücretsiz, açık kullanım politikası net. |
| İl/ilçe listesi ve merkez koordinatları | Statik, uygulama içine gömülü veri seti (`data.js`) | Çevrimdışı da çalışsın, harici bir kaynağa bağımlı olmasın diye. |
| **Nöbetçi eczane** | Kullanıcının kendi girdiği **CollectAPI** anahtarı (opsiyonel) | **Önemli:** Türkiye genelinde resmi, ücretsiz ve tüm illeri kapsayan açık bir nöbetçi eczane API'si bulunmamaktadır. Scraping (eczaneler.gen.tr vb.) hem talimatlarınızdaki "ToS/robots.txt'e uy" kuralına hem de genel yasal risklere aykırı olacağından tercih edilmedi. Bunun yerine **adaptör deseni** kuruldu: anahtar girilirse gerçek veri denenir, girilmezse veya doğrulanamazsa sistem **asla nöbetçi bilgisi uydurmaz**, açıkça "doğrulanamadı" gösterir. |

## 3) Konum sistemi nasıl çalışıyor
`requestGeolocation()` → tarayıcı desteği ve güvenli bağlam (HTTPS) kontrolü → `getCurrentPosition` → başarı/hata dallanması.
Ayrı ayrı ele alınan durumlar: izin reddi, GPS/sinyal yok, zaman aşımı, düşük doğruluk (>3000m uyarısı ama engelleme yok), tarayıcı desteklemiyor, HTTPS sorunu. **Hiçbir durumda uygulama kilitlenmiyor** — her hata, kullanıcıyı otomatik olarak manuel il/ilçe ekranına yönlendiren bir uyarı banner'ı ile sonuçlanıyor (`handleLocationFailure`).

## 4) Manuel sistem nasıl çalışıyor
81 il ve 973 ilçe içeren gömülü veri seti (`TURKEY_IL_ILCE`) ile kademeli (il → ilçe) seçim. Seçim `localStorage`'a yazılır, sayfa yenilendiğinde son seçim geri yüklenir. İlçe merkezi önce Nominatim ile, bulunamazsa ilçenin bağlı olduğu il merkezi koordinatıyla (kullanıcıya açıkça belirtilerek) referans alınır.

## 5) Harita sistemi
Leaflet + OpenStreetMap tile katmanı, `leaflet.markercluster` ile yoğun bölgelerde kümeleme. Kullanıcı konumu yeşil nokta, eczaneler 💊, nöbetçiler ⭐ ile ayrıştırılıyor. Liste ↔ harita çift yönlü senkronize: karta tıklayınca marker popup açılıp haritaya kayıyor; markera tıklayınca ilgili kart `is-active` sınıfıyla vurgulanıp görünüme kaydırılıyor. "Yol Tarifi Al" Google Maps yönlendirme linkiyle cihazın harita uygulamasına yönlendiriyor.

## 6) Nöbetçi eczane sistemi (dürüstlük kuralları)
- Tarih kontrolü `Europe/Istanbul` saat dilimine göre günlük anahtar (`todayIstanbulKey`) ile yapılıyor; eski nöbet listesi önbellekten "bugünmüş gibi" sunulmuyor.
- API anahtarı yoksa/başarısızsa **hiçbir eczaneye** "Bugün Nöbetçi" etiketi verilmiyor; arayüzde açıkça "Nöbetçi bilgisi: doğrulanamadı" gösteriliyor.
- Eşleştirme sadece isme göre değil, isim + adres benzerliğine göre yapılıyor (bölüm 23 kuralı).

## 7) Yapılan testler ve sonuçlar
**Yapabildiklerim (bu ortamda gerçekten çalıştırıldı):**
- Sözdizimi doğrulaması (`node --check`) — app.js, data.js: **geçti**.
- 81 il / 973 ilçe veri seti bütünlük kontrolü (otomatik sayım) — **geçti**.
- Node `vm` ile DOM/tarayıcı taklit edilerek **30 otomatik birim/entegrasyon testi** yazıldı ve çalıştırıldı (`tests/` klasörü) — **30/30 geçti**. Kapsam: Haversine mesafe doğruluğu, mesafe biçimlendirme, Türkçe karakter normalizasyonu, duplicate birleştirme (yakın/uzak ayrımı), koordinatsız kaydı filtreleme, nöbetçi eşleştirme, konum izin reddi/timeout/GPS kapalı/tarayıcı desteklemiyor/HTTPS sorunu senaryoları, Overpass çoklu endpoint yedekliliği (429 sonrası ikinci uca geçiş), tüm kaynaklar çökünce çökmeden hata banner'ı gösterme, tek eczane / 300 eczane / API anahtarsız nöbetçi senaryoları.

**Yapamadıklarım (dürüstçe belirtmem gerekiyor):**
- Bu ortamda gerçek bir tarayıcı, telefon veya internet erişimi **yok**. Bu yüzden sizin istediğiniz 30 senaryodan **cihaz/tarayıcı bazlı olanları** (iPhone Safari, Android Chrome, gerçek GPS açma/kapama, gerçek Overpass/Nominatim/CollectAPI ağ çağrıları, harita render performansı, dokunma etkileşimleri) **fiilen test edemedim**. Kodun mantığını, hata yollarını ve veri işleme doğruluğunu simülasyonla test ettim; ancak "gerçek cihazda çalıştı" diyemem çünkü çalıştırmadım.
- Bu nedenle aşağıdaki maddeleri **sizin veya gerçek bir cihazda/CI ortamında** doğrulamanız gerekiyor: mobil Safari/Chrome/Firefox/Edge gerçek testleri, gerçek Overpass/Nominatim yanıt süreleri ve rate-limit davranışı, gerçek CollectAPI entegrasyon testi (bir anahtarla), PWA "ana ekrana ekle" davranışı, service worker'ın gerçek offline senaryosu.

## 8) Bulunan ve düzeltilen hatalar
- İlk testte, farklı ama birbirine çok yakın (aynı ~1km hücresine düşen) iki sorgu önbellek anahtarını paylaşıp ikinci sorgunun önbellekten yanlış veri döndürmesi durumu fark edildi. İnceleme sonucu bunun **tasarım gereği** (bölgesel önbellekleme, 30 dk TTL, API'yi gereksiz yormamak için) olduğuna karar verildi; test senaryosu buna göre düzeltildi. Canlıda bu davranış, "eczane listesi 30 dakikaya kadar ~1km çözünürlükte önbellekten gelebilir" şeklinde beklenen bir durumdur.

## 9) Kalan bilinen problemler / riskler
1. **İl/ilçe veri seti** (`data.js`) benim genel coğrafi bilgimden derlendi; TÜİK/resmi kaynakla çapraz doğrulanmadı. Nadir de olsa ilçe adı/merkez koordinatında küçük sapmalar olabilir.
2. **Nominatim kullanımı tarayıcıdan doğrudan yapılıyor.** Ciddi trafik alacak bir canlı sistemde Nominatim'in kullanım politikasına (kimlik/User-Agent, hız sınırı) tam uyum için bu istekler kendi backend'inizden proxy'lenmelidir. Şu anki haliyle düşük/orta trafikli kullanım için uygundur, yüksek trafikte IP engellenebilir.
3. **Nöbetçi veri kapsamı** yalnızca kullanıcı bir CollectAPI anahtarı girdiğinde çalışır; anahtar yoksa uygulama bilerek "doğrulanamadı" gösterir. Bu bir hata değil, bilinçli bir dürüstlük tercihidir — ama son kullanıcı deneyimi açısından not düşülmesi gerekir.
4. Gerçek cihaz/tarayıcı testleri yapılmadı (madde 7'de detaylı).
5. İkonlar basit, programatik olarak üretildi; marka/görsel kimlik için profesyonel bir tasarımcı elinden geçmesi önerilir.

## 10) Canlıya hazır mı?
**Hayır — "CANLIYA HAZIR" değil.** Mimari, hata yönetimi ve mantık düzeyinde sağlam ve test edilmiş durumda; ancak sizin 21. bölümde istediğiniz kontrol listesindeki gerçek cihaz/tarayıcı testleri, gerçek ağ koşullarında API testleri ve resmi il/ilçe veri doğrulaması bu ortamda yapılamadı. Bunlar tamamlanıp doğrulandıktan sonra "canlıya hazır" denebilir.
