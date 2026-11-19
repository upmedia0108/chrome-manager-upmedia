#!/usr/bin/env node
// Cổng MCP "Chrome Manager by UP Media" — cho Claude tìm và mở đúng Chrome profile theo tên.
// Chạy qua stdio (Claude Desktop tự khởi động khi cài gói .mcpb). KHÔNG in gì ra stdout ngoài giao thức MCP.
'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const crypto = require('crypto');
const core = require('./core');
const pkg = require('../package.json');

const INSTRUCTIONS = [
  'Cổng này điều khiển phần mềm Chrome Manager by UP Media trên máy Windows của người dùng: tìm và mở các Chrome profile theo tên họ đã đặt.',
  '- "Mở Chrome <tên>" → gọi mo_chrome với đúng tên người dùng nói (có dấu hay không dấu đều được).',
  '- Kết quả báo nhiều profile trùng → KHÔNG tự chọn; hỏi người dùng chọn rồi gọi lại bằng thư mục (vd "Profile 14").',
  '- Mở một trang trong Chrome nào đó → mo_link. Mở cả nhóm/danh mục → mo_nhom; nhóm lớn sẽ cần người dùng xác nhận (xac_nhan=true).',
  '- Chưa rõ tên/nhóm → tim_chrome để xem danh sách.',
  '- Chrome đang khóa bằng mã (trường "khoa"): cổng KHÔNG mở được. Không hỏi, không nhận mã khóa từ người dùng; bảo người dùng tự mở trong Chrome Manager và nhập mã ở đó.',
  '- Chrome có cảnh báo khi mở: lần gọi đầu chỉ trả nội dung cảnh báo kèm MÃ XÁC NHẬN, CHƯA mở. Đọc nguyên văn cảnh báo cho người dùng; người dùng đồng ý thì gọi lại y như cũ, thêm ma_canh_bao=<mã xác nhận>. Không gọi lại khi người dùng chưa đọc.',
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
  if (p.lock) o.khoa = core.lockText(p.lock);   // Chrome khóa: đã ẩn ghi chú, email
  if (running) o.dang_mo = running.has(p.dir.toLowerCase());
  return o;
}
function label(p) { return `"${p.name}" (${p.dir})`; }

function load() {
  try {
    const base = core.loadProfiles();
    const lk = core.loadLocks(base.configPath);          // đọc mới mỗi lần: khóa có hiệu lực ngay
    return { data: { ...base, profiles: core.applyLocks(base.profiles, lk), lk } };
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
function lockedResult(p) {
  return textResult(`Chrome ${label(p)} đang ${core.lockText(p.lock)}. Claude không mở được Chrome đang khóa và không nhận mã khóa — người dùng tự mở trong Chrome Manager by UP Media rồi nhập mã ở đó.`, true);
}
// Cảnh báo khi mở (người dùng tự đặt trong app). Chưa đọc → trả nội dung cảnh báo, chưa mở.
function collectWarnings(data, list) {
  const seen = new Set(), out = [];
  for (const p of list) for (const w of data.lk.warningsFor(p)) {
    const k = `${w.source}|${w.name}|${w.text}`;
    if (!seen.has(k)) { seen.add(k); out.push(w); }
  }
  return out;
}
function warningLines(data, ws) {
  const nameOf = dir => { const p = data.profiles.find(x => x.dir === dir); return p ? p.name : dir; };
  return ws.map(w => `- ${w.source === 'group' ? `Cảnh báo nhóm "${w.name}"` : `Cảnh báo Chrome "${nameOf(w.name)}"`}: ${w.text}`).join('\n');
}
// Mã xác nhận suy ra từ nội dung cảnh báo: phải gọi lần đầu (nhận cảnh báo) mới biết mã để mở
function warningToken(ws) {
  return crypto.createHash('sha256').update(ws.map(w => `${w.source}|${w.name}|${w.text}`).sort().join('\n')).digest('hex').slice(0, 6).toUpperCase();
}
function warningGate(data, list, maCanhBao, what) {
  const ws = collectWarnings(data, list);
  if (!ws.length) return null;
  const token = warningToken(ws);
  if (String(maCanhBao || '').trim().toUpperCase() === token) return null;
  return textResult(`${what} có cảnh báo trước khi mở (đặt trong Chrome Manager). CHƯA mở — đọc nguyên văn cảnh báo dưới đây cho người dùng; người dùng đồng ý thì gọi lại y như cũ, thêm ma_canh_bao="${token}".\n` + warningLines(data, ws));
}
const MA_CANH_BAO = z.string().optional().describe('Mã xác nhận in trong lần trả cảnh báo trước đó — chỉ điền sau khi đã đọc cảnh báo cho người dùng và người dùng đồng ý mở');

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
    ' Ghi chú chỉ hiện đoạn đầu; thông tin đăng nhập trong ghi chú luôn được ẩn.' +
    (data.lk.failClosed ? ' CẢNH BÁO: dữ liệu khóa của Chrome Manager có dấu hiệu bị sửa — mọi Chrome đang khóa cho tới khi CEO nhập mã trong app.'
      : (list.some(p => p.lock) ? ' Chrome có trường "khoa" đang khóa bằng mã: Claude không mở được, đã ẩn ghi chú và email.' : ''));
  return textResult(head + configNote(data) + '\n' + JSON.stringify(shown, null, 1));
});

// 2) Mở theo tên
server.registerTool('mo_chrome', {
  title: 'Mở Chrome theo tên',
  description: 'Mở Chrome profile theo tên đã đặt trong Chrome Manager (vd "Đinh Thị Thanh", "dinh thi thanh"), theo thư mục ("Profile 14" hoặc "14"), tên trong Chrome hoặc email. Trùng nhiều profile thì KHÔNG mở mà trả danh sách để hỏi lại. Profile đang mở sẵn thì đưa cửa sổ đó lên trước màn hình thay vì mở chồng (mo_them_cua_so=true để mở thêm cửa sổ mới). Chrome đang khóa bằng mã thì không mở được. Chrome có cảnh báo thì lần đầu chỉ trả cảnh báo kèm mã xác nhận; đọc cho người dùng rồi gọi lại với ma_canh_bao=<mã>.',
  inputSchema: {
    ten: z.string().min(1).describe('Tên Chrome cần mở, hoặc "Profile N"'),
    mo_them_cua_so: z.boolean().optional().describe('true = vẫn mở thêm cửa sổ dù profile đang mở sẵn'),
    ma_canh_bao: MA_CANH_BAO,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ten, mo_them_cua_so, ma_canh_bao }) => {
  const { data, error } = load();
  if (error) return error;
  const r = core.resolveProfile(data.profiles, ten);
  if (r.status === 'ambiguous') return textResult(ambiguousText(r, ten));
  if (r.status !== 'ok') return notFoundText(ten);
  const p = r.profile;
  if (p.lock) return lockedResult(p);                       // khóa: không mở, không đưa cửa sổ lên
  const warn = warningGate(data, [p], ma_canh_bao, `Chrome ${label(p)}`);
  if (warn) return warn;
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
  description: 'Mở một trang web (http/https) trong đúng Chrome profile theo tên, vd mở facebook.com trong Chrome "Đinh Thị Thanh". Profile đang mở thì trang mở thành tab mới trong Chrome đó. Chrome đang khóa bằng mã thì không mở được; Chrome có cảnh báo thì cần ma_canh_bao=<mã xác nhận> sau khi đã đọc cảnh báo cho người dùng.',
  inputSchema: {
    ten: z.string().min(1).describe('Tên Chrome hoặc "Profile N"'),
    url: z.string().min(1).describe('Địa chỉ trang, vd https://facebook.com (thiếu https:// sẽ tự thêm)'),
    ma_canh_bao: MA_CANH_BAO,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ ten, url, ma_canh_bao }) => {
  const href = core.normalizeUrl(url);
  if (!href) return textResult(`Địa chỉ "${url}" không hợp lệ — chỉ nhận trang web http/https.`, true);
  const { data, error } = load();
  if (error) return error;
  const r = core.resolveProfile(data.profiles, ten);
  if (r.status === 'ambiguous') return textResult(ambiguousText(r, ten));
  if (r.status !== 'ok') return notFoundText(ten);
  if (r.profile.lock) return lockedResult(r.profile);
  const warn = warningGate(data, [r.profile], ma_canh_bao, `Chrome ${label(r.profile)}`);
  if (warn) return warn;
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
  description: `Mở tất cả Chrome trong một nhóm cha hoặc danh mục con của Chrome Manager (vd "Social", "FB"). Bỏ qua Chrome đang mở sẵn và Chrome đang khóa bằng mã. Cần mở nhiều hơn ${core.GROUP_CONFIRM_OVER} Chrome thì lần gọi đầu chỉ trả danh sách; hỏi người dùng xác nhận rồi gọi lại với xac_nhan=true. Chrome có cảnh báo thì cần ma_canh_bao=<mã xác nhận> sau khi đã đọc cảnh báo cho người dùng.`,
  inputSchema: {
    nhom: z.string().min(1).describe('Tên nhóm cha hoặc danh mục con'),
    danh_muc_con: z.string().optional().describe('Chỉ mở danh mục con này bên trong nhóm (tùy chọn)'),
    xac_nhan: z.boolean().optional().describe('true = người dùng đã đồng ý mở nhiều Chrome'),
    ma_canh_bao: MA_CANH_BAO,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ nhom, danh_muc_con, xac_nhan, ma_canh_bao }) => {
  const { data, error } = load();
  if (error) return error;
  const g = core.resolveGroup(data.profiles, nhom, danh_muc_con);
  const where = `"${nhom}"` + (danh_muc_con ? ` / "${danh_muc_con}"` : '');
  if (!g.profiles.length) {
    return textResult(`Không có Chrome nào trong ${where}. Các nhóm hiện có: ${data.groups.join(', ') || '(chưa có)'}.` + configNote(data), true);
  }
  const lockedList = g.profiles.filter(p => p.lock);         // Chrome khóa bằng mã: bỏ qua, không mở
  const lockedNote = lockedList.length ? ` ${lockedList.length} Chrome đang khóa bằng mã nên bỏ qua (người dùng tự mở trong Chrome Manager): ${lockedList.map(label).join(', ')}.` : '';
  const unlockedList = g.profiles.filter(p => !p.lock);
  if (!unlockedList.length) return textResult(`Cả ${g.profiles.length} Chrome trong ${where} đều đang khóa bằng mã — Claude không mở được. Người dùng tự mở trong Chrome Manager by UP Media và nhập mã.`, true);
  const running = (await core.getOpenDirs(data.userDataPath)).dirs;
  const toOpen = unlockedList.filter(p => !running.has(p.dir.toLowerCase()));
  const skipped = unlockedList.length - toOpen.length;
  if (!toOpen.length) return textResult(`Cả ${unlockedList.length} Chrome (chưa khóa) trong ${where} đều đang mở sẵn.` + lockedNote);
  const needConfirm = toOpen.length > core.GROUP_CONFIRM_OVER && !xac_nhan;
  const allWs = collectWarnings(data, toOpen);
  const token = allWs.length ? warningToken(allWs) : null;
  const ws = token && String(ma_canh_bao || '').trim().toUpperCase() !== token ? allWs : [];
  if (needConfirm || ws.length) {
    const need = [needConfirm && 'xac_nhan=true (người dùng đồng ý mở nhiều Chrome)', ws.length && `ma_canh_bao="${token}" (người dùng đã đọc cảnh báo)`].filter(Boolean).join(' và ');
    return textResult(`${where} có ${toOpen.length} Chrome cần mở` + (skipped ? ` (${skipped} cái đang mở sẵn sẽ bỏ qua)` : '') + '.' + lockedNote +
      ` CHƯA mở — ${ws.length ? 'đọc nguyên văn cảnh báo dưới đây cho người dùng, ' : ''}hỏi người dùng rồi gọi lại với ${need}.\n` +
      (ws.length ? 'Cảnh báo trước khi mở:\n' + warningLines(data, ws) + '\n' : '') + 'Chrome sẽ mở:\n' + toOpen.map(label).join('\n'));
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
    (skipped ? `, ${skipped} cái đang mở sẵn nên bỏ qua` : '') + (fail ? `, ${fail} lỗi` : '') + '.' + lockedNote;
  return textResult([head, ...lines].join('\n'), fail > 0 && ok === 0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chrome-manager-upmedia MCP ${pkg.version}] sẵn sàng`);
}
main().catch(err => { console.error('[chrome-manager-upmedia MCP] lỗi khởi động:', err); process.exit(1); });
