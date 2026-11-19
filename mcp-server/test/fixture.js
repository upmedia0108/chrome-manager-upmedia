// Dựng một "máy giả": Chrome User Data + config.json của Chrome Manager, để test không cần Windows.
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-mcp-'));
  const ud = path.join(root, 'User Data');
  fs.mkdirSync(ud);
  const infoCache = {};
  const cfgProfiles = {};
  function addProfile(dir, chromeName, saved, extra = {}) {
    fs.mkdirSync(path.join(ud, dir));
    const prefs = { profile: { name: chromeName, using_default_name: /^Person \d+$/.test(chromeName) } };
    if (extra.email) prefs.account_info = [{ email: extra.email, full_name: chromeName }];
    fs.writeFileSync(path.join(ud, dir, 'Preferences'), JSON.stringify(prefs), 'utf8');
    infoCache[dir] = { name: chromeName, is_using_default_name: prefs.profile.using_default_name };
    if (saved) cfgProfiles[dir] = saved;
  }
  addProfile('Default', 'Sếp', { shortcutName: 'Tuyển UP', groups: ['Nhân sự UP'], subGroups: { 'Nhân sự UP': ['HCTH'] } });
  addProfile('Profile 14', 'Đinh Thị Thanh', { shortcutName: 'Đinh Thị Thanh', groups: ['Nhân sự UP'], subGroups: { 'Nhân sự UP': ['VHDA'] }, notes: 'Ads Queen Spa', pinned: true }, { email: 'thanh.dt@gmail.com' });
  for (let i = 2; i <= 10; i++) {
    addProfile(`Profile ${i}`, `Person ${i}`, { shortcutName: `Seeding FB ${String(i - 1).padStart(2, '0')}`, groups: ['Social'], subGroups: { Social: 'FB' },
      notes: i === 2 ? 'Tài khoản: 100099\nPass: GiaMatKhau99\n2FA: ABCDEFGHIJKLMNOPQRSTUVWX' : (i === 3 ? 'GiaMatKhau99\tc_user=100099; xs=GIA' : '') });
  }
  addProfile('Profile 11', 'Thanh Hà', null);
  addProfile('Profile 12', 'Person 12', { shortcutName: 'Thanh Hà KH', groups: ['Khách hàng'] });
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }), 'utf8');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    settings: { chromeUserDataPath: ud },
    groups: ['Social', 'Digital', 'Nhân sự UP', 'Khách hàng'],
    groupSubs: { Social: ['FB', 'Tiktok'], 'Nhân sự UP': ['HCTH', 'VHDA'] },
    profiles: cfgProfiles,
  }), 'utf8');
  return {
    root, userData: ud, configPath,
    // Dữ liệu khóa (app v1.11): locks.json nằm cạnh config.json; bản dự phòng + dấu niêm phong giả lập (không đụng registry thật)
    env: { UPM_CONFIG_PATH: configPath, UPM_CHROME_USER_DATA: ud, UPM_LOCKS_MIRROR: path.join(root, 'mirror', 'locks-backup.json'), UPM_LOCK_SEAL: '' },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
// Ghi dữ liệu khóa đã niêm phong giống app (CEO, khóa nhóm, khóa riêng, cảnh báo) — mã chỉ là mẫu giả
const CEO = 'GiaMaCEO-2026';
function writeLocks(fx) {
  const crypto = require('crypto');
  const locks = require('../server/shared/locks');
  let s = locks.setupCeo(locks.emptyState(), CEO).state;
  s = locks.lockGroup(s, CEO, 'Khách hàng', ['Profile 12'], '246810').state;
  s = locks.lockChrome(s, CEO, 'Profile 11', '135790').state;
  s = locks.setWarning(s, { type: 'group', group: 'Nhân sự UP' }, '', { text: 'Chỉ dùng cho việc tuyển dụng', newCode: 'w1234' }).state;
  s = locks.setWarning(s, { type: 'chrome', dir: 'Profile 2' }, '', { text: 'Tài khoản seeding chính, không đổi avatar', newCode: 'w5678' }).state;
  s.counter = 5;
  const doc = locks.sealDoc(s, crypto.randomBytes(32));
  const primary = path.join(path.dirname(fx.configPath), 'locks.json');
  fs.writeFileSync(primary, JSON.stringify(doc), 'utf8');
  fs.mkdirSync(path.dirname(fx.env.UPM_LOCKS_MIRROR), { recursive: true });
  fs.writeFileSync(fx.env.UPM_LOCKS_MIRROR, JSON.stringify(doc), 'utf8');
  fx.env.UPM_LOCK_SEAL = locks.sealString(doc);
  return { primary, doc };
}
// Giả lập người sửa file khóa: xóa hết khóa trong locks.json (dấu niêm phong không đổi)
function tamperLocks(fx) {
  const primary = path.join(path.dirname(fx.configPath), 'locks.json');
  const doc = JSON.parse(fs.readFileSync(primary, 'utf8'));
  doc.state.chromeLocks = {}; doc.state.groupLocks = {};
  doc.mac = 'GIA' + doc.mac.slice(3);
  fs.writeFileSync(primary, JSON.stringify(doc), 'utf8');
  fs.writeFileSync(fx.env.UPM_LOCKS_MIRROR, JSON.stringify(doc), 'utf8');
}
module.exports = { makeFixture, writeLocks, tamperLocks, CEO };
