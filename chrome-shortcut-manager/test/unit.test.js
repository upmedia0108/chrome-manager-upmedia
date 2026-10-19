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
