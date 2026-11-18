# Cổng MCP — Chrome Manager by UP Media

Cho Claude (app Claude trên máy Windows) **tìm và mở đúng Chrome profile theo tên** đã đặt trong Chrome Manager by UP Media.
Gõ cho Claude: *"Mở Chrome Đinh Thị Thanh"*, *"Mở facebook.com trong Chrome Seeding FB 01"*, *"Mở cả nhóm FB"*.

## A. Cài đặt (làm 1 lần trên mỗi máy)

1. Mở app **Claude** trên máy tính (bản cài trên Windows, không phải trang web).
2. Bấm đúp file `Chrome-Manager-UP-Media-MCP-<phiên bản>.mcpb` (nằm trong thư mục `mcp-server\dist\`).
   Hoặc trong app Claude: **Settings → Extensions → Advanced settings → Install Extension…** rồi chọn file đó.
3. Màn hình cài hiện ra → bấm **Install**. Không cần nhập gì thêm.
4. Thử: mở một cuộc chat mới, gõ *"Liệt kê các Chrome trong nhóm Social"*.
   Lần đầu Claude gọi lệnh có thể hỏi cho phép → chọn cho phép.

> Không thấy chỗ cài hoặc bị chặn: tài khoản Team có thể đang bật danh sách cho phép tiện ích.
> Chủ tài khoản (Owner) vào phần quản trị tổ chức → Desktop extensions → tải file `.mcpb` lên để cả team cài được.

## B. Các lệnh Claude có

| Lệnh | Làm gì | Ví dụ câu nói |
|---|---|---|
| `tim_chrome` | Tìm / liệt kê theo tên, nhóm, ghi chú, email; báo Chrome nào đang mở | "Chrome nào có ghi chú Queen Spa?" |
| `mo_chrome` | Mở Chrome theo tên (có dấu, không dấu, hoặc "Profile 14"). Đang mở sẵn thì đưa cửa sổ đó lên trước | "Mở Chrome dinh thi thanh" |
| `mo_link` | Mở một trang web trong đúng Chrome | "Mở business.facebook.com trong Chrome Đinh Thị Thanh" |
| `mo_nhom` | Mở cả nhóm hoặc danh mục con | "Mở cả nhóm FB" |

Quy tắc an toàn:
- Chỉ **tìm và mở**. Không xóa, không sửa, không đọc cookie hay mật khẩu.
- Tên khớp nhiều Chrome → Claude **hỏi lại**, không tự chọn.
- Chrome đang mở sẵn → đưa cửa sổ đó lên trước màn hình, không mở chồng thêm cửa sổ (trừ khi Sếp yêu cầu).
- Mở nhóm **hơn 5 Chrome** → Claude phải hỏi xác nhận trước.
- Chỉ mở trang web `http/https`.

Không cần bật Chrome Manager: cổng tự đọc tên, nhóm, ghi chú đã đặt trong app (`%APPDATA%\chrome-manager-upmedia\config.json`) và quét thư mục Chrome. Đổi tên trong app thì khoảng 20 giây sau Claude thấy tên mới.

## C. Dành cho dev / AI phiên sau

- **Cấu trúc:** `server/index.js` (khai báo 4 lệnh MCP, SDK `@modelcontextprotocol/sdk`) · `server/core.js` (logic thuần: đọc cấu hình, quét, khớp tên, mở Chrome) · `server/shared/` (**bản sao** `chromeProfiles.js`, `accounts.js`, `chromeWindows.js` từ `chrome-shortcut-manager/src`).
- **Sửa `chromeProfiles.js` / `accounts.js` / `chromeWindows.js` của app → chạy `npm run sync`** để chép sang. Test "bản sao module dùng chung khớp với app" báo đỏ nếu quên.
- **Test:** `npm install` rồi `npm test` (test lõi + test đầu-cuối bằng client MCP chính thức ở chế độ chạy khô `UPM_MCP_DRY_RUN=1`, không mở Chrome thật).
- **Đóng gói:** `npm run pack` → đồng bộ, chạy test, `mcpb validate`, `mcpb pack` → `dist/Chrome-Manager-UP-Media-MCP-<version>.mcpb` (`dist/` không đưa lên Git). Nâng version: sửa **cả** `package.json` và `manifest.json`.
- **Biến môi trường cho test:** `UPM_CONFIG_PATH`, `UPM_CHROME_USER_DATA`, `UPM_CHROME_EXE`, `UPM_MCP_DRY_RUN`, `UPM_MCP_FAKE_RUNNING` ("Profile 3,Profile 5"), `UPM_MCP_FAKE_NOWINDOW` (profile chạy ngầm không có cửa sổ).
- **Khác app:** không truyền `--remote-debugging-port` (vô tác dụng từ Chrome 130+, bỏ cho an toàn); thêm đường dẫn Chrome cài theo user (`%LOCALAPPDATA%\Google\Chrome\Application`); KHÔNG đồng bộ tên lên Chrome trước khi mở như app (cổng chỉ đọc + mở).
- **Đang mở + nhảy cửa sổ (từ 1.1.0):** dùng chung `chromeWindows.js` của app v1.10.6 — đang mở = Chrome khóa file dữ liệu của profile; nhảy đúng cửa sổ theo thuộc tính Windows của từng cửa sổ (xem `CLAUDE.md` Mục 19). Đang mở mà không thấy cửa sổ nào (chạy ngầm) → mở cửa sổ mới.
- **Cần nghiệm thu trên Windows thật:** mở theo tên; mở link; mở nhóm; chống mở trùng; đưa cửa sổ đang mở lên trước; trường hợp Chrome đang chạy do Chrome Manager (chạy quyền Administrator) mở trước đó.
