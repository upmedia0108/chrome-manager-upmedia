# Changelog — Chrome Manager by UP Media

Tất cả thay đổi theo từng phiên bản.

## v1.11.0
- **Khóa mở Chrome bằng mã + cảnh báo khi mở** (máy dùng chung ở công ty).
  - **Mã CEO** (≥ 8 ký tự, đặt trên từng máy khi bật tính năng, kèm **mã khẩn cấp** hiện 1 lần): mở được mọi Chrome/nhóm đang khóa; cần để khóa, gỡ khóa, cấp lại mã, xóa nhóm đang khóa, xem nhật ký. Không có mã CEO nào nằm trong code/repo.
  - **Khóa nhóm** (dùng nhóm sẵn có) hoặc **khóa riêng 1 Chrome**; mỗi Chrome chỉ 1 lớp khóa. App tự tạo mã 6 số, hiện 1 lần + nút "Sao chép tin nhắn Fiine". Chỉ lưu mã đã băm (scrypt).
  - **Mã nhóm**: mở cả nhóm (hỏi 1 lần khi "Mở tất cả"), thêm Chrome chưa khóa vào nhóm (Chrome khóa theo nhóm), gỡ Chrome khỏi nhóm (Chrome hết khóa), đổi tên nhóm.
  - **Mở khóa tới khi tắt Chrome đó**: sau 45 giây, Chrome nào không còn cửa sổ 2 lần đọc liên tiếp (~15 giây/lần; Chrome chạy ngầm cũng tính là đã tắt) tự khóa lại. Tắt app hoặc "Đóng tất cả Chrome" thì mọi Chrome khóa lại.
  - Chrome đang khóa: ẩn ghi chú, Gmail, lịch sử, cookie/mạng xã hội; không đổi tên, không xóa, không chuyển nhóm khóa; xóa shortcut Desktop và không cho tạo lại; bỏ qua khi "Mở tất cả", "Tạo tất cả shortcut", mở profile mặc định.
  - **Cảnh báo khi mở** cho từng Chrome và từng nhóm, nhân sự tự đặt kèm **mã cảnh báo** (sửa/tắt cần mã cảnh báo, mã khóa của mục đó hoặc mã CEO). Pop-up hiện mỗi lần bấm mở.
  - **Phát hiện sửa file**: dữ liệu khóa ký HMAC, lưu file chính `%APPDATA%\chrome-manager-upmedia\locks.json` + bản dự phòng `%LOCALAPPDATA%\UP Media\Chrome Manager\locks-backup.json` + **bản neo** (trạng thái mới nhất cất cùng khóa bí mật trong `lock.key`, mã hóa DPAPI qua `safeStorage`) + dấu niêm phong registry `HKCU\Software\UP Media\Chrome Manager\LockSeal` (cho cổng MCP). File bị sửa / xóa / chép đè bản cũ → **tự khôi phục từ bản neo**, thanh vàng, ghi nhật ký. **Khóa toàn bộ** (thanh đỏ, nhập mã CEO / mã khẩn cấp) khi mất khóa bí mật hoặc mọi nơi đều bị chép đè bản cũ; mất cả khóa bí mật lẫn dữ liệu đáng tin → chỉ "Đặt lại từ đầu" (mã CEO mới, bỏ khóa cũ, ghi nhật ký). Khôi phục không bao giờ tin mã CEO trong file chưa kiểm được. Lỗi đọc/ghi bất ngờ → khóa toàn bộ, không bao giờ "mở toang".
  - Nhập sai mã 5 lần / mục → chặn mục đó 5 phút; sai tổng 15 lần (mọi mục) → chặn mọi lần nhập mã 5 phút. **Nhật ký bảo vệ** (200 sự kiện gần nhất) xem bằng mã CEO.
  - Chrome có khóa hoặc cảnh báo chỉ mở bằng nút "Mở"; bấm vùng trắng của thẻ chỉ báo nhắc (thẻ thường vẫn bấm vùng trắng để mở). Thẻ: tên Chrome chiếm ít nhất nửa dòng tiêu đề, các nhãn gom vào `.card-badges` tự xuống dòng ở nửa phải.
  - Cửa sổ app chặn chuyển trang / mở cửa sổ mới (trang lạ không dùng được `window.app`); so thư mục profile không phân biệt hoa thường; "Đóng tất cả Chrome" khóa lại ngay mọi Chrome đang mở khóa; nhập đúng mã nhưng Hủy ở pop-up cảnh báo → khóa lại ngay.
- Module mới: `src/locks.js` (lõi thuần, dùng chung với cổng MCP), `src/lockService.js` (theo dõi mở khóa, chặn đoán mã, ẩn dữ liệu), `renderer/locksUi.js` (giao diện). `main.js` chặn mọi IPC đụng tới Chrome đang khóa; 17 IPC mới `lock-*` / `warning-*` (xem `preload.js`).
- Cổng MCP **1.3.0**: tôn trọng khóa (không mở, không đưa cửa sổ lên, ẩn ghi chú/email; khóa tính theo cả file chính lẫn bản dự phòng), bắt đọc cảnh báo (`ma_canh_bao=<mã xác nhận>` lấy từ lần trả cảnh báo), dữ liệu khóa bị sửa / bị xóa → khóa toàn bộ.
- Đã qua kiểm tra độc lập (trợ lý riêng chỉ đọc đặc tả): sửa 4 lỗi nặng (lỗi ghi lúc khôi phục làm mất khóa; khôi phục tin mã CEO trong file đã bị sửa; xóa file làm CEO bị khóa ngoài vĩnh viễn; cổng MCP tin file chỉ sửa nội dung) và các lỗi vừa / nhỏ (dò mã CEO qua lệnh cảnh báo, bỏ qua mã cảnh báo khi xóa / đổi tên nhóm, Chrome chạy ngầm không tự khóa lại, mở từ Lịch sử không hiện cảnh báo, nhập Excel gán thẳng nhóm khóa…).
- Test: +30 unit test (`test/locks.test.js`, `test/lockService.test.js`), app tổng 56; kiểm thử giao diện tự động 21 kịch bản (Playwright, phần nền giả lập dùng lõi khóa thật).

---

## v1.10.6
- **Sửa "Đang mở" chỉ thấy 1 Chrome.** Chẩn đoán trên máy thật (18/11/2026): Chrome gom MỌI profile vào 1 tiến trình trình duyệt, dòng lệnh chỉ còn `--profile-directory` của profile mở đầu tiên → cách đọc dòng lệnh (PowerShell CIM) chỉ thấy 1 profile. Module mới `src/chromeWindows.js`:
  - `getLoadedProfileDirs(userDataPath)`: profile đang mở = Chrome đang khóa `Network/Cookies` (hoặc `Cookies`, `Local Storage/leveldb/LOCK`) — Node thuần, khớp 3/3 Chrome đang mở trên máy thật. Thay `getChromeCommandLines`/`getRunningProfileDirs`/`isChromeRunningForProfile` trong `main.js` (đã gỡ cách cũ). Vòng làm mới 4 giây không còn gọi PowerShell.
  - `focusProfileWindow(dir)`: PowerShell (`-EncodedCommand`) liệt kê cửa sổ chrome.exe, đọc thuộc tính `RelaunchCommand` (`--profile-directory="Profile N"`) / `AppUserModelID` (`Chrome.UserData.ProfileN`, Default = `Chrome`) để tìm ĐÚNG cửa sổ của profile → sửa lỗi bản 1.10.0 (khớp tiền tố: Profile 1 dính Profile 14; dùng cửa sổ chính của tiến trình nên nhảy nhầm; `SW_RESTORE` làm thu nhỏ cửa sổ đang phóng to). Nay chỉ khôi phục cửa sổ đang thu nhỏ, thử mẹo phím Alt khi Windows chặn giành focus. Mẫu nhận diện dùng chung JS ↔ PowerShell (`RELAUNCH_DIR_RE`, `AUMID_PROFILE_RE`), có test bằng mẫu thật.
- `open-profile`: profile đang mở → đưa cửa sổ lên trước (`focused`); không thấy cửa sổ nào (profile chạy ngầm) → mở cửa sổ mới.
- Renderer: `refreshRunning` chỉ vẽ lại khi tập "Đang mở" thay đổi (trước đây vẽ lại danh sách mỗi 4 giây khi đang lọc "Đang mở").
- `nameRules.js`: thêm mẫu tên mặc định "Cá nhân N" (Chrome tiếng Việt).
- Thêm 5 unit test (`test/unit.test.js`).
- `chromeWindows.js` thêm `listChromeWindows`/`parseWindowList`/`buildListScript` (liệt kê cửa sổ Chrome theo profile) — cổng MCP 1.2.0 dùng để bù cho Chrome vừa mở chưa khóa file; app chưa dùng (+1 unit test).

---

## v1.10.0
- **Định vị Chrome đang mở + khớp tên hai chiều (Hướng A + B).**
  - **Hướng A — đồng bộ tên lên Chrome:** `chromeProfiles.applyProfileName(userDataPath, dir, name)` ghi tên thân thiện (`shortcutName`) vào `Local State → info_cache[dir]` (`name`, `shortcut_name`, `is_using_default_name=false`) + `Preferences → profile.name`. Nhìn cửa sổ Chrome (nút profile góc phải + taskbar / Alt-Tab) là biết profile nào. Tự đồng bộ trước mỗi lần mở (`syncChromeNameFor` trong `open-profile`, `open-profile-url`, `open-profiles-batch`). Nút "Đồng bộ tên" trong Cài đặt → IPC `sync-all-profile-names` (đóng Chrome trước rồi ghi tất cả). Hàm thuần `setNameInLocalStateObj` có unit test.
  - **Hướng B — Chrome đang mở:** nhãn "● Đang mở" trên thẻ/hàng (tự cập nhật mỗi 4 giây qua `refreshRunning` + `get-running-profiles`), bộ lọc sidebar "Đang mở" (`activeSidebarFilter.type==='running'`), bấm nhãn → IPC `focus-profile-window` (PowerShell `SetForegroundWindow` theo `--profile-directory`) đưa cửa sổ lên trước.
- IPC mới: `sync-all-profile-names`, `focus-profile-window`. Preload: `syncAllProfileNames`, `focusProfileWindow`.

## v1.9.4
- **Sửa lỗi bộ lọc "Chưa đặt tên" xếp nhầm profile đã có tên.** Nguyên nhân: `isUnnamed()` cũ coi "tên shortcut = tên Chrome đang lưu (`chromeProfileName`)" là chưa đặt (vì `main.js` tự điền tên Chrome vào ô tên khi chưa đặt) → profile mà tên Chrome đã là tên thật (vd Profile 14 "Đinh Thị Thanh") bị xếp nhầm. Quy tắc mới tách ra `renderer/nameRules.js` (`isUnnamedProfile`, dùng chung cho sidebar, thống kê header, chấm vàng dạng hàng + unit test): chỉ "chưa đặt" khi tên trống / trùng `Profile N` / khớp mẫu tên mặc định Chrome (Person N, Người dùng N, Your Chrome…) / hoặc trùng tên Chrome **và** Chrome đánh dấu `is_using_default_name` (trừ khi trùng tên tài khoản Google).
- `chromeProfiles.scanProfiles()` trả thêm `chromeUsingDefaultName` (Local State `info_cache.is_using_default_name`, dự phòng Preferences `profile.using_default_name`) và `chromeGaiaNames`.
- Ô "Tên shortcut": chỉ lưu khi tên thực sự đổi (trước đây chỉ bấm vào rồi bấm ra cũng lưu); sau khi lưu cập nhật ngay số đếm "Chưa đặt tên" ở header + sidebar (cập nhật tại chỗ, không vẽ lại sidebar để không mất cú bấm).
- Thêm 7 unit test (`test/unit.test.js`).

## v1.9.2
- **Khuyến nghị Basic/Pro đúng sức máy:** công thức mới chỉ gợi ý Basic khi `RAM < 8GB` HOẶC `CPU ≤ 2 nhân` HOẶC (`RAM < 16GB` và `>80 Chrome`). Trước đây chỉ cần >50 Chrome là khuyên Basic kể cả máy khỏe → đã sửa.
- **Dọn "profile ma":** `chromeProfiles.removeProfilesFromLocalState()` xóa các entry Chrome còn nhớ trong Local State nhưng thư mục đã mất. Nút "Dọn profile ma" trên thanh so sánh (IPC `clean-ghost-profiles`, đóng Chrome trước khi dọn). Handler `delete-chrome-profile` nay cũng dọn Local State → không sinh profile ma nữa.

## v1.9.0
- **Tự động cập nhật (electron-updater + GitHub Releases, repo Public):** app tự kiểm tra bản mới khi khởi động, tải nền và hỏi khởi động lại để cập nhật. Nút "Kiểm tra cập nhật" trong Cài đặt. IPC `check-for-updates`; `build.publish` github `releaseType: release`.
- **CI đổi mới:** version = `<major>.<minor>.<run_number>` (KHÔNG commit ngược về repo → máy owner push lúc nào cũng trơn tru, không kẹt "cần pull"); `electron-builder --publish always` tự tạo Release kèm `latest.yml`. Telegram chuyển thành tùy chọn (chỉ chạy nếu có secret).
- **Ghim profile lên đầu:** nút ghim trên thẻ và hàng tinh gọn; profile ghim luôn nổi lên đầu, giữ qua các lần quét, ghim được nhiều cái. Lưu `pinned` trong `config.json`.
- **Box so sánh "Chrome trong máy vs đã quét":** đọc `Local State` → `profile.info_cache` (nguồn chân lý số profile Chrome tự khai) để so với số quét được; báo rõ thiếu bao nhiêu + lý do từng cái (thư mục không còn / thiếu Preferences / tên không chuẩn).
- **Sửa lỗi quét thiếu:** `scanProfiles` nay vẫn nhận profile `Default`/`Profile N` chưa có file `Preferences` (trước đây bị bỏ qua gây thống kê thiếu).
- **Chế độ Basic/Pro (máy yếu):** handler `get-system-info` đọc RAM/CPU; Cài đặt hiện cấu hình máy + khuyến nghị; Basic bỏ tự quét Social khi mở app, không tải avatar thật, ưu tiên dạng hàng. Lưu `upm_perf_mode` ở localStorage.
- **Chống mở trùng bền hơn:** thay dò tiến trình `wmic` bằng PowerShell `Get-CimInstance` (Windows 11 24H2 đã gỡ `wmic`), vẫn fallback `wmic` cho máy cũ.
- Đây là bản đầu tiên trên **repo riêng** `chrome-manager-upmedia` (tách khỏi monorepo `UP-Media`).

---

## v1.8.54
- Chuyển icon **"Phím tắt"** và **"Tiện ích UP Media"** lên thanh header (cạnh cụm thống kê) cho gọn, dễ thấy.

## v1.8.53
- Thiết kế lại pop-up **"Tạo tài khoản Chrome mới"**: rộng hơn (640px), bố cục xếp dọc thoáng, hết chồng chéo.
- Gộp **Tạo tất cả shortcut / Tối ưu dung lượng / Đóng Chrome** vào menu **"Chức năng"** trên toolbar.
- Phím tắt chuyển thành **icon** (rê chuột xem nhanh) + thêm **Ctrl+~** mở bảng phím tắt.
- Thêm **"Tiện ích UP Media trên Store"**: danh sách extension chính thức, mở bằng trình duyệt (extension đầu tiên: UP Media - Cookie Facebook). Danh sách dạng dữ liệu để dễ thêm về sau.
- Đồng bộ giao diện mục **"Lọc nhóm"** theo **"Lọc đăng nhập"** (icon/chấm màu + tên + số đếm, cùng font).

## v1.8.52
- **Typeahead danh mục:** gõ tên để lọc nhóm/danh mục con có sẵn hoặc **tạo mới** ngay (tự lưu & đồng bộ). Áp dụng cả trên thẻ lẫn pop-up thêm tài khoản.
- **Bấm vùng trắng của thẻ** để mở Chrome (không cần đúng nút "Mở").
- **Chống mở trùng:** khi quét lại / mở hàng loạt / mở mặc định lúc khởi động, bỏ qua các Chrome đang mở sẵn.
- **Esc / Ctrl+D** đóng mọi pop-up.
- Thêm phím tắt **Ctrl+O** (đổi kiểu hiển thị), **Ctrl+G** (nhóm), **Ctrl+T** (dung lượng), **Ctrl+L** (load Social); thêm nút/bảng danh sách phím tắt.
- Thanh cuộn danh sách Chrome dày hơn (dễ kéo).

## v1.8.51
- **Tự chạy dưới quyền Administrator** khi khởi động (khắc phục lỗi thỉnh thoảng không gõ được tiếng Việt/Unikey) — có thể tắt trong Cài đặt.
- Thêm phím tắt: **Ctrl+F** (tìm kiếm), **Ctrl+N** (thêm Chrome), **Ctrl+D** (xóa bộ lọc), **Ctrl+Q** (Cài đặt), **Ctrl+R** (quét lại).

## v1.8.42
- Extension cookie: thêm ô textarea xem/sửa cookie, nút Lấy / Copy / Đăng nhập bằng cookie (nhập), khử trùng lặp cho chuỗi cookie chuẩn.

## v1.8.41
- Lấy cookie Facebook chuyển sang **extension độc lập** (`assets/fb-cookie-extension/`): Cài đặt → "Xuất extension ra Desktop" → tự cài (load unpacked) → bấm icon để Copy/Nhập cookie.
- Sửa modal Cài đặt bị che nút phía dưới (thêm thanh cuộn).

## v1.8.40
- Thêm nút "Tải file mẫu" Excel để điền thông tin nhập profile hàng loạt.
- Cải thiện thông báo lỗi khi Copy cookie.

## v1.8.39
- Xuất cookie Facebook (opt-in, qua extension nội bộ + localhost) — sau này thay bằng extension độc lập.

## v1.8.38
- **Nhập tiện ích ngoài store hàng loạt:** đóng gói thư mục thành CRX + ép cài lên tất cả Chrome (self-host localhost, không cần Developer Mode).

## v1.8.37
- Xuất / Nhập dữ liệu chuyển sang **Excel (.xlsx)** thay JSON — mỗi dòng tạo 1 Chrome mới.

## v1.8.36
- Bỏ chặn tiện ích đang bị chặn; hiện số tiện ích ở chế độ hàng; Xuất/Nhập dữ liệu; đổi khẩu hiệu header.

## v1.8.34–1.8.35
- **Quản lý tiện ích:** liệt kê tiện ích của profile (đọc Secure Preferences); nhân bản/ép cài 1 tiện ích ra tất cả Chrome (policy + verify registry); xóa 1 tiện ích khỏi tất cả (kể cả hàng chờ).

## v1.8.31–1.8.33
- Bỏ "Dọn tiện ích"; mở toàn màn hình; Cài đặt (khởi động cùng Windows, profile mở mặc định); sắp xếp theo lượt mở; **chế độ hàng tinh gọn**; lọc "Chưa đặt tên" / "Chưa có nhóm"; sửa tên danh mục con; **Lịch sử phiên bản** trong app; changelog cuộn được.

## v1.8.30
- Sửa lỗi đơ: bỏ tự động quét cache dung lượng từng thẻ; thêm nút "Tính" cache riêng.

## v1.8.29
- Tìm kiếm không phân biệt hoa/thường, dấu tiếng Việt, khoảng trắng, ký tự đặc biệt; tự xóa ô tìm kiếm khi bấm bộ lọc; Social Cache tải thủ công + tự làm mới 7 ngày.

## v1.8.26
- Nâng cấp toàn bộ giao diện theo nhận diện thương hiệu UP Media.

## v1.8.0–1.8.25
- Kiểm tra đăng nhập mạng xã hội qua cookie SQLite (v10/v11/v20); đọc Gmail, lịch sử duyệt; xử lý khóa file Chrome (Kill-Read-Reopen); tối ưu cache.

---

## v1.3.0 — 2026-06-20

### Thêm mới
- **Đa nhóm (Multi-group):** Mỗi profile có thể thuộc nhiều nhóm cùng lúc. Hiển thị dạng tag chip, click vào tag để xóa nhóm đó, nút `+` để thêm nhóm mới.
- **Đánh số profile:** Badge `#1`, `#2`... hiện ngay trên ảnh đại diện dựa theo tên thư mục (`Profile 1`, `Profile 2`...). Profile Default hiện `★`.
- **Tối ưu dung lượng:** Nút cam "Tối ưu dung lượng" trên toolbar — xem dung lượng cache từng profile, xóa cache tất cả hoặc từng profile riêng lẻ. Chỉ xóa cache, không đụng vào cookie/mật khẩu/đăng nhập.
- **Ghi chú per profile:** Mỗi card có nút ghi chú, click để mở/đóng textarea. Tự động lưu khi blur. Hiện dấu chấm đỏ khi có nội dung. Nội dung ghi chú được tìm kiếm cùng với tên profile.

### Thay đổi kỹ thuật
- `src/storage.js` — file mới, xử lý tính dung lượng và xóa cache
- `src/configStore.js` — migration tự động từ `group` (string) sang `groups` (array)
- `main.js` — thêm 4 IPC handler: `get-cache-size`, `get-all-cache-sizes`, `clear-cache`, `clear-all-cache`
- `preload.js` — expose 4 API mới: `getCacheSize`, `getAllCacheSizes`, `clearCache`, `clearAllCache`

---

## v1.2.0 — 2026-06-19

### Thêm mới
- **Quản lý nhóm tùy chỉnh:** Thêm, sửa, xóa nhóm trong modal "Quản lý nhóm". Không bị giới hạn bởi 6 nhóm mặc định.
- **Đồng bộ ảnh avatar Chrome:** App đọc file `Google Profile Picture.png` trong thư mục profile và hiển thị ảnh thật của từng tài khoản Google.
- **Tạo Chrome profile mới:** Nút "Thêm tài khoản" mở Chrome với profile rỗng để tạo tài khoản mới. Sau đó bấm "Quét lại" để thấy profile mới.

---

## v1.1.0 — 2026-06-18

### Thêm mới
- **Chọn thư mục thủ công:** Nút "Chọn thư mục thủ công" cho phép chỉ định đường dẫn Chrome User Data khi app không tự tìm được (ví dụ: Chrome cài ở ổ D).
- **Quét đa ổ đĩa:** Tự động quét đường dẫn Chrome User Data ở ổ C, D, E, F.
- **Tìm kiếm:** Ô tìm kiếm trên toolbar, tìm theo tên profile và shortcut name.
- **Lọc theo nhóm:** Dropdown lọc profile theo nhóm.

---

## v1.0.0 — 2026-06-17

### Ra mắt ban đầu
- Quét tự động Chrome profile từ `%LOCALAPPDATA%\Google\Chrome\User Data`
- Hiển thị profile dạng card với tên, ảnh đại diện, trạng thái shortcut
- Đổi tên profile thành tên thân thiện
- Gán nhóm cho profile: Seeding, Ads, BM, Khách hàng, Cá nhân, Khác
- Tạo shortcut `.lnk` ra Desktop theo từng profile hoặc tất cả cùng lúc
- Mở Chrome profile trực tiếp từ app
- Xóa shortcut
- Lưu config tại `%APPDATA%\Chrome Shortcut Manager\config.json`
- Thống kê: Tổng profile / Có shortcut / Chưa có shortcut / Chưa đặt tên
