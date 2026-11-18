// Bộ test khởi đầu — chỉ kiểm thử các HÀM LOGIC THUẦN (không phụ thuộc Windows/Electron/Chrome).
// Chạy: npm test   (dùng node:test có sẵn, không cần thư viện ngoài)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── src/utils.js ──────────────────────────────────────────
const { sanitizeFileName } = require('../src/utils');

test('sanitizeFileName: thay ký tự cấm của Windows bằng _', () => {
  assert.strictEqual(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});
test('sanitizeFileName: giữ nguyên tên hợp lệ (có dấu tiếng Việt) + trim', () => {
  assert.strictEqual(sanitizeFileName('  Seeding Facebook 01  '), 'Seeding Facebook 01');
  assert.strictEqual(sanitizeFileName('Khách hàng - Thiên Phú'), 'Khách hàng - Thiên Phú');
});

// ── src/storage.js — formatBytes ──────────────────────────
const { formatBytes } = require('../src/storage');

test('formatBytes: đổi đơn vị đúng ngưỡng', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
  assert.strictEqual(formatBytes(1024 * 1024 * 1024), '1.00 GB');
});

// ── src/configStore.js — load & migration ────────────────
const configStore = require('../src/configStore');

function withTempConfig(configObj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-cfg-'));
  try {
    if (configObj !== undefined) {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configObj), 'utf8');
    }
    configStore.init(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('configStore.load: file trống → trả groups mặc định', () => {
  withTempConfig(undefined, () => {
    const cfg = configStore.load();
    assert.ok(Array.isArray(cfg.groups) && cfg.groups.length > 0);
    assert.deepStrictEqual(cfg.profiles, {});
  });
});

test('configStore.load: migrate profile.group (string) → groups (array)', () => {
  withTempConfig({ profiles: { 'Profile 1': { group: 'Seeding' } } }, () => {
    const p = configStore.load().profiles['Profile 1'];
    assert.deepStrictEqual(p.groups, ['Seeding']);
    assert.strictEqual(p.group, undefined);
    assert.strictEqual(p.notes, '');
    assert.deepStrictEqual(p.subGroups, {});
  });
});

test('configStore.load: migrate subGroups value string → array', () => {
  withTempConfig({ profiles: { 'Profile 2': { groups: ['Ads'], subGroups: { Ads: 'Meta' } } } }, () => {
    const p = configStore.load().profiles['Profile 2'];
    assert.deepStrictEqual(p.subGroups.Ads, ['Meta']);
  });
});

test('configStore: saveProfileConfig rồi đọc lại giữ đúng dữ liệu', () => {
  withTempConfig({}, () => {
    configStore.saveProfileConfig('Profile 3', { shortcutName: 'Test 3', notes: 'ghi chú' });
    const p = configStore.load().profiles['Profile 3'];
    assert.strictEqual(p.shortcutName, 'Test 3');
    assert.strictEqual(p.notes, 'ghi chú');
  });
});

test('configStore: lưu & đọc lại trạng thái ghim (pinned)', () => {
  withTempConfig({}, () => {
    configStore.saveProfileConfig('Profile 9', { pinned: true });
    assert.strictEqual(configStore.load().profiles['Profile 9'].pinned, true);
  });
});

// ── src/chromeProfiles.js — computeMissingProfiles (mục 4) ─
const { computeMissingProfiles } = require('../src/chromeProfiles');

test('computeMissingProfiles: không thiếu khi mọi profile đều quét được', () => {
  const machine = [{ profileDirectory: 'Default', name: 'Sếp' }, { profileDirectory: 'Profile 1', name: 'Seeding' }];
  const found = new Set(['Default', 'Profile 1']);
  const missing = computeMissingProfiles(machine, found, 'C:\\x', () => true);
  assert.strictEqual(missing.length, 0);
});

const { setNameInLocalStateObj } = require('../src/chromeProfiles');

test('setNameInLocalStateObj: ghi đúng tên hiển thị Chrome', () => {
  const ls = { profile: { info_cache: { 'Profile 1': { name: 'Person 1', is_using_default_name: true } } } };
  const ok = setNameInLocalStateObj(ls, 'Profile 1', '  T93 - FB Seeding  ');
  assert.strictEqual(ok, true);
  const e = ls.profile.info_cache['Profile 1'];
  assert.strictEqual(e.name, 'T93 - FB Seeding');
  assert.strictEqual(e.shortcut_name, 'T93 - FB Seeding');
  assert.strictEqual(e.is_using_default_name, false);
});

test('setNameInLocalStateObj: tạo entry nếu chưa có, bỏ qua tên rỗng', () => {
  const ls = { profile: {} };
  assert.strictEqual(setNameInLocalStateObj(ls, 'Profile 5', 'Ads Sun'), true);
  assert.strictEqual(ls.profile.info_cache['Profile 5'].name, 'Ads Sun');
  assert.strictEqual(setNameInLocalStateObj(ls, 'Profile 6', '   '), false);
  assert.strictEqual(ls.profile.info_cache['Profile 6'], undefined);
});

const { removeProfilesFromLocalState } = require('../src/chromeProfiles');

test('removeProfilesFromLocalState: xóa đúng profile ma khỏi Local State', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-ls-'));
  try {
    const ls = {
      profile: {
        info_cache: { 'Default': { name: 'Sếp' }, 'Profile 1': { name: 'Seeding' }, 'Profile 2': { name: 'Ma' } },
        profiles_order: ['Default', 'Profile 1', 'Profile 2'],
        last_active_profiles: ['Profile 2'],
      },
    };
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify(ls), 'utf8');
    const res = removeProfilesFromLocalState(dir, ['Profile 2']);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.removed, 1);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    assert.strictEqual(after.profile.info_cache['Profile 2'], undefined);
    assert.ok(after.profile.info_cache['Default']);
    assert.deepStrictEqual(after.profile.profiles_order, ['Default', 'Profile 1']);
    assert.deepStrictEqual(after.profile.last_active_profiles, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeMissingProfiles: báo thiếu + đúng lý do', () => {
  const machine = [
    { profileDirectory: 'Default', name: 'Sếp' },
    { profileDirectory: 'Profile 1', name: 'Seeding' },   // còn thư mục, chưa đọc được
    { profileDirectory: 'Profile 2', name: 'Ads' },        // thư mục không còn
  ];
  const found = new Set(['Default']);
  const exists = dir => dir === 'Profile 1'; // Profile 1 còn, Profile 2 mất
  const missing = computeMissingProfiles(machine, found, 'C:\\x', exists);
  assert.strictEqual(missing.length, 2);
  const p1 = missing.find(m => m.profileDirectory === 'Profile 1');
  const p2 = missing.find(m => m.profileDirectory === 'Profile 2');
  assert.match(p1.reason, /chưa đọc được/);
  assert.match(p2.reason, /không còn/);
});

// ── renderer/nameRules.js — bộ lọc "Chưa đặt tên" ────────
const { isUnnamedProfile, looksLikeDefaultName } = require('../renderer/nameRules');

test('isUnnamedProfile: lỗi Profile 14 — tên shortcut trùng tên Chrome là tên thật → ĐÃ đặt tên', () => {
  const p = { profileDirectory: 'Profile 14', chromeProfileName: 'Đinh Thị Thanh', shortcutName: 'Đinh Thị Thanh', chromeUsingDefaultName: false };
  assert.strictEqual(isUnnamedProfile(p), false);
  // Không đọc được cờ của Chrome (profile thiếu trong Local State) vẫn tính là đã đặt
  assert.strictEqual(isUnnamedProfile({ ...p, chromeUsingDefaultName: null }), false);
  assert.strictEqual(isUnnamedProfile({ ...p, chromeUsingDefaultName: undefined }), false);
});

test('isUnnamedProfile: trống / trùng tên thư mục → chưa đặt', () => {
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 3', chromeProfileName: 'Profile 3', shortcutName: '' }), true);
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 3', chromeProfileName: 'Profile 3', shortcutName: '   ' }), true);
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 3', chromeProfileName: 'X', shortcutName: 'Profile 3' }), true);
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Default', chromeProfileName: 'Default', shortcutName: 'Default' }), true);
  assert.strictEqual(isUnnamedProfile(null), true);
});

test('isUnnamedProfile: tên mặc định Chrome tự sinh → chưa đặt', () => {
  for (const n of ['Person 1', 'Người dùng 2', 'Người 5', 'Hồ sơ 3', 'Your Chrome', 'Chrome của bạn', 'User 7']) {
    assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 9', chromeProfileName: n, shortcutName: n }), true, n);
  }
});

test('isUnnamedProfile: Chrome đánh dấu đang dùng tên mặc định → chưa đặt, trừ khi trùng tên tài khoản Google', () => {
  const base = { profileDirectory: 'Profile 2', chromeProfileName: 'Cú mèo', shortcutName: 'Cú mèo', chromeUsingDefaultName: true };
  assert.strictEqual(isUnnamedProfile(base), true);
  assert.strictEqual(isUnnamedProfile({ ...base, chromeProfileName: 'Lan Anh', shortcutName: 'Lan Anh', chromeGaiaNames: ['Lan Anh'] }), false);
});

test('isUnnamedProfile: tên tự đặt khác tên Chrome → đã đặt (kể cả Chrome dùng tên mặc định)', () => {
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 5', chromeProfileName: 'Person 5', shortcutName: 'Ads Queen Spa', chromeUsingDefaultName: true }), false);
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 6', chromeProfileName: 'Profile 6', shortcutName: 'Seeding FB 01' }), false);
});

test('isUnnamedProfile: không phân biệt dạng gõ tiếng Việt (NFC/NFD) và khoảng trắng thừa', () => {
  const nfd = 'Đinh Thị Thanh'.normalize('NFD');
  assert.strictEqual(isUnnamedProfile({ profileDirectory: 'Profile 14', chromeProfileName: 'Đinh Thị Thanh', shortcutName: ' ' + nfd + ' ', chromeUsingDefaultName: true, chromeGaiaNames: ['Đinh  Thị Thanh'] }), false);
  assert.strictEqual(looksLikeDefaultName('Người  dùng 1'.normalize('NFD')), true);
  assert.strictEqual(looksLikeDefaultName('Người mua hàng'), false);
});

test('scanProfiles: đọc cờ tên mặc định + tên Google từ Local State/Preferences cho bộ lọc "Chưa đặt tên"', () => {
  const { scanProfiles } = require('../src/chromeProfiles');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: {
      'Profile 14': { name: 'Đinh Thị Thanh', is_using_default_name: false },
      'Profile 2':  { name: 'Person 2', is_using_default_name: true, gaia_name: 'Lan Anh Nguyễn', gaia_given_name: 'Lan Anh' },
    } } }), 'utf8');
    fs.mkdirSync(path.join(dir, 'Profile 14'));
    fs.writeFileSync(path.join(dir, 'Profile 14', 'Preferences'), JSON.stringify({ profile: { name: 'Đinh Thị Thanh', using_default_name: false } }), 'utf8');
    fs.mkdirSync(path.join(dir, 'Profile 2')); // thiếu Preferences → lấy từ Local State
    fs.mkdirSync(path.join(dir, 'Profile 7'));
    fs.writeFileSync(path.join(dir, 'Profile 7', 'Preferences'), JSON.stringify({ profile: { name: 'Người dùng 7', using_default_name: true } }), 'utf8');

    const { profiles } = scanProfiles(dir);
    const by = Object.fromEntries(profiles.map(p => [p.profileDirectory, p]));
    assert.strictEqual(by['Profile 14'].chromeUsingDefaultName, false);
    assert.strictEqual(by['Profile 2'].chromeUsingDefaultName, true);
    assert.deepStrictEqual(by['Profile 2'].chromeGaiaNames, ['Lan Anh Nguyễn', 'Lan Anh']);
    assert.strictEqual(by['Profile 7'].chromeUsingDefaultName, true); // dự phòng từ Preferences

    // Giống main.js: tên shortcut tự điền = tên Chrome khi chưa đặt trong app
    const asApp = p => ({ ...p, shortcutName: p.chromeProfileName });
    assert.strictEqual(isUnnamedProfile(asApp(by['Profile 14'])), false);
    assert.strictEqual(isUnnamedProfile(asApp(by['Profile 2'])), true);
    assert.strictEqual(isUnnamedProfile(asApp(by['Profile 7'])), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
