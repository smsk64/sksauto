// Bağımlılıksız basit .xlsx yazıcı (ZIP + SpreadsheetML). Excel, LibreOffice ve Google Sheets açar.
const zlib = require('zlib');

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
    yerel.writeUInt16LE(0x0800, 6);       // UTF-8 dosya adı
    yerel.writeUInt16LE(8, 8);            // deflate
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

const xmlKacis = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function kolonHarf(i) {
  let s = '';
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// satirlar: [[hücre, ...], ...]  (ilk satır başlık). Hücre: string | number | {v, bold}
function xlsxOlustur(sayfaAdi, satirlar, genislikler) {
  const satirXml = satirlar.map((satir, r) => {
    const hucreler = satir.map((h, c) => {
      const ref = kolonHarf(c) + (r + 1);
      const stil = r === 0 ? ' s="1"' : '';
      if (h === null || h === undefined || h === '') return `<c r="${ref}"${stil}/>`;
      if (typeof h === 'number' && isFinite(h)) return `<c r="${ref}"${stil}><v>${h}</v></c>`;
      return `<c r="${ref}"${stil} t="inlineStr"><is><t xml:space="preserve">${xmlKacis(h)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${hucreler}</row>`;
  }).join('');
  const kolonlar = (genislikler || []).length
    ? '<cols>' + genislikler.map((g, i) => `<col min="${i + 1}" max="${i + 1}" width="${g}" customWidth="1"/>`).join('') + '</cols>'
    : '';
  const sayfa = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${kolonlar}<sheetData>${satirXml}</sheetData></worksheet>`;
  const stiller = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3B5BFD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const ad = xmlKacis(sayfaAdi || 'Sayfa1').slice(0, 31);
  return zipYap([
    { ad: '[Content_Types].xml', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { ad: '_rels/.rels', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { ad: 'xl/workbook.xml', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${ad}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { ad: 'xl/_rels/workbook.xml.rels', veri: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { ad: 'xl/styles.xml', veri: stiller },
    { ad: 'xl/worksheets/sheet1.xml', veri: sayfa }
  ]);
}

module.exports = { xlsxOlustur };
