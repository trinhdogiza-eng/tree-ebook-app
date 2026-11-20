// Lưu trữ cục bộ bằng IndexedDB: tệp sách, thông tin sách, tiến độ, bảng vị trí (locations).
const DB_NAME = 'epub-reader';
const DB_VERSION = 1;
const STORES = ['books', 'files', 'progress', 'locations'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());

export async function removeBook(id) {
  await Promise.all(STORES.map((s) => del(s, id)));
}

// Xin trình duyệt giữ dữ liệu lâu dài (tránh iOS/Android tự xoá khi thiếu dung lượng).
export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
