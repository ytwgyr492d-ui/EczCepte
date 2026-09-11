"use strict";
const fs = require("fs");
const vm = require("vm");

function makeFakeEl() {
  return {
    innerHTML: "", value: "", disabled: false, dataset: {}, style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    appendChild(){}, querySelector(){ return makeFakeEl(); }, querySelectorAll(){ return []; },
    addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){return null;},
    remove(){}, focus(){}, closest(){ return null; }
  };
}
const fakeDocument = {
  createElement: (tag) => {
    if (tag === "template") {
      const t = { _html: "", get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = v; }, content: { firstElementChild: makeFakeEl() } };
      return t;
    }
    return makeFakeEl();
  },
  querySelector: () => makeFakeEl(), querySelectorAll: () => [],
  addEventListener: () => {}, body: makeFakeEl(), getElementById: () => makeFakeEl(),
};

let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });

const sandbox = {
  console,
  window: { isSecureContext: true, addEventListener(){}, innerWidth: 1024 },
  navigator: { geolocation: {} },
  document: fakeDocument,
  localStorage: (() => { let s={}; return { getItem:k=>(k in s?s[k]:null), setItem:(k,v)=>{s[k]=String(v);}, removeItem:k=>{delete s[k];} }; })(),
  fetch: (...args) => fetchImpl(...args),
  AbortController: class { constructor(){this.signal={};} abort(){} },
  L: { map(){ return { setView(){return this;}, invalidateSize(){}, remove(){}, addLayer(){} }; }, tileLayer(){return {addTo(){}};}, circleMarker(){return {addTo(){return {bindPopup(){}};}};}, marker(){return {bindPopup(){return this;}, on(){}};}, divIcon(){}, markerClusterGroup(){return {addLayer(){}, eachLayer(){}};}, layerGroup(){return {addLayer(){}, eachLayer(){}};} },
  Intl, Date, JSON, Math, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, queueMicrotask,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require("path").join(__dirname,"..","data.js"),"utf8"), sandbox, {filename:"data.js"});
vm.runInContext(fs.readFileSync(require("path").join(__dirname,"..","app.js"),"utf8") + "\nglobalThis.__state = state;\n", sandbox, {filename:"app.js"});
Object.defineProperty(sandbox, "state", { get: () => sandbox.__state, set: (v) => { Object.assign(sandbox.__state, v); } });

let pass=0, fail=0;
function assert(name, cond){ if(cond){pass++;console.log("OK  -",name);} else {fail++;console.log("FAIL-",name);} }

(async () => {
  // Senaryo: konum izni reddedildi -> manual ekrana düşmeli + doğru banner mesajı
  sandbox.state.screen = "home";
  sandbox.onLocationError({ code: 1 });
  assert("İzin reddedildi -> manuel ekrana geçti", sandbox.state.screen === "manual");
  assert("İzin reddedildi -> uyarı banner metni doğru", sandbox.state.banner.text.includes("izni verilmedi"));

  // Senaryo: timeout
  sandbox.state.screen = "home"; sandbox.state.banner = null;
  sandbox.onLocationError({ code: 3 });
  assert("Timeout -> manuel ekrana geçti", sandbox.state.screen === "manual");
  assert("Timeout -> doğru mesaj", sandbox.state.banner.text.includes("zaman aşımına"));

  // Senaryo: GPS kapalı / sinyal yok (POSITION_UNAVAILABLE)
  sandbox.state.screen = "home"; sandbox.state.banner = null;
  sandbox.onLocationError({ code: 2 });
  assert("GPS kapalı -> manuel ekrana geçti", sandbox.state.screen === "manual");
  assert("GPS kapalı -> doğru mesaj", sandbox.state.banner.text.includes("GPS kapalı"));

  // Senaryo: tarayıcı desteklemiyor
  const savedGeo = sandbox.navigator.geolocation;
  delete sandbox.navigator.geolocation;
  sandbox.state.screen = "home"; sandbox.state.banner = null;
  sandbox.requestGeolocation();
  assert("Geolocation desteklenmiyor -> manuel ekrana geçti", sandbox.state.screen === "manual");
  assert("Geolocation desteklenmiyor -> doğru mesaj", sandbox.state.banner.text.includes("desteklemiyor"));
  sandbox.navigator.geolocation = savedGeo;

  // Senaryo: HTTPS problemi (insecure context)
  sandbox.window.isSecureContext = false;
  sandbox.state.screen = "home"; sandbox.state.banner = null;
  sandbox.requestGeolocation();
  assert("Güvensiz bağlam -> manuel ekrana geçti", sandbox.state.screen === "manual");
  assert("Güvensiz bağlam -> doğru mesaj", sandbox.state.banner.text.includes("HTTPS"));
  sandbox.window.isSecureContext = true;

  // Senaryo: Overpass tüm endpointler hatalı, önbellek de yok -> throw edilmeli (üst katman yakalar)
  fetchImpl = async () => { throw new Error("network down"); };
  let threw = false;
  try { await sandbox.fetchPharmaciesNear(41.0, 29.0); } catch(e) { threw = true; }
  assert("Tüm Overpass uçları çökünce ve önbellek yokken hata fırlatılır", threw);

  // Senaryo: loadRegionData bu durumda uygulamayı ÇÖKERTMEMELİ, error banner göstermeli
  sandbox.state.region = { source:"manual", il:"İstanbul", ilce:"Kadıköy", lat:40.99, lng:29.03, label:"Kadıköy, İstanbul" };
  await sandbox.loadRegionData();
  assert("Veri gelmeyince ekran 'results' olarak set edilir (çökmez)", sandbox.state.screen === "results");
  assert("Veri gelmeyince kullanıcı dostu hata banner'ı gösterilir", sandbox.state.banner && sandbox.state.banner.type === "error" && sandbox.state.banner.text.includes("birkaç saniye sonra"));
  assert("Veri gelmeyince eczane listesi boş ama tanımlı (undefined değil)", Array.isArray(sandbox.state.pharmacies) && sandbox.state.pharmacies.length === 0);

  // Senaryo: Overpass 429 (rate limit) ilk uçta, ikinci uçta başarı -> tek kaynağa bağımlı kalmama testi
  let call = 0;
  fetchImpl = async (url) => {
    call++;
    if (call === 1) return { ok:false, status:429, json: async()=>({}) };
    return { ok:true, status:200, json: async()=>({ elements: [
      { type:"node", id:1, lat:40.99, lon:29.03, tags:{ name:"A Eczanesi" } },
      { type:"node", id:2, lat:40.991, lon:29.031, tags:{ name:"B Eczanesi" } },
    ]}) };
  };
  const r = await sandbox.fetchPharmaciesNear(40.99, 29.03);
  assert("İlk Overpass ucu 429 verince ikinci uca geçilir", r.pharmacies.length === 2);
  assert("Başarılı kaynak meta bilgisi doğru işaretlenir", r.meta.source.includes("Overpass"));

  // Senaryo: tek eczane geliyor
  fetchImpl = async () => ({ ok:true, status:200, json: async()=>({ elements: [{type:"node",id:9,lat:40.99,lon:29.03,tags:{name:"Tek Eczane"}}] }) });
  const one = await sandbox.fetchPharmaciesNear(39.5, 33.5); // farklı bölge -> önbellek çakışmasın
  assert("Tek eczane senaryosu doğru işlenir", one.pharmacies.length === 1);

  // Senaryo: çok sayıda eczane (performans/işlev - 300 kayıt)
  const many = { elements: Array.from({length:300}, (_,i)=>({type:"node", id:i, lat:40.99+i*0.0001, lon:29.03, tags:{name:"Eczane "+i}})) };
  fetchImpl = async () => ({ ok:true, status:200, json: async()=>many });
  const bigList = await sandbox.fetchPharmaciesNear(41.5, 30.5);
  assert("300 eczane hatasız işlenir", bigList.pharmacies.length === 300);

  // Senaryo: nöbetçi verisi doğrulanamıyorsa asla 'BUGÜN NÖBETÇİ' etiketi verilmemeli
  const dutyRes = await sandbox.fetchDutyPharmacies("Ankara", "Çankaya");
  assert("Nöbetçi API anahtarı yokken hiçbir eczane isDuty=true olamaz (uydurma yok)", dutyRes.list.length === 0 && dutyRes.meta.status === "unverified");

  console.log(`\nSonuç: ${pass} başarılı, ${fail} başarısız`);
  process.exit(fail>0?1:0);
})();
