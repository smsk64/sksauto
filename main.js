const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, clipboard, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const BASE = process.env.PORTABLE_EXECUTABLE_DIR || __dirname;
app.setPath('userData', path.join(BASE, 'veri'));

// Performans / arka plan ayarları
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-ipc-flooding-protection');
if (fs.existsSync(path.join(BASE, 'veri', 'gpu-kapat.txt'))) {
  app.disableHardwareAcceleration();
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

const CFG = path.join(BASE, 'veri', 'ayar.json');
const SCRIPT = path.join(BASE, 'veri', 'script.user.js');
const SILME = path.join(BASE, 'veri', 'silme.user.js');
const DEBUG_FILE = path.join(BASE, 'veri', 'debug.log');
const TAB_PRELOAD = path.join(__dirname, 'preload-tab.js');
const TOOLBAR_H = 84;
let win, editWin, dbgWin, setWin, cfg;
const views = {};

// ---------------- Debug kayıt sistemi ----------------
const DBG = [];
const DBG_YAZ = [];
const bekleyen = {};
try {
  fs.mkdirSync(path.dirname(DEBUG_FILE), { recursive: true });
  if (fs.existsSync(DEBUG_FILE) && fs.statSync(DEBUG_FILE).size > 2 * 1024 * 1024) fs.unlinkSync(DEBUG_FILE);
} catch (e) {}

function kisalt(s, n) {
  s = String(s == null ? '' : s);
  n = n || 160;
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function adBul(id) {
  const t = cfg && cfg.tabs.find((x) => x.id === id);
  return t ? t.name : (id == null ? '-' : String(id));
}
function dlog(tabId, tur, msg) {
  const s = new Date().toLocaleTimeString('tr-TR') + ' | ' + adBul(tabId) + ' | ' + tur + ' | ' + msg;
  DBG.push(s);
  if (DBG.length > 4000) DBG.splice(0, DBG.length - 4000);
  DBG_YAZ.push(s);
}
setInterval(() => {
  if (DBG_YAZ.length) fs.appendFile(DEBUG_FILE, DBG_YAZ.splice(0).join('\n') + '\n', () => {});
}, 5000);
app.on('before-quit', () => {
  try { if (DBG_YAZ.length) fs.appendFileSync(DEBUG_FILE, DBG_YAZ.splice(0).join('\n') + '\n'); } catch (e) {}
});
app.on('child-process-gone', (e, d) => dlog(null, 'ÇÖKME', 'alt süreç: ' + JSON.stringify(d)));
app.on('certificate-error', (e, wc, url, error, cert, cb) => {
  dlog(null, 'SERTİFİKA', error + ' ' + kisalt(url));
  cb(false);
});

async function rapor() {
  const o = [];
  o.push('=== STOK OTO RAPOR === ' + new Date().toLocaleString('tr-TR'));
  o.push('Electron ' + process.versions.electron + ' | Chrome ' + process.versions.chrome + ' | ' + process.platform);
  try { o.push('GPU: ' + JSON.stringify(app.getGPUFeatureStatus())); } catch (e) {}
  o.push('gpu-kapat.txt: ' + (fs.existsSync(path.join(BASE, 'veri', 'gpu-kapat.txt')) ? 'var' : 'yok'));
  for (const t of cfg.tabs) {
    const v = views[t.id];
    const wc = v && v.webContents;
    let proxy = '-';
    if (wc && t.url) { try { proxy = await wc.session.resolveProxy(t.url); } catch (e) {} }
    o.push('[Sekme ' + t.name + '] yükleniyor=' + (wc ? wc.isLoading() : '-') + ' zoom=' + (t.zoom || 1) +
      ' proxy=' + proxy + ' url=' + kisalt(t.url, 200));
  }
  const simdi = Date.now();
  const bek = Object.values(bekleyen).filter((b) => simdi - b.t > 3000).sort((a, b) => a.t - b.t);
  o.push('--- 3 sn+ süredir cevap bekleyen istekler (' + bek.length + ') ---');
  bek.slice(0, 40).forEach((b) => {
    o.push(adBul(b.tab) + ' | ' + Math.round((simdi - b.t) / 1000) + ' sn | ' + b.m + ' ' + b.tip + ' ' + kisalt(b.url, 200));
  });
  o.push('--- Son kayıtlar ---');
  o.push(...DBG.slice(-350));
  return o.join('\n');
}

function agIzle(tab, wc) {
  const wr = wc.session.webRequest;
  const filter = { urls: ['*://*/*'] };
  const bitti = (d, hata) => {
    const b = bekleyen[d.id];
    delete bekleyen[d.id];
    const sure = b ? Date.now() - b.t : 0;
    const onemli = ['mainFrame', 'subFrame', 'xhr'].indexOf(d.resourceType) >= 0;
    if (hata || d.statusCode >= 400 || sure > 3000 || onemli) {
      dlog(tab.id, 'AĞ', d.method + ' ' + (d.statusCode || '') + ' ' + sure + 'ms ' + d.resourceType + ' ' +
        (d.fromCache ? 'cache ' : '') + kisalt(d.url) + (hata ? ' ' + hata : ''));
    }
  };
  wr.onSendHeaders(filter, (d) => {
    bekleyen[d.id] = { tab: tab.id, t: Date.now(), m: d.method, tip: d.resourceType, url: d.url };
  });
  wr.onCompleted(filter, (d) => bitti(d, ''));
  wr.onErrorOccurred(filter, (d) => bitti(d, 'HATA ' + d.error));
}
// ------------------------------------------------------

// Sayfaya script'ten önce enjekte edilen kod:
// 1) Teklif atılan hastane listesini uygulama kapanınca da koru
// 2) ASP.NET AJAX zaman aşımını 90 sn yerine 20 dk yap (sunucu yavaş cevap verirse sayfa pes etmesin)
const HASTANE_ONKOD = `(function(){
  var K='oto_durum_v42',H='oto_hastane_kalici';
  var g=Storage.prototype.getItem,s=Storage.prototype.setItem;
  Storage.prototype.getItem=function(k){
    if(this===sessionStorage&&k===K){
      var v=g.call(this,k); if(v) return v;
      var h=g.call(localStorage,H);
      return h?JSON.stringify({hastaneler:JSON.parse(h)}):null;
    }
    return g.call(this,k);
  };
  Storage.prototype.setItem=function(k,v){
    if(this===sessionStorage&&k===K){
      try{ s.call(localStorage,H,JSON.stringify(JSON.parse(v).hastaneler||[])); }catch(e){}
    }
    return s.call(this,k,v);
  };
})();
(function(){
  setInterval(function(){
    try{
      var p=window.Sys&&Sys.WebForms&&Sys.WebForms.PageRequestManager&&Sys.WebForms.PageRequestManager.getInstance();
      if(p&&p._asyncPostBackTimeout!==undefined&&p._asyncPostBackTimeout<1200000){
        if(!window.__otoTO){window.__otoTO=1;console.log('[Oto] AJAX timeout: '+p._asyncPostBackTimeout+' -> 1200000');}
        p._asyncPostBackTimeout=1200000;
      }
    }catch(e){}
  },500);
})();
`;

function sifrele(s) {
  if (!s) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return 'e:' + safeStorage.encryptString(s).toString('base64');
  } catch (e) {}
  return 'p:' + Buffer.from(s, 'utf8').toString('base64');
}
function coz(s) {
  if (!s) return '';
  try {
    if (s.startsWith('e:')) return safeStorage.decryptString(Buffer.from(s.slice(2), 'base64'));
    if (s.startsWith('p:')) return Buffer.from(s.slice(2), 'base64').toString('utf8');
  } catch (e) {}
  return '';
}

const VARSAYILAN_CFG = () => ({
  nextId: 5, active: 1,
  tabs: [1, 2, 3, 4].map((n) => ({ id: n, name: String(n), url: '', zoom: 1 })),
  giris: { user: '', pass: '', auto: false },
  ayar: { url: '', baslangic: false, yeniSekme: false }
});
function cfgOku(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function cfgYukle() {
  let c = null;
  if (fs.existsSync(CFG)) {
    try { c = cfgOku(CFG); } catch (e) {
      try { c = cfgOku(CFG + '.bak'); dlog(null, 'UYARI', 'ayar.json okunamadı, yedekten yüklendi'); } catch (e2) {}
    }
  }
  if (!c || !Array.isArray(c.tabs)) c = VARSAYILAN_CFG();
  // Eski sürümden geçiş: sekme bazlı kullanıcı/parola -> tek ortak giriş bilgisi
  if (!c.giris) {
    const t = c.tabs.find((x) => x.user && x.pass) || c.tabs.find((x) => x.user);
    c.giris = { user: t ? t.user : '', pass: t ? (t.pass || '') : '', auto: c.tabs.some((x) => x.auto) };
  }
  c.tabs.forEach((t) => { delete t.user; delete t.pass; delete t.auto; });
  c.giris = Object.assign({ user: '', pass: '', auto: false }, c.giris);
  c.ayar = Object.assign({ url: '', baslangic: false, yeniSekme: false }, c.ayar || {});
  if (!c.nextId) c.nextId = Math.max(0, ...c.tabs.map((t) => t.id)) + 1;
  return c;
}
let sonKayitHata = '';
function cfgKaydet() {
  const veri = JSON.stringify(cfg, null, 2);
  try {
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    const tmp = CFG + '.tmp';
    try {
      fs.writeFileSync(tmp, veri);
      fs.renameSync(tmp, CFG);
    } catch (e) {
      fs.writeFileSync(CFG, veri);
    }
    sonKayitHata = '';
    return true;
  } catch (e) {
    sonKayitHata = String(e && e.message);
    dlog(null, 'HATA', 'ayar kaydedilemedi: ' + sonKayitHata);
    return false;
  }
}
function push() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('durum', {
    active: cfg.active,
    tabs: cfg.tabs.map((t) => ({ id: t.id, name: t.name, url: t.url, zoom: t.zoom || 1 })),
    giris: { user: cfg.giris.user, hasPass: !!cfg.giris.pass, auto: !!cfg.giris.auto },
    ayar: cfg.ayar
  });
}

function dosyaYolu(h) { return h === 'silme' ? SILME : SCRIPT; }
function gomuluKod(h) {
  try { return fs.readFileSync(path.join(__dirname, h === 'silme' ? 'silme.user.js' : 'script.user.js'), 'utf8'); } catch (e) { return ''; }
}
function scriptOku(h) {
  try { if (fs.existsSync(dosyaYolu(h))) return fs.readFileSync(dosyaYolu(h), 'utf8'); } catch (e) {}
  return gomuluKod(h);
}
function silmeOku() { return scriptOku('silme'); }
function surumOku(kod) {
  const m = String(kod || '').match(/@version\s+([^\s]+)/);
  return m ? m[1] : '';
}
function tabBul(id) { return cfg.tabs.find((t) => t.id === id); }
function normURL(u) {
  u = (u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}

// Pasif sekmeler gizlenmez, pencere dışına kaydırılır (render durmasın)
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const id of Object.keys(views)) {
    const v = views[id];
    const on = Number(id) === cfg.active;
    v.setBounds({ x: on ? 0 : -30000, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
    v.setVisible(true);
  }
}

function zoomAyar(id, z) {
  const t = tabBul(id);
  if (!t) return;
  t.zoom = Math.min(2, Math.max(0.3, Math.round(z * 100) / 100));
  if (views[id]) views[id].webContents.setZoomFactor(t.zoom);
  cfgKaydet(); push();
}

// ---- Sayfa içinde çalışan fonksiyonlar (metne çevrilip enjekte edilir) ----
function girisFn(U, P, Z) {
  var n = 0;
  window.__otoGD = 'aranıyor...';
  var RP = /pass|parola|[şs]ifre|pwd/i;
  var RU = /user|kullan|login|sicil|kimlik|mail|tc/i;
  var RB = /g[iİıI]r[iİıI][şŞsS]|login|oturum/i;
  function gor(e) { return !!e && e.getClientRects().length > 0; }
  function docs() {
    var l = [document];
    (function tara(d) {
      [].slice.call(d.querySelectorAll('iframe')).forEach(function (f) {
        try { var x = f.contentDocument; if (x) { l.push(x); tara(x); } } catch (e) {}
      });
    })(document);
    return l;
  }
  function ozellik(e) { return (e.id || '') + ' ' + (e.name || '') + ' ' + (e.placeholder || '') + ' ' + (e.autocomplete || ''); }
  function yaz(el, v) {
    var w = el.ownerDocument.defaultView;
    var d = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value');
    el.focus(); d.set.call(el, v);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.KeyboardEvent('keyup', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    el.blur();
  }
  // DevExpress kontrolünü bul (id sonundaki _I atılır)
  function dxBul(el) {
    try {
      var w = el.ownerDocument.defaultView;
      var ad = (el.id || '').replace(/_I$/, '');
      var col = w.ASPxClientControl && w.ASPxClientControl.GetControlCollection && w.ASPxClientControl.GetControlCollection();
      if (!col) return null;
      var c = col.GetByName ? col.GetByName(ad) : (col.Get ? col.Get(ad) : null);
      return (c && c.SetText) ? c : null;
    } catch (e) { return null; }
  }
  function dxYaz(el, v) {
    var c = dxBul(el);
    if (c) { try { c.SetText(v); return 'api'; } catch (e) {} }
    yaz(el, v);
    return 'dom';
  }
  function tikla(el) {
    var w = el.ownerDocument.defaultView;
    ['mousedown', 'mouseup'].forEach(function (t) {
      el.dispatchEvent(new w.MouseEvent(t, { bubbles: true, cancelable: true, view: w }));
    });
    el.click();
  }
  function dene() {
    var D = docs();
    for (var i = 0; i < D.length; i++) {
      var d = D[i];
      var tum = [].slice.call(d.querySelectorAll('input')).filter(function (e) {
        return !e.disabled && !/_CLND$/.test(e.id || '');
      });
      // Gerçek parola alanı (DevExpress'te gizli olabilir)
      var pw = tum.filter(function (e) { return e.type === 'password'; })[0] ||
        tum.filter(function (e) { return gor(e) && (e.type === 'text' || e.type === '') && RP.test(ozellik(e)); })[0];
      if (!pw) continue;
      var w = d.defaultView;
      // DevExpress kontrolleri henüz hazır değilse biraz bekle
      if (!dxBul(pw) && typeof w.ASPxClientControl !== 'undefined' && n < 6) return false;
      var son = +sessionStorage.getItem('__otoG') || 0;
      if (!Z && Date.now() - son < 20000) { window.__otoGD = '20 sn içinde zaten denendi'; return true; }
      sessionStorage.setItem('__otoG', String(Date.now()));
      var onceki = tum.filter(function (e) {
        return e !== pw && gor(e) && !e.readOnly &&
          ['text', 'email', 'tel', 'number', ''].indexOf(e.type) >= 0 &&
          (e.compareDocumentPosition(pw) & 4);
      });
      var us = onceki.filter(function (e) { return RU.test(ozellik(e)); }).pop() || onceki.pop();
      var m1 = us ? dxYaz(us, U) : 'YOK';
      var m2 = dxYaz(pw, P);
      var mod = '(kullanıcı:' + m1 + ', parola:' + m2 + ')';
      window.__otoGD = 'dolduruldu ' + mod;
      (function (d, pw, mod) {
        setTimeout(function () {
          var adaylar = [].slice.call(d.querySelectorAll(
            'input[type=submit],input[type=button],button,a,[role=button],.dxbButton,td[id*=Button],div[id*=Button]'
          )).filter(function (e) {
            if (!gor(e)) return false;
            var tx = ((e.value || e.textContent || e.title || '') + '').replace(/\s+/g, ' ').trim();
            return (tx.length <= 40 && RB.test(tx)) || RB.test(e.id || '');
          });
          var sonra = adaylar.filter(function (e) { return pw.compareDocumentPosition(e) & 4; });
          var b = sonra.filter(function (e) { return e.tagName === 'INPUT'; })[0] || sonra[0] || adaylar[0];
          if (b) {
            tikla(b);
            window.__otoGD = 'dolduruldu ' + mod + ', butona basıldı: ' + (b.id || b.tagName);
          } else {
            var w2 = pw.ownerDocument.defaultView;
            pw.focus();
            ['keydown', 'keypress', 'keyup'].forEach(function (t) {
              pw.dispatchEvent(new w2.KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            });
            window.__otoGD = 'dolduruldu ' + mod + ', giriş butonu bulunamadı, Enter gönderildi';
          }
        }, 600);
      })(d, pw, mod);
      return true;
    }
    return false;
  }
  var t = setInterval(function () {
    if (++n > 20) { clearInterval(t); window.__otoGD = 'giriş formu bulunamadı (sayfada parola alanı yok)'; return; }
    if (dene()) clearInterval(t);
  }, 500);
}

function teshisFn() {
  var o = ['URL: ' + location.href, 'Başlık: ' + document.title];
  function k(x, n) { x = ((x || '') + '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) : x; }
  function tara(d, ad) {
    o.push('--- ' + ad + ' ---');
    [].slice.call(d.querySelectorAll('input,select,textarea')).forEach(function (e) {
      o.push('<' + e.tagName.toLowerCase() + ' type=' + e.type + ' id=' + e.id + ' name=' + e.name +
        ' class=' + k(e.className, 40) + ' placeholder=' + k(e.placeholder, 30) +
        ' autocomplete=' + (e.autocomplete || '') +
        ((e.type === 'submit' || e.type === 'button') ? ' value=' + k(e.value, 30) : '') +
        ' ' + (e.getClientRects().length ? 'görünür' : 'gizli') + (e.readOnly ? ' readonly' : '') + '>');
    });
    [].slice.call(d.querySelectorAll('button,a,[role=button],.dxbButton,td[id*=Button],div[id*=Button],span[id*=Button]')).forEach(function (e) {
      if (!e.getClientRects().length) return;
      o.push('[' + e.tagName.toLowerCase() + ' id=' + e.id + ' class=' + k(e.className, 40) + ' metin=' + k(e.textContent, 40) + ']');
    });
  }
  tara(document, 'ana sayfa');
  (function f(d, p) {
    [].slice.call(d.querySelectorAll('iframe')).forEach(function (fr, i) {
      try {
        var x = fr.contentDocument;
        if (x) { tara(x, p + 'iframe ' + (i + 1) + ' (' + k(fr.src, 60) + ')'); f(x, p + 'iframe ' + (i + 1) + ' > '); }
        else o.push('--- iframe ' + (i + 1) + ' erişilemiyor ---');
      } catch (e) { o.push('--- iframe ' + (i + 1) + ' erişilemiyor (farklı alan adı) ---'); }
    });
  })(document, '');
  return o.slice(0, 200).join('\n');
}

function loginDene(id, zorla) {
  const g = cfg.giris, v = views[id];
  if (!g || !v || !g.user || !g.pass) return null;
  if (!zorla && !g.auto) return null;
  const p = coz(g.pass);
  if (!p) return null;
  const kod = '(' + girisFn.toString() + ')(' + JSON.stringify(g.user) + ',' + JSON.stringify(p) + ',' + (zorla ? 'true' : 'false') + ')';
  return v.webContents.executeJavaScript(kod);
}

const POPUP_AYAR = {
  autoHideMenuBar: true, width: 1100, height: 800,
  webPreferences: { backgroundThrottling: false, spellcheck: false, contextIsolation: false, preload: TAB_PRELOAD }
};

function viewOlustur(tab) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:tab-' + tab.id,
      backgroundThrottling: false,
      spellcheck: false,
      contextIsolation: false,
      preload: TAB_PRELOAD
    }
  });
  const wc = view.webContents;
  const L = (tur, msg) => dlog(tab.id, tur, msg);

  wc.setBackgroundThrottling(false);
  wc.setUserAgent(wc.userAgent.replace(/\s(stok-oto-pencere|Electron)\/\S+/g, ''));
  agIzle(tab, wc);

  // Popup / yeni pencere: özellikli veya POST'lu açılışlar gerçek pencere olur, düz linkler aynı sekmede açılır
  wc.setWindowOpenHandler((d) => {
    L('POPUP', d.disposition + ' frame=' + d.frameName + ' features=' + (d.features || '-') +
      ' post=' + (d.postBody ? 'var' : 'yok') + ' ' + kisalt(d.url));
    if (d.postBody || d.disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: POPUP_AYAR };
    }
    wc.loadURL(d.url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (w) => {
    L('POPUP', 'pencere açıldı');
    try { w.setMenuBarVisibility(false); } catch (e) {}
    w.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  });

  // Sayfa beforeunload ile ayrılmayı engellemeye çalışırsa izin ver (Electron'da sessizce takılıyordu)
  wc.on('will-prevent-unload', (e) => {
    L('UYARI', 'sayfa beforeunload ile ayrılmayı engellemeye çalıştı, izin verildi');
    e.preventDefault();
  });

  wc.on('did-start-loading', () => L('YÜKLE', 'başladı'));
  wc.on('did-stop-loading', () => L('YÜKLE', 'bitti'));
  wc.on('did-fail-load', (e, code, desc, url, anaMi) => {
    if (code === -3) return;
    L('HATA', 'yükleme hatası ' + code + ' ' + desc + ' ana=' + anaMi + ' ' + kisalt(url));
  });
  wc.on('did-frame-navigate', (e, url, kod, metin, anaMi) => {
    L('GEZİN', (anaMi ? 'ana ' : 'iframe ') + kod + ' ' + kisalt(url));
  });
  wc.on('render-process-gone', (e, d) => L('ÇÖKME', JSON.stringify(d)));
  wc.on('unresponsive', () => L('DONMA', 'sayfa yanıt vermiyor'));
  wc.on('responsive', () => L('DONMA', 'sayfa tekrar yanıt veriyor'));
  wc.on('console-message', (a, b, c) => {
    let seviye, msg;
    if (a && a.message !== undefined && b === undefined) { seviye = a.level; msg = a.message; }
    else { seviye = b; msg = c; }
    if (typeof seviye === 'string') seviye = { error: 3, warning: 2, info: 1 }[seviye] || 0;
    msg = String(msg || '');
    if (msg.indexOf('[Oto]') === 0) L('SCRIPT', kisalt(msg, 300));
    else if (seviye >= 3) L('JS-HATA', kisalt(msg, 300));
  });

  wc.on('did-finish-load', () => {
    wc.setZoomFactor(tab.zoom || 1);
    const kod = scriptOku('stok');
    if (kod) {
      wc.executeJavaScript(
        'if(!window.__oto){window.__oto=1;\n' + HASTANE_ONKOD + kod + '\n}'
      ).catch((err) => L('HATA', 'script enjeksiyon hatası: ' + (err && err.message)));
    }
    ['stok', 'silme'].forEach((h) => {
      if (fs.existsSync(dosyaYolu(h)) && surumOku(scriptOku(h)) !== surumOku(gomuluKod(h))) {
        L('UYARI', h + ' scripti: kayıtlı sürüm (' + (surumOku(scriptOku(h)) || '?') + ') gömülü sürümden (' + (surumOku(gomuluKod(h)) || '?') + ') farklı, kayıtlı olan kullanılıyor');
      }
    });
    const kod2 = silmeOku();
    if (kod2) {
      wc.executeJavaScript(
        'if(!window.__otoSil){window.__otoSil=1;\n' + kod2 + '\n}'
      ).catch((err) => L('HATA', 'silme script enjeksiyon hatası: ' + (err && err.message)));
    }
    const l = loginDene(tab.id, false);
    if (l) l.catch(() => {});
  });

  const urlGuncelle = (e, url) => {
    wc.setZoomFactor(tab.zoom || 1);
    if (typeof url === 'string' && url.startsWith('http')) {
      tab.url = url; cfgKaydet(); push();
    }
  };
  wc.on('did-navigate', urlGuncelle);
  wc.on('did-navigate-in-page', urlGuncelle);

  wc.on('zoom-changed', (e, yon) => zoomAyar(tab.id, (tab.zoom || 1) + (yon === 'in' ? 0.1 : -0.1)));
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F5') { wc.reload(); e.preventDefault(); return; }
    if (i.key === 'F12') {
      if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' });
      e.preventDefault(); return;
    }
    if (!i.control) return;
    if (i.key === '+' || i.key === '=') { zoomAyar(tab.id, (tab.zoom || 1) + 0.1); e.preventDefault(); }
    else if (i.key === '-') { zoomAyar(tab.id, (tab.zoom || 1) - 0.1); e.preventDefault(); }
    else if (i.key === '0') { zoomAyar(tab.id, 1); e.preventDefault(); }
  });

  win.contentView.addChildView(view);
  views[tab.id] = view;
  if (tab.url) wc.loadURL(tab.url);
}

function editorAc() {
  if (editWin && !editWin.isDestroyed()) { editWin.focus(); return; }
  editWin = new BrowserWindow({
    width: 900, height: 700, parent: win, title: 'Script düzenle', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  editWin.removeMenu();
  editWin.loadFile(path.join(__dirname, 'editor.html'));
}
function ayarAc() {
  if (setWin && !setWin.isDestroyed()) { setWin.focus(); return; }
  setWin = new BrowserWindow({
    width: 520, height: 660, parent: win, modal: true, title: 'Ayarlar',
    autoHideMenuBar: true, resizable: false, minimizable: false, maximizable: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  setWin.removeMenu();
  setWin.loadFile(path.join(__dirname, 'ayarlar.html'));
}
function debugAc() {
  if (dbgWin && !dbgWin.isDestroyed()) { dbgWin.focus(); return; }
  dbgWin = new BrowserWindow({
    width: 1000, height: 700, parent: win, title: 'Debug', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  dbgWin.removeMenu();
  dbgWin.loadFile(path.join(__dirname, 'debug.html'));
}

function pencereAc() {
  cfg = cfgYukle();
  if (cfg.ayar.baslangic && cfg.ayar.url) cfg.tabs.forEach((t) => { t.url = cfg.ayar.url; });
  win = new BrowserWindow({
    width: 1280, height: 800, autoHideMenuBar: true, title: 'Stok Oto',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui.html'));
  cfg.tabs.forEach(viewOlustur);
  if (!tabBul(cfg.active)) cfg.active = cfg.tabs[0] ? cfg.tabs[0].id : 0;
  win.on('resize', layout);
  win.webContents.on('did-finish-load', () => { layout(); push(); });
  dlog(null, 'UYGULAMA', 'başladı, sekme sayısı ' + cfg.tabs.length);
}

ipcMain.on('sec', (e, id) => {
  cfg.active = id; cfgKaydet(); layout(); push();
  if (views[id]) views[id].webContents.focus();
});
ipcMain.on('ekle', () => {
  const id = cfg.nextId++;
  const tab = { id, name: String(cfg.tabs.length + 1), url: (cfg.ayar.yeniSekme && cfg.ayar.url) || '', zoom: 1 };
  cfg.tabs.push(tab);
  viewOlustur(tab);
  cfg.active = id; cfgKaydet(); layout(); push();
});
ipcMain.on('kapat', (e, id) => {
  const v = views[id];
  if (v) { win.contentView.removeChildView(v); v.webContents.close(); delete views[id]; }
  cfg.tabs = cfg.tabs.filter((t) => t.id !== id);
  if (cfg.active === id) cfg.active = cfg.tabs[0] ? cfg.tabs[0].id : 0;
  cfgKaydet(); layout(); push();
});
ipcMain.on('ad', (e, id, ad) => {
  const t = tabBul(id); if (t) { t.name = ad; cfgKaydet(); push(); }
});
ipcMain.on('git', (e, id, url) => {
  const t = tabBul(id), u = normURL(url);
  if (t && u && views[id]) { t.url = u; cfgKaydet(); dlog(id, 'GİT', kisalt(u)); views[id].webContents.loadURL(u); push(); }
});
// Hepsine uygula: zaten o adreste olan sekmeyi yenilemez (çalışan turu kesmesin)
ipcMain.on('hepsi', (e, url) => {
  const u = normURL(url);
  if (!u) return;
  cfg.tabs.forEach((t) => {
    if (t.url === u) return;
    t.url = u;
    dlog(t.id, 'GİT', 'hepsine uygula: ' + kisalt(u));
    if (views[t.id]) views[t.id].webContents.loadURL(u);
  });
  cfgKaydet(); push();
});
ipcMain.on('yenile', (e, id) => { if (views[id]) views[id].webContents.reload(); });

ipcMain.on('zoom', (e, id, delta) => { const t = tabBul(id); if (t) zoomAyar(id, (t.zoom || 1) + delta); });
ipcMain.on('zoom1', (e, id) => zoomAyar(id, 1));
ipcMain.on('zoomhepsi', (e, id) => {
  const t = tabBul(id);
  if (t) cfg.tabs.forEach((x) => zoomAyar(x.id, t.zoom || 1));
});

// Şimdi gir: sonucu geri bildirir
async function simdiYap(id) {
  const t = tabBul(id), v = views[id], g = cfg.giris;
  if (!t || !v) return 'sekme yok';
  if (!g.user || !g.pass) return 'Kullanıcı adı/parola kayıtlı değil (Ayarlar\'dan kaydet)';
  if (!coz(g.pass)) return 'Parola çözülemedi, Ayarlar\'dan yeniden kaydet';
  try { await loginDene(id, true); } catch (err) { return 'kod hatası: ' + err.message; }
  await new Promise((r) => setTimeout(r, 11000));
  try {
    const r = await v.webContents.executeJavaScript('window.__otoGD||""');
    if (!r || r === 'aranıyor...') return 'giriş formu bulunamadı (sayfa zaten girişli olabilir)';
    return r;
  } catch (err) { return 'okunamadı: ' + err.message; }
}
ipcMain.handle('simdi', async (e, id) => {
  const r = await simdiYap(id);
  dlog(id, 'GİRİŞ', r);
  return r;
});

// Teşhis: sayfadaki alan/buton listesini panoya kopyalar (parola/değer içermez)
ipcMain.handle('teshis', async (e, id) => {
  id = id || cfg.active;
  const v = views[id];
  if (!v) return 'sekme yok';
  try {
    const r = await v.webContents.executeJavaScript('(' + teshisFn.toString() + ')()');
    clipboard.writeText(r);
    dlog(id, 'TEŞHİS', 'giriş formu teşhisi alındı');
    return r.split('\n').length + ' satır panoya kopyalandı, sohbete yapıştır';
  } catch (err) { return 'hata: ' + err.message; }
});

// Ayarlar penceresi
ipcMain.on('ayarlar', ayarAc);
ipcMain.handle('ayar:oku', () => ({
  user: cfg.giris.user,
  hasPass: !!cfg.giris.pass,
  parolaBozuk: !!cfg.giris.pass && !coz(cfg.giris.pass),
  auto: !!cfg.giris.auto,
  url: cfg.ayar.url,
  baslangic: !!cfg.ayar.baslangic,
  yeniSekme: !!cfg.ayar.yeniSekme,
  veri: path.dirname(CFG)
}));
ipcMain.handle('ayar:kaydet', (e, o) => {
  o = o || {};
  cfg.giris.user = String(o.user || '').trim();
  if (o.parolaSil) cfg.giris.pass = '';
  else if (o.pass) cfg.giris.pass = sifrele(String(o.pass));
  cfg.giris.auto = !!o.auto;
  cfg.ayar.url = normURL(o.url);
  cfg.ayar.baslangic = !!o.baslangic;
  cfg.ayar.yeniSekme = !!o.yeniSekme;
  try { if (fs.existsSync(CFG)) fs.copyFileSync(CFG, CFG + '.bak'); } catch (err) {}
  const ok = cfgKaydet();
  let dogru = false;
  try {
    const c = cfgOku(CFG);
    dogru = c.giris.user === cfg.giris.user && c.giris.pass === cfg.giris.pass && c.ayar.url === cfg.ayar.url;
  } catch (err) {}
  push();
  dlog(null, 'AYAR', 'ayarlar kaydedildi (kullanıcı ' + (cfg.giris.user ? 'var' : 'yok') + ', parola ' + (cfg.giris.pass ? 'var' : 'yok') + ', adres ' + (cfg.ayar.url ? 'var' : 'yok') + ')');
  return { ok: ok && dogru, hata: sonKayitHata || (dogru ? '' : 'dosya doğrulanamadı'), hasPass: !!cfg.giris.pass, url: cfg.ayar.url };
});

// Debug penceresi
ipcMain.on('debug', debugAc);
ipcMain.handle('dbg:rapor', () => rapor());
ipcMain.handle('dbg:not', (e, s) => { dlog(cfg.active, 'NOT', kisalt(s, 500)); return true; });
ipcMain.handle('dbg:kopya', async () => {
  const r = await rapor();
  clipboard.writeText(r);
  return r.length;
});

// Script editörü
ipcMain.on('editor', editorAc);
ipcMain.handle('script:oku', (e, h) => {
  const ozel = fs.existsSync(dosyaYolu(h));
  return {
    kod: scriptOku(h),
    ozel,
    gomuluSurum: surumOku(gomuluKod(h)),
    ozelSurum: ozel ? surumOku(scriptOku(h)) : ''
  };
});
ipcMain.handle('script:kaydet', (e, kod, yenile, h) => {
  try {
    fs.mkdirSync(path.dirname(dosyaYolu(h)), { recursive: true });
    fs.writeFileSync(dosyaYolu(h), kod, 'utf8');
    if (yenile) Object.values(views).forEach((v) => v.webContents.reload());
    return { ok: true };
  } catch (err) {
    return { ok: false, hata: String(err && err.message) };
  }
});
ipcMain.handle('script:varsayilan', (e, h) => {
  try { fs.unlinkSync(dosyaYolu(h)); } catch (err) {}
  return { kod: scriptOku(h) };
});
ipcMain.handle('pano', () => clipboard.readText());

app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension');
  pencereAc();
});
app.on('window-all-closed', () => app.quit());
