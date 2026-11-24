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
const APP_VERSION = '2.22';
const APP_BUILD = 58; // phải trùng số trong CACHE của sw.js ('epub-reader-v58') — tăng mỗi lần phát hành
const $ = (id) => document.getElementById(id);
$('appVersion').textContent = `Tree Ebook · Phiên bản ${APP_VERSION} (bản cập nhật ${APP_BUILD}) · Tác giả: Trình Đỗ`;
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
  { fontSize: 100, lineHeight: 1.5, fontFamily: '', theme: 'light', flow: 'paginated', pageAnim: 'curl', ttsRate: 1.5, ttsVoice: '', ttsEngine: 'auto', gVoice: '', bgVoice: 'vi_VN-vais1000-medium', openVoice: 'device', startView: 'resume', spread: 'single' },
  lsGet('settings', {}),
);
const saveSettings = () => lsSet('settings', settings);
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
const cloudNav = { stack: lsGet(K_CLOUDNAV, null) || [] }; // [{ id, name }] — nhớ thư mục đang xem lần trước
// Danh sách thư mục đã xem: hiện ngay từ bộ nhớ, tải lại ngầm trên Drive rồi cập nhật
const K_CLOUDCACHE = 'cloudCache';
const cloudCache = new Map(Object.entries(lsGet(K_CLOUDCACHE, {}) || {}));
function cacheList(key, items) {
  cloudCache.delete(key);
  cloudCache.set(key, items);
  while (cloudCache.size > 60) cloudCache.delete(cloudCache.keys().next().value); // giữ 60 thư mục gần nhất
  lsSet(K_CLOUDCACHE, Object.fromEntries(cloudCache));
}
async function showCloudFolder() {
  cloudNav.searching = false;
  lsSet(K_CLOUDNAV, cloudNav.stack);
  const cur = cloudNav.stack[cloudNav.stack.length - 1];
  $('cloudTitle').textContent = cur ? cur.name : sync.currentUser().providerName;
  $('cloudPath').textContent = cloudNav.stack.length ? ['…', ...cloudNav.stack.map((s) => s.name)].slice(-3).join(' / ') : 'Thư mục gốc';
  $('cloudUp').querySelector('span').textContent = cloudNav.stack.length ? 'Quay lại' : 'Đóng'; // ở thư mục gốc: nút này đóng menu
  // Gốc Google Drive: thư viện chung đứng đầu để vào thẳng kho sách
  const lib = !cur && sync.currentUser().provider === 'gdrive' && cloudConfig.libraryFolderId
    ? [{ id: cloudConfig.libraryFolderId, name: cloudConfig.libraryName || 'Thư viện', isFolder: true, icon: '🌳', note: 'kho sách' }] : [];
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
      const size = it.isFolder ? esc(it.note || '') : have.has(it.id) ? 'Đã có' : `${(it.size / 1048576).toFixed(1)} MB`;
      const cat = it.cat ? `<small class="cloud-cat">${esc(it.cat)}</small>` : '';
      b.innerHTML = `<span class="ic">${it.icon || (it.isFolder ? '📁' : /\.pdf$/i.test(it.name) ? '📄' : '📖')}</span><span class="nm">${esc(it.name)}${cat}</span><span class="sz">${size}</span>`;
      b.onclick = it.isFolder
        ? () => { cloudNav.stack.push({ id: it.id, name: it.name }); $('cloudSearch').value = ''; showCloudFolder(); }
        : () => downloadAndOpen(it.id, it.name);
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
function openCloudBrowser(u) {
  if (lsGet(K_CLOUDNAV, null) == null && u.provider === 'gdrive' && cloudConfig.libraryFolderId) {
    cloudNav.stack = [{ id: cloudConfig.libraryFolderId, name: cloudConfig.libraryName || 'Thư viện' }];
  }
  $('cloudDialog').showModal();
  try { if (!history.state?.cloud) history.pushState({ ...(history.state || {}), cloud: 1 }, ''); } catch { /* bỏ qua */ }
  showCloudFolder();
}
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
    const libIds = cloudConfig.libraryFolderId ? [cloudConfig.libraryFolderId, ...LIBRARY_CATEGORIES.map(([id]) => id)] : [];
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
  $('cloudPath').textContent = sync.currentUser().providerName;
  $('cloudUp').querySelector('span').textContent = 'Quay lại';
  cloudNav.searching = true;
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

  // Chọn vị trí bắt đầu: bản mới nhất giữa máy này và đám mây
  let remote = null;
  if (sync.currentUser()) {
    remote = await Promise.race([sync.fetchOne(id).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]);
  }
  // line = đúng câu đang đọc (CFI của câu) → máy khác mở ra đúng trang chứa câu đó và đọc tiếp từ câu đó
  let start = local?.line || local?.cfi || null;
  R.line = local?.line || null;
  let fromOther = null;
  if (remote?.cfi && (remote.updatedAt || 0) > (local?.updatedAt || 0)) {
    start = remote.line || remote.cfi;
    R.line = remote.line || null;
    R.percent = remote.percent || R.percent;
    if (remote.deviceId !== deviceId) fromOther = remote.deviceName || 'thiết bị khác';
  }
  R.lastSavedAt = Math.max(local?.updatedAt || 0, remote?.updatedAt || 0);

  if (R.kind === 'pdf') { if (!(await openPdfReader(file.data, start))) return; }
  else await createRendition(start);
  if (fromOther) {
    toast(`Đã chuyển đến ${R.line ? 'đúng câu' : 'vị trí'} bạn đọc trên ${fromOther}`, null, null, 3500);
    if (R.line) flashLine(R.line);
  }
  updateSyncText();

  R.unwatch = sync.watchOne(id, onRemoteChange);
  if (R.kind === 'epub') loadLocations(id);
  // Nạp sẵn giọng AI lúc vừa mở sách (khi máy sẽ dùng nó) → lúc bấm 🔊 / khoá màn hình không phải nạp trùng lúc phát
  if (bgAiOn() && aiStored[settings.bgVoice] && (aiAlways() || /Android/i.test(navigator.userAgent))) {
    setTimeout(() => { if (R.id === id) aiWarmup(settings.bgVoice).catch(() => {}); }, 1500);
  }
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
  style.textContent = `
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
  // Dựng sẵn bản sao trang cho hiệu ứng "Lật giấy" (chương mới / vừa mở sách) khi máy rảnh
  if (settings.pageAnim === 'curl' && !document.hidden) {
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
  $('progressText').textContent = R.kind === 'pdf' && R.pdf
    ? `Trang ${R.pdf.page}/${R.pdf.pages} · ${pctText(R.percent)}`
    : pctText(R.percent);
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
        <div class="cp-page cp-front"><div class="cp-pages"></div><div class="cp-bars"></div></div>
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
  for (const host of layer.querySelectorAll('.cp-bars')) {
    host.replaceChildren();
    if (!show) continue;
    for (const bar of [$('readerTop'), $('readerBottom')]) {
      const cl = bar.cloneNode(true);
      cl.removeAttribute('id');
      cl.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
      const inp = cl.querySelector('input[type=range]');
      if (inp) inp.value = $('progressSlider').value;
      host.appendChild(cl);
    }
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
  const st = { layer, W, H, S, L, B, clip: q('.cp-clip'), front: q('.cp-front'), back: q('.cp-back'), shade: q('.cp-shade'), gloss: q('.cp-gloss') };
  Object.assign(st.clip.style, { width: `${S}px`, height: `${S}px` });
  for (const p of [st.front, st.back]) Object.assign(p.style, { width: `${W}px`, height: `${H}px` });
  for (const g of [st.shade, st.gloss]) Object.assign(g.style, { width: `${B}px`, height: `${L}px` });
  return st;
}
// Vẽ trạng thái lật ở tiến độ t (0 = phẳng, 1 = đã lật hết sang trái); lift: độ nhấc góc lên (theo tay kéo)
function curlRender(st, t, lift = 0) {
  const { W, H, S, L } = st;
  // Góc dưới-phải đi theo đường cong lên trên rồi sang trái (giống ngón tay lật trang)
  const Mx = W - 2 * W * t, My = H - H * (0.32 * Math.sin(Math.PI * Math.min(1, t * 1.05)) + lift);
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
  st.back.style.transform = mCss(mMul(inv, refl));
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
      const want = commit ? target : start;
      if (c.scrollLeft !== want) { R.rendition.manager.ignore = false; c.scrollLeft = want; }
      R.rendition?.reportLocation();
      // Chuẩn bị sẵn bản sao cho lần lật sau (chương mới / sau khi đổi cỡ chữ)
      setTimeout(() => { const q = pager(); if (settings.pageAnim === 'curl' && q) curlCloneFor(q.c.scrollLeft); }, 50);
    },
    cut() { curlAnimate.stop?.(); s.done(true); },
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
if (location.hostname === 'localhost') window.__curl = { begin: curlBegin };

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
  if (within && settings.pageAnim === 'curl' && !shift && fromScroll == null) {
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
  if (settings.pageAnim === 'curl') { // lật giấy: góc trang gấp theo ngón tay
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
$('btnSettings').onclick = () => { $('tocPanel').hidden = true; $('settingsPanel').hidden = !$('settingsPanel').hidden; fillVoices(); };
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $(b.dataset.close).hidden = true; }; });
$('fontUp').onclick = () => (R.kind === 'pdf' ? R.pdf?.zoomStep(1) : changeSetting({ fontSize: Math.min(200, settings.fontSize + 10) }));
$('fontDown').onclick = () => (R.kind === 'pdf' ? R.pdf?.zoomStep(-1) : changeSetting({ fontSize: Math.max(60, settings.fontSize - 10) }));
$('lhUp').onclick = () => changeSetting({ lineHeight: Math.min(2.4, +(settings.lineHeight + 0.1).toFixed(1)) });
$('lhDown').onclick = () => changeSetting({ lineHeight: Math.max(1.0, +(settings.lineHeight - 0.1).toFixed(1)) });
$('fontFamily').onchange = (e) => changeSetting({ fontFamily: e.target.value });
$('flowMode').onchange = (e) => changeSetting({ flow: e.target.value });
$('pageAnim').onchange = (e) => {
  settings.pageAnim = e.target.value; saveSettings(); // không cần dựng lại trang
  if (settings.pageAnim === 'curl' && pager()) curlCloneFor(pager().c.scrollLeft); // chuẩn bị sẵn hiệu ứng lật giấy
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
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
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
