// ==UserScript==
// @name         Stok Koordinasyon Otomasyonu v4.8
// @namespace    stok-oto
// @version      4.8
// @description  Akıllı teklif: miad + miktar + hastane + yurtdışı bütçe kontrolü, sunucu yavaşlığına dayanıklı sayfa geçişi, hata olunca durmadan toparlanma, log paneli
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============ SABİTLER ============
    const BASARI_MAX = 20000;           // "İşlem başarıyla gerçekleşti" mesajı için azami bekleme
    const POPUP_BEKLEME = 10000;        // popup'ın açılması için bekleme (her denemede)
    const POPUP_DENEME = 3;             // popup açılmazsa aynı satır için deneme sayısı
    const TEKRAR_BEKLEME = 15000;       // sayfa geçişi başarısız olursa tekrar denemeden önce bekleme
    const SUNUCU_BOS_MAX = 600000;      // sunucudaki isteğin bitmesi için en fazla bekleme (10 dk)
    const ARDISIK_HATA_LIMIT = 4;       // üst üste bu kadar satır hatasında sayfa yenileyip toparlan
    const KURTARMA_MAX = 5;             // ilerleme olmadan en fazla kaç kez sayfa yenilensin
    const KURTAR_BEKLEME = 60000;       // yenilemeden önce sunucuya nefes aldırma
    const LOG_MAX = 5000;               // saklanacak en fazla kayıt
    const LOG_GOSTER = 30;              // panelde görünen kayıt sayısı
    // ==================================

    const SEL_SATIR  = 'tr[id*="ASPxGridViewStokFazlasi_DXDataRow"]';
    const SEL_ISTEK  = 'input[id$="ASPxButtonIstekGonder_I"]';
    const SEL_MIKTAR = '#ucTalepciIstekGonder1_ASPxTextBoxTalepMiktari_I';
    const SEL_KAYDET = '#ucTalepciIstekGonder1_ASPxButtonKaydet_I';
    const SEL_KAPAT  = 'img.dxWeb_pcCloseButton_Glass';
    const SEL_ONAY   = '[id$="ucPopUpConfirm1_popUpControl_PWC0"]';
    const SEL_PAGER  = 'div[id$="ASPxGridViewStokFazlasi_DXPagerBottom"]';

    if (window.top !== window.self) return;

    const AYAR_KEY = 'oto_ayar_v4';
    const DURUM_KEY = 'oto_durum_v42';
    const LOG_KEY = 'oto_log_v43';

    // Grid yoksa: çalışma sırasında sayfa yenilenmiş ve sunucu henüz cevap vermiyor olabilir.
    // Çalışma bayrağı açıksa ve hâlâ sorgulama sayfasındaysak 60 sn sonra tekrar yenile.
    if (!document.querySelector('[id*="ASPxGridViewStokFazlasi"]')) {
        try {
            const s = JSON.parse(sessionStorage.getItem(DURUM_KEY) || 'null');
            const n = +sessionStorage.getItem('__otoYenileSay') || 0;
            if (s && s.run && /TalepciSorgulama/i.test(location.href) && n < 20) {
                sessionStorage.setItem('__otoYenileSay', String(n + 1));
                console.log('[Oto] grid bulunamadı, 60 sn sonra sayfa tekrar yenilenecek (' + (n + 1) + '/20)');
                setTimeout(() => location.reload(), 60000);
            }
        } catch (e) {}
        return;
    }
    try { sessionStorage.removeItem('__otoYenileSay'); } catch (e) {}

    // ---------- Sunucu isteği sayacı (TalepciSorgulama XHR'ları) ----------
    if (!window.__otoXhrKurulu) {
        window.__otoXhrKurulu = true;
        window.__otoXhrBekleyen = 0;
        const xo = XMLHttpRequest.prototype.open;
        const xs = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) {
            try { this.__otoU = String(u || ''); } catch (e) {}
            return xo.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            if (/TalepciSorgulama/i.test(this.__otoU || '')) {
                window.__otoXhrBekleyen = (window.__otoXhrBekleyen || 0) + 1;
                let b = false;
                const d = () => {
                    if (b) return;
                    b = true;
                    window.__otoXhrBekleyen = Math.max(0, (window.__otoXhrBekleyen || 0) - 1);
                };
                this.addEventListener('loadend', d);
            }
            return xs.apply(this, arguments);
        };
    }
    const xhrBekleyen = () => window.__otoXhrBekleyen || 0;

    // ---------- Ayarlar (tarayıcıda hatırlanır) ----------
    let A = { yuzde: 50, min: 10, max: 50, adim: 5, gun: 180, maxTeklif: 9999, maxSayfa: 9999, gecisSn: 600, deneme: 5, hastaneTek: true, v46: true, adimMs: 250, v47: true, v48: true };
    try { Object.assign(A, JSON.parse(localStorage.getItem(AYAR_KEY) || '{}')); } catch (e) {}
    // v4.6'ya geçişte eski kısa bekleme/deneme değerlerini yükselt (bir kereliğine)
    if (!A.v46) {
        A.gecisSn = 600;
        A.deneme = Math.max(5, A.deneme || 5);
        A.v46 = true;
        try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {}
    }

    if (!A.v47) {
        A.adimMs = 250;
        A.v47 = true;
        try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {}
    }

    if (!A.v48) {
        A.maxTeklif = 9999;
        A.maxSayfa = 9999;
        A.v48 = true;
        try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {}
    }

    // ---------- Durum (sayfa yenilense de kaybolmaz) ----------
    const D0 = () => ({ run: false, sayfa: null, done: [], hastaneler: [], teklif: 0, atlanan: 0, sayfaSayac: 0, nedenler: {}, hedef: null, ardisikHata: 0, kurtarma: 0 });
    let D = D0();
    try {
        const s = JSON.parse(sessionStorage.getItem(DURUM_KEY) || 'null');
        if (s) D = Object.assign(D, s);
    } catch (e) {}
    if (!D.nedenler) D.nedenler = {};
    const durumKaydet = () => { try { sessionStorage.setItem(DURUM_KEY, JSON.stringify(D)); } catch (e) {} };

    // ---------- Log (sadece son çalıştırma tutulur) ----------
    let L = [];
    try { L = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) {}
    let logKaydetT = null;
    let logAcik = false;
    let logCizBekliyor = false;
    let logKutu = null;

    function logKaydet() {
        clearTimeout(logKaydetT);
        logKaydetT = setTimeout(() => {
            try { localStorage.setItem(LOG_KEY, JSON.stringify(L)); } catch (e) {}
        }, 500);
    }
    function logYaz(tur, mesaj) {
        const s = `${new Date().toLocaleTimeString('tr-TR')} | ${tur} | ${mesaj}`;
        L.push(s);
        if (L.length > LOG_MAX) L.splice(0, L.length - LOG_MAX);
        console.log('[Oto]', s);
        logKaydet();
        if (logAcik) logCiz();
    }
    function logCiz() {
        if (logCizBekliyor || !logKutu) return;
        logCizBekliyor = true;
        requestAnimationFrame(() => {
            logCizBekliyor = false;
            if (!logKutu) return;
            logKutu.textContent = '';
            const son = L.slice(-LOG_GOSTER).reverse();
            if (!son.length) { logKutu.textContent = 'Kayıt yok.'; return; }
            for (const s of son) {
                const d = document.createElement('div');
                d.textContent = s;
                d.style.cssText = 'padding:2px 0;border-bottom:1px solid #23262e;word-break:break-word;';
                if (s.includes('| TEKLİF |')) d.style.color = '#4ade80';
                else if (s.includes('| HATA |') || s.includes('| KURTAR |')) d.style.color = '#f87171';
                else if (s.includes('| UYARI |')) d.style.color = '#fbbf24';
                else if (s.includes('| ATLA |')) d.style.color = '#6b7385';
                else d.style.color = '#cdd3df';
                logKutu.appendChild(d);
            }
        });
    }
    function logIndir() {
        const t = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const ad = `stok-log-${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}.txt`;
        const blob = new Blob(['\uFEFF' + L.join('\r\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = ad;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    let durduruldu = false;
    let calisiyor = false;

    const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
    const gorunur = (el) => !!el && el.getClientRects().length > 0;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');

    // Hastane adı: sadece bağlantı yazısı, baştaki "T.C." ve "SAĞLIK BAKANLIĞI" atılır
    function hastaneOku(td) {
        if (!td) return '';
        const a = td.querySelector('a');
        let t = a
            ? a.textContent
            : [...td.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
        t = norm(t).replace(/^T\.?\s?C\.?\s*/, '').replace(/^SAĞLIK BAKANLIĞI\s*/, '');
        return norm(t);
    }

    // Yurtdışı bütçe mi? ("YURTDIŞI BÜTÇE" / "YURT DIŞI ...")
    function yurtdisiMi(butce) {
        const b = norm(butce).replace(/\s/g, '');
        return b.includes('YURTDIŞI');
    }

    async function bekleVeBul(fn, timeout) {
        const bitis = Date.now() + timeout;
        while (Date.now() < bitis) {
            if (durduruldu) return null;
            const v = fn();
            if (v) return v;
            await bekle(60);
        }
        return null;
    }

    // ---------- iframe destekli arama ----------
    function tumDokumanlar() {
        const liste = [document];
        const tara = (doc) => {
            for (const f of doc.querySelectorAll('iframe')) {
                try {
                    const d = f.contentDocument;
                    if (d) { liste.push(d); tara(d); }
                } catch (e) {}
            }
        };
        tara(document);
        return liste;
    }
    function gorunurAra(sel) {
        for (const d of tumDokumanlar()) {
            for (const el of d.querySelectorAll(sel)) if (gorunur(el)) return el;
        }
        return null;
    }
    function miktarYaz(input, deger) {
        const win = input.ownerDocument.defaultView;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(deger));
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true }));
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
        input.blur();
    }
    function disKapatBul() {
        return [...document.querySelectorAll(SEL_KAPAT)].filter(gorunur)[0] || null;
    }

    // ---------- Sunucu durumu ----------
    function gridNesne() {
        try {
            const r = document.querySelector(SEL_SATIR);
            if (!r) return null;
            const ad = r.id.split('_DXDataRow')[0];
            const col = window.ASPxClientControl.GetControlCollection();
            const g = col.GetByName ? col.GetByName(ad) : col.Get(ad);
            return g && typeof g.GotoPage === 'function' ? g : null;
        } catch (e) { return null; }
    }
    function sunucuMesgul() {
        if (xhrBekleyen() > 0) return true;
        try {
            const g = gridNesne();
            if (g && typeof g.InCallback === 'function' && g.InCallback()) return true;
        } catch (e) {}
        return false;
    }
    // Sunucudaki istek bitene kadar bekler (tekrar tıklamadan). true: boşta, false: zaman aşımı / durduruldu
    async function bosBekle(maxMs, etiket) {
        const bas = Date.now();
        let yazildi = false;
        while (Date.now() - bas < maxMs) {
            if (durduruldu) return false;
            if (!sunucuMesgul()) {
                await bekle(300);
                if (!sunucuMesgul()) return true;
                continue;
            }
            const sn = Math.round((Date.now() - bas) / 1000);
            if (!yazildi && sn >= 10) { logYaz('BEKLE', `sunucu cevabı bekleniyor (${etiket})`); yazildi = true; }
            durumYaz(`Sunucu cevabı bekleniyor... ${sn} sn (${etiket})`);
            await bekle(300);
        }
        logYaz('HATA', `sunucu ${Math.round(maxMs / 1000)} sn içinde cevap vermedi (${etiket})`);
        return false;
    }
    // Açık kalmış popup varsa kapat
    async function popupTemizle() {
        for (let i = 0; i < 3; i++) {
            if (durduruldu) return;
            const x = disKapatBul();
            if (!x && !gorunurAra(SEL_MIKTAR)) return;
            if (x) x.click();
            await bekleVeBul(() => !gorunurAra(SEL_MIKTAR), 4000);
            await bekle(500);
        }
    }

    // ---------- Tablo okuma ----------
    function kolonlar() {
        const idx = {};
        const hr = document.querySelector('tr[id$="DXHeadersRow0"]');
        if (hr) [...hr.children].forEach((td, i) => { idx[td.textContent.replace(/\s+/g, ' ').trim()] = i; });
        return {
            ilac: idx['Malzeme Tanımı'] ?? 1,
            butce: idx['Bütçe'] ?? 2,
            miad: idx['Son Kullanma Tarihi'] ?? 3,
            stok: idx['Stok Fazlası'] ?? 6,
            hastane: idx['Karşılayacak Birim'] ?? 11
        };
    }
    function sayiOku(t) {
        const n = parseFloat((t || '').replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
        return isNaN(n) ? null : n;
    }
    function tarihOku(t) {
        const m = (t || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
    }
    function sayfaBilgi() {
        const root = document.querySelector(SEL_PAGER);
        if (!root) return { cur: null, toplam: null };
        const c = root.querySelector('b.dxp-current');
        const s = root.querySelector('b.dxp-summary');
        const m = s ? s.textContent.match(/Toplam\s+(\d+)\s+Sayfa/) : null;
        return {
            cur: c ? parseInt(c.textContent.replace(/\D/g, ''), 10) : null,
            toplam: m ? parseInt(m[1], 10) : null
        };
    }
    function satirImza() {
        const r = document.querySelector(SEL_SATIR);
        return r ? r.id + '|' + (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    }
    function sonrakiSatir() {
        for (const r of document.querySelectorAll(SEL_SATIR)) {
            if (!D.done.includes(r.id)) return r;
        }
        return null;
    }

    // ---------- Teklif miktarı hesabı ----------
    function teklifMiktari(stok) {
        const ham = Math.floor((stok * A.yuzde) / 100);
        let m = Math.floor(ham / A.adim) * A.adim;
        if (m > A.max) m = A.max;
        return m;
    }

    // "İşlem başarıyla gerçekleşti" uyarı kutusunu bekler (iframe içinde). Kutu çıkar çıkmaz devam edilir.
    async function basariBekle(uyari0, maxMs) {
        const bas = Date.now();
        while (Date.now() - bas < maxMs) {
            if (durduruldu) return { tur: 'dur', metin: '', ms: 0 };
            const el = gorunurAra(SEL_ONAY);
            if (el) {
                const m = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (m) return { tur: /başar/.test(m.toLocaleLowerCase('tr-TR')) ? 'ok' : 'hata', metin: m, ms: Date.now() - bas };
            }
            if ((window.__otoAlertSayac || 0) > uyari0) {
                return { tur: 'hata', metin: 'sayfa uyarısı: ' + String(window.__otoSonAlert || ''), ms: Date.now() - bas };
            }
            await bekle(60);
        }
        return { tur: 'zaman', metin: '', ms: Date.now() - bas };
    }

    // ---------- Tek satır: 'teklif' | 'atla' | 'hata' | 'dur' ----------
    async function satirIsle(satir, k) {
        const satirId = satir.id;
        D.done.push(satirId);
        durumKaydet();

        const hucre = satir.children;
        const ilac = ((hucre[k.ilac] && hucre[k.ilac].textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const butce = ((hucre[k.butce] && hucre[k.butce].textContent) || '').replace(/\s+/g, ' ').trim();
        const miadYazi = ((hucre[k.miad] && hucre[k.miad].textContent) || '').trim();
        const stok = sayiOku(hucre[k.stok] && hucre[k.stok].textContent);
        const miad = tarihOku(miadYazi);
        const hastane = hastaneOku(hucre[k.hastane]);
        const btn0 = satir.querySelector(SEL_ISTEK);
        const bilgi = `${ilac} | ${butce} | stok ${stok} | miad ${miadYazi} | ${hastane}`;

        const atla = (neden) => {
            D.atlanan++;
            D.nedenler[neden] = (D.nedenler[neden] || 0) + 1;
            durumKaydet();
            logYaz('ATLA', `${neden} | ${bilgi}`);
            return 'atla';
        };

        if (!btn0 || btn0.disabled) return atla('buton yok');
        if (yurtdisiMi(butce)) return atla('yurtdışı bütçe');
        if (stok === null || !miad) return atla('veri okunamadı');

        const sinir = new Date(); sinir.setHours(0, 0, 0, 0);
        sinir.setDate(sinir.getDate() + A.gun);
        if (miad < sinir) return atla('miad yakın');

        if (A.hastaneTek && hastane && D.hastaneler.includes(hastane)) return atla('hastaneye zaten teklif atıldı');

        const miktar = teklifMiktari(stok);
        if (miktar < A.min) return atla(`miktar düşük (hesap: ${miktar})`);

        durumYaz(`Teklif: ${miktar} (stok ${stok}) açılıyor...`);

        // Sunucu bir önceki isteği işlerken popup açmaya çalışma
        if (!(await bosBekle(SUNUCU_BOS_MAX, 'satır öncesi'))) return durduruldu ? 'dur' : 'hata';

        // Popup'ı aç (açılmazsa temizleyip tekrar dene)
        let kutu = null;
        for (let d = 1; d <= POPUP_DENEME && !kutu; d++) {
            if (durduruldu) return 'dur';
            if (d > 1) {
                logYaz('HATA', `popup açılmadı, tekrar deneniyor (${d}/${POPUP_DENEME}) | ${bilgi}`);
                await popupTemizle();
                await bekle(3000 * d);
                if (!(await bosBekle(SUNUCU_BOS_MAX, 'popup tekrar'))) return durduruldu ? 'dur' : 'hata';
            }
            const p = sayfaBilgi();
            if (p.cur && D.sayfa && p.cur !== D.sayfa) {
                logYaz('HATA', `satır işlenirken sayfa değişti (${D.sayfa} -> ${p.cur}) | ${bilgi}`);
                return 'hata';
            }
            const s2 = document.getElementById(satirId) || satir;
            const btn = s2.querySelector(SEL_ISTEK);
            if (!btn || btn.disabled) { logYaz('HATA', `istek butonu bulunamadı | ${bilgi}`); return 'hata'; }
            s2.scrollIntoView({ block: 'center' });
            await bekle(100);
            btn.click();
            kutu = await bekleVeBul(() => gorunurAra(SEL_MIKTAR), POPUP_BEKLEME);
        }
        if (!kutu) {
            logYaz('HATA', `popup açılmadı (${POPUP_DENEME} deneme) | ${bilgi}`);
            durumYaz('Popup açılmadı, satır atlanıyor...');
            return 'hata';
        }
        await bekle(A.adimMs);

        miktarYaz(kutu, miktar);
        await bekle(A.adimMs);

        const kaydet = gorunurAra(SEL_KAYDET);
        if (!kaydet) {
            logYaz('HATA', `Kaydet butonu yok | ${bilgi}`);
            await popupTemizle();
            return 'hata';
        }
        const uyari0 = window.__otoAlertSayac || 0;
        kaydet.click();
        durumYaz(`Kaydediliyor (${miktar})...`);

        const sonuc = await basariBekle(uyari0, BASARI_MAX);
        if (sonuc.tur === 'dur') { await popupTemizle(); return 'dur'; }
        if (sonuc.tur === 'hata') {
            logYaz('HATA', `sunucu teklifi kabul etmedi: ${sonuc.metin.slice(0, 120)} | ${bilgi}`);
            await popupTemizle();
            return atla('sunucu reddetti');
        }
        if (sonuc.tur === 'zaman') {
            logYaz('UYARI', `onay mesajı ${BASARI_MAX / 1000} sn içinde görülmedi, teklif gitti sayıldı | ${bilgi}`);
        }

        if (hastane) D.hastaneler.push(hastane);
        D.teklif++;
        D.ardisikHata = 0;
        D.kurtarma = 0;
        durumKaydet();
        logYaz('TEKLİF', `miktar ${miktar}${sonuc.tur === 'ok' ? ` | onay ${sonuc.ms} ms` : ''} | ${bilgi}`);

        const x = await bekleVeBul(disKapatBul, 8000);
        if (!x) {
            logYaz('HATA', 'X bulunamadı, popup temizleniyor');
            await popupTemizle();
            return 'teklif';
        }
        x.click();

        await bekleVeBul(() => !gorunurAra(SEL_MIKTAR), POPUP_BEKLEME);
        await bekle(A.adimMs);
        return 'teklif';
    }

    // ---------- Geçiş bekleme: 'ok' | 'uyari' | 'bos' | 'zaman' | 'dur' ----------
    // İstek sunucuda sürdüğü sürece (yavaş da olsa) bekler; sadece cevap geldiği halde
    // sayfa değişmediyse, sunucu hata verdiyse ya da azami süre dolduysa pes eder.
    async function gecisBekle(kosul, bas, uyari0, etiket) {
        const limit = Math.max(A.gecisSn, 60) * 1000;
        while (true) {
            if (durduruldu) return 'dur';
            if (kosul()) return 'ok';
            if ((window.__otoAlertSayac || 0) > uyari0) return 'uyari';
            const gecen = Date.now() - bas;
            if (!sunucuMesgul() && gecen > 6000) return 'bos';
            if (gecen > limit) return 'zaman';
            durumYaz(`${etiket} bekleniyor... ${Math.round(gecen / 1000)}/${Math.round(limit / 1000)} sn`);
            await bekle(250);
        }
    }

    // ---------- Sonraki sayfa: 'ok' | 'son' | 'yok' | 'zaman' ----------
    async function sonrakiSayfa() {
        const pb = sayfaBilgi();
        if (!pb.cur) return 'yok';
        if (pb.toplam && pb.cur >= pb.toplam) return 'son';

        const onceki = pb.cur;
        const imza0 = satirImza();
        const degisti = () => { const p = sayfaBilgi(); return !!p.cur && p.cur !== onceki; };

        for (let deneme = 1; deneme <= A.deneme; deneme++) {
            if (durduruldu) return 'zaman';

            // Önceki denemeden kalan istek hâlâ sürüyorsa tekrar tıklama, bitmesini bekle
            if (!(await bosBekle(SUNUCU_BOS_MAX, 'sayfa geçişi'))) return 'zaman';

            const bas = Date.now();
            let sonuc;
            if (degisti()) {
                sonuc = 'ok'; // yavaş gelen önceki cevap sayfayı zaten değiştirmiş
            } else {
                const sonraki = document.querySelector(SEL_PAGER + ' a[id$="DXPagerBottom_PBN"]');
                if (!sonraki) return 'yok';
                const uyari0 = window.__otoAlertSayac || 0;
                if (deneme > 1) logYaz('SAYFA', `geçiş tekrar deneniyor (${deneme}/${A.deneme})`);
                sonraki.click();
                sonuc = await gecisBekle(degisti, bas, uyari0, `Sayfa geçişi (deneme ${deneme}/${A.deneme})`);
            }

            if (sonuc === 'dur') return 'zaman';
            if (sonuc === 'ok') {
                await bekleVeBul(() => satirImza() !== imza0, 15000);
                await bosBekle(120000, 'sayfa sonrası');
                await bekle(500);
                const sn = Math.round((Date.now() - bas) / 1000);
                logYaz('SAYFA', `${onceki} -> ${sayfaBilgi().cur} geçildi (${sn} sn)`);
                D.kurtarma = 0;
                durumKaydet();
                return 'ok';
            }

            const sn = Math.round((Date.now() - bas) / 1000);
            const neden = sonuc === 'uyari'
                ? `sunucu hata verdi: ${String(window.__otoSonAlert || '').slice(0, 120)}`
                : (sonuc === 'bos' ? 'cevap geldi ama sayfa değişmedi' : 'süre doldu');
            logYaz('HATA', `sayfa geçişi başarısız (${neden}, ${sn} sn), deneme ${deneme}/${A.deneme}`);

            if (deneme < A.deneme) {
                durumYaz(`Geçiş başarısız, ${TEKRAR_BEKLEME / 1000} sn sonra tekrar denenecek...`);
                await bekleVeBul(() => false, TEKRAR_BEKLEME);
            }
        }
        return 'zaman';
    }

    // ---------- Belirli sayfaya doğrudan git (yenileme sonrası) ----------
    async function hedefeGit(hedef) {
        const g = gridNesne();
        if (!g) { logYaz('HATA', 'grid nesnesi bulunamadı, ilk sayfadan devam edilecek'); return false; }
        const uyari0 = window.__otoAlertSayac || 0;
        const bas = Date.now();
        logYaz('SAYFA', `${hedef}. sayfaya doğrudan gidiliyor`);
        try { g.GotoPage(hedef - 1); } catch (e) { logYaz('HATA', 'GotoPage hatası: ' + (e && e.message)); return false; }
        const s = await gecisBekle(() => sayfaBilgi().cur === hedef, bas, uyari0, 'Hedef sayfa');
        if (s === 'ok') {
            await bosBekle(120000, 'hedef sayfa');
            await bekle(500);
            logYaz('SAYFA', `${hedef}. sayfaya gidildi (${Math.round((Date.now() - bas) / 1000)} sn)`);
            return true;
        }
        logYaz('HATA', `hedef sayfaya gidilemedi (${s}), ilk sayfadan devam edilecek`);
        return false;
    }

    // ---------- Toparlanma: sayfayı yenile, kaldığı sayfaya dön, devam et ----------
    async function kurtar(neden) {
        D.kurtarma = (D.kurtarma || 0) + 1;
        if (D.kurtarma > KURTARMA_MAX) return false;
        D.hedef = D.sayfa;
        D.run = true;
        durumKaydet();
        logYaz('KURTAR', `${neden} | ${KURTAR_BEKLEME / 1000} sn sonra sayfa yenilenecek (${D.kurtarma}/${KURTARMA_MAX}), hedef sayfa ${D.hedef}`);
        const bas = Date.now();
        while (Date.now() - bas < KURTAR_BEKLEME) {
            if (durduruldu) return false;
            durumYaz(`Toparlanma: ${Math.round((KURTAR_BEKLEME - (Date.now() - bas)) / 1000)} sn sonra sayfa yenilenecek`);
            await bekle(500);
        }
        try { localStorage.setItem(LOG_KEY, JSON.stringify(L)); } catch (e) {}
        location.reload();
        await bekle(120000);
        return true;
    }

    // ---------- Ana döngü ----------
    async function calistir() {
        if (calisiyor) return;
        calisiyor = true;
        durduruldu = false;
        D.run = true;
        durumKaydet();
        let bitisMesaji = '';
        let yenileniyor = false;

        const kurtarDene = async (neden) => {
            const r = await kurtar(neden);
            if (r) yenileniyor = true;
            else if (!durduruldu) bitisMesaji = `Toparlanma hakkı bitti: ${neden}`;
            durduruldu = true;
        };

        try {
            // Yenileme sonrası kaldığı sayfaya dön
            if (D.hedef) {
                const hedef = D.hedef;
                D.hedef = null;
                durumKaydet();
                const cur = sayfaBilgi().cur;
                if (cur && cur < hedef) await hedefeGit(hedef);
            }

            dis: while (!durduruldu) {
                if (!(await bosBekle(SUNUCU_BOS_MAX, 'sayfa başı'))) {
                    if (!durduruldu) await kurtarDene('sunucu yanıt vermiyor');
                    break;
                }
                const pb = sayfaBilgi();
                if (D.sayfa !== pb.cur) { D.sayfa = pb.cur; D.done = []; durumKaydet(); }
                logYaz('SAYFA', `${D.sayfa}. sayfa işleniyor`);

                const k = kolonlar();
                let satir;
                while (!durduruldu && (satir = sonrakiSatir())) {
                    const p = sayfaBilgi();
                    if (p.cur && D.sayfa && p.cur !== D.sayfa) {
                        logYaz('SAYFA', `işlem sırasında sayfa değişti (${D.sayfa} -> ${p.cur}), yeniden okunuyor`);
                        continue dis;
                    }
                    const s = await satirIsle(satir, k);
                    durumYaz(`Sayfa ${D.sayfa} | Teklif: ${D.teklif} | Atlanan: ${D.atlanan}`);
                    if (s === 'dur') break;
                    if (s === 'hata') {
                        D.ardisikHata = (D.ardisikHata || 0) + 1;
                        durumKaydet();
                        await popupTemizle();
                        if (D.ardisikHata >= ARDISIK_HATA_LIMIT) {
                            D.ardisikHata = 0;
                            durumKaydet();
                            await kurtarDene(`${ARDISIK_HATA_LIMIT} satır üst üste hata verdi`);
                            break;
                        }
                        await bekle(2000);
                        continue;
                    }
                    if (s === 'teklif' && D.teklif >= A.maxTeklif) { bitisMesaji = 'Teklif limiti doldu.'; durduruldu = true; break; }
                    if (s === 'atla') await bekle(5);
                }
                if (durduruldu) break;

                if (D.sayfaSayac >= A.maxSayfa) { bitisMesaji = 'Sayfa limiti doldu.'; break; }
                durumYaz(`Sayfa ${D.sayfa} bitti, sonrakine geçiliyor...`);
                const g = await sonrakiSayfa();
                if (durduruldu) break;
                if (g === 'son') { bitisMesaji = 'Son sayfaya gelindi.'; break; }
                if (g === 'yok') { bitisMesaji = 'Sonraki sayfa butonu bulunamadı.'; break; }
                if (g === 'zaman') { await kurtarDene(`sayfa geçişi ${A.deneme} denemede olmadı`); break; }
                D.sayfaSayac++;
                durumKaydet();
            }
        } catch (e) {
            console.error('[Oto] hata', e);
            logYaz('HATA', 'beklenmeyen hata: ' + (e && e.message));
            if (!durduruldu) await kurtarDene('beklenmeyen hata: ' + (e && e.message));
        }

        if (yenileniyor) { calisiyor = false; return; }

        D.run = false;
        durumKaydet();
        calisiyor = false;
        if (durduruldu && !bitisMesaji) bitisMesaji = 'Durduruldu.';
        const nedenler = Object.entries(D.nedenler).map(([n, c]) => `${n}: ${c}`).join(', ') || '-';
        logYaz('BİTİŞ', `${bitisMesaji} | Teklif ${D.teklif}, Atlanan ${D.atlanan}`);
        logYaz('ÖZET', `Atlama nedenleri -> ${nedenler}`);
        if (bitisMesaji) durumYaz(`${bitisMesaji} Teklif: ${D.teklif}, Atlanan: ${D.atlanan}`);
    }

    // ---------- Arayüz ----------
    let durumEl, miniEl;
    function durumYaz(t) { if (durumEl) durumEl.textContent = t; if (miniEl) miniEl.textContent = t; }

    const KAPALI_KEY = 'oto_stok_kapali';
    let kapali = false;
    try { kapali = localStorage.getItem(KAPALI_KEY) === '1'; } catch (e) {}

    const stil = document.createElement('style');
    stil.textContent = `
        #otoPanel,#otoLogPanel{position:fixed;top:10px;z-index:999999;background:#16181d;color:#e8eaf0;border-radius:12px;
            font:12px/1.4 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);width:272px;max-height:96vh;overflow:auto}
        #otoPanel{right:10px}
        #otoPanel *,#otoLogPanel *{box-sizing:border-box}
        .oto-bas{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:pointer;user-select:none}
        .oto-bas b{font-size:13px;font-weight:600;white-space:nowrap}
        .oto-ok{color:#8e97a8;display:inline-block;width:10px}
        .oto-mini{flex:1;min-width:0;display:none;text-align:right;color:#8e97a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .oto-bos{flex:1}
        .oto-gov{padding:0 14px 12px}
        .oto-sat{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
        .oto-in{width:70px;height:24px;border:1px solid #3a3f4b;border-radius:6px;background:#0f1115;color:#e8eaf0;padding:0 6px;font:inherit;text-align:right;outline:none}
        .oto-in:focus{border-color:#3b5bfd}
        .oto-btn{height:30px;padding:0 12px;border:0;border-radius:8px;font:inherit;cursor:pointer;background:#2b2f38;color:#e8eaf0}
        .oto-btn:hover{background:#363b46}
        .oto-p{background:#3b5bfd;color:#fff;font-weight:600}
        .oto-p:hover{background:#2f49d1}
        .oto-r{background:#e5484d;color:#fff;font-weight:600}
        .oto-r:hover{background:#cf3a3f}
        .oto-k{height:24px;padding:0 8px}
        .oto-deep{background:#1d2027;border-radius:8px;padding:8px;margin:6px 0 4px;display:none}
        .oto-chk{display:flex;gap:6px;align-items:center;margin:8px 0 10px;cursor:pointer}
        .oto-chk input{accent-color:#3b5bfd}
        .oto-btns{display:flex;gap:6px;flex-wrap:wrap}
        .oto-durum{margin-top:10px;color:#8e97a8}
        .oto-dur2{display:none}
        #otoPanel.oto-kapali .oto-gov,#otoPanel.oto-kapali .oto-ayarbtn{display:none}
        #otoPanel.oto-kapali .oto-mini{display:block}
        #otoPanel.oto-kapali .oto-bos{display:none}
        #otoPanel.oto-kapali .oto-dur2{display:inline-block}
        #otoLogPanel{display:none;padding:12px 14px}
        #oLogKutu{height:230px;overflow-y:auto;font-family:Consolas,monospace;font-size:11px;background:#0f1115;border:1px solid #2b2f38;border-radius:8px;padding:6px;margin:8px 0}
    `;
    document.head.appendChild(stil);

    const alan = (id, etiket, deger) =>
        `<div class="oto-sat"><span>${etiket}</span><input id="${id}" class="oto-in" type="number" value="${deger}"></div>`;

    const panel = document.createElement('div');
    panel.id = 'otoPanel';
    if (kapali) panel.classList.add('oto-kapali');
    panel.innerHTML = `
        <div class="oto-bas" id="oBaslik" title="Stok Otomasyon v4.8 - küçült / büyüt">
            <span class="oto-ok" id="oOk">${kapali ? '▸' : '▾'}</span><b>Stok Otomasyon</b>
            <span class="oto-bos"></span>
            <span class="oto-mini" id="oMini"></span>
            <button id="oDur2" class="oto-btn oto-r oto-k oto-dur2" type="button">Durdur</button>
            <button id="oAyarBtn" class="oto-btn oto-k oto-ayarbtn" type="button">Ayarlar ▾</button>
        </div>
        <div class="oto-gov">
            ${alan('oYuzde', 'Max yüzde (%)', A.yuzde)}
            ${alan('oMin', 'Min teklif', A.min)}
            ${alan('oMax', 'Max teklif', A.max)}
            ${alan('oAdim', 'Yuvarlama adımı', A.adim)}
            ${alan('oGun', 'Miad en az (gün)', A.gun)}
            <div class="oto-deep" id="oDeep">
                ${alan('oMaxTeklif', 'Toplam teklif sınırı', A.maxTeklif)}
                ${alan('oMaxSayfa', 'Sayfa sınırı', A.maxSayfa)}
                ${alan('oAdimMs', 'Adım bekleme (ms)', A.adimMs)}
                ${alan('oGecis', 'Sayfa geçiş azami bekleme (sn)', A.gecisSn)}
                ${alan('oDeneme', 'Sayfa geçiş deneme sayısı', A.deneme)}
            </div>
            <label class="oto-chk"><input id="oHastane" type="checkbox" ${A.hastaneTek ? 'checked' : ''}> Aynı hastaneye tekrar atma</label>
            <div class="oto-btns">
                <button id="oBasla" class="oto-btn oto-p" type="button">Başlat</button>
                <button id="oDur" class="oto-btn oto-r" type="button">Durdur</button>
                <button id="oSifir" class="oto-btn" type="button">Sıfırla</button>
                <button id="oLog" class="oto-btn" type="button">Log</button>
            </div>
            <div id="oDurum" class="oto-durum"></div>
        </div>`;
    document.body.appendChild(panel);
    durumEl = panel.querySelector('#oDurum');
    miniEl = panel.querySelector('#oMini');
    durumYaz(D.hastaneler.length ? `Hazır. Teklif atılan hastane: ${D.hastaneler.length}` : 'Hazır.');

    // Başlık çubuğuna tıklayınca küçül / büyüt
    panel.querySelector('#oBaslik').onclick = () => {
        kapali = !kapali;
        panel.classList.toggle('oto-kapali', kapali);
        panel.querySelector('#oOk').textContent = kapali ? '▸' : '▾';
        try { localStorage.setItem(KAPALI_KEY, kapali ? '1' : '0'); } catch (e) {}
    };
    // Gelişmiş ayarlar (toplam teklif, sayfa sınırı, bekleme süreleri) aç / kapat
    panel.querySelector('#oAyarBtn').onclick = (e) => {
        e.stopPropagation();
        const d = panel.querySelector('#oDeep');
        const ac = d.style.display !== 'block';
        d.style.display = ac ? 'block' : 'none';
        e.target.textContent = ac ? 'Ayarlar ▴' : 'Ayarlar ▾';
    };
    // Küçültülmüşken Durdur (asıl Durdur düğmesini tetikler)
    panel.querySelector('#oDur2').onclick = (e) => { e.stopPropagation(); panel.querySelector('#oDur').click(); };

    // Log paneli (ana panelin solunda)
    const logPanel = document.createElement('div');
    logPanel.id = 'otoLogPanel';
    logPanel.innerHTML = `
        <div style="font-weight:600;font-size:13px;">Log (son ${LOG_GOSTER})</div>
        <div id="oLogKutu"></div>
        <div class="oto-btns" style="align-items:center">
            <button id="oLogIndir" class="oto-btn" type="button">TXT indir</button>
            <button id="oLogKapat" class="oto-btn" type="button">Kapat</button>
            <span id="oLogSay" style="color:#8e97a8"></span>
        </div>`;
    document.body.appendChild(logPanel);
    logKutu = logPanel.querySelector('#oLogKutu');

    function logAcKapat(ac) {
        logAcik = ac;
        if (ac) {
            logPanel.style.right = (panel.offsetWidth + 18) + 'px';
            logPanel.style.display = 'block';
            logCiz();
        } else {
            logPanel.style.display = 'none';
        }
    }
    setInterval(() => {
        if (logAcik) logPanel.querySelector('#oLogSay').textContent = `${L.length} kayıt`;
    }, 1000);

    panel.querySelector('#oLog').onclick = () => logAcKapat(!logAcik);
    logPanel.querySelector('#oLogKapat').onclick = () => logAcKapat(false);
    logPanel.querySelector('#oLogIndir').onclick = logIndir;

    const al = (id, varsayilan) => {
        const v = parseFloat(panel.querySelector('#' + id).value);
        return v > 0 ? v : varsayilan;
    };

    panel.querySelector('#oBasla').onclick = () => {
        // Çalışırken Başlat'a basmak ayarları/sayaçları bozuyordu
        if (calisiyor) {
            durumYaz(durduruldu ? 'Önceki tur bitiyor, 1-2 sn sonra tekrar bas.' : 'Zaten çalışıyor. Önce Durdur.');
            return;
        }
        A.yuzde = al('oYuzde', A.yuzde);
        A.min = al('oMin', A.min);
        A.max = al('oMax', A.max);
        A.adim = al('oAdim', A.adim);
        A.gun = al('oGun', A.gun);
        A.maxTeklif = al('oMaxTeklif', A.maxTeklif);
        A.maxSayfa = al('oMaxSayfa', A.maxSayfa);
        A.gecisSn = al('oGecis', A.gecisSn);
        A.adimMs = Math.max(50, Math.round(al('oAdimMs', A.adimMs)));
        A.deneme = Math.max(1, Math.round(al('oDeneme', A.deneme)));
        A.hastaneTek = panel.querySelector('#oHastane').checked;
        try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {}

        const pb = sayfaBilgi();
        D.sayfa = pb.cur; D.done = []; D.teklif = 0; D.atlanan = 0; D.sayfaSayac = 1; D.nedenler = {};
        D.hedef = null; D.ardisikHata = 0; D.kurtarma = 0;
        durumKaydet();

        // Yeni çalıştırma: eski log silinir
        L = [];
        const t = new Date();
        logYaz('BAŞLA', `v4.8 | ${t.toLocaleDateString('tr-TR')} | yüzde ${A.yuzde}, min ${A.min}, max ${A.max}, adım ${A.adim}, miad ${A.gun} gün, teklif sınırı ${A.maxTeklif}, sayfa sınırı ${A.maxSayfa}, adım bekleme ${A.adimMs} ms, geçiş azami bekleme ${A.gecisSn} sn x ${A.deneme} deneme, aynı hastane engeli ${A.hastaneTek ? 'açık' : 'kapalı'}`);
        calistir();
    };
    panel.querySelector('#oDur').onclick = () => {
        durduruldu = true; D.run = false; D.hedef = null; durumKaydet(); durumYaz('Durduruldu.');
    };
    panel.querySelector('#oSifir').onclick = () => {
        durduruldu = true; D = D0();
        durumKaydet(); durumYaz('Sıfırlandı (hastane listesi dahil).');
        logYaz('SIFIRLA', 'hastane listesi ve sayaçlar sıfırlandı');
    };

    window.addEventListener('pagehide', () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(L)); } catch (e) {} });

    // Sayfa yenilenirse yarıda kalan işe devam et (log silinmez, devam eder)
    if (D.run) setTimeout(() => {
        durumYaz('Yenilendi, devam ediliyor...');
        logYaz('DEVAM', 'sayfa yenilendi, kaldığı yerden devam');
        calistir();
    }, 3000);
})();
