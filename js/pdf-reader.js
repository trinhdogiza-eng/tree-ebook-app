// Trình đọc PDF dùng pdf.js (thư viện đọc PDF của Mozilla/Firefox).
// - Lật trang: 1 trang vừa khung, trượt mượt (transform trên GPU), kéo theo ngón tay; trang trước/sau
//   được vẽ sẵn để kéo là thấy ngay.
// - Cuộn dọc: các trang xếp liền nhau, vừa chiều ngang; chỉ vẽ những trang gần màn hình (tiết kiệm bộ nhớ).
// - Phóng to: chụm/mở 2 ngón, Ctrl + lăn chuột, hoặc A+/A−. Khi phóng to thì kéo để xem phần còn lại.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168';
const EASE = 'cubic-bezier(.25,.8,.25,1)';
const MAX_CANVAS_PX = 5e6; // giới hạn điểm ảnh mỗi trang (iPhone giới hạn bộ nhớ canvas)
const ZOOM_MIN = 1, ZOOM_MAX = 4;

let lib = null;
async function loadPdfjs() {
  if (lib) return lib;
  lib = await import(`${PDFJS}/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
  return lib;
}

export const isPdfBuffer = (buf) => {
  const b = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true; // "%PDF"
  }
  return false;
};

export async function openPdf(data) {
  const L = await loadPdfjs();
  return L.getDocument({
    data,
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    isEvalSupported: false, // không chạy mã trong phông chữ
  }).promise;
}

// Thông tin để thêm vào thư viện: tên, tác giả, ảnh bìa (trang 1), số trang
export async function pdfInfo(buf) {
  const doc = await openPdf(new Uint8Array(buf.slice(0)));
  let title = '', author = '', cover = null;
  try {
    const m = await doc.getMetadata();
    title = (m.info?.Title || '').trim();
    author = (m.info?.Author || '').trim();
  } catch { /* không có metadata */ }
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 320 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  } catch { /* bỏ qua bìa */ }
  const pages = doc.numPages;
  await doc.destroy();
  return { title, author, cover, pages };
}

// Mục lục PDF → [{ label, page, level }]
async function readOutline(doc) {
  const out = [];
  let outline = null;
  try { outline = await doc.getOutline(); } catch { return out; }
  const walk = async (items, level) => {
    for (const it of items || []) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          page = typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
        }
      } catch { /* liên kết hỏng */ }
      if (page) out.push({ label: (it.title || '').trim(), page, level });
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

export class PdfReader {
  // opts: { container, doc, getSettings(), onLocation(page, pages), onTap(clientX), onZoom(zoom) }
  constructor(opts) {
    Object.assign(this, opts);
    this.pages = this.doc.numPages;
    this.page = 1;
    this.zoom = 1;
    this.baseSize = {}; // trang → [rộng, cao] ở tỉ lệ 1
    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage';
    this.container.appendChild(this.stage);
    this.lastTouch = 0;
    this.bindInput();
    let t = null;
    this.ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.rebuild(), 150); });
    this.ro.observe(this.stage);
  }

  get flow() { return this.getSettings().flow; }
  get animOn() {
    return this.getSettings().pageAnim !== 'none'
      && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  async outline() { return readOutline(this.doc); }

  async start(page) {
    this.page = Math.min(this.pages, Math.max(1, page || 1));
    const p1 = await this.doc.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    this.baseSize[1] = [v.width, v.height];
    this.applyTheme();
    await this.rebuild();
  }

  applyTheme() {
    const theme = this.getSettings().theme;
    this.stage.dataset.theme = theme;
  }

  // Dựng lại toàn bộ (đổi kiểu đọc, đổi cỡ màn hình, đổi mức phóng)
  async rebuild() {
    if (this.destroyed) return;
    this.gen = (this.gen || 0) + 1;
    this.finishAnims();
    this.applyTheme();
    this.stage.replaceChildren();
    this.stage.scrollTop = 0; this.stage.scrollLeft = 0;
    this.stage.classList.toggle('scrolled', this.flow !== 'paginated');
    this.stage.classList.toggle('zoomed', this.zoom > 1.001);
    if (this.flow === 'paginated') await this.buildPaged();
    else await this.buildScrolled();
  }

  size(n) { return this.baseSize[n] || this.baseSize[1] || [595, 842]; }
  fit(n) {
    const [bw, bh] = this.size(n);
    const W = this.stage.clientWidth || 1, H = this.stage.clientHeight || 1;
    if (this.flow === 'paginated') return Math.min(W / bw, H / bh) * 0.98;
    return W / bw;
  }

  // Vẽ trang n vào holder (thay nội dung khi xong). Huỷ lượt vẽ cũ nếu có.
  async draw(n, holder) {
    if (!holder || n < 1 || n > this.pages) { holder?.replaceChildren(); return; }
    const token = (holder._token || 0) + 1;
    holder._token = token;
    holder._page = n;
    holder._task?.cancel();
    const page = await this.doc.getPage(n);
    if (holder._token !== token || this.destroyed) return;
    const base = page.getViewport({ scale: 1 });
    this.baseSize[n] = [base.width, base.height];
    const scale = this.fit(n) * this.zoom;
    const cssW = base.width * scale, cssH = base.height * scale;
    let px = scale * Math.min(window.devicePixelRatio || 1, 2);
    const area = base.width * base.height * px * px;
    if (area > MAX_CANVAS_PX) px *= Math.sqrt(MAX_CANVAS_PX / area);
    const vp = page.getViewport({ scale: px });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    holder._task = task;
    try { await task.promise; } catch { return; }
    if (holder._token !== token || this.destroyed) { canvas.width = 0; return; }
    holder._task = null;
    holder.replaceChildren(canvas);
    if (holder.classList.contains('pdf-ph')) holder.style.height = `${cssH}px`;
  }

  /* ---------- Chế độ lật trang ---------- */
  async buildPaged() {
    this.slots = [-1, 0, 1].map(() => {
      const el = document.createElement('div');
      el.className = 'pdf-slot';
      this.stage.appendChild(el);
      return el;
    });
    this.placeSlots(0);
    const [prev, cur, next] = this.slots;
    await this.draw(this.page, cur);
    this.emit();
    if (this.zoom <= 1.001) { this.draw(this.page - 1, prev); this.draw(this.page + 1, next); }
  }

  W() { return this.stage.clientWidth || 1; }
  placeSlots(shift) {
    const W = this.W();
    this.slots.forEach((el, i) => {
      el.style.transform = `translate3d(${(i - 1) * W + shift}px,0,0)`;
      el.style.display = this.zoom > 1.001 && i !== 1 ? 'none' : '';
    });
  }

  animateSlots(from, to, ms) {
    const W = this.W();
    const anims = this.slots.map((el, i) => {
      el.style.transform = `translate3d(${(i - 1) * W + to}px,0,0)`;
      return el.animate(
        [{ transform: `translate3d(${(i - 1) * W + from}px,0,0)` }, { transform: `translate3d(${(i - 1) * W + to}px,0,0)` }],
        { duration: ms, easing: EASE },
      );
    });
    this.anims = anims;
    return Promise.all(anims.map((a) => a.finished.catch(() => {})));
  }
  finishAnims() { (this.anims || []).forEach((a) => a.finish()); this.anims = null; }

  // Các lần lật được xếp hàng: lần mới đợi lần trước xong hẳn (tránh 2 lần lật chen nhau làm sai trang)
  async turn(dir, shift = 0) {
    if (this.flow !== 'paginated') {
      // Cuộn dọc: nhảy theo màn hình
      this.stage.scrollBy({ top: dir * this.stage.clientHeight * 0.9, behavior: this.animOn ? 'smooth' : 'auto' });
      return;
    }
    if (this.busy) { this.finishAnims(); await this.busy; }
    const run = this.doTurn(dir, shift);
    this.busy = run;
    try { await run; } finally { if (this.busy === run) this.busy = null; }
  }

  async doTurn(dir, shift) {
    const gen = this.gen;
    const target = this.page + dir;
    if (target < 1 || target > this.pages || this.zoom > 1.001) {
      if (shift) await this.animateSlots(shift, 0, 200);
      if (this.zoom > 1.001 && target >= 1 && target <= this.pages) { this.page = target; await this.rebuild(); }
      return;
    }
    if (this.animOn) await this.animateSlots(shift, -dir * this.W(), 300);
    if (gen !== this.gen) return; // trang đã được dựng lại (nhảy trang / đổi cỡ) trong lúc trượt
    // Xoay vòng 3 ô: ô cũ bên kia được dùng để vẽ trang kế tiếp
    if (dir > 0) this.slots.push(this.slots.shift()); else this.slots.unshift(this.slots.pop());
    this.page = target;
    this.placeSlots(0);
    this.emit();
    const [prev, cur, next] = this.slots;
    if (cur._page !== this.page) await this.draw(this.page, cur);
    if (dir > 0) this.draw(this.page + 1, next); else this.draw(this.page - 1, prev);
  }

  /* ---------- Chế độ cuộn dọc ---------- */
  async buildScrolled() {
    this.col = document.createElement('div');
    this.col.className = 'pdf-col';
    const [bw, bh] = this.size(1);
    const scale = this.fit(1) * this.zoom;
    this.phs = [];
    for (let n = 1; n <= this.pages; n++) {
      const ph = document.createElement('div');
      ph.className = 'pdf-ph';
      const [w, h] = this.baseSize[n] || [bw, bh];
      ph.style.height = `${h * scale}px`;
      ph.style.width = `${w * scale}px`;
      ph.dataset.page = n;
      this.col.appendChild(ph);
      this.phs.push(ph);
    }
    this.stage.appendChild(this.col);
    this.io?.disconnect();
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const ph = e.target;
        if (e.isIntersecting) { if (ph._page !== +ph.dataset.page) this.draw(+ph.dataset.page, ph); }
        else if (ph.firstChild) { ph._token = (ph._token || 0) + 1; ph._task?.cancel(); ph._page = null; ph.replaceChildren(); }
      }
    }, { root: this.stage, rootMargin: '150% 0px' });
    this.phs.forEach((ph) => this.io.observe(ph));
    const target = this.phs[this.page - 1];
    if (target) this.stage.scrollTop = target.offsetTop;
    this.emit();
    if (!this.onScrollBound) {
      this.onScrollBound = () => {
        if (this.flow === 'paginated' || this.scrollRaf) return;
        this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = null; this.trackScroll(); });
      };
      this.stage.addEventListener('scroll', this.onScrollBound, { passive: true });
    }
  }

  trackScroll() {
    if (!this.phs?.length) return;
    const mid = this.stage.scrollTop + this.stage.clientHeight * 0.35;
    let lo = 0, hi = this.phs.length - 1;
    while (lo < hi) { // trang cuối cùng có đỉnh nằm trên điểm giữa
      const m = Math.ceil((lo + hi) / 2);
      if (this.phs[m].offsetTop <= mid) lo = m; else hi = m - 1;
    }
    const page = lo + 1;
    if (page !== this.page) { this.page = page; this.emit(); }
  }

  /* ---------- Điều hướng chung ---------- */
  async goTo(n) {
    n = Math.min(this.pages, Math.max(1, Math.round(n)));
    if (this.flow === 'paginated') {
      this.finishAnims();
      if (this.busy) await this.busy;
      this.page = n;
      await this.rebuild();
    } else {
      this.page = n;
      const ph = this.phs?.[n - 1];
      if (ph) this.stage.scrollTop = ph.offsetTop;
      this.emit();
    }
  }

  emit() { this.onLocation?.(this.page, this.pages); }

  setZoom(z) {
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 4) / 4));
    if (Math.abs(z - this.zoom) < 0.01) return;
    this.zoom = z;
    this.onZoom?.(z);
    this.rebuild();
  }
  zoomStep(d) { this.setZoom(this.zoom + d * 0.25); }

  /* ---------- Cảm ứng / chuột ---------- */
  bindInput() {
    const s = this.stage;
    s.addEventListener('touchstart', (e) => this.tStart(e), { passive: true });
    s.addEventListener('touchmove', (e) => this.tMove(e), { passive: false });
    s.addEventListener('touchend', (e) => this.tEnd(e), { passive: false });
    s.addEventListener('touchcancel', () => this.tCancel());
    s.addEventListener('click', (e) => {
      if (Date.now() - this.lastTouch < 800) return;
      this.onTap?.(e.clientX);
    });
    s.addEventListener('wheel', (e) => { // Ctrl + lăn chuột = phóng to/thu nhỏ (máy tính)
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.25 : 0.8));
    }, { passive: false });
  }
  canDrag() { return this.flow === 'paginated' && this.zoom <= 1.001; }
  tStart(e) {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      this.pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z0: this.zoom };
      this.pinch.d = this.pinch.d0;
      this.tCancel(true);
      return;
    }
    const t = e.touches[0];
    this.finishAnims();
    this.drag = { x: t.clientX, y: t.clientY, time: Date.now(), active: false, shift: 0, lastX: t.clientX, lastT: Date.now(), v: 0 };
  }
  tMove(e) {
    if (this.pinch) {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        this.pinch.d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        e.preventDefault();
      }
      return;
    }
    const d = this.drag;
    if (!d || !this.canDrag()) return;
    const t = e.touches[0];
    const dx = t.clientX - d.x, dy = t.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) d.active = true; else return;
    }
    e.preventDefault();
    const atEdge = (dx > 0 && this.page <= 1) || (dx < 0 && this.page >= this.pages);
    d.shift = atEdge ? dx / 3 : dx;
    if (this.animOn) this.placeSlots(d.shift);
    const now = Date.now();
    d.v = (t.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.lastX = t.clientX; d.lastT = now;
  }
  tEnd(e) {
    this.lastTouch = Date.now();
    if (this.pinch) {
      if (e.touches.length) return;
      const p = this.pinch; this.pinch = null;
      const ratio = p.d / p.d0;
      if (ratio > 1.1 || ratio < 0.9) this.setZoom(p.z0 * ratio);
      return;
    }
    const d = this.drag; this.drag = null;
    if (!d) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - d.x, dy = t.clientY - d.y, dt = Date.now() - d.time;
    if (d.active) {
      e.preventDefault();
      const fling = Math.abs(d.v) > 0.35;
      if (fling || Math.abs(dx) > this.W() * 0.18) this.turn((fling ? d.v : dx) < 0 ? 1 : -1, d.shift);
      else if (this.animOn) this.animateSlots(d.shift, 0, 200);
      return;
    }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 500) {
      e.preventDefault(); // không phát thêm "click"
      this.onTap?.(t.clientX);
    }
  }
  tCancel(silent) {
    const d = this.drag; this.drag = null;
    if (!silent && d?.active && this.animOn) this.animateSlots(d.shift, 0, 200);
    else if (d?.active) this.placeSlots(0);
  }

  destroy() {
    this.destroyed = true;
    this.ro?.disconnect();
    this.io?.disconnect();
    this.finishAnims();
    this.stage.querySelectorAll('canvas').forEach((c) => { c.width = 0; c.height = 0; });
    this.stage.remove();
    this.doc.destroy().catch(() => {});
  }
}
