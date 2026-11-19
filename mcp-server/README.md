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
- **Ghi chú** chỉ gửi cho Claude **đoạn đầu** (trước xuống dòng/tab), tối đa 80 ký tự; đoạn nào trông như mật khẩu, mã 2FA, cookie, token thì **ẩn hẳn** (từ 1.2.0).
- Tên khớp nhiều Chrome → Claude **hỏi lại**, không tự chọn.
- Chrome đang mở sẵn → đưa cửa sổ đó lên trước màn hình, không mở chồng thêm cửa sổ (trừ khi Sếp yêu cầu).
- Mở nhóm **hơn 5 Chrome** → Claude phải hỏi xác nhận trước.
- Chỉ mở trang web `http/https`.
- **Khóa bằng mã (từ 1.3.0, cần app v1.11):** Chrome đang khóa → Claude **không mở, không đưa cửa sổ lên**, ẩn ghi chú và email; Claude không hỏi, không nhận mã. Người dùng tự mở trong Chrome Manager và nhập mã. Mở nhóm thì bỏ qua Chrome đang khóa.
- **Cảnh báo khi mở (từ 1.3.0):** Chrome hoặc nhóm có cảnh báo → lần gọi đầu Claude chỉ đọc cảnh báo cho người dùng, chưa mở; kèm mã xác nhận 6 ký tự; người dùng đồng ý thì Claude gọi lại với `ma_canh_bao=<mã>` (mã suy ra từ nội dung cảnh báo, không gọi lần đầu thì không biết mã).
- **Phát hiện file khóa bị sửa:** dấu niêm phong trong registry không khớp file khóa, hoặc app còn khóa bí mật mà mất cả 2 file → cổng coi như **khóa toàn bộ** (mở app là app tự khôi phục). Khóa tính theo cả file chính lẫn bản dự phòng: sửa 1 bản không gỡ được khóa với Claude.

Không cần bật Chrome Manager: cổng tự đọc tên, nhóm, ghi chú đã đặt trong app (`%APPDATA%\chrome-manager-upmedia\config.json`) và quét thư mục Chrome. Đổi tên trong app thì khoảng 20 giây sau Claude thấy tên mới.

## C. Dành cho dev / AI phiên sau

- **Cấu trúc:** `server/index.js` (khai báo 4 lệnh MCP, SDK `@modelcontextprotocol/sdk`) · `server/core.js` (logic thuần: đọc cấu hình, quét, khớp tên, mở Chrome) · `server/shared/` (**bản sao** `chromeProfiles.js`, `accounts.js`, `chromeWindows.js`, `locks.js` từ `chrome-shortcut-manager/src`).
- **Sửa `chromeProfiles.js` / `accounts.js` / `chromeWindows.js` / `locks.js` của app → chạy `npm run sync`** để chép sang. Test "bản sao module dùng chung khớp với app" báo đỏ nếu quên.
- **Test:** `npm install` rồi `npm test` (test lõi + test đầu-cuối bằng client MCP chính thức ở chế độ chạy khô `UPM_MCP_DRY_RUN=1`, không mở Chrome thật).
- **Đóng gói:** `npm run pack` → đồng bộ, chạy test, `mcpb validate`, `mcpb pack` → `dist/Chrome-Manager-UP-Media-MCP-<version>.mcpb` (`dist/` không đưa lên Git). Nâng version: sửa **cả** `package.json` và `manifest.json`.
- **Biến môi trường cho test:** `UPM_CONFIG_PATH`, `UPM_CHROME_USER_DATA`, `UPM_CHROME_EXE`, `UPM_MCP_DRY_RUN`, `UPM_MCP_FAKE_RUNNING` ("Profile 3,Profile 5"), `UPM_MCP_FAKE_NOWINDOW` (profile chạy ngầm không có cửa sổ), `UPM_LOCKS_PATH`, `UPM_LOCKS_MIRROR`, `UPM_LOCK_SEAL` (dấu niêm phong giả; chuỗi rỗng = không có, không đọc registry thật).
- **Khóa bằng mã (từ 1.3.0):** `server/shared/locks.js` là bản sao lõi khóa của app (`npm run sync`). Cổng chỉ ĐỌC `locks.json` (cạnh `config.json`), bản dự phòng `%LOCALAPPDATA%\UP Media\Chrome Manager\locks-backup.json` và giá trị registry `HKCU\Software\UP Media\Chrome Manager\LockSeal`; đọc mới mỗi lần gọi lệnh. Cổng không có khóa bí mật của app (mã hóa DPAPI) nên chỉ so bộ đếm + mã niêm phong: lệch → khóa toàn bộ. Kiểm chữ ký đầy đủ do app làm. Trạng thái "đã mở khóa tới khi tắt Chrome" chỉ nằm trong app, nên Chrome khóa luôn bị cổng từ chối kể cả khi đang mở khóa trong app.
- **Khác app:** không truyền `--remote-debugging-port` (vô tác dụng từ Chrome 130+, bỏ cho an toàn); thêm đường dẫn Chrome cài theo user (`%LOCALAPPDATA%\Google\Chrome\Application`); KHÔNG đồng bộ tên lên Chrome trước khi mở như app (cổng chỉ đọc + mở).
- **Đang mở (từ 1.2.0):** gộp khóa file + danh sách cửa sổ Chrome (`listChromeWindows`) — khóa file một mình bỏ sót Chrome vừa mở (test 19/11/2026). `mo_chrome` luôn tìm cửa sổ của profile trước: có → đưa lên; không → mở.
- **Đang mở + nhảy cửa sổ (từ 1.1.0):** dùng chung `chromeWindows.js` của app v1.10.6 — đang mở = Chrome khóa file dữ liệu của profile; nhảy đúng cửa sổ theo thuộc tính Windows của từng cửa sổ (xem `CLAUDE.md` Mục 19). Đang mở mà không thấy cửa sổ nào (chạy ngầm) → mở cửa sổ mới.
- **Cần nghiệm thu trên Windows thật:** mở theo tên; mở link; mở nhóm; chống mở trùng; đưa cửa sổ đang mở lên trước; trường hợp Chrome đang chạy do Chrome Manager (chạy quyền Administrator) mở trước đó.
