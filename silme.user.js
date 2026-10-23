// Teklif silme otomasyonu - MalzemeyeGore.aspx (ASPxGridViewTalepDetay)
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (!document.body || !document.querySelector('[id*="ASPxGridViewTalepDetay"]')) return;

    const SEL_SIL = 'input[id*="ASPxGridViewTalepDetay"][id$="_ASPxButtonSil_I"]';
    const SEL_SATIR = 'tr[id*="ASPxGridViewTalepDetay_DXDataRow"]';
    const KEY = 'oto_sil_durum_v1';
    const AYAR_KEY = 'oto_sil_ayar_v1';
    const BEKLEME_MAX = 120000;   // bir silme için azami bekleme
    const ARDISIK_LIMIT = 3;      // üst üste bu kadar silme sonuçsuz kalırsa dur

    let A = { toplu: false };
    try { Object.assign(A, JSON.parse(localStorage.getItem(AYAR_KEY) || '{}')); } catch (e) {}
    let D = { run: false, silinen: 0, filtre: '', ardisik: 0 };
    try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) Object.assign(D, s); } catch (e) {}
    const durumKaydet = () => { try { sessionStorage.setItem(KEY, JSON.stringify(D)); } catch (e) {} };

    let dur = false;
    let calisiyor = false;
    let mod = 'bos';           // bos | onay | calisiyor
    const logSatir = [];
    const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- confirm() kutusunu otomatik onayla (sadece çalışırken) ----
    const asilConfirm = window.confirm;
    function confirmAc() {
        window.confirm = function (m) {
            logYaz('ONAY', String(m || '').slice(0, 80));
            return true;
        };
    }
    function confirmKapat() { window.confirm = asilConfirm; }

    // ---- sayfa okuma ----
    function butonlar() {
        return [...document.querySelectorAll(SEL_SIL)].filter((b) => b.isConnected && !b.disabled);
    }
    function satirAdi(b) {
        const tr = b.closest('tr');
        return tr ? (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70) : '?';
    }
    function imza() {
        const bt = butonlar();
        return bt.length + '|' + bt.map((b) => satirAdi(b)).join('||');
    }
    // Seçili filtre (Giden / Kabul / Red) değişirse güvenlik için dur
    function filtreImza() {
        const a = [...document.querySelectorAll('input[type=radio]')].filter((r) => r.checked).map((r) => r.id || r.value);
        const b = [...document.querySelectorAll('[class*="RadioButtonChecked"]')].map((e) => e.id || e.className);
        return a.concat(b).join(',');
    }
    function filtreMetni() {
        const r = [...document.querySelectorAll('input[type=radio]')].find((x) => x.checked);
        if (!r) return '';
        const l = (r.id && document.querySelector('label[for="' + r.id + '"]')) || r.closest('label');
        const t = l ? l.textContent : (r.nextSibling && r.nextSibling.textContent) || '';
        return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    }

    async function degisimBekle(imza0, ms) {
        const bas = Date.now();
        while (Date.now() - bas < ms) {
            if (dur) return 'dur';
            if (imza() !== imza0) return 'ok';
            await bekle(300);
        }
        return 'zaman';
    }
    async function sakinBekle(sakinMs, maxMs) {
        const bas = Date.now();
        let son = imza(), sonDeg = Date.now();
        while (Date.now() - bas < maxMs) {
            if (dur) return;
            const s = imza();
            if (s !== son) { son = s; sonDeg = Date.now(); }
            if (Date.now() - sonDeg >= sakinMs) return;
            await bekle(300);
        }
    }

    // ---- log ----
    function logYaz(tur, m) {
        const s = `${new Date().toLocaleTimeString('tr-TR')} | ${tur} | ${m}`;
        logSatir.push(s);
        if (logSatir.length > 6) logSatir.shift();
        try { console.log('[Oto] ' + s); } catch (e) {}
        ciz();
    }

    // ---- ana döngü ----
    async function dongu() {
        if (calisiyor) return;
        calisiyor = true;
        dur = false;
        mod = 'calisiyor';
        confirmAc();
        ciz();
        let mesaj = '';
        try {
            while (!dur) {
                if (filtreImza() !== D.filtre) { mesaj = 'Filtre değişti, güvenlik için durdu.'; break; }
                const bt = butonlar();
                if (!bt.length) { mesaj = 'Silinecek teklif kalmadı.'; break; }
                const imza0 = imza();
                const say0 = bt.length;
                let sonuc;

                if (A.toplu) {
                    logYaz('SİL', `toplu: ${say0} satıra tıklanıyor`);
                    for (const b of bt) {
                        if (dur) break;
                        if (!b.isConnected) continue;
                        D.silinen++; durumKaydet();
                        b.click();
                        await bekle(350);
                    }
                    sonuc = await degisimBekle(imza0, BEKLEME_MAX);
                    if (sonuc === 'ok') await sakinBekle(8000, 180000);
                } else {
                    logYaz('SİL', `${say0} kaldı | ${satirAdi(bt[0])}`);
                    bt[0].scrollIntoView({ block: 'center' });
                    await bekle(200);
                    const uyari0 = window.__otoAlertSayac || 0;
                    D.silinen++; durumKaydet();
                    bt[0].click();
                    sonuc = await degisimBekle(imza0, BEKLEME_MAX);
                    if (sonuc === 'ok') await bekle(800);
                    if ((window.__otoAlertSayac || 0) > uyari0) logYaz('UYARI', 'sayfa uyarısı: ' + String(window.__otoSonAlert || '').slice(0, 100));
                }
                if (dur) break;

                if (sonuc === 'ok') {
                    D.ardisik = 0;
                } else {
                    D.ardisik++;
                    logYaz('HATA', `silme sonuçlanmadı (${D.ardisik}/${ARDISIK_LIMIT})`);
                    if (D.ardisik >= ARDISIK_LIMIT) { mesaj = 'Sunucu silme isteklerine cevap vermedi, durdu.'; break; }
                    await bekle(15000);
                }
                durumKaydet();
            }
        } catch (e) {
            logYaz('HATA', 'beklenmeyen hata: ' + (e && e.message));
            mesaj = 'Hata ile durdu.';
        }
        D.run = false;
        durumKaydet();
        confirmKapat();
        calisiyor = false;
        mod = 'bos';
        logYaz('BİTİŞ', `${mesaj || (dur ? 'Durduruldu.' : 'Bitti.')} | silme isteği: ${D.silinen}`);
        ciz();
    }

    // ---- arayüz ----
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:272px;' +
        'background:#16181d;color:#e8eaf0;border-radius:12px;padding:12px 14px;' +
        'font:12px/1.4 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)';
    document.body.appendChild(panel);

    const bs = 'height:30px;padding:0 12px;border:0;border-radius:8px;font:inherit;cursor:pointer;';
    function ciz() {
        const n = butonlar().length;
        let h = `<div style="font-weight:600;font-size:13px;margin-bottom:8px">Teklif silme</div>`;
        if (mod === 'bos') {
            h += `<div style="color:#aab0bd;margin-bottom:8px">Ekranda silinebilir teklif: <b style="color:#fff">${n}</b><br>Silmeden önce üstten filtreyi seç (ör. Giden talepler).</div>
                <label style="display:flex;gap:6px;align-items:center;margin-bottom:10px;cursor:pointer">
                <input id="oSTop" type="checkbox" ${A.toplu ? 'checked' : ''}> Hızlı mod (arka arkaya tıkla)</label>
                <button id="oSBasla" style="${bs}background:#3b5bfd;color:#fff;font-weight:600" ${n ? '' : 'disabled'}>Başlat</button>`;
        } else if (mod === 'onay') {
            const f = filtreMetni();
            h += `<div style="background:#3a2a12;border:1px solid #7a5a1c;border-radius:8px;padding:8px;margin-bottom:10px;color:#ffd58a">
                Ekrandaki <b>${n}</b> teklif ve devamındakiler silinecek.<br>Seçili filtre: <b>${f || '(algılanamadı, ekrandan kontrol et)'}</b><br>Emin misin?</div>
                <button id="oSEvet" style="${bs}background:#e5484d;color:#fff;font-weight:600">Evet, sil</button>
                <button id="oSVaz" style="${bs}background:#2b2f38;color:#e8eaf0;margin-left:6px">Vazgeç</button>`;
        } else {
            h += `<div style="margin-bottom:10px">Çalışıyor... kalan: <b>${n}</b> | silme isteği: <b>${D.silinen}</b></div>
                <button id="oSDur" style="${bs}background:#e5484d;color:#fff;font-weight:600">Durdur</button>`;
        }
        if (logSatir.length) {
            h += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #2b2f38;color:#8e97a8;font-size:11px;max-height:90px;overflow:auto">` +
                logSatir.slice().reverse().map((s) => `<div>${s.replace(/</g, '&lt;')}</div>`).join('') + `</div>`;
        }
        panel.innerHTML = h;
        const q = (id) => panel.querySelector('#' + id);
        if (q('oSTop')) q('oSTop').onchange = (e) => { A.toplu = e.target.checked; try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (x) {} };
        if (q('oSBasla')) q('oSBasla').onclick = () => { mod = 'onay'; ciz(); };
        if (q('oSVaz')) q('oSVaz').onclick = () => { mod = 'bos'; ciz(); };
        if (q('oSEvet')) q('oSEvet').onclick = () => {
            D = { run: true, silinen: 0, filtre: filtreImza(), ardisik: 0 };
            durumKaydet();
            logYaz('BAŞLA', `filtre: ${filtreMetni() || '-'} | mod: ${A.toplu ? 'hızlı' : 'sıralı'} | görünen ${butonlar().length}`);
            dongu();
        };
        if (q('oSDur')) q('oSDur').onclick = () => { dur = true; D.run = false; durumKaydet(); };
    }
    ciz();
    setInterval(() => { if (mod === 'bos' && !panel.contains(document.activeElement)) ciz(); }, 3000);

    // Sayfa yenilenirse (silme sonrası form gönderimi) kaldığı yerden devam et
    if (D.run) setTimeout(() => {
        logYaz('DEVAM', 'sayfa yenilendi, silmeye devam');
        dongu();
    }, 2000);
})();
