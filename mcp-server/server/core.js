// Lõi cổng MCP của Chrome Manager by UP Media — hàm thuần + mở Chrome.
// KHÔNG phụ thuộc Electron: chạy bằng Node có sẵn trong app Claude Desktop.
// Đọc chung dữ liệu với app (config.json: tên, nhóm, ghi chú, ghim) + quét Chrome User Data.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec, spawn, execFileSync } = require('child_process');
const chromeProfiles = require('./shared/chromeProfiles');
const accounts = require('./shared/accounts');
const chromeWindows = require('./shared/chromeWindows');
const locks = require('./shared/locks');

// Thư mục dữ liệu của app. Thực tế trên máy (18/11/2026): %APPDATA%\\chrome-manager-upmedia (theo "name" của package.json).
const APP_DIR_NAMES = ['chrome-manager-upmedia', 'Chrome Manager by UP Media'];
const CACHE_MS = 20 * 1000;          // quét lại sau 20 giây (Sếp đổi tên trong app thì ~20s sau Claude thấy)
const GROUP_CONFIRM_OVER = 5;        // mở nhóm nhiều hơn số này phải có xác nhận
const BATCH_DELAY_MS = 400;          // giãn cách khi mở nhiều Chrome (app dùng 350ms)

// ── Chuẩn hóa để tìm kiếm (giống normalizeSearch trong renderer.js) ──
function normalizeSearch(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Cấu hình của app ─────────────────────────────────────
function findConfigPath(env = process.env) {
  if (env.UPM_CONFIG_PATH) return fs.existsSync(env.UPM_CONFIG_PATH) ? env.UPM_CONFIG_PATH : null;
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const n of APP_DIR_NAMES) {
    const p = path.join(appData, n, 'config.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadAppConfig(configPath) {
  const empty = { profiles: {}, settings: {}, groups: [], groupSubs: {} };
  if (!configPath) return { ...empty, _missing: true };
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      profiles: cfg.profiles || {},
      settings: cfg.settings || {},
      groups: Array.isArray(cfg.groups) ? cfg.groups : [],
      groupSubs: cfg.groupSubs || {},
    };
  } catch {
    return { ...empty, _error: true };
  }
}

// ── Ghi chú an toàn ──────────────────────────────────────
// Ghi chú trong app có thể chứa mật khẩu, mã 2FA, cookie (thấy khi test 19/11/2026) → KHÔNG bao giờ gửi nguyên văn cho Claude.
// Chỉ lấy ĐOẠN ĐẦU (trước xuống dòng / tab / "|"), tối đa 80 ký tự; đoạn đầu trông như thông tin đăng nhập thì ẩn hẳn.
const SECRET_HINT_RE = /(pass|mật\s*khẩu|mat\s*khau|\b2fa\b|\botp\b|cookie|token|c_user|\bxs=|datr=|\bfr=|sessionid|bearer|EAA[A-Za-z0-9]{10,}|[A-Za-z0-9+\/_=-]{24,})/i;
const NOTE_HIDDEN = '(ghi chú có thể chứa thông tin đăng nhập — đã ẩn)';
function looksSecret(text) {
  const s = String(text || '');
  if (SECRET_HINT_RE.test(s)) return true;
  // một "từ" ≥ 8 ký tự trộn chữ thường + chữ hoa + số → nhiều khả năng là mật khẩu
  return s.split(/\s+/).some(w => w.length >= 8 && /[a-z]/.test(w) && /[A-Z]/.test(w) && /\d/.test(w));
}
function firstNoteSegment(notes) {
  return String(notes || '').split(/[\r\n\t|]/).map(x => x.trim()).find(Boolean) || '';
}
// Ghi chú để HIỂN THỊ cho Claude
function safeNote(notes) {
  const first = firstNoteSegment(notes);
  if (!first) return '';
  if (looksSecret(first)) return NOTE_HIDDEN;
  return first.length > 80 ? first.slice(0, 80) + '…' : first;
}
// Ghi chú để TÌM KIẾM (chỉ đoạn đầu, bỏ nếu trông như thông tin đăng nhập)
function searchableNote(notes) {
  const first = firstNoteSegment(notes);
  return first && !looksSecret(first) ? first : '';
}

// Gộp dữ liệu Chrome + dữ liệu app thành danh sách profile gọn cho Claude
function buildProfiles(scanned, config) {
  return scanned.map(p => {
    const saved = config.profiles[p.profileDirectory] || {};
    const groups = Array.isArray(saved.groups) ? saved.groups : (saved.group ? [saved.group] : []);
    const subGroups = {};
    for (const [g, v] of Object.entries(saved.subGroups || {})) subGroups[g] = Array.isArray(v) ? v : (v ? [v] : []);
    const name = String(saved.shortcutName || '').trim() || p.chromeProfileName || p.profileDirectory;
    const emails = [...new Set([
      ...accounts.getGoogleAccounts(p.profilePath).map(a => a.email),
      p.email,
    ].filter(Boolean))];
    return {
      dir: p.profileDirectory,
      name,
      chromeName: p.chromeProfileName || '',
      groups,
      subGroups,
      note: safeNote(saved.notes),                 // KHÔNG giữ ghi chú gốc trong dữ liệu gửi cho Claude
      noteSearch: searchableNote(saved.notes),
      pinned: !!saved.pinned,
      emails,
    };
  });
}

let _cache = null;
function loadProfiles({ env = process.env, now = Date.now(), fresh = false } = {}) {
  if (!fresh && _cache && now - _cache.at < CACHE_MS && _cache.env === env) return _cache.data;
  const configPath = findConfigPath(env);
  const config = loadAppConfig(configPath);
  const custom = env.UPM_CHROME_USER_DATA || config.settings.chromeUserDataPath || null;
  const scan = chromeProfiles.scanProfiles(custom);   // ném NOT_FOUND_USER_DATA nếu không thấy Chrome
  const data = {
    profiles: buildProfiles(scan.profiles, config),
    userDataPath: scan.userDataPath,
    // Giống app: chỉ truyền --user-data-dir khi app đã lưu đường dẫn (hoặc khi bị ép qua env)
    launchUserDataPath: env.UPM_CHROME_USER_DATA || config.settings.chromeUserDataPath || null,
    groups: config.groups,
    groupSubs: config.groupSubs,
    configPath,
    configProblem: config._missing ? 'missing' : (config._error ? 'unreadable' : null),
  };
  _cache = { at: now, env, data };
  return data;
}
function clearCache() { _cache = null; }

// ── Tìm & khớp tên ───────────────────────────────────────
function allSubs(p) { return Object.values(p.subGroups).flat(); }
function haystack(p) {
  return ' ' + normalizeSearch([p.name, p.chromeName, p.dir, p.noteSearch, ...p.groups, ...allSubs(p), ...p.emails].join(' ')) + ' ';
}
function tokens(q) { return normalizeSearch(q).split(' ').filter(Boolean); }
// Mọi từ khóa đều khớp ĐẦU một từ trong chuỗi (gõ "thanh" khớp "Thanh", "an" không khớp "Thanh")
function wordStartMatch(text, toks) {
  const h = ' ' + normalizeSearch(text) + ' ';
  return toks.length > 0 && toks.every(t => h.includes(' ' + t));
}

function searchProfiles(profiles, { query, group } = {}) {
  let list = profiles;
  if (group) {
    const g = resolveGroup(profiles, group);
    list = g.profiles;
  }
  const toks = tokens(query);
  if (toks.length) list = list.filter(p => toks.every(t => haystack(p).includes(' ' + t)));
  return list;
}

// Tìm ĐÚNG MỘT profile theo tên. Ưu tiên khớp chặt → lỏng dần; trùng nhiều thì trả danh sách để hỏi lại.
function resolveProfile(profiles, ten) {
  const q = normalizeSearch(ten);
  if (!q) return { status: 'empty', matches: [] };
  const toks = q.split(' ');
  const tiers = [
    p => normalizeSearch(p.name) === q,                                               // đúng tên đặt trong app
    p => normalizeSearch(p.dir) === q || (/^\d+$/.test(q) && normalizeSearch(p.dir) === 'profile ' + q), // "Profile 14" / "14"
    p => normalizeSearch(p.chromeName) === q || p.emails.some(e => normalizeSearch(e) === q), // tên trong Chrome / email
    p => wordStartMatch(p.name, toks) || wordStartMatch(p.chromeName, toks),            // tên chứa các từ đã gõ
    p => toks.every(t => haystack(p).includes(' ' + t)),                                 // khớp ghi chú / nhóm / email
  ];
  for (const t of tiers) {
    const m = profiles.filter(t);
    if (m.length === 1) return { status: 'ok', profile: m[0], matches: m };
    if (m.length > 1) return { status: 'ambiguous', matches: m };
  }
  return { status: 'not_found', matches: [] };
}

// Nhóm cha hoặc danh mục con (vd "Social", "FB", "Nhân sự UP / HCTH")
function resolveGroup(profiles, nhom, danhMucCon) {
  const g = normalizeSearch(nhom);
  const s = normalizeSearch(danhMucCon);
  let list = [];
  let kind = null;
  if (g) {
    list = profiles.filter(p => p.groups.some(x => normalizeSearch(x) === g));
    kind = list.length ? 'group' : null;
    if (!list.length) {                                   // không phải nhóm cha → thử danh mục con
      list = profiles.filter(p => allSubs(p).some(x => normalizeSearch(x) === g));
      kind = list.length ? 'sub' : null;
    }
  }
  if (s && list.length) {
    list = list.filter(p => Object.entries(p.subGroups).some(([pg, subs]) =>
      (kind !== 'group' || normalizeSearch(pg) === g) && subs.some(x => normalizeSearch(x) === s)));
  }
  return { kind, profiles: list };
}

// ── URL ──────────────────────────────────────────────────
// Chỉ nhận http/https. Thiếu "https://" thì tự thêm. Trả về href chuẩn (không bao giờ bắt đầu bằng "--",
// nên không thể chèn tham số dòng lệnh cho Chrome).
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

// ── Chrome đang mở: dùng CHUNG module của app (shared/chromeWindows.js) ──
// Chrome gom mọi profile vào 1 tiến trình nên KHÔNG đọc dòng lệnh được. Gộp 2 nguồn:
//  - khóa file (nhanh, nhưng profile vừa mở có thể chưa khóa) · - cửa sổ Chrome (chắc chắn, ~1 giây PowerShell)
function fakeSet(v) { return new Set(String(v || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)); }
function getLockedDirs(userDataPath, env = process.env) {
  if (env.UPM_MCP_FAKE_RUNNING != null) return fakeSet(env.UPM_MCP_FAKE_RUNNING);   // cho test
  try { return chromeWindows.getLoadedProfileDirs(userDataPath); } catch { return new Set(); }
}
async function getOpenDirs(userDataPath, env = process.env) {
  const lock = getLockedDirs(userDataPath, env);
  let win = new Set(), winOk = false;
  if (env.UPM_MCP_FAKE_RUNNING != null) {             // cho test: profile trong FAKE_NOWINDOW chỉ khóa file, không có cửa sổ
    const noWin = fakeSet(env.UPM_MCP_FAKE_NOWINDOW);
    win = new Set([...lock].filter(d => !noWin.has(d))); winOk = true;
  } else {
    const r = await chromeWindows.listChromeWindows();
    winOk = r.ok;
    for (const w of r.windows) if (w.dir) win.add(w.dir.toLowerCase());
  }
  return { dirs: new Set([...lock, ...win]), lock, win, winOk };
}

// ── Mở Chrome ────────────────────────────────────────────
function chromeCandidates(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    env.UPM_CHROME_EXE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}
function findChrome(env = process.env) {
  return chromeCandidates(env).find(p => fs.existsSync(p)) || null;
}
function buildChromeArgs(dir, { url, userDataPath } = {}) {
  const args = [`--profile-directory=${dir}`, '--no-first-run', '--no-default-browser-check'];
  if (userDataPath) args.push(`--user-data-dir=${userDataPath}`);
  if (url) args.push(url);
  return args;
}
// Trả về { dryRun, exe, args }. Chế độ chạy khô (UPM_MCP_DRY_RUN=1) chỉ ghi lại, không mở thật — dùng cho test.
function launchChrome(dir, opts = {}, env = process.env) {
  const args = buildChromeArgs(dir, opts);
  if (env.UPM_MCP_DRY_RUN) return { dryRun: true, exe: 'chrome.exe', args };
  const exe = findChrome(env);
  if (!exe) throw new Error('CHROME_NOT_FOUND');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { dryRun: false, exe, args };
}

// ── Đưa đúng cửa sổ của profile lên trước (module chung) → {success} | {notFound} | {blocked} ──
function focusProfileWindow(dir, env = process.env) {
  if (env.UPM_MCP_DRY_RUN) {                          // cho test: có cửa sổ = nằm trong FAKE_RUNNING và không nằm trong FAKE_NOWINDOW
    const d = String(dir).toLowerCase();
    const hasWin = fakeSet(env.UPM_MCP_FAKE_RUNNING).has(d) && !fakeSet(env.UPM_MCP_FAKE_NOWINDOW).has(d);
    return Promise.resolve(hasWin ? { success: true, dryRun: true } : { success: false, notFound: true, dryRun: true });
  }
  return chromeWindows.focusProfileWindow(dir);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Khóa Chrome bằng mã + cảnh báo khi mở (app v1.11) ─────
// Cổng ĐỌC dữ liệu khóa của app (locks.json + bản dự phòng + dấu niêm phong trong registry), không bao giờ ghi.
// Không có khóa bí mật của app (mã hóa DPAPI) nên chỉ so bộ đếm + mã niêm phong với registry: lệch → khóa TOÀN BỘ.
// Chrome đang khóa: KHÔNG mở, KHÔNG đưa cửa sổ lên, ẩn email / ghi chú. Cổng không bao giờ hỏi hay nhận mã.
// Đọc mới mỗi lần gọi lệnh (không dùng bộ nhớ đệm 20 giây) để khóa có hiệu lực ngay.
const LOCK_REG_KEY = 'HKCU\\Software\\UP Media\\Chrome Manager';
function lockPaths(configPath, env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = configPath ? path.dirname(configPath) : path.join(appData, APP_DIR_NAMES[0]);
  return {
    primary: env.UPM_LOCKS_PATH || path.join(dir, 'locks.json'),
    mirror: env.UPM_LOCKS_MIRROR || path.join(local, 'UP Media', 'Chrome Manager', 'locks-backup.json'),
  };
}
function readLockSeal(env = process.env) {
  if (env.UPM_LOCK_SEAL != null) return env.UPM_LOCK_SEAL || null;     // cho test ('' = không có dấu niêm phong)
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', LOCK_REG_KEY, '/v', 'LockSeal'], { windowsHide: true, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /LockSeal\s+REG_SZ\s+(\S+)/.exec(out || '');
    return m ? m[1] : null;
  } catch { return null; }
}
function loadLocks(configPath, env = process.env) {
  const p = lockPaths(configPath, env);
  const primary = locks.readDocFile(p.primary), mirror = locks.readDocFile(p.mirror);
  const ev = locks.evaluateUnverified({ primary, mirror, seal: locks.parseSeal(readLockSeal(env)) });
  // App đã từng bật khóa (còn khóa bí mật) mà mất cả 2 file dữ liệu → coi như bị xóa, khóa toàn bộ (app sẽ tự khôi phục)
  const keyFile = path.join(path.dirname(p.primary), 'lock.key');
  const wiped = !!(primary.missing && mirror.missing && fs.existsSync(keyFile));
  const failClosed = ev.failClosed || wiped;
  const ctx = { failClosed, failClosedDirs: failClosed ? 'all' : new Set() };
  // Khóa theo CẢ 2 bản (file chính + dự phòng): một bản còn khóa là coi như khóa (sửa 1 bản không gỡ được khóa với Claude)
  const states = [primary, mirror].filter(r => r.doc).map(r => r.doc.state);
  if (!states.length) states.push(ev.state);
  return {
    failClosed,
    lockOf: dir => { for (const st of states) { const L = locks.lockOf(st, dir, ctx); if (L) return L; } return null; },
    warningsFor: p2 => locks.warningsFor(ev.state, p2.dir, p2.groups),
  };
}
// Gắn trạng thái khóa vào danh sách; Chrome khóa bị ẩn ghi chú + email (giống app)
function applyLocks(profiles, lk) {
  return profiles.map(p => {
    const L = lk.lockOf(p.dir);
    return L ? { ...p, lock: L, note: '', noteSearch: '', emails: [] } : { ...p, lock: null };
  });
}
function lockText(L) {
  if (!L) return '';
  if (L.type === 'group') return `khóa theo nhóm "${L.group}"`;
  if (L.type === 'chrome') return 'khóa riêng';
  return 'khóa toàn bộ (dữ liệu khóa có dấu hiệu bị sửa)';
}

module.exports = {
  normalizeSearch, findConfigPath, loadAppConfig, buildProfiles, loadProfiles, clearCache,
  searchProfiles, resolveProfile, resolveGroup, normalizeUrl,
  getLockedDirs, getOpenDirs, findChrome, buildChromeArgs, launchChrome, sleep, focusProfileWindow,
  safeNote, searchableNote,
  lockPaths, readLockSeal, loadLocks, applyLocks, lockText,
  GROUP_CONFIRM_OVER, BATCH_DELAY_MS,
};
