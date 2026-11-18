#!/usr/bin/env node
// Cổng MCP "Chrome Manager by UP Media" — cho Claude tìm và mở đúng Chrome profile theo tên.
// Chạy qua stdio (Claude Desktop tự khởi động khi cài gói .mcpb). KHÔNG in gì ra stdout ngoài giao thức MCP.
'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const core = require('./core');
const pkg = require('../package.json');

const INSTRUCTIONS = [
  'Cổng này điều khiển phần mềm Chrome Manager by UP Media trên máy Windows của người dùng: tìm và mở các Chrome profile theo tên họ đã đặt.',
  '- "Mở Chrome <tên>" → gọi mo_chrome với đúng tên người dùng nói (có dấu hay không dấu đều được).',
  '- Kết quả báo nhiều profile trùng → KHÔNG tự chọn; hỏi người dùng chọn rồi gọi lại bằng thư mục (vd "Profile 14").',
  '- Mở một trang trong Chrome nào đó → mo_link. Mở cả nhóm/danh mục → mo_nhom; nhóm lớn sẽ cần người dùng xác nhận (xac_nhan=true).',
  '- Chưa rõ tên/nhóm → tim_chrome để xem danh sách.',
  '- Cổng chỉ tìm và mở Chrome; không xóa, không sửa, không đọc cookie hay mật khẩu.',
  '- Sau khi mở, nếu cần thao tác bên trong Chrome đó thì dùng công cụ Claude in Chrome và chọn đúng trình duyệt của profile vừa mở.',
].join('\n');

function textResult(text, isError = false) {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}
function brief(p, running) {
  const o = { ten: p.name, thu_muc: p.dir };
  if (p.chromeName && p.chromeName !== p.name) o.ten_trong_chrome = p.chromeName;
  if (p.groups.length) o.nhom = p.groups;
  const subs = Object.entries(p.subGroups).filter(([, v]) => v.length);
  if (subs.length) o.danh_muc_con = Object.fromEntries(subs);
  if (p.note) o.ghi_chu = p.note;   // chỉ đoạn đầu, đã ẩn thông tin đăng nhập
  if (p.emails.length) o.email = p.emails;
  if (p.pinned) o.ghim = true;
  if (running) o.dang_mo = running.has(p.dir.toLowerCase());
  return o;
}
function label(p) { return `"${p.name}" (${p.dir})`; }

function load() {
  try {
    return { data: core.loadProfiles() };
  } catch (err) {
    if (err && err.message === 'NOT_FOUND_USER_DATA') {
      return { error: textResult('Không tìm thấy thư mục dữ liệu Chrome (User Data) trên máy này. Mở Chrome Manager by UP Media, bấm "Quét lại" (hoặc chọn thư mục thủ công) rồi thử lại.', true) };
    }
    return { error: textResult('Không đọc được danh sách Chrome: ' + (err && err.message), true) };
  }
}
function configNote(data) {
  if (data.configProblem === 'missing') return '\n(Lưu ý: chưa thấy cấu hình Chrome Manager trên máy này — chỉ có tên lưu trong Chrome, chưa có tên/nhóm đặt trong app.)';
  if (data.configProblem === 'unreadable') return '\n(Lưu ý: không đọc được file cấu hình Chrome Manager — tạm dùng tên lưu trong Chrome.)';
  return '';
}
function openedLine(p, r) {
  return r.dryRun ? `[chạy khô] chrome.exe ${r.args.join(' ')}` : `Đã mở Chrome ${label(p)}.`;
}
function chromeError(err) {
  return err && err.message === 'CHROME_NOT_FOUND'
    ? 'Không tìm thấy Google Chrome trên máy (đường dẫn cài đặt chuẩn).'
    : 'Không mở được Chrome: ' + (err && err.message);
}
function ambiguousText(r, ten) {
  const list = r.matches.slice(0, 15).map(p => brief(p));
  return `Có ${r.matches.length} Chrome khớp "${ten}". Chưa mở cái nào — hãy hỏi người dùng chọn đúng một, rồi gọi lại với "thu_muc" của profile đó.\n` +
    JSON.stringify(list, null, 1) + (r.matches.length > 15 ? `\n… và ${r.matches.length - 15} profile khác.` : '');
}
function notFoundText(ten) {
  return textResult(`Không tìm thấy Chrome nào tên "${ten}". Dùng tim_chrome để xem danh sách rồi gọi lại.`, true);
}

const server = new McpServer(
  { name: 'chrome-manager-upmedia', version: pkg.version },
  { instructions: INSTRUCTIONS },
);

// 1) Tìm / liệt kê
server.registerTool('tim_chrome', {
  title: 'Tìm Chrome profile',
  description: 'Liệt kê hoặc tìm Chrome profile trong Chrome Manager by UP Media theo tên, nhóm, danh mục con, đoạn đầu ghi chú hoặc email (gõ có dấu hay không dấu đều được). Trả về tên, thư mục (Profile N), nhóm, đoạn đầu ghi chú (thông tin đăng nhập luôn bị ẩn), email, đang mở hay không. Để trống tu_khoa để xem tất cả.',
  inputSchema: {
    tu_khoa: z.string().optional().describe('Từ khóa: tên, ghi chú, email… (bỏ trống = tất cả)'),
    nhom: z.string().optional().describe('Lọc theo nhóm cha hoặc danh mục con, vd "Social", "FB"'),
    gioi_han: z.number().int().min(1).max(300).optional().describe('Số kết quả tối đa, mặc định 50'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ tu_khoa, nhom, gioi_han }) => {
  const { data, error } = load();
  if (error) return error;
  if (nhom && !core.resolveGroup(data.profiles, nhom).profiles.length) {
    return textResult(`Không có nhóm/danh mục con nào tên "${nhom}". Các nhóm hiện có: ${data.groups.join(', ') || '(chưa có)'}.` +
      configNote(data), true);
  }
  const list = core.searchProfiles(data.profiles, { query: tu_khoa, group: nhom });
  const open = await core.getOpenDirs(data.userDataPath);
  const running = open.dirs;
  const max = gioi_han || 50;
  const shown = list.slice(0, max).map(p => brief(p, running));
  const head = `Tìm thấy ${list.length}/${data.profiles.length} Chrome` +
    (tu_khoa ? ` khớp "${tu_khoa}"` : '') + (nhom ? ` trong "${nhom}"` : '') +
    (list.length > max ? ` (hiện ${max} đầu tiên)` : '') + '.' +
    ` Trên máy đang mở ${open.dirs.size} Chrome` + (open.winOk ? '.' : ' (chưa đọc được cửa sổ Chrome, chỉ dò theo file — có thể sót Chrome vừa mở).') +
    ' Ghi chú chỉ hiện đoạn đầu; thông tin đăng nhập trong ghi chú luôn được ẩn.';
  return textResult(head + configNote(data) + '\n' + JSON.stringify(shown, null, 1));
});

// 2) Mở theo tên
server.registerTool('mo_chrome', {
  title: 'Mở Chrome theo tên',
  description: 'Mở Chrome profile theo tên đã đặt trong Chrome Manager (vd "Đinh Thị Thanh", "dinh thi thanh"), theo thư mục ("Profile 14" hoặc "14"), tên trong Chrome hoặc email. Trùng nhiều profile thì KHÔNG mở mà trả danh sách để hỏi lại. Profile đang mở sẵn thì đưa cửa sổ đó lên trước màn hình thay vì mở chồng (mo_them_cua_so=true để mở thêm cửa sổ mới).',
  inputSchema: {
    ten: z.string().min(1).describe('Tên Chrome cần mở, hoặc "Profile N"'),
    mo_them_cua_so: z.boolean().optional().describe('true = vẫn mở thêm cửa sổ dù profile đang mở sẵn'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ten, mo_them_cua_so }) => {
  const { data, error } = load();
  if (error) return error;
  const r = core.resolveProfile(data.profiles, ten);
  if (r.status === 'ambiguous') return textResult(ambiguousText(r, ten));
  if (r.status !== 'ok') return notFoundText(ten);
  const p = r.profile;
  let reopenNote = '';
  if (!mo_them_cua_so) {
    // Tìm cửa sổ của profile trước (chắc chắn hơn dò file): có → đưa lên trước, không mở chồng
    const f = await core.focusProfileWindow(p.dir);
    if (f.success) return textResult(`Chrome ${label(p)} đang mở sẵn — đã đưa cửa sổ lên trước màn hình${f.dryRun ? ' [chạy khô]' : ''}.`);
    if (!f.notFound) {
      return textResult(`Chrome ${label(p)} đang mở sẵn nhưng Windows chưa cho đưa cửa sổ lên trước. Người dùng có thể bấm vào Chrome đó trên thanh taskbar; nếu muốn mở thêm cửa sổ mới, gọi lại với mo_them_cua_so=true.`);
    }
    if (core.getLockedDirs(data.userDataPath).has(p.dir.toLowerCase())) {
      reopenNote = ' (Chrome này đang chạy ngầm, không có cửa sổ nào — đã mở cửa sổ mới.)';
    }
  }
  try {
    const res = core.launchChrome(p.dir, { userDataPath: data.launchUserDataPath });
    return textResult(openedLine(p, res) + reopenNote + configNote(data));
  } catch (err) {
    return textResult(chromeError(err), true);
  }
});

// 3) Mở một trang trong đúng Chrome
server.registerTool('mo_link', {
  title: 'Mở link trong Chrome',
  description: 'Mở một trang web (http/https) trong đúng Chrome profile theo tên, vd mở facebook.com trong Chrome "Đinh Thị Thanh". Profile đang mở thì trang mở thành tab mới trong Chrome đó.',
  inputSchema: {
    ten: z.string().min(1).describe('Tên Chrome hoặc "Profile N"'),
    url: z.string().min(1).describe('Địa chỉ trang, vd https://facebook.com (thiếu https:// sẽ tự thêm)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ten, url }) => {
  const href = core.normalizeUrl(url);
  if (!href) return textResult(`Địa chỉ "${url}" không hợp lệ — chỉ nhận trang web http/https.`, true);
  const { data, error } = load();
  if (error) return error;
  const r = core.resolveProfile(data.profiles, ten);
  if (r.status === 'ambiguous') return textResult(ambiguousText(r, ten));
  if (r.status !== 'ok') return notFoundText(ten);
  try {
    const res = core.launchChrome(r.profile.dir, { url: href, userDataPath: data.launchUserDataPath });
    return textResult(res.dryRun ? openedLine(r.profile, res) : `Đã mở ${href} trong Chrome ${label(r.profile)}.`);
  } catch (err) {
    return textResult(chromeError(err), true);
  }
});

// 4) Mở cả nhóm
server.registerTool('mo_nhom', {
  title: 'Mở cả nhóm Chrome',
  description: `Mở tất cả Chrome trong một nhóm cha hoặc danh mục con của Chrome Manager (vd "Social", "FB"). Bỏ qua Chrome đang mở sẵn. Cần mở nhiều hơn ${core.GROUP_CONFIRM_OVER} Chrome thì lần gọi đầu chỉ trả danh sách; hỏi người dùng xác nhận rồi gọi lại với xac_nhan=true.`,
  inputSchema: {
    nhom: z.string().min(1).describe('Tên nhóm cha hoặc danh mục con'),
    danh_muc_con: z.string().optional().describe('Chỉ mở danh mục con này bên trong nhóm (tùy chọn)'),
    xac_nhan: z.boolean().optional().describe('true = người dùng đã đồng ý mở nhiều Chrome'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ nhom, danh_muc_con, xac_nhan }) => {
  const { data, error } = load();
  if (error) return error;
  const g = core.resolveGroup(data.profiles, nhom, danh_muc_con);
  const where = `"${nhom}"` + (danh_muc_con ? ` / "${danh_muc_con}"` : '');
  if (!g.profiles.length) {
    return textResult(`Không có Chrome nào trong ${where}. Các nhóm hiện có: ${data.groups.join(', ') || '(chưa có)'}.` + configNote(data), true);
  }
  const running = (await core.getOpenDirs(data.userDataPath)).dirs;
  const toOpen = g.profiles.filter(p => !running.has(p.dir.toLowerCase()));
  const skipped = g.profiles.length - toOpen.length;
  if (!toOpen.length) return textResult(`Cả ${g.profiles.length} Chrome trong ${where} đều đang mở sẵn.`);
  if (toOpen.length > core.GROUP_CONFIRM_OVER && !xac_nhan) {
    return textResult(`${where} có ${toOpen.length} Chrome cần mở` + (skipped ? ` (${skipped} cái đang mở sẵn sẽ bỏ qua)` : '') +
      `. CHƯA mở — hãy hỏi người dùng xác nhận, rồi gọi lại với xac_nhan=true.\n` + toOpen.map(label).join('\n'));
  }
  const lines = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < toOpen.length; i++) {
    const p = toOpen[i];
    try {
      const res = core.launchChrome(p.dir, { userDataPath: data.launchUserDataPath });
      ok++; if (res.dryRun) lines.push(openedLine(p, res));
    } catch (err) { fail++; lines.push(`Lỗi ${label(p)}: ${chromeError(err)}`); if (err.message === 'CHROME_NOT_FOUND') break; }
    if (i < toOpen.length - 1 && !process.env.UPM_MCP_DRY_RUN) await core.sleep(core.BATCH_DELAY_MS);
  }
  const head = `Đã mở ${ok}/${g.profiles.length} Chrome trong ${where}` +
    (skipped ? `, ${skipped} cái đang mở sẵn nên bỏ qua` : '') + (fail ? `, ${fail} lỗi` : '') + '.';
  return textResult([head, ...lines].join('\n'), fail > 0 && ok === 0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chrome-manager-upmedia MCP ${pkg.version}] sẵn sàng`);
}
main().catch(err => { console.error('[chrome-manager-upmedia MCP] lỗi khởi động:', err); process.exit(1); });
