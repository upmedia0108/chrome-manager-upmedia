# Chrome Manager by UP Media

Phần mềm desktop Windows (Electron) quản lý nhiều Chrome profile: tạo shortcut, phân nhóm, ghim, kiểm tra đăng nhập mạng xã hội, quản lý tiện ích, xuất/nhập Excel, tối ưu dung lượng.

- **Mã nguồn ứng dụng:** thư mục [`chrome-shortcut-manager/`](chrome-shortcut-manager/)
- **Tài liệu kỹ thuật đầy đủ:** [`CLAUDE.md`](CLAUDE.md) (đọc Mục 0 trước)
- **Hướng dẫn đẩy lên GitHub (không rành tech):** [`HUONG-DAN-GITHUB.txt`](HUONG-DAN-GITHUB.txt)
- **Phiên bản hiện tại:** v1.9.0

## Đẩy thay đổi lên GitHub
- Lần đầu: chạy `CAI-DAT-LAN-DAU.bat` (xem `HUONG-DAN-GITHUB.txt`).
- Về sau: bấm đúp `day-len-github.bat` → tự commit + push → CI tự build `.exe` + Release + Telegram.

## Chạy / build cho developer
```bash
cd chrome-shortcut-manager
npm ci
npm start           # chạy thử
npm test            # unit test
npm run build:win   # build .exe (NSIS + Portable) → dist/
```

CI/CD: push lên nhánh `main` → GitHub Actions (windows-latest) tự bump version, `npm ci` + `npm test`, build `.exe`, tạo Release, gửi Telegram (cần secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
