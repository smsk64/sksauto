// Teklif silme otomasyonu v2 - MalzemeyeGore.aspx (ASPxGridViewTalepDetay)
// Talep numarasıyla takip: tıklanan her satırın gerçekten silindiği (sayfadan kaybolduğu) doğrulanır,
// silinmeyenlere sadece tekrar tıklanır.
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (!document.body || !document.querySelector('[id*="ASPxGridViewTalepDetay"]')) return;

    const SEL_SIL = 'input[id*="ASPxGridViewTalepDetay"][id$="_ASPxButtonSil_I"]';
    const KEY = 'oto_sil_durum_v2';
    const AYAR_KEY = 'oto_sil_ayar_v1';
    const CLICK_ARA = 150;          // hızlı modda tıklamalar arası (ms)
    const ILK_BEKLEME = 30000;      // tıklamadan sonra ilk silinmeyi bekleme
    const SAKIN_BEKLEME = 3000;    // son silinmeden sonra yeni silinme gelmezse kalanlar "işlenmedi" sayılır
    const MAX_DENEME = 3;           // aynı talebe en fazla bu kadar tıklanır
    const ARDISIK_LIMIT = 3;        // üst üste bu kadar tur sonuçsuz kalırsa dur

    let A = { toplu: false };
    try { Object.assign(A, JSON.parse(localStorage.getItem(AYAR_KEY) || '{}')); } catch (e) {}
    let D = { run: false, silinen: [], deneme: {}, filtre: '', ardisik: 0 };
    try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) Object.assign(D, s); } catch (e) {}
    const durumKaydet = () => { try { sessionStorage.setItem(KEY, JSON.stringify(D)); } catch (e) {} };

    let dur = false;
    let calisiyor = false;
    let mod = 'bos';           // bos | onay | calisiyor
    const logSatir = [];
    const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');

    // ---- confirm() kutusunu otomatik onayla (sadece çalışırken) ----
    const asilConfirm = window.confirm;
    function confirmAc() {
        window.confirm = function () { return true; };
    }
    function confirmKapat() { window.confirm = asilConfirm; }

    // ---- sayfa okuma ----
    function butonlar() {
        return [...document.querySelectorAll(SEL_SIL)].filter((b) => b.isConnected && !b.disabled);
    }
    // "Talep No" sütununun satır içindeki sırası
    function talepKolonu() {
        const basliklar = [...document.querySelectorAll('td[id*="ASPxGridViewTalepDetay_col"]')];
        const h = basliklar.find((td) => /TALEP\s*(NO|NUMARA)/.test(norm(td.textContent)));
        if (!h || !h.parentElement) return -1;
        return [...h.parentElement.children].indexOf(h);
    }
    // Her silinebilir satır için anahtar (talep no; benzersiz değilse satır metni)
    function satirlar() {
        const idx = talepKolonu();
        const ham = butonlar().map((b) => {
            const tr = b.closest('tr');
            let no = '';
            if (tr && idx >= 0 && tr.children[idx]) no = norm(tr.children[idx].textContent);
            if (!no && tr) { const m = (tr.textContent || '').match(/\d{5,}/); if (m) no = m[0]; }
            return { btn: b, no, metin: tr ? norm(tr.textContent).slice(0, 160) : '' };
        });
        const say = {};
        ham.forEach((h) => { if (h.no) say[h.no] = (say[h.no] || 0) + 1; });
        const benzersiz = ham.every((h) => h.no && say[h.no] === 1);
        ham.forEach((h) => { h.key = benzersiz ? h.no : h.metin; h.yontem = benzersiz ? (idx >= 0 ? 'Talep No sütunu' : 'satırdaki numara') : 'satır metni'; });
        return ham;
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

    // Tıklanan anahtarların sayfadan kaybolmasını bekler (kaybolan = silindi)
    // Döner: { kalan: [...anahtarlar], silinen: n, neden: 'tamam' | 'sakin' | 'zaman' | 'dur' }
    async function kaybolmaBekle(anahtarlar) {
        const bekleyen = new Set(anahtarlar);
        const bas = Date.now();
        let son = null;
        let silinen = 0;
        while (true) {
            if (dur) return { kalan: [...bekleyen], silinen, neden: 'dur' };
            const simdi = new Set(satirlar().map((s) => s.key));
            for (const k of [...bekleyen]) {
                if (!simdi.has(k)) {
                    bekleyen.delete(k);
                    D.silinen.push(k);
                    delete D.deneme[k];
                    silinen++;
                    son = Date.now();
                    logYaz('SİLİNDİ', `talep ${k.slice(0, 40)} | toplam ${D.silinen.length}`);
                }
            }
            if (silinen) durumKaydet();
            if (!bekleyen.size) return { kalan: [], silinen, neden: 'tamam' };
            const t = Date.now();
            if (son === null && t - bas > ILK_BEKLEME) return { kalan: [...bekleyen], silinen, neden: 'zaman' };
            if (son !== null && t - son > SAKIN_BEKLEME) return { kalan: [...bekleyen], silinen, neden: 'sakin' };
            await bekle(150);
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
                const liste = satirlar();
                if (!liste.length) { mesaj = 'Silinecek teklif kalmadı.'; break; }

                const aday = liste.filter((s) => (D.deneme[s.key] || 0) < MAX_DENEME);
                if (!aday.length) { mesaj = `${liste.length} teklif ${MAX_DENEME} denemede silinemedi, durdu.`; break; }

                const parti = (A.toplu ? aday : aday.slice(0, 1)).map((s) => s.key);
                logYaz('SİL', `${parti.length} talebe tıklanıyor (ekranda ${liste.length})`);

                const tiklanan = [];
                for (const k of parti) {
                    if (dur) break;
                    const s = satirlar().find((x) => x.key === k);
                    if (!s) continue;                 // bu arada silinmiş
                    D.deneme[k] = (D.deneme[k] || 0) + 1;
                    durumKaydet();
                    s.btn.click();
                    tiklanan.push(k);
                    if (A.toplu) await bekle(CLICK_ARA);
                }
                if (dur) break;

                const r = await kaybolmaBekle(tiklanan);
                if (dur) break;

                if (r.silinen > 0) {
                    D.ardisik = 0;
                    if (r.kalan.length) logYaz('UYARI', `${r.kalan.length} talep silinmedi, tekrar denenecek`);
                } else {
                    D.ardisik++;
                    logYaz('HATA', `hiçbir talep silinmedi (${r.neden}) ${D.ardisik}/${ARDISIK_LIMIT}`);
                    if (D.ardisik >= ARDISIK_LIMIT) { mesaj = 'Sunucu silme isteklerine cevap vermedi, durdu.'; break; }
                    await bekle(5000);
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
        logYaz('BİTİŞ', `${mesaj || (dur ? 'Durduruldu.' : 'Bitti.')} | silinen: ${D.silinen.length}`);
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
            h += `<div style="margin-bottom:10px">Çalışıyor... kalan: <b>${n}</b> | silinen: <b>${D.silinen.length}</b></div>
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
            D = { run: true, silinen: [], deneme: {}, filtre: filtreImza(), ardisik: 0 };
            durumKaydet();
            const ls = satirlar();
            logYaz('BAŞLA', `filtre: ${filtreMetni() || '-'} | mod: ${A.toplu ? 'hızlı' : 'sıralı'} | görünen ${ls.length} | takip: ${ls.length ? ls[0].yontem : '-'}`);
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
