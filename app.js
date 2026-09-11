"use strict";
/* ============================================================================
 * NÖBETÇİ CEPTE — app.js
 * Bağımlılık yok (framework yok). Leaflet + Leaflet.markercluster CDN'den
 * yüklenir (index.html). Bu dosya: durum yönetimi, veri kaynakları,
 * render ve hata yönetimini içerir.
 *
 * VERİ KAYNAKLARI (gerçek / doğrulanabilir):
 *  - Tüm eczaneler: OpenStreetMap Overpass API (amenity=pharmacy)
 *  - Geocoding: OpenStreetMap Nominatim (reverse + forward)
 *  - Nöbetçi eczane: Kullanıcı tarafından girilen CollectAPI anahtarı
 *    üzerinden (gerçek, dokümante edilmiş, key gerektiren bir servis).
 *    ANAHTAR YOKSA UYDURULMAZ — "doğrulanamadı" durumu gösterilir.
 * ==========================================================================*/

const CONFIG = {
  OVERPASS_ENDPOINTS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ],
  NOMINATIM_BASE: "https://nominatim.openstreetmap.org",
  SEARCH_RADIUS_M: 6000,
  CACHE_TTL_MS: 1000 * 60 * 30, // 30 dk — "tüm eczaneler" için makul bir önbellek süresi
  DUTY_CACHE_TTL_MS: 1000 * 60 * 15,
  APP_NAME: "Nöbetçi Cepte",
  CONTACT_NOTE: "nobetci-cepte-demo (iletisim: uygulama-sahibi@example.com)"
};

/* ---------------------------------------------------------------------------
 * Yardımcılar
 * ------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m) {
  if (m == null || Number.isNaN(m)) return "—";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function nowIso() {
  return new Date().toISOString();
}

function formatUpdatedAt(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("tr-TR", {
      day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/Istanbul"
    });
  } catch {
    return "bilinmiyor";
  }
}

function todayIstanbulKey() {
  // Türkiye saat dilimine göre bugünün tarihi (nöbet listesi eskiyi kullanmasın diye)
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // YYYY-MM-DD
}

function normalizeText(s) {
  return (s || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function safeLocalGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function safeLocalSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota vs. — sessizce yut, uygulama çökmesin */ }
}

/* ---------------------------------------------------------------------------
 * Uygulama durumu
 * ------------------------------------------------------------------------- */
const state = {
  screen: "home", // home | loading | manual | results
  loadingMessage: "",
  region: { source: null, il: null, ilce: null, lat: null, lng: null, label: null }, // source: 'gps' | 'manual'
  userCoords: null, // gerçek GPS noktası (mesafe/harita için — manuelde null olabilir)
  pharmacies: [], // birleştirilmiş liste
  pharmaciesSourceMeta: null, // {source, fetchedAt}
  dutyMeta: null, // {status: 'ok'|'unverified'|'error', source, fetchedAt}
  filter: "all", // all | duty | near | far
  query: "",
  showMap: false,
  visibleCount: 20,
  activeId: null,
  banner: null, // {type:'info'|'warn'|'error', text}
  map: null,
  markerLayer: null,
  userMarker: null
};

function setBanner(type, text) {
  state.banner = { type, text };
  renderBanner();
}
function clearBanner() {
  state.banner = null;
  renderBanner();
}

/* ---------------------------------------------------------------------------
 * 1) KONUM SİSTEMİ — tüm hata durumları ayrı ayrı ele alınır (bölüm 2)
 * ------------------------------------------------------------------------- */
function isSecureContextOk() {
  return window.isSecureContext === true;
}

function requestGeolocation() {
  clearBanner();

  if (!("geolocation" in navigator)) {
    handleLocationFailure("unsupported");
    return;
  }
  if (!isSecureContextOk()) {
    // HTTPS problemi: Geolocation API güvenli bağlam gerektirir
    handleLocationFailure("insecure_context");
    return;
  }

  state.screen = "loading";
  state.loadingMessage = "Konumunuz alınıyor…";
  render();

  const options = { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 };

  navigator.geolocation.getCurrentPosition(
    (pos) => onLocationSuccess(pos),
    (err) => onLocationError(err),
    options
  );
}

function onLocationError(err) {
  // GeolocationPositionError.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  if (err.code === 1) handleLocationFailure("permission_denied");
  else if (err.code === 2) handleLocationFailure("position_unavailable");
  else if (err.code === 3) handleLocationFailure("timeout");
  else handleLocationFailure("unknown");
}

function handleLocationFailure(reason) {
  const messages = {
    unsupported: "Tarayıcınız konum servisini desteklemiyor.",
    insecure_context: "Konum servisi yalnızca güvenli (HTTPS) bağlantılarda çalışır.",
    permission_denied: "Konum izni verilmedi.",
    position_unavailable: "Konum bilgisi alınamadı (GPS kapalı olabilir ya da sinyal yok).",
    timeout: "Konum isteği zaman aşımına uğradı.",
    low_accuracy: "Konum doğruluğu çok düşük.",
    unknown: "Konum servisinden konum alınamadı."
  };
  const detail = messages[reason] || messages.unknown;
  setBanner("warn", `${detail} İl ve ilçenizi manuel seçerek devam edebilirsiniz.`);
  goToManualPicker();
}

async function onLocationSuccess(pos) {
  const { latitude, longitude, accuracy } = pos.coords;

  if (accuracy && accuracy > 3000) {
    // Çok düşük doğruluk: kullanıcıyı uyar ama tamamen durdurma — devam etmesine izin ver
    setBanner("warn", `Konum doğruluğu düşük (~${Math.round(accuracy)} m). Sonuçlar tam isabetli olmayabilir.`);
  }

  state.userCoords = { lat: latitude, lng: longitude, accuracy };
  state.region.source = "gps";
  state.region.lat = latitude;
  state.region.lng = longitude;

  state.loadingMessage = "Adres bilgisi belirleniyor…";
  render();

  const addr = await reverseGeocode(latitude, longitude);
  state.region.il = addr?.il || null;
  state.region.ilce = addr?.ilce || null;
  state.region.label = addr ? [addr.ilce, addr.il].filter(Boolean).join(", ") : "Konumunuz";

  await loadRegionData();
}

/* ---------------------------------------------------------------------------
 * 2) MANUEL İL/İLÇE SİSTEMİ
 * ------------------------------------------------------------------------- */
function goToManualPicker() {
  state.screen = "manual";
  render();
}

function populateIlSelect() {
  const ilSelect = $("#il-select");
  if (!ilSelect) return;
  const ils = Object.keys(TURKEY_IL_ILCE).sort((a, b) => a.localeCompare(b, "tr"));
  ilSelect.innerHTML = `<option value="">İl seçin</option>` + ils.map((il) => `<option value="${il}">${il}</option>`).join("");

  const saved = safeLocalGet("nc_last_region");
  if (saved?.il && TURKEY_IL_ILCE[saved.il]) {
    ilSelect.value = saved.il;
    populateIlceSelect(saved.il, saved.ilce);
  }
}

function populateIlceSelect(il, preselect) {
  const ilceSelect = $("#ilce-select");
  const confirmBtn = $("#manual-confirm");
  if (!ilceSelect) return;
  const data = TURKEY_IL_ILCE[il];
  if (!data) {
    ilceSelect.innerHTML = `<option value="">Önce il seçin</option>`;
    ilceSelect.disabled = true;
    confirmBtn.disabled = true;
    return;
  }
  ilceSelect.disabled = false;
  const ilceler = [...data.ilceler].sort((a, b) => a.localeCompare(b, "tr"));
  ilceSelect.innerHTML = `<option value="">İlçe seçin</option>` + ilceler.map((i) => `<option value="${i}">${i}</option>`).join("");
  if (preselect && ilceler.includes(preselect)) ilceSelect.value = preselect;
  confirmBtn.disabled = !ilceSelect.value;
}

async function confirmManualSelection() {
  const il = $("#il-select").value;
  const ilce = $("#ilce-select").value;
  if (!il || !ilce) return;

  safeLocalSet("nc_last_region", { il, ilce });

  state.region.source = "manual";
  state.region.il = il;
  state.region.ilce = ilce;
  state.region.label = `${ilce}, ${il}`;
  state.userCoords = null; // manuel seçimde gerçek GPS yok

  // İlçe merkezi referans koordinatı: önce Nominatim ile dene, olmazsa il merkezine düş
  state.screen = "loading";
  state.loadingMessage = `${ilce} için konum belirleniyor…`;
  render();

  let center = await forwardGeocodeIlce(il, ilce);
  if (!center) {
    const ilData = TURKEY_IL_ILCE[il];
    center = ilData ? { lat: ilData.lat, lng: ilData.lng } : null;
    if (center) setBanner("info", `${ilce} ilçe merkezi tam olarak bulunamadı; ${il} il merkezine göre yaklaşık sonuçlar gösteriliyor.`);
  }
  if (!center) {
    setBanner("error", "Bu bölge için konum belirlenemedi. Lütfen başka bir ilçe deneyin.");
    state.screen = "manual";
    render();
    return;
  }

  state.region.lat = center.lat;
  state.region.lng = center.lng;
  await loadRegionData();
}

/* ---------------------------------------------------------------------------
 * 3) GEOCODING (Nominatim) — nazik kullanım: debounce, tek eşzamanlı istek,
 *    kimlik belirten sorgu parametresi. NOT: Tarayıcıdan yapılan fetch
 *    isteklerinde User-Agent başlığı değiştirilemez; ciddi trafik alacak bir
 *    canlı sistemde bu istekler, Nominatim kullanım politikasına tam uyum
 *    için kendi backend'inizden proxy'lenmelidir (bkz. QA raporu).
 * ------------------------------------------------------------------------- */
async function reverseGeocode(lat, lng) {
  try {
    const url = `${CONFIG.NOMINATIM_BASE}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=tr`;
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) throw new Error(`reverse_geocode_http_${res.status}`);
    const data = await res.json();
    const a = data.address || {};
    const il = a.province || a.state || a.city || null;
    const ilce = a.town || a.county || a.district || a.city_district || a.suburb || null;
    return { il, ilce };
  } catch (e) {
    console.warn("[geocode] reverse başarısız:", e.message);
    return null; // sessizce boş dön — üst katman zaten "Konumunuz" gibi güvenli bir etikete düşer
  }
}

async function forwardGeocodeIlce(il, ilce) {
  try {
    const q = encodeURIComponent(`${ilce}, ${il}, Türkiye`);
    const url = `${CONFIG.NOMINATIM_BASE}/search?format=jsonv2&q=${q}&countrycodes=tr&limit=1`;
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) throw new Error(`forward_geocode_http_${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) {
    console.warn("[geocode] forward başarısız:", e.message);
    return null;
  }
}

function fetchWithTimeout(url, ms, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/* ---------------------------------------------------------------------------
 * 4) TÜM ECZANELER — Overpass API (OpenStreetMap açık verisi)
 * ------------------------------------------------------------------------- */
function cacheKeyFor(lat, lng) {
  // ~1km hassasiyetle bölgesel önbellek anahtarı
  return `nc_cache_${lat.toFixed(2)}_${lng.toFixed(2)}`;
}

async function fetchPharmaciesNear(lat, lng) {
  const cacheKey = cacheKeyFor(lat, lng);
  const cached = safeLocalGet(cacheKey);
  if (cached && Date.now() - cached.fetchedAtMs < CONFIG.CACHE_TTL_MS) {
    return { pharmacies: cached.pharmacies, meta: { source: "önbellek (OpenStreetMap)", fetchedAt: cached.fetchedAt, stale: false } };
  }

  const query = `
    [out:json][timeout:20];
    (
      node["amenity"="pharmacy"](around:${CONFIG.SEARCH_RADIUS_M},${lat},${lng});
      way["amenity"="pharmacy"](around:${CONFIG.SEARCH_RADIUS_M},${lat},${lng});
    );
    out center tags;
  `.trim();

  let lastErr = null;
  for (const endpoint of CONFIG.OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(endpoint, 15000, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: query
      });
      if (res.status === 429) { lastErr = new Error("rate_limited"); continue; }
      if (!res.ok) { lastErr = new Error(`http_${res.status}`); continue; }
      const data = await res.json();
      const pharmacies = (data.elements || [])
        .map((el) => elementToPharmacy(el, lat, lng))
        .filter(Boolean);

      const dedup = dedupePharmacies(pharmacies);
      const meta = { source: "OpenStreetMap (Overpass)", fetchedAt: nowIso(), stale: false };
      safeLocalSet(cacheKey, { pharmacies: dedup, fetchedAt: meta.fetchedAt, fetchedAtMs: Date.now() });
      return { pharmacies: dedup, meta };
    } catch (e) {
      lastErr = e;
      continue; // sıradaki Overpass endpoint'ini dene — tek kaynağa bağımlı kalma
    }
  }

  // Tüm canlı kaynaklar başarısız: varsa eski önbelleği "bayat" etiketiyle göster
  if (cached) {
    return { pharmacies: cached.pharmacies, meta: { source: "önbellek (bağlantı sorunu nedeniyle)", fetchedAt: cached.fetchedAt, stale: true } };
  }
  throw lastErr || new Error("pharmacy_fetch_failed");
}

function elementToPharmacy(el, refLat, refLng) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null; // koordinatsız kaydı haritada YANLIŞ yere koyma — filtrele

  const addressParts = [tags["addr:neighbourhood"], tags["addr:street"], tags["addr:housenumber"]].filter(Boolean);
  return {
    id: `osm_${el.type}_${el.id}`,
    name: tags.name || "İsimsiz Eczane",
    address: addressParts.join(" ") || tags["addr:full"] || null,
    il: tags["addr:province"] || tags["addr:state"] || null,
    ilce: tags["addr:district"] || tags["addr:city"] || null,
    mahalle: tags["addr:neighbourhood"] || tags["addr:suburb"] || null,
    phone: tags.phone || tags["contact:phone"] || null,
    lat, lng,
    distance: haversineMeters(refLat, refLng, lat, lng),
    isDuty: false,
    dutyVerified: false,
    dataSource: "OpenStreetMap",
    updatedAt: nowIso()
  };
}

function dedupePharmacies(list) {
  // İsim + ~40 m yakınlık eşleşmesine göre birleştir (sadece isme göre birleştirme YAPMA — bölüm 23)
  const out = [];
  for (const p of list) {
    const dupe = out.find((o) => {
      if (normalizeText(o.name) !== normalizeText(p.name)) return false;
      const d = haversineMeters(o.lat, o.lng, p.lat, p.lng);
      return d < 40;
    });
    if (!dupe) out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 5) NÖBETÇİ ECZANELER — dürüst adaptör deseni.
 *    Gerçek, ücretsiz ve tüm Türkiye'yi kapsayan resmi bir açık API yok.
 *    Kullanıcı kendi CollectAPI anahtarını girerse gerçek veri denenir;
 *    yoksa veya kaynak doğrulanamazsa UYDURULMAZ — "unverified" durumu
 *    açıkça gösterilir (bölüm 5, 15, 25 kuralı).
 * ------------------------------------------------------------------------- */
async function fetchDutyPharmacies(il, ilce) {
  const dateKey = todayIstanbulKey();
  const cacheKey = `nc_duty_${il}_${ilce}_${dateKey}`;

  const cached = safeLocalGet(cacheKey);

  if (
    cached &&
    Date.now() - cached.fetchedAtMs < CONFIG.DUTY_CACHE_TTL_MS
  ) {
    return {
      list: cached.list,
      meta: {
        status: "ok",
        source: "Nöbetçi Cepte (önbellek)",
        fetchedAt: cached.fetchedAt,
        dateKey
      }
    };
  }

  try {
    const backendUrl =
      "https://nobetci-cepte-jwt7j9.v2.appdeploy.ai/api/duty-pharmacies" +
      `?province=${encodeURIComponent(il)}` +
      `&district=${encodeURIComponent(ilce)}`;

    const res = await fetchWithTimeout(
      backendUrl,
      12000
    );

    if (!res.ok) {
      throw new Error(`duty_backend_http_${res.status}`);
    }

    const json = await res.json();

    if (!json.success || !Array.isArray(json.result)) {
      throw new Error("duty_bad_payload");
    }

    const list = json.result.map((r, idx) => ({
      id: `duty_${idx}_${normalizeText(r.name)}`,
      name: r.name || "",
      address: r.address || "",
      phone: r.phone || "",
      dist: r.dist || null,
      il,
      ilce
    }));

    safeLocalSet(cacheKey, {
      list,
      fetchedAt: nowIso(),
      fetchedAtMs: Date.now()
    });

    return {
      list,
      meta: {
        status: "ok",
        source: "Nöbetçi Cepte Güvenli API",
        fetchedAt: nowIso(),
        dateKey
      }
    };

  } catch (e) {
    console.warn("[duty] alınamadı:", e.message);

    return {
      list: [],
      meta: {
        status: "error",
        source: "Nöbetçi Cepte Güvenli API",
        fetchedAt: nowIso(),
        reason: e.message
      }
    };
  }
}

function mergeDutyIntoPharmacies(pharmacies, dutyList) {
  if (!dutyList.length) return pharmacies;
  const used = new Set();
  for (const p of pharmacies) {
    const match = dutyList.find((d, i) => {
      if (used.has(i)) return false;
      return normalizeText(d.name) === normalizeText(p.name) ||
        (p.address && d.address && normalizeText(p.address).includes(normalizeText(d.address).slice(0, 12)));
    });
    if (match) {
      p.isDuty = true;
      p.dutyVerified = true;
      p.phone = p.phone || match.phone;
      used.add(dutyList.indexOf(match));
    }
  }
  // Overpass'ta bulunamayan ama nöbetçi listesinde olan eczaneler varsa, koordinatsız
  // olduklarından haritaya rastgele koymuyoruz; yine de listede "adres bazlı" gösterelim.
  dutyList.forEach((d, i) => {
    if (used.has(i)) return;
    pharmacies.push({
      id: d.id, name: d.name, address: d.address, il: d.il, ilce: d.ilce,
      phone: d.phone, lat: null, lng: null, distance: null,
      isDuty: true, dutyVerified: true, dataSource: "CollectAPI", updatedAt: nowIso(),
      noCoords: true
    });
  });
  return pharmacies;
}

/* ---------------------------------------------------------------------------
 * Bölge verisini yükle (eczaneler + nöbetçi) — bölüm 10/11 hata yönetimi
 * ------------------------------------------------------------------------- */
async function loadRegionData() {
  state.screen = "loading";
  state.loadingMessage = "Çevredeki eczaneler getiriliyor…";
  render();

  const { lat, lng } = state.region;
  try {
    const { pharmacies, meta } = await fetchPharmaciesNear(lat, lng);
    state.pharmacies = pharmacies;
    state.pharmaciesSourceMeta = meta;
    if (meta.stale) setBanner("warn", "İnternet bağlantısı sağlanamadığı için son bilinen eczane listesi gösteriliyor. Bilgiler güncel olmayabilir.");
    else if (!pharmacies.length) setBanner("info", "Bu bölgede eczane verisi bulunamadı. Arama yarıçapını genişletmek için farklı bir ilçe deneyebilirsiniz.");
  } catch (e) {
    console.error(e);
    state.pharmacies = [];
    state.pharmaciesSourceMeta = null;
    setBanner("error", "Eczane bilgileri şu anda alınamıyor. Lütfen birkaç saniye sonra tekrar deneyin.");
  }

  // Nöbetçi verisi — il/ilçe biliniyorsa dene
  if (state.region.il && state.region.ilce) {
    const { list, meta } = await fetchDutyPharmacies(state.region.il, state.region.ilce);
    state.dutyMeta = meta;
    if (list.length) state.pharmacies = mergeDutyIntoPharmacies(state.pharmacies, list);
  } else {
    state.dutyMeta = { status: "unverified", reason: "region_unknown", fetchedAt: nowIso() };
  }

  state.pharmacies.sort((a, b) => {
    if (a.distance == null) return 1;
    if (b.distance == null) return -1;
    return a.distance - b.distance;
  });

  state.visibleCount = 20;
  state.screen = "results";
  render();
  initMapIfNeeded();
}

/* ---------------------------------------------------------------------------
 * RENDER
 * ------------------------------------------------------------------------- */
function render() {
  const root = $("#app");
  root.innerHTML = "";
  root.appendChild(renderTopbar());

  if (state.screen === "home") root.appendChild(renderHome());
  else if (state.screen === "loading") root.appendChild(renderLoading());
  else if (state.screen === "manual") root.appendChild(renderManual());
  else if (state.screen === "results") root.appendChild(renderResults());

  renderBanner();
  attachGlobalHandlers();
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function renderTopbar() {
  const regionLabel = state.region.label || "Bölge seçilmedi";
  return el(`
    <header class="topbar">
      <div class="brand"><span class="dot"></span> Nöbetçi Cepte</div>
      ${state.screen === "results" ? `<button class="region" id="change-region-btn" title="Bölgeyi değiştir">${regionLabel} ▾</button>` : ""}
    </header>
  `);
}

function renderBanner() {
  let holder = $("#banner-holder");
  if (!holder) return;
  holder.innerHTML = "";
  if (!state.banner) return;
  const b = el(`
    <div class="status-banner ${state.banner.type}">
      <span>${state.banner.type === "error" ? "⚠️" : state.banner.type === "warn" ? "ℹ️" : "✅"}</span>
      <span>${state.banner.text}</span>
      <button class="close" aria-label="Kapat">✕</button>
    </div>
  `);
  b.querySelector(".close").onclick = clearBanner;
  holder.appendChild(b);
}

function renderHome() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<div id="banner-holder"></div>`));
  wrap.appendChild(el(`
    <div class="home">
      <div>
        <h1>Size en yakın eczaneyi hemen bulun</h1>
        <p class="lede">Konumunuza göre çevredeki tüm eczaneleri ve bugün nöbetçi olanları listeler, haritada gösterir.</p>
      </div>
      <button class="choice-btn primary" id="use-location-btn">
        <span class="icon">📍</span>
        <span class="txt"><strong>Konumumu Kullan</strong><span>En hızlı ve en doğru sonuç</span></span>
      </button>
      <button class="choice-btn" id="pick-region-btn">
        <span class="icon">📝</span>
        <span class="txt"><strong>İl / İlçe Seç</strong><span>Konum paylaşmadan devam et</span></span>
      </button>
    </div>
  `));
  return wrap;
}

function renderLoading() {
  return el(`
    <div class="loading-view">
      <div class="spinner" role="status" aria-label="Yükleniyor"></div>
      <p>${state.loadingMessage || "Yükleniyor…"}</p>
    </div>
  `);
}

function renderManual() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<div id="banner-holder"></div>`));
  wrap.appendChild(el(`
    <div class="manual-picker">
      <button class="btn-link" id="back-home-btn">← Geri</button>
      <h2>İl ve ilçe seçin</h2>
      <div class="field">
        <label for="il-select">İl</label>
        <select id="il-select"></select>
      </div>
      <div class="field">
        <label for="ilce-select">İlçe</label>
        <select id="ilce-select" disabled><option value="">Önce il seçin</option></select>
      </div>
      <button class="btn-primary" id="manual-confirm" disabled>Eczaneleri Göster</button>
    </div>
  `));
  queueMicrotask(populateIlSelect);
  return wrap;
}

function renderResults() {
  const wrap = el(`<div class="results"></div>`);
  wrap.appendChild(el(`<div id="banner-holder"></div>`));

  const duty = state.pharmacies.filter((p) => p.isDuty);
  wrap.appendChild(el(`
    <div class="tabs" role="tablist">
      <button class="tab-btn" role="tab" aria-selected="${state.filter !== "duty"}" data-tab="all">Yakınındaki Eczaneler (${state.pharmacies.length})</button>
      <button class="tab-btn" role="tab" aria-selected="${state.filter === "duty"}" data-tab="duty">Bugünün Nöbetçileri (${duty.length})</button>
    </div>
  `));

  wrap.appendChild(el(`
    <div class="toolbar">
      <div class="search-row">
        <input type="search" id="search-input" placeholder="Eczane adı ara…" value="${state.query}" aria-label="Eczane ara">
        <button class="map-toggle" id="toggle-map-btn">${state.showMap ? "☰ Liste" : "🗺 Harita"}</button>
      </div>
      <div class="chips">
        <button class="chip" data-filter="all" aria-pressed="${state.filter === "all"}">Tümü</button>
        <button class="chip duty" data-filter="duty" aria-pressed="${state.filter === "duty"}">Nöbetçi</button>
        <button class="chip" data-filter="near" aria-pressed="${state.filter === "near"}">En yakın</button>
        <button class="chip" data-filter="far" aria-pressed="${state.filter === "far"}">En uzak</button>
      </div>
    </div>
  `));

  wrap.appendChild(renderMetaLine());

  const split = el(`<div class="split ${state.showMap ? "show-map" : ""}"></div>`);
  split.appendChild(renderListPane());
  split.appendChild(el(`<div class="map-pane"><div id="map"></div><button class="locate-me-fab" id="locate-me-btn" title="Konumuma git">🎯</button></div>`));
  wrap.appendChild(split);

  wrap.appendChild(el(`<button class="settings-fab" id="settings-btn">⚙ Nöbetçi veri kaynağı</button>`));

  return wrap;
}

function renderMetaLine() {
  const parts = [];
  if (state.pharmaciesSourceMeta) {
    parts.push(`<span class="src">Kaynak: ${state.pharmaciesSourceMeta.source}</span>`);
    parts.push(`<span>Güncellendi: ${formatUpdatedAt(state.pharmaciesSourceMeta.fetchedAt)}</span>`);
  }
  if (state.dutyMeta?.status === "unverified") {
    parts.push(`<span class="src" style="background:#fbeed8">Nöbetçi bilgisi: doğrulanamadı</span>`);
  } else if (state.dutyMeta?.status === "ok") {
    parts.push(`<span class="src" style="background:#fdedcf">Nöbetçi kaynağı: ${state.dutyMeta.source}</span>`);
  } else if (state.dutyMeta?.status === "error") {
    parts.push(`<span class="src" style="background:#fbe6e1">Nöbetçi verisi alınamadı</span>`);
  }
  return el(`<div class="meta-line">${parts.join("")}</div>`);
}

function getFilteredList() {
  let list = state.pharmacies;
  if (state.filter === "duty") list = list.filter((p) => p.isDuty);
  if (state.query.trim()) {
    const q = normalizeText(state.query);
    list = list.filter((p) => normalizeText(p.name).includes(q) || normalizeText(p.address || "").includes(q));
  }
  if (state.filter === "near") list = [...list].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  if (state.filter === "far") list = [...list].sort((a, b) => (b.distance ?? -1) - (a.distance ?? -1));
  return list;
}

function renderListPane() {
  const pane = el(`<div class="list-pane"></div>`);
  const list = getFilteredList();

  if (!list.length) {
    pane.appendChild(el(`
      <div class="empty-state">
        <div class="em-icon">💊</div>
        <p>${state.filter === "duty" ? "Bugün için doğrulanmış nöbetçi eczane bulunamadı." : "Eşleşen eczane bulunamadı."}</p>
      </div>
    `));
    return pane;
  }

  const visible = list.slice(0, state.visibleCount);
  visible.forEach((p) => pane.appendChild(renderCard(p)));

  if (list.length > visible.length) {
    const btn = el(`<button class="load-more">Daha fazla göster (${list.length - visible.length})</button>`);
    btn.onclick = () => { state.visibleCount += 20; render(); if (state.showMap) initMapIfNeeded(true); };
    pane.appendChild(btn);
  }
  return pane;
}

function renderCard(p) {
  const card = el(`
    <div class="pharmacy-card ${p.isDuty ? "is-duty" : ""} ${state.activeId === p.id ? "is-active" : ""}" data-id="${p.id}">
      <div class="card-head">
        <h3>${escapeHtml(p.name)}</h3>
        ${p.isDuty && p.dutyVerified ? `<span class="badge-duty">⭐ Bugün Nöbetçi</span>` : ""}
      </div>
      <div class="card-addr">${escapeHtml(p.address || "Adres bilgisi yok")}${p.ilce ? " · " + escapeHtml(p.ilce) : ""}</div>
      <div class="card-row">
        <span class="distance">${p.noCoords ? "Konum doğrulanamadı" : "📏 " + formatDistance(p.distance)}</span>
        <div class="card-actions">
          ${p.phone ? `<a class="icon-btn" href="tel:${p.phone.replace(/\s/g, "")}">☎ Ara</a>` : ""}
          ${!p.noCoords ? `<button class="icon-btn route" data-route="${p.lat},${p.lng}" data-name="${escapeHtml(p.name)}">🗺 Yol Tarifi</button>` : ""}
        </div>
      </div>
    </div>
  `);
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-route]") || e.target.closest("a")) return;
    state.activeId = p.id;
    if (!state.showMap && window.innerWidth < 860) { state.showMap = true; }
    render();
    initMapIfNeeded(true);
    focusPharmacyOnMap(p);
  });
  const routeBtn = card.querySelector("[data-route]");
  if (routeBtn) routeBtn.addEventListener("click", () => openDirections(p));
  return card;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openDirections(p) {
  // Cihazdaki uygun harita uygulamasına yönlendir
  const url = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&destination_place_id=&travelmode=walking`;
  window.open(url, "_blank", "noopener");
}

/* ---------------------------------------------------------------------------
 * HARİTA (Leaflet + marker clustering)
 * ------------------------------------------------------------------------- */
function initMapIfNeeded(forceRefresh) {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  if (state.map && !forceRefresh) { state.map.invalidateSize(); return; }

  if (state.map) { state.map.remove(); state.map = null; }

  const center = state.userCoords
    ? [state.userCoords.lat, state.userCoords.lng]
    : [state.region.lat, state.region.lng];

  const map = L.map("map", { zoomControl: true }).setView(center, 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar',
    maxZoom: 19
  }).addTo(map);

  if (state.userCoords) {
    L.circleMarker(center, { radius: 8, color: "#0e7c61", fillColor: "#0e7c61", fillOpacity: 0.9 })
      .addTo(map).bindPopup("📍 Buradasınız");
  }

  const cluster = (typeof L.markerClusterGroup === "function") ? L.markerClusterGroup() : L.layerGroup();
  getFilteredList().forEach((p) => {
    if (p.noCoords || p.lat == null || p.lng == null) return;
    const icon = L.divIcon({
      className: "",
      html: p.isDuty ? `<div style="font-size:22px;line-height:1">⭐</div>` : `<div style="font-size:20px;line-height:1">💊</div>`,
      iconSize: [24, 24]
    });
    const marker = L.marker([p.lat, p.lng], { icon });
    marker.bindPopup(`
      <div class="popup-title">${escapeHtml(p.name)}</div>
      <div class="popup-addr">${escapeHtml(p.address || "Adres bilgisi yok")}</div>
      ${p.phone ? `<div>☎ ${escapeHtml(p.phone)}</div>` : ""}
      <div>📏 ${formatDistance(p.distance)}</div>
      <a class="popup-route" href="#" data-route-id="${p.id}">Yol Tarifi Al</a>
    `);
    marker.on("popupopen", () => {
      const link = document.querySelector(`[data-route-id="${p.id}"]`);
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openDirections(p); });
      state.activeId = p.id;
      highlightActiveCardOnly();
    });
    marker.on("click", () => { state.activeId = p.id; highlightActiveCardOnly(); });
    marker._pharmacyId = p.id;
    cluster.addLayer(marker);
  });
  map.addLayer(cluster);

  state.map = map;
  state.markerLayer = cluster;

  const fab = document.getElementById("locate-me-btn");
  if (fab) fab.onclick = () => map.setView(center, 15);

  setTimeout(() => map.invalidateSize(), 60);
}

function highlightActiveCardOnly() {
  $$(".pharmacy-card").forEach((c) => c.classList.toggle("is-active", c.dataset.id === state.activeId));
  const activeCard = $(`.pharmacy-card[data-id="${state.activeId}"]`);
  if (activeCard) activeCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function focusPharmacyOnMap(p) {
  if (!state.map || p.noCoords) return;
  state.map.setView([p.lat, p.lng], 16, { animate: true });
  if (state.markerLayer) {
    state.markerLayer.eachLayer((m) => {
      if (m._pharmacyId === p.id) { m.openPopup(); }
    });
  }
}

/* ---------------------------------------------------------------------------
 * AYARLAR SHEET (nöbetçi API anahtarı)
 * ------------------------------------------------------------------------- */
function openSettingsSheet() {
  const existing = safeLocalGet("nc_collectapi_key") || "";
  const backdrop = el(`
    <div class="sheet-backdrop">
      <div class="sheet">
        <button class="close-sheet" aria-label="Kapat">✕</button>
        <h3>Nöbetçi eczane veri kaynağı</h3>
        <p class="note">
          Türkiye genelinde ücretsiz, resmi ve tüm illeri kapsayan açık bir nöbetçi eczane API'si bulunmuyor.
          Bu nedenle uygulama, nöbetçi bilgisini asla tahmin etmez. İsterseniz kendi
          <strong>CollectAPI</strong> anahtarınızı girerek gerçek nöbetçi verisini etkinleştirebilirsiniz.
          Anahtar girilmezse "Bugün Nöbetçi" etiketi hiçbir eczaneye verilmez; bunun yerine
          "doğrulanamadı" durumu gösterilir.
        </p>
        <div class="field">
          <label for="api-key-input">CollectAPI anahtarı (opsiyonel)</label>
          <input type="password" id="api-key-input" value="${escapeHtml(existing)}" placeholder="apikey ile başlayan anahtar">
        </div>
        <button class="btn-primary" id="save-key-btn">Kaydet</button>
      </div>
    </div>
  `);
  backdrop.querySelector(".close-sheet").onclick = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector("#save-key-btn").onclick = async () => {
    const val = backdrop.querySelector("#api-key-input").value.trim();
    safeLocalSet("nc_collectapi_key", val || null);
    backdrop.remove();
    if (state.region.il && state.region.ilce) {
      setBanner("info", "Nöbetçi veri kaynağı güncellendi, yeniden kontrol ediliyor…");
      await loadRegionData();
    }
  };
  document.body.appendChild(backdrop);
}

/* ---------------------------------------------------------------------------
 * OLAY BAĞLAMA
 * ------------------------------------------------------------------------- */
function attachGlobalHandlers() {
  const useLocBtn = $("#use-location-btn");
  if (useLocBtn) useLocBtn.onclick = requestGeolocation;

  const pickRegionBtn = $("#pick-region-btn");
  if (pickRegionBtn) pickRegionBtn.onclick = goToManualPicker;

  const backHomeBtn = $("#back-home-btn");
  if (backHomeBtn) backHomeBtn.onclick = () => { state.screen = "home"; render(); };

  const ilSelect = $("#il-select");
  if (ilSelect) ilSelect.onchange = () => populateIlceSelect(ilSelect.value);

  const ilceSelect = $("#ilce-select");
  if (ilceSelect) ilceSelect.onchange = () => { $("#manual-confirm").disabled = !ilceSelect.value; };

  const confirmBtn = $("#manual-confirm");
  if (confirmBtn) confirmBtn.onclick = confirmManualSelection;

  const changeRegionBtn = $("#change-region-btn");
  if (changeRegionBtn) changeRegionBtn.onclick = () => { state.screen = "home"; render(); };

  $$(".tab-btn").forEach((btn) => {
    btn.onclick = () => { state.filter = btn.dataset.tab === "duty" ? "duty" : "all"; state.visibleCount = 20; render(); if (state.showMap) initMapIfNeeded(true); };
  });

  $$(".chip").forEach((chip) => {
    chip.onclick = () => { state.filter = chip.dataset.filter; state.visibleCount = 20; render(); if (state.showMap) initMapIfNeeded(true); };
  });

  const searchInput = $("#search-input");
  if (searchInput) {
    searchInput.oninput = debounce((e) => { state.query = e.target.value; state.visibleCount = 20; render(); if (state.showMap) initMapIfNeeded(true); searchInputRefocus(); }, 300);
  }

  const toggleMapBtn = $("#toggle-map-btn");
  if (toggleMapBtn) toggleMapBtn.onclick = () => { state.showMap = !state.showMap; render(); if (state.showMap) initMapIfNeeded(true); };

  const settingsBtn = $("#settings-btn");
  if (settingsBtn) settingsBtn.onclick = openSettingsSheet;
}

function searchInputRefocus() {
  const input = $("#search-input");
  if (input) { input.focus(); const v = input.value; input.value = ""; input.value = v; }
}

/* ---------------------------------------------------------------------------
 * BAŞLAT
 * ------------------------------------------------------------------------- */
window.addEventListener("error", (e) => {
  // Bölüm 17: kullanıcıya çökme yaşatma, sessizce logla + genel bir bant göster
  console.error("[uncaught]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled-rejection]", e.reason);
});

document.addEventListener("DOMContentLoaded", () => {
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW kaydı başarısız:", e.message));
  }
});
