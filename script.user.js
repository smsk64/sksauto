// ==UserScript==
// @name         Stok Koordinasyon Otomasyonu v4.5
// @namespace    stok-oto
// @version      4.5
// @description  Akıllı teklif: miad + miktar + hastane + yurtdışı bütçe kontrolü, otomatik sayfa geçişi (hata olursa tekrar dener), log paneli
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============ SABİTLER ============
    const ADIM_BEKLEME = 800;
    const POPUP_BEKLEME = 8000;
    const KAYDET_SONRASI = 3500;
    const TEKRAR_BEKLEME = 15000; // sayfa geçişi başarısız olursa tekrar denemeden önce bekleme
    const LOG_MAX = 5000;      // saklanacak en fazla kayıt
    const LOG_GOSTER = 30;     // panelde görünen kayıt sayısı
    // ==================================

    const SEL_SATIR  = 'tr[id*="ASPxGridViewStokFazlasi_DXDataRow"]';
    const SEL_ISTEK  = 'input[id$="ASPxButtonIstekGonder_I"]';
    const SEL_MIKTAR = '#ucTalepciIstekGonder1_ASPxTextBoxTalepMiktari_I';
    const SEL_KAYDET = '#ucTalepciIstekGonder1_ASPxButtonKaydet_I';
    const SEL_KAPAT  = 'img.dxWeb_pcCloseButton_Glass';
    const SEL_PAGER  = 'div[id$="ASPxGridViewStokFazlasi_DXPagerBottom"]';

    if (window.top !== window.self) return;
    if (!document.querySelector('[id*="ASPxGridViewStokFazlasi"]')) return;

    // ---------- Ayarlar (tarayıcıda hatırlanır) ----------
    const AYAR_KEY = 'oto_ayar_v4';
    const DURUM_KEY = 'oto_durum_v42';
    const LOG_KEY = 'oto_log_v43';
    let A = { yuzde: 50, min: 10, max: 50, adim: 5, gun: 180, maxTeklif: 3, maxSayfa: 1, gecisSn: 60, deneme: 3, hastaneTek: true };
    try { Object.assign(A, JSON.parse(localStorage.getItem(AYAR_KEY) || '{}')); } catch (e) {}

    // ---------- Durum (sayfa yenilense de kaybolmaz) ----------
    let D = { run: false, sayfa: null, done: [], hastaneler: [], teklif: 0, atlanan: 0, sayfaSayac: 0, nedenler: {} };
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
                d.style.cssText = 'padding:2px 0;border-bottom:1px solid #eee;word-break:break-word;';
                if (s.includes('| TEKLİF |')) d.style.color = '#0a7a2f';
                else if (s.includes('| HATA |')) d.style.color = '#c00';
                else if (s.includes('| ATLA |')) d.style.color = '#888';
                else d.style.color = '#222';
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
            await bekle(150);
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

    // ---------- Tek satır ----------
    async function satirIsle(satir, k) {
        D.done.push(satir.id);
        durumKaydet();

        const hucre = satir.children;
        const ilac = ((hucre[k.ilac] && hucre[k.ilac].textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const butce = ((hucre[k.butce] && hucre[k.butce].textContent) || '').replace(/\s+/g, ' ').trim();
        const miadYazi = ((hucre[k.miad] && hucre[k.miad].textContent) || '').trim();
        const stok = sayiOku(hucre[k.stok] && hucre[k.stok].textContent);
        const miad = tarihOku(miadYazi);
        const hastane = hastaneOku(hucre[k.hastane]);
        const btn = satir.querySelector(SEL_ISTEK);
        const bilgi = `${ilac} | ${butce} | stok ${stok} | miad ${miadYazi} | ${hastane}`;

        const atla = (neden) => {
            D.atlanan++;
            D.nedenler[neden] = (D.nedenler[neden] || 0) + 1;
            durumKaydet();
            logYaz('ATLA', `${neden} | ${bilgi}`);
            return 'atla';
        };

        if (!btn || btn.disabled) return atla('buton yok');
        if (yurtdisiMi(butce)) return atla('yurtdışı bütçe');
        if (stok === null || !miad) return atla('veri okunamadı');

        const sinir = new Date(); sinir.setHours(0, 0, 0, 0);
        sinir.setDate(sinir.getDate() + A.gun);
        if (miad < sinir) return atla('miad yakın');

        if (A.hastaneTek && hastane && D.hastaneler.includes(hastane)) return atla('hastaneye zaten teklif atıldı');

        const miktar = teklifMiktari(stok);
        if (miktar < A.min) return atla(`miktar düşük (hesap: ${miktar})`);

        durumYaz(`Teklif: ${miktar} (stok ${stok}) açılıyor...`);
        satir.scrollIntoView({ block: 'center' });
        await bekle(400);
        btn.click();

        const kutu = await bekleVeBul(() => gorunurAra(SEL_MIKTAR), POPUP_BEKLEME);
        if (!kutu) { logYaz('HATA', `popup açılmadı | ${bilgi}`); durumYaz('Popup açılmadı. Durdu.'); return 'hata'; }
        await bekle(ADIM_BEKLEME);

        miktarYaz(kutu, miktar);
        await bekle(ADIM_BEKLEME);

        const kaydet = gorunurAra(SEL_KAYDET);
        if (!kaydet) { logYaz('HATA', `Kaydet butonu yok | ${bilgi}`); durumYaz('Kaydet butonu yok. Durdu.'); return 'hata'; }
        kaydet.click();

        if (hastane) D.hastaneler.push(hastane);
        D.teklif++;
        durumKaydet();
        logYaz('TEKLİF', `miktar ${miktar} | ${bilgi}`);
        durumYaz(`Kaydediliyor (${miktar})...`);
        await bekle(KAYDET_SONRASI);

        const x = disKapatBul();
        if (!x) { logYaz('HATA', 'X bulunamadı'); durumYaz('X bulunamadı. Durdu.'); return 'hata'; }
        x.click();

        await bekleVeBul(() => !gorunurAra(SEL_MIKTAR), POPUP_BEKLEME);
        await bekle(ADIM_BEKLEME);
        return 'teklif';
    }

    // ---------- Sonraki sayfa: 'ok' | 'son' | 'yok' | 'zaman' ----------
    // Sunucu hata verirse (uyarı çıkarsa) veya süre dolarsa, A.deneme kadar tekrar dener
    async function sonrakiSayfa() {
        const pb = sayfaBilgi();
        if (!pb.cur) return 'yok';
        if (pb.toplam && pb.cur >= pb.toplam) return 'son';

        const onceki = pb.cur;
        const imza0 = satirImza();
        const degisti = () => { const p = sayfaBilgi(); return !!p.cur && p.cur !== onceki; };

        for (let deneme = 1; deneme <= A.deneme; deneme++) {
            if (durduruldu) return 'zaman';
            const sonraki = document.querySelector(SEL_PAGER + ' a[id$="DXPagerBottom_PBN"]');
            if (!sonraki) return degisti() ? 'ok' : 'yok';

            const bas = Date.now();
            const limit = A.gecisSn * 1000;
            const uyari0 = window.__otoAlertSayac || 0;
            const uyariGeldi = () => (window.__otoAlertSayac || 0) > uyari0;

            if (deneme > 1) logYaz('SAYFA', `geçiş tekrar deneniyor (${deneme}/${A.deneme})`);
            sonraki.click();

            await bekleVeBul(() => {
                const sn = Math.round((Date.now() - bas) / 1000);
                durumYaz(`Sayfa geçişi bekleniyor... ${sn}/${A.gecisSn} sn (deneme ${deneme}/${A.deneme})`);
                return degisti() || uyariGeldi();
            }, limit);

            if (degisti()) {
                await bekleVeBul(() => satirImza() !== imza0, 15000);
                await bekle(1500);
                const sn = Math.round((Date.now() - bas) / 1000);
                logYaz('SAYFA', `${onceki} -> ${sayfaBilgi().cur} geçildi (${sn} sn)`);
                return 'ok';
            }

            if (durduruldu) return 'zaman';
            const sn = Math.round((Date.now() - bas) / 1000);
            const neden = uyariGeldi()
                ? `sunucu hata verdi: ${String(window.__otoSonAlert || '').slice(0, 120)}`
                : 'süre doldu';
            logYaz('HATA', `sayfa geçişi başarısız (${neden}, ${sn} sn), deneme ${deneme}/${A.deneme}`);

            if (deneme < A.deneme) {
                durumYaz(`Geçiş başarısız, ${TEKRAR_BEKLEME / 1000} sn sonra tekrar denenecek...`);
                await bekle(TEKRAR_BEKLEME);
            }
        }
        return 'zaman';
    }

    // ---------- Ana döngü ----------
    async function calistir() {
        if (calisiyor) return;
        calisiyor = true;
        durduruldu = false;
        D.run = true;
        durumKaydet();
        let bitisMesaji = '';

        try {
            while (!durduruldu) {
                const pb = sayfaBilgi();
                if (D.sayfa !== pb.cur) { D.sayfa = pb.cur; D.done = []; durumKaydet(); }
                logYaz('SAYFA', `${D.sayfa}. sayfa işleniyor`);

                const k = kolonlar();
                let satir;
                while (!durduruldu && (satir = sonrakiSatir())) {
                    const s = await satirIsle(satir, k);
                    durumYaz(`Sayfa ${D.sayfa} | Teklif: ${D.teklif} | Atlanan: ${D.atlanan}`);
                    if (s === 'hata') { bitisMesaji = 'Hata ile durdu.'; durduruldu = true; break; }
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
                if (g === 'zaman') { bitisMesaji = `Sayfa geçişi ${A.deneme} denemede de olmadı (sunucu yanıt vermedi/hata verdi).`; break; }
                D.sayfaSayac++;
                durumKaydet();
            }
        } catch (e) {
            console.error('[Oto] hata', e);
            logYaz('HATA', 'beklenmeyen hata: ' + (e && e.message));
            bitisMesaji = 'Beklenmeyen hata, konsola bak.';
        }

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
    let durumEl;
    function durumYaz(t) { if (durumEl) durumEl.textContent = t; }

    const alan = (id, etiket, deger) =>
        `<div style="display:flex;justify-content:space-between;margin-bottom:3px;">
            <span>${etiket}</span><input id="${id}" type="number" value="${deger}" style="width:60px"></div>`;

    const panel = document.createElement('div');
    panel.style.cssText = `position:fixed;top:10px;right:10px;z-index:999999;background:#fff;
        border:2px solid #333;padding:10px;border-radius:8px;font-family:sans-serif;
        font-size:12px;box-shadow:0 2px 10px rgba(0,0,0,.3);width:250px`;
    panel.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;">Stok Otomasyon v4.5</div>
        ${alan('oYuzde', 'Max yüzde (%)', A.yuzde)}
        ${alan('oMin', 'Min teklif', A.min)}
        ${alan('oMax', 'Max teklif', A.max)}
        ${alan('oAdim', 'Yuvarlama adımı', A.adim)}
        ${alan('oGun', 'Miad en az (gün)', A.gun)}
        ${alan('oMaxTeklif', 'Toplam teklif sınırı', A.maxTeklif)}
        ${alan('oMaxSayfa', 'Sayfa sınırı', A.maxSayfa)}
        ${alan('oGecis', 'Sayfa geçiş bekleme (sn)', A.gecisSn)}
        ${alan('oDeneme', 'Sayfa geçiş deneme sayısı', A.deneme)}
        <label style="display:block;margin:4px 0 6px;">
            <input id="oHastane" type="checkbox" ${A.hastaneTek ? 'checked' : ''}> Aynı hastaneye tekrar atma</label>
        <button id="oBasla" type="button" style="padding:4px 6px;">Başlat</button>
        <button id="oDur" type="button" style="padding:4px 6px;">Durdur</button>
        <button id="oSifir" type="button" style="padding:4px 6px;">Sıfırla</button>
        <button id="oLog" type="button" style="padding:4px 6px;">Log</button>
        <div id="oDurum" style="margin-top:6px;color:#666;"></div>`;
    document.body.appendChild(panel);
    durumEl = panel.querySelector('#oDurum');
    durumYaz(D.hastaneler.length ? `Hazır. Teklif atılan hastane: ${D.hastaneler.length}` : 'Hazır.');

    // Log paneli (ana panelin solunda)
    const logPanel = document.createElement('div');
    logPanel.style.cssText = `position:fixed;top:10px;z-index:999999;background:#fff;display:none;
        border:2px solid #333;padding:10px;border-radius:8px;font-family:sans-serif;
        font-size:12px;box-shadow:0 2px 10px rgba(0,0,0,.3);width:250px`;
    logPanel.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;">Log (son ${LOG_GOSTER})</div>
        <div id="oLogKutu" style="height:230px;overflow-y:auto;font-family:monospace;font-size:11px;
            border:1px solid #ccc;padding:4px;margin-bottom:6px;"></div>
        <button id="oLogIndir" type="button" style="padding:4px 6px;">TXT indir</button>
        <button id="oLogKapat" type="button" style="padding:4px 6px;">Kapat</button>
        <span id="oLogSay" style="color:#666;margin-left:4px;"></span>`;
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
        A.deneme = Math.max(1, Math.round(al('oDeneme', A.deneme)));
        A.hastaneTek = panel.querySelector('#oHastane').checked;
        try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {}

        const pb = sayfaBilgi();
        D.sayfa = pb.cur; D.done = []; D.teklif = 0; D.atlanan = 0; D.sayfaSayac = 1; D.nedenler = {};
        durumKaydet();

        // Yeni çalıştırma: eski log silinir
        L = [];
        const t = new Date();
        logYaz('BAŞLA', `${t.toLocaleDateString('tr-TR')} | yüzde ${A.yuzde}, min ${A.min}, max ${A.max}, adım ${A.adim}, miad ${A.gun} gün, teklif sınırı ${A.maxTeklif}, sayfa sınırı ${A.maxSayfa}, geçiş bekleme ${A.gecisSn} sn x ${A.deneme} deneme, aynı hastane engeli ${A.hastaneTek ? 'açık' : 'kapalı'}`);
        calistir();
    };
    panel.querySelector('#oDur').onclick = () => {
        durduruldu = true; D.run = false; durumKaydet(); durumYaz('Durduruldu.');
    };
    panel.querySelector('#oSifir').onclick = () => {
        durduruldu = true; D = { run: false, sayfa: null, done: [], hastaneler: [], teklif: 0, atlanan: 0, sayfaSayac: 0, nedenler: {} };
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
