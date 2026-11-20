// Service worker: lưu sẵn giao diện và thư viện để app mở được khi không có mạng.
const CACHE = 'epub-reader-v44';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/sync.js', 'js/cloud-config.js', 'js/pdf-reader.js', 'js/read-aloud.js', 'js/mobi-convert.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Bật chế độ "cô lập" cho trang (COOP/COEP) → giọng AI được chạy trên nhiều nhân CPU (nhanh ~1.7×).
// GitHub Pages không cho đặt các header này nên service worker tự thêm vào khi trả trang về.
function isolate(res) {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // Mạng trước (để nhận bản cập nhật), rơi về bộ nhớ đệm khi ngoại tuyến.
    // cache: 'no-cache' → luôn hỏi lại máy chủ, không dùng bản HTTP-cache cũ (GitHub Pages cho cache 10 phút).
    const isPage = req.mode === 'navigate';
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return isPage ? isolate(res) : res;
      }).catch(() => caches.match(req, { ignoreSearch: true })
        .then((r) => r || caches.match('index.html'))
        .then((r) => (isPage && r ? isolate(r) : r))),
    );
  } else if (CDN_HOSTS.includes(url.hostname)) {
    // Thư viện có phiên bản cố định: dùng bộ nhớ đệm trước
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // OneDrive / Google Drive / đăng nhập: để trình duyệt tự xử lý
});
