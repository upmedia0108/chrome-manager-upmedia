// Chép module dùng chung từ app sang cổng MCP (server/shared/).
// Sửa chromeProfiles.js / accounts.js / chromeWindows.js ở chrome-shortcut-manager/src rồi chạy: npm run sync
// (test "bản sao dùng chung khớp với app" sẽ báo đỏ nếu quên chạy).
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', '..', 'chrome-shortcut-manager', 'src');
const DST = path.join(__dirname, '..', 'server', 'shared');
for (const f of ['chromeProfiles.js', 'accounts.js', 'chromeWindows.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  console.log('Đã chép', f);
}
