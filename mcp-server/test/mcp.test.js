// Test đầu-cuối: khởi động cổng MCP như Claude Desktop (stdio), dùng client MCP chính thức gọi từng lệnh.
// Chạy khô (UPM_MCP_DRY_RUN=1): không mở Chrome thật, chỉ trả lại lệnh sẽ chạy.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { makeFixture } = require('./fixture');

const fx = makeFixture();
let client;
before(async () => {
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server', 'index.js')],
    env: { ...getDefaultEnvironment(), ...fx.env, UPM_MCP_DRY_RUN: '1', UPM_MCP_FAKE_RUNNING: 'Profile 3,Profile 4', UPM_MCP_FAKE_NOWINDOW: 'Profile 4' },
    stderr: 'ignore',
  }));
});
after(async () => { await client.close(); fx.cleanup(); });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map(c => c.text).join('\n'), isError: !!r.isError };
};

test('khai báo đủ 4 lệnh + hướng dẫn cho Claude', async () => {
  const { tools } = await client.listTools();
  assert.deepStrictEqual(tools.map(t => t.name).sort(), ['mo_chrome', 'mo_link', 'mo_nhom', 'tim_chrome']);
  assert.strictEqual(tools.find(t => t.name === 'tim_chrome').annotations.readOnlyHint, true);
  assert.match(client.getInstructions(), /Chrome Manager by UP Media/);
});

test('tim_chrome: tìm theo từ khóa, báo đang mở', async () => {
  const r = await call('tim_chrome', { tu_khoa: 'seeding fb 02' });
  assert.match(r.text, /Tìm thấy 1\/13/);
  assert.match(r.text, /"dang_mo": true/);
  const all = await call('tim_chrome', {});
  assert.match(all.text, /Tìm thấy 13\/13/);
  const bad = await call('tim_chrome', { nhom: 'Không có' });
  assert.strictEqual(bad.isError, true);
});

test('mo_chrome: mở đúng Profile 14 khi gõ không dấu', async () => {
  const r = await call('mo_chrome', { ten: 'dinh thi thanh' });
  assert.strictEqual(r.isError, false);
  assert.match(r.text, /\[chạy khô\] chrome\.exe --profile-directory=Profile 14 /);
});

test('mo_chrome: đang mở sẵn thì đưa cửa sổ lên trước, không mở chồng (trừ khi yêu cầu)', async () => {
  const r = await call('mo_chrome', { ten: 'Seeding FB 02' });
  assert.match(r.text, /đang mở sẵn — đã đưa cửa sổ lên trước màn hình \[chạy khô\]/);
  assert.doesNotMatch(r.text, /chrome\.exe --profile-directory/);
  const r2 = await call('mo_chrome', { ten: 'Seeding FB 02', mo_them_cua_so: true });
  assert.match(r2.text, /--profile-directory=Profile 3 /);
});

test('mo_chrome: profile chạy ngầm không có cửa sổ → mở cửa sổ mới', async () => {
  const r = await call('mo_chrome', { ten: 'Seeding FB 03' });
  assert.match(r.text, /--profile-directory=Profile 4 /);
  assert.match(r.text, /đang chạy ngầm, không có cửa sổ nào — đã mở cửa sổ mới/);
});

test('mo_chrome: trùng nhiều → không mở, trả danh sách; không có → báo lỗi', async () => {
  const r = await call('mo_chrome', { ten: 'thanh' });
  assert.match(r.text, /Có 3 Chrome khớp "thanh"\. Chưa mở cái nào/);
  assert.doesNotMatch(r.text, /chạy khô/);
  const nf = await call('mo_chrome', { ten: 'abc xyz' });
  assert.strictEqual(nf.isError, true);
});

test('mo_link: mở trang trong đúng Chrome; chặn địa chỉ không phải web', async () => {
  const r = await call('mo_link', { ten: '14', url: 'facebook.com' });
  assert.match(r.text, /--profile-directory=Profile 14 .* https:\/\/facebook\.com\/$/);
  const bad = await call('mo_link', { ten: '14', url: 'javascript:alert(1)' });
  assert.strictEqual(bad.isError, true);
});

test('mo_nhom: nhóm lớn cần xác nhận, bỏ qua Chrome đang mở', async () => {
  const r = await call('mo_nhom', { nhom: 'FB' });
  assert.match(r.text, /có 7 Chrome cần mở \(2 cái đang mở sẵn sẽ bỏ qua\)\. CHƯA mở/);
  assert.doesNotMatch(r.text, /chạy khô/);
  const ok = await call('mo_nhom', { nhom: 'FB', xac_nhan: true });
  assert.match(ok.text, /Đã mở 7\/9 Chrome trong "FB", 2 cái đang mở sẵn nên bỏ qua\./);
  assert.strictEqual((ok.text.match(/chạy khô/g) || []).length, 7);
});

test('mo_nhom: nhóm nhỏ mở luôn; nhóm + danh mục con; nhóm không có', async () => {
  const r = await call('mo_nhom', { nhom: 'Nhân sự UP', danh_muc_con: 'HCTH' });
  assert.match(r.text, /Đã mở 1\/1/);
  assert.match(r.text, /--profile-directory=Default /);
  const bad = await call('mo_nhom', { nhom: 'Không có' });
  assert.strictEqual(bad.isError, true);
  assert.match(bad.text, /Các nhóm hiện có: Social, Digital, Nhân sự UP, Khách hàng/);
});
