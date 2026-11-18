// Test hàm thuần của cổng MCP. Chạy: npm test
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../server/core');
const { makeFixture } = require('./fixture');

const fx = makeFixture();
after(() => fx.cleanup());
const data = core.loadProfiles({ env: fx.env, fresh: true });
const P = data.profiles;
const dirOf = r => r.profile && r.profile.dir;

test('loadProfiles: gộp đúng tên/nhóm/ghi chú/email từ app + Chrome', () => {
  assert.strictEqual(P.length, 13);
  const p14 = P.find(p => p.dir === 'Profile 14');
  assert.strictEqual(p14.name, 'Đinh Thị Thanh');
  assert.deepStrictEqual(p14.groups, ['Nhân sự UP']);
  assert.strictEqual(p14.notes, 'Ads Queen Spa');
  assert.deepStrictEqual(p14.emails, ['thanh.dt@gmail.com']);
  assert.strictEqual(p14.pinned, true);
  // subGroups dạng chuỗi (dữ liệu cũ) được đổi thành mảng
  assert.deepStrictEqual(P.find(p => p.dir === 'Profile 2').subGroups, { Social: ['FB'] });
  // Không có tên trong app → dùng tên Chrome
  assert.strictEqual(P.find(p => p.dir === 'Profile 11').name, 'Thanh Hà');
  assert.strictEqual(data.configProblem, null);
  assert.strictEqual(data.launchUserDataPath, fx.userData);
});

test('resolveProfile: tên có dấu / không dấu / hoa thường đều ra đúng Profile 14', () => {
  for (const q of ['Đinh Thị Thanh', 'dinh thi thanh', 'ĐINH THỊ THANH', '  dinh   thi thanh ']) {
    const r = core.resolveProfile(P, q);
    assert.strictEqual(r.status, 'ok', q);
    assert.strictEqual(dirOf(r), 'Profile 14', q);
  }
});

test('resolveProfile: theo thư mục "Profile 14" hoặc số "14", theo email', () => {
  assert.strictEqual(dirOf(core.resolveProfile(P, 'Profile 14')), 'Profile 14');
  assert.strictEqual(dirOf(core.resolveProfile(P, '14')), 'Profile 14');
  assert.strictEqual(dirOf(core.resolveProfile(P, 'thanh.dt@gmail.com')), 'Profile 14');
  assert.strictEqual(dirOf(core.resolveProfile(P, 'default')), 'Default');
});

test('resolveProfile: khớp đúng tên ưu tiên hơn khớp một phần', () => {
  assert.strictEqual(dirOf(core.resolveProfile(P, 'thanh ha')), 'Profile 11');      // không lẫn "Thanh Hà KH"
  assert.strictEqual(dirOf(core.resolveProfile(P, 'thanh ha kh')), 'Profile 12');
  assert.strictEqual(dirOf(core.resolveProfile(P, 'seeding fb 01')), 'Profile 2');
  assert.strictEqual(dirOf(core.resolveProfile(P, 'queen spa')), 'Profile 14');     // khớp ghi chú
  assert.strictEqual(dirOf(core.resolveProfile(P, 'Sếp')), 'Default');              // tên trong Chrome
});

test('resolveProfile: trùng nhiều thì trả danh sách, không đoán', () => {
  const r = core.resolveProfile(P, 'thanh');
  assert.strictEqual(r.status, 'ambiguous');
  assert.deepStrictEqual(r.matches.map(p => p.dir).sort(), ['Profile 11', 'Profile 12', 'Profile 14']);
  assert.strictEqual(core.resolveProfile(P, 'seeding').status, 'ambiguous');
  // "an" không được khớp lung tung vào giữa từ ("Thanh")
  assert.notStrictEqual(core.resolveProfile(P, 'an').status, 'ambiguous');
});

test('resolveProfile: không có / để trống', () => {
  assert.strictEqual(core.resolveProfile(P, 'không tồn tại xyz').status, 'not_found');
  assert.strictEqual(core.resolveProfile(P, '   ').status, 'empty');
});

test('resolveGroup: nhóm cha, danh mục con, nhóm + danh mục con', () => {
  assert.strictEqual(core.resolveGroup(P, 'social').profiles.length, 9);
  const fb = core.resolveGroup(P, 'FB');
  assert.strictEqual(fb.kind, 'sub');
  assert.strictEqual(fb.profiles.length, 9);
  assert.deepStrictEqual(core.resolveGroup(P, 'Nhân sự UP', 'hcth').profiles.map(p => p.dir), ['Default']);
  assert.deepStrictEqual(core.resolveGroup(P, 'nhan su up', 'VHDA').profiles.map(p => p.dir), ['Profile 14']);
  assert.strictEqual(core.resolveGroup(P, 'Không có').profiles.length, 0);
});

test('searchProfiles: từ khóa + lọc nhóm', () => {
  assert.strictEqual(core.searchProfiles(P, {}).length, 13);
  assert.strictEqual(core.searchProfiles(P, { query: 'seeding' }).length, 9);
  assert.strictEqual(core.searchProfiles(P, { query: 'thanh', group: 'Nhân sự UP' }).length, 1);
  assert.strictEqual(core.searchProfiles(P, { query: 'gmail' }).length, 1);
});

test('normalizeUrl: chỉ nhận http/https, tự thêm https://, không thể chèn tham số Chrome', () => {
  assert.strictEqual(core.normalizeUrl('facebook.com'), 'https://facebook.com/');
  assert.strictEqual(core.normalizeUrl('https://business.facebook.com/latest'), 'https://business.facebook.com/latest');
  assert.strictEqual(core.normalizeUrl('http://upmedia.vn'), 'http://upmedia.vn/');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows', 'chrome://settings', '', '   ']) {
    assert.strictEqual(core.normalizeUrl(bad), null, bad);
  }
  const sneaky = core.normalizeUrl('--disable-web-security');
  assert.ok(sneaky === null || sneaky.startsWith('https://'));
});

test('buildChromeArgs: đúng tham số, link nằm cuối', () => {
  assert.deepStrictEqual(core.buildChromeArgs('Profile 14', { url: 'https://a.vn/', userDataPath: 'D:\\UD' }),
    ['--profile-directory=Profile 14', '--no-first-run', '--no-default-browser-check', '--user-data-dir=D:\\UD', 'https://a.vn/']);
  assert.deepStrictEqual(core.buildChromeArgs('Default'), ['--profile-directory=Default', '--no-first-run', '--no-default-browser-check']);
});

test('getRunningDirs: dùng dò khóa file của module chung (máy thường → không có profile nào đang mở)', async () => {
  assert.strictEqual((await core.getRunningDirs(fx.userData, {})).size, 0);
  assert.deepStrictEqual([...(await core.getRunningDirs(fx.userData, { UPM_MCP_FAKE_RUNNING: 'Profile 3, Default' }))].sort(), ['default', 'profile 3']);
});

test('loadProfiles: không có config.json của app → vẫn chạy bằng tên trong Chrome', () => {
  const d = core.loadProfiles({ env: { UPM_CONFIG_PATH: path.join(fx.root, 'khong-co.json'), UPM_CHROME_USER_DATA: fx.userData }, fresh: true });
  assert.strictEqual(d.configProblem, 'missing');
  assert.strictEqual(d.profiles.find(p => p.dir === 'Profile 14').name, 'Đinh Thị Thanh');
  assert.strictEqual(d.profiles.find(p => p.dir === 'Profile 2').name, 'Person 2');
});

test('bản sao module dùng chung khớp với app (nhớ chạy npm run sync khi sửa src của app)', (t) => {
  const appSrc = path.join(__dirname, '..', '..', 'chrome-shortcut-manager', 'src');
  if (!fs.existsSync(appSrc)) { t.skip('không thấy thư mục app'); return; }
  for (const f of ['chromeProfiles.js', 'accounts.js', 'chromeWindows.js']) {
    assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'server', 'shared', f), 'utf8'),
      fs.readFileSync(path.join(appSrc, f), 'utf8'), f);
  }
});
