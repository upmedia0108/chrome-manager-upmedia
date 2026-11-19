// Test lõi khóa Chrome (src/locks.js) — v1.11. Chạy: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/locks');

const CEO = 'UpMedia@2026';
function setup() { return L.setupCeo(L.emptyState(), CEO); }
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code, `cần lỗi ${code}`);

test('mã CEO: chặn mã yếu, đặt được, sinh mã khẩn cấp; chỉ lưu dạng băm', () => {
  throwsCode(() => L.setupCeo(L.emptyState(), '1234567'), 'WEAK_CEO');
  throwsCode(() => L.setupCeo(L.emptyState(), '11111111'), 'WEAK_CEO');
  const { state, recoveryKey } = setup();
  assert.match(recoveryKey, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.ok(L.isCeo(state, CEO));
  assert.ok(!L.isCeo(state, 'sai-ma-123'));
  assert.ok(!JSON.stringify(state).includes(CEO));
  throwsCode(() => L.setupCeo(state, 'KhacNua#99'), 'ALREADY');
});

test('đổi mã CEO bằng mã cũ hoặc mã khẩn cấp (dùng khẩn cấp thì cấp mã khẩn cấp mới)', () => {
  const { state, recoveryKey } = setup();
  const a = L.changeCeo(state, CEO, 'MoiMoi#2027');
  assert.ok(L.isCeo(a.state, 'MoiMoi#2027') && !L.isCeo(a.state, CEO));
  assert.strictEqual(a.recoveryKey, null);
  const b = L.changeCeo(state, recoveryKey.toLowerCase().replace(/-/g, ' '), 'QuenMa#2027');   // gõ thường, khoảng trắng vẫn nhận
  assert.ok(L.isCeo(b.state, 'QuenMa#2027'));
  assert.ok(b.recoveryKey && b.recoveryKey !== recoveryKey);
  throwsCode(() => L.changeCeo(b.state, recoveryKey, 'LanNua#2028'), 'BAD_CODE');            // mã khẩn cấp cũ hết hiệu lực
  throwsCode(() => L.changeCeo(state, 'sai', 'LanNua#2028'), 'BAD_CODE');
});

test('khóa riêng 1 Chrome: cần mã CEO, sinh mã 6 số; mở bằng mã đó hoặc mã CEO', () => {
  let s = setup().state;
  throwsCode(() => L.lockChrome(s, 'sai', 'Profile 14'), 'BAD_CODE');
  const r = L.lockChrome(s, CEO, 'Profile 14'); s = r.state;
  assert.match(r.pin, /^\d{6}$/);
  assert.deepStrictEqual(L.lockOf(s, 'Profile 14'), { type: 'chrome' });
  assert.strictEqual(L.checkOpenCode(s, 'Profile 14', r.pin), 'pin');
  assert.strictEqual(L.checkOpenCode(s, 'Profile 14', CEO), 'ceo');
  assert.strictEqual(L.checkOpenCode(s, 'Profile 14', '000000'), null);
  assert.strictEqual(L.checkOpenCode(s, 'Profile 2', ''), 'free');
  assert.strictEqual(L.lockOf(s, 'Profile 1'), null);                                       // "Profile 1" không dính "Profile 14"
  throwsCode(() => L.lockChrome(s, CEO, 'Profile 14'), 'ONE_LAYER');
});

test('khóa nhóm + quy tắc 1 lớp khóa', () => {
  let s = setup().state;
  s = L.lockChrome(s, CEO, 'Profile 9', '4321').state;
  throwsCode(() => L.lockGroup(s, CEO, 'Social', ['Profile 1', 'Profile 9']), 'ONE_LAYER');   // Profile 9 đang khóa riêng
  const g = L.lockGroup(s, CEO, 'Social', ['Profile 1', 'Profile 2']); s = g.state;
  assert.deepStrictEqual(L.lockOf(s, 'Profile 2'), { type: 'group', group: 'Social' });
  assert.strictEqual(L.checkOpenCode(s, 'Profile 1', g.pin), 'pin');
  assert.strictEqual(L.checkOpenCode(s, 'Profile 1', '4321'), null);                        // mã Chrome khác không mở được
  throwsCode(() => L.lockChrome(s, CEO, 'Profile 1'), 'ONE_LAYER');                         // đang thuộc nhóm khóa
  s = L.lockGroup(s, CEO, 'Digital', ['Profile 5'], '5555').state;
  throwsCode(() => L.addMember(s, g.pin, 'Social', 'Profile 5'), 'ONE_LAYER');              // thuộc nhóm khóa khác
  throwsCode(() => L.addMember(s, g.pin, 'Social', 'Profile 9'), 'ONE_LAYER');              // đang khóa riêng
  throwsCode(() => L.addMember(s, '5555', 'Social', 'Profile 7'), 'BAD_CODE');              // mã nhóm khác
  s = L.addMember(s, g.pin, 'Social', 'Profile 7').state;                                   // Chrome chưa khóa → vào nhóm của mình
  assert.deepStrictEqual(L.lockOf(s, 'Profile 7'), { type: 'group', group: 'Social' });
  s = L.removeMember(s, g.pin, 'Social', 'Profile 7').state;
  assert.strictEqual(L.lockOf(s, 'Profile 7'), null);
  throwsCode(() => L.lockGroup(s, CEO, 'Social', []), 'ALREADY');
});

test('gỡ khóa, xóa nhóm khóa chỉ mã CEO; cấp lại mã; đổi tên nhóm khóa cần mã nhóm', () => {
  let s = setup().state;
  const g = L.lockGroup(s, CEO, 'Social', ['Profile 1']); s = g.state;
  throwsCode(() => L.removeLock(s, g.pin, { type: 'group', group: 'Social' }), 'BAD_CODE');
  throwsCode(() => L.deleteGroup(s, g.pin, 'Social'), 'BAD_CODE');
  const r = L.resetPin(s, CEO, { type: 'group', group: 'Social' }, '246810'); s = r.state;
  assert.strictEqual(L.checkOpenCode(s, 'Profile 1', g.pin), null);
  assert.strictEqual(L.checkOpenCode(s, 'Profile 1', '246810'), 'pin');
  throwsCode(() => L.renameGroup(s, 'sai', 'Social', 'Social 2'), 'BAD_CODE');
  s = L.renameGroup(s, '246810', 'Social', 'Social 2').state;
  assert.deepStrictEqual(L.lockOf(s, 'Profile 1'), { type: 'group', group: 'Social 2' });
  s = L.removeLock(s, CEO, { type: 'group', group: 'Social 2' }).state;
  assert.strictEqual(L.lockOf(s, 'Profile 1'), null);
  s = L.deleteGroup(s, '', 'Khong khoa').state;                                             // nhóm không khóa: xóa tự do
});

test('cảnh báo: nhân sự tự cài (mục chưa khóa phải đặt mã cảnh báo); sửa cần mã cảnh báo / mã khóa / mã CEO', () => {
  let s = setup().state;
  const tC = { type: 'chrome', dir: 'Profile 3' };
  throwsCode(() => L.setWarning(s, tC, '', { text: 'Chỉ dùng cho Ads' }), 'NEED_CODE');
  s = L.setWarning(s, tC, '', { text: 'Chỉ dùng cho Ads', newCode: '7788' }).state;
  throwsCode(() => L.setWarning(s, tC, '', { text: 'đổi bậy', enabled: false }), 'BAD_CODE');
  throwsCode(() => L.setWarning(s, tC, '0000', { enabled: false, text: 'x' }), 'BAD_CODE');
  s = L.setWarning(s, tC, '7788', { text: 'Chỉ dùng cho Ads Queen Spa', enabled: true }).state;
  s = L.setWarning(s, tC, CEO, { text: 'Chỉ dùng cho Ads Queen Spa', enabled: true, newCode: '9999' }).state;   // CEO đặt lại mã cảnh báo
  throwsCode(() => L.setWarning(s, tC, '7788', { text: 'x' }), 'BAD_CODE');
  // Nhóm đang khóa: chủ nhóm dùng mã nhóm cài cảnh báo, không cần mã cảnh báo riêng
  const g = L.lockGroup(s, CEO, 'Social', ['Profile 3']); s = g.state;
  s = L.setWarning(s, { type: 'group', group: 'Social' }, g.pin, { text: 'Nhóm FB khách — không đăng bài cá nhân' }).state;
  const w = L.warningsFor(s, 'Profile 3', []);
  assert.deepStrictEqual(w.map(x => x.source), ['group', 'chrome']);
  assert.match(w[0].text, /không đăng bài cá nhân/);
  // Nhóm theo config (không khóa) cũng áp cảnh báo; cảnh báo tắt thì không hiện
  s = L.setWarning(s, { type: 'group', group: 'Digital' }, '', { text: 'Digital nè', newCode: '1357' }).state;
  assert.strictEqual(L.warningsFor(s, 'Profile 8', ['Digital']).length, 1);
  s = L.setWarning(s, { type: 'group', group: 'Digital' }, '1357', { text: 'Digital nè', enabled: false }).state;
  assert.strictEqual(L.warningsFor(s, 'Profile 8', ['Digital']).length, 0);
  // Xóa cảnh báo
  s = L.setWarning(s, tC, '9999', { text: '', enabled: false }).state;
  assert.deepStrictEqual(L.warningsFor(s, 'Profile 3', []).map(x => x.source), ['group']);
});

test('publicView không lộ mã băm; tin nhắn Fiine có mã và cách dùng', () => {
  let s = setup().state;
  s = L.lockGroup(s, CEO, 'Social', ['Profile 1'], '135790').state;
  s = L.setWarning(s, { type: 'chrome', dir: 'Profile 2' }, '', { text: 'Cẩn thận', newCode: '2468' }).state;
  const v = L.publicView(s);
  const txt = JSON.stringify(v);
  assert.ok(!/hash|salt/.test(txt));
  assert.deepStrictEqual(v.groupLocks, { Social: ['Profile 1'] });
  assert.strictEqual(v.warnings.chromes['Profile 2'].hasCode, true);
  const m = L.fiineMessage({ kind: 'group', name: 'Social', pin: '135790', chromeNames: ['A', 'B'] });
  assert.match(m, /135790/); assert.match(m, /Social/); assert.match(m, /Gồm 2 Chrome/);
});

// ── Kho niêm phong + phát hiện sửa file ──
function makeStore(dir, opts = {}) {
  const env = opts.env || { key: null, seal: null };
  const store = L.createLockStore({
    primaryPath: path.join(dir, 'locks.json'),
    mirrorPath: path.join(dir, 'mirror', 'locks-backup.json'),
    keyStore: { load: () => env.key, save: k => { env.key = k; } },
    sealStore: { read: () => env.seal, write: v => { env.seal = v; } },
  });
  return { store, env, primary: path.join(dir, 'locks.json'), mirror: path.join(dir, 'mirror', 'locks-backup.json') };
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'upm-lock-')); }

test('kho: chưa bật → rỗng; lưu → có 2 bản + dấu niêm phong; đọc lại đúng', () => {
  const d = tmp();
  try {
    const { store, env, primary, mirror } = makeStore(d);
    assert.strictEqual(store.load().status, 'empty');
    let s = setup().state;
    s = L.lockChrome(s, CEO, 'Profile 14', '112233').state;
    store.save(s);
    assert.ok(fs.existsSync(primary) && fs.existsSync(mirror) && env.key && env.seal);
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: sửa tay file chính để gỡ khóa → phát hiện, khôi phục từ bản dự phòng, ghi nhật ký', () => {
  const d = tmp();
  try {
    const { store, env, primary } = makeStore(d);
    store.save(L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state);
    const doc = JSON.parse(fs.readFileSync(primary, 'utf8'));
    delete doc.state.chromeLocks['Profile 14'];
    fs.writeFileSync(primary, JSON.stringify(doc));
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'restored');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
    assert.ok(r.state.events.some(e => e.type === 'tamper-restored'));
    assert.strictEqual(makeStore(d, { env }).store.load().status, 'ok');                   // đã ghi lại sạch
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: file chính hỏng / bị xóa → khôi phục; quay file chính về bản cũ → khôi phục', () => {
  const d = tmp();
  try {
    const { store, env, primary } = makeStore(d);
    const s1 = store.save(setup().state);
    const old = fs.readFileSync(primary, 'utf8');                                           // bản cũ CHƯA có khóa (chữ ký hợp lệ)
    store.save(L.lockChrome(s1, CEO, 'Profile 14', '112233').state);
    fs.writeFileSync(primary, '{hỏng');
    assert.strictEqual(makeStore(d, { env }).store.load().status, 'restored');
    fs.rmSync(primary);
    assert.strictEqual(makeStore(d, { env }).store.load().status, 'restored');
    fs.writeFileSync(primary, old);                                                         // quay về bản cũ để gỡ khóa
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'restored');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: sửa / xóa cả 2 file → khôi phục từ bản neo; mất khóa bí mật → KHÓA TOÀN BỘ tới khi nhập mã CEO / mã khẩn cấp', () => {
  const d = tmp();
  try {
    const { store, env, primary, mirror } = makeStore(d);
    store.save(L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state);
    for (const f of [primary, mirror]) {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8')); doc.state.chromeLocks = {}; fs.writeFileSync(f, JSON.stringify(doc));
    }
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'restored');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
    fs.rmSync(primary); fs.rmSync(mirror);
    const r2 = makeStore(d, { env }).store.load();
    assert.strictEqual(r2.status, 'restored');
    assert.deepStrictEqual(L.lockOf(r2.state, 'Profile 14'), { type: 'chrome' });
    assert.strictEqual(makeStore(d, { env }).store.load().status, 'ok');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }

  const d2 = tmp();
  try {
    const { store, env } = makeStore(d2);
    const { state, recoveryKey } = setup();
    store.save(L.lockChrome(state, CEO, 'Profile 14', '112233').state);
    env.key = null;                                                                         // mất khóa bí mật (file còn nguyên)
    const st = makeStore(d2, { env }).store;
    const r = st.load();
    assert.strictEqual(r.status, 'failclosed');
    assert.strictEqual(r.failClosedDirs, 'all');
    const ctx = { failClosed: true, failClosedDirs: 'all' };
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 1', ctx), { type: 'all' });           // Chrome chưa từng khóa cũng khóa
    assert.strictEqual(L.checkOpenCode(r.state, 'Profile 14', '112233', ctx), null);
    assert.strictEqual(L.checkOpenCode(r.state, 'Profile 14', CEO, ctx), 'ceo');
    assert.throws(() => st.recover(r, 'sai-ma-99'), e => e.code === 'BAD_CODE');
    st.recover(r, recoveryKey);                                                             // mã khẩn cấp cũng khôi phục được
    const r3 = makeStore(d2, { env }).store.load();
    assert.strictEqual(r3.status, 'ok');
    assert.deepStrictEqual(L.lockOf(r3.state, 'Profile 14'), { type: 'chrome' });           // khóa cũ còn nguyên
    assert.ok(r3.state.events.some(e => e.type === 'tamper-recovered'));
  } finally { fs.rmSync(d2, { recursive: true, force: true }); }
});

test('kho: chỉ mất dấu niêm phong (registry) → lặng lẽ ghi lại (mỏ neo giữ bộ đếm), không khóa toàn bộ', () => {
  const d = tmp();
  try {
    const { store, env } = makeStore(d);
    store.save(setup().state);
    env.seal = null;
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'ok');
    assert.ok(env.seal);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Các lỗ do kiểm tra độc lập tìm ra (19/11/2026) ──
test('kho: ghi lại lỗi lúc khôi phục KHÔNG làm mất khóa (không "mở toang")', () => {
  const d = tmp();
  try {
    const { store, env, primary } = makeStore(d);
    store.save(L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state);
    env.seal = null;
    fs.mkdirSync(primary + '.tmp');                                                         // chặn ghi file chính
    const r = makeStore(d, { env }).store.load();
    assert.notStrictEqual(r.status, 'empty');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
    assert.ok(L.isEnabled(r.state));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: sửa cả 2 file để cài mã CEO giả + gỡ khóa → khôi phục từ bản neo, mã giả vô dụng', () => {
  const d = tmp();
  try {
    const { store, env, primary, mirror } = makeStore(d);
    store.save(L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state);
    const fake = L.hashSecret('MaGiaCuaKe1');
    for (const f of [primary, mirror]) {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8')); doc.state.ceo = fake; doc.state.chromeLocks = {}; fs.writeFileSync(f, JSON.stringify(doc));
    }
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'restored');
    assert.deepStrictEqual(L.lockOf(r.state, 'Profile 14'), { type: 'chrome' });
    assert.ok(L.isCeo(r.state, CEO) && !L.isCeo(r.state, 'MaGiaCuaKe1'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: chép đè TẤT CẢ (2 file + bản neo) bằng bản cũ nhưng dấu niêm phong mới hơn → khóa toàn bộ; mã CEO khôi phục', () => {
  const d = tmp();
  try {
    const { store, env, primary, mirror } = makeStore(d);
    const s1 = store.save(L.lockGroup(setup().state, CEO, 'Social', ['Profile 2'], '111111').state);
    const old = { p: fs.readFileSync(primary, 'utf8'), m: fs.readFileSync(mirror, 'utf8'), k: env.key };
    store.save(L.resetPin(s1, CEO, { type: 'group', group: 'Social' }, '222222').state);
    fs.writeFileSync(primary, old.p); fs.writeFileSync(mirror, old.m); env.key = old.k;
    const st = makeStore(d, { env }).store;
    const r = st.load();
    assert.strictEqual(r.status, 'failclosed');
    assert.match(r.problem, /bản cũ/);
    assert.ok(!r.canReset);
    st.recover(r, CEO);
    assert.strictEqual(makeStore(d, { env }).store.load().status, 'ok');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: chép đè cả 2 file bằng bản cũ + xóa dấu niêm phong → khôi phục bản mới nhất từ bản neo', () => {
  const d = tmp();
  try {
    const { store, env, primary, mirror } = makeStore(d);
    const s1 = store.save(L.lockGroup(setup().state, CEO, 'Social', ['Profile 2'], '111111').state);
    const oldP = fs.readFileSync(primary, 'utf8'), oldM = fs.readFileSync(mirror, 'utf8');
    store.save(L.resetPin(s1, CEO, { type: 'group', group: 'Social' }, '222222').state);
    fs.writeFileSync(primary, oldP); fs.writeFileSync(mirror, oldM); env.seal = null;
    const r = makeStore(d, { env }).store.load();
    assert.strictEqual(r.status, 'restored');
    assert.strictEqual(L.checkOpenCode(r.state, 'Profile 2', '222222'), 'pin');
    assert.strictEqual(L.checkOpenCode(r.state, 'Profile 2', '111111'), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('kho: mất khóa bí mật + dữ liệu bị sửa → không ai khôi phục bằng mã trong file; chỉ "đặt lại từ đầu" (mất hết khóa, có nhật ký)', () => {
  const d = tmp();
  try {
    const { store, env, primary } = makeStore(d);
    store.save(L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state);
    const doc = JSON.parse(fs.readFileSync(primary, 'utf8')); doc.state.ceo = L.hashSecret('MaGiaCuaKe1'); fs.writeFileSync(primary, JSON.stringify(doc));
    env.key = null;
    const st = makeStore(d, { env }).store;
    const r = st.load();
    assert.strictEqual(r.status, 'failclosed');
    assert.strictEqual(r.canReset, true);
    assert.throws(() => st.recover(r, 'MaGiaCuaKe1'), e => e.code === 'NO_ANCHOR');
    assert.throws(() => st.reset({ ...r, canReset: false }, 'MaCEOmoi-2026'), e => e.code === 'NOT_ALLOWED');
    const { recoveryKey } = st.reset(r, 'MaCEOmoi-2026');
    assert.match(recoveryKey, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
    const r2 = makeStore(d, { env }).store.load();
    assert.strictEqual(r2.status, 'ok');
    assert.strictEqual(L.lockOf(r2.state, 'Profile 14'), null);
    assert.ok(L.isCeo(r2.state, 'MaCEOmoi-2026'));
    assert.ok(r2.state.events.some(e => e.type === 'tamper-reset'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('cảnh báo: không thành chỗ dò mã CEO; mã nhóm sửa được cảnh báo của Chrome trong nhóm; xóa nhóm có cảnh báo cần mã', () => {
  let s = setup().state;
  // mục mới chưa khóa, không đặt mã cảnh báo → NEED_CODE dù đúng hay sai mã CEO (không lộ đúng/sai)
  assert.throws(() => L.setWarning(s, { type: 'chrome', dir: 'Profile 77' }, CEO, { text: 'x' }), e => e.code === 'NEED_CODE');
  assert.throws(() => L.setWarning(s, { type: 'chrome', dir: 'Profile 77' }, 'sai-ma-99', { text: 'x' }), e => e.code === 'NEED_CODE');
  s = L.lockGroup(s, CEO, 'Social', ['Profile 2'], '246810').state;
  // Chrome khóa theo nhóm: tạo cảnh báo riêng cần mã nhóm (hoặc CEO)
  assert.throws(() => L.setWarning(s, { type: 'chrome', dir: 'Profile 2' }, 'sai', { text: 'x', newCode: 'w1111' }), e => e.code === 'BAD_CODE');
  s = L.setWarning(s, { type: 'chrome', dir: 'Profile 2' }, '246810', { text: 'Cảnh báo riêng', newCode: 'w1111' }).state;
  s = L.setWarning(s, { type: 'chrome', dir: 'Profile 2' }, '246810', { text: '', enabled: false }).state;
  assert.strictEqual(s.warnings.chromes['Profile 2'], undefined);
  // xóa nhóm chưa khóa có cảnh báo có mã
  s = L.setWarning(s, { type: 'group', group: 'Ads' }, '', { text: 'Nhóm Ads', newCode: 'w2222' }).state;
  assert.throws(() => L.deleteGroup(s, '', 'Ads'), e => e.code === 'BAD_CODE');
  assert.strictEqual(L.deleteGroup(s, 'w2222', 'Ads').state.warnings.groups.Ads, undefined);
  // không đổi tên nhóm đè lên nhóm có cảnh báo / đang khóa
  assert.throws(() => L.renameGroup(s, '246810', 'Social', 'Ads'), e => e.code === 'ALREADY');
});

test('thư mục profile không phân biệt hoa thường', () => {
  let s = L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state;
  s = L.lockGroup(s, CEO, 'Social', ['Profile 2'], '246810').state;
  assert.deepStrictEqual(L.lockOf(s, 'profile 14'), { type: 'chrome' });
  assert.deepStrictEqual(L.lockOf(s, 'PROFILE 2'), { type: 'group', group: 'Social' });
  assert.strictEqual(L.checkOpenCode(s, 'profile 14', '112233'), 'pin');
});

test('evaluateUnverified (cổng MCP, không có khóa bí mật): sạch / bị sửa / thiếu file chính', () => {
  const key = Buffer.alloc(32, 7);
  const st = L.lockChrome(setup().state, CEO, 'Profile 14', '112233').state; st.counter = 5;
  const doc = L.sealDoc(st, key);
  const seal = L.parseSeal(L.sealString(doc));
  assert.strictEqual(L.evaluateUnverified({ primary: { doc }, mirror: { doc }, seal }).failClosed, false);
  const edited = JSON.parse(JSON.stringify(doc)); edited.state.chromeLocks = {}; edited.mac = 'AAAA';
  assert.strictEqual(L.evaluateUnverified({ primary: { doc: edited }, mirror: { doc }, seal }).failClosedDirs, 'all');
  assert.strictEqual(L.evaluateUnverified({ primary: { missing: true }, mirror: { doc }, seal: null }).failClosed, true);
  assert.strictEqual(L.evaluateUnverified({ primary: { missing: true }, mirror: { missing: true }, seal: null }).failClosed, false);
});
