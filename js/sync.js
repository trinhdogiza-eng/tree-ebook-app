// Đồng bộ tiến độ đọc qua OneDrive hoặc Google Drive (chọn một khi đăng nhập).
// Tiến độ của mọi cuốn nằm trong 1 tệp progress.json trong thư mục riêng của app:
//   OneDrive:      Ứng dụng/<tên app>/progress.json   (special folder "approot")
//   Google Drive:  thư mục ẩn appDataFolder (không hiện trong Drive)
// Nội dung: { version: 1, books: { <bookId>: { title, author, cfi, percent, chapter, updatedAt, deviceId, deviceName, source } } }
// Đăng nhập dùng OAuth chuyển trang (redirect) — chạy được cả trong app đã "Thêm vào MH chính" trên iOS.
import { cloudConfig } from './cloud-config.js';

const FILE = 'progress.json';
const K_SESSION = 'cloudSession';
const K_PENDING = 'cloudPending';
const K_AUTH = 'cloudAuthReq';
const K_BOUNCE = 'cloudBounceAt';
const POLL_MS = 30000;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GDRIVE = 'https://www.googleapis.com/drive/v3';
const GUPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const PROVIDERS = {
  onedrive: {
    name: 'OneDrive',
    clientId: () => cloudConfig.onedriveClientId,
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile offline_access User.Read Files.Read Files.ReadWrite.AppFolder',
  },
  gdrive: {
    name: 'Google Drive',
    clientId: () => cloudConfig.googleClientId,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    // drive.appdata: lưu tiến độ đọc trong thư mục ẩn của app; drive.file: chỉ những tệp người dùng tự chọn
    // qua Google Picker. Cả hai đều là quyền "không nhạy cảm" → app công khai được cho mọi tài khoản Google.
    scope: 'openid email https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file',
  },
};

/* ---------- tiện ích ---------- */
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } };
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

function rand(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pkceChallenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

class NeedAuth extends Error { constructor() { super('Phiên đăng nhập đã hết hạn'); this.code = 'need-auth'; } }

/* ---------- trạng thái ---------- */
let session = lsGet(K_SESSION);      // { provider, email, accessToken, expiresAt, refreshToken }
let needsReconnect = false;
let lastError = '';
let onUserChange = () => {};
let cache = null;                    // { version, books }
let gFileId = null;                  // id tệp progress.json trên Google Drive
let pollTimer = null;
const watchers = new Set();          // { id?: string, cb }

const saveSession = () => (session ? lsSet(K_SESSION, session) : lsDel(K_SESSION));

export const providers = () =>
  Object.entries(PROVIDERS).filter(([, p]) => p.clientId()).map(([id, p]) => ({ id, name: p.name }));
export const isConfigured = () => providers().length > 0;
export const providerName = (id) => PROVIDERS[id]?.name || id;
export const takeLastError = () => { const e = lastError; lastError = ''; return e; };

export function currentUser() {
  if (!session) return null;
  return { email: session.email, provider: session.provider, providerName: PROVIDERS[session.provider].name, needsReconnect };
}
const ready = () => !!session && !needsReconnect;
const announce = () => onUserChange(currentUser());

/* ---------- đăng nhập ---------- */
async function startAuth(provider, silent, consent = false) {
  const p = PROVIDERS[provider];
  const state = rand(16);
  const req = { provider, state, silent: !!silent, email: session?.provider === provider ? session.email : null };
  const params = new URLSearchParams({ client_id: p.clientId(), redirect_uri: redirectUri(), scope: p.scope, state });
  if (provider === 'onedrive') {
    req.verifier = rand(48);
    params.set('response_type', 'code');
    params.set('response_mode', 'query');
    params.set('code_challenge', await pkceChallenge(req.verifier));
    params.set('code_challenge_method', 'S256');
  } else {
    params.set('response_type', 'token');
    params.set('include_granted_scopes', 'true');
  }
  if (req.email) params.set('login_hint', req.email);
  if (silent) { params.set('prompt', 'none'); lsSet(K_BOUNCE, Date.now()); }
  else if (consent) params.set('prompt', 'consent'); // hỏi lại từng quyền (người dùng từng bỏ tick ô Google Drive)
  else if (!req.email) params.set('prompt', 'select_account');
  lsSet(K_AUTH, req);
  location.assign(`${p.authorize}?${params}`);
  return new Promise(() => {}); // trang đang chuyển đi
}

async function msToken(params) {
  const p = PROVIDERS.onedrive;
  const body = new URLSearchParams({ client_id: p.clientId(), scope: p.scope, ...params });
  const r = await fetch(p.token, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
  const out = { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in - 120) * 1000 };
  if (j.refresh_token) out.refreshToken = j.refresh_token;
  return out;
}

// Xử lý khi Microsoft/Google chuyển về app sau khi đăng nhập
/* ---------- Chọn sách bằng trang Google toàn màn hình ("onepick") ----------
   Safari (iPhone, iPad, Mac) chặn cookie của Google trong khung Picker nhúng → báo "Không thể truy cập vào
   Tài khoản Google". Cách này mở trang chọn tệp của chính Google (drive.google.com), chọn xong Google chuyển
   về app kèm picked_file_ids và 1 mã truy cập chỉ có quyền drive.file cho các tệp đó. */
const K_ONEPICK = 'cloudOnePick';      // yêu cầu đang chờ { state, at }
const K_PICKED = 'cloudPicked';        // kết quả chờ app xử lý { ids, token, expiresAt }
// folderId: mở thẳng thư mục đó (vd. thư viện "Ebook sách"); người dùng bấm vào để xem các thư mục con.
// prompt=consent là bắt buộc để Google hiện trang chọn tệp (bỏ đi thì Google chuyển thẳng về app).
export function startOnePick({ folderId = '' } = {}) {
  const p = PROVIDERS.gdrive;
  const state = rand(16);
  lsSet(K_ONEPICK, { state, at: Date.now() });
  const params = new URLSearchParams({
    client_id: p.clientId(), redirect_uri: redirectUri(), response_type: 'token',
    scope: 'https://www.googleapis.com/auth/drive.file', prompt: 'consent',
    trigger_onepick: 'true', allow_multiple: 'true', state,
  });
  if (folderId) params.set('file_ids', folderId);
  // Chỉ hiện sách + thư mục (không lẫn Excel, video, ảnh…) — đã thử 24/11/2026: Google nhận tham số "mimetypes"
  params.set('mimetypes', ['application/epub+zip', 'application/pdf', 'application/x-mobipocket-ebook', 'application/vnd.amazon.ebook',
    'application/vnd.amazon.mobi8-ebook', 'application/octet-stream', 'application/vnd.google-apps.folder'].join(','));
  if (session?.provider === 'gdrive' && session.email) params.set('login_hint', session.email);
  location.assign(`${p.authorize}?${params}`);
  return new Promise(() => {}); // trang đang chuyển đi
}
// Lấy (một lần) các tệp vừa chọn ở trang Google → { ids: [...], token } hoặc null
export function takePicked() {
  const r = lsGet(K_PICKED);
  lsDel(K_PICKED);
  if (!r || Date.now() > r.expiresAt) return null;
  return r;
}
function handleOnePick(q, h, state) {
  const req = lsGet(K_ONEPICK);
  if (!req || req.state !== state) return false;
  lsDel(K_ONEPICK);
  history.replaceState(null, '', redirectUri());
  const ids = (h.get('picked_file_ids') || q.get('picked_file_ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const token = h.get('access_token');
  if (ids.length && token) {
    lsSet(K_PICKED, { ids, token, expiresAt: Date.now() + (Number(h.get('expires_in') || 3600) - 120) * 1000 });
  }
  return true;
}
// Tải 1 tệp đã chọn ở trang Google (dùng mã truy cập Google trả kèm) → { name, mimeType, buf }
export async function downloadPicked(fileId, token) {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const metaRes = await fetch(`${GDRIVE}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`, auth);
  if (!metaRes.ok) throw new Error(`Không đọc được thông tin tệp (HTTP ${metaRes.status})`);
  const meta = await metaRes.json();
  const r = await fetch(`${GDRIVE}/files/${encodeURIComponent(fileId)}?alt=media`, auth);
  if (!r.ok) throw new Error(`Không tải được tệp (HTTP ${r.status})`);
  return { name: meta.name || 'sach', mimeType: meta.mimeType || '', buf: await r.arrayBuffer() };
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const state = q.get('state') || h.get('state');
  if (!state) return;
  if (handleOnePick(q, h, state)) return; // quay về từ trang chọn sách: giữ nguyên phiên đăng nhập
  const req = lsGet(K_AUTH);
  lsDel(K_AUTH);
  history.replaceState(null, '', redirectUri());
  if (!req || req.state !== state) return;

  const err = q.get('error') || h.get('error');
  if (err) {
    if (req.silent) needsReconnect = true;
    else lastError = q.get('error_description') || h.get('error_description') || err;
    return;
  }
  try {
    let s;
    if (req.provider === 'onedrive') {
      s = await msToken({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: req.verifier });
    } else {
      s = { accessToken: h.get('access_token'), scope: h.get('scope') || null, expiresAt: Date.now() + (Number(h.get('expires_in') || 3600) - 120) * 1000 };
    }
    if (session && session.provider !== req.provider) gFileId = null;
    session = { provider: req.provider, email: req.email, ...s };
    session.email = await fetchEmail().catch(() => req.email || '');
    saveSession();
    needsReconnect = false;
  } catch (e) {
    lastError = e.message || String(e);
  }
}

async function fetchEmail() {
  if (session.provider === 'onedrive') {
    const me = await (await api(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`)).json();
    return me.mail || me.userPrincipalName || me.displayName || '';
  }
  const me = await (await api('https://www.googleapis.com/oauth2/v3/userinfo')).json();
  return me.email || '';
}

// Token đăng nhập hiện tại (dùng cho Google Picker)
export const accessToken = () => getToken();

// Tài khoản còn quyền đọc cả Drive từ bản cũ (drive.readonly, nhờ include_granted_scopes) →
// duyệt thư mục ngay trong app, không phải qua trang chọn tệp của Google.
const FULL_DRIVE = /auth\/drive(\.readonly)?(\s|$)/;
async function grantedScope() {
  if (session?.provider !== 'gdrive') return null;
  if (session.scope == null) {
    try {
      const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(await getToken())}`);
      if (!r.ok) return null;
      session.scope = (await r.json()).scope || '';
      saveSession();
    } catch { return null; }
  }
  return session.scope;
}
export async function hasFullDrive() {
  const s = await grantedScope();
  return s != null && FULL_DRIVE.test(s);
}
// Trang xác nhận của Google cho bỏ tick từng quyền: thiếu quyền Drive thì khung chọn sách báo 403
export async function lacksDrive() {
  const s = await grantedScope();
  return s != null && !/auth\/drive(\.file|\.readonly)?(\s|$)/.test(s);
}

async function getToken() {
  if (!session) throw new NeedAuth();
  if (session.accessToken && Date.now() < session.expiresAt) return session.accessToken;
  if (session.provider === 'onedrive' && session.refreshToken) {
    try {
      Object.assign(session, await msToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken }));
      saveSession();
      return session.accessToken;
    } catch { /* refresh token hết hạn → cần đăng nhập lại */ }
  }
  if (!needsReconnect) { needsReconnect = true; announce(); }
  throw new NeedAuth();
}

async function api(url, opts = {}, retry = true) {
  const token = await getToken();
  const r = await fetch(url, { cache: 'no-store', ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (r.status === 401 && retry) { session.expiresAt = 0; return api(url, opts, false); }
  return r;
}
async function apiOk(url, opts) {
  const r = await api(url, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || j.error_description || msg; } catch { /* bỏ qua */ }
    // Google Drive (quyền drive.file): tệp chưa được chọn qua Google Picker trên tài khoản này → 404
    if (session?.provider === 'gdrive' && (r.status === 404 || r.status === 403) && /\/files\//.test(url)) {
      msg = 'App chưa được quyền đọc tệp này — bấm Google Drive → Chọn sách và chọn lại đúng cuốn đó';
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r;
}

// Khởi động: xử lý redirect, làm mới phiên nếu cần (tự chuyển trang "im lặng" tối đa 1 lần / 5 phút)
export async function init(cb) {
  onUserChange = cb;
  if (!isConfigured()) { announce(); return false; }
  await handleRedirect();
  if (session && !PROVIDERS[session.provider]?.clientId()) { session = null; saveSession(); }
  if (session) {
    try { await getToken(); } catch {
      if (canBounce()) return startAuth(session.provider, true);
    }
  }
  announce();
  if (ready()) { flush().catch(() => {}); }
  startPolling();
  return true;
}
const canBounce = () => Date.now() - (lsGet(K_BOUNCE) || 0) > 5 * 60 * 1000;

export const signIn = (provider) => startAuth(provider, false);
export const reconnect = () => session && startAuth(session.provider, false);
export const grantDrive = () => startAuth('gdrive', false, true);
export function signOut() {
  session = null; cache = null; gFileId = null; needsReconnect = false;
  saveSession(); lsDel(K_PENDING);
  announce();
}

// Gọi khi app quay lại màn hình: kéo dữ liệu mới; nếu phiên hết hạn và đang ở thư viện thì tự làm mới
export async function resume(allowRedirect) {
  if (!session) return;
  try { await getToken(); needsReconnect = false; } catch {
    if (allowRedirect && canBounce()) { startAuth(session.provider, true); return; }
  }
  if (ready()) { await flush().catch(() => {}); await pull(); }
}

/* ---------- đọc / ghi progress.json ---------- */
async function readRemote() {
  if (session.provider === 'onedrive') {
    const r = await api(`${GRAPH}/me/drive/special/approot:/${FILE}:/content`);
    if (r.status === 404) return { version: 1, books: {} };
    if (!r.ok) throw new Error(`OneDrive HTTP ${r.status}`);
    return normalize(await r.json().catch(() => null));
  }
  if (!gFileId) {
    const q = encodeURIComponent(`name='${FILE}' and trashed=false`);
    const list = await (await apiOk(`${GDRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`)).json();
    gFileId = list.files?.[0]?.id || null;
    if (!gFileId) return { version: 1, books: {} };
  }
  const r = await api(`${GDRIVE}/files/${gFileId}?alt=media`);
  if (r.status === 404) { gFileId = null; return { version: 1, books: {} }; }
  if (!r.ok) throw new Error(`Google Drive HTTP ${r.status}`);
  return normalize(await r.json().catch(() => null));
}
const normalize = (d) => (d && typeof d.books === 'object' ? d : { version: 1, books: {} });

async function writeRemote(data) {
  const body = JSON.stringify(data);
  if (session.provider === 'onedrive') {
    await apiOk(`${GRAPH}/me/drive/special/approot:/${FILE}:/content`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    });
    return;
  }
  if (gFileId) {
    await apiOk(`${GUPLOAD}/files/${gFileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return;
  }
  const boundary = `b${rand(12)}`;
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + `${JSON.stringify({ name: FILE, parents: ['appDataFolder'] })}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await apiOk(`${GUPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  gFileId = (await r.json()).id;
}

// Gộp theo từng cuốn: bản có updatedAt mới hơn thắng; trường thiếu được bổ sung từ bản kia
function merge(old, inc) {
  if (!old) return { ...inc };
  if (!inc) return { ...old };
  return (inc.updatedAt || 0) >= (old.updatedAt || 0) ? { ...old, ...inc } : { ...inc, ...old };
}

async function pull() {
  if (!ready()) return cache;
  try {
    const remote = await readRemote();
    const pending = lsGet(K_PENDING) || {};
    for (const [id, d] of Object.entries(pending)) remote.books[id] = merge(remote.books[id], d);
    cache = remote;
    emit();
  } catch (e) {
    if (e.code !== 'need-auth') console.warn('Không đọc được tiến độ từ đám mây', e);
  }
  return cache;
}

let flushing = null;
async function flush() {
  if (!ready()) return;
  while (flushing) await flushing.catch(() => {});
  const pending = lsGet(K_PENDING) || {};
  if (!Object.keys(pending).length) return;
  flushing = (async () => {
    const remote = await readRemote();
    for (const [id, d] of Object.entries(pending)) remote.books[id] = merge(remote.books[id], d);
    await writeRemote(remote);
    // Chỉ xoá những mục chưa bị thay đổi thêm trong lúc đang gửi
    const now = lsGet(K_PENDING) || {};
    for (const [id, d] of Object.entries(pending)) if (JSON.stringify(now[id]) === JSON.stringify(d)) delete now[id];
    lsSet(K_PENDING, now);
    for (const [id, d] of Object.entries(now)) remote.books[id] = merge(remote.books[id], d);
    cache = remote;
    emit();
  })();
  try { await flushing; } finally { flushing = null; }
}

/* ---------- API dùng trong app ---------- */
export async function push(id, data) {
  if (!session) return;
  const pending = lsGet(K_PENDING) || {};
  pending[id] = merge(pending[id], data);
  lsSet(K_PENDING, pending);   // lưu ngay → không mất khi đóng app / mất mạng
  if (cache) cache.books[id] = merge(cache.books[id], data);
  if (!ready()) throw new NeedAuth();
  await flush();
}

// Gửi nhiều cuốn trong một lần ghi (dùng khi vừa đăng nhập trên máy có sẵn tiến độ)
export async function pushMany(map) {
  if (!session) return;
  const pending = lsGet(K_PENDING) || {};
  for (const [id, d] of Object.entries(map)) pending[id] = merge(pending[id], d);
  lsSet(K_PENDING, pending);
  if (!ready()) throw new NeedAuth();
  await flush();
}

// Tuỳ chọn dùng chung mọi thiết bị (vd. khoá giọng Google), lưu trong progress.json → "prefs"
export const getPref = (name) => cache?.prefs?.[name];
export async function setPref(name, value) {
  if (!ready()) throw new NeedAuth();
  await flush().catch(() => {});
  const remote = await readRemote();
  remote.prefs = { ...(remote.prefs || {}), [name]: value };
  const pending = lsGet(K_PENDING) || {};
  for (const [id, d] of Object.entries(pending)) remote.books[id] = merge(remote.books[id], d);
  await writeRemote(remote);
  cache = remote;
  emit();
}

export async function fetchOne(id) {
  if (!ready()) return null;
  const c = await pull();
  return c?.books[id] || null;
}

export function watchOne(id, cb) {
  const w = { id, cb };
  watchers.add(w);
  return () => watchers.delete(w);
}
export function watchAll(cb) {
  const w = { cb };
  watchers.add(w);
  if (cache) cb(cache.books); else pull();
  return () => watchers.delete(w);
}
function emit() {
  if (!cache) return;
  for (const w of watchers) {
    if (w.id) { if (cache.books[w.id]) w.cb(cache.books[w.id]); } else w.cb(cache.books);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && ready() && watchers.size) { flush().catch(() => {}); pull(); }
  }, POLL_MS);
  window.addEventListener('online', () => { if (ready()) flush().catch(() => {}); });
}

/* ---------- duyệt & tải sách từ đám mây ---------- */
// Sách đọc được: EPUB, PDF và sách Kindle (MOBI, AZW3, AZW, PRC — được chuyển sang EPUB khi mở)
const BOOK_MIMES = ['application/epub+zip', 'application/pdf', 'application/x-mobipocket-ebook', 'application/vnd.amazon.ebook'];
const isBook = (name, mime) => /\.(epub|pdf|mobi|azw3|azw|prc)$/i.test(name || '') || BOOK_MIMES.includes(mime);
const G_EPUB = "(mimeType='application/epub+zip' or name contains '.epub')";
const G_PDF = "(mimeType='application/pdf' or name contains '.pdf')";
const G_KINDLE = "(name contains '.mobi' or name contains '.azw3' or name contains '.azw' or name contains '.prc' or mimeType='application/x-mobipocket-ebook')";
const G_BOOK_OR_FOLDER = `(mimeType='application/vnd.google-apps.folder' or ${G_EPUB} or ${G_PDF} or ${G_KINDLE})`;

// Trả về [{ id, name, isFolder, size }]
// Thư mục ảo ở cấp gốc: "Tất cả sách EPUB", "Tất cả PDF" và (Google Drive) "Được chia sẻ với tôi"
export const ALL_EPUBS = '__all';
export const ALL_PDFS = '__allpdf';
export const ALL_KINDLE = '__allkindle';
export const SHARED = '__shared';
export const BY_CATEGORY = '__bycat';

export async function listFolder(folderId) {
  if (folderId === BY_CATEGORY) return categoryFolders();
  if (folderId === ALL_EPUBS) return withCategories(await allOfKind('epub'));
  if (folderId === ALL_PDFS) return withCategories(await allOfKind('pdf'));
  if (folderId === ALL_KINDLE) return withCategories(await allOfKind('kindle'));
  if (!folderId) {
    const virtual = [
      ...(session.provider === 'gdrive' ? [{ id: BY_CATEGORY, name: 'Theo thể loại', isFolder: true, icon: '🏷️', note: 'thư mục có sách' }] : []),
      { id: ALL_EPUBS, name: 'Tất cả sách EPUB', isFolder: true, icon: '📚' },
      { id: ALL_PDFS, name: 'Tất cả PDF', isFolder: true, icon: '📄' },
      { id: ALL_KINDLE, name: 'Tất cả sách Kindle (MOBI, AZW3, PRC)', isFolder: true, icon: '📙' },
    ];
    if (session.provider === 'gdrive') virtual.push({ id: SHARED, name: 'Được chia sẻ với tôi', isFolder: true, icon: '👥' });
    return [...virtual, ...(await listFolderReal(null))];
  }
  if (folderId === SHARED) return gCollect(`sharedWithMe and trashed=false and ${G_BOOK_OR_FOLDER}`);
  return listFolderReal(folderId);
}

async function allOfKind(kind) {
  if (session.provider === 'onedrive' && kind === 'kindle') {
    const exts = ['.mobi', '.azw3', '.azw', '.prc'];
    const seen = new Set();
    const lists = await Promise.all(exts.map((e) => msCollect(`${GRAPH}/me/drive/root/search(q='${e}')?$select=id,name,size,folder,file&$top=200`)));
    return sortItems(lists.flat().filter((i) => !i.isFolder && exts.some((e) => i.name.toLowerCase().endsWith(e)) && !seen.has(i.id) && seen.add(i.id)));
  }
  if (kind === 'kindle') return gCollect(`trashed=false and ${G_KINDLE}`);
  if (session.provider === 'onedrive') {
    const ext = kind === 'pdf' ? '.pdf' : '.epub';
    return (await msCollect(`${GRAPH}/me/drive/root/search(q='${ext}')?$select=id,name,size,folder,file&$top=200`))
      .filter((i) => !i.isFolder && i.name.toLowerCase().endsWith(ext));
  }
  return gCollect(`trashed=false and ${kind === 'pdf' ? G_PDF : G_EPUB}`);
}

async function listFolderReal(folderId) {
  if (session.provider === 'onedrive') {
    let url = folderId ? `${GRAPH}/me/drive/items/${folderId}/children` : `${GRAPH}/me/drive/root/children`;
    url += '?$select=id,name,size,folder,file&$top=200';
    return msCollect(url);
  }
  return gCollect(`'${folderId || 'root'}' in parents and trashed=false and ${G_BOOK_OR_FOLDER}`);
}

export async function search(text) {
  if (session.provider === 'onedrive') {
    const t = text.replace(/'/g, "''");
    return (await msCollect(`${GRAPH}/me/drive/root/search(q='${encodeURIComponent(t)}')?$select=id,name,size,folder,file&$top=200`))
      .filter((i) => !i.isFolder);
  }
  const t = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return withCategories(await gCollect(`trashed=false and (${G_EPUB} or ${G_PDF} or ${G_KINDLE}) and name contains '${t}'`));
}

async function msCollect(url) {
  const out = [];
  for (let page = 0; url && page < 10; page++) {
    const j = await (await apiOk(url)).json();
    for (const it of j.value || []) {
      if (it.folder) out.push({ id: it.id, name: it.name, isFolder: true });
      else if (isBook(it.name, it.file?.mimeType)) out.push({ id: it.id, name: it.name, size: it.size });
    }
    url = j['@odata.nextLink'];
  }
  return sortItems(out);
}

async function gCollect(q) {
  const out = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ q, fields: 'files(id,name,mimeType,size,parents),nextPageToken', pageSize: '200', orderBy: 'folder,name' });
    if (token) params.set('pageToken', token);
    const j = await (await apiOk(`${GDRIVE}/files?${params}`)).json();
    for (const f of j.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') out.push({ id: f.id, name: f.name, isFolder: true });
      else if (isBook(f.name, f.mimeType)) out.push({ id: f.id, name: f.name, size: Number(f.size) || 0, parent: f.parents?.[0] });
    }
    token = j.nextPageToken;
    if (!token) break;
  }
  return sortItems(out);
}

/* ----- Thể loại trên Google Drive = thư mục chứa sách ----- */
// Danh sách mọi thư mục trên Drive (mã → { name, parent }), giữ 5 phút để không hỏi lại liên tục
let folderCache = null;
async function driveFolders() {
  if (folderCache && Date.now() - folderCache.at < 5 * 60 * 1000) return folderCache.map;
  const map = new Map();
  let token = '';
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ q: "mimeType='application/vnd.google-apps.folder' and trashed=false", fields: 'files(id,name,parents),nextPageToken', pageSize: '1000' });
    if (token) params.set('pageToken', token);
    const j = await (await apiOk(`${GDRIVE}/files?${params}`)).json();
    for (const f of j.files || []) map.set(f.id, { name: f.name, parent: f.parents?.[0] });
    token = j.nextPageToken;
    if (!token) break;
  }
  folderCache = { at: Date.now(), map };
  for (const [id, f] of map) folderNames.set(id, f.name);
  return map;
}
// Thể loại của thư mục chứa sách: nếu thư mục nằm (ở tầng nào cũng được) trong 1 thư mục "Ebook sách"
// → thể loại = thư mục ngay dưới "Ebook sách" (thư viện Calibre: Ebook sách/Thể loại/Tác giả/Tên sách/sách.epub);
// không thì = chính thư mục chứa. → { id, name, main }
function shelfCat(folders, pid) {
  for (let id = pid, depth = 0; id && folders.has(id) && depth < 12; depth++) {
    const f = folders.get(id);
    if (isShelf(folders.get(f.parent)?.name)) return { id, name: f.name, main: true };
    id = f.parent;
  }
  return folders.has(pid) ? { id: pid, name: folders.get(pid).name, main: false } : null;
}
// Gắn nhãn thể loại (tên thư mục chứa) cho các sách trong danh sách
async function withCategories(items) {
  if (session.provider !== 'gdrive' || !items.some((i) => i.parent)) return items;
  try {
    const folders = await driveFolders();
    for (const it of items) { const c = it.parent && shelfCat(folders, it.parent); if (c) it.cat = c.name; }
  } catch { /* không có nhãn cũng không sao */ }
  return items;
}
// Mục "Theo thể loại": mọi thể loại có chứa sách, kèm số cuốn → bấm vào là xem sách trong thư mục đó
async function categoryFolders() {
  const [books, folders] = await Promise.all([gCollect(`trashed=false and (${G_EPUB} or ${G_PDF} or ${G_KINDLE})`), driveFolders()]);
  const cats = new Map();
  for (const b of books) {
    const c = b.parent && shelfCat(folders, b.parent);
    if (!c) continue;
    const o = cats.get(c.id) || { ...c, n: 0 };
    o.n++; cats.set(c.id, o);
  }
  // Thể loại nằm trong thư mục "Ebook sách" xếp trước, thư mục ở chỗ khác trên Drive xếp cuối
  return [...cats.values()].map(({ id, name, main, n }) => ({
    id, name, isFolder: true, icon: main ? '🏷️' : '📁', note: main ? `${n} cuốn` : `${n} cuốn · ngoài Ebook sách`, main,
  })).sort((a, b) => (b.main - a.main) || a.name.localeCompare(b.name, 'vi', { numeric: true }));
}
// Thư mục kho sách chính
export const SHELF_NAME = 'Ebook sách';
const isShelf = (name) => !!name && name.normalize('NFC').trim().toLowerCase() === SHELF_NAME.normalize('NFC').toLowerCase();
// Thể loại của 1 cuốn + có nằm trong "Ebook sách" không → { name, main }
export async function fileCategoryInfo(fileId) {
  const name = await fileCategory(fileId);
  if (!name) return { name: '', main: false };
  try {
    const f = await (await apiOk(`${GDRIVE}/files/${encodeURIComponent(fileId)}?fields=parents`)).json();
    const folders = await driveFolders();
    const c = shelfCat(folders, f.parents?.[0]);
    return c ? { name: c.name, main: c.main } : { name, main: false };
  } catch { return { name, main: false }; }
}

const sortItems = (items) => items.sort((a, b) =>
  (b.isFolder ? 1 : 0) - (a.isFolder ? 1 : 0) || a.name.localeCompare(b.name, 'vi', { numeric: true }));

// Thể loại của 1 cuốn trên Google Drive = tên thư mục chứa nó (vd. "Ebook sách/Tiên hiệp/abc.epub" → "Tiên hiệp").
// Nằm thẳng ở thư mục gốc "Drive của tôi" → không có thể loại.
const folderNames = new Map(); // mã thư mục → tên (đỡ hỏi lại)
export async function fileCategory(fileId) {
  if (!ready() || session.provider !== 'gdrive' || !fileId) return '';
  const f = await (await apiOk(`${GDRIVE}/files/${encodeURIComponent(fileId)}?fields=parents`)).json();
  const pid = f.parents?.[0];
  if (!pid) return '';
  if (!folderNames.has(pid)) {
    const p = await (await apiOk(`${GDRIVE}/files/${encodeURIComponent(pid)}?fields=name,parents`)).json();
    folderNames.set(pid, p.parents?.length ? (p.name || '') : ''); // thư mục gốc không có "parents"
  }
  return folderNames.get(pid);
}

export async function download(fileId) {
  const url = session.provider === 'onedrive'
    ? `${GRAPH}/me/drive/items/${fileId}/content`
    : `${GDRIVE}/files/${fileId}?alt=media`;
  return (await apiOk(url)).arrayBuffer();
}

/* ---------- Danh mục thư viện công khai (thư mục "Ebook sách" để "Ai có link đều xem được") ----------
 * Chủ thư viện (còn quyền đọc cả Drive) lập danh mục: mọi thư mục + sách trong thư viện, lưu thành 1 tệp JSON
 * trong chính thư mục thư viện. Người khác đọc danh mục và tải sách bằng API key, không cần trang chọn tệp của Google.
 * Định dạng: { v: 1, at, root, f: [[id, tên, chỉ số thư mục cha (-1 = gốc)]], b: [[id, tên, cỡ, chỉ số thư mục, resourceKey?]] }
 */
export const CATALOG_NAME = 'tree-ebook-danh-muc.json';
async function gList(q, fields) {
  const out = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ q, fields: `files(${fields}),nextPageToken`, pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (token) params.set('pageToken', token);
    const j = await (await apiOk(`${GDRIVE}/files?${params}`)).json();
    out.push(...(j.files || []));
    token = j.nextPageToken;
    if (!token) break;
  }
  return out;
}
// extras: [{ id, name }] — kho sách thêm, mỗi kho thành 1 thư mục cấp đầu, đánh dấu f[3] = 1 (gốc của 1 kho)
export async function buildCatalog(rootId, extras = []) {
  const folders = [];               // [id, name, parentIdx, (1 = gốc kho thêm)]
  const index = new Map([[rootId, -1]]);
  const books = [];
  for (const x of extras) {
    if (!x?.id || index.has(x.id)) continue;
    index.set(x.id, folders.length);
    folders.push([x.id, x.name || 'Kho sách', -1, 1]);
  }
  let level = [rootId, ...folders.map((f) => f[0])];
  while (level.length) {
    const next = [];
    for (let i = 0; i < level.length; i += 40) {
      const ids = level.slice(i, i + 40);
      const q = `(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed=false`;
      for (const f of await gList(q, 'id,name,mimeType,size,parents,resourceKey')) {
        const parent = index.get((f.parents || []).find((p) => index.has(p)));
        if (parent === undefined) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (index.has(f.id)) continue;
          index.set(f.id, folders.length);
          folders.push([f.id, f.name, parent]);
          next.push(f.id);
        } else if (isBook(f.name, f.mimeType) && f.name !== CATALOG_NAME) {
          books.push(f.resourceKey ? [f.id, f.name, Number(f.size) || 0, parent, f.resourceKey] : [f.id, f.name, Number(f.size) || 0, parent]);
        }
      }
    }
    level = next;
  }
  return tidyCatalog({ v: 1, at: Date.now(), root: rootId, f: folders, b: books });
}
// Gọn danh mục:
//  1) Cùng 1 cuốn có nhiều định dạng trong cùng thư mục (thư viện Calibre: .epub + .mobi + .azw3) → giữ 1, ưu tiên EPUB.
//  2) Thư mục chỉ chứa đúng 1 mục (Calibre: Tác giả/Tên sách (123)/sách) → đưa mục đó lên thư mục cha, bỏ thư mục.
//     Không đụng tới thư mục cấp đầu (thể loại) và gốc các kho. Thư mục rỗng cũng bỏ.
const FMT_RANK = { epub: 0, azw3: 1, kf8: 1, mobi: 2, azw: 3, prc: 4, pdf: 5 };
function tidyCatalog(c) {
  const ext = (n) => (n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const base = (n) => n.replace(/\.[a-z0-9]+$/i, '').normalize('NFC').trim().toLowerCase();
  const best = new Map();
  for (const b of c.b) {
    const k = `${b[3]}|${base(b[1])}`;
    const o = best.get(k);
    if (!o || (FMT_RANK[ext(b[1])] ?? 9) < (FMT_RANK[ext(o[1])] ?? 9)) best.set(k, b);
  }
  const books = [...best.values()];
  const f = c.f.map((x) => [...x]);
  const keep = f.map(() => true);
  const kids = f.map(() => []);               // thư mục con còn giữ
  const items = f.map(() => []);              // sách trực tiếp
  f.forEach((x, i) => { if (x[2] >= 0) kids[x[2]].push(i); });
  books.forEach((b) => { if (b[3] >= 0) items[b[3]].push(b); });
  // Từ dưới lên (thư mục con luôn đứng sau thư mục cha trong danh sách)
  for (let i = f.length - 1; i >= 0; i--) {
    const p = f[i][2];
    if (p === -1 || f[i][3] === 1 || f[p][3] === 1) continue; // thể loại cấp đầu / gốc kho / thể loại trong kho: giữ
    const k = kids[i].filter((j) => keep[j]);
    const n = k.length + items[i].length;
    if (n > 1) continue;
    keep[i] = false;
    kids[p] = kids[p].filter((j) => j !== i);
    for (const j of k) { f[j][2] = p; kids[p].push(j); }
    for (const b of items[i]) { b[3] = p; items[p].push(b); }
    items[i] = [];
  }
  // Đánh lại chỉ số
  const map = new Map();
  const outF = [];
  f.forEach((x, i) => { if (keep[i]) { map.set(i, outF.length); outF.push(x); } });
  for (const x of outF) x[2] = x[2] === -1 ? -1 : map.get(x[2]);
  for (const b of books) b[3] = b[3] === -1 ? -1 : map.get(b[3]);
  return { ...c, f: outF.map((x) => (x[3] === 1 ? x : x.slice(0, 3))), b: books };
}
// Lưu danh mục vào thư mục thư viện (tạo mới lần đầu, sau đó ghi đè cùng tệp) → trả về mã tệp
export async function saveCatalog(catalog, rootId) {
  const body = JSON.stringify(catalog);
  const existing = (await gList(`'${rootId}' in parents and name='${CATALOG_NAME}' and trashed=false`, 'id'))[0];
  if (existing) {
    await apiOk(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return existing.id;
  }
  const boundary = `tree${rand(8)}`;
  const meta = JSON.stringify({ name: CATALOG_NAME, parents: [rootId], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await apiOk('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  return (await r.json()).id;
}
// Người dùng khác: đọc tệp công khai bằng API key (không cần đăng nhập)
async function publicFetch(fileId, apiKey, resourceKey) {
  const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` } : {};
  const r = await fetch(`${GDRIVE}/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`, { headers });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* bỏ qua */ }
    if (r.status === 403 && /quota|limit|rate/i.test(msg)) msg = 'Sách này đang bị Google giới hạn lượt tải — thử lại sau ít giờ';
    else if (r.status === 404 || r.status === 403) msg = 'Thư viện chưa mở công khai hoặc tệp đã bị xoá';
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r;
}
export const fetchCatalog = async (fileId, apiKey) => (await publicFetch(fileId, apiKey)).json();
export const downloadPublic = async (fileId, apiKey, resourceKey) => (await publicFetch(fileId, apiKey, resourceKey)).arrayBuffer();

export function errorText(e) {
  if (e?.code === 'need-auth') return 'Phiên đăng nhập đã hết hạn — bấm "Kết nối lại".';
  if (e instanceof TypeError) return 'Không có kết nối mạng.';
  return e?.message || String(e);
}
