// Google Picker: cửa sổ chọn tệp chính thức của Google.
// Với quyền drive.file, app chỉ đọc được những tệp người dùng chọn ở đây (kể cả tệp người khác chia sẻ cho họ).
/* global gapi, google */
import { cloudConfig } from './cloud-config.js';

const GAPI = 'https://apis.google.com/js/api.js';
let loading = null;

export const pickerReady = () => !!(cloudConfig.googleApiKey && cloudConfig.googleAppId);

function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GAPI;
    s.async = true;
    s.onload = () => gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Không tải được Google Picker')) });
    s.onerror = () => { loading = null; reject(new Error('Không tải được Google Picker (cần mạng)')); };
    document.head.appendChild(s);
  });
  return loading;
}

// Mở cửa sổ chọn sách → trả về [{ id, name, mimeType, parentId }] (mảng rỗng nếu người dùng đóng)
export async function pickBooks(token, { library = false } = {}) {
  await loadPicker();
  const P = google.picker;
  const BOOK_MIMES = [
    'application/epub+zip', 'application/pdf', 'application/x-mobipocket-ebook',
    'application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook', 'application/octet-stream',
    'application/vnd.google-apps.folder',
  ].join(',');
  // Chế độ danh sách: với drive.file Google không cho xem ảnh thu nhỏ
  const view = (label, setup) => {
    const v = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false)
      .setMimeTypes(BOOK_MIMES).setMode(P.DocsViewMode.LIST).setLabel(label);
    setup(v);
    return v;
  };
  const lib = cloudConfig.libraryFolderId
    ? view(cloudConfig.libraryName || 'Thư viện', (v) => v.setParent(cloudConfig.libraryFolderId)) : null;
  const mine = view('Drive của tôi', (v) => v.setParent('root'));
  const shared = view('Được chia sẻ với tôi', (v) => v.setOwnedByMe(false));

  return new Promise((resolve) => {
    const b = new P.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(cloudConfig.googleApiKey)
      .setAppId(cloudConfig.googleAppId)
      .setLocale('vi')
      .setTitle('Chọn sách để đọc')
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) {
          resolve((data[P.Response.DOCUMENTS] || []).map((d) => ({
            id: d[P.Document.ID], name: d[P.Document.NAME], mimeType: d[P.Document.MIME_TYPE], parentId: d[P.Document.PARENT_ID],
          })));
        } else if (action === P.Action.CANCEL) resolve([]);
      });
    // Thư viện chung đứng đầu khi mở từ nút "Thư viện", còn lại thì Drive của tôi trước
    const views = library && lib ? [lib, mine, shared] : [mine, shared, lib].filter(Boolean);
    views.forEach((v) => b.addView(v));
    b.build().setVisible(true);
  });
}

// Trang thư mục thư viện trên Google Drive: người chưa có quyền sẽ thấy nút "Yêu cầu quyền truy cập"
export const libraryUrl = () => cloudConfig.libraryFolderId
  ? `https://drive.google.com/drive/folders/${encodeURIComponent(cloudConfig.libraryFolderId)}` : '';
