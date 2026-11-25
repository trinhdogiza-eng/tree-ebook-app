// Điền Client ID của bạn (xem README). Để trống dịch vụ nào thì nút đăng nhập của dịch vụ đó bị ẩn.
export const cloudConfig = {
  // Microsoft Entra (Azure) → App registrations → Application (client) ID
  onedriveClientId: '',
  // Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (loại Web application)
  // Project Google Cloud "Doc EPUB" (doc-epub), tài khoản dovantrinh@hotmail.com
  googleClientId: '603934511242-7vb672r76njjbm1basudm0m98kmmt59m.apps.googleusercontent.com',

  // Google Picker (cửa sổ chọn sách của Google) — cùng project với Client ID ở trên
  //  - googleApiKey: Credentials → API key, giới hạn website: app.dvt-treebook.com, localhost, docs.google.com
  //  - googleAppId: số project (Project number), là phần số ở đầu Client ID
  // Key "Tree Ebook Picker" (tạo 24/11/2026): chỉ dùng được cho Google Picker API, từ app.dvt-treebook.com / docs.google.com / localhost:8080
  googleApiKey: 'AIzaSyCTTDgb8t6xm0AV3B8hc0bd2TMF048hH78',
  googleAppId: '603934511242',

  // Thư viện sách của chủ app trên Google Drive (để mọi người xin quyền đọc).
  // Mã thư mục = phần cuối link https://drive.google.com/drive/folders/<mã>
  // Thư mục "Ebook sách" trong Drive của dovantrinh@gmail.com
  libraryFolderId: '1rPfRcFT2DYGQMuNldWlIkX6J_9QnhOQ5',
  libraryName: 'Thư viện Tree Ebook',
  libraryOwner: 'Trình Đỗ',
  // Danh mục thư viện (tệp tree-ebook-danh-muc.json trong "Ebook sách", app của chủ thư viện tự cập nhật 6 giờ/lần).
  // Người khác đọc danh mục + tải sách bằng googleApiKey → thư mục phải để "Ai có link đều xem được"
  // và API key phải được phép dùng Google Drive API.
  catalogFileId: '1l-ADcTYj4gh1i83F2T2DmuhhyGCA9DUa',
  // Kho sách thêm (cũng của dovantrinh@gmail.com, để "Ai có link đều xem được"). Mỗi kho hiện thành 1 mục
  // trong thư viện chung và được gộp vào cùng tệp danh mục ở trên. Thêm kho: thêm 1 dòng { id, name }.
  // Kho dạng thư viện Calibre (Thể loại/Tác giả/Tên sách/…) được tự rút gọn: bỏ tầng thư mục chỉ chứa 1 cuốn.
  extraLibraries: [
    { id: '1BL3RMDMUHNiU2-r5ylGk79brBe2_gkek', name: 'Kho sách 2' }, // "Ebook sách" ở thư mục gốc Drive, thêm 25/11/2026
  ],
};
