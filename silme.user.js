// Teklif silme otomasyonu v3 - MalzemeyeGore.aspx (ASPxGridViewTalepDetay)
// @version 3.0
// Talep numarasıyla takip: tıklanan her satırın gerçekten silindiği (sayfadan kaybolduğu) doğrulanır,
// silinmeyenlere tekrar tıklanır. Tıklama hızı, sunucunun gerçek silme hızına göre kendiliğinden ayarlanır.
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (!document.body || !document.querySelector('[id*="ASPxGridViewTalepDetay"]')) return;

    const SEL_SIL = 'input[id*="ASPxGridViewTalepDetay"][id$="_ASPxButtonSil_I"]';
    const SEL_SATIR = 'tr[id*="ASPxGridViewTalepDetay_DXDataRow"]';
    const KEY = 'oto_sil_durum_v2';
    const AYAR_KEY = 'oto_sil_ayar_v1';
    const ARDISIK_LIMIT = 3;        // üst üste bu kadar tur hiç silme olmazsa dur

    // Panelden düzenlenebilen ayarlar
    let A = {
        toplu: false,      // hızlı mod: arka arkaya tıkla
        tikAra: 400,       // tıklamalar arası bekleme (ms) - otomatik ayarda kendiliğinden güncellenir
        oto: true,         // tıklama aralığını sunucu hızına göre otomatik ayarla
        minAra: 100,       // otomatik ayarda en düşük aralık (ms)
        maxAra: 8000,      // otomatik ayarda en yüksek aralık (ms)
        pencere: 5,        // aynı anda sonucu beklenen en fazla tıklama (0 = sınırsız)
        maxDeneme: 6,      // bir talebe, aradan hiç silme olmadan en fazla kaç kez tıklanır
        ilkSn: 60,         // tıklamadan sonra ilk silinmeyi bekleme (sn)
        sakinSn: 20        // son silinmeden sonra yeni silinme gelmezse bekleyenler "işlenmedi" sayılır (sn)
    };
    try { Object.assign(A, JSON.parse(localStorage.getItem(AYAR_KEY) || '{}')); } catch (e) {}
    const ayarKaydet = () => { try { localStorage.setItem(AYAR_KEY, JSON.stringify(A)); } catch (e) {} };

    let D = { run: false, silinen: [], deneme: {}, filtre: '', ardisik: 0 };
    try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) Object.assign(D, s); } catch (e) {}
    const durumKaydet = () => { try { sessionStorage.setItem(KEY, JSON.stringify(D)); } catch (e) {} };

    let dur = false;
    let calisiyor = false;
    let mod = 'bos';           // bos | onay | calisiyor
    let ayarAcik = false;
    const logSatir = [];
    const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR');
    const sinirla = (v, a, b) => Math.max(a, Math.min(b, v));

    // ---- confirm() kutusunu otomatik onayla (sadece çalışırken) ----
    const asilConfirm = window.confirm;
    function confirmAc() { window.confirm = function () { return true; }; }
    function confirmKapat() { window.confirm = asilConfirm; }

    // ---- sayfa okuma ----
    function butonlar() {
        return [...document.querySelectorAll(SEL_SIL)].filter((b) => b.isConnected && !b.disabled);
    }
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
    // Seçili filtre (Giden / Kabul / Red) değişirse güvenlik için dur (sadece kimlik; sınıf adları hover ile değişir)
    function filtreImza() {
        const a = [...document.querySelectorAll('input[type=radio]')].filter((r) => r.checked).map((r) => r.id || r.value);
        const b = [...document.querySelectorAll('[class*="RadioButtonChecked"]')].map((e) => e.id).filter(Boolean);
        return a.concat(b).join(',');
    }
    function filtreMetni() {
        const r = [...document.querySelectorAll('input[type=radio]')].find((x) => x.checked);
        if (!r) return '';
        const l = (r.id && document.querySelector('label[for="' + r.id + '"]')) || r.closest('label');
        const t = l ? l.textContent : (r.nextSibling && r.nextSibling.textContent) || '';
        return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    }

    // ---- izleme: tıklanan anahtarlar sayfadan kaybolunca "silindi" say ----
    function yeniIz() { return { bekleyen: new Set(), sil: 0, t0: Date.now(), sonSil: null }; }
    function izle(iz) {
        if (!iz.bekleyen.size) return;
        const simdi = new Set(satirlar().map((s) => s.key));
        let degisti = false;
        for (const k of [...iz.bekleyen]) {
            if (!simdi.has(k)) {
                iz.bekleyen.delete(k);
                D.silinen.push(k);
                iz.sil++;
                iz.sonSil = Date.now();
                degisti = true;
                logYaz('SİLİNDİ', `talep ${k.slice(0, 40)} | toplam ${D.silinen.length}`);
            }
        }
        if (degisti) durumKaydet();
    }
    const sakinMs = () => Math.max(6000, Math.min(A.sakinSn * 1000, A.tikAra * 8));
    // Beklemeyi bırakma zamanı geldi mi? (hiç silme yok -> ilkSn, silme var ama durdu -> sakin)
    function yutuldu(iz) {
        const t = Date.now();
        if (iz.sonSil === null) return t - iz.t0 > A.ilkSn * 1000 ? 'zaman' : '';
        return t - iz.sonSil > sakinMs() ? 'sakin' : '';
    }
    async function turBitir(iz) {
        while (true) {
            if (dur) return 'dur';
            izle(iz);
            if (!iz.bekleyen.size) return 'tamam';
            const y = yutuldu(iz);
            if (y) return y;
            await bekle(100);
        }
    }

    // ---- boş liste doğrulaması (grid yenilenirken geçici boşluk olabilir) ----
    async function bosDogrula() {
        for (let i = 0; i < 5; i++) {
            if (dur) return 'dur';
            if (butonlar().length) return 'var';
            await bekle(1000);
        }
        return document.querySelectorAll(SEL_SATIR).length ? 'butonyok' : 'bos';
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
                let liste = satirlar();
                if (!liste.length) {
                    const d = await bosDogrula();
                    if (d === 'dur') break;
                    if (d === 'var') continue;
                    if (d === 'butonyok') {
                        mesaj = `Ekranda ${document.querySelectorAll(SEL_SATIR).length} satır var ama Sil butonu bulunamadı (sayfa yapısı değişmiş olabilir).`;
                    } else {
                        mesaj = 'Silinecek teklif kalmadı.';
                    }
                    break;
                }

                const aday = liste.filter((s) => (D.deneme[s.key] || 0) < A.maxDeneme);
                if (!aday.length) { mesaj = `Ekranda ${liste.length} teklif kaldı, her birine ${A.maxDeneme} kez tıklandı ama silinmedi.`; break; }

                const parti = (A.toplu ? aday : aday.slice(0, 1)).map((s) => s.key);
                logYaz('SİL', `${parti.length} talebe tıklanıyor (ekranda ${liste.length}, aralık ${A.toplu ? A.tikAra + ' ms' : 'sıralı'})`);

                const iz = yeniIz();
                let tik = 0;
                for (const k of parti) {
                    if (dur) break;
                    // Aynı anda sonuç bekleyen tıklama sayısını sınırla (sunucu fazlasını yutuyor)
                    if (A.toplu && A.pencere > 0) {
                        while (!dur && iz.bekleyen.size >= A.pencere && !yutuldu(iz)) {
                            await bekle(50);
                            izle(iz);
                        }
                    }
                    if (dur) break;
                    const s = satirlar().find((x) => x.key === k);
                    if (!s) continue;                 // bu arada silinmiş
                    D.deneme[k] = (D.deneme[k] || 0) + 1;
                    durumKaydet();
                    if (!tik) iz.t0 = Date.now();
                    s.btn.click();
                    iz.bekleyen.add(k);
                    tik++;
                    if (A.toplu) {
                        const hedef = Date.now() + A.tikAra;
                        while (!dur && Date.now() < hedef) { await bekle(40); izle(iz); }
                    }
                }
                if (dur) break;

                const sonuc = await turBitir(iz);
                if (dur) break;
                const kalan = iz.bekleyen.size;

                if (iz.sil > 0) {
                    D.ardisik = 0;
                    D.deneme = {};     // ilerleme var, sunucu çalışıyor: deneme haklarını sıfırla
                    if (A.toplu && A.oto && tik >= 3) {
                        const per = (iz.sonSil - iz.t0) / iz.sil;     // 1 teklifin algılanma süresi (ms)
                        let yeni = A.tikAra;
                        if (kalan > 0) {
                            yeni = Math.max(per * 1.05, A.tikAra * 1.25);   // tıklamalar yutuldu: yavaşla
                        } else if (tik >= 5) {
                            yeni = A.tikAra * 0.85;                          // hepsi algılandı: biraz hızlan
                        }
                        yeni = Math.round(sinirla(yeni, A.minAra, A.maxAra));
                        logYaz('ARALIK', `${tik} tıklama, ${iz.sil} algılandı, teklif başına ${Math.round(per)} ms | aralık ${A.tikAra} -> ${yeni} ms`);
                        A.tikAra = yeni;
                        ayarKaydet();
                    }
                    if (kalan > 0) logYaz('UYARI', `${kalan} talep silinmedi, tekrar denenecek`);
                } else {
                    D.ardisik++;
                    logYaz('HATA', `hiçbir talep silinmedi (${sonuc}) ${D.ardisik}/${ARDISIK_LIMIT}`);
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
        logYaz('BİTİŞ', `${mesaj || (dur ? 'Durduruldu.' : 'Bitti.')} | silinen: ${D.silinen.length} | ekranda: ${butonlar().length}`);
        ciz();
    }

    // ---- arayüz ----
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:292px;max-height:92vh;overflow:auto;' +
        'background:#16181d;color:#e8eaf0;border-radius:12px;padding:12px 14px;' +
        'font:12px/1.4 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)';
    document.body.appendChild(panel);

    const bs = 'height:30px;padding:0 12px;border:0;border-radius:8px;font:inherit;cursor:pointer;';
    const girdi = 'width:70px;height:24px;border:1px solid #3a3f4b;border-radius:6px;background:#0f1115;color:#e8eaf0;padding:0 6px;font:inherit;text-align:right';
    const AYAR_ALANLARI = [
        ['tikAra', 'Tıklama aralığı (ms)'],
        ['minAra', 'En düşük aralık (ms)'],
        ['maxAra', 'En yüksek aralık (ms)'],
        ['pencere', 'Aynı anda bekleyen (0=sınırsız)'],
        ['maxDeneme', 'Talep başına en fazla deneme'],
        ['ilkSn', 'İlk silinme bekleme (sn)'],
        ['sakinSn', 'Sakin bekleme (sn)']
    ];
    function ciz() {
        const n = butonlar().length;
        let h = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-weight:600;font-size:13px">Teklif silme</span>
            ${mod === 'bos' ? `<button id="oSAyar" style="${bs}height:24px;padding:0 8px;background:#2b2f38;color:#e8eaf0">${ayarAcik ? 'Ayarlar ▴' : 'Ayarlar ▾'}</button>` : ''}</div>`;
        if (mod === 'bos') {
            h += `<div style="color:#aab0bd;margin-bottom:8px">Ekranda silinebilir teklif: <b style="color:#fff">${n}</b><br>Silmeden önce üstten filtreyi seç (ör. Giden talepler).</div>`;
            if (ayarAcik) {
                h += `<div style="background:#1d2027;border-radius:8px;padding:8px;margin-bottom:10px">
                    <label style="display:flex;gap:6px;align-items:center;margin-bottom:6px;cursor:pointer"><input id="oSTop" type="checkbox" ${A.toplu ? 'checked' : ''}> Hızlı mod (arka arkaya tıkla)</label>
                    <label style="display:flex;gap:6px;align-items:center;margin-bottom:8px;cursor:pointer"><input id="oSOto" type="checkbox" ${A.oto ? 'checked' : ''}> Tıklama aralığını otomatik ayarla</label>` +
                    AYAR_ALANLARI.map(([k, e]) => `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span>${e}</span><input data-k="${k}" type="number" value="${A[k]}" style="${girdi}"></div>`).join('') +
                    `</div>`;
            } else {
                h += `<label style="display:flex;gap:6px;align-items:center;margin-bottom:10px;cursor:pointer">
                    <input id="oSTop" type="checkbox" ${A.toplu ? 'checked' : ''}> Hızlı mod (arka arkaya tıkla)</label>`;
            }
            h += `<button id="oSBasla" style="${bs}background:#3b5bfd;color:#fff;font-weight:600" ${n ? '' : 'disabled'}>Başlat</button>`;
        } else if (mod === 'onay') {
            const f = filtreMetni();
            h += `<div style="background:#3a2a12;border:1px solid #7a5a1c;border-radius:8px;padding:8px;margin-bottom:10px;color:#ffd58a">
                Ekrandaki <b>${n}</b> teklif ve devamındakiler silinecek.<br>Seçili filtre: <b>${f || '(algılanamadı, ekrandan kontrol et)'}</b><br>Emin misin?</div>
                <button id="oSEvet" style="${bs}background:#e5484d;color:#fff;font-weight:600">Evet, sil</button>
                <button id="oSVaz" style="${bs}background:#2b2f38;color:#e8eaf0;margin-left:6px">Vazgeç</button>`;
        } else {
            h += `<div style="margin-bottom:10px">Çalışıyor... kalan: <b>${n}</b> | silinen: <b>${D.silinen.length}</b>${A.toplu ? ` | aralık: <b>${A.tikAra} ms</b>` : ''}</div>
                <button id="oSDur" style="${bs}background:#e5484d;color:#fff;font-weight:600">Durdur</button>`;
        }
        if (logSatir.length) {
            h += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #2b2f38;color:#8e97a8;font-size:11px;max-height:110px;overflow:auto">` +
                logSatir.slice().reverse().map((s) => `<div>${s.replace(/</g, '&lt;')}</div>`).join('') + `</div>`;
        }
        panel.innerHTML = h;
        const q = (id) => panel.querySelector('#' + id);
        if (q('oSAyar')) q('oSAyar').onclick = () => { ayarAcik = !ayarAcik; ciz(); };
        if (q('oSTop')) q('oSTop').onchange = (e) => { A.toplu = e.target.checked; ayarKaydet(); };
        if (q('oSOto')) q('oSOto').onchange = (e) => { A.oto = e.target.checked; ayarKaydet(); };
        panel.querySelectorAll('input[data-k]').forEach((i) => {
            i.onchange = () => {
                const v = parseFloat(i.value);
                if (v >= 0) { A[i.dataset.k] = Math.round(v); ayarKaydet(); }
                i.value = A[i.dataset.k];
            };
        });
        if (q('oSBasla')) q('oSBasla').onclick = () => { mod = 'onay'; ciz(); };
        if (q('oSVaz')) q('oSVaz').onclick = () => { mod = 'bos'; ciz(); };
        if (q('oSEvet')) q('oSEvet').onclick = () => {
            D = { run: true, silinen: [], deneme: {}, filtre: filtreImza(), ardisik: 0 };
            durumKaydet();
            const ls = satirlar();
            logYaz('BAŞLA', `filtre: ${filtreMetni() || '-'} | mod: ${A.toplu ? 'hızlı ' + A.tikAra + ' ms' + (A.oto ? ' (otomatik)' : '') : 'sıralı'} | görünen ${ls.length} | takip: ${ls.length ? ls[0].yontem : '-'}`);
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
