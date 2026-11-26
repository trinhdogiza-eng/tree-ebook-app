import * as db from './db.js';
import * as sync from './sync.js';
import { PdfReader, openPdf, pdfInfo, isPdfBuffer } from './pdf-reader.js';
import { kindleToEpub, isKindleBuffer, KINDLE_EXT, KINDLE_MIME } from './mobi-convert.js';
import { pickBooks, pickerReady, libraryUrl } from './picker.js';
import { cloudConfig } from './cloud-config.js';
import { LIBRARY_CATEGORIES } from './library-categories.js';
import {
  Speaker, CloudSpeaker, ttsSupported, voices, isVietnamese, pickVoice, unlockSpeech, splitSentences,
  googleVoices, GOOGLE_DEFAULT_VOICE, AiSpeaker, AI_VOICES, AI_DEFAULT_VOICE, aiDownload, aiVoiceStored,
  aiWarmup, stream, aiPrefetch, aiPrefetchStop, aiCacheInfo, aiCacheClear, aiStats,
} from './read-aloud.js';

/* global ePub */
const APP_VERSION = '2.24';
const APP_BUILD = 75; // phải trùng số trong CACHE của sw.js ('epub-reader-v75') — tăng mỗi lần phát hành
const $ = (id) => document.getElementById(id);
// iPhone/iPad mở từ màn hình chính, chế độ toàn màn hình (black-translucent): iOS báo vùng hiển thị (innerHeight)
// hụt đúng bằng thanh trạng thái so với màn hình thật → đo khoảng hụt và để CSS kéo đáy màn hình app xuống bù.
// Lúc vừa mở, iOS có thể báo ĐỦ chiều cao rồi một lúc sau mới đổi sang chiều cao hụt → đo lại nhiều lần
// (mở app, sau 0,3/1/2,5 giây, khi đổi kích thước, khi quay lại app); bỏ qua lúc bàn phím đang mở.
let iosGap = -1;
let iosGapOrient = '';
let iosGapChanges = 0;
function fixIosGap(force = false) {
  let gap = 0;
  const portrait = window.innerHeight >= window.innerWidth;
  const orient = portrait ? 'p' : 'l';
  if (navigator.standalone === true) {
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && iosGap >= 0) return; // bàn phím đang mở
    const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    gap = Math.round(full - window.innerHeight);
    if (gap > 90) { if (iosGap >= 0) return; gap = 0; } // chênh quá nhiều = bàn phím, không phải lỗi này
    gap = Math.max(0, gap);
    // Đã đo được khoảng hụt → GIỮ CỐ ĐỊNH cho tới khi xoay máy (tránh bật/tắt liên tục làm đáy màn hình nhảy)
    if (!force && iosGap > 0 && orient === iosGapOrient) return;
  }
  iosGapOrient = orient;
  if (gap === iosGap) return;
  iosGap = gap;
  iosGapChanges++;
  document.documentElement.style.setProperty('--ios-gap', `${gap}px`);
  document.documentElement.classList.toggle('ios-gap', gap > 0);
  if (gap > 0) window.scrollTo(0, 0);
}
// Trang không được cuộn lệch (iOS đôi khi tự cuộn khi bàn phím đóng) → luôn về đầu
addEventListener('scroll', () => { if (document.documentElement.classList.contains('ios-gap') && window.scrollY) window.scrollTo(0, 0); }, { passive: true });
fixIosGap();
for (const ms of [300, 1000, 2500]) setTimeout(fixIosGap, ms);
addEventListener('resize', () => setTimeout(fixIosGap, 50));
window.visualViewport?.addEventListener('resize', () => setTimeout(fixIosGap, 50));
addEventListener('orientationchange', () => setTimeout(() => fixIosGap(true), 400));
// iPhone có khoảng hụt: màn hình app dài hơn vùng iOS báo → chặn cuộn cả trang (gây giật đáy),
// chỉ cho cuộn trong các vùng có danh sách / menu.
document.addEventListener('touchmove', (e) => {
  if (!document.documentElement.classList.contains('ios-gap') || e.touches.length > 1) return;
  if (e.target.closest?.('.lib-main, #tocList, .set-body, #cloudList, dialog, .panel, textarea, select, input')) return;
  e.preventDefault();
}, { passive: false });
addEventListener('pageshow', fixIosGap);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(fixIosGap, 200); });
$('appVersion').textContent =`Tree Ebook · Phiên bản ${APP_VERSION} (bản cập nhật ${APP_BUILD}) · Tác giả: Trình Đỗ`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pctText = (p) => `${Math.round((p || 0) * 100)}%`;

/* ================= Thiết bị & cài đặt ================= */
function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } }

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Điện thoại Android' : 'Máy tính bảng Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Thiết bị';
}
let deviceId = lsGet('deviceId', null);
if (!deviceId) { deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('deviceId', deviceId); }
let deviceName = lsGet('deviceName', guessDeviceName());

const settings = Object.assign(
  { fontSize: 100, lineHeight: 1.5, fontFamily: '', theme: 'light', flow: 'paginated', pageAnim: 'curl3d', ttsRate: 1.5, ttsVoice: '', ttsEngine: 'auto', gVoice: '', bgVoice: 'vi_VN-vais1000-medium', openVoice: 'device', startView: 'resume', spread: 'single', justify: true, pageAnim3d: 1 },
  lsGet('settings', {}),
);
const saveSettings = () => lsSet('settings', settings);
// Bản 2.24: lật giấy 3D thành mặc định (người đang dùng lật giấy phẳng được chuyển 1 lần, vẫn chọn lại được trong Aa)
if (!settings.pageAnim3d) { if (settings.pageAnim === 'curl') settings.pageAnim = 'curl3d'; settings.pageAnim3d = 1; saveSettings(); }
const isCurl = () => settings.pageAnim === 'curl' || settings.pageAnim === 'curl3d';
// Hiệu ứng "Lật giấy" mới: máy đang dùng kiểu Trượt (mặc định cũ) chuyển sang 1 lần; sau đó tuỳ người dùng chọn
if (!lsGet('curlIntro', false)) {
  if (settings.pageAnim === 'slide') { settings.pageAnim = 'curl'; saveSettings(); }
  lsSet('curlIntro', true);
}

// Sách đang mở: tắt app lúc đang đọc → bật lại mở tiếp đúng cuốn đó (vị trí đọc đã lưu sẵn trong tiến độ)
const lastBook = {
  KEY: 'lastBook',
  remember(id) { lsSet(this.KEY, id); },
  forget(id) { if (!id || lsGet(this.KEY, null) === id) localStorage.removeItem(this.KEY); },
  async resume() {
    const id = lsGet(this.KEY, null);
    if (!id) return;
    if (!(await db.get('files', id))) { this.forget(id); return; }
    openBook(id);
  },
};
document.body.dataset.theme = settings.theme;

const THEMES = {
  light: { bg: '#ffffff', fg: '#1f1d1a', link: '#b5532c', bar: '#ffffff' },
  sepia: { bg: '#f4ecd8', fg: '#3b2f22', link: '#9c4a1f', bar: '#f4ecd8' },
  dark: { bg: '#161514', fg: '#d9d3c7', link: '#e08a5e', bar: '#161514' },
};

/* ================= Băm tệp (định danh sách giống nhau trên mọi thiết bị) ================= */
function hashBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + '-' + bytes.length.toString(36);
}

/* ================= Thông báo ================= */
let toastTimer = null;
function toast(msg, actionLabel, onAction, ms = 5000) {
  $('toastMsg').textContent = msg;
  const btn = $('toastAction');
  if (actionLabel) {
    btn.textContent = actionLabel; btn.hidden = false;
    btn.onclick = () => { hideToast(); onAction(); };
  } else btn.hidden = true;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').hidden = true; }
$('toastClose').onclick = hideToast;

/* ================= Thư viện ================= */
let remoteMap = {};      // bookId -> dữ liệu đồng bộ
let unwatchAll = () => {};
const coverUrls = [];

function newer(a, b) { return (a?.updatedAt || 0) >= (b?.updatedAt || 0) ? a : b; }

/* ----- Thể loại sách (theo thư mục trên Google Drive) ----- */
const K_LIBCAT = 'libCategory';
const NO_CAT = '__none';
const catOf = (b) => b.category || remoteMap[b.id]?.category || '';
// Thể loại nằm trong thư mục "Ebook sách" trên Drive → ưu tiên xếp trước
const catMain = (b) => (b.category ? b.categoryMain : remoteMap[b.id]?.categoryMain) === true;
async function setCategory(id, cat, main) {
  if (cat == null) return;
  const b = await db.get('books', id);
  const m = !!main;
  if (!b || (b.category === cat && b.categoryMain === m)) return;
  await db.put('books', { ...b, category: cat, categoryMain: m });
  if (cat) sync.push(id, { category: cat, categoryMain: m }).catch(() => {});
  if (!R.id) renderLibrary();
}
// Sách đã mở từ Drive trước đây chưa có thể loại → hỏi Drive (hoặc lấy từ máy khác đã biết) một lần
let backfilling = false;
async function backfillCategories() {
  if (backfilling) return;
  backfilling = true;
  try {
    const u = sync.currentUser();
    for (const b of await db.all('books')) {
      if (b.category && b.categoryMain !== undefined) continue; // đã đủ thông tin
      const r = remoteMap[b.id];
      if (r?.category && r.categoryMain !== undefined) { await setCategory(b.id, r.category, r.categoryMain); continue; }
      if (u && !u.needsReconnect && u.provider === 'gdrive' && b.source?.provider === 'gdrive' && b.source.id) {
        try { const c = await sync.fileCategoryInfo(b.source.id); await setCategory(b.id, c.name, c.main); } catch { /* tệp đã xoá / không còn quyền */ }
      }
    }
  } finally { backfilling = false; }
}
function renderCategoryBar(books) {
  const bar = $('catBar');
  const counts = new Map();
  const main = new Set(); // thể loại thuộc thư mục "Ebook sách"
  for (const b of books) { const c = catOf(b) || NO_CAT; counts.set(c, (counts.get(c) || 0) + 1); if (catMain(b)) main.add(c); }
  // Thể loại trong "Ebook sách" xếp trước (theo tên), thể loại khác xếp sau, "Chưa phân loại" cuối cùng
  const cats = [...counts.keys()].filter((c) => c !== NO_CAT)
    .sort((a, b) => (main.has(b) - main.has(a)) || a.localeCompare(b, 'vi'));
  let sel = lsGet(K_LIBCAT, '') || '';
  if (sel && !counts.has(sel)) sel = '';
  bar.hidden = cats.length === 0;
  if (bar.hidden) return '';
  const chip = (val, label, n) => `<button type="button" class="cat-chip${sel === val ? ' on' : ''}" data-cat="${esc(val)}">${esc(label)} <small>${n}</small></button>`;
  bar.innerHTML = chip('', 'Tất cả', books.length)
    + cats.map((c) => chip(c, c, counts.get(c))).join('')
    + (counts.has(NO_CAT) ? chip(NO_CAT, 'Chưa phân loại', counts.get(NO_CAT)) : '');
  bar.querySelectorAll('[data-cat]').forEach((el) => { el.onclick = () => { lsSet(K_LIBCAT, el.dataset.cat); renderLibrary(); }; });
  return sel;
}

async function renderLibrary() {
  const [allBooks, progress] = await Promise.all([db.all('books'), db.all('progress')]);
  const prog = Object.fromEntries(progress.map((p) => [p.id, p]));
  const selCat = renderCategoryBar(allBooks);
  const books = !selCat ? allBooks : allBooks.filter((b) => (catOf(b) || NO_CAT) === selCat);
  books.sort((a, b) => {
    const ta = newer(prog[a.id], remoteMap[a.id])?.updatedAt || a.addedAt;
    const tb = newer(prog[b.id], remoteMap[b.id])?.updatedAt || b.addedAt;
    return tb - ta;
  });
  coverUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));

  const grid = $('bookGrid');
  grid.innerHTML = '';
  $('emptyState').hidden = allBooks.length > 0;
  for (const b of books) {
    const p = newer(prog[b.id], remoteMap[b.id]);
    const el = document.createElement('div');
    el.className = 'book';
    let coverHtml = `<div class="ph">${esc(b.title)}</div>`;
    if (b.cover) { const u = URL.createObjectURL(b.cover); coverUrls.push(u); coverHtml = `<img src="${u}" alt="">`; }
    el.innerHTML = `
      <div class="cover">${coverHtml}${b.format === 'pdf' ? '<span class="badge">PDF</span>' : ''}</div>
      <button class="del" title="Xoá khỏi máy này" aria-label="Xoá">✕</button>
      <div class="meta">
        <div class="t">${esc(b.title)}</div>
        <div class="a">${esc(b.author) || '&nbsp;'}</div>
        ${catOf(b) && !selCat ? `<div class="c">${esc(catOf(b))}</div>` : ''}
        <div class="bar"><i style="width:${Math.round((p?.percent || 0) * 100)}%"></i></div>
      </div>`;
    el.onclick = () => openBook(b.id);
    el.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Xoá “${b.title}” khỏi máy này? (Tiến độ đã đồng bộ vẫn được giữ.)`)) return;
      await db.removeBook(b.id);
      lastBook.forget(b.id);
      renderLibrary();
    };
    grid.appendChild(el);
  }

  // Sách đang đọc ở thiết bị khác nhưng máy này chưa có tệp
  const localIds = new Set(allBooks.map((b) => b.id));
  const remoteOnly = Object.entries(remoteMap)
    .filter(([id, r]) => !localIds.has(id) && r.title)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  // Trang "Thiết bị khác" (mục trong dock) + số đếm trên dock
  $('remoteSection').hidden = libTab !== 'remote';
  $('remoteEmpty').hidden = remoteOnly.length > 0;
  $('remoteBadge').hidden = remoteOnly.length === 0;
  $('remoteBadge').textContent = remoteOnly.length > 99 ? '99+' : String(remoteOnly.length);
  const list = $('remoteList');
  list.innerHTML = '';
  const u = sync.currentUser();
  for (const [id, r] of remoteOnly) {
    const el = document.createElement('div');
    el.className = 'remote-item';
    const where = r.deviceName ? ` · ${esc(r.deviceName)}` : '';
    const canDownload = u && !u.needsReconnect && r.source?.provider === u.provider;
    el.innerHTML = `<div class="info"><div class="t">${esc(r.title)}</div>
      <div class="s">${r.category ? `<b class="rc">${esc(r.category)}</b> · ` : ''}${esc(r.author || '')}${r.author ? ' · ' : ''}${pctText(r.percent)}${where}</div></div>
      <button class="btn small ${canDownload ? 'primary' : ''}">${canDownload ? `Tải từ ${esc(u.providerName)}` : 'Chọn tệp…'}</button>`;
    el.querySelector('button').onclick = canDownload ? () => downloadAndOpen(r.source.id, r.title, id)
      : () => $('fileInput').click();
    list.appendChild(el);
  }
}

// Tải sách từ OneDrive / Google Drive rồi mở
async function downloadAndOpen(fileId, name, expectedId) {
  try {
    toast(`Đang tải “${name}”…`, null, null, 0);
    const buf = await sync.download(fileId);
    const fileName = /\.(epub|pdf)$/i.test(name) || KINDLE_EXT.test(name) ? name
      : `${name}${isPdfBuffer(buf) ? '.pdf' : isKindleBuffer(buf) ? '.mobi' : '.epub'}`;
    const { id } = await importBuffer(buf, fileName, { provider: sync.currentUser().provider, id: fileId });
    // Thể loại = tên thư mục chứa sách trên Drive (vd. "Tiên hiệp") → lưu & đồng bộ
    sync.fileCategoryInfo(fileId).then((c) => setCategory(id, c.name, c.main)).catch(() => {});
    hideToast();
    if (expectedId && id !== expectedId) toast('Tệp trên đám mây đã thay đổi so với lúc đọc — sẽ mở như sách mới');
    $('cloudDialog').close();
    openBook(id);
  } catch (e) {
    console.error(e);
    toast(`Không tải được: ${sync.errorText(e)}`);
  }
}

/* ----- Trình duyệt tệp trên đám mây ----- */
const K_CLOUDNAV = 'cloudNav';
const K_CATNAV = 'catalogNav';
const cloudNav = { stack: lsGet(K_CLOUDNAV, null) || [], catalog: false }; // [{ id, name }] — nhớ thư mục đang xem lần trước
// Danh sách thư mục đã xem: hiện ngay từ bộ nhớ, tải lại ngầm trên Drive rồi cập nhật
const K_CLOUDCACHE = 'cloudCache';
const cloudCache = new Map(Object.entries(lsGet(K_CLOUDCACHE, {}) || {}));
function cacheList(key, items) {
  cloudCache.delete(key);
  cloudCache.set(key, items);
  while (cloudCache.size > 60) cloudCache.delete(cloudCache.keys().next().value); // giữ 60 thư mục gần nhất
  lsSet(K_CLOUDCACHE, Object.fromEntries(cloudCache));
}
/* ----- Danh mục thư viện công khai: người dùng khác duyệt thư viện ngay trong app (không qua trang Google) ----- */
const K_CATALOG = 'libCatalog';
let catalog = null;
let catalogLoading = null;
const MY_DRIVE = '__mydrive';
function catalogReady() { return !!cloudConfig.catalogFileId && !!cloudConfig.googleApiKey; }
async function loadCatalog(force = false) {
  if (!catalog) { try { catalog = JSON.parse(localStorage.getItem(K_CATALOG) || 'null'); } catch { catalog = null; } }
  // Danh mục đang lưu chưa có kho mới thêm (vd. Tree Ebook 2) → tải lại ngay (chủ thư viện có thể vừa lập lại)
  const stale = !catalog || missingExtras(catalog).length > 0 || Date.now() - (catalog.fetchedAt || 0) > 60 * 60 * 1000;
  if (catalog && !stale && !force) return catalog;
  catalogLoading ||= sync.fetchCatalog(cloudConfig.catalogFileId, cloudConfig.googleApiKey).then((c) => {
    c.fetchedAt = Date.now();
    catalog = c;
    try { localStorage.setItem(K_CATALOG, JSON.stringify(c)); } catch { /* bộ nhớ đầy: vẫn dùng trong phiên */ }
    return c;
  }).finally(() => { catalogLoading = null; });
  if (catalog) { catalogLoading.catch(() => {}); return catalog; } // có bản cũ: dùng ngay, cập nhật ngầm
  return catalogLoading;
}
/* Kho sách thêm (cloudConfig.extraLibraries) chưa có trong danh mục của chủ thư viện (danh mục chỉ lập lại khi app
   của chủ mở) → người đọc vẫn thấy kho ở gốc thư viện và DUYỆT TRỰC TIẾP từng thư mục bằng API key
   (thư mục kho để "Ai có link đều xem được"). Kho dạng Calibre có hàng nghìn thư mục nên không lập trọn trên máy người đọc. */
const missingExtras = (c) => extraLibs().filter((x) => !c.f?.some((f) => f[0] === x.id));
async function catalogWithExtras() {
  const c = await loadCatalog();
  const add = missingExtras(c).map((x) => [x.id, x.name, -1, 1]);
  if (add.length) await loadExtraCounts();
  return add.length ? { ...c, f: [...c.f, ...add] } : c;
}
// Số cuốn trong từng thư mục của kho thêm: đếm sẵn (data/tree-ebook-2-dem.json, lập bằng cách duyệt cả kho)
// + đếm ngầm những thư mục chưa có số (sách mới thêm), nhớ trong máy
const K_PUBCOUNTS = 'pubCounts';
let extraCounts = null;
async function loadExtraCounts() {
  if (extraCounts) return extraCounts;
  let base = {};
  try { base = (await (await fetch('data/tree-ebook-2-dem.json')).json()).counts || {}; } catch { /* chưa có tệp đếm sẵn */ }
  let mine = {};
  try { mine = JSON.parse(localStorage.getItem(K_PUBCOUNTS) || '{}'); } catch { /* bỏ qua */ }
  extraCounts = { ...base, ...mine };
  return extraCounts;
}
const countNote = (id) => (extraCounts?.[id] ? `${extraCounts[id]} cuốn` : '');
let countSeq = 0;
// Chạy ngầm cho các thư mục đang hiện (1 lần hỏi/thư mục):
//  - thư mục chỉ chứa sách (Calibre: "Tên sách/sách.epub") → đổi thành dòng sách, bấm là đọc ngay
//  - thư mục còn thư mục con (tác giả, bộ truyện) → điền số cuốn (sách + thư mục con; mỗi thư mục con Calibre = 1 cuốn)
async function fillLiveCounts(items, cacheKey, cat) {
  const seq = ++countSeq;
  const fid = cloudNav.stack[cloudNav.stack.length - 1]?.id;
  // Vẫn đang xem đúng thư mục này → mới được vẽ lại
  const alive = () => seq === countSeq && $('cloudDialog').open && !cloudNav.searching && cloudNav.stack[cloudNav.stack.length - 1]?.id === fid;
  const todo = items.filter((it) => it.isFolder && it.live && !extraCounts?.[it.id]);
  if (!todo.length) return;
  const have = new Set((await db.all('books')).map((b) => b.source?.id).filter(Boolean));
  let list = items;
  let dirty = false;
  let timer = null;
  const redraw = () => {
    timer = null;
    if (!dirty || !alive()) return;
    dirty = false;
    const el = $('cloudList'); const top = el.scrollTop;
    renderCloudItems(list, have);
    el.scrollTop = top;
    if (cacheKey) cacheList(cacheKey, list);
  };
  let i = 0;
  const worker = async () => {
    while (i < todo.length && alive()) {
      const it = todo[i++];
      try {
        const sub = await sync.listPublic(it.id, cloudConfig.googleApiKey);
        if (!alive()) return;
        const subFolders = sub.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
        const bks = bestBooks(sub);
        if (!subFolders.length && bks.length) {
          const rows = bks.map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0, pub: true, rk: f.resourceKey || '', cat }));
          list = list.flatMap((x) => (x === it ? rows : [x]));
          dirty = true; timer ||= setTimeout(redraw, 400);
          continue;
        }
        const n = bks.length + subFolders.length;
        if (!n) continue;
        extraCounts[it.id] = n;
        it.note = `${n} cuốn`;
        const el = alive() && document.querySelector(`#cloudList [data-id="${CSS.escape(it.id)}"] .sz`);
        if (el) el.textContent = it.note;
        if (cacheKey) { dirty = true; timer ||= setTimeout(redraw, 400); }
      } catch { /* bỏ qua, lần sau đếm lại */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  if (timer) { clearTimeout(timer); redraw(); }
  const mine = {};
  try { Object.assign(mine, JSON.parse(localStorage.getItem(K_PUBCOUNTS) || '{}')); } catch { /* bỏ qua */ }
  for (const it of todo) if (extraCounts[it.id]) mine[it.id] = extraCounts[it.id];
  try { localStorage.setItem(K_PUBCOUNTS, JSON.stringify(mine)); } catch { /* bộ nhớ đầy */ }
}
// Thư mục đang xem thuộc kho thêm chưa có trong danh mục → duyệt trực tiếp
const isLiveFolder = (cur) => !!cur && (cur.live || (extraLibs().some((x) => x.id === cur.id) && !catalog?.f?.some((f) => f[0] === cur.id)));
const FMT_ORDER = { epub: 0, azw3: 1, kf8: 1, mobi: 2, azw: 3, prc: 4, pdf: 5 };
function bestBooks(files) {
  const best = new Map();
  for (const f of files) {
    if (f.mimeType === 'application/vnd.google-apps.folder' || !sync.isBook(f.name, f.mimeType)) continue;
    const k = f.name.replace(/\.[a-z0-9]+$/i, '').normalize('NFC').trim().toLowerCase();
    const rank = (n) => FMT_ORDER[(n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] ?? 9;
    if (!best.has(k) || rank(f.name) < rank(best.get(k).name)) best.set(k, f);
  }
  return [...best.values()];
}
// Liệt kê 1 thư mục của kho thêm. Thư mục con chỉ chứa sách (Calibre: "Tên sách (123)/sách.epub") → hiện thẳng cuốn sách.
async function liveExtraList(folderId, cat, expand = true) {
  const key = cloudConfig.googleApiKey;
  await loadExtraCounts();
  const raw = await sync.listPublic(folderId, key);
  const folders = raw.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
  const books = bestBooks(raw);
  const shown = [];
  if (expand && folders.length && folders.length <= 60) {
    let i = 0;
    const kids = new Array(folders.length);
    const worker = async () => { while (i < folders.length) { const k = i++; try { kids[k] = await sync.listPublic(folders[k].id, key); } catch { kids[k] = null; } } };
    await Promise.all(Array.from({ length: Math.min(8, folders.length) }, worker));
    folders.forEach((f, k) => {
      const sub = kids[k];
      const subBooks = sub ? bestBooks(sub) : [];
      if (sub && subBooks.length && !sub.some((x) => x.mimeType === 'application/vnd.google-apps.folder')) books.push(...subBooks);
      else shown.push(f);
    });
  } else shown.push(...folders);
  const by = (a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true });
  return [
    ...shown.map((f) => ({ id: f.id, name: f.name, isFolder: true, live: true, note: countNote(f.id) })).sort(by),
    ...books.map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0, pub: true, rk: f.resourceKey || '', cat })).sort(by),
  ];
}
// Thư mục trong danh mục → danh sách mục (thư mục trước, sách sau)
function catalogList(c, folderId) {
  const idx = folderId ? c.f.findIndex((f) => f[0] === folderId) : -1;
  // Số cuốn của mỗi thư mục, tính cả thư mục con (kho sách thêm có nhiều tầng)
  const count = new Map();
  for (const b of c.b) for (let i = b[3], d = 0; i >= 0 && d < 20; i = c.f[i][2], d++) count.set(i, (count.get(i) || 0) + 1);
  const folders = c.f.map((f, i) => [f, i]).filter(([f]) => f[2] === idx)
    .map(([f, i]) => ({ id: f[0], name: f[1], isFolder: true, icon: f[3] === 1 ? '🌳' : idx === -1 ? '🏷️' : '📁', note: count.get(i) ? `${count.get(i)} cuốn` : countNote(f[0]), kho: f[3] === 1 }));
  const books = c.b.filter((b) => b[3] === idx).map(catalogBook(c));
  const by = (a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true });
  // Ở gốc: các kho sách thêm đứng đầu, rồi tới thể loại
  return [...folders.sort((a, b) => (b.kho - a.kho) || by(a, b)), ...books.sort(by)];
}
// Thể loại của 1 cuốn = thư mục cấp đầu (thư viện chính) hoặc thư mục ngay dưới gốc kho sách thêm
function catalogCat(c, i) {
  for (let d = 0; i >= 0 && d < 20; d++) {
    const p = c.f[i][2];
    if (p === -1 || c.f[p]?.[3] === 1) return c.f[i][1];
    i = p;
  }
  return '';
}
const catalogBook = (c) => (b) => ({ id: b[0], name: b[1], size: b[2], pub: true, rk: b[4] || '', cat: catalogCat(c, b[3]) });
function catalogSearch(c, q) {
  const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const words = norm(q).split(/\s+/).filter(Boolean);
  return c.b.filter((b) => { const n = norm(b[1]); return words.every((w) => n.includes(w)); })
    .slice(0, 300).map(catalogBook(c));
}
async function downloadAndOpenPublic(it) {
  try {
    toast(`Đang tải “${it.name}”…`, null, null, 0);
    const buf = await sync.downloadPublic(it.id, cloudConfig.googleApiKey, it.rk);
    const fileName = /\.(epub|pdf)$/i.test(it.name) || KINDLE_EXT.test(it.name) ? it.name
      : `${it.name}${isPdfBuffer(buf) ? '.pdf' : isKindleBuffer(buf) ? '.mobi' : '.epub'}`;
    const { id } = await importBuffer(buf, fileName, { provider: 'gdrive', id: it.id });
    if (it.cat) setCategory(id, it.cat, true);
    hideToast();
    $('cloudDialog').close();
    openBook(id);
  } catch (e) {
    console.error(e);
    toast(`Không tải được: ${sync.errorText(e)}`, null, null, 6000);
  }
}
// Chủ thư viện: lập lại danh mục (tối đa 6 giờ/lần) để người khác thấy sách mới
const extraLibs = () => (cloudConfig.extraLibraries || []).filter((x) => x?.id);
async function refreshCatalogAsOwner(force = false) {
  if (!cloudConfig.libraryFolderId || !(await sync.hasFullDrive())) return;
  // Đổi danh sách kho (vd. vừa thêm "Kho sách 2") → lập lại danh mục ngay, không chờ đủ 6 giờ
  const cfgKey = `2|${extraLibs().map((x) => `${x.id}:${x.name}`).join(',')}`;
  if (lsGet('catalogCfg', '') !== cfgKey) force = true;
  if (!force && Date.now() - lsGet('catalogBuiltAt', 0) < 6 * 60 * 60 * 1000) return;
  lsSet('catalogBuiltAt', Date.now());
  try {
    const c = await sync.buildCatalog(cloudConfig.libraryFolderId, extraLibs());
    lsSet('catalogCfg', cfgKey);
    const fileId = await sync.saveCatalog(c, cloudConfig.libraryFolderId);
    console.info(`Danh mục thư viện: ${c.f.length} thư mục, ${c.b.length} cuốn → tệp ${fileId}`);
    return { ...c, fileId };
  } catch (e) {
    lsSet('catalogBuiltAt', 0);
    console.warn('Không lập được danh mục thư viện', e);
    return null;
  }
}
window.treeRefreshCatalog = () => refreshCatalogAsOwner(true);

async function showCloudFolder() {
  cloudNav.searching = false;
  lsSet(cloudNav.catalog ? K_CATNAV : K_CLOUDNAV, cloudNav.stack);
  const cur = cloudNav.stack[cloudNav.stack.length - 1];
  if (cloudNav.catalog) {
    $('cloudTitle').textContent = cur ? cur.name : (cloudConfig.libraryName || 'Thư viện');
    $('cloudPath').textContent = cloudNav.stack.length ? ['…', ...cloudNav.stack.map((s) => s.name)].slice(-3).join(' / ') : `${cloudConfig.libraryOwner ? `của ${cloudConfig.libraryOwner}` : ''}`;
    $('cloudUp').querySelector('span').textContent = cloudNav.stack.length ? 'Quay lại' : 'Đóng';
    const mine = !cur ? [{ id: MY_DRIVE, name: 'Sách trong Google Drive của bạn', isFolder: true, icon: '☁️', note: 'chọn tệp' }] : [];
    if (cur && (await loadCatalog().catch(() => null), isLiveFolder(cur))) {
      // Kho thêm: duyệt trực tiếp; thể loại = thư mục ngay dưới gốc kho
      const rootAt = cloudNav.stack.findIndex((s) => extraLibs().some((x) => x.id === s.id));
      const cat = rootAt >= 0 ? (cloudNav.stack[rootAt + 1]?.name || '') : '';
      // Ở gốc kho (danh sách thể loại) không mở sẵn thư mục con cho nhanh
      let shownItems = [];
      await loadCloudItems(async () => (shownItems = await liveExtraList(cur.id, cat, rootAt !== cloudNav.stack.length - 1)), `pub:${cur.id}`);
      if (cloudNav.stack[cloudNav.stack.length - 1] === cur) fillLiveCounts(shownItems, `pub:${cur.id}`, cat);
      return;
    }
    await loadCloudItems(async () => [...mine, ...catalogList(await catalogWithExtras(), cur?.id || null)]);
    return;
  }
  $('cloudTitle').textContent = cur ? cur.name : sync.currentUser().providerName;
  $('cloudPath').textContent = cloudNav.stack.length ? ['…', ...cloudNav.stack.map((s) => s.name)].slice(-3).join(' / ') : 'Thư mục gốc';
  $('cloudUp').querySelector('span').textContent = cloudNav.stack.length ? 'Quay lại' : 'Đóng'; // ở thư mục gốc: nút này đóng menu
  // Gốc Google Drive: thư viện chung đứng đầu để vào thẳng kho sách
  const lib = !cur && sync.currentUser().provider === 'gdrive' && cloudConfig.libraryFolderId
    ? [{ id: cloudConfig.libraryFolderId, name: cloudConfig.libraryName || 'Thư viện', isFolder: true, icon: '🌳', note: 'kho sách' },
      ...extraLibs().map((x) => ({ id: x.id, name: x.name, isFolder: true, icon: '🌳', note: 'kho sách' }))] : [];
  await loadCloudItems(async () => [...lib, ...(await sync.listFolder(cur?.id || null))], `${sync.currentUser().provider}:${cur?.id || 'root'}`);
}
let cloudLoadSeq = 0;
async function loadCloudItems(loader, cacheKey = '') {
  const list = $('cloudList');
  const seq = ++cloudLoadSeq;
  const cached = cacheKey && cloudCache.get(cacheKey);
  const books = await db.all('books');
  const have = new Set(books.map((b) => b.source?.id).filter(Boolean));
  if (cached) { renderCloudItems(cached, have); $('cloudStatus').textContent = ''; list.scrollTop = 0; }
  else { list.innerHTML = ''; $('cloudStatus').textContent = 'Đang tải danh sách…'; }
  try {
    const items = await loader();
    if (seq !== cloudLoadSeq) return; // đã sang thư mục khác
    if (cacheKey) {
      const changed = JSON.stringify(items) !== JSON.stringify(cached);
      cacheList(cacheKey, items);
      if (cached && !changed) return;
    }
    $('cloudStatus').textContent = items.length ? '' : 'Không có thư mục con hay tệp EPUB/PDF nào ở đây.';
    renderCloudItems(items, have);
  } catch (e) {
    if (seq !== cloudLoadSeq) return;
    $('cloudStatus').textContent = cached ? `Đang xem danh sách đã lưu (chưa cập nhật được: ${sync.errorText(e)})` : `Lỗi: ${sync.errorText(e)}`;
  }
}
function renderCloudItems(items, have) {
  const list = $('cloudList');
  list.innerHTML = '';
  {
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cloud-item${have.has(it.id) ? ' have' : ''}`;
      b.dataset.id = it.id;
      const size = it.isFolder ? esc(it.note || '') : have.has(it.id) ? 'Đã có' : `${(it.size / 1048576).toFixed(1)} MB`;
      const cat = it.cat ? `<small class="cloud-cat">${esc(it.cat)}</small>` : '';
      b.innerHTML = `<span class="ic">${it.icon || (it.isFolder ? '📁' : /\.pdf$/i.test(it.name) ? '📄' : '📖')}</span><span class="nm">${esc(it.name)}${cat}</span><span class="sz">${size}</span>`;
      b.onclick = it.id === MY_DRIVE ? () => { $('cloudDialog').close(); openDriveDialog(sync.currentUser()); }
        : it.isFolder ? () => { cloudNav.stack.push(it.live ? { id: it.id, name: it.name, live: true } : { id: it.id, name: it.name }); $('cloudSearch').value = ''; showCloudFolder(); }
          : it.pub ? () => downloadAndOpenPublic(it) : () => downloadAndOpen(it.id, it.name);
      list.appendChild(b);
    }
  }
}
/* ----- Dock: Trang chủ / Google Drive / Thêm sách / Thiết bị khác ----- */
let libTab = 'home';
function setLibTab(tab) {
  libTab = tab;
  $('library').classList.toggle('tab-remote', tab === 'remote');
  $('dockHome').toggleAttribute('aria-current', tab === 'home');
  $('dockRemote').toggleAttribute('aria-current', tab === 'remote');
  if (tab === 'home') $('dockHome').setAttribute('aria-current', 'page');
  if (tab === 'remote') $('dockRemote').setAttribute('aria-current', 'page');
  document.querySelector('#library .lib-main').scrollTop = 0;
  renderLibrary();
}
$('dockHome').onclick = () => setLibTab('home');
$('dockRemote').onclick = () => setLibTab('remote');

$('btnCloud').onclick = async () => {
  const u = sync.currentUser();
  if (!u || u.needsReconnect) { $('btnAccount').click(); return; } // chưa đăng nhập Drive → mở phần đăng nhập
  // Google Drive (quyền drive.file): chọn sách bằng Google Picker; còn quyền đọc cả Drive → duyệt trong app
  // Người dùng khác (không có quyền đọc cả Drive): duyệt thư viện bằng danh mục công khai, không qua trang Google
  if (u.provider === 'gdrive' && catalogReady() && !(await sync.hasFullDrive())) { openCloudBrowser(u, true); return; }
  if (u.provider === 'gdrive' && await sync.lacksDrive()) {
    toast('App chưa có quyền Google Drive — bấm Cấp quyền, tick đủ các ô',
      'Cấp quyền', () => authAction(() => sync.grantDrive()), 15000);
    return;
  }
  if (u.provider === 'gdrive' && pickerReady() && !(await sync.hasFullDrive())) { openDriveDialog(u); return; }
  openCloudBrowser(u);
};
// Mở trình duyệt Drive trong app: lần đầu vào thẳng thư viện, sau đó mở lại đúng thư mục đang xem.
// Nút Back của điện thoại/trình duyệt: lùi 1 thư mục, ở thư mục gốc thì đóng.
function openCloudBrowser(u, useCatalog = false) {
  if (useCatalog !== cloudNav.catalog) {
    cloudNav.catalog = useCatalog;
    cloudNav.stack = lsGet(useCatalog ? K_CATNAV : K_CLOUDNAV, null) || [];
  }
  if (!useCatalog && lsGet(K_CLOUDNAV, null) == null && u.provider === 'gdrive' && cloudConfig.libraryFolderId) {
    cloudNav.stack = [{ id: cloudConfig.libraryFolderId, name: cloudConfig.libraryName || 'Thư viện' }];
  }
  $('cloudDialog').showModal();
  try { if (!history.state?.cloud) history.pushState({ ...(history.state || {}), cloud: 1 }, ''); } catch { /* bỏ qua */ }
  showCloudFolder();
}
if (location.hostname === 'localhost') window.__catalogBrowser = () => openCloudBrowser(null, true); // chỉ để thử trên máy
$('cloudDialog').addEventListener('close', () => {
  if (history.state?.cloud) history.back(); // bỏ mốc "đang mở Drive" khỏi lịch sử
});
addEventListener('popstate', () => {
  if (!$('cloudDialog').open) return;
  if (cloudNav.stack.length) {
    cloudNav.stack.pop();
    showCloudFolder();
    try { history.pushState({ ...(history.state || {}), cloud: 1 }, ''); } catch { /* bỏ qua */ }
  } else $('cloudDialog').close();
});

/* ----- Google Drive: Google Picker + thư viện chung ----- */
function openDriveDialog(u) {
  $('driveWho').textContent = u.email || '';
  const lib = libraryUrl();
  $('libBox').hidden = !lib;
  document.querySelectorAll('#driveDialog .lib-name').forEach((el) => { el.textContent = cloudConfig.libraryName || 'thư viện'; });
  $('libOwner').textContent = cloudConfig.libraryOwner || 'chủ thư viện';
  // Trang chọn sách toàn màn hình của Google không mở thẳng được thư mục thư viện → chỉ đường
  $('pickHint').innerHTML = needsOnePick()
    ? `Trang chọn tệp của Google sẽ mở ra (Google hỏi <b>Cho phép truy cập</b> → bấm đồng ý). Chọn sách xong bấm <b>Chèn</b>. Muốn vào thẳng kho sách: bấm <b>Mở ${esc(cloudConfig.libraryName || 'thư viện')}</b> bên dưới.`
    : 'Chọn một hoặc nhiều cuốn (EPUB, PDF, MOBI, AZW3) trong Drive của bạn, mục <b>Được chia sẻ với tôi</b> hoặc thư viện chung.';
  $('driveDialog').showModal();
}
// Trang đang "cô lập" (Chrome/Edge, để giọng AI chạy đa luồng) thì khung Google Picker bị chặn →
// tải lại 1 lần ở chế độ thường (?chon-sach) rồi tự mở Picker.
const K_PICK = 'pendingPick';
let noIsolateNow = false;
// Safari (iPhone/iPad/Mac, kể cả Chrome trên iPhone) chặn cookie của Google trong khung Picker nhúng
// → dùng trang chọn sách toàn màn hình của Google (sync.startOnePick)
const needsOnePick = () => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return true;
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
};
async function importPickedFiles({ ids, token }) {
  let added = 0; let lastId = null;
  for (const [i, fid] of ids.entries()) {
    try {
      toast(`Đang tải ${ids.length > 1 ? `${i + 1}/${ids.length} ` : ''}sách từ Google Drive…`, null, null, 0);
      const { name, mimeType, buf } = await sync.downloadPicked(fid, token);
      if (!/\.(epub|pdf|mobi|azw3|azw|prc|kf8)$/i.test(name) && !['application/epub+zip', 'application/pdf', ...KINDLE_MIME].includes(mimeType)
        && !isPdfBuffer(buf) && !isKindleBuffer(buf)) {
        toast(`Bỏ qua “${name}” — không phải sách EPUB, PDF, MOBI hoặc AZW3`, null, null, 4000);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      const { id, isNew } = await importBuffer(buf, name, { provider: 'gdrive', id: fid });
      sync.fileCategoryInfo(fid).then((c) => setCategory(id, c.name, c.main)).catch(() => {});
      if (isNew) added++;
      lastId = id;
    } catch (e) {
      console.error(e);
      toast(`Không tải được sách: ${sync.errorText(e)}`, null, null, 6000);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  hideToast();
  renderLibrary();
  if (ids.length === 1 && lastId) openBook(lastId);
  else if (ids.length > 1) toast(added ? `Đã thêm ${added} cuốn vào thư viện` : 'Các cuốn này đã có trong thư viện', null, null, 3000);
}
async function pickFromDrive(library) {
  $('driveDialog').close();
  if (inAppBrowser()) { toast('Google không cho chọn sách trong Zalo/Messenger/Facebook — hãy mở link bằng Safari hoặc Chrome', null, null, 8000); return; }
  if (needsOnePick()) {
    toast('Đang mở trang chọn sách của Google…', null, null, 0);
    // Thư viện: mở thẳng danh sách thể loại ("Ebook sách" đứng đầu để vẫn vào được thể loại mới thêm)
    const libIds = cloudConfig.libraryFolderId ? [cloudConfig.libraryFolderId, ...extraLibs().map((x) => x.id), ...LIBRARY_CATEGORIES.map(([id]) => id)] : [];
    sync.startOnePick({ folderId: library ? libIds.join(',') : '' });
    return;
  }
  if (window.crossOriginIsolated) {
    try { sessionStorage.setItem(K_PICK, library ? 'lib' : 'mine'); } catch { /* bỏ qua */ }
    toast('Đang mở Google Drive…', null, null, 0);
    location.href = `${location.pathname}?chon-sach`;
    return;
  }
  let docs;
  try {
    docs = await pickBooks(await sync.accessToken(), { library, email: sync.currentUser()?.email, onBack: () => openDriveDialog(sync.currentUser()) });
  } catch (e) {
    console.error(e);
    toast(`Không mở được Google Drive: ${sync.errorText(e)}`);
    return;
  }
  if (!docs.length) return; // đóng cửa sổ chọn sách mà không chọn gì
  const books = docs.filter((d) => /\.(epub|pdf|mobi|azw3|azw|prc|kf8)$/i.test(d.name || '')
    || ['application/epub+zip', 'application/pdf', ...KINDLE_MIME].includes(d.mimeType));
  if (docs.length && !books.length) { toast('Tệp đã chọn không phải sách EPUB, PDF, MOBI hoặc AZW3'); return; }
  if (books.length === 1) { downloadAndOpen(books[0].id, books[0].name); return; }
  // Chọn nhiều cuốn: thêm hết vào thư viện, không mở
  let added = 0;
  for (const [i, d] of books.entries()) {
    try {
      toast(`Đang tải ${i + 1}/${books.length}: “${d.name}”…`, null, null, 0);
      const buf = await sync.download(d.id);
      const { id, isNew } = await importBuffer(buf, d.name, { provider: 'gdrive', id: d.id });
      sync.fileCategoryInfo(d.id).then((c) => setCategory(id, c.name, c.main)).catch(() => {});
      if (isNew) added++;
    } catch (e) {
      console.error(e);
      toast(`Không tải được “${d.name}”: ${sync.errorText(e)}`, null, null, 6000);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  renderLibrary();
  toast(added ? `Đã thêm ${added} cuốn vào thư viện` : 'Các cuốn này đã có trong thư viện', null, null, 3000);
}
// Vừa tải lại ở chế độ thường để chọn sách → bỏ tham số khỏi địa chỉ, mở Picker
if (new URLSearchParams(location.search).has('chon-sach')) {
  noIsolateNow = true;
  history.replaceState(null, '', location.pathname + location.hash);
  let pending = null;
  try { pending = sessionStorage.getItem(K_PICK); sessionStorage.removeItem(K_PICK); } catch { /* bỏ qua */ }
  if (pending && !window.crossOriginIsolated) setTimeout(() => pickFromDrive(pending === 'lib'), 300);
}
$('driveClose').onclick = () => $('driveDialog').close();
$('drivePick').onclick = () => pickFromDrive(false);
$('libOpen').onclick = () => pickFromDrive(true);
$('libRequest').onclick = () => window.open(libraryUrl(), '_blank', 'noopener');
$('cloudClose').onclick = () => $('cloudDialog').close();
$('cloudUp').onclick = () => {
  if (cloudNav.searching) { $('cloudSearch').value = ''; showCloudFolder(); return; } // thoát kết quả tìm
  if (!cloudNav.stack.length) { $('cloudDialog').close(); return; } cloudNav.stack.pop(); showCloudFolder(); };
$('cloudSearchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('cloudSearch').value.trim();
  if (!q) { showCloudFolder(); return; }
  $('cloudTitle').textContent = `Tìm “${q}”`;
  $('cloudPath').textContent = sync.currentUser()?.providerName || '';
  $('cloudUp').querySelector('span').textContent = 'Quay lại';
  cloudNav.searching = true;
  if (cloudNav.catalog) { $('cloudPath').textContent = cloudConfig.libraryName || 'Thư viện'; loadCloudItems(async () => catalogSearch(await catalogWithExtras(), q)); return; }
  loadCloudItems(() => sync.search(q));
};

// Thêm một tệp EPUB/PDF (từ máy hoặc từ đám mây) vào thư viện. Trả về { id, isNew }.
async function importBuffer(buf, fileName, source) {
  const id = hashBuffer(buf);
  const existing = await db.get('books', id);
  if (existing) {
    if (source && !existing.source) await db.put('books', { ...existing, source });
    return { id, isNew: false };
  }
  if (isPdfBuffer(buf)) {
    const info = await pdfInfo(buf);
    const title = info.title || fileName.replace(/\.pdf$/i, '').trim();
    const author = info.author;
    await db.put('files', { id, data: buf });
    await db.put('books', {
      id, title, author, cover: info.cover, format: 'pdf', pages: info.pages,
      addedAt: Date.now(), fileName, size: buf.byteLength, ...(source ? { source } : {}),
    });
    sync.push(id, { title, author, ...(source ? { source } : {}) }).catch(() => {});
    return { id, isNew: true };
  }
  // Sách Kindle (MOBI/AZW3/PRC): chuyển sang EPUB rồi xử lý như EPUB.
  // Mã sách (id) vẫn băm từ tệp gốc để cùng một tệp trên mọi thiết bị luôn khớp nhau.
  let origFormat = null;
  if (isKindleBuffer(buf)) {
    toast(`Đang chuyển “${fileName}” sang EPUB…`, null, null, 0);
    origFormat = (fileName.match(KINDLE_EXT)?.[1] || 'mobi').toLowerCase();
    ({ epub: buf } = await kindleToEpub(buf, fileName));
  }
  const book = ePub(buf.slice(0));
  await book.ready;
  const meta = await book.loaded.metadata;
  let cover = null;
  try {
    const url = await book.coverUrl();
    if (url) cover = await (await fetch(url)).blob();
  } catch { /* sách không có bìa */ }
  book.destroy();
  const title = (meta.title || fileName.replace(/\.epub$/i, '').replace(KINDLE_EXT, '')).trim();
  const author = (meta.creator || '').trim();
  await db.put('files', { id, data: buf });
  await db.put('books', {
    id, title, author, cover, addedAt: Date.now(), fileName, size: buf.byteLength,
    ...(origFormat ? { origFormat } : {}), ...(source ? { source } : {}),
  });
  sync.push(id, { title, author, ...(source ? { source } : {}) }).catch(() => {});
  return { id, isNew: true };
}

async function importFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!/\.(epub|pdf)$/i.test(file.name) && !KINDLE_EXT.test(file.name)
      && !['application/epub+zip', 'application/pdf', ...KINDLE_MIME].includes(file.type)) {
      toast(`Bỏ qua “${file.name}” — không phải tệp EPUB, PDF, MOBI, AZW3 hoặc PRC`); continue;
    }
    try {
      toast(`Đang thêm “${file.name}”…`, null, null, 0);
      const { isNew } = await importBuffer(await file.arrayBuffer(), file.name, null);
      if (isNew) added++; else toast(`“${file.name}” đã có trong thư viện`);
    } catch (e) {
      console.error(e);
      toast(`Không đọc được “${file.name}”: ${e.message || e}`);
    }
  }
  if (added) toast(added === 1 ? 'Đã thêm sách' : `Đã thêm ${added} cuốn sách`, null, null, 2500);
  renderLibrary();
}

$('fileInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
// iPhone/iPad làm mờ các đuôi tệp lạ (.azw3, .mobi…) nếu giữ "accept" → bỏ đi, importFiles tự lọc
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  $('fileInput').removeAttribute('accept');
}

// Kéo thả tệp (Mac / máy tính)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
});

/* ================= Trình đọc ================= */
const R = {
  id: null, book: null, rendition: null, meta: null,
  cfi: null, percent: 0, toc: [], flatToc: [],
  lastSavedAt: 0, skipNextSave: false,
  unwatch: () => {}, pushTimer: null, pendingPush: null,
};

if (location.hostname === 'localhost') window.__R = R; // chỉ để kiểm thử trên máy (không có trên trang web thật)

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === name);
}

async function openBook(id) {
  const [file, meta, local] = await Promise.all([db.get('files', id), db.get('books', id), db.get('progress', id)]);
  if (!file) { toast('Không tìm thấy tệp sách trên máy này'); lastBook.forget(id); return; }
  lastBook.remember(id);
  Object.assign(R, { id, meta, cfi: null, percent: local?.percent || 0, toc: [], flatToc: [] });
  R.kind = meta.format === 'pdf' ? 'pdf' : 'epub';
  showView('reader');
  $('reader').classList.remove('immersive');
  $('reader').classList.toggle('is-pdf', R.kind === 'pdf');
  $('fontLabel').textContent = R.kind === 'pdf' ? 'Phóng to' : 'Cỡ chữ';
  $('rTitle').textContent = meta.title;
  $('rChapter').textContent = meta.author || '';
  $('progressText').textContent = 'Đang mở…';
  $('syncText').textContent = '';
  $('progressSlider').disabled = true;
  renderToc();

  if (R.kind === 'epub') {
    R.book = ePub(file.data);
    // Chạy sau hook thay thế tài nguyên của epub.js (hook đó ghi đè section.output từ bản gốc), nên đợi 1 microtask.
    R.book.spine.hooks.serialize.register((output, section) =>
      Promise.resolve().then(() => { section.output = sanitizeSection(section.output); }));
    R.book.loaded.navigation.then((nav) => { R.toc = nav.toc; R.flatToc = flatten(nav.toc); renderToc(); }).catch(() => {});
  }

  // Mở ngay tại vị trí đã lưu trên máy này (không chờ đám mây); vị trí trên đám mây kiểm tra ngầm song song
  // line = đúng câu đang đọc (CFI của câu) → máy khác mở ra đúng trang chứa câu đó và đọc tiếp từ câu đó
  const remoteP = sync.currentUser() ? sync.fetchOne(id).catch(() => null) : Promise.resolve(null);
  const start = local?.line || local?.cfi || null;
  R.line = local?.line || null;
  R.lastSavedAt = local?.updatedAt || 0;
  R.movedSinceOpen = false;
  R.openedAt = performance.now();

  if (R.kind === 'pdf') { if (!(await openPdfReader(file.data, start))) return; }
  else await createRendition(start);
  R.openMs = Math.round(performance.now() - R.openedAt);
  updateSyncText();
  wakeUpdate(true);
  remoteP.then((remote) => applyRemoteOnOpen(id, local, remote));

  R.unwatch = sync.watchOne(id, onRemoteChange);
  if (R.kind === 'epub') {
    // Tính số trang/phần trăm khi máy rảnh, sau khi trang đầu đã hiện (không làm khựng lúc mở)
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
    idle(() => { if (R.id === id) loadLocations(id); }, { timeout: 2500 });
  }
  // Nạp sẵn giọng AI lúc vừa mở sách (khi máy sẽ dùng nó) → lúc bấm 🔊 / khoá màn hình không phải nạp trùng lúc phát
  if (bgAiOn() && aiStored[settings.bgVoice] && (aiAlways() || /Android/i.test(navigator.userAgent))) {
    setTimeout(() => { if (R.id === id) aiWarmup(settings.bgVoice).catch(() => {}); }, 1500);
  }
}

/* ----- Giữ màn hình sáng khi đang đọc (tự thôi sau 10 phút không lật trang, trừ khi đang nghe đọc) ----- */
let wakeLock = null, wakeBusy = false, wakeTouch = 0;
async function wakeUpdate(activity) {
  if (activity) wakeTouch = Date.now();
  if (!('wakeLock' in navigator) || wakeBusy) return;
  const playing = typeof speaker !== 'undefined' && speaker?.state === 'playing';
  const want = !!R.id && !document.hidden && (playing || Date.now() - wakeTouch < 10 * 60 * 1000);
  wakeBusy = true;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch { wakeLock = null; } finally { wakeBusy = false; }
}
setInterval(() => wakeUpdate(false), 60 * 1000);

/* ----- Thời gian đọc: "còn ~X phút hết chương" + thống kê mỗi ngày ----- */
const K_STATS = 'readStats', K_SPEED = 'readSpeed';
let stats = lsGet(K_STATS, null) || { days: {}, done: [] };
let speed = lsGet(K_SPEED, null) || { key: '', samples: [] };   // giây/trang theo cỡ chữ & khổ màn hình
let lastTurn = null;                                            // { t, page, total, href, key, broken }
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const layoutKey = () => `${settings.fontSize}|${settings.lineHeight}|${settings.fontFamily}|${settings.spread}|${innerWidth}x${innerHeight}`;
let statsPushTimer = null;
function saveStats() {
  lsSet(K_STATS, stats);
  clearTimeout(statsPushTimer);
  statsPushTimer = setTimeout(() => { if (sync.currentUser()) sync.setPref('readStats', stats).catch(() => {}); }, 60 * 1000);
}
function mergeCloudStats() {
  const c = sync.getPref('readStats');
  if (!c?.days) return;
  for (const [d, sec] of Object.entries(c.days)) stats.days[d] = Math.max(stats.days[d] || 0, sec);
  if (Array.isArray(c.done)) for (const id of c.done) if (!stats.done.includes(id)) stats.done.push(id);
  lsSet(K_STATS, stats);
}
function addReadSeconds(sec) {
  if (!(sec > 0)) return;
  const k = dayKey();
  stats.days[k] = Math.round((stats.days[k] || 0) + sec);
  saveStats();
}
// Gọi mỗi lần lật trang (loc) hoặc khi đóng sách (null)
function readTick(loc) {
  const now = Date.now();
  if (lastTurn && !document.hidden) {
    const dwell = (now - lastTurn.t) / 1000;
    addReadSeconds(Math.min(dwell, 300)); // bỏ máy đó lâu: chỉ tính tối đa 5 phút
    const st = loc?.start;
    // Tốc độ đọc: chỉ lấy lượt đọc hết 1 trang rồi sang đúng trang kế trong cùng chương (bỏ lượt lật lướt < 2 giây
    // và lượt bỏ máy > 5 phút); đổi cỡ chữ/khổ màn hình → đo lại từ đầu
    const key = layoutKey();
    if (st && !lastTurn.broken && dwell >= 2 && dwell <= 300 && lastTurn.key === key
        && st.href === lastTurn.href && st.displayed?.page === lastTurn.page + 1) {
      if (speed.key !== key) speed = { key, samples: [] };
      speed.samples.push(Math.round(dwell * 10) / 10);
      if (speed.samples.length > 30) speed.samples.shift();
      lsSet(K_SPEED, speed);
    }
  }
  const st = loc?.start;
  lastTurn = loc ? { t: now, page: st?.displayed?.page, total: st?.displayed?.total, href: st?.href, key: layoutKey() } : null;
  if (R.id && R.percent >= 0.985 && !stats.done.includes(R.id)) { stats.done.push(R.id); saveStats(); }
}
document.addEventListener('visibilitychange', () => {
  if (lastTurn) {
    if (document.hidden) { addReadSeconds(Math.min((Date.now() - lastTurn.t) / 1000, 300)); lastTurn.broken = true; }
    lastTurn.t = Date.now();
  }
  wakeUpdate(!document.hidden);
});
function chapterLeftText() {
  if (R.kind !== 'epub' || !lastTurn?.total || speed.key !== layoutKey() || speed.samples.length < 3) return '';
  const sorted = [...speed.samples].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const pagesLeft = lastTurn.total - lastTurn.page;
  if (pagesLeft <= 0) return 'trang cuối chương';
  const min = Math.round((pagesLeft * med) / 60);
  return min < 1 ? 'còn < 1 phút hết chương' : `còn ~${min} phút hết chương`;
}
function openStats() {
  mergeCloudStats();
  const fmt = (sec) => { const m = Math.round(sec / 60); return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${m % 60 ? `${m % 60} phút` : ''}`.trim(); };
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const vals = days.map((d) => stats.days[dayKey(d)] || 0);
  const max = Math.max(60, ...vals);
  const names = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  $('statsBars').innerHTML = days.map((d, i) => `<div class="sb"><span class="sb-v">${vals[i] >= 60 ? Math.round(vals[i] / 60) : ''}</span><i style="height:${Math.max(3, (vals[i] / max) * 100)}%"></i><span class="sb-d">${i === 6 ? 'Nay' : names[d.getDay()]}</span></div>`).join('');
  // Chuỗi ngày đọc liên tiếp (tính từ hôm nay, hoặc từ hôm qua nếu hôm nay chưa đọc)
  let streak = 0;
  const d = new Date();
  if ((stats.days[dayKey(d)] || 0) < 60) d.setDate(d.getDate() - 1);
  while ((stats.days[dayKey(d)] || 0) >= 60) { streak++; d.setDate(d.getDate() - 1); }
  const week = vals.reduce((a, b) => a + b, 0);
  const all = Object.values(stats.days).reduce((a, b) => a + b, 0);
  $('statsNums').innerHTML = [
    ['Hôm nay', fmt(vals[6])], ['7 ngày qua', fmt(week)], ['Chuỗi ngày đọc', `${streak} ngày`],
    ['Sách đã đọc xong', `${stats.done.length} cuốn`], ['Tổng thời gian', fmt(all)],
  ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  $('statsDialog').showModal();
}

/* ----- Giữ sách đã tải không bị trình duyệt tự xoá khi máy đầy bộ nhớ ----- */
if (navigator.storage?.persist) navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
async function showStorageInfo() {
  try {
    const [est, kept] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
    const mb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
    $('storageInfo').textContent = `Sách & dữ liệu trên máy: ${mb(est.usage || 0)} · ${kept ? 'được giữ lâu dài' : 'máy có thể tự xoá khi đầy bộ nhớ (cài app ra màn hình chính để giữ)'}`;
  } catch { $('storageInfo').textContent = ''; }
}

/* ----- PDF ----- */
// Vị trí trong PDF được lưu/đồng bộ dạng "page:<số trang>" (cùng trường với CFI của EPUB)
const pageOf = (cfi) => { const m = /^page:(\d+)/.exec(cfi || ''); return m ? Number(m[1]) : 1; };

async function openPdfReader(data, startCfi) {
  $('viewer').innerHTML = '';
  let doc;
  try {
    doc = await openPdf(data);
  } catch (e) {
    console.error(e);
    toast(`Không mở được PDF: ${e.message || e}`);
    lastBook.forget(R.id);
    closeBook();
    return false;
  }
  R.skipNextSave = true; // lần hiển thị đầu không tính là "đọc tiếp"
  R.pdf = new PdfReader({
    container: $('viewer'),
    doc,
    getSettings: () => settings,
    onLocation: onPdfLocation,
    onTap: (x) => tapAt(x),
    onZoom: (z) => {
      $('fontSizeVal').textContent = `${Math.round(z * 100)}%`;
      toast(`Phóng to ${Math.round(z * 100)}%`, null, null, 1000);
    },
  });
  applyChrome();
  R.pdf.outline().then((items) => {
    R.flatToc = items;
    renderToc();
    if (R.pdf) onPdfLocation(R.pdf.page, R.pdf.pages, true);
  }).catch(() => {});
  await R.pdf.start(pageOf(startCfi));
  $('progressSlider').disabled = false;
  return true;
}

function onPdfLocation(page, pages, labelOnly) {
  R.cfi = `page:${page}`;
  R.percent = pages > 1 ? (page - 1) / (pages - 1) : 1;
  // Mục lục: mục có số trang lớn nhất mà không vượt quá trang hiện tại
  let ch = null;
  for (const t of R.flatToc) if (t.page <= page && (!ch || t.page >= ch.page)) ch = t;
  $('rChapter').textContent = ch?.label || `Trang ${page}/${pages}`;
  document.querySelectorAll('#tocList a').forEach((a, i) => a.classList.toggle('current', R.flatToc[i] === ch));
  updateProgressUI();
  if (labelOnly) return;
  if (!R.skipNextSave) R.movedSinceOpen = true;
  readTick({ start: {} });
  wakeUpdate(true);
  if (R.skipNextSave) { R.skipNextSave = false; return; }
  saveProgress(ch?.label || `Trang ${page}`);
}

function goToLocation(cfi) {
  if (R.kind === 'pdf') R.pdf?.goTo(pageOf(cfi));
  else R.rendition?.display(cfi);
}

async function createRendition(cfi) {
  // Đang đọc to mà dựng lại trang (đổi cỡ chữ, nền…) → dừng rồi đọc tiếp sau khi dựng xong
  if (speaker && speaker.state !== 'idle') { ttsRestartAfterRender = speaker.state === 'playing'; speaker.stop(true); ttsUI('idle'); }
  if (R.rendition) { R.rendition.destroy(); R.rendition = null; }
  $('viewer').innerHTML = '';
  // Truyện tranh bố cục cố định: bỏ lề trái/phải của khung đọc → trang truyện to hết bề ngang màn hình
  try { await R.book.loaded?.metadata; } catch { /* bỏ qua */ }
  $('reader').classList.toggle('fxl', R.book.package?.metadata?.layout === 'pre-paginated');
  const scrolled = settings.flow === 'scrolled-doc';
  const rendition = R.book.renderTo('viewer', {
    width: '100%', height: '100%',
    flow: settings.flow,
    // "continuous": epub.js nạp sẵn chương kế bên cạnh chương đang đọc → sang chương mới cũng trượt mượt
    // như lật trang thường (không phải xoá màn hình rồi dựng lại chương).
    manager: 'continuous',
    // Nạp sẵn chương kế/chương trước khi còn cách khoảng 4 màn hình (mặc định epub.js chỉ ~500px → lật
    // nhanh thì tới trang cuối chương mà chương kế chưa kịp nạp).
    offset: Math.min(2400, Math.max(1400, window.innerWidth * 3)),
    // 2 trang cạnh nhau chỉ khi chọn "2 trang" và màn hình đủ rộng; mặc định 1 trang
    spread: settings.spread === 'double' ? 'auto' : 'none', minSpreadWidth: 900,
    // Safari (iPhone/iPad/Mac) không chuyển sự kiện chạm/vuốt vào iframe bị sandbox thiếu "allow-scripts",
    // nên phải bật. Script trong sách vẫn bị chặn: xem sanitizeSection() (xoá <script> + CSP script-src 'none').
    allowScriptedContent: true,
  });
  R.rendition = rendition;
  // epub.js tự đặt lại khoảng nạp sẵn = 1 trang mỗi lần sắp trang → ghi đè lại giá trị lớn hơn
  rendition.started?.then(() => {
    const m = rendition.manager;
    const look = Math.min(2400, Math.max(1400, window.innerWidth * 3));
    if (!m || typeof m.updateLayout !== 'function') return;
    const orig = m.updateLayout.bind(m);
    m.updateLayout = (...args) => { const r = orig(...args); m.settings.offset = look; return r; };
    m.settings.offset = look;
  }).catch(() => {});
  rendition.hooks.content.register((contents) => { normalizeText(contents.document); injectStyle(contents); });
  rendition.on('relocated', onRelocated);
  rendition.on('click', onFrameClick);
  rendition.on('touchstart', onTouchStart);
  rendition.on('touchmove', onTouchMove);
  rendition.on('touchend', onTouchEnd);
  rendition.on('keydown', onKey);
  applyChrome();
  R.skipNextSave = true; // lần hiển thị đầu không tính là "đọc tiếp"
  try {
    await rendition.display(cfi || undefined);
  } catch (e) {
    console.warn('Vị trí không hợp lệ, mở từ đầu', e);
    await rendition.display();
  }
  // Nạp sẵn chương kế ngay khi mở (epub.js chỉ tự kiểm tra khi có cuộn trang)
  setTimeout(() => { try { if (R.rendition === rendition) rendition.manager?.check?.(); } catch { /* bỏ qua */ } }, 400);
  if (ttsRestartAfterRender) { ttsRestartAfterRender = false; setTimeout(ttsStart, 300); }
}

// Không cho mã trong sách chạy (sách có thể chứa <script> hoặc onclick=...):
// xoá script / thuộc tính on* / liên kết javascript:, và thêm CSP chặn mọi script trong trang sách.
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'"/>';
function sanitizeSection(html) {
  if (!html) return html;
  let out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => m + CSP_META);
  else out = out.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${CSP_META}</head>`);
  return out;
}

// Nhiều EPUB tiếng Việt lưu dấu dạng tổ hợp (vd "ê" + dấu sắc rời) → hiển thị dấu bị tách ("Yế u").
// Chuẩn hoá về dạng dựng sẵn (NFC) để chữ hiển thị đúng với mọi phông.
function normalizeText(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let v = n.nodeValue;
    if (/[̀-ͯ]/.test(v)) v = v.normalize('NFC');
    // Dấu cách kiểu chữ Hán (U+3000) không co lại được → thừa ở cuối đoạn sẽ lố ra ngoài mép trang
    if (v.includes('　')) v = v.replace(/　+/g, ' ');
    if (v !== n.nodeValue) n.nodeValue = v;
  }
}

function injectStyle(contents) {
  const t = THEMES[settings.theme] || THEMES.light;
  const doc = contents.document;
  let style = doc.getElementById('__reader_style');
  if (!style) {
    // Cỡ chữ gốc của sách (nhiều sách đặt body cố định theo px, vd 14.6px) — đo trước khi chèn style
    // để A+/A− phóng to/thu nhỏ theo đúng cỡ gốc đó.
    doc.documentElement.dataset.baseFs = parseFloat(contents.window.getComputedStyle(doc.body).fontSize) || 16;
    style = doc.createElement('style'); style.id = '__reader_style'; doc.head.appendChild(style);
  }
  const baseFs = Number(doc.documentElement.dataset.baseFs) || 16;
  const bodyFs = Math.round(baseFs * settings.fontSize) / 100;
  const recolor = settings.theme !== 'light';
  // Sách bố cục cố định (truyện tranh chuyển từ MOBI/AZW3: <meta name="viewport" content="width=620, height=1024">):
  // epub.js vẽ trang ở cỡ gốc rồi thu nhỏ cả trang cho vừa khung → ảnh phải lấp đúng khung gốc (không giới hạn theo
  // chiều cao màn hình), và căn trang vào giữa theo chiều dọc.
  let fxlPad = 0;
  let fxl = false;
  try {
    const vp = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
    const vw = Number(vp.match(/width\s*=\s*(\d+)/)?.[1] || 0), vh = Number(vp.match(/height\s*=\s*(\d+)/)?.[1] || 0);
    const box = $('viewer');
    // epub.js tự chèn viewport "width=<khung>, height=<khung>, initial-scale=1, …, user-scalable=no" vào MỌI chương
    // của sách thường → không được coi đó là sách tranh. Sách tranh thật: khai báo pre-paginated, hoặc viewport
    // riêng của sách (vd. MOBI/AZW3 truyện tranh: "width=620, height=1024") khác cỡ khung đọc.
    const injected = /user-scalable\s*=\s*no/.test(vp) && Math.abs(vh - box.clientHeight) <= 2;
    fxl = R.book?.package?.metadata?.layout === 'pre-paginated' || (vw > 0 && vh > 0 && !injected);
    if (fxl && vw > 0 && vh > 0) {
      const sc = Math.min(box.clientWidth / vw, box.clientHeight / vh);
      fxlPad = Math.max(0, Math.floor((box.clientHeight - vh * sc) / 2));
    }
    doc.documentElement.classList.toggle('tree-fxl', fxl);
  } catch { /* bỏ qua */ }
  // Trang chỉ có ảnh (truyện tranh, ảnh bìa, trang minh hoạ) ở sách thường: gần như không có chữ → phóng ảnh vừa khít trang
  try {
    const imgs = doc.body.querySelectorAll('img, svg').length;
    const txt = (doc.body.textContent || '').replace(/\s+/g, '').length;
    doc.documentElement.classList.toggle('tree-imgpage', !fxl && imgs > 0 && txt <= 12 * imgs);
  } catch { /* bỏ qua */ }
  // Căn đều 2 lề: chỉ đoạn văn thường (sách tự căn giữa/phải — tiêu đề, thơ, lời đề tặng — giữ nguyên).
  // Đo căn lề gốc của sách 1 lần trước khi chèn CSS của app.
  const justify = settings.justify !== false && !fxl;
  let lang = '';
  if (justify) {
    try {
      lang = (doc.documentElement.getAttribute('lang') || doc.documentElement.getAttribute('xml:lang')
        || doc.body.getAttribute('lang') || R.book?.package?.metadata?.language || '').toLowerCase();
      if (lang && !doc.documentElement.getAttribute('lang')) doc.documentElement.setAttribute('lang', lang);
      const cw = contents.window;
      for (const el of doc.body.querySelectorAll('p, li, blockquote, div:not(:has(p, div))')) {
        if (el.dataset.tj) continue;
        const a = cw.getComputedStyle(el).textAlign;
        el.dataset.tj = a === 'start' || a === 'left' || a === 'justify' || a === '-webkit-auto' ? '1' : '0';
      }
    } catch { /* bỏ qua */ }
  }
  // Tiếng Anh: ngắt từ có gạch nối; tiếng Việt (từ đơn âm): chỉ căn đều + tránh dòng cuối đoạn còn 1 chữ
  const hyph = justify && /^en/.test(lang) ? 'hyphens: auto; -webkit-hyphens: auto;' : 'hyphens: manual; -webkit-hyphens: manual;';
  style.textContent = `
    ${justify ? `[data-tj="1"] { text-align: justify !important; text-wrap: pretty; ${hyph} }` : ''}
    html { font-size: ${settings.fontSize}% !important; background: ${t.bg} !important; touch-action: ${settings.flow === 'paginated' ? 'none' : 'pan-y'}; -webkit-tap-highlight-color: transparent; }
    body { font-size: ${bodyFs}px !important; background: ${t.bg} !important; color: ${t.fg} !important; -webkit-text-size-adjust: none; }
    p, li, blockquote, dd, dt, td, div { line-height: ${settings.lineHeight} !important; }
    body *:not(img):not(svg):not(image) { background-color: transparent !important; background-image: none !important; }
    /* Một số sách tự phủ lớp tối/hiệu ứng ánh sáng lên cả trang bằng ::before/::after → bỏ để nền trang
       đúng một màu, khớp với thanh trên & dưới */
    html::before, html::after, body::before, body::after, body *::before, body *::after {
      background-color: transparent !important; background-image: none !important; box-shadow: none !important;
    }
    ${recolor ? `body *:not(img):not(svg):not(image) { color: inherit !important; border-color: ${t.fg}33 !important; }` : ''}
    a, a * { color: ${t.link} !important; }
    ::highlight(resume) { background-color: ${settings.theme === 'dark' ? 'rgba(110,170,255,.35)' : 'rgba(80,150,255,.28)'}; }
    ::highlight(tts) { background-color: ${settings.theme === 'dark' ? 'rgba(224,138,94,.38)' : 'rgba(255,196,0,.38)'}; }
    ${settings.fontFamily ? `body, body p, body div, body span, body li, body blockquote, body td, body h1, body h2, body h3, body h4 { font-family: ${settings.fontFamily} !important; }` : ''}
    /* epub.js chia cột trên <body>; lề/đệm mà sách đặt cho <html> (vd html,body{padding:0 1.3em}) không được tính
       → mọi trang bị đẩy lệch sang phải, mép trái lộ đuôi trang trước. Bỏ lề của <html>. */
    html { padding: 0 !important; margin: 0 !important; border: 0 !important; }
    /* ---- Căn vừa trang trên mọi máy ----
       epub.js giới hạn ảnh bằng đúng bề rộng cột nhưng không trừ lề của sách → ảnh lố mép phải vài px,
       đẩy các trang sau lệch dần. Giới hạn theo khung chứa thật (100%) và chiều cao trang trừ lề. */
    body img, body svg, body video, body object, body canvas, body iframe {
      max-width: 100% !important; max-height: ${fitH(contents)}px !important;
      height: auto; object-fit: contain; box-sizing: border-box;
    }
    body svg[width="100%"], body svg[height="100%"] { width: 100% !important; height: ${fitH(contents)}px !important; }
    /* Khối đặt bề rộng cố định (vd width:600px, min-width) → co theo trang */
    /* Ảnh nằm trong đoạn có thụt đầu dòng → bị đẩy lố mép phải: bỏ thụt đầu dòng của đoạn chứa ảnh */
    body p:has(img), body p:has(svg), body p:has(iframe), body div:has(> img):not(:has(p)) { text-indent: 0 !important; }
    body * { max-width: 100% !important; min-width: 0 !important; box-sizing: border-box; }
    body table { width: auto !important; table-layout: auto; }
    body td, body th { word-break: break-word; }
    /* Chữ dài không có chỗ ngắt (đường link, chuỗi gạch…) / đoạn "không xuống dòng" → tự xuống dòng */
    body { overflow-wrap: break-word; word-wrap: break-word; }
    body pre, body code, body [style*="nowrap"] { white-space: pre-wrap !important; }
    /* Cột lồng trong cột phân trang làm trang lệch → bỏ */
    body * { column-count: auto !important; column-width: auto !important; columns: auto !important; }
    /* Hiệu ứng động tự chạy trong sách (hoa rơi, tim bay…) bắt máy vẽ lại liên tục → nóng máy */
    *, *::before, *::after { animation: none !important; transition: none !important; }
    /* Trang chỉ có ảnh (truyện tranh): mỗi ảnh chiếm trọn 1 trang, giữ tỉ lệ, căn giữa (kể cả ảnh nhỏ được phóng to) */
    html.tree-imgpage body { margin: 0 !important; }
    html.tree-imgpage body *:not(img):not(svg):not(image) {
      margin-top: 0 !important; margin-bottom: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important;
      line-height: 0 !important; text-indent: 0 !important;
    }
    html.tree-imgpage body img, html.tree-imgpage body svg {
      display: block !important; width: 100% !important; height: calc(100vh - 4px) !important;
      max-width: 100% !important; max-height: calc(100vh - 4px) !important;
      object-fit: contain !important; margin: 0 auto !important; break-inside: avoid; page-break-inside: avoid;
    }
    /* Bố cục cố định: ảnh lấp trọn khung trang gốc; cả trang (đã thu nhỏ) nằm giữa màn hình theo chiều dọc */
    html.tree-fxl { padding-top: ${fxlPad}px !important; }
    html.tree-fxl body img, html.tree-fxl body svg {
      width: 100% !important; height: auto !important; max-width: 100% !important; max-height: none !important; object-fit: contain;
    }
  `;
}
// Chiều cao tối đa cho ảnh = chiều cao trang trừ lề trên/dưới của sách (để ảnh không bị cắt sang trang sau)
function fitH(contents) {
  try {
    const win = contents.window, cs = win.getComputedStyle(contents.document.body);
    const v = ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom'].reduce((s, k) => s + (parseFloat(cs[k]) || 0), 0);
    return Math.max(120, Math.floor(win.innerHeight - v - 6));
  } catch { return 600; }
}

function applyChrome() {
  document.body.dataset.theme = settings.theme;
  $('reader').classList.toggle('paginated', settings.flow === 'paginated');
  const t = THEMES[settings.theme];
  document.querySelector('meta[name="theme-color"]').content = t.bar;
  $('viewerWrap').style.background = t.bg;
  // Cả khu đọc (thanh trên/dưới, lề, vùng chữ) dùng đúng 1 màu nền → không còn chỗ đậm chỗ nhạt
  $('reader').style.setProperty('--bg', t.bg);
  $('reader').style.background = t.bg;
  $('fontSizeVal').textContent = R.kind === 'pdf' && R.pdf ? `${Math.round(R.pdf.zoom * 100)}%` : `${settings.fontSize}%`;
  $('lhVal').textContent = settings.lineHeight.toFixed(1);
  $('fontFamily').value = settings.fontFamily;
  $('flowMode').value = settings.flow;
  $('pageAnim').value = settings.pageAnim;
  $('pageAnimRow').hidden = settings.flow !== 'paginated';
  $('startView').value = settings.startView;
  $('spreadMode').value = settings.spread;
  $('justifyMode').value = settings.justify === false ? 'off' : 'on';
  $('spreadRow').hidden = settings.flow !== 'paginated';
  // 1 trang: khung chữ vừa phải, đặt giữa màn hình (không trải dài hết màn hình rộng)
  document.body.classList.toggle('single-page', settings.spread !== 'double');
  document.querySelectorAll('.sw').forEach((b) => b.classList.toggle('active', b.dataset.theme === settings.theme));
}

// Đổi cài đặt hiển thị: dựng lại trang ở đúng vị trí đang đọc
let rerenderTimer = null;
function changeSetting(patch) {
  Object.assign(settings, patch);
  saveSettings();
  applyChrome();
  if (R.kind === 'pdf') { if (R.pdf && ('flow' in patch || 'theme' in patch)) R.pdf.rebuild(); return; }
  if (!R.rendition) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => createRendition(R.line || R.cfi), 250);
}

function flatten(items, level = 1, out = []) {
  for (const it of items || []) {
    out.push({ label: (it.label || '').trim(), href: it.href, level });
    if (it.subitems?.length) flatten(it.subitems, level + 1, out);
  }
  return out;
}
const baseName = (href) => (href || '').split('#')[0].split('/').pop();

function currentChapter(href) {
  const name = baseName(href);
  return R.flatToc.find((t) => baseName(t.href) === name) || null;
}

function renderToc() {
  const nav = $('tocList');
  nav.innerHTML = '';
  if (!R.flatToc.length) { nav.innerHTML = '<p class="hint" style="padding:16px">Sách không có mục lục.</p>'; return; }
  for (const t of R.flatToc) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = t.label || '(không tên)';
    if (t.level > 1) a.className = `sub-item${t.level > 2 ? ' l3' : ''}`;
    a.onclick = (e) => {
      e.preventDefault();
      $('tocPanel').hidden = true;
      if (R.kind === 'pdf') R.pdf?.goTo(t.page); else R.rendition.display(t.href);
    };
    nav.appendChild(a);
  }
}

async function loadLocations(id) {
  const book = R.book;
  const cached = await db.get('locations', id);
  if (cached?.json) {
    book.locations.load(cached.json);
  } else {
    $('syncText').textContent = 'Đang tính vị trí…';
    await book.ready;
    await book.locations.generate(1600);
    if (R.book !== book) return;
    db.put('locations', { id, json: book.locations.save() }).catch(() => {});
    updateSyncText();
  }
  if (R.book !== book) return;
  $('progressSlider').disabled = false;
  if (R.cfi) {
    R.percent = book.locations.percentageFromCfi(R.cfi) || R.percent;
    updateProgressUI();
  }
}

// So sánh 2 vị trí CFI: -1 / 0 / 1
const cfiCmp = (a, b) => { try { return new ePub.CFI().compare(a, b); } catch { return NaN; } };
// Câu đang đọc còn nằm trong trang đang hiển thị không
const lineOnPage = (line, loc) => !!line && cfiCmp(line, loc.start.cfi) >= 0 && cfiCmp(line, loc.end.cfi) <= 0;

let curlPrepTimer = 0;
function onRelocated(loc) {
  const cfi = loc.start.cfi;
  R.cfi = cfi;
  if (!R.skipNextSave) R.movedSinceOpen = true;
  readTick(loc);
  wakeUpdate(true);
  // Dựng sẵn bản sao trang cho hiệu ứng "Lật giấy" (chương mới / vừa mở sách) khi máy rảnh
  if (isCurl() && !document.hidden) {
    clearTimeout(curlPrepTimer);
    curlPrepTimer = setTimeout(() => { const p = pager(); if (p && !curlFinish) curlCloneFor(p.c.scrollLeft); }, 600);
  }
  // Tự lật sang trang khác (không phải do giọng đọc) → vị trí là đầu trang mới
  if (R.line && !lineOnPage(R.line, loc)) R.line = null;
  const book = R.book;
  if (book.locations.length()) R.percent = book.locations.percentageFromCfi(R.line || cfi);
  else if (!R.percent || !R.skipNextSave) R.percent = (loc.start.index || 0) / Math.max(1, book.spine.length);
  const ch = currentChapter(loc.start.href);
  $('rChapter').textContent = ch?.label || R.meta.author || '';
  document.querySelectorAll('#tocList a').forEach((a, i) => a.classList.toggle('current', R.flatToc[i] === ch));
  updateProgressUI();

  if (R.skipNextSave) { R.skipNextSave = false; return; }
  saveProgress(ch?.label || '');
}

function updateProgressUI() {
  const left = chapterLeftText();
  $('progressText').textContent = (R.kind === 'pdf' && R.pdf
    ? `Trang ${R.pdf.page}/${R.pdf.pages} · ${pctText(R.percent)}`
    : pctText(R.percent)) + (left ? ` · ${left}` : '');
  if (document.activeElement !== $('progressSlider')) $('progressSlider').value = Math.round(R.percent * 1000);
}

function updateSyncText() {
  const el = $('syncText');
  const u = sync.currentUser();
  if (!sync.isConfigured()) el.textContent = 'Chỉ lưu trên máy này';
  else if (!u) el.textContent = 'Chưa đăng nhập — chưa đồng bộ';
  else if (u.needsReconnect) el.textContent = 'Cần kết nối lại — sẽ đồng bộ sau';
  else el.textContent = navigator.onLine ? `Đã đồng bộ (${u.providerName})` : 'Ngoại tuyến — sẽ đồng bộ sau';
}

// quiet: lưu theo từng câu khi đang đọc to → lưu trên máy ngay, gửi lên đám mây thưa hơn (tối đa 20 giây/lần;
// tạm dừng / dừng / rời app thì gửi ngay)
async function saveProgress(chapter, quiet) {
  const now = Date.now();
  R.lastSavedAt = now;
  const line = R.kind === 'pdf' ? '' : (R.line || '');
  const rec = { id: R.id, cfi: R.cfi, line, percent: R.percent, chapter, updatedAt: now };
  db.put('progress', rec).catch(() => {});
  R.pendingPush = {
    id: R.id,
    data: {
      title: R.meta.title, author: R.meta.author || '',
      cfi: R.cfi, line, percent: R.percent, chapter, updatedAt: now, deviceId, deviceName,
      ...(R.meta.source ? { source: R.meta.source } : {}),
    },
  };
  if (quiet) { if (!R.pushTimer) R.pushTimer = setTimeout(flushPush, 10000); return; }
  clearTimeout(R.pushTimer);
  R.pushTimer = setTimeout(flushPush, 1500);
}

// Tô sáng vài giây câu đang đọc dở (khi mở từ vị trí của máy khác) để biết đọc tiếp từ đâu
function lineSegment(cfi) {
  let idx;
  try { idx = new ePub.CFI(cfi).spinePos; } catch { return null; }
  const c = findContents(idx);
  if (!c) return null;
  let r = null;
  try { r = c.range(cfi); } catch { /* bỏ qua */ }
  if (!r) return null;
  return epubSegments(c, r.startContainer, r.startOffset)[0] || null;
}
function flashLine(cfi, tries = 0) {
  const seg = lineSegment(cfi);
  if (!seg) { if (tries < 10) setTimeout(() => flashLine(cfi, tries + 1), 200); return; }
  const win = seg.contents.window;
  try {
    if (!win.CSS?.highlights || !win.Highlight) return;
    win.CSS.highlights.set('resume', new win.Highlight(seg.range));
    setTimeout(() => { try { win.CSS.highlights.delete('resume'); } catch { /* bỏ qua */ } }, 4000);
  } catch { /* bỏ qua */ }
}

function flushPush() {
  clearTimeout(R.pushTimer);
  R.pushTimer = null;
  const p = R.pendingPush;
  R.pendingPush = null;
  if (!p) return;
  sync.push(p.id, p.data).then(updateSyncText).catch((e) => {
    if (e.code === 'need-auth') { updateSyncText(); return; }
    console.warn('Đồng bộ lỗi', e);
    $('syncText').textContent = navigator.onLine ? 'Lỗi đồng bộ — sẽ thử lại' : 'Ngoại tuyến — sẽ đồng bộ sau';
  });
}

// Thiết bị khác vừa đọc tiếp cuốn này
// Vị trí trên đám mây về sau khi đã mở sách: mới hơn → chưa lật trang thì tự chuyển tới, đã lật thì hỏi
function applyRemoteOnOpen(id, local, remote) {
  if (R.id !== id || !remote?.cfi) return;
  // So với vị trí đã lưu trên máy lúc mở sách (không so với R.lastSavedAt: nếu đã kịp lật trang thì lần lưu mới
  // của máy này sẽ che mất vị trí xa hơn của máy khác → không hỏi "Đến đó" nữa)
  if ((remote.updatedAt || 0) <= (local?.updatedAt || 0)) return;
  if (remote.deviceId === deviceId && R.movedSinceOpen) return; // chính máy này vừa lưu
  if (remote.cfi === R.cfi && (remote.line || '') === (R.line || '')) return;
  R.lastSavedAt = Math.max(R.lastSavedAt || 0, remote.updatedAt);
  const who = remote.deviceId !== deviceId ? (remote.deviceName || 'thiết bị khác') : 'lần đọc trước';
  const auto = !R.movedSinceOpen;
  const go = () => {
    if (R.id !== id) return; // đã đóng / mở cuốn khác trước khi bấm "Đến đó"
    if (speaker && speaker.state !== 'idle') speaker.stop();
    R.skipNextSave = auto; // tự chuyển lúc vừa mở: chưa tính là đọc tiếp; bấm "Đến đó": lưu vị trí mới
    R.percent = remote.percent || R.percent;
    if (R.kind !== 'pdf' && remote.line) {
      R.line = remote.line;
      Promise.resolve(R.rendition?.display(remote.line)).then(() => flashLine(remote.line)).catch(() => {});
    } else goToLocation(remote.cfi);
  };
  if (auto) {
    go();
    toast(`Đã chuyển đến ${remote.line ? 'đúng câu' : 'vị trí'} bạn đọc trên ${who}`, null, null, 3500);
  } else {
    toast(`${who === 'lần đọc trước' ? 'Lần đọc trước' : who} đã đọc đến ${pctText(remote.percent)}`, 'Đến đó', go, 15000);
  }
}

function onRemoteChange(data) {
  if (!R.id || data.deviceId === deviceId || !data.cfi) return;
  if ((data.updatedAt || 0) <= R.lastSavedAt || (data.cfi === R.cfi && (data.line || '') === (R.line || ''))) return;
  R.lastSavedAt = data.updatedAt;
  toast(`${data.deviceName || 'Thiết bị khác'} đã đọc đến ${pctText(data.percent)}`, 'Chuyển đến', () => {
    if (speaker && speaker.state !== 'idle') speaker.stop();
    R.skipNextSave = false;
    if (R.kind !== 'pdf' && data.line) {
      R.line = data.line;
      Promise.resolve(R.rendition?.display(data.line)).then(() => flashLine(data.line)).catch(() => {});
    } else goToLocation(data.cfi);
  }, 15000);
}

async function closeBook() {
  readTick(null);
  wakeUpdate(false);
  speaker?.stop();
  ttsRestartAfterRender = false;
  ttsNeedsResync = false;
  if (R.coverUrl) { URL.revokeObjectURL(R.coverUrl); R.coverUrl = null; }
  flushPush();
  R.unwatch(); R.unwatch = () => {};
  clearTimeout(rerenderTimer);
  if (R.rendition) R.rendition.destroy();
  if (R.book) R.book.destroy();
  if (R.pdf) R.pdf.destroy();
  Object.assign(R, { id: null, book: null, rendition: null, pdf: null, kind: null, line: null });
  $('reader').classList.remove('is-pdf');
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#ffffff';
  $('tocPanel').hidden = true; $('settingsPanel').hidden = true;
  showView('library');
  renderLibrary();
}

/* ----- Điều hướng + hiệu ứng lật trang kiểu Play Sách ----- */
// Ở chế độ lật trang, epub.js xếp cả chương thành các cột trong 1 khung rộng và lật trang bằng
// cách đổi scrollLeft của khung chứa. Ta cuộn mượt tới trang kế (trượt), cho trang chạy theo ngón tay
// khi kéo, và khi sang chương mới thì cho chương mới trượt vào.
const reduceMotion = () => settings.pageAnim === 'none'
  || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function pager() {
  const m = R.rendition?.manager;
  const c = m?.container;
  if (!c || !m.layout || settings.flow !== 'paginated') return null;
  return { c, delta: m.layout.delta };
}

// Cách làm mượt (v1.5): KHÔNG cuộn khung sách từng khung hình (mỗi lần cuộn epub.js lại tính vị trí
// và app lưu tiến độ → giật). Thay vào đó lật thật đúng 1 lần (đổi scrollLeft), còn phần "trượt" mắt thấy
// là dịch chuyển (transform) phần tử trang bằng GPU.
// Có thể có nhiều chương đang nạp cạnh nhau (chế độ continuous) → dịch chuyển tất cả cùng lúc
const pageEls = () => [...(R.rendition?.manager?.container?.querySelectorAll('.epub-view') || [])];
const EASE = 'cubic-bezier(.25,.8,.25,1)';
let slideAnims = [];
const finishSlide = () => { slideAnims.forEach((a) => a.finish()); slideAnims = []; };
function setShift(px) {
  for (const v of pageEls()) v.style.transform = px ? `translate3d(${px}px,0,0)` : '';
}
function animShift(from, to, ms) {
  finishSlide();
  const els = pageEls();
  if (!els.length || !els[0].animate) { setShift(to); return Promise.resolve(); }
  const anims = els.map((v) => {
    v.style.transform = to ? `translate3d(${to}px,0,0)` : '';
    return v.animate(
      [{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }],
      { duration: ms, easing: EASE },
    );
  });
  slideAnims = anims;
  return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {
    if (slideAnims === anims) slideAnims = [];
  });
}

/* ----- Hiệu ứng "Lật giấy" kiểu Apple Books: góc trang gấp chéo, mặt sau in ngược mờ, bóng dọc nếp gấp ----- */
// Trang sách nằm trong khung iframe rộng cả chương (trang kế ở ngay bên phải), nên giữ sẵn 2 BẢN SAO tĩnh của
// chương (iframe không chạy script, dựng 1 lần mỗi chương): 1 làm mặt trước trang đang lật, 1 làm mặt sau.
// Hình học: góc dưới-phải C của trang bị kéo tới điểm M; nếp gấp là đường trung trực của CM.
//   - Mặt trước = phần trang phía bên kia nếp gấp (cắt bằng clip-path).
//   - Mặt sau  = phần phía góc, lật đối xứng qua nếp gấp (ma trận phản chiếu) → chữ in ngược, phủ màu giấy cho mờ.
//   - Trang mới nằm bên dưới (khung sách thật), có bóng đổ dọc nếp gấp.
const curlClones = new Map(); // iframe gốc → { frames: [mặt trước, mặt sau], sig, ready }
const curlSig = (src) => {
  const d = src.contentDocument;
  return `${src.offsetWidth}x${src.offsetHeight}|${d?.body?.innerHTML.length}|${[...(d?.querySelectorAll('style') || [])].map((s) => s.textContent.length).join(',')}`;
};
// Lớp lật trùm TOÀN MÀN HÌNH đọc (cả 2 thanh trên/dưới được chụp theo vào trang giấy).
// Mượt: mỗi khung hình chỉ đổi transform/opacity → GPU ghép lớp có sẵn, không phải vẽ lại chữ.
//   .cp-clip  = khung vuông rất lớn, xoay theo nếp gấp, overflow:hidden → mép phải của nó chính là nếp gấp
//               (thay cho clip-path vốn bắt vẽ lại mỗi khung hình).
//   .cp-front = trang đang lật (phần còn phẳng); .cp-back = cùng trang đó phản chiếu qua nếp gấp (mặt sau, chữ ngược mờ).
//   .cp-shade = bóng của tờ giấy đổ xuống trang mới bên dưới.
function curlLayer() {
  let layer = $('curlLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'curlLayer';
    layer.innerHTML = `
      <div class="cp-shade"></div>
      <div class="cp-clip">
        <div class="cp-page cp-front"><div class="cp-pages"></div><div class="cp-bars"></div><div class="cp-bend"></div></div>
        <div class="cp-page cp-back"><div class="cp-pages"></div><div class="cp-bars"></div><div class="cp-paper"></div><div class="cp-gloss"></div></div>
      </div>`;
    $('reader').appendChild(layer);
  }
  // Khung chữ trong bản sao đặt đúng chỗ khung chữ thật
  const rr = $('reader').getBoundingClientRect(), vr = $('viewer').getBoundingClientRect();
  for (const el of layer.querySelectorAll('.cp-pages')) {
    Object.assign(el.style, { left: `${vr.left - rr.left}px`, top: `${vr.top - rr.top}px`, width: `${vr.width}px`, height: `${vr.height}px` });
  }
  return layer;
}
// Chụp 2 thanh trên/dưới (tên chương, vạch tiến độ) vào trang giấy để chúng lật cùng trang
function curlBars(layer) {
  const show = !$('reader').classList.contains('immersive');
  const sysbar = $('reader').querySelector(':scope > .sysbar'); // đồng hồ + pin (Android toàn màn hình): luôn lật theo trang
  for (const host of layer.querySelectorAll('.cp-bars')) {
    host.replaceChildren();
    if (show) {
      for (const bar of [$('readerTop'), $('readerBottom')]) {
        const cl = bar.cloneNode(true);
        cl.removeAttribute('id');
        cl.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
        const inp = cl.querySelector('input[type=range]');
        if (inp) inp.value = $('progressSlider').value;
        host.appendChild(cl);
      }
    }
    if (sysbar) host.appendChild(sysbar.cloneNode(true)); // sau cùng → nằm trên thanh tiêu đề (như ngoài thật)
  }
}
// Lấy (hoặc dựng nền) bản sao cho chương chứa vị trí cuộn `scroll`; trả về null nếu chưa sẵn sàng
function curlCloneFor(scroll) {
  const view = pageEls().find((v) => v.offsetLeft <= scroll + 1 && scroll < v.offsetLeft + v.offsetWidth - 1);
  const src = view?.querySelector('iframe');
  if (!src?.contentDocument?.body) return null;
  for (const [k, c] of curlClones) if (!k.isConnected) { c.frames.forEach((f) => f.remove()); curlClones.delete(k); } // chương đã gỡ
  const sig = curlSig(src);
  let c = curlClones.get(src);
  const layer = curlLayer();
  if (!c || c.sig !== sig) {
    c?.frames.forEach((f) => f.remove());
    const html = '<!DOCTYPE html>' + src.contentDocument.documentElement.outerHTML;
    c = { sig, ready: false, frames: [] };
    let loaded = 0;
    for (const host of [layer.querySelector('.cp-front .cp-pages'), layer.querySelector('.cp-back .cp-pages')]) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin'); // chỉ để hiển thị, không chạy script
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      // Chỉ rộng đúng 1 màn hình (không phải cả chương dài hàng chục nghìn px) rồi cuộn bên trong tới trang
      // đang lật → lớp đồ hoạ nhỏ, iPhone lật mượt, không giật
      const pageW = R.rendition?.manager?.container?.offsetWidth || src.offsetWidth;
      Object.assign(frame.style, { width: `${pageW}px`, height: `${src.offsetHeight}px` });
      frame.onload = () => { if (++loaded === 2) c.ready = true; };
      frame.srcdoc = html;
      host.appendChild(frame);
      c.frames.push(frame);
    }
    curlClones.set(src, c);
  }
  if (!c.ready) return null;
  for (const o of curlClones.values()) o.frames.forEach((f) => { f.style.display = o === c ? '' : 'none'; });
  const x = Math.round(scroll - view.offsetLeft);
  c.frames.forEach((f) => {
    const se = f.contentDocument?.scrollingElement;
    if (se) se.scrollLeft = x; else f.style.transform = `translateX(${-x}px)`;
  });
  return c;
}

// Ma trận 2D [a,b,c,d,e,f] như CSS matrix(); mul(A,B) = áp B trước rồi A
const mMul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const mInv = ([a, b, c, d, e, f]) => { const det = a * d - b * c; return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]; };
const mCss = (m) => `matrix(${m.map((v) => v.toFixed(4)).join(',')})`;
// Chuẩn bị 1 lần mỗi lượt lật: kích thước + phần tử (khỏi đọc bố cục trong từng khung hình)
function curlState(layer) {
  const W = layer.clientWidth, H = layer.clientHeight;
  const S = 2 * Math.hypot(W, H), L = S, B = Math.max(70, W * 0.3);
  const q = (s) => layer.querySelector(s);
  const st = { layer, W, H, S, L, B, clip: q('.cp-clip'), front: q('.cp-front'), back: q('.cp-back'), shade: q('.cp-shade'), gloss: q('.cp-gloss'), bend: q('.cp-bend') };
  st.c3d = settings.pageAnim === 'curl3d';
  layer.classList.toggle('c3d', st.c3d);
  if (st.bend) { Object.assign(st.bend.style, { width: `${B * 1.3}px`, height: `${L}px` }); st.bend.style.opacity = 0; }
  Object.assign(st.clip.style, { width: `${S}px`, height: `${S}px` });
  for (const p of [st.front, st.back]) Object.assign(p.style, { width: `${W}px`, height: `${H}px` });
  for (const g of [st.shade, st.gloss]) Object.assign(g.style, { width: `${B}px`, height: `${L}px` });
  return st;
}
// Vẽ trạng thái lật ở tiến độ t (0 = phẳng, 1 = đã lật hết sang trái); lift: độ nhấc góc lên (theo tay kéo)
function curlRender(st, t, lift = 0) {
  const { W, H, S, L } = st;
  // Cả mép phải của trang lật sang trái, nếp gấp chạy suốt từ mép dưới lên mép trên màn hình (như Apple Books);
  // góc dưới chỉ nhấc rất nhẹ (6%) để phần dưới đi trước một chút. Kéo tay lên/xuống → góc nhấc theo ngón tay.
  // Độ nghiêng của nếp gấp tính theo bề ngang (không theo chiều cao): mép dưới chỉ đi trước mép trên ~12% bề ngang,
  // nên trên màn hình điện thoại (cao gấp đôi ngang) phần trên trang cũng lật gần cùng lúc với phần dưới.
  const lean = 0.12 * W * Math.sin(Math.PI * Math.min(1, t));
  const Mx = W - 2 * W * t, My = H - (2 * W * t * lean) / H - H * lift;
  let nx = W - Mx, ny = H - My, Px, Py;
  const len = Math.hypot(nx, ny);
  if (len < 0.5) { nx = 0.96; ny = 0.28; Px = W + 2; Py = H + 2; } // chưa gấp: nếp gấp nằm ngoài góc trang
  else { nx /= len; ny /= len; Px = (W + Mx) / 2; Py = (H + My) / 2; }
  const F = [nx, ny, -ny, nx, Px, Py];                   // hệ toạ độ nếp gấp: trục x = pháp tuyến n (hướng về góc trang)
  const clip = mMul(F, [1, 0, 0, 1, -S, -S / 2]);       // khung cắt nằm phía trang phẳng, mép phải = nếp gấp
  const inv = mInv(clip);
  const k = 2 * (Px * nx + Py * ny);
  const refl = [1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, k * nx, k * ny]; // phản chiếu qua nếp gấp
  const band = mMul(F, [1, 0, 0, 1, 0, -L / 2]);        // dải dọc nếp gấp, toả về phía góc trang
  st.clip.style.transform = mCss(clip);
  st.front.style.transform = mCss(inv);
  // 3D: tờ giấy đang dựng lên nhìn từ trên xuống bị "co" theo phương vuông góc nếp gấp (phối cảnh),
  // co nhiều nhất khi giấy đứng thẳng giữa chừng; phần trang phẳng sát nếp gấp tối dần như mặt giấy cong xuống.
  let backM = refl;
  if (st.c3d && len >= 0.5) {
    const lift3d = Math.sin(Math.PI * Math.min(1, t));
    const c = 1 - 0.22 * lift3d;                        // hệ số co theo pháp tuyến n
    const sc = [1 - (1 - c) * nx * nx, -(1 - c) * nx * ny, -(1 - c) * nx * ny, 1 - (1 - c) * ny * ny];
    const fix = [Px - (sc[0] * Px + sc[2] * Py), Py - (sc[1] * Px + sc[3] * Py)]; // giữ nếp gấp đứng yên
    backM = mMul([...sc, ...fix], refl);
    st.bend.style.transform = mCss(mMul(F, [1, 0, 0, 1, -st.B * 1.3, -L / 2]));
    st.bend.style.opacity = Math.min(1, lift3d * 1.4);
  } else if (st.bend) st.bend.style.opacity = 0;
  st.back.style.transform = mCss(mMul(inv, backM));
  st.gloss.style.transform = mCss(band);
  st.shade.style.transform = mCss(band);
  // Bóng mạnh nhất khi trang đang dựng đứng giữa chừng, nhạt dần lúc gần phẳng
  st.shade.style.opacity = len < 0.5 ? 0 : Math.min(1, Math.sin(Math.PI * Math.min(1, t)) * 1.6 + 0.2);
}
let curlFinish = null;   // đang lật dở mà lật tiếp → hoàn tất ngay lần đang chạy
const finishCurl = () => curlFinish?.();
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
function curlAnimate(layer, from, to, ms, lift = 0) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let stopped = false;
    // Bấm/chạm: tăng tốc rồi chậm dần; thả tay giữa chừng: đi tiếp theo đà ngón tay rồi chậm dần
    const ease = from === 0 || from === 1 ? easeInOut : (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      if (stopped) return;
      const k = Math.min(1, (now - t0) / ms);
      curlRender(layer, from + (to - from) * ease(k), lift * (1 - ease(k)));
      if (k < 1) requestAnimationFrame(step); else resolve(true);
    };
    requestAnimationFrame(step);
    curlAnimate.stop = () => { stopped = true; resolve(false); };
  });
}
// Bắt đầu 1 lần lật giấy (cho cả bấm/chạm lẫn kéo tay). Trả về phiên { dir, set(t), end(commit) } hoặc null
function curlBegin(dir) {
  const p = pager();
  if (!p) return null;
  const { c, delta } = p;
  const start = c.scrollLeft;
  const within = dir > 0 ? start + c.offsetWidth + delta <= c.scrollWidth + 1 : start > 1;
  if (!within) return null;
  const target = start + dir * delta;
  // Lật tới: trang đang lật = trang hiện tại, bên dưới là trang sau. Lật lùi: trang đang lật = trang trước.
  const clone = curlCloneFor(dir > 0 ? start : target);
  if (!clone) { curlCloneFor(start); return null; } // chưa sẵn → lần này dùng kiểu trượt
  // Nhớ vị trí theo "chương + chỗ trong chương", KHÔNG theo toạ độ tuyệt đối: trong lúc lật, epub.js có thể gỡ
  // bớt chương đã qua / chèn chương phía trước và tự dời scrollLeft → đặt lại toạ độ cũ sẽ nhảy nhiều trang.
  const rel = (pos) => { const v = pageEls().find((e) => e.offsetLeft <= pos + 1 && pos < e.offsetLeft + e.offsetWidth - 1); return v ? { v, off: pos - v.offsetLeft } : null; };
  const relStart = rel(start), relTarget = rel(target);
  const absOf = (r) => (r && r.v.isConnected ? r.v.offsetLeft + r.off : null);
  const layer = curlLayer();
  curlBars(layer);
  const st = curlState(layer);
  if (dir > 0) { R.rendition.manager.ignore = false; c.scrollLeft = target; }
  const t0 = dir > 0 ? 0 : 1;
  curlRender(st, t0);
  layer.classList.add('on');
  let finished = false, raf = 0, lastLift = 0;
  const s = {
    dir, t: t0,
    // Theo tay kéo: gộp các lần di chuyển ngón tay, mỗi khung hình chỉ vẽ 1 lần
    set(t, lift = 0) {
      s.t = Math.max(0, Math.min(1, t)); lastLift = lift;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!finished) curlRender(st, s.t, lastLift); });
    },
    // commit = true: lật hẳn; false: trả trang về như cũ
    async end(commit, lift = lastLift) {
      s.intent = commit;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const to = dir > 0 ? (commit ? 1 : 0) : (commit ? 0 : 1);
      const ms = 180 + 520 * Math.abs(to - s.t);
      await curlAnimate(st, s.t, to, ms, lift);
      s.done(commit);
    },
    done(commit) {
      if (finished) return;
      finished = true;
      if (curlFinish === s.cut) curlFinish = null;
      layer.classList.remove('on');
      // Lật tới & lật hẳn: trang đã ở đúng chỗ từ lúc bắt đầu → không đụng tới vị trí cuộn
      if (!(dir > 0 && commit)) {
        const want = absOf(commit ? relTarget : relStart);
        if (want != null && Math.abs(c.scrollLeft - want) > 1) { R.rendition.manager.ignore = false; c.scrollLeft = want; }
      }
      R.rendition?.reportLocation();
      // Chuẩn bị sẵn bản sao cho lần lật sau (chương mới / sau khi đổi cỡ chữ)
      setTimeout(() => { const q = pager(); if (isCurl() && q) curlCloneFor(q.c.scrollLeft); }, 50);
    },
    // Đang lật dở mà lật tiếp → kết thúc ngay theo đúng ý lần trước (thả tay chưa đủ xa thì trả về, không lật)
    cut() { curlAnimate.stop?.(); s.done(s.intent ?? true); },
  };
  curlFinish = s.cut;
  return s;
}
// Lật bằng nút / chạm mép / phím: trả về false nếu chưa làm được (để dùng kiểu trượt)
async function curlTurn(dir) {
  const s = curlBegin(dir);
  if (!s) return false;
  await s.end(true);
  return true;
}
if (location.hostname === 'localhost') window.__curl = { begin: curlBegin, clone: curlCloneFor, sig: curlSig, pager };

function slideIn(dir) {
  const v = $('viewer');
  if (reduceMotion() || !v.animate) return;
  v.animate(
    [{ transform: `translate3d(${dir * 100}%,0,0)` }, { transform: 'none' }],
    { duration: 300, easing: EASE },
  );
}

// dir = 1: trang sau, -1: trang trước. fromScroll: vị trí trang lúc bắt đầu kéo; shift: độ lệch hiện tại do kéo.
async function turn(dir, fromScroll, shift = 0) {
  if (R.kind === 'pdf') return R.pdf?.turn(dir);
  if (!R.rendition) return;
  finishSlide();
  finishCurl();
  const go = () => (dir > 0 ? R.rendition.next() : R.rendition.prev());
  const p = pager();
  if (!p || reduceMotion()) { setShift(0); return go(); }
  const { c, delta } = p;
  const start = fromScroll ?? c.scrollLeft;
  const within = dir > 0 ? start + c.offsetWidth + delta <= c.scrollWidth + 1 : start > 1;
  if (within && isCurl() && !shift && fromScroll == null) {
    if (await curlTurn(dir)) return; // bản sao chưa sẵn → lần này trượt, lần sau sẽ lật giấy
  }
  if (within) {
    // Lật thật 1 lần; cùng lúc đặt độ lệch để mắt vẫn thấy trang cũ, rồi trượt độ lệch về 0.
    // epub.js đôi khi để cờ "bỏ qua lần cuộn kế" sau lần tự cuộn của nó → xoá cờ để nó xử lý lần cuộn này
    // (nạp sẵn chương kế, cập nhật vị trí). Sau khi trượt xong vẫn yêu cầu báo vị trí cho chắc.
    R.rendition.manager.ignore = false;
    c.scrollLeft = start + dir * delta;
    await animShift(shift + dir * delta, 0, 320);
    R.rendition?.reportLocation();
  } else {
    // Chương kế chưa kịp nạp: cho trang cũ trượt ra, rồi chương mới trượt vào
    await animShift(shift, -dir * c.offsetWidth, 240);
    await go();
    setShift(0);
    slideIn(dir);
  }
}
const next = () => turn(1);
const prev = () => turn(-1);

// Kéo trang theo ngón tay (dùng chung cho khung sách và 2 vùng chạm mép)
let drag = null;
function dragStart(x, y) {
  finishSlide();
  finishCurl();
  const p = pager();
  drag = { x, y, time: Date.now(), scroll: p ? p.c.scrollLeft : 0, active: false, shift: 0, lastX: x, lastT: Date.now(), v: 0 };
}
function dragMove(x, y) {
  const s = drag;
  if (!s) return;
  const p = pager();
  if (!p || reduceMotion()) return;
  const dx = x - s.x, dy = y - s.y;
  if (!s.active) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) s.active = true;
    else return;
  }
  const max = p.c.scrollWidth - p.c.offsetWidth;
  if (isCurl()) { // lật giấy: góc trang gấp theo ngón tay
    const now = Date.now();
    s.v = (x - s.lastX) / Math.max(1, now - s.lastT);
    s.lastX = x; s.lastT = now;
    if (!s.curl && !s.noCurl) { s.curl = curlBegin(dx < 0 ? 1 : -1); if (!s.curl) s.noCurl = true; }
    if (s.curl) {
      const prog = Math.min(1, Math.abs(dx) / (p.c.offsetWidth * 0.95));
      s.lift = Math.max(-0.12, Math.min(0.3, -dy / p.c.offsetHeight)); // kéo lên → góc nhấc cao hơn
      s.curl.set(s.curl.dir > 0 ? prog : 1 - prog, s.lift);
    }
    return;
  }
  // Ở đầu/cuối chương không còn trang bên cạnh → kéo có lực cản
  const atEdge = (dx > 0 && s.scroll <= 1) || (dx < 0 && s.scroll >= max - 1);
  s.shift = atEdge ? dx / 3 : dx;
  setShift(s.shift);
  const now = Date.now();
  s.v = (x - s.lastX) / Math.max(1, now - s.lastT);
  s.lastX = x; s.lastT = now;
}
function cancelDrag() {
  const s = drag;
  drag = null;
  if (s?.curl) { s.curl.end(false); return; }
  if (s?.active) animShift(s.shift, 0, 200);
}
// Trả về 'tap' nếu là một cú chạm, 'done' nếu đã xử lý (lật/kéo), '' nếu bỏ qua.
function dragEnd(x, y) {
  const s = drag;
  drag = null;
  if (!s) return '';
  const dx = x - s.x, dy = y - s.y, dt = Date.now() - s.time;
  const p = pager();
  if (s.curl) { // đang gấp giấy theo tay: đủ xa hoặc vuốt nhanh đúng chiều → lật hẳn, không thì trả về
    const fling = Math.abs(s.v) > 0.35 && Math.sign(-s.v) === s.curl.dir;
    const back = Math.abs(s.v) > 0.35 && Math.sign(-s.v) === -s.curl.dir;
    const prog = s.curl.dir > 0 ? s.curl.t : 1 - s.curl.t;
    s.curl.end(!back && (fling || prog > 0.28), s.lift || 0);
    return 'done';
  }
  if (s.active && p) {
    const fling = Math.abs(s.v) > 0.35;
    if (fling || Math.abs(dx) > p.c.offsetWidth * 0.18) turn((fling ? s.v : dx) < 0 ? 1 : -1, s.scroll, s.shift);
    else animShift(s.shift, 0, 200); // chưa đủ xa → trượt về chỗ cũ
    return 'done';
  }
  if (settings.flow === 'paginated' && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) && dt < 1000) {
    turn(dx < 0 ? 1 : -1, s.scroll);
    return 'done';
  }
  return Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 500 ? 'tap' : '';
}

// Vùng chạm 2 mép nằm trên trang app (ngoài khung sách) → luôn nhận chạm/vuốt trên iPhone/iPad,
// kể cả khi Safari không chuyển sự kiện vào trong khung sách.
function bindTapZone(el, action) {
  el.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    dragStart(t.screenX, t.screenY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) dragMove(t.screenX, t.screenY);
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    e.preventDefault(); // không phát thêm "click"
    if (dragEnd(t.screenX, t.screenY) === 'tap') action();
  }, { passive: false });
  el.addEventListener('touchcancel', cancelDrag);
  el.addEventListener('click', action); // chuột / bút cảm ứng
}
bindTapZone($('tapPrev'), prev);
bindTapZone($('tapNext'), next);
$('btnNext').onclick = next;
$('btnPrev').onclick = prev;
// Chủ động quay về thư viện → lần sau mở app vào thư viện
$('btnBack').onclick = () => { lastBook.forget(); closeBook(); };

function onKey(e) {
  if (!(R.rendition || R.pdf) || e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return false;
  if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && settings.flow === 'paginated')) { next(); return true; }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) { prev(); return true; }
  if (e.key === 'Escape') { $('tocPanel').hidden = true; $('settingsPanel').hidden = true; }
  return false;
}
document.addEventListener('keydown', (e) => {
  if ($('reader').classList.contains('active') && !$('accountDialog').open && onKey(e)) e.preventDefault();
});

// Chạm trái/phải để lật trang, chạm giữa để ẩn/hiện thanh công cụ, vuốt ngang để lật
// iPhone/iPad (Safari) không phát sự kiện "click" khi chạm vào chữ thường trong iframe,
// nên chạm và vuốt được nhận trực tiếp từ touchstart/touchend. Chuột (máy tính) vẫn dùng click.
let lastTouchEnd = 0;
let pinch = null; // chụm/mở 2 ngón để đổi cỡ chữ
const touchDist = (ts) => Math.hypot(ts[0].screenX - ts[1].screenX, ts[0].screenY - ts[1].screenY);
function onTouchStart(e) {
  if (e.touches?.length === 2) {
    const d = touchDist(e.touches);
    pinch = { d0: d, d };
    cancelDrag();
    return;
  }
  const t = e.changedTouches?.[0];
  if (t && !pinch) dragStart(t.screenX, t.screenY);
}
function onTouchMove(e) {
  if (pinch) { if (e.touches?.length === 2) pinch.d = touchDist(e.touches); return; }
  const t = e.touches?.[0];
  if (t) dragMove(t.screenX, t.screenY);
}
function onTouchEnd(e) {
  lastTouchEnd = Date.now();
  if (pinch) {
    if (e.touches?.length) return; // còn ngón trên màn hình
    const ratio = pinch.d / pinch.d0;
    pinch = null;
    drag = null;
    if (ratio > 1.12 || ratio < 0.89) {
      const target = Math.round((settings.fontSize * Math.sqrt(ratio)) / 10) * 10; // dịu hơn tỉ lệ ngón tay
      const step = ratio > 1 ? Math.max(target, settings.fontSize + 10) : Math.min(target, settings.fontSize - 10);
      const size = Math.min(200, Math.max(60, step));
      if (size !== settings.fontSize) { changeSetting({ fontSize: size }); toast(`Cỡ chữ ${size}%`, null, null, 1200); }
    }
    return;
  }
  const t = e.changedTouches?.[0];
  if (!t) { drag = null; return; }
  if (dragEnd(t.screenX, t.screenY) === 'tap') handleTap(e.view, t.clientX, e.target);
}
function onFrameClick(e) {
  if (Date.now() - lastTouchEnd < 800) return; // đã xử lý bằng cảm ứng
  handleTap(e.view, e.clientX, e.target);
}
function handleTap(evView, clientX, target) {
  const view = evView || target?.ownerDocument?.defaultView;
  if (target?.closest?.('a')) return;
  const sel = view?.getSelection?.();
  if (sel && sel.toString().length) return;
  const frame = view?.frameElement;
  tapAt((frame ? frame.getBoundingClientRect().left : 0) + clientX);
}
// Chạm ở vị trí x (toạ độ cửa sổ app): mép trái/phải lật trang, giữa ẩn/hiện thanh công cụ
function tapAt(x) {
  if (!$('tocPanel').hidden || !$('settingsPanel').hidden) { $('tocPanel').hidden = true; $('settingsPanel').hidden = true; return; }
  const wrap = $('viewerWrap').getBoundingClientRect();
  const f = (x - wrap.left) / wrap.width;
  if (settings.flow === 'paginated' && f < 0.3) prev();
  else if (settings.flow === 'paginated' && f > 0.7) next();
  else $('reader').classList.toggle('immersive');
}

const slider = $('progressSlider');
const sliderPage = () => 1 + Math.round((slider.value / 1000) * (R.pdf.pages - 1));
slider.oninput = () => {
  $('progressText').textContent = R.kind === 'pdf' && R.pdf
    ? `Trang ${sliderPage()}/${R.pdf.pages}`
    : `${Math.round(slider.value / 10)}%`;
};
slider.onchange = () => {
  if (R.kind === 'pdf') { R.pdf?.goTo(sliderPage()); slider.blur(); return; }
  if (!R.book?.locations.length()) return;
  const cfi = R.book.locations.cfiFromPercentage(slider.value / 1000);
  R.rendition.display(cfi);
  slider.blur();
};

/* ================= Đọc to ================= */
const RATES = [1, 1.25, 1.5, 1.75, 2];
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,pre,figcaption,td,th,div';
let ttsRestartAfterRender = false;

// Hai bộ đọc: giọng có sẵn của máy (Web Speech) và giọng Google Cloud (phát như tệp âm thanh → đọc được
// khi khoá màn hình). Khoá Google được lưu trong progress.json trên Drive (dùng chung mọi máy), không nằm trong mã.
const gKey = () => sync.getPref('gTtsKey') || lsGet('gTtsKey', '');
const useGoogle = () => settings.ttsEngine === 'google' || (settings.ttsEngine !== 'device' && !!gKey());
const speakerOpts = {
  getRate: () => settings.ttsRate,
  getVoiceURI: () => settings.ttsVoice,
  getKey: gKey,
  getGoogleVoice: () => settings.gVoice || GOOGLE_DEFAULT_VOICE,
  onSegment: (seg) => { ttsFollow(seg); schedulePrefetch(seg); },
  onState: (state, ev) => ttsUI(state, ev),
  onError: (msg) => toast(`Giọng Google: ${msg}`, null, null, 6000),
  getMeta: () => {
    if (R.meta?.cover && !R.coverUrl) R.coverUrl = URL.createObjectURL(R.meta.cover);
    return { title: R.meta?.title, artist: R.meta?.author, album: $('rChapter').textContent, artwork: R.coverUrl };
  },
};
const deviceSpeaker = ttsSupported ? new Speaker(speakerOpts) : null;
const googleSpeaker = new CloudSpeaker(speakerOpts);
const aiSpeaker = new AiSpeaker({ ...speakerOpts, getAiVoice: () => settings.bgVoice || AI_DEFAULT_VOICE });
let speaker = useGoogle() ? googleSpeaker : deviceSpeaker;
if (location.hostname === 'localhost') Object.assign(window, { __dev: deviceSpeaker, __ai: aiSpeaker, __cur: () => speaker, __flash: (c) => flashLine(c) });

/* ----- Khi khoá màn hình / chuyển app: chuyển sang giọng AI trong máy; mở lại: về giọng của máy ----- */
// Giọng có sẵn của máy (Chrome Android) tự dừng khi app bị ẩn; giọng AI phát như tệp âm thanh nên chạy tiếp.
const bgAiOn = () => settings.bgVoice && settings.bgVoice !== 'off' && !!AI_VOICES[settings.bgVoice];
function chainProvider(segs, base) {
  const q = segs.filter(Boolean);
  return { next: async () => (q.length ? q.shift() : base.next()) };
}
// Chuyển việc đọc từ bộ này sang bộ kia, đọc tiếp đúng câu đang đọc (và các câu đã chuẩn bị sẵn)
function handoff(from, to) {
  if (!from || !to || from.state === 'idle' || !from.provider) return;
  // Bộ đọc phát qua luồng: câu đang phát thật sự + các câu đã chuẩn bị chưa phát
  const segs = from.nowSeg ? [from.nowSeg(), ...from.pendingSegs()] : [from.current, ...(from.ahead || []).map((i) => i.seg)];
  const prov = chainProvider(segs, from.provider);
  const paused = from.state === 'paused';
  from.keepStream = true; // luồng âm thanh phải chạy liên tục khi chuyển giọng (nhất là lúc đã khoá màn hình)
  from.stop(true);
  from.keepStream = false;
  speaker = to;
  to.start(prov);
  if (paused) to.pause();
}
const aiAlways = () => settings.openVoice === 'ai' && bgAiOn();
// Máy này không phát thẳng được khi khoá màn hình → luồng âm thanh vừa đổi cách phát: đọc lại từ câu đang dở
stream.onRouteChange = () => { if (speaker && speaker !== deviceSpeaker && speaker.state === 'playing') handoff(speaker, speaker); };
document.addEventListener('visibilitychange', () => {
  if (aiAlways()) return; // dùng giọng AI suốt → không đổi giọng
  if (document.hidden) {
    if (speaker === deviceSpeaker && speaker.state === 'playing' && bgAiOn()) handoff(deviceSpeaker, aiSpeaker);
  } else if (speaker === aiSpeaker && aiSpeaker.state !== 'idle' && deviceSpeaker) {
    handoff(aiSpeaker, deviceSpeaker);
  }
});

// Tải trước giọng AI (lần đầu) khi bắt đầu đọc to — để lúc khoá màn hình có ngay
let aiDownloading = false;
const aiStored = {}; // giọng AI nào đã tải về máy (kiểm tra khi mở app)
async function prepareBackgroundVoice() {
  if (!bgAiOn() || aiDownloading) return;
  const v = settings.bgVoice;
  if (await aiVoiceStored(v)) { aiStored[v] = true; aiWarmup(v).catch(() => {}); return; }
  aiDownloading = true;
  toast(`Đang tải giọng AI (${AI_VOICES[v].size}) để đọc tiếp khi khoá màn hình…`, null, null, 4000);
  let last = 0;
  try {
    await aiDownload(v, (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      if (pct >= last + 20) { last = pct; toast(`Đang tải giọng AI… ${pct}%`, null, null, 2500); }
    });
    toast('Đã tải xong giọng AI — giờ khoá màn hình vẫn nghe tiếp được', null, null, 4000);
    aiStored[v] = true;
    aiWarmup(v).catch(() => {});
    // Đang chọn "giọng AI suốt" mà lúc bắt đầu chưa có giọng → chuyển sang giọng AI ngay khi tải xong
    if (aiAlways() && speaker === deviceSpeaker && deviceSpeaker.state === 'playing') handoff(deviceSpeaker, aiSpeaker);
  } catch (e) {
    toast(`Không tải được giọng AI: ${e.message || e}`, null, null, 6000);
  } finally { aiDownloading = false; }
}
let ttsNeedsResync = false; // đã đọc sang chương khác trong lúc app bị ẩn → khi quay lại thì nhảy tới chương đó

/* ----- Giảm nóng máy: tạo trước giọng AI lúc màn hình còn bật ----- */
// Khi đang đọc to và màn hình bật, lấy các câu sắp đọc (hết chương này + tối đa 2 chương sau) rồi cho giọng AI
// tạo sẵn ở nền. Tắt màn hình → giọng AI dùng luôn phần đã tạo, máy gần như không phải tính nên đỡ nóng.
const PREFETCH_EVERY_MS = 20000;
const PREFETCH_MAX_SEGS = 600;
let prefetchAt = 0;
let prefetchSec = null;
function canPrefetch() {
  return !document.hidden && R.kind !== 'pdf' && R.book && bgAiOn() && aiStored[settings.bgVoice]
    && speaker && (speaker === deviceSpeaker || speaker === aiSpeaker) && speaker.state === 'playing';
}
async function upcomingTexts(seg) {
  const out = [];
  let idx;
  if (seg.contents && seg.range) {
    idx = seg.contents.sectionIndex;
    const list = epubSegments(seg.contents, seg.range.startContainer, seg.range.startOffset);
    out.push(...list.slice(1).map((s) => s.text));
  } else if (seg.offline && seg.sectionIndex != null) {
    idx = seg.sectionIndex;
    const sec = R.book.spine.get(idx);
    const doc = await sec.load(R.book.load.bind(R.book));
    const list = epubSegments({ document: doc.ownerDocument || doc }, null).map((s) => s.text);
    const k = list.indexOf(seg.text);
    out.push(...list.slice(k + 1));
  } else return out;
  for (let n = 1; n <= 2 && out.length < PREFETCH_MAX_SEGS; n++) {
    const sec = R.book.spine.get(idx + n);
    if (!sec) break;
    const doc = await sec.load(R.book.load.bind(R.book));
    out.push(...epubSegments({ document: doc.ownerDocument || doc }, null).map((s) => s.text));
  }
  return out.slice(0, PREFETCH_MAX_SEGS);
}
function schedulePrefetch(seg) {
  if (!seg || !canPrefetch()) return;
  const secIdx = seg.contents?.sectionIndex ?? seg.sectionIndex;
  const now = Date.now();
  if (now - prefetchAt < PREFETCH_EVERY_MS && secIdx === prefetchSec) return;
  prefetchAt = now; prefetchSec = secIdx;
  upcomingTexts(seg).then((texts) => {
    // Bỏ các câu bộ đọc giọng AI đã tự chuẩn bị sẵn (đỡ tạo trùng)
    const have = new Set(speaker === aiSpeaker ? aiSpeaker.pendingSegs().map((s) => s?.text) : []);
    texts = texts.filter((t) => !have.has(t));
    if (texts.length && canPrefetch()) aiPrefetch(settings.bgVoice, settings.ttsRate, texts);
  }).catch((e) => console.warn('Tạo trước giọng AI:', e));
}
// Tắt màn hình / dừng đọc → ngừng tạo trước (để máy nghỉ); giọng AI vẫn dùng phần đã tạo
document.addEventListener('visibilitychange', () => { if (document.hidden) aiPrefetchStop(); else prefetchAt = 0; });
if (location.hostname === 'localhost') Object.assign(window, { __aiCache: aiCacheInfo, __aiStats: aiStats, __aiCacheClear: aiCacheClear, __upcoming: upcomingTexts, __segs: epubSegments });

if (location.hostname === 'localhost') window.__speaker = speaker; // chỉ để kiểm thử trên máy

const findContents = (idx) => R.rendition?.getContents().find((c) => c.sectionIndex === idx);

// Các câu của 1 chương EPUB (đã hiển thị) kể từ điểm (startNode, startOffset) — bắt đầu đúng câu chứa điểm đó;
// mỗi câu kèm Range để tô sáng & lật trang theo; câu cuối mỗi đoạn văn có paraEnd (để nghỉ lâu hơn chút)
function epubSegments(contents, startNode, startOffset) {
  const doc = contents.document;
  let blocks = [...doc.body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS) && el.textContent.trim());
  if (!blocks.length && doc.body.textContent.trim()) blocks = [doc.body];
  let i0 = 0;
  if (startNode) {
    i0 = blocks.findIndex((b) => b.contains(startNode)
      || (startNode.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (i0 < 0) return [];
  }
  const segs = [];
  for (const block of blocks.slice(i0)) {
    const nodes = [];
    let full = '';
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, full.length]); full += n.nodeValue; }
    const at = (i) => { // vị trí ký tự → (nút chữ, offset)
      let k = nodes.length - 1;
      while (k > 0 && nodes[k][1] > i) k--;
      return [nodes[k][0], Math.min(i - nodes[k][1], nodes[k][0].nodeValue.length)];
    };
    const first = segs.length;
    for (const [s, e] of splitSentences(full)) {
      const range = doc.createRange();
      try { range.setStart(...at(s)); range.setEnd(...at(e)); } catch { continue; }
      // Bỏ các câu nằm hẳn trước điểm bắt đầu (điểm ở giữa đoạn văn)
      if (startNode && segs.length === 0) {
        try { if (range.comparePoint(startNode, startOffset || 0) > 0) continue; } catch { /* giữ câu */ }
      }
      segs.push({ text: full.slice(s, e).trim().normalize('NFC'), range, contents });
    }
    if (segs.length > first) segs[segs.length - 1].paraEnd = true;
  }
  return segs;
}

function epubProvider() {
  let queue = null;
  let secIndex = null;
  return {
    async next() {
      if (!queue) {
        const loc = R.rendition.currentLocation();
        secIndex = loc?.start?.index;
        const c = findContents(secIndex);
        // Đọc tiếp đúng câu đang đọc dở (nếu câu đó còn trong trang này), không thì từ đầu trang
        const from = loc?.start && lineOnPage(R.line, loc) ? R.line : loc?.start?.cfi;
        let r = null;
        try { r = c?.range(from); } catch { /* bắt đầu từ đầu chương */ }
        queue = c ? epubSegments(c, r?.startContainer, r?.startOffset) : [];
      }
      while (!queue.length) { // hết chương → sang chương sau
        const sec = R.book?.spine.get(secIndex + 1);
        if (!sec) return null;
        let c = findContents(sec.index);
        if (!c && document.hidden) {
          // App đang ẩn (khoá màn hình / chuyển app): trình duyệt tạm dừng vẽ trang nên không dựng được
          // chương mới → đọc thẳng từ nội dung sách; quay lại app sẽ nhảy tới chương này.
          const doc = await sec.load(R.book.load.bind(R.book));
          secIndex = sec.index;
          queue = epubSegments({ document: doc.ownerDocument || doc }, null).map((s) => ({ ...s, offline: true, sectionIndex: sec.index }));
          continue;
        }
        // Chương kế thường đã được nạp sẵn (chế độ continuous); nếu đang nạp dở thì đợi một chút
        for (let i = 0; !c && i < 20; i++) {
          try { R.rendition.manager?.check?.(); } catch { /* bỏ qua */ }
          await new Promise((r) => setTimeout(r, 100));
          c = findContents(sec.index);
        }
        if (!c) { await R.rendition.display(sec.href); c = findContents(sec.index); }
        if (!c) return null;
        secIndex = sec.index;
        queue = epubSegments(c, null);
      }
      return queue.shift();
    },
  };
}

function pdfProvider() {
  let page = R.pdf.page - 1;
  let queue = [];
  let empty = 0;
  return {
    async next() {
      while (!queue.length) {
        page++;
        if (!R.pdf || page > R.pdf.pages) return null;
        const pg = await R.pdf.doc.getPage(page);
        const tc = await pg.getTextContent();
        const text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').replace(/-\n(?=\p{Ll})/gu, '').replace(/\s*\n\s*/g, ' ');
        queue = splitSentences(text).map(([s, e]) => ({ text: text.slice(s, e).trim(), page }));
        if (!queue.length && ++empty >= 3) {
          toast('Các trang này không có chữ (có thể là PDF scan) nên không đọc to được', null, null, 6000);
          return null;
        }
        if (queue.length) empty = 0;
      }
      return queue.shift();
    },
  };
}

// Tô sáng câu đang đọc và lật trang theo giọng đọc
function clearTtsHighlight() {
  for (const c of R.rendition?.getContents() || []) {
    try { c.window.CSS?.highlights?.delete('tts'); } catch { /* bỏ qua */ }
  }
}
function ttsFollow(seg) {
  if (R.kind === 'pdf') {
    if (!R.pdf || seg.page === R.pdf.page) return;
    if (settings.flow === 'paginated' && seg.page === R.pdf.page + 1) R.pdf.turn(1); else R.pdf.goTo(seg.page);
    return;
  }
  if (!R.rendition) return;
  if (seg.offline) { // câu lấy từ nội dung sách lúc app bị ẩn (chương chưa hiển thị)
    if (document.hidden) {
      ttsNeedsResync = seg.sectionIndex; speaker?.setupMediaSession();
      // Vẫn lưu & đồng bộ đúng câu đang đọc dù app đang ẩn
      const sec = R.book?.spine.get(seg.sectionIndex);
      if (sec) {
        try {
          const r = seg.range.cloneRange(); r.collapse(true);
          markLine(new ePub.CFI(r, sec.cfiBase).toString(), currentChapter(sec.href)?.label);
        } catch { /* bỏ qua */ }
      }
      return;
    }
    const c = findContents(seg.sectionIndex);
    if (!c) { // đã mở lại app: nhảy tới chương đang đọc
      ttsNeedsResync = false;
      const sec = R.book?.spine.get(seg.sectionIndex);
      if (sec) R.rendition.display(lineIn(sec.index) || sec.href);
      return;
    }
    // Chương đã hiển thị: tìm lại đúng câu đó trong trang để tô sáng & lật theo
    c.ttsSegs ||= epubSegments(c, null);
    c.ttsIdx ||= 0;
    const k = c.ttsSegs.findIndex((s, i) => i >= c.ttsIdx && s.text === seg.text);
    if (k < 0) return;
    c.ttsIdx = k + 1;
    seg = c.ttsSegs[k];
  }
  clearTtsHighlight();
  try { const r = seg.range.cloneRange(); r.collapse(true); markLine(seg.contents.cfiFromRange(r)); } catch { /* bỏ qua */ }
  const win = seg.contents.window;
  try { if (win.CSS?.highlights && win.Highlight) win.CSS.highlights.set('tts', new win.Highlight(seg.range)); } catch { /* bỏ qua */ }
  const rect = seg.range.getClientRects()[0] || seg.range.getBoundingClientRect();
  const frame = win.frameElement;
  if (!rect || !frame) return;
  const fr = frame.getBoundingClientRect();
  const wrap = $('viewerWrap').getBoundingClientRect();
  const x = fr.left + rect.left + 2, y = fr.top + rect.top + 2;
  const visible = settings.flow === 'paginated'
    ? x >= wrap.left && x < wrap.right
    : y >= wrap.top && y < wrap.bottom - 20;
  if (visible) return;
  const p = pager();
  if (p && x >= wrap.right && x < wrap.right + p.delta) turn(1);
  else R.rendition.display(seg.contents.cfiFromRange(seg.range));
}

// Câu đang đọc nếu nó thuộc chương idx (để quay lại app thì mở đúng trang chứa câu đó)
const lineIn = (idx) => { try { return R.line && new ePub.CFI(R.line).spinePos === idx ? R.line : null; } catch { return null; } };

// Ghi nhớ câu đang đọc (lưu trên máy ngay, gửi lên đám mây thưa) → máy khác mở đúng câu này
function markLine(cfi, chapter) {
  if (!cfi || !R.id) return;
  R.line = cfi;
  if (R.book?.locations.length()) R.percent = R.book.locations.percentageFromCfi(cfi) || R.percent;
  saveProgress(chapter ?? $('rChapter').textContent ?? '', true);
}

function ttsStart() {
  if (!(R.rendition || R.pdf)) return;
  stream.ensure(); // mở luồng âm thanh ngay trong lúc bấm nút (trình duyệt chỉ cho phép khi có thao tác chạm)
  let next = useGoogle() ? googleSpeaker : deviceSpeaker;
  if (!useGoogle() && aiAlways() && aiStored[settings.bgVoice]) next = aiSpeaker; // giọng AI suốt
  if (!next) { toast('Trình duyệt này không hỗ trợ đọc to'); return; }
  if (speaker && speaker !== next) speaker.stop(true);
  speaker = next;
  if (speaker === googleSpeaker && !gKey()) {
    toast('Chưa có khoá giọng Google — nhập ở Aa → Khoá giọng Google', null, null, 6000);
    return;
  }
  if (speaker === deviceSpeaker && !pickVoice(settings.ttsVoice)) {
    toast('Máy này chưa có giọng tiếng Việt — giọng mặc định có thể đọc sai. Chọn giọng ở Aa → Giọng đọc.', null, null, 7000);
  }
  speaker.start(R.kind === 'pdf' ? pdfProvider() : epubProvider());
  if (speaker === deviceSpeaker || speaker === aiSpeaker) prepareBackgroundVoice();
}
function ttsUI(state, ev) {
  if (state !== 'playing') aiPrefetchStop();
  $('ttsBar').hidden = state === 'idle';
  $('btnTts').classList.toggle('on', state !== 'idle');
  $('ttsPlay').textContent = state === 'playing' ? '⏸' : '▶';
  $('ttsPlay').setAttribute('aria-label', state === 'playing' ? 'Tạm dừng' : 'Đọc tiếp');
  $('ttsRate').textContent = `${settings.ttsRate}×`;
  if (state === 'idle') clearTtsHighlight();
  if (state !== 'playing' && R.pendingPush) flushPush(); // tạm dừng / dừng đọc → gửi ngay câu đang đọc lên đám mây
  if (ev === 'end') toast('Đã đọc đến hết sách', null, null, 3000);
}
$('btnTts').onclick = () => {
  if (!useGoogle()) unlockSpeech();
  if (!speaker || speaker.state === 'idle') ttsStart();
  else if (speaker.state === 'playing') speaker.pause();
  else speaker.resume();
};
$('ttsPlay').onclick = () => {
  if (speaker === deviceSpeaker) unlockSpeech();
  if (speaker.state === 'playing') speaker.pause(); else speaker.resume();
};
$('ttsStop').onclick = () => speaker?.stop();
$('ttsRate').onclick = () => {
  settings.ttsRate = RATES[(RATES.indexOf(settings.ttsRate) + 1) % RATES.length] || 1.5;
  saveSettings();
  $('ttsRate').textContent = `${settings.ttsRate}×`;
  $('ttsRateSel').value = String(settings.ttsRate);
  speaker?.refresh();
};

// Danh sách giọng: giọng Google (nếu có khoá) và giọng của máy (giọng tiếng Việt lên đầu)
let gVoiceCache = null;
async function fillVoices() {
  const sel = $('ttsVoiceSel');
  const key = gKey();
  $('gKeyState').textContent = key ? 'Đã lưu ✓' : 'Chưa có';
  $('gKeyBtn').textContent = key ? 'Đổi' : 'Nhập khoá';
  $('ttsEngineSel').value = settings.ttsEngine || 'auto';
  $('bgVoiceSel').value = settings.bgVoice || 'off';
  $('openVoiceSel').value = settings.openVoice || 'device';
  $('ttsRateSel').value = String(settings.ttsRate);
  let html = '';
  if (key) {
    if (!gVoiceCache) {
      try { gVoiceCache = await googleVoices(key); } catch (e) { gVoiceCache = []; toast(`Giọng Google: ${e.message}`, null, null, 6000); }
    }
    html += `<optgroup label="Google (đọc được khi khoá màn hình)">${gVoiceCache.map((v) =>
      `<option value="g:${esc(v.name)}">${esc(v.name.replace('vi-VN-', ''))} · ${esc(v.gender)} · ${esc(v.tier)}</option>`).join('')}</optgroup>`;
  }
  if (ttsSupported) {
    const vs = voices().slice().sort((a, b) => (isVietnamese(b) - isVietnamese(a)) || a.name.localeCompare(b.name));
    const auto = pickVoice('');
    html += `<optgroup label="Giọng của máy"><option value="d:">Tự chọn${auto ? ` (${esc(auto.name)})` : ' — chưa có giọng tiếng Việt'}</option>`
      + vs.map((v) => `<option value="d:${esc(v.voiceURI)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('')
      + '</optgroup>';
  }
  sel.innerHTML = html;
  sel.value = useGoogle() ? `g:${settings.gVoice || GOOGLE_DEFAULT_VOICE}` : `d:${settings.ttsVoice || ''}`;
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
}
if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', () => { if (!$('settingsPanel').hidden) fillVoices(); });
$('ttsVoiceSel').onchange = (e) => {
  const v = e.target.value;
  const wasPlaying = speaker && speaker.state !== 'idle';
  if (v.startsWith('g:')) { settings.gVoice = v.slice(2); if (settings.ttsEngine === 'device') settings.ttsEngine = 'auto'; }
  else { settings.ttsVoice = v.slice(2); settings.ttsEngine = 'device'; }
  saveSettings();
  $('ttsEngineSel').value = settings.ttsEngine;
  const target = useGoogle() ? googleSpeaker : deviceSpeaker;
  if (wasPlaying && target !== speaker) { speaker.stop(true); ttsStart(); } else speaker?.refresh(true);
};
$('openVoiceSel').onchange = (e) => {
  settings.openVoice = e.target.value;
  saveSettings();
  // Đổi ngay nếu đang đọc
  if (aiAlways() && speaker === deviceSpeaker && deviceSpeaker.state !== 'idle') {
    if (aiStored[settings.bgVoice]) handoff(deviceSpeaker, aiSpeaker); else prepareBackgroundVoice();
  } else if (!aiAlways() && speaker === aiSpeaker && aiSpeaker.state !== 'idle' && deviceSpeaker && !document.hidden) {
    handoff(aiSpeaker, deviceSpeaker);
  }
};
$('bgVoiceSel').onchange = (e) => {
  settings.bgVoice = e.target.value;
  saveSettings();
  if (speaker === deviceSpeaker && speaker.state !== 'idle') prepareBackgroundVoice();
};
$('ttsEngineSel').onchange = (e) => {
  settings.ttsEngine = e.target.value;
  saveSettings();
  const wasPlaying = speaker && speaker.state !== 'idle';
  if (wasPlaying) { speaker.stop(true); ttsStart(); }
  fillVoices();
};
// Nhập khoá Google một lần → lưu lên Drive để mọi thiết bị dùng chung
$('gKeyBtn').onclick = async () => {
  const key = (prompt('Dán khoá API Google Cloud Text-to-Speech (bắt đầu bằng AIza…):') || '').trim();
  if (!key) return;
  try {
    gVoiceCache = await googleVoices(key);
  } catch (e) { toast(`Khoá không dùng được: ${e.message}`, null, null, 7000); return; }
  lsSet('gTtsKey', key);
  try { await sync.setPref('gTtsKey', key); toast('Đã lưu khoá giọng Google cho mọi thiết bị', null, null, 4000); }
  catch { toast('Đã lưu khoá trên máy này (chưa đồng bộ được lên Drive — hãy đăng nhập Google Drive)', null, null, 6000); }
  if (settings.ttsEngine === 'device') { settings.ttsEngine = 'auto'; saveSettings(); }
  fillVoices();
};
$('ttsRateSel').onchange = (e) => {
  settings.ttsRate = Number(e.target.value) || 1.5;
  saveSettings();
  $('ttsRate').textContent = `${settings.ttsRate}×`;
  speaker?.refresh();
};

/* ----- Bảng mục lục & cài đặt ----- */
/* ----- Chạm ra ngoài menu là tự đóng (không cần bấm ✕) ----- */
// Bảng Mục lục / Aa khi đọc: chạm bất cứ đâu ngoài bảng (thanh trên, thanh dưới, lề…) → đóng.
// (Chạm vào trang sách đã được tapAt() xử lý: đóng bảng thay vì lật trang.)
document.addEventListener('pointerdown', (e) => {
  const open = ['tocPanel', 'settingsPanel'].filter((id) => !$(id).hidden);
  if (!open.length) return;
  if (open.some((id) => $(id).contains(e.target))) return;
  if (e.target.closest?.('#btnToc, #btnSettings')) return; // nút mở/đóng tự xử lý
  open.forEach((id) => { $(id).hidden = true; });
}, true);
// Thông báo nhỏ ở đáy màn hình: chạm vào chỗ khác → tắt (nút trong thông báo vẫn bấm được)
document.addEventListener('pointerdown', (e) => {
  if (!$('toast').hidden && !$('toast').contains(e.target)) hideToast();
}, true);
// Mọi hộp thoại (Đồng bộ, Google Drive…): chạm ra vùng tối bên ngoài khung → đóng
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  });
}

$('btnToc').onclick = () => { $('settingsPanel').hidden = true; $('tocPanel').hidden = !$('tocPanel').hidden; document.querySelector('#tocList a.current')?.scrollIntoView({ block: 'center' }); };
$('btnSettings').onclick = () => { $('tocPanel').hidden = true; $('settingsPanel').hidden = !$('settingsPanel').hidden; fillVoices(); showScreenInfo(); showStorageInfo(); };
$('btnStats').onclick = openStats;
$('statsClose').onclick = () => $('statsDialog').close();
$('justifyMode').onchange = (e) => changeSetting({ justify: e.target.value === 'on' });
/* ----- Android toàn màn hình: thanh trạng thái của máy bị ẩn → app tự hiện đồng hồ + % pin ở mép trên ----- */
// (trình duyệt không cho app web đọc sóng điện thoại / wifi, nên chỉ có giờ và pin)
const wantSysbar = () => (/Android/i.test(navigator.userAgent) && matchMedia('(display-mode: fullscreen)').matches)
  || (location.hostname === 'localhost' && lsGet('forceSysbar', false)); // thử trên máy
let sysBattery = null;
function renderSysbar() {
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const lv = sysBattery ? Math.round(sysBattery.level * 100) : null;
  const bat = lv == null ? '' : `${sysBattery.charging ? '⚡' : ''}${lv}%<i class="sb-cell"><b style="width:${lv}%"></b></i>`;
  document.querySelectorAll('.sysbar').forEach((el) => {
    el.querySelector('.sb-time').textContent = time;
    const b = el.querySelector('.sb-bat');
    b.innerHTML = bat;
    b.classList.toggle('low', lv != null && lv <= 20 && !sysBattery.charging);
  });
}
function setupSysbar() {
  const on = wantSysbar();
  document.body.classList.toggle('has-sysbar', on);
  if (!on) return;
  for (const host of [$('library'), $('reader')]) {
    if (host.querySelector(':scope > .sysbar')) continue;
    const el = document.createElement('div');
    el.className = 'sysbar';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="sb-time"></span><span class="sb-bat"></span>';
    host.appendChild(el);
  }
  renderSysbar();
  if (!setupSysbar.ticking) { // cập nhật đúng lúc sang phút mới
    setupSysbar.ticking = true;
    const tick = () => { renderSysbar(); setTimeout(tick, 60000 - (Date.now() % 60000) + 50); };
    setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  }
  if (!sysBattery && navigator.getBattery) {
    navigator.getBattery().then((b) => {
      sysBattery = b;
      b.addEventListener('levelchange', renderSysbar);
      b.addEventListener('chargingchange', renderSysbar);
      renderSysbar();
    }).catch(() => {});
  }
}
setupSysbar();
matchMedia('(display-mode: fullscreen)').addEventListener?.('change', setupSysbar);
document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.classList.contains('has-sysbar')) renderSysbar(); });

// Số đo màn hình thật (để sửa lỗi toàn màn hình trên từng loại máy): hiện ở dòng cuối menu Aa
function showScreenInfo() {
  try {
    fixIosGap();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    const ps = getComputedStyle(probe); const st = parseFloat(ps.paddingTop) || 0; const sb = parseFloat(ps.paddingBottom) || 0;
    probe.remove();
    const rr = $('reader').getBoundingClientRect();
    const mode = navigator.standalone ? 'app' : matchMedia('(display-mode: fullscreen)').matches ? 'fs' : matchMedia('(display-mode: standalone)').matches ? 'sa' : 'web';
    const sbs = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || '';
    const vv = window.visualViewport ? Math.round(window.visualViewport.height) : '-';
    const info = `Màn ${screen.width}×${screen.height} · vùng ${innerWidth}×${innerHeight} (vv ${vv}, html ${document.documentElement.clientHeight}) · tai thỏ ${st}/${sb} · bù ${getComputedStyle(document.documentElement).getPropertyValue('--ios-gap').trim() || '0'} (đổi ${iosGapChanges}) · đọc ${Math.round(rr.top)}→${Math.round(rr.bottom)} · ${mode} ${sbs.slice(0, 5)}`;
    let el = $('screenInfo');
    if (!el) { el = document.createElement('p'); el.id = 'screenInfo'; el.className = 'hint version'; el.style.cssText = 'font-size:11px;opacity:.75;margin:0;padding:0 16px 10px;text-align:center'; $('appVersion').after(el); }
    el.textContent = info;
  } catch { /* bỏ qua */ }
}
// Menu Aa chia 3 thẻ: Văn bản · Trang · Đọc to (nhớ thẻ đang mở)
function setSettingsTab(tab) {
  if (!document.querySelector(`.set-tab[data-tab="${tab}"]`)) tab = 'text';
  document.querySelectorAll('.set-tabs [data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  document.querySelectorAll('.set-tab').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
  lsSet('setTab', tab);
}
document.querySelectorAll('.set-tabs [data-tab]').forEach((b) => { b.onclick = () => setSettingsTab(b.dataset.tab); });
setSettingsTab(lsGet('setTab', 'text'));
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $(b.dataset.close).hidden = true; }; });
$('fontUp').onclick = () => (R.kind === 'pdf' ? R.pdf?.zoomStep(1) : changeSetting({ fontSize: Math.min(200, settings.fontSize + 10) }));
$('fontDown').onclick = () => (R.kind === 'pdf' ? R.pdf?.zoomStep(-1) : changeSetting({ fontSize: Math.max(60, settings.fontSize - 10) }));
$('lhUp').onclick = () => changeSetting({ lineHeight: Math.min(2.4, +(settings.lineHeight + 0.1).toFixed(1)) });
$('lhDown').onclick = () => changeSetting({ lineHeight: Math.max(1.0, +(settings.lineHeight - 0.1).toFixed(1)) });
$('fontFamily').onchange = (e) => changeSetting({ fontFamily: e.target.value });
$('flowMode').onchange = (e) => changeSetting({ flow: e.target.value });
$('pageAnim').onchange = (e) => {
  settings.pageAnim = e.target.value; saveSettings(); // không cần dựng lại trang
  if (isCurl() && pager()) curlCloneFor(pager().c.scrollLeft); // chuẩn bị sẵn hiệu ứng lật giấy
};
$('startView').onchange = (e) => { settings.startView = e.target.value; saveSettings(); };
$('spreadMode').onchange = (e) => changeSetting({ spread: e.target.value });
document.querySelectorAll('.sw').forEach((b) => { b.onclick = () => changeSetting({ theme: b.dataset.theme }); });

// Lưu ngay khi rời app / chuyển tab / khoá màn hình
// Trang vừa bị hệ thống cho "ngủ" rồi chạy lại (Android) → đọc tiếp ngay và gửi vị trí đang đọc
document.addEventListener('resume', () => { if (speaker?.state === 'playing') speaker.kick?.(); flushPush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPush();
  else {
    sync.resume(!R.id).then(updateAccountUI).catch(() => {}); // quay lại app: lấy tiến độ mới
    if (speaker?.state === 'playing') { speaker.lockScreen(); speaker.kick?.(); } // khoá màn hình bị nhả khi ẩn app
    if (ttsNeedsResync !== false && R.rendition) { // trong lúc ẩn đã đọc sang chương khác → nhảy tới đó
      const sec = R.book?.spine.get(ttsNeedsResync);
      ttsNeedsResync = false;
      if (sec && !findContents(sec.index)) R.rendition.display(lineIn(sec.index) || sec.href);
    }
  }
});
window.addEventListener('pagehide', flushPush);
window.addEventListener('online', updateSyncText);
window.addEventListener('offline', updateSyncText);

/* ================= Tài khoản & đồng bộ ================= */
function updateAccountUI() {
  const u = sync.currentUser();
  const dot = $('syncDot');
  if (!sync.isConfigured()) { $('accountLabel').textContent = 'Chỉ máy này'; dot.className = 'dot off'; }
  else if (!u) { $('accountLabel').textContent = 'Đăng nhập để đồng bộ'; dot.className = 'dot off'; }
  else if (u.needsReconnect) { $('accountLabel').textContent = 'Kết nối lại'; dot.className = 'dot off'; }
  else { $('accountLabel').textContent = u.email || u.providerName; dot.className = 'dot on'; }
  const avail = new Set(sync.providers().map((p) => p.id));
  $('btnOneDrive').hidden = !avail.has('onedrive');
  $('btnGDrive').hidden = !avail.has('gdrive');
  $('syncDisabledNote').hidden = sync.isConfigured();
  $('signedOutBox').hidden = !sync.isConfigured() || !!u;
  $('signedInBox').hidden = !u;
  $('userProvider').textContent = u ? u.providerName : '';
  $('userEmail').textContent = u ? u.email || '' : '';
  $('reconnectNote').hidden = !u?.needsReconnect;
  $('btnReconnect').hidden = !u?.needsReconnect;
  // Nút Google Drive nằm trong dock, luôn hiện ("Mở từ " được ẩn bằng CSS)
  const provs = sync.providers();
  const cloudName = u ? u.providerName : provs.length === 1 ? provs[0].name : 'Đám mây';
  $('cloudBtnLabel').innerHTML = `<span class="lbl-pre">Mở từ </span>${esc(cloudName)}`;
  if (R.id) updateSyncText();
}

$('btnAccount').onclick = () => {
  $('deviceName').value = deviceName;
  updateAccountUI();
  $('accountDialog').showModal();
};
$('deviceName').onchange = (e) => { deviceName = e.target.value.trim() || guessDeviceName(); lsSet('deviceName', deviceName); };

// Trình duyệt nằm trong Zalo/Messenger/Facebook… → Google chặn đăng nhập ("Lỗi 403: disallowed_useragent")
function inAppBrowser() {
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|Zalo|Line\/|MicroMessenger|KAKAOTALK|TikTok|musical_ly|Bytedance|Snapchat|Twitter|Pinterest|; wv\)/i.test(ua)) return true;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
  return /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !standalone; // WebView của app khác trên iPhone
}
function inAppHelpHtml() {
  const android = /Android/i.test(navigator.userAgent);
  const url = location.origin + location.pathname;
  const chrome = android ? ` <a href="intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end">Mở bằng Chrome</a>` : '';
  return `Google không cho đăng nhập trong trình duyệt của Zalo, Messenger, Facebook… (lỗi 403).
    Hãy mở <b>${esc(url)}</b> bằng <b>${android ? 'Chrome' : 'Safari'}</b>: bấm <b>⋯</b> ở góc màn hình → <b>Mở bằng trình duyệt</b>${android ? '' : ' / <b>Mở trong Safari</b>'}.${chrome}
    <button type="button" class="link-btn" id="copyAppLink">Sao chép link</button>`;
}
document.addEventListener('click', (e) => {
  if (e.target.id !== 'copyAppLink') return;
  navigator.clipboard?.writeText(location.origin + location.pathname)
    .then(() => { e.target.textContent = 'Đã sao chép ✓'; }, () => {});
});
if (inAppBrowser()) setTimeout(() => toast('Đang mở trong Zalo/Messenger/Facebook — muốn đăng nhập Google, hãy mở link bằng Safari hoặc Chrome', null, null, 9000), 1500);

// Đăng nhập sẽ chuyển sang trang của Microsoft/Google rồi quay về app
function authAction(fn) {
  $('authError').textContent = '';
  if (inAppBrowser()) { $('authError').innerHTML = inAppHelpHtml(); return; }
  flushPush();
  Promise.resolve().then(fn).catch((e) => { $('authError').textContent = sync.errorText(e); });
}
$('btnOneDrive').onclick = () => authAction(() => sync.signIn('onedrive'));
$('btnGDrive').onclick = () => authAction(() => sync.signIn('gdrive'));
$('btnReconnect').onclick = () => authAction(() => sync.reconnect());
$('btnSignOut').onclick = () => {
  if (!confirm('Đăng xuất? Sách và tiến độ trên máy này vẫn được giữ.')) return;
  sync.signOut();
  $('cloudList').innerHTML = ''; cloudNav.stack = [];
  $('accountDialog').close();
};

// Khi đăng nhập lần đầu trên máy này: đẩy tiến độ cục bộ lên nếu mới hơn bản trên đám mây
async function uploadLocalProgress() {
  const [books, progress] = await Promise.all([db.all('books'), db.all('progress')]);
  const prog = Object.fromEntries(progress.map((p) => [p.id, p]));
  const batch = {};
  for (const b of books) {
    const p = prog[b.id];
    const r = remoteMap[b.id];
    const base = { title: b.title, author: b.author || '', ...(b.source ? { source: b.source } : {}) };
    if (p && (!r || (p.updatedAt || 0) > (r.updatedAt || 0))) {
      batch[b.id] = { ...base, cfi: p.cfi, line: p.line || '', percent: p.percent, chapter: p.chapter || '', updatedAt: p.updatedAt, deviceId, deviceName };
    } else if (!r) batch[b.id] = base;
  }
  if (Object.keys(batch).length) sync.pushMany(batch).catch(() => {});
}

function onUser(u) {
  updateAccountUI();
  unwatchAll();
  remoteMap = {};
  if (!u) { renderLibrary(); return; }
  let first = true;
  unwatchAll = sync.watchAll((map) => {
    remoteMap = map;
    if (first) { first = false; uploadLocalProgress(); backfillCategories(); }
    if (!R.id) renderLibrary();
  });
}

/* ================= Khởi động ================= */
db.requestPersistence();
applyChrome();
renderLibrary();
updateAccountUI();
if (settings.startView === 'resume') lastBook.resume().catch(() => {});
sync.init(onUser).then(() => {
  const err = sync.takeLastError();
  if (err) toast(`Đăng nhập không thành công: ${err}`, null, null, 8000);
}).catch((e) => {
  console.error('Không khởi tạo được đồng bộ', e);
  toast('Không kết nối được dịch vụ đồng bộ — đang dùng chế độ ngoại tuyến');
}).finally(() => {
  // Vừa quay về từ trang chọn sách của Google → tải và mở các cuốn đã chọn
  const picked = sync.takePicked();
  if (picked) importPickedFiles(picked);
  mergeCloudStats();
  // Chủ thư viện: cập nhật danh mục công khai cho người khác (chạy ngầm)
  if (sync.currentUser()?.provider === 'gdrive') setTimeout(() => refreshCatalogAsOwner(), 8000);
});

// Biết sẵn giọng AI đã tải về máy chưa (để bấm 🔊 là dùng được ngay nếu chọn "giọng AI suốt")
if (bgAiOn()) aiVoiceStored(settings.bgVoice).then((ok) => { if (ok) aiStored[settings.bgVoice] = true; }).catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Lần đầu service worker mới nhận quản lý trang → tải lại 1 lần để bật chế độ cô lập (giọng AI đa luồng)
  // (Safari chưa hỗ trợ kiểu cô lập này → không tải lại; mỗi máy chỉ thử lại tối đa 1 lần/ngày)
  const tryIsolate = () => {
    if (window.crossOriginIsolated || !navigator.serviceWorker.controller || R.id || noIsolateNow) return;
    if (/iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|Edg/.test(navigator.userAgent)) return;
    const last = Number(lsGet('isoTried', 0)) || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    lsSet('isoTried', Date.now());
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', tryIsolate);
  setTimeout(tryIsolate, 1500);

  // Tự nhận bản mới: app trên điện thoại thường chỉ "ngủ" rồi thức dậy chứ không mở lại từ đầu,
  // nên mỗi lần app hiện lên lại thì hỏi máy chủ số bản mới nhất; có bản mới → tải lại app.
  let updChecking = false, updShown = false;
  const checkUpdate = async () => {
    if (updChecking || !navigator.onLine) return;
    updChecking = true;
    try {
      const txt = await (await fetch(`sw.js?u=${Date.now()}`, { cache: 'no-store' })).text();
      const latest = Number((txt.match(/epub-reader-v(\d+)/) || [])[1]) || 0;
      if (latest <= APP_BUILD) return;
      navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {});
      // Mỗi bản chỉ tự tải lại 1 lần (máy chủ có lúc mới cập nhật 1 nửa → tránh tải lại liên tục)
      if (!R.id && Number(lsGet('updTried', 0)) !== latest) { lsSet('updTried', latest); location.reload(); return; }
      if (!updShown) { // đang đọc → không làm gián đoạn, hỏi trước
        updShown = true;
        toast(`Có bản cập nhật mới (${latest})`, 'Cập nhật', () => location.reload(), 15000);
      }
    } catch { /* không có mạng: bỏ qua */ } finally { updChecking = false; }
  };
  setTimeout(checkUpdate, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
}
