(function () {
  // Sayfa arka planda/odaksız sanılmasın
  try {
    const d = document;
    const tanim = (ad, deger) => {
      try { Object.defineProperty(d, ad, { get: () => deger, configurable: true }); } catch (e) {}
    };
    tanim('hidden', false);
    tanim('visibilityState', 'visible');
    tanim('webkitHidden', false);
    tanim('webkitVisibilityState', 'visible');
    d.hasFocus = () => true;
    d.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    window.addEventListener('blur', (e) => {
      if (e.target === window || e.target === d) e.stopImmediatePropagation();
    }, true);
  } catch (e) {}

  // alert() sayfayı kilitlemesin: ekranda kutu göster, say, logla
  try {
    window.__otoAlertSayac = 0;
    window.__otoSonAlert = '';
    window.alert = function (m) {
      window.__otoAlertSayac++;
      window.__otoSonAlert = String(m);
      try { console.log('[Oto] ALERT: ' + String(m).slice(0, 300)); } catch (e) {}
      try {
        const b = document.createElement('div');
        b.textContent = 'Sayfa uyarısı: ' + m;
        b.style.cssText = 'position:fixed;left:8px;bottom:8px;max-width:60%;z-index:2147483647;' +
          'background:#b00020;color:#fff;font:12px sans-serif;padding:8px 10px;border-radius:6px;' +
          'cursor:pointer;white-space:pre-wrap';
        b.onclick = () => b.remove();
        (document.body || document.documentElement).appendChild(b);
        setTimeout(() => b.remove(), 15000);
      } catch (e) {}
    };
  } catch (e) {}
})();
