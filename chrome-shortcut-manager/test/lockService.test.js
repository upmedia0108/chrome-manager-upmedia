// Test dịch vụ khóa của app (src/lockService.js) — v1.11. Chạy: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/locks');
const { createLockService, GRACE_MS } = require('../src/lockService');

const CEO = 'UpMedia@2026';

function makeEnv(profiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-svc-'));
  const mem = { key: null, seal: null };
  const store = L.createLockStore({
    primaryPath: path.join(dir, 'locks.json'), mirrorPath: path.join(dir, 'm', 'locks-backup.json'),
    keyStore: { load: () => mem.key, save: k => { mem.key = k; } },
    sealStore: { read: () => mem.seal, write: v => { mem.seal = v; } },
  });
  const config = { profiles: JSON.parse(JSON.stringify(profiles || {})) };
  const configStore = {
    getConfig: () => JSON.parse(JSON.stringify(config)),
    saveProfileConfig: (d, data) => { config.profiles[d] = { ...(config.profiles[d] || {}), ...data }; return true; },
  };
  const clock = { t: 1_000_000 };
  const world = { loaded: new Set(), windows: { ok: true, windows: [] } };
  const deleted = [];
  const svc = createLockService({
    store, configStore, getUserDataPath: () => 'UD',
    getLoadedDirs: () => new Set(world.loaded), listWindows: async () => world.windows,
    deleteShortcutsForDir: d => deleted.push(d), displayName: d => (config.profiles[d] || {}).shortcutName || d,
    now: () => clock.t, autoTimer: false,
  });
  svc.reload();
  return { svc, config, clock, world, deleted, mem, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('khóa nhóm lấy thành viên theo config; ẩn ghi chú/email khi chưa mở khóa; xóa shortcut', () => {
  const e = makeEnv({ 'Profile 1': { shortcutName: 'Hường', groups: ['Social'], notes: 'bí mật' }, 'Profile 2': { groups: ['Social'] }, 'Profile 3': { groups: ['Digital'] } });
  try {
    assert.ok(e.svc.setup(CEO).success);
    const g = e.svc.lockGroup(CEO, 'Social');
    assert.ok(g.success);
    assert.deepStrictEqual(g.members.sort(), ['Profile 1', 'Profile 2']);
    assert.match(g.message, new RegExp(g.pin));
    assert.match(g.message, /Hường/);
    assert.deepStrictEqual(e.deleted.sort(), ['Profile 1', 'Profile 2']);
    const red = e.svc.redactProfile({ profileDirectory: 'Profile 1', notes: 'bí mật', googleAccounts: [{ email: 'a@b.c' }], email: 'a@b.c' });
    assert.strictEqual(red.notes, ''); assert.deepStrictEqual(red.googleAccounts, []); assert.strictEqual(red.email, null);
    assert.deepStrictEqual(red.lock, { type: 'group', group: 'Social' });
    assert.strictEqual(e.svc.redactProfile({ profileDirectory: 'Profile 3', notes: 'x' }).notes, 'x');
    assert.ok(e.svc.isBlocked('Profile 1'));
    assert.ok(e.svc.unlock('Profile 1', g.pin).success);
    assert.ok(!e.svc.isBlocked('Profile 1'));
    assert.strictEqual(e.svc.redactProfile({ profileDirectory: 'Profile 1', notes: 'bí mật' }).notes, 'bí mật');
    assert.ok(e.svc.isBlocked('Profile 2'));                                   // mở khóa từng Chrome, không mở cả nhóm
  } finally { e.cleanup(); }
});

test('nhập sai 5 lần → chặn 5 phút (kể cả mã đúng); hết hạn thì mở được', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] } });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    for (let i = 0; i < 5; i++) assert.strictEqual(e.svc.unlock('Profile 1', '000000').code, 'BAD_CODE');
    assert.strictEqual(e.svc.unlock('Profile 1', g.pin).code, 'TOO_MANY');
    e.clock.t += 5 * 60 * 1000 + 1;
    assert.ok(e.svc.unlock('Profile 1', g.pin).success);
  } finally { e.cleanup(); }
});

test('thêm / gỡ Chrome khỏi nhóm khóa đồng bộ luôn config.json', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] }, 'Profile 4': { groups: [] } });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    assert.strictEqual(e.svc.addMember('sai', 'Social', 'Profile 4').code, 'BAD_CODE');
    assert.ok(e.svc.addMember(g.pin, 'Social', 'Profile 4').success);
    assert.deepStrictEqual(e.config.profiles['Profile 4'].groups, ['Social']);
    assert.ok(e.svc.isBlocked('Profile 4'));
    assert.ok(e.svc.removeMember(g.pin, 'Social', 'Profile 4').success);
    assert.deepStrictEqual(e.config.profiles['Profile 4'].groups, []);
    assert.ok(!e.svc.isLocked('Profile 4'));
  } finally { e.cleanup(); }
});

test('mở khóa đến khi tắt Chrome: còn cửa sổ → giữ; đóng cửa sổ 2 nhịp → khóa lại (kể cả Chrome còn chạy ngầm giữ file)', async () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] } });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    e.svc.unlock('Profile 1', g.pin);
    e.world.loaded = new Set(); e.world.windows = { ok: true, windows: [] };
    e.clock.t += 10_000; await e.svc.tick();
    assert.ok(e.svc.isUnlocked('Profile 1'), 'chưa hết thời gian chờ khởi động');
    e.clock.t += GRACE_MS; e.world.windows = { ok: true, windows: [{ dir: 'Profile 1' }] }; await e.svc.tick(); await e.svc.tick();
    assert.ok(e.svc.isUnlocked('Profile 1'), 'còn cửa sổ = đang mở');
    e.world.loaded = new Set(['profile 1']); e.world.windows = { ok: true, windows: [] };
    e.clock.t += 20_000; await e.svc.tick(); e.clock.t += 20_000; await e.svc.tick();
    assert.ok(!e.svc.isUnlocked('Profile 1'), 'chạy ngầm (giữ file, không cửa sổ) → coi như đã tắt, khóa lại');
    e.svc.unlock('Profile 1', g.pin); e.clock.t += GRACE_MS + 1;
    e.world.loaded = new Set(['profile 1']); e.world.windows = { ok: false, windows: [] };
    e.clock.t += 20_000; await e.svc.tick(); e.clock.t += 20_000; await e.svc.tick();
    assert.ok(e.svc.isUnlocked('Profile 1'), 'không đọc được cửa sổ → dựa vào khóa file');
    e.world.loaded = new Set(); e.world.windows = { ok: true, windows: [{ dir: 'Profile 1' }] };
    e.clock.t += 20_000; await e.svc.tick(); e.clock.t += 20_000; await e.svc.tick();
    assert.ok(e.svc.isUnlocked('Profile 1'), 'còn cửa sổ = đang mở (Chrome vừa mở chưa khóa file)');
    e.world.windows = { ok: true, windows: [] };
    e.clock.t += 20_000; await e.svc.tick();
    assert.ok(e.svc.isUnlocked('Profile 1'), 'mới thấy đóng 1 lần');
    e.clock.t += 20_000; await e.svc.tick();
    assert.ok(!e.svc.isUnlocked('Profile 1'), 'đóng 2 nhịp liên tiếp → khóa lại');
    assert.ok(e.svc.isBlocked('Profile 1'));
  } finally { e.cleanup(); }
});

test('phát hiện sửa file → khóa toàn bộ: mọi thao tác bị chặn, chỉ mã CEO mở / khôi phục', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] }, 'Profile 9': {} });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    e.mem.key = null;                                                    // mất khóa niêm phong
    e.svc.reload();
    assert.strictEqual(e.svc.status().failClosed, true);
    assert.ok(e.svc.isBlocked('Profile 9'));                             // Chrome chưa từng khóa cũng bị khóa
    assert.strictEqual(e.svc.unlock('Profile 1', g.pin).code, 'BAD_CODE');
    assert.strictEqual(e.svc.lockChrome(CEO, 'Profile 9').code, 'FAIL_CLOSED');
    assert.ok(e.svc.unlock('Profile 9', CEO).success);                   // mã CEO mở từng Chrome được
    assert.ok(e.svc.recover(CEO).success);
    assert.strictEqual(e.svc.status().failClosed, false);
    assert.ok(!e.svc.isLocked('Profile 9'));
    assert.ok(e.svc.isBlocked('Profile 1'));                             // khóa cũ vẫn còn
  } finally { e.cleanup(); }
});

test('đổi tên / xóa nhóm khóa: cần mã nhóm / mã CEO; cảnh báo đi theo; status không lộ mã băm', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] } });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    assert.ok(e.svc.setWarning({ type: 'group', group: 'Social' }, g.pin, { text: 'Không đăng bài cá nhân' }).success);
    assert.strictEqual(e.svc.renameGroup('sai', 'Social', 'Social FB').code, 'BAD_CODE');
    assert.ok(e.svc.renameGroup(g.pin, 'Social', 'Social FB').success);
    assert.deepStrictEqual(e.svc.lockOf('Profile 1'), { type: 'group', group: 'Social FB' });
    assert.strictEqual(e.svc.warningsFor(['Profile 1'])['Profile 1'][0].text, 'Không đăng bài cá nhân');
    assert.strictEqual(e.svc.deleteGroups(g.pin, ['Social FB']).code, 'BAD_CODE');
    assert.ok(e.svc.deleteGroups(CEO, ['Social FB']).success);
    assert.ok(!e.svc.isLocked('Profile 1'));
    assert.ok(e.svc.renameGroup('', 'Nhom thuong', 'Nhom khac').success);   // nhóm thường: không cần mã
    assert.ok(!/hash|salt/.test(JSON.stringify(e.svc.status())));
  } finally { e.cleanup(); }
});

// ── Các lỗ do kiểm tra độc lập tìm ra (19/11/2026) ──
test('đọc dữ liệu khóa lỗi bất ngờ → khóa toàn bộ, không coi như chưa bật', () => {
  const e = makeEnv({ 'Profile 1': {} });
  try {
    e.svc.setup(CEO);
    const realLoad = e.store.load;
    e.store.load = () => { throw new Error('EPERM'); };
    e.svc.reload();
    assert.strictEqual(e.svc.status().failClosed, true);
    assert.ok(e.svc.isBlocked('Profile 1'));
    e.store.load = realLoad;
    assert.ok(e.svc.recover(CEO).success);                               // đọc lại được → hết khóa toàn bộ
    assert.strictEqual(e.svc.status().failClosed, false);
  } finally { e.cleanup(); }
});

test('chặn đoán mã: chưa nhập mã khi xóa nhóm khóa không tính là sai; sai tổng 15 lần ở nhiều mục → chặn mọi lần nhập mã', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] }, 'Profile 2': { groups: ['Ads'] }, 'Profile 3': { groups: ['BM'] }, 'Profile 4': {} });
  try {
    e.svc.setup(CEO);
    for (const g of ['Social', 'Ads', 'BM']) e.svc.lockGroup(CEO, g);
    e.svc.lockChrome(CEO, 'Profile 4');
    for (let i = 0; i < 10; i++) assert.strictEqual(e.svc.deleteGroups('', ['Social']).code, 'NEED_CODE');
    assert.ok(e.svc.events(CEO).success, 'mã CEO vẫn dùng được');
    for (const d of ['Profile 1', 'Profile 2', 'Profile 3']) for (let i = 0; i < 4; i++) e.svc.unlock(d, '000000');
    for (let i = 0; i < 3; i++) e.svc.unlock('Profile 4', '000000');
    assert.strictEqual(e.svc.unlock('Profile 4', CEO).code, 'TOO_MANY', '15 lần sai ở nhiều mục → chặn tất cả');
    e.clock.t += 5 * 60 * 1000 + 1;
    assert.ok(e.svc.unlock('Profile 4', CEO).success);
  } finally { e.cleanup(); }
});

test('đổi tên nhóm không gộp được vào nhóm đang có khi một bên khóa / có cảnh báo', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] }, 'Profile 2': { groups: ['Ads'] } });
  e.config.groups = ['Social', 'Ads', 'Khác'];
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    assert.strictEqual(e.svc.renameGroup(g.pin, 'Social', 'Ads').code, 'ALREADY');      // nhóm khóa gộp vào nhóm thường
    assert.strictEqual(e.svc.renameGroup('', 'Ads', 'Social').code, 'ALREADY');         // nhóm thường gộp vào nhóm khóa
    assert.ok(e.svc.renameGroup('', 'Ads', 'Khác').success);                            // 2 nhóm thường: như cũ
  } finally { e.cleanup(); }
});

test('mất khóa bí mật + mất dấu niêm phong → chỉ "đặt lại từ đầu"; thêm Chrome vào nhóm khóa thì phải nhập mã lại', () => {
  const e = makeEnv({ 'Profile 1': { groups: ['Social'] }, 'Profile 5': {} });
  try {
    e.svc.setup(CEO);
    const g = e.svc.lockGroup(CEO, 'Social');
    assert.ok(e.svc.unlock('Profile 5', CEO).success === true);                          // Chrome chưa khóa: mở tự do
    e.svc.lockChrome(CEO, 'Profile 5'); assert.ok(e.svc.unlock('Profile 5', CEO).success);
    e.svc.removeLock(CEO, { type: 'chrome', dir: 'Profile 5' });
    assert.ok(e.svc.addMember(g.pin, 'Social', 'Profile 5').success);
    assert.ok(e.svc.isBlocked('Profile 5'), 'vào nhóm khóa thì không giữ trạng thái mở khóa cũ');
    assert.strictEqual(e.svc.reset('MaCEOmoi-2026').code, 'NOT_ALLOWED');
    e.mem.key = null; e.mem.seal = null;
    e.svc.reload();
    const st = e.svc.status();
    assert.ok(st.failClosed && st.canReset);
    const r = e.svc.reset('MaCEOmoi-2026');
    assert.ok(r.success && r.recoveryKey);
    assert.strictEqual(e.svc.status().failClosed, false);
    assert.ok(!e.svc.isLocked('Profile 1'));
  } finally { e.cleanup(); }
});
