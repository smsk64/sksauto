'use strict';
// Takip ekranı: kalem listesi, otomatik arama + bot başlatma, hata sonrası kaldığı sayfadan devam,
// masaüstüne hata logu, Excel çıktısı, tek dosya yedek/geri yükleme.
const TARAMA_URL = 'https://stokkoordinasyon.saglik.gov.tr/islemler/TalepciSorgulama.aspx';
const SONUC_MAX = 6 * 60 * 1000;       // arama sonucu için azami bekleme
const YENIDEN_BEKLEME = 20000;         // hata sonrası sekme yeniden açılmadan önce bekleme
const AKTIF_ASAMALAR = ['form', 'sonuc', 'bot'];

module.exports = function (ctx) {
  const { app, dialog, BrowserWindow, ipcMain, shell, fs, path } = ctx;
  const DOSYA = path.join(ctx.BASE, 'veri', 'takip.json');
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  const str = (v) => String(v == null ? '' : v).trim();
  let pencere = null;
  let kayitT = null;

  // ---------------- Veri ----------------
  function varsayilan() {
    return {
      surum: 1, sonId: 0, kalemler: [],
      botAyar: { yuzde: 50, min: 10, max: 50, adim: 5, gun: 180, hastaneTek: true, maxTeklif: 9999, maxSayfa: 9999, adimMs: 250, gecisSn: 600, deneme: 5 },
      otoYeniden: true, maxYeniden: 8
    };
  }
  function duzenle(t) {
    const v = varsayilan();
    t = Object.assign(v, t || {});
    t.botAyar = Object.assign(varsayilan().botAyar, t.botAyar || {});
    t.kalemler = (Array.isArray(t.kalemler) ? t.kalemler : []).map((k) => {
      const o = Object.assign(yeniKalemTaslak(), k, { gorev: null });
      o.jenerik = str(o.jenerik) || str(o.tasinir);   // jenerik ve taşınır adı tek alan
      o.tasinir = o.jenerik;
      return o;
    });
    t.sonId = Math.max(t.sonId || 0, ...t.kalemler.map((k) => k.id || 0));
    return t;
  }
  function yeniKalemTaslak() {
    return {
      id: 0, ad: '', jenerik: '', tasinir: '', miktar: '', notlar: '',
      tarandi: false, talepYapildi: false, durum: '', sayfa: 0, toplamSayfa: 0, teklif: 0, atlanan: 0,
      sonTeklifSayfa: 0, hastaneler: [], sonHata: '', guncel: '', yeniden: 0, ayar: {}, hataGecmisi: [], sekmeId: null, gorev: null
    };
  }
  function yukle() {
    try { return duzenle(JSON.parse(fs.readFileSync(DOSYA, 'utf8'))); } catch (e) {}
    try { return duzenle(JSON.parse(fs.readFileSync(DOSYA + '.bak', 'utf8'))); } catch (e) {}
    return duzenle(null);
  }
  let T = yukle();

  function diske(veri) {
    const metin = JSON.stringify(veri, (k, v) => (k === 'gorev' ? undefined : v), 2);
    fs.mkdirSync(path.dirname(DOSYA), { recursive: true });
    try { if (fs.existsSync(DOSYA)) fs.copyFileSync(DOSYA, DOSYA + '.bak'); } catch (e) {}
    const tmp = DOSYA + '.tmp';
    try { fs.writeFileSync(tmp, metin); fs.renameSync(tmp, DOSYA); } catch (e) { fs.writeFileSync(DOSYA, metin); }
  }
  function kaydetHemen() {
    clearTimeout(kayitT);
    try { diske(T); } catch (e) { ctx.dlog(null, 'HATA', 'takip.json yazılamadı: ' + e.message); }
  }
  function kaydet() { clearTimeout(kayitT); kayitT = setTimeout(kaydetHemen, 800); }
  app.on('before-quit', kaydetHemen);

  const kalem = (id) => T.kalemler.find((k) => k.id === id);
  const kalemSekme = (tabId) => T.kalemler.find((k) => k.sekmeId === tabId && k.sekmeId != null);
  const simdiYazi = () => new Date().toLocaleString('tr-TR');
  const aktifMi = (k) => !!(k.gorev && AKTIF_ASAMALAR.includes(k.gorev.asama));

  function botAyarKalem(k) {
    const o = Object.assign({}, T.botAyar);
    Object.keys(k.ayar || {}).forEach((a) => {
      const v = k.ayar[a];
      if (typeof v === 'number' ? v > 0 : v === true || v === false) o[a] = v;
    });
    return o;
  }

  // ---------------- Sayfa içinde çalışan kodlar ----------------
  const R = 'ctl00_ContentPlaceHolder1_ASPxRoundPanelMain_';
  function formKodu(jenerik, baslangic) {
    return `(async function(){
      var R=${JSON.stringify(R)}, JEN=${JSON.stringify(jenerik)}, BAS=${JSON.stringify(String(baslangic))};
      var bekle=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
      var norm=function(s){return String(s||'').replace(/\\s+/g,' ').trim().toLocaleUpperCase('tr-TR');};
      var sonuc={ok:false,adim:'',il:'',jenerik:''};
      function ctl(n){try{var c=window.ASPxClientControl.GetControlCollection();return c.GetByName?c.GetByName(R+n):c.Get(R+n);}catch(e){return null;}}
      var ilIn=document.getElementById(R+'ASPxComboBoxIlList_I');
      var jIn=document.getElementById(R+'ASPxTextBoxJenerikAdi_I');
      var ara=document.getElementById(R+'ASPxButtonAraSorgulama_I');
      if(!ilIn||!jIn||!ara){sonuc.adim='form elemanları bulunamadı';return sonuc;}
      var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      if(norm(ilIn.value)!=='TÜRKİYE'){
        var cb=ctl('ASPxComboBoxIlList'),tamam=false;
        if(cb){try{
          var n=cb.GetItemCount(),it=null;
          for(var i=0;i<n;i++){var x=cb.GetItem(i);var t=norm(x.text);if(t==='TÜRKİYE'||t==='TURKIYE'){it=x;break;}}
          if(it){cb.SetSelectedItem(it);tamam=true;}
        }catch(e){}}
        if(!tamam){ilIn.focus();setter.call(ilIn,'TÜRKİYE');ilIn.dispatchEvent(new Event('input',{bubbles:true}));ilIn.dispatchEvent(new Event('change',{bubbles:true}));}
        await bekle(1200);
      }
      sonuc.il=ilIn.value;
      var jt=ctl('ASPxTextBoxJenerikAdi');
      try{if(jt&&jt.SetText)jt.SetText(JEN);}catch(e){}
      setter.call(jIn,JEN);
      jIn.dispatchEvent(new Event('input',{bubbles:true}));
      jIn.dispatchEvent(new Event('change',{bubbles:true}));
      jIn.blur();
      await bekle(500);
      sonuc.jenerik=jIn.value;
      if(norm(sonuc.il)!=='TÜRKİYE'){sonuc.adim='il TÜRKİYE seçilemedi ('+sonuc.il+')';return sonuc;}
      if(jIn.value!==JEN){sonuc.adim='jenerik adı yazılamadı';return sonuc;}
      try{sessionStorage.setItem('oto_form_tikladi',BAS);}catch(e){}
      ara.click();
      sonuc.ok=true;sonuc.adim='Ara tıklandı';
      return sonuc;
    })()`;
  }
  const SONUC_SORGU = `(function(){
    var rows=document.querySelectorAll('tr[id*="ASPxGridViewStokFazlasi_DXDataRow"]').length;
    var busy=false;
    try{var p=window.Sys&&Sys.WebForms&&Sys.WebForms.PageRequestManager.getInstance();if(p&&p.get_isInAsyncPostBack())busy=true;}catch(e){}
    try{
      var e0=document.querySelector('[id*="ASPxGridViewStokFazlasi"]');
      if(e0){var ad=e0.id.split('ASPxGridViewStokFazlasi')[0]+'ASPxGridViewStokFazlasi';
        var c=window.ASPxClientControl.GetControlCollection();var g=c.GetByName?c.GetByName(ad):c.Get(ad);
        if(g&&g.InCallback&&g.InCallback())busy=true;}
    }catch(e){}
    return {satir:rows,hazir:document.readyState==='complete',busy:busy,
      form:!!document.getElementById(${JSON.stringify(R + 'ASPxButtonAraSorgulama_I')}),
      marker:(function(){try{return sessionStorage.getItem('oto_form_tikladi');}catch(e){return null;}})()};
  })()`;

  // ---------------- Görev akışı ----------------
  function yeniGorev(hedef) {
    return { asama: 'form', hedef: Math.max(1, hedef || 1), yonlendirme: 0, formDeneme: 0, baslangic: Date.now() };
  }
  const aranan = (k) => str(k.jenerik) || str(k.tasinir);
  const sekmeAdi = (k) => str(k.ad) || aranan(k) || 'Kalem ' + k.id;
  function durum(k, m) { k.durum = m; k.guncel = simdiYazi(); kaydet(); }

  async function ara(id, devam) {
    const k = kalem(id);
    if (!k) return { ok: false, hata: 'Kalem bulunamadı' };
    if (!aranan(k)) return { ok: false, hata: 'Önce jenerik / taşınır adını yaz' };
    const cfg = ctx.getCfg();
    const hedef = devam ? Math.max(1, k.sayfa || 1) : 1;
    if (!devam) {
      Object.assign(k, { tarandi: false, talepYapildi: false, sayfa: 0, toplamSayfa: 0, teklif: 0, atlanan: 0, sonTeklifSayfa: 0, hastaneler: [], sonHata: '', yeniden: 0, hataGecmisi: [] });
    }
    let tab = k.sekmeId != null ? ctx.tabBul(k.sekmeId) : null;
    const gorev = yeniGorev(hedef);
    if (!tab) {
      tab = { id: cfg.nextId++, name: sekmeAdi(k), url: TARAMA_URL, zoom: 1 };
      cfg.tabs.push(tab);
      k.sekmeId = tab.id;
      k.gorev = gorev;
      ctx.viewOlustur(tab);
    } else {
      k.sekmeId = tab.id;
      k.gorev = gorev;
      tab.name = sekmeAdi(k) || tab.name;
      tab.url = TARAMA_URL;
      const v = ctx.views[tab.id];
      if (v) {
        try {
          await v.webContents.executeJavaScript(
            "try{sessionStorage.removeItem('oto_form_tikladi');sessionStorage.removeItem('oto_gorev');sessionStorage.removeItem('oto_durum_v42');" +
            (devam ? '' : "localStorage.removeItem('oto_hastane_kalici');") + '}catch(e){}'
          );
        } catch (e) {}
        v.webContents.loadURL(TARAMA_URL);
      } else {
        ctx.viewOlustur(tab);
      }
    }
    durum(k, devam && hedef > 1 ? `Sekme açıldı, ${hedef}. sayfadan devam edilecek...` : 'Sekme açıldı, giriş ve arama bekleniyor...');
    cfg.active = tab.id;
    ctx.cfgKaydet(); ctx.layout(); ctx.push();
    const w = ctx.getWin();
    if (w && !w.isDestroyed()) { w.show(); w.focus(); }
    ctx.dlog(tab.id, 'TAKİP', `"${k.ad}" araması başlatıldı (jenerik: ${aranan(k)}, hedef sayfa ${hedef})`);
    return { ok: true };
  }

  function hataDurumu(k, mesaj) {
    if (k.gorev) k.gorev.asama = 'hata';
    k.sonHata = mesaj;
    durum(k, 'Hata: ' + mesaj);
  }

  async function sayfaYuklendi(tab, wc) {
    const k = kalemSekme(tab.id);
    if (!k || !k.gorev) return;
    const g = k.gorev;
    if (!AKTIF_ASAMALAR.includes(g.asama)) return;
    let url = '';
    try { url = wc.getURL(); } catch (e) {}
    const talepci = /TalepciSorgulama\.aspx/i.test(url);

    if (!talepci) {
      if (g.asama === 'bot') {
        // Bot çalışırken ana ekrana / başka sayfaya atıldık
        const o = { neden: 'Arama sayfasından çıkıldı (ana ekrana atılmış olabilir): ' + url, sayfa: k.sayfa, toplam: k.toplamSayfa, sonTeklifSayfa: k.sonTeklifSayfa, teklif: k.teklif, atlanan: k.atlanan, log: [] };
        masaustuLog(tab, k, o);
        hataDonusu(k, tab, o.neden);
        return;
      }
      let sifre = false;
      try { sifre = await wc.executeJavaScript("!!document.querySelector('input[type=password]')"); } catch (e) {}
      if (sifre) {
        durum(k, 'Giriş yapılıyor...');
        if (!ctx.getCfg().giris.auto) { try { await ctx.loginDene(tab.id, true); } catch (e) {} }
        return;
      }
      g.yonlendirme++;
      if (g.yonlendirme > 6) { hataDurumu(k, 'Arama sayfasına ulaşılamadı (' + url + ')'); return; }
      durum(k, 'Arama sayfasına gidiliyor...');
      wc.loadURL(TARAMA_URL);
      return;
    }
    if (g.asama === 'form') formAdimi(k, tab, wc);
    else sonucAdimi(k, tab, wc);
  }

  async function formAdimi(k, tab, wc) {
    const g = k.gorev;
    if (!g || g.formMesgul) return;
    g.formMesgul = true;
    try {
      // Ara daha önce tıklandıysa (sayfa yeniden yüklendi) tekrar arama yapma
      let marker = null;
      try { marker = await wc.executeJavaScript("sessionStorage.getItem('oto_form_tikladi')"); } catch (e) {}
      if (marker && String(marker) === String(g.baslangic)) {
        g.asama = 'sonuc';
        g.formMesgul = false;
        sonucAdimi(k, tab, wc);
        return;
      }
      g.formDeneme++;
      if (g.formDeneme > 10) { hataDurumu(k, 'Form doldurulamadı (10 deneme)'); return; }
      durum(k, `Form dolduruluyor (il: TÜRKİYE, jenerik: ${aranan(k)})...`);
      await bekle(1500);       // DevExpress kontrollerinin hazır olması için
      let s = null;
      try { s = await wc.executeJavaScript(formKodu(aranan(k), g.baslangic)); }
      catch (e) {
        // Sayfa yeniden yüklenmiş olabilir; yeni yüklemede tekrar denenecek
        ctx.dlog(tab.id, 'TAKİP', 'form betiği kesildi: ' + ctx.kisalt(e && e.message));
        return;
      }
      if (s && s.ok) {
        g.asama = 'sonuc';
        durum(k, 'Arama yapıldı, sonuç bekleniyor...');
        g.formMesgul = false;
        sonucAdimi(k, tab, wc);
        return;
      }
      ctx.dlog(tab.id, 'TAKİP', 'form adımı tamamlanamadı: ' + (s && s.adim));
      g.formMesgul = false;
      setTimeout(() => { if (k.gorev === g && g.asama === 'form') formAdimi(k, tab, wc); }, 3000);
    } finally {
      if (k.gorev === g) g.formMesgul = false;
    }
  }

  async function sonucAdimi(k, tab, wc) {
    const g = k.gorev;
    if (!g || g.sonucMesgul) return;
    g.sonucMesgul = true;
    try {
      durum(k, 'Arama sonucu bekleniyor...');
      const t0 = Date.now();
      let sifir = 0, sonuc = '';
      while (Date.now() - t0 < SONUC_MAX) {
        if (k.gorev !== g || !AKTIF_ASAMALAR.includes(g.asama)) return;
        if (!ctx.views[tab.id] || wc.isDestroyed()) return;
        let d = null;
        try { d = await wc.executeJavaScript(SONUC_SORGU); } catch (e) { await bekle(1500); continue; }
        if (d && d.satir > 0 && d.hazir && !d.busy) { sonuc = 'var'; break; }
        if (d && d.hazir && !d.busy && d.satir === 0 && d.form && String(d.marker) === String(g.baslangic)) {
          sifir++;
          if (sifir >= 20 && Date.now() - t0 > 10000) { sonuc = 'yok'; break; }
        } else sifir = 0;
        await bekle(1500);
      }
      if (sonuc === 'yok') {
        k.tarandi = true; g.asama = 'bitti';
        durum(k, 'Tarandı: teklif edilecek stok bulunamadı');
        return;
      }
      if (sonuc !== 'var') { hataDurumu(k, 'Arama sonucu ' + SONUC_MAX / 60000 + ' dk içinde gelmedi'); return; }

      k.tarandi = true;
      g.asama = 'bot';
      durum(k, 'Teklifler bulundu, bot başlatılıyor...');
      const gorev = {
        baslat: true, ad: k.ad, hedef: g.hedef, hastaneler: k.hastaneler, teklifOnce: k.teklif,
        sonTeklifSayfa: k.sonTeklifSayfa, ay: botAyarKalem(k)
      };
      const kod = "sessionStorage.setItem('oto_gorev'," + JSON.stringify(JSON.stringify(gorev)) +
        ");(window.__otoGorevKontrol?(window.__otoGorevKontrol(),'ok'):'yok')";
      let r = 'yok';
      try { r = await wc.executeJavaScript(kod); } catch (e) {}
      if (r !== 'ok') {
        // Script henüz enjekte edilmemiş (grid sonradan geldi): yeniden enjekte et
        try { await ctx.scriptEnjekte(wc, tab, true); } catch (e) {}
        await bekle(2500);
        try { await wc.executeJavaScript('window.__otoGorevKontrol&&window.__otoGorevKontrol()'); } catch (e) {}
      }
    } finally {
      if (k.gorev === g) g.sonucMesgul = false;
    }
  }

  // ---------------- Script'ten gelen bildirimler ----------------
  function komut(tab, metin) {
    let o = null;
    try { o = JSON.parse(metin); } catch (e) { return; }
    if (!o || !o.tip) return;
    const k = kalemSekme(tab.id);
    if (k) {
      if (o.sayfa) k.sayfa = o.sayfa;
      if (o.toplam) k.toplamSayfa = o.toplam;
      if (typeof o.teklif === 'number') k.teklif = o.teklif;
      if (typeof o.atlanan === 'number') k.atlanan = o.atlanan;
      if (o.sonTeklifSayfa) k.sonTeklifSayfa = o.sonTeklifSayfa;
    }
    if (o.tip === 'teklif' && k) {
      if (o.hastane && !k.hastaneler.includes(o.hastane)) k.hastaneler.push(o.hastane);
      k.yeniden = 0;      // ilerleme var: ardışık yeniden başlatma sayacı sıfırlanır
      durum(k, `Çalışıyor: ${k.sayfa}/${k.toplamSayfa || '?'}. sayfa, ${k.teklif} teklif`);
    } else if (o.tip === 'ilerleme' && k) {
      durum(k, `Çalışıyor: ${k.sayfa}/${k.toplamSayfa || '?'}. sayfa, ${k.teklif} teklif`);
    } else if (o.tip === 'hata') {
      masaustuLog(tab, k, o);
      if (k) { k.sonHata = o.neden || ''; durum(k, `Hata (toparlanıyor): ${k.sayfa}/${k.toplamSayfa || '?'}. sayfa - ${ctx.kisalt(o.neden, 80)}`); }
    } else if (o.tip === 'bitti') {
      if (o.hata) masaustuLog(tab, k, o);
      if (!k || !k.gorev) return;
      if (o.tamam) {
        k.talepYapildi = true; k.gorev.asama = 'bitti';
        durum(k, `Tamamlandı (${o.neden}) - ${k.teklif} teklif`);
      } else if (o.kullanici) {
        k.gorev.asama = 'durduruldu';
        durum(k, `Durduruldu (${k.sayfa}/${k.toplamSayfa || '?'}. sayfada)`);
      } else {
        k.sonHata = o.neden || '';
        hataDonusu(k, tab, o.neden || 'bilinmeyen hata');
      }
    }
  }

  // Hata sonrası: sekmeyi kapatıp yeniden aç, aramayı yap, kaldığı sayfaya git
  function hataDonusu(k, tab, neden) {
    if (!T.otoYeniden || k.yeniden >= T.maxYeniden) {
      hataDurumu(k, `${neden} (otomatik yeniden başlatma ${T.otoYeniden ? 'hakkı bitti' : 'kapalı'}) - ${k.sayfa}/${k.toplamSayfa || '?'}. sayfada kaldı`);
      return;
    }
    k.yeniden++;
    const hedef = Math.max(1, k.sayfa || 1);
    const g = k.gorev;
    if (g) g.asama = 'bekleme';
    durum(k, `Hata: ${ctx.kisalt(neden, 70)} | ${YENIDEN_BEKLEME / 1000} sn sonra yeniden başlatılacak (${k.yeniden}/${T.maxYeniden}), ${hedef}/${k.toplamSayfa || '?'}. sayfadan devam`);
    setTimeout(() => {
      if (k.gorev !== g || (g && g.asama !== 'bekleme')) return;
      sekmeYenile(k, hedef);
    }, YENIDEN_BEKLEME);
  }
  function sekmeYenile(k, hedef) {
    const tab = k.sekmeId != null ? ctx.tabBul(k.sekmeId) : null;
    if (!tab) { hataDurumu(k, 'Sekme bulunamadı'); return; }
    ctx.viewKaldir(tab.id);
    tab.url = TARAMA_URL;
    k.gorev = yeniGorev(hedef);
    durum(k, `Sekme yeniden açıldı, ${hedef}. sayfaya gidilecek...`);
    ctx.dlog(tab.id, 'TAKİP', `"${k.ad}" sekmesi yeniden açıldı, hedef sayfa ${hedef}`);
    ctx.viewOlustur(tab);
    ctx.layout(); ctx.push();
  }
  function cokme(tab) {
    const k = kalemSekme(tab.id);
    if (!k || !aktifMi(k)) return;
    const o = { neden: 'Sekme süreci çöktü', sayfa: k.sayfa, toplam: k.toplamSayfa, sonTeklifSayfa: k.sonTeklifSayfa, teklif: k.teklif, atlanan: k.atlanan, log: [] };
    masaustuLog(tab, k, o);
    hataDonusu(k, tab, o.neden);
  }
  function sekmeKapandi(id) {
    const k = kalemSekme(id);
    if (!k) return;
    k.sekmeId = null; k.gorev = null;
    durum(k, 'Sekme kapatıldı');
  }

  // ---------------- Masaüstü hata logu ----------------
  // Her sekme (kalem) için tek dosya; her hata aynı dosyayı günceller, üstte son durum, altta hata geçmişi.
  const gecmisBellek = {};   // takip listesi dışı sekmeler için
  function dosyaAdi(ad) {
    return 'StokOto-HATA-' + String(ad || 'sekme').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '.txt';
  }
  async function masaustuLog(tab, k, o) {
    try {
      const masa = app.getPath('desktop');
      const ad = k ? sekmeAdi(k) : (tab.name || 'sekme');
      const yol = path.join(masa, dosyaAdi(ad));
      const toplam = o.toplam || (k && k.toplamSayfa) || '?';
      const sonSayfa = o.sonTeklifSayfa ? `${o.sonTeklifSayfa} / ${toplam}` : 'henüz hiç teklif atılmadı';

      // hata geçmişi
      const gecmis = k ? k.hataGecmisi : (gecmisBellek[tab.id] = gecmisBellek[tab.id] || []);
      gecmis.push({ zaman: simdiYazi(), neden: o.neden || '-', sayfa: o.sayfa || 0, toplam, sonTeklifSayfa: o.sonTeklifSayfa || 0, teklif: o.teklif || 0 });
      while (gecmis.length > 30) gecmis.shift();
      if (k) kaydet();

      const ayarYazi = k ? (() => {
        const a = botAyarKalem(k);
        return `yüzde ${a.yuzde}, min ${a.min}, max ${a.max}, adım ${a.adim}, miad ${a.gun} gün, aynı hastaneye tekrar atma ${a.hastaneTek ? 'evet' : 'hayır'}`;
      })() : '';
      const baslik = [
        '=== STOK OTO HATA RAPORU ===',
        k ? `ARANAN KALEM: ${k.ad || '-'}` : `SEKME: ${ad}`,
        k ? `Jenerik / Taşınır adı: ${aranan(k) || '-'} | İstenen miktar: ${k.miktar || '-'}` : '',
        k ? `Bot ayarları: ${ayarYazi}` : '',
        'Son güncelleme: ' + simdiYazi(),
        '',
        'SON HATA: ' + (o.neden || '-'),
        `SON TEKLİF ATILAN SAYFA${k && k.ad ? ' (' + k.ad + ')' : ''}: ${sonSayfa}`,
        `Hatanın olduğu sayfa: ${o.sayfa || '?'} / ${toplam}`,
        `Toplam teklif: ${o.teklif || 0}, atlanan: ${o.atlanan || 0}`,
        k ? `Otomatik yeniden başlatma: ${k.yeniden}/${T.maxYeniden} (${T.otoYeniden ? 'açık' : 'kapalı'})` : '',
        '',
        '--- Hata geçmişi (en yeni en üstte) ---'
      ].filter((x) => x !== '' || true);
      const gecmisSatir = gecmis.slice().reverse().map((g, i) =>
        `${i + 1}) ${g.zaman} | ${g.neden} | sayfa ${g.sayfa || '?'}/${g.toplam}, son teklif sayfası ${g.sonTeklifSayfa || '-'}, teklif ${g.teklif}`);
      const govde = (o.log && o.log.length ? o.log : ['(bu hatada script kaydı alınamadı)']).join('\r\n');
      let rapor = '';
      try {
        const r = await Promise.race([Promise.resolve(ctx.rapor()), bekle(4000).then(() => '(rapor 4 sn içinde alınamadı)')]);
        rapor = '\r\n\r\n--- Uygulama (debug) kayıtları ---\r\n' + r;
      } catch (e) {}
      const metin = baslik.concat(gecmisSatir, ['', '--- Bot kayıtları (son hatadaki son satırlar) ---']).join('\r\n') + '\r\n' + govde + rapor;
      fs.writeFileSync(yol, '\uFEFF' + metin, 'utf8');
      ctx.dlog(tab.id, 'HATA-LOG', 'masaüstüne kaydedildi: ' + yol);
    } catch (e) {
      ctx.dlog(tab.id, 'HATA', 'masaüstü logu yazılamadı: ' + (e && e.message));
    }
  }

  // ---------------- Excel ----------------
  function sayiMi(v) {
    const t = str(v).replace(',', '.');
    return t !== '' && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : str(v);
  }
  // Excel: 1. sayfa kullanıcının şablonuyla aynı ("Stok İhtiyaç": KALEM ADI | JENERİK ADI | TAŞINIR ADI | İHTİYAÇ MİKTARI),
  // 2. sayfa ayrıntılı takip durumu. İçe aktarmada sadece 1. sayfa okunur.
  const N = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');
  async function excelAl() {
    const ihtiyac = [['KALEM ADI', 'JENERİK ADI', 'TAŞINIR ADI', 'İHTİYAÇ MİKTARI']];
    T.kalemler.forEach((k) => ihtiyac.push([k.ad, aranan(k), aranan(k), sayiMi(k.miktar)]));
    const durumSat = [['No', 'Kalem Adı', 'Jenerik / Taşınır Adı', 'Miktar', 'Stok Koordinasyon Tarandı', 'Talep Yapıldı', 'Sayfa', 'Teklif Sayısı', 'Atlanan', 'Son Teklif Sayfası', 'Durum', 'Son Hata', 'Son Güncelleme']];
    T.kalemler.forEach((k, i) => durumSat.push([
      i + 1, k.ad, aranan(k), sayiMi(k.miktar), k.tarandi ? '✓' : '', k.talepYapildi ? '✓' : '',
      k.toplamSayfa ? `${k.sayfa}/${k.toplamSayfa}` : '', k.teklif, k.atlanan, k.sonTeklifSayfa || '', k.durum, k.sonHata, k.guncel
    ]));
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const r = await dialog.showSaveDialog(pencere && !pencere.isDestroyed() ? pencere : undefined, {
      title: 'Excel olarak kaydet',
      defaultPath: path.join(app.getPath('desktop'), `StokTakip-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.xlsx`),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, iptal: true };
    try {
      fs.writeFileSync(r.filePath, ctx.xlsxOlustur([
        { ad: 'Stok İhtiyaç', satirlar: ihtiyac, genislik: [36, 30, 30, 18] },
        { ad: 'Takip Durumu', satirlar: durumSat, genislik: [5, 28, 34, 10, 16, 14, 10, 12, 10, 14, 44, 44, 20] }
      ]));
      try { shell.showItemInFolder(r.filePath); } catch (e) {}
      return { ok: true, yol: r.filePath };
    } catch (e) { return { ok: false, hata: e.message }; }
  }

  // Boş şablon (sadece başlık satırı): doldurup "Excel'den içe aktar" ile yüklenir
  async function sablonIndir() {
    const r = await dialog.showSaveDialog(pencere && !pencere.isDestroyed() ? pencere : undefined, {
      title: 'Şablonu kaydet',
      defaultPath: path.join(app.getPath('desktop'), 'StokTakip-sablon.xlsx'),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, iptal: true };
    try {
      fs.writeFileSync(r.filePath, ctx.xlsxOlustur([
        { ad: 'Stok İhtiyaç', satirlar: [['KALEM ADI', 'JENERİK ADI', 'TAŞINIR ADI', 'İHTİYAÇ MİKTARI']], genislik: [36, 30, 30, 18] }
      ]));
      try { shell.showItemInFolder(r.filePath); } catch (e) {}
      return { ok: true, yol: r.filePath };
    } catch (e) { return { ok: false, hata: e.message }; }
  }

  function miktarMetni(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000).replace('.', ',');
    return str(v);
  }
  async function excelYukle() {
    const pen = pencere && !pencere.isDestroyed() ? pencere : undefined;
    const r = await dialog.showOpenDialog(pen, {
      title: 'Excel dosyasını seç (KALEM ADI | JENERİK ADI | TAŞINIR ADI | İHTİYAÇ MİKTARI)', defaultPath: app.getPath('desktop'),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, iptal: true };
    let tablo = null;
    try { tablo = ctx.xlsxOku(fs.readFileSync(r.filePaths[0])); } catch (e) { return { ok: false, hata: 'Excel okunamadı: ' + e.message }; }
    const satirlar = tablo.satirlar;
    let bas = satirlar.findIndex((s) => (s || []).some((c) => N(c) === 'KALEM ADI'));
    const kol = { ad: 0, jenerik: 1, tasinir: 2, miktar: 3 };
    if (bas >= 0) {
      satirlar[bas].forEach((c, i) => {
        const n = N(c);
        if (n === 'KALEM ADI') kol.ad = i;
        else if (n === 'JENERİK ADI') kol.jenerik = i;
        else if (n === 'TAŞINIR ADI') kol.tasinir = i;
        else if (n.includes('MİKTAR')) kol.miktar = i;
      });
    } else bas = 0;
    const yeniler = [];
    satirlar.slice(bas + 1).forEach((s) => {
      s = s || [];
      const jen = str(s[kol.jenerik]) || str(s[kol.tasinir]);   // JENERİK ADI hücresi hem jenerik hem taşınır adı sayılır
      const o = { ad: str(s[kol.ad]), jenerik: jen, tasinir: jen, miktar: miktarMetni(s[kol.miktar]) };
      if (!o.ad && !o.jenerik && !o.miktar) return;
      if (!o.ad) o.ad = o.jenerik;
      yeniler.push(o);
    });
    if (!yeniler.length) return { ok: false, hata: 'Dosyada içe aktarılacak satır bulunamadı (başlıklar: KALEM ADI, JENERİK ADI, TAŞINIR ADI, İHTİYAÇ MİKTARI)' };

    const sec = await dialog.showMessageBox(pen, {
      type: 'question', title: 'Excel içe aktar', buttons: ['Mevcut listeyle birleştir', 'Listeyi tamamen değiştir', 'Vazgeç'], defaultId: 0, cancelId: 2,
      message: `${yeniler.length} kalem bulundu (sayfa: ${tablo.sayfa}).`,
      detail: 'Birleştir: aynı kalem adı varsa jenerik / taşınır adı ve miktar güncellenir (ilerleme ve tikler korunur), yeni kalemler eklenir.\nDeğiştir: mevcut liste ve ilerlemeleri silinip Excel\'deki liste kurulur.'
    });
    if (sec.response === 2) return { ok: false, iptal: true };
    let eklenen = 0, guncellenen = 0;
    if (sec.response === 1) {
      T.kalemler.forEach((k) => { if (k.gorev) k.gorev.asama = 'durduruldu'; });
      T.kalemler = [];
    }
    yeniler.forEach((o) => {
      const var_ = T.kalemler.find((k) => N(k.ad) === N(o.ad));
      if (var_) {
        if (o.jenerik) { var_.jenerik = o.jenerik; var_.tasinir = o.jenerik; }
        if (o.miktar !== '') var_.miktar = o.miktar;
        guncellenen++;
      } else {
        T.kalemler.push(Object.assign(yeniKalemTaslak(), { id: ++T.sonId }, o));
        eklenen++;
      }
    });
    kaydetHemen();
    return { ok: true, eklenen, guncellenen };
  }

  // ---------------- Yedek ----------------
  async function yedekAl() {
    const cfg = ctx.getCfg();
    const sec = await dialog.showMessageBox(pencere && !pencere.isDestroyed() ? pencere : undefined, {
      type: 'question', title: 'Yedek', buttons: ['Parolasız yedekle', 'Parolayla yedekle', 'Vazgeç'], defaultId: 0, cancelId: 2,
      message: 'Giriş parolası yedeğe eklensin mi?',
      detail: 'Parolalı yedekte parola düz yazı olarak dosyaya yazılır. Dosyayı e-postayla kendine gönderiyorsan parolasız yedeği tercih et; evdeki bilgisayarda parolayı bir kere yeniden girersin.'
    });
    if (sec.response === 2) return { ok: false, iptal: true };
    const veri = {
      tur: 'StokOtoYedek', surum: 1, tarih: new Date().toISOString(), uygulama: app.getVersion(),
      cfg: { nextId: cfg.nextId, active: cfg.active, tabs: cfg.tabs.map((t) => ({ id: t.id, name: t.name, url: t.url, zoom: t.zoom })), ayar: cfg.ayar },
      giris: { user: cfg.giris.user, auto: !!cfg.giris.auto, parolaMetni: sec.response === 1 ? ctx.coz(cfg.giris.pass) : null },
      takip: JSON.parse(JSON.stringify(T, (k, v) => (k === 'gorev' ? undefined : v))),
      scriptler: {
        stok: fs.existsSync(ctx.dosyaYolu('stok')) ? ctx.scriptOku('stok') : null,
        silme: fs.existsSync(ctx.dosyaYolu('silme')) ? ctx.scriptOku('silme') : null
      }
    };
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const r = await dialog.showSaveDialog(pencere && !pencere.isDestroyed() ? pencere : undefined, {
      title: 'Yedeği kaydet',
      defaultPath: path.join(app.getPath('desktop'), `StokOto-Yedek-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`),
      filters: [{ name: 'Stok Oto Yedek', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, iptal: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(veri, null, 2), 'utf8');
      try { shell.showItemInFolder(r.filePath); } catch (e) {}
      return { ok: true, yol: r.filePath };
    } catch (e) { return { ok: false, hata: e.message }; }
  }
  async function yedekYukle() {
    const pen = pencere && !pencere.isDestroyed() ? pencere : undefined;
    const r = await dialog.showOpenDialog(pen, {
      title: 'Yedek dosyasını seç', defaultPath: app.getPath('desktop'),
      filters: [{ name: 'Stok Oto Yedek', extensions: ['json'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, iptal: true };
    let y = null;
    try { y = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (e) { return { ok: false, hata: 'Dosya okunamadı: ' + e.message }; }
    if (!y || y.tur !== 'StokOtoYedek' || !y.cfg || !Array.isArray(y.cfg.tabs)) return { ok: false, hata: 'Bu bir Stok Oto yedek dosyası değil' };
    const onay = await dialog.showMessageBox(pen, {
      type: 'warning', title: 'Yedekten yükle', buttons: ['Yükle', 'Vazgeç'], defaultId: 1, cancelId: 1,
      message: 'Mevcut sekmeler, takip listesi ve ayarlar yedektekiyle değiştirilecek.',
      detail: `Yedek tarihi: ${y.tarih || '-'}\nSekme sayısı: ${y.cfg.tabs.length}\nKalem sayısı: ${(y.takip && y.takip.kalemler || []).length}`
    });
    if (onay.response !== 0) return { ok: false, iptal: true };
    try {
      const cfg = ctx.getCfg();
      const yeni = {
        nextId: y.cfg.nextId, active: y.cfg.active, tabs: y.cfg.tabs, ayar: y.cfg.ayar,
        giris: {
          user: (y.giris && y.giris.user) || '', auto: !!(y.giris && y.giris.auto),
          pass: y.giris && y.giris.parolaMetni ? ctx.sifrele(y.giris.parolaMetni) : cfg.giris.pass
        }
      };
      ctx.cfgDegistir(yeni);
      T = duzenle(y.takip);
      kaydetHemen();
      if (y.scriptler) {
        ['stok', 'silme'].forEach((h) => {
          if (y.scriptler[h]) { fs.mkdirSync(path.dirname(ctx.dosyaYolu(h)), { recursive: true }); fs.writeFileSync(ctx.dosyaYolu(h), y.scriptler[h], 'utf8'); }
        });
      }
      return { ok: true, parola: !!(y.giris && y.giris.parolaMetni) };
    } catch (e) { return { ok: false, hata: e.message }; }
  }

  // ---------------- Pencere + IPC ----------------
  function pencereAc() {
    if (pencere && !pencere.isDestroyed()) { pencere.show(); pencere.focus(); return; }
    pencere = new BrowserWindow({
      width: 1260, height: 780, title: 'Takip', autoHideMenuBar: true, backgroundColor: '#f4f5f7',
      webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    pencere.removeMenu();
    pencere.loadFile(path.join(__dirname, 'takip.html'));
    const w = ctx.getWin();
    if (w) w.once('closed', () => { try { if (pencere && !pencere.isDestroyed()) pencere.destroy(); } catch (e) {} });
  }
  ipcMain.on('takip', pencereAc);

  ipcMain.handle('takip:oku', () => ({
    kalemler: T.kalemler.map((k) => Object.assign({}, k, { gorev: null, aktif: aktifMi(k), asama: (k.gorev && k.gorev.asama) || '' })),
    botAyar: T.botAyar, otoYeniden: T.otoYeniden, maxYeniden: T.maxYeniden, masaustu: app.getPath('desktop')
  }));
  // Mükerrer kontrolü: aynı kalem adı engellenir, aynı jenerik adı (farklı kalem adıyla) uyarıyla sorulur
  const katla = (v) => str(v).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/\s+/g, ' ');
  ipcMain.handle('takip:ekle', (e, o, zorla) => {
    o = o || {};
    const ad = str(o.ad), jen = str(o.jenerik) || str(o.tasinir);
    if (ad) {
      const ayni = T.kalemler.find((k) => katla(k.ad) === katla(ad));
      if (ayni) return { ok: false, tur: 'ad', id: ayni.id, ad: ayni.ad };
    }
    if (jen && !zorla) {
      const ayni = T.kalemler.find((k) => katla(aranan(k)) === katla(jen));
      if (ayni) return { ok: false, tur: 'jenerik', id: ayni.id, ad: ayni.ad };
    }
    const k = Object.assign(yeniKalemTaslak(), { id: ++T.sonId, ad, jenerik: jen, tasinir: jen, miktar: str(o.miktar) });
    T.kalemler.push(k);
    kaydetHemen();
    return { ok: true, id: k.id };
  });
  ipcMain.handle('takip:guncelle', (e, id, alan, deger) => {
    const k = kalem(id);
    if (!k) return false;
    if (['ad', 'jenerik', 'tasinir', 'miktar', 'notlar'].includes(alan)) {
      k[alan] = str(deger);
      if (alan === 'jenerik' || alan === 'tasinir') { k.jenerik = k[alan]; k.tasinir = k[alan]; }
      if (alan === 'ad' && k.sekmeId != null) {
        const t = ctx.tabBul(k.sekmeId);
        if (t && k.ad) { t.name = k.ad; ctx.cfgKaydet(); ctx.push(); }
      }
    } else if (alan === 'tarandi' || alan === 'talepYapildi') {
      k[alan] = !!deger;
    } else if (alan === 'ayar' && deger && typeof deger === 'object') {
      const sayisal = ['yuzde', 'min', 'max', 'adim', 'gun', 'maxTeklif', 'maxSayfa'];
      k.ayar = k.ayar || {};
      Object.keys(deger).forEach((a) => {
        const v = deger[a];
        if (sayisal.includes(a)) {
          const n = Number(v);
          if (v === '' || v == null || !(n > 0)) delete k.ayar[a]; else k.ayar[a] = Math.round(n);
        } else if (a === 'hastaneTek') {
          if (v === true || v === 'e') k.ayar.hastaneTek = true;
          else if (v === false || v === 'h') k.ayar.hastaneTek = false;
          else delete k.ayar.hastaneTek;
        }
      });
    } else return false;
    kaydet();
    return true;
  });
  ipcMain.handle('takip:sil', (e, id) => {
    const k = kalem(id);
    if (!k) return false;
    if (k.gorev) k.gorev.asama = 'durduruldu';
    T.kalemler = T.kalemler.filter((x) => x.id !== id);
    kaydetHemen();
    return true;
  });
  ipcMain.handle('takip:ara', (e, id, devam) => ara(id, !!devam));
  ipcMain.handle('takip:durdur', async (e, id) => {
    const k = kalem(id);
    if (!k) return false;
    if (k.gorev) k.gorev.asama = 'durduruldu';
    const v = k.sekmeId != null ? ctx.views[k.sekmeId] : null;
    if (v) { try { await v.webContents.executeJavaScript("(function(){var b=document.getElementById('oDur');if(b)b.click();})()"); } catch (err) {} }
    durum(k, 'Durduruldu');
    return true;
  });
  ipcMain.handle('takip:botayar', (e, o) => {
    o = o || {};
    ['yuzde', 'min', 'max', 'adim', 'gun', 'maxTeklif', 'maxSayfa', 'adimMs', 'gecisSn', 'deneme'].forEach((a) => {
      const n = Number(o[a]);
      if (n > 0) T.botAyar[a] = Math.round(n);
    });
    if (typeof o.hastaneTek === 'boolean') T.botAyar.hastaneTek = o.hastaneTek;
    kaydetHemen();
    return T.botAyar;
  });
  ipcMain.handle('takip:genel', (e, o) => {
    o = o || {};
    if (typeof o.otoYeniden === 'boolean') T.otoYeniden = o.otoYeniden;
    if (Number(o.maxYeniden) >= 0) T.maxYeniden = Math.round(Number(o.maxYeniden));
    kaydetHemen();
    return true;
  });
  ipcMain.handle('takip:excel', () => excelAl());
  ipcMain.handle('takip:excelyukle', () => excelYukle());
  ipcMain.handle('takip:sablon', () => sablonIndir());
  ipcMain.handle('takip:yedekal', () => yedekAl());
  ipcMain.handle('takip:yedekyukle', () => yedekYukle());

  return { sayfaYuklendi, komut, cokme, sekmeKapandi, pencereAc };
};
