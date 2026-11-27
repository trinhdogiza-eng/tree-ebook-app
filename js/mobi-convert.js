// Chuyển sách Kindle (MOBI, AZW3/KF8, AZW, PRC) sang EPUB ngay trên máy.
// Đọc tệp bằng foliate-js (MIT, https://github.com/johnfactotum/foliate-js) rồi đóng gói lại thành EPUB 3
// để Tree Ebook mở như sách EPUB bình thường (mục lục, đọc to, đồng bộ trang… đều dùng được).
// Sách có DRM (khoá bản quyền của Amazon) không đọc được.
/* global JSZip */

const FOLIATE_MOBI = 'https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@9a676796f728347b0127162079c13d23a0f7fee8/mobi.js';
const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

export const KINDLE_EXT = /\.(mobi|azw3|azw|prc|kf8)$/i;
export const KINDLE_MIME = ['application/x-mobipocket-ebook', 'application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook'];

const ascii = (bytes, start, len) => String.fromCharCode(...bytes.subarray(start, start + len));

// Tệp Palm Database: kiểu sách ở byte 60–67 ("BOOKMOBI" = MOBI/AZW3/PRC, "TEXtREAd" = PalmDoc cũ)
export function kindleKind(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 86) return null;
  const type = ascii(b, 60, 8);
  if (type === 'BOOKMOBI') return 'mobi';
  if (type === 'TEXtREAd') return 'palmdoc';
  return null;
}
export const isKindleBuffer = (buf) => !!kindleKind(buf);

// Trường "encryption" trong PalmDOC header của bản ghi đầu tiên (0 = không khoá)
function isEncrypted(buf) {
  const v = new DataView(buf);
  const rec0 = v.getUint32(78);
  return rec0 + 14 <= buf.byteLength && v.getUint16(rec0 + 12) !== 0;
}

// Xem nhanh phần đầu tệp (không cần tải cả cuốn) → 'locked' (có DRM Kindle), 'open' (đọc được),
// 'old' (PRC PalmDoc cũ, chưa hỗ trợ), 'bad' (không phải sách Kindle) hoặc { need: số byte cần đọc thêm }
export function kindleHeadState(buf) {
  const b = new Uint8Array(buf);
  const kind = kindleKind(buf);
  // Topaz (.azw/.tpz, "TPZ") và KFX ("\xeaDRMION" = KFX có DRM) không phải tệp PDB — Kindle khoá, không đọc được
  if (!kind && b.length >= 8 && (ascii(b, 0, 3) === 'TPZ' || (b[0] === 0xea && ascii(b, 1, 7) === 'DRMION'))) return 'locked';
  if (!kind) return 'bad';
  if (kind === 'palmdoc') return 'old';
  const rec0 = new DataView(buf).getUint32(78);
  if (rec0 + 14 > b.length) return { need: rec0 + 16 };
  return isEncrypted(buf) ? 'locked' : 'open';
}

/* ---------- nhận dạng tài nguyên (ảnh, phông, CSS) ---------- */
function sniff(bytes, hint) {
  const h = (n) => ascii(bytes, 0, n);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ['jpg', 'image/jpeg'];
  if (h(4) === '\x89PNG') return ['png', 'image/png'];
  if (h(3) === 'GIF') return ['gif', 'image/gif'];
  if (h(4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return ['webp', 'image/webp'];
  if (h(2) === 'BM') return ['bmp', 'image/bmp'];
  if (h(4) === 'wOFF') return ['woff', 'font/woff'];
  if (h(4) === 'wOF2') return ['woff2', 'font/woff2'];
  if (h(4) === 'OTTO') return ['otf', 'font/otf'];
  if (h(4) === '\x00\x01\x00\x00' || h(4) === 'true') return ['ttf', 'font/ttf'];
  if (hint === 'css') return ['css', 'text/css'];
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg/i.test(head)) return ['svg', 'image/svg+xml'];
  return ['bin', 'application/octet-stream'];
}

const URL_IN_CSS = /url\(\s*(['"]?)(blob:[^'")\s]+)\1\s*\)/g;

/* ---------- làm sạch tài liệu để thành XHTML hợp lệ ---------- */
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
function cleanDoc(doc) {
  doc.querySelectorAll('script, iframe, object, embed, picture > source').forEach((el) => el.remove());
  // srcset/sizes thường trỏ tới đường dẫn gốc của nhà xuất bản (không có trong tệp Kindle)
  // và được trình duyệt ưu tiên hơn src → ảnh hỏng. Bỏ đi để dùng src đã thay.
  doc.querySelectorAll('[srcset], [sizes]').forEach((el) => { el.removeAttribute('srcset'); el.removeAttribute('sizes'); });
  // Thẻ/thuộc tính có tiền tố lạ (mbp:pagebreak, mbp:nu…) không hợp lệ trong XHTML
  for (const el of [...doc.querySelectorAll('*')]) {
    if (el.namespaceURI === XHTML_NS && el.localName.includes(':')) {
      const span = doc.createElement(/^(mbp:pagebreak)$/i.test(el.localName) ? 'div' : 'span');
      while (el.firstChild) span.appendChild(el.firstChild);
      el.replaceWith(span);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const n = attr.name;
      if (/^on/i.test(n)) el.removeAttribute(n);
      else if (n.includes(':') && !/^(xmlns(:\w+)?|xlink:href|xml:lang|epub:type)$/i.test(n)) el.removeAttribute(n);
      else if (!/^[A-Za-z_][\w.\-:]*$/.test(n)) el.removeAttribute(n);
    }
  }
}

function toXhtml(doc, title) {
  if (!doc.head) doc.documentElement.prepend(doc.createElement('head'));
  if (!doc.querySelector('head > title')) {
    const t = doc.createElement('title');
    t.textContent = title;
    doc.head.prepend(t);
  }
  doc.querySelectorAll('meta[charset], meta[http-equiv]').forEach((m) => m.remove());
  let body = new XMLSerializer().serializeToString(doc.documentElement);
  if (!/^<html[^>]*xmlns=/.test(body)) body = body.replace(/^<html/, `<html xmlns="${XHTML_NS}"`);
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n${body}`;
  // Kiểm tra lại: nếu vẫn không phải XML hợp lệ thì lấy văn bản thuần
  const check = new DOMParser().parseFromString(out, 'application/xhtml+xml');
  if (!check.querySelector('parsererror')) return out;
  const paras = (doc.body?.innerText || doc.body?.textContent || '').split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML_NS}"><head><title>${esc(title)}</title></head><body>${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</body></html>`;
}

const xml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean);
const asText = (v) => (typeof v === 'string' ? v : v?.name || v?.toString?.() || '');

/* ---------- chuyển đổi ---------- */
// Trả về { epub: ArrayBuffer, title, author }
export async function kindleToEpub(buf, fileName = 'sach') {
  const kind = kindleKind(buf);
  if (kind === 'palmdoc') throw new Error('Tệp PRC dạng PalmDoc cũ chưa được hỗ trợ — chỉ đọc được PRC/MOBI của Kindle');
  if (!kind) throw new Error('Không phải tệp MOBI/AZW3/PRC');
  if (isEncrypted(buf)) throw new Error('Sách có DRM (khoá bản quyền Kindle) nên không mở được');
  if (typeof JSZip === 'undefined') throw new Error('Chưa tải được thư viện JSZip (cần mạng lần đầu)');

  const [{ MOBI }, { unzlibSync }] = await Promise.all([import(FOLIATE_MOBI), import(FFLATE)]);
  const book = await new MOBI({ unzlib: unzlibSync }).open(new Blob([buf]));

  try {
    const meta = book.metadata || {};
    const title = (asText(meta.title) || fileName.replace(KINDLE_EXT, '')).trim();
    const author = asList(meta.author).join(', ');
    const lang = asText(meta.language) || 'vi';

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');

    // Tài nguyên: blob URL → tên tệp trong EPUB
    const manifest = []; // { id, href, type, props }
    const resNames = new Map();
    let resCount = 0;
    async function addResource(url, hint) {
      if (resNames.has(url)) return resNames.get(url);
      const name = `r${++resCount}`;
      resNames.set(url, null); // chống vòng lặp
      let bytes;
      try { bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch { resNames.delete(url); return null; }
      let [ext, type] = sniff(bytes, hint);
      if (ext === 'bin' && hint !== 'css') {
        const text = new TextDecoder().decode(bytes.subarray(0, 400));
        if (/[{};]\s*$|@font-face|\{[^}]*:/.test(text)) [ext, type] = ['css', 'text/css'];
      }
      const href = `${name}.${ext}`;
      resNames.set(url, href);
      if (type === 'text/css') {
        let css = new TextDecoder().decode(bytes);
        css = await replaceAsync(css, URL_IN_CSS, async (m, q, u) => {
          const h = await addResource(u);
          return h ? `url("${h}")` : 'url("")';
        });
        zip.file(`OEBPS/${href}`, css);
      } else zip.file(`OEBPS/${href}`, bytes);
      manifest.push({ id: name, href, type });
      return href;
    }

    // 1) Nạp tất cả các phần (chương) của sách
    const docs = []; // theo chỉ số section của foliate
    for (let i = 0; i < book.sections.length; i++) {
      const s = book.sections[i];
      if (!s?.load) continue;
      try {
        const url = await s.load();
        const text = await (await fetch(url)).text();
        let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
        if (doc.querySelector('parsererror') || !doc.documentElement?.namespaceURI) doc = new DOMParser().parseFromString(text, 'text/html');
        // Bỏ phần trống (thường là phần thừa sau dấu ngắt trang cuối)
        const empty = !(doc.body?.textContent || '').trim() && !doc.querySelector('img, svg, image, video, audio');
        if (!empty || i === 0) docs[i] = doc;
      } catch (e) { console.warn('Bỏ qua phần lỗi', i, e); }
    }
    const chapterIdx = docs.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
    if (!chapterIdx.length) throw new Error('Không đọc được nội dung sách');
    const fileOf = (i) => `ch${String(chapterIdx.indexOf(i) + 1).padStart(3, '0')}.xhtml`;

    // 2) Liên kết nội bộ (filepos:, kindle:pos:) → chương#neo
    let anchorCount = 0;
    async function resolve(href) {
      try {
        const r = await book.resolveHref(href);
        if (!r || !docs[r.index]) return null;
        let id = '';
        const el = r.anchor?.(docs[r.index]);
        if (el && el !== docs[r.index].body && el !== docs[r.index].documentElement) {
          if (!el.id) el.id = `tq${++anchorCount}`;
          id = el.id;
        }
        return fileOf(r.index) + (id ? `#${id}` : '');
      } catch { return null; }
    }
    const isInternal = (h) => /^(filepos:|kindle:pos:)/i.test(h || '');

    for (const i of chapterIdx) {
      for (const a of docs[i].querySelectorAll('a[href]')) {
        const h = a.getAttribute('href');
        if (isInternal(h)) {
          const target = await resolve(h);
          if (target) a.setAttribute('href', target); else a.removeAttribute('href');
        } else if (/^blob:/i.test(h)) a.removeAttribute('href');
      }
    }

    // 3) Mục lục
    const toc = [];
    async function mapToc(items, out) {
      for (const it of items || []) {
        const href = it.href && isInternal(it.href) ? await resolve(it.href) : null;
        const node = { label: (it.label || '').trim() || 'Mục', href, children: [] };
        await mapToc(it.subitems, node.children);
        if (node.href || node.children.length) out.push(node);
      }
    }
    await mapToc(book.toc, toc);
    if (!toc.length) chapterIdx.forEach((i, n) => toc.push({ label: `Phần ${n + 1}`, href: fileOf(i), children: [] }));
    const fixHref = (node) => { if (!node.href) node.href = node.children[0]?.href; node.children.forEach(fixHref); };
    toc.forEach(fixHref);

    // 4) Thay ảnh/CSS (blob:) bằng tệp trong EPUB rồi ghi từng chương
    for (const i of chapterIdx) {
      const doc = docs[i];
      for (const el of doc.querySelectorAll('[src], [poster], link[href], image')) {
        for (const attr of ['src', 'poster', 'href', 'xlink:href']) {
          const v = el.getAttribute(attr);
          if (!v || !/^blob:/i.test(v)) continue;
          const isCss = el.localName === 'link';
          const h = await addResource(v, isCss ? 'css' : null);
          if (h) el.setAttribute(attr, h); else el.removeAttribute(attr);
        }
      }
      for (const el of doc.querySelectorAll('[style]')) {
        const v = el.getAttribute('style');
        if (v.includes('blob:')) el.setAttribute('style', await replaceAsync(v, URL_IN_CSS, async (m, q, u) => `url("${(await addResource(u)) || ''}")`));
      }
      for (const st of doc.querySelectorAll('style')) {
        if (st.textContent.includes('blob:')) st.textContent = await replaceAsync(st.textContent, URL_IN_CSS, async (m, q, u) => `url("${(await addResource(u)) || ''}")`);
      }
      cleanDoc(doc);
      zip.file(`OEBPS/${fileOf(i)}`, toXhtml(doc, title));
    }

    // 5) Bìa
    let coverHref = null;
    try {
      const blob = await book.getCover?.();
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const [ext, type] = sniff(bytes);
        if (type.startsWith('image/')) {
          coverHref = `cover.${ext}`;
          zip.file(`OEBPS/${coverHref}`, bytes);
          manifest.push({ id: 'cover-image', href: coverHref, type, props: 'cover-image' });
        }
      }
    } catch { /* không có bìa */ }

    // 6) Mục lục (nav + ncx) và tệp gói
    const navList = (nodes) => `<ol>${nodes.map((n) => `<li><a href="${xml(n.href)}">${xml(n.label)}</a>${n.children.length ? navList(n.children) : ''}</li>`).join('')}</ol>`;
    zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(lang)}"><head><title>Mục lục</title></head><body><nav epub:type="toc" id="toc"><h1>Mục lục</h1>${navList(toc)}</nav></body></html>`);
    let order = 0;
    const ncxPoints = (nodes) => nodes.map((n) => `<navPoint id="np${++order}" playOrder="${order}"><navLabel><text>${xml(n.label)}</text></navLabel><content src="${xml(n.href)}"/>${ncxPoints(n.children)}</navPoint>`).join('');
    const uid = `urn:tree-ebook:${asText(meta.identifier) || Date.now()}`;
    zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${xml(uid)}"/></head><docTitle><text>${xml(title)}</text></docTitle><navMap>${ncxPoints(toc)}</navMap></ncx>`);

    const fixed = book.rendition?.layout === 'pre-paginated';
    const items = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      ...chapterIdx.map((i, n) => `<item id="c${n + 1}" href="${fileOf(i)}" media-type="application/xhtml+xml"/>`),
      ...manifest.map((m) => `<item id="${m.id}" href="${xml(m.href)}" media-type="${m.type}"${m.props ? ` properties="${m.props}"` : ''}/>`),
    ];
    const spine = chapterIdx.map((i, n) => `<itemref idref="c${n + 1}"/>`).join('');
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${xml(lang)}"${book.dir === 'rtl' ? ' dir="rtl"' : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${xml(uid)}</dc:identifier>
<dc:title>${xml(title)}</dc:title>
${asList(meta.author).map((a) => `<dc:creator>${xml(a)}</dc:creator>`).join('')}
<dc:language>${xml(lang)}</dc:language>
${meta.publisher ? `<dc:publisher>${xml(asText(meta.publisher))}</dc:publisher>` : ''}
${meta.description ? `<dc:description>${xml(asText(meta.description))}</dc:description>` : ''}
<meta property="dcterms:modified">${modified}</meta>
${coverHref ? '<meta name="cover" content="cover-image"/>' : ''}
${fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}
</metadata>
<manifest>${items.join('')}</manifest>
<spine toc="ncx"${book.dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>${spine}</spine>
</package>`);

    const epub = await zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });
    return { epub, title, author };
  } finally {
    try { book.destroy?.(); } catch { /* bỏ qua */ }
  }
}

// Thay lần lượt (tuần tự) để mỗi tài nguyên chỉ được thêm một lần
async function replaceAsync(str, regex, fn) {
  const matches = [];
  str.replace(regex, (...args) => { matches.push(args); return ''; });
  const results = [];
  for (const args of matches) results.push(await fn(...args));
  return str.replace(regex, () => results.shift());
}
