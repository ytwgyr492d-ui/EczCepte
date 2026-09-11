"use strict";
const fs = require("fs");
const vm = require("vm");

// ---- DOM/tarayıcı ortamını minimal biçimde taklit et ----
function makeFakeEl() {
  const listeners = {};
  return {
    innerHTML: "", value: "", disabled: false, dataset: {}, style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    appendChild(){}, querySelector(){ return makeFakeEl(); }, querySelectorAll(){ return []; },
    addEventListener(t, fn){ listeners[t]=fn; }, removeEventListener(){},
    setAttribute(){}, getAttribute(){ return null; }, remove(){}, focus(){},
    closest(){ return null; }
  };
}
const fakeDocument = {
  createElement: () => makeFakeEl(),
  querySelector: () => makeFakeEl(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: makeFakeEl(),
  getElementById: () => null,
};
const sandbox = {
  console,
  window: { isSecureContext: true, addEventListener(){}, innerWidth: 1024 },
  navigator: { geolocation: {} },
  document: fakeDocument,
  localStorage: (() => {
    let store = {};
    return { getItem: k => (k in store ? store[k] : null), setItem: (k,v) => { store[k]=String(v); }, removeItem: k => { delete store[k]; } };
  })(),
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  AbortController: class { constructor(){ this.signal = {}; } abort(){} },
  L: { map(){ return { setView(){return this;}, invalidateSize(){}, remove(){}, addLayer(){} }; }, tileLayer(){ return { addTo(){} }; }, circleMarker(){ return { addTo(){ return { bindPopup(){} }; } }; }, marker(){ return { bindPopup(){return this;}, on(){}, }; }, divIcon(){}, markerClusterGroup(){ return { addLayer(){}, eachLayer(){} }; }, layerGroup(){ return { addLayer(){}, eachLayer(){} }; } },
  Intl, Date, JSON, Math, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, queueMicrotask,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const dataSrc = fs.readFileSync(require("path").join(__dirname,"..","data.js"), "utf8");
vm.runInContext(dataSrc, sandbox, { filename: "data.js" });
sandbox.TURKEY_IL_ILCE = sandbox.module ? sandbox.module.exports.TURKEY_IL_ILCE : sandbox.TURKEY_IL_ILCE;

const appSrc = fs.readFileSync(require("path").join(__dirname,"..","app.js"), "utf8");
// DOMContentLoaded tetiklenmesin diye document.addEventListener no-op zaten yukarıda.
vm.runInContext(appSrc, sandbox, { filename: "app.js" });

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("OK  -", name); }
  else { fail++; console.log("FAIL-", name); }
}

// 1) Haversine mesafe testi (İstanbul Taksim -> Kadıköy ~ bilinen aralık)
const d1 = sandbox.haversineMeters(41.0370, 28.9850, 40.9908, 29.0303);
assert("haversineMeters makul aralıkta (5-8km)", d1 > 5000 && d1 < 8000);

// 2) formatDistance
assert("formatDistance metre formatı", sandbox.formatDistance(350) === "350 m");
assert("formatDistance km formatı", sandbox.formatDistance(2140) === "2,1 km");
assert("formatDistance null güvenli", sandbox.formatDistance(null) === "—");

// 3) normalizeText Türkçe karakter/harf duyarlılığı
assert("normalizeText ı/İ normalizasyonu", sandbox.normalizeText("Işık Eczanesi") === sandbox.normalizeText("isik eczanesi"));

// 4) dedupePharmacies — aynı isim + yakın konum birleşmeli, uzak konum birleşmemeli
const list = [
  { id: "a", name: "Yıldız Eczanesi", lat: 41.000, lng: 29.000 },
  { id: "b", name: "Yıldız Eczanesi", lat: 41.0001, lng: 29.0001 }, // ~15m yakın -> aynı kabul edilmeli
  { id: "c", name: "Yıldız Eczanesi", lat: 41.050, lng: 29.050 },  // çok uzak -> farklı eczane
];
const deduped = sandbox.dedupePharmacies(list);
assert("dedupePharmacies yakın duplikeyi birleştirir, uzağı korur", deduped.length === 2);

// 5) elementToPharmacy — koordinatsız eleman filtrelenmeli (haritada yanlış yere koyma kuralı)
const withCoords = sandbox.elementToPharmacy({ type: "node", id: 1, lat: 41.0, lon: 29.0, tags: { name: "Test Eczanesi" } }, 41.0, 29.0);
const withoutCoords = sandbox.elementToPharmacy({ type: "node", id: 2, tags: { name: "Koordinatsız Eczane" } }, 41.0, 29.0);
assert("elementToPharmacy koordinatlıyı işler", withCoords && withCoords.name === "Test Eczanesi");
assert("elementToPharmacy koordinatsızı ELER (null döner)", withoutCoords === null);

// 6) mergeDutyIntoPharmacies — isim eşleşmesiyle isDuty=true, dutyVerified=true olmalı
const pharmacies = [{ id: "p1", name: "Merkez Eczanesi", address: "Atatürk Cad. No:5", isDuty: false, dutyVerified: false }];
const dutyList = [{ id: "d1", name: "Merkez Eczanesi", address: "Atatürk Caddesi No 5", phone: "0212 000 00 00" }];
const merged = sandbox.mergeDutyIntoPharmacies(pharmacies, dutyList);
assert("mergeDutyIntoPharmacies eşleşen eczaneyi nöbetçi işaretler", merged[0].isDuty === true && merged[0].dutyVerified === true);

// 7) fetchDutyPharmacies — API anahtarı YOKSA asla 'ok' dönmemeli (sahte nöbetçi verisi üretmeme kuralı)
sandbox.fetchDutyPharmacies("İstanbul", "Kadıköy").then((res) => {
  assert("API key yokken duty status 'unverified'", res.meta.status === "unverified");
  assert("API key yokken duty listesi boş", res.list.length === 0);

  console.log(`\nSonuç: ${pass} başarılı, ${fail} başarısız`);
  process.exit(fail > 0 ? 1 : 0);
});
