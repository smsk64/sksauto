// Bağımlılıksız .xlsx okuyucu/yazıcı (ZIP + SpreadsheetML). Excel, LibreOffice ve Google Sheets ile uyumlu.
const zlib = require('zlib');

// ---------------- ZIP ----------------
const CRC_TABLO = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLO[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipYap(dosyalar) {
  const parcalar = [];
  const merkez = [];
  let ofset = 0;
  const simdi = new Date();
  const zaman = (simdi.getHours() << 11) | (simdi.getMinutes() << 5) | (simdi.getSeconds() >> 1);
  const tarih = ((simdi.getFullYear() - 1980) << 9) | ((simdi.getMonth() + 1) << 5) | simdi.getDate();
  for (const d of dosyalar) {
    const ad = Buffer.from(d.ad, 'utf8');
    const ham = Buffer.isBuffer(d.veri) ? d.veri : Buffer.from(d.veri, 'utf8');
    const sik = zlib.deflateRawSync(ham);
    const crc = crc32(ham);
    const yerel = Buffer.alloc(30);
    yerel.writeUInt32LE(0x04034b50, 0);
    yerel.writeUInt16LE(20, 4);
    yerel.writeUInt16LE(0x0800, 6);
    yerel.writeUInt16LE(8, 8);
    yerel.writeUInt16LE(zaman, 10);
    yerel.writeUInt16LE(tarih, 12);
    yerel.writeUInt32LE(crc, 14);
    yerel.writeUInt32LE(sik.length, 18);
    yerel.writeUInt32LE(ham.length, 22);
    yerel.writeUInt16LE(ad.length, 26);
    yerel.writeUInt16LE(0, 28);
    parcalar.push(yerel, ad, sik);

    const m = Buffer.alloc(46);
    m.writeUInt32LE(0x02014b50, 0);
    m.writeUInt16LE(20, 4);
    m.writeUInt16LE(20, 6);
    m.writeUInt16LE(0x0800, 8);
    m.writeUInt16LE(8, 10);
    m.writeUInt16LE(zaman, 12);
    m.writeUInt16LE(tarih, 14);
    m.writeUInt32LE(crc, 16);
    m.writeUInt32LE(sik.length, 20);
    m.writeUInt32LE(ham.length, 24);
    m.writeUInt16LE(ad.length, 28);
    m.writeUInt32LE(ofset, 42);
    merkez.push(m, ad);
    ofset += yerel.length + ad.length + sik.length;
  }
  const merkezBoyut = merkez.reduce((t, b) => t + b.length, 0);
  const son = Buffer.alloc(22);
  son.writeUInt32LE(0x06054b50, 0);
  son.writeUInt16LE(dosyalar.length, 8);
  son.writeUInt16LE(dosyalar.length, 10);
  son.writeUInt32LE(merkezBoyut, 12);
  son.writeUInt32LE(ofset, 16);
  return Buffer.concat([...parcalar, ...merkez, son]);
}

// Zip içindeki dosyaları okur: { ad: () => Buffer }
function zipOku(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Geçerli bir .xlsx dosyası değil');
  const adet = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const dosyalar = {};
  for (let i = 0; i < adet; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const yontem = buf.readUInt16LE(p + 10);
    const sikBoy = buf.readUInt32LE(p + 20);
    const adU = buf.readUInt16LE(p + 28);
    const exU = buf.readUInt16LE(p + 30);
    const yoU = buf.readUInt16LE(p + 32);
    const yerelOfs = buf.readUInt32LE(p + 42);
    const ad = buf.toString('utf8', p + 46, p + 46 + adU);
    const lAd = buf.readUInt16LE(yerelOfs + 26);
    const lEx = buf.readUInt16LE(yerelOfs + 28);
    const bas = yerelOfs + 30 + lAd + lEx;
    const ham = buf.subarray(bas, bas + sikBoy);
    dosyalar[ad] = () => (yontem === 0 ? ham : zlib.inflateRawSync(ham));
    p += 46 + adU + exU + yoU;
  }
  return dosyalar;
}

// ---------------- XML yardımcıları ----------------
const xmlKacis = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const xmlCoz = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function tMetni(xml) {
  // <t> öğelerinin birleşimi (zengin metinde birden çok <r><t>); fonetik (<rPh>) hariç
  const temiz = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(temiz))) s += m[1] ? xmlCoz(m[1]) : '';
  return s;
}
function kolonHarf(i) {
  let s = '';
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function kolonIndeks(ref) {
  const h = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const c of h) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------- OKUMA ----------------
// İlk sayfayı okur. Döner: { sayfa: 'Ad', satirlar: [[hücre, ...], ...] }
function xlsxOku(buf) {
  const z = zipOku(buf);
  const oku = (ad) => (z[ad] ? z[ad]().toString('utf8') : null);
  const wb = oku('xl/workbook.xml');
  if (!wb) throw new Error('Excel çalışma kitabı bulunamadı');
  const sh = wb.match(/<sheet\b[^>]*>/);
  if (!sh) throw new Error('Excel dosyasında sayfa yok');
  const sayfaAdi = xmlCoz((sh[0].match(/\bname="([^"]*)"/) || [, ''])[1]);
  const rid = (sh[0].match(/\br:id="([^"]*)"/) || [, ''])[1];
  let hedef = 'worksheets/sheet1.xml';
  const rels = oku('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    const re = /<Relationship\b[^>]*>/g;
    let m;
    while ((m = re.exec(rels))) {
      if ((m[0].match(/\bId="([^"]*)"/) || [])[1] === rid) { hedef = (m[0].match(/\bTarget="([^"]*)"/) || [, hedef])[1]; break; }
    }
  }
  const yol = hedef.startsWith('/') ? hedef.slice(1) : 'xl/' + hedef.replace(/^\.\//, '');
  const sayfaXml = oku(yol);
  if (!sayfaXml) throw new Error('Sayfa verisi okunamadı (' + yol + ')');

  const ortak = [];
  const ss = oku('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m;
    while ((m = re.exec(ss))) ortak.push(m[1] ? tMetni(m[1]) : '');
  }

  const satirlar = [];
  const hucreRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = hucreRe.exec(sayfaXml))) {
    const ozel = m[1], icerik = m[2] || '';
    const ref = (ozel.match(/\br="([A-Z]+\d+)"/) || [])[1];
    if (!ref) continue;
    const tur = (ozel.match(/\bt="([^"]*)"/) || [, ''])[1];
    const v = (icerik.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    let deger = null;
    if (tur === 's') deger = v !== undefined ? ortak[parseInt(v, 10)] : null;
    else if (tur === 'inlineStr') deger = tMetni(icerik);
    else if (tur === 'str') deger = v !== undefined ? xmlCoz(v) : null;
    else if (tur === 'b') deger = v === '1';
    else if (tur === 'e') deger = null;
    else if (v !== undefined && v !== '') { const n = Number(v); deger = isFinite(n) ? n : xmlCoz(v); }
    const r = parseInt(ref.replace(/^[A-Z]+/, ''), 10) - 1;
    const c = kolonIndeks(ref);
    if (!satirlar[r]) satirlar[r] = [];
    satirlar[r][c] = deger;
  }
  for (let i = 0; i < satirlar.length; i++) satirlar[i] = satirlar[i] ? Array.from(satirlar[i], (x) => (x === undefined ? null : x)) : [];
  return { sayfa: sayfaAdi, satirlar };
}

// ---------------- YAZMA ----------------
// sayfalar: [{ ad, satirlar: [[...]], genislik: [..], filtre: true }]  (ilk satır başlık)
function xlsxOlustur(sayfalar) {
  const stiller = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const adlar = [];
  const sayfaDosyalari = sayfalar.map((sf, si) => {
    let ad = xmlKacis(sf.ad || 'Sayfa' + (si + 1)).slice(0, 31);
    while (adlar.includes(ad)) ad = ad.slice(0, 28) + '_' + si;
    adlar.push(ad);
    const satirlar = sf.satirlar || [];
    const kolonSay = satirlar.reduce((m, r) => Math.max(m, r.length), 1);
    const satirXml = satirlar.map((satir, r) => {
      const hucreler = satir.map((h, c) => {
        const ref = kolonHarf(c) + (r + 1);
        const stil = r === 0 ? 1 : (typeof h === 'number' ? 3 : 2);
        if (h === null || h === undefined || h === '') return `<c r="${ref}" s="${stil}"/>`;
        if (typeof h === 'number' && isFinite(h)) return `<c r="${ref}" s="${stil}"><v>${h}</v></c>`;
        return `<c r="${ref}" s="${stil}" t="inlineStr"><is><t xml:space="preserve">${xmlKacis(h)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${hucreler}</row>`;
    }).join('');
    const kolonlar = (sf.genislik || []).length
      ? '<cols>' + sf.genislik.map((g, i) => `<col min="${i + 1}" max="${i + 1}" width="${g}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    const filtre = sf.filtre !== false && satirlar.length ? `<autoFilter ref="A1:${kolonHarf(kolonSay - 1)}${Math.max(1, satirlar.length)}"/>` : '';
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${kolonHarf(kolonSay - 1)}${Math.max(1, satirlar.length)}"/><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${kolonlar}<sheetData>${satirXml}</sheetData>${filtre}</worksheet>`;
    return { ad, xml, no: si + 1 };
  });

  const dosyalar = [
    { ad: '[Content_Types].xml', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sayfaDosyalari.map((s) => `<Override PartName="/xl/worksheets/sheet${s.no}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { ad: '_rels/.rels', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { ad: 'xl/workbook.xml', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sayfaDosyalari.map((s) => `<sheet name="${s.ad}" sheetId="${s.no}" r:id="rId${s.no}"/>`).join('')}</sheets></workbook>` },
    { ad: 'xl/_rels/workbook.xml.rels', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sayfaDosyalari.map((s) => `<Relationship Id="rId${s.no}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.no}.xml"/>`).join('')}<Relationship Id="rId${sayfaDosyalari.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { ad: 'xl/styles.xml', veri: stiller },
    ...sayfaDosyalari.map((s) => ({ ad: `xl/worksheets/sheet${s.no}.xml`, veri: s.xml }))
  ];
  return zipYap(dosyalar);
}

module.exports = { xlsxOlustur, xlsxOku };
