// Khóa Chrome bằng mã + cảnh báo khi mở + chống sửa file (v1.11).
// KHÔNG phụ thuộc Electron: app (main.js) và cổng MCP (mcp-server, bản chép qua npm run sync) dùng chung.
//
// Mô hình (Sếp chốt 19/11/2026):
//  - Mã CEO (cửa sau): mở mọi Chrome/nhóm khóa; tạo, gỡ khóa; cấp lại mọi mã. Kèm MÃ KHẨN CẤP (hiện 1 lần khi đặt) để đặt lại mã CEO.
//  - Khóa nhóm (nhóm cha có sẵn) hoặc khóa riêng 1 Chrome. MỖI CHROME CHỈ 1 LỚP KHÓA. Thành viên nhóm khóa lưu NGAY TRONG
//    dữ liệu khóa (không tin config.json — sửa config.json không gỡ được khóa).
//  - Mã nhóm (CEO cấp, gửi tay qua Fiine): mở Chrome trong nhóm; thêm Chrome CHƯA khóa vào nhóm; gỡ Chrome ra khỏi nhóm.
//  - Cảnh báo (pop-up mỗi lần mở) theo nhóm và theo từng Chrome, nhân sự tự cài; mỗi cảnh báo có MÃ CẢNH BÁO riêng
//    (sửa/tắt cần mã đó, hoặc mã khóa của chính nhóm/Chrome, hoặc mã CEO; CEO đặt lại được).
//  - Mở khóa đến khi tắt Chrome đó: trạng thái "đang mở khóa" nằm trong bộ nhớ của app (main.js), không lưu ở đây.
//  - Chống sửa file: dữ liệu khóa niêm phong HMAC-SHA256 bằng khóa bí mật, lưu 2 bản (chính + dự phòng).
//    "Bản neo" = bản trạng thái mới nhất cất cùng khóa bí mật (app mã hóa bằng Windows DPAPI qua safeStorage) → file bị
//    sửa / xóa / chép đè bản cũ thì khôi phục từ bản neo; khôi phục KHÔNG BAO GIỜ tin mã CEO trong file chưa kiểm được.
//    Dấu niêm phong (bộ đếm:mac) còn ghi vào registry cho cổng MCP (không có khóa bí mật). Sửa/xóa/quay về bản cũ →
//    khôi phục từ bản còn đúng; không còn bản nào đáng tin thì KHÓA TOÀN BỘ Chrome tới khi nhập mã CEO (hoặc mã khẩn cấp);
//    mất cả khóa bí mật lẫn mã CEO kiểm được → chỉ còn cách "đặt lại từ đầu" (mất hết khóa, ghi nhật ký).
// Mã chỉ lưu dạng băm scrypt (không đọc ngược được).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_EVENTS = 200;

class LockError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

// ── Mã ───────────────────────────────────────────────────
function normCode(s) { return String(s == null ? '' : s).normalize('NFC').trim(); }

function hashSecret(secret, salt) {
  const s = salt ? Buffer.from(salt, 'base64') : crypto.randomBytes(16);
  const h = crypto.scryptSync(normCode(secret), s, 32, SCRYPT_OPTS);
  return { salt: s.toString('base64'), hash: h.toString('base64') };
}
function verifySecret(secret, rec) {
  const c = normCode(secret);
  if (!c || !rec || !rec.salt || !rec.hash) return false;
  let h;
  try { h = crypto.scryptSync(c, Buffer.from(rec.salt, 'base64'), 32, SCRYPT_OPTS); } catch { return false; }
  const ref = Buffer.from(rec.hash, 'base64');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}

function generatePin(digits = 6) {
  let s = '';
  for (let i = 0; i < digits; i++) s += crypto.randomInt(0, 10);
  return s;
}
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // bỏ I, L, O, 0, 1 cho dễ đọc
function generateRecoveryKey() {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += RECOVERY_ALPHABET[crypto.randomInt(0, RECOVERY_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');                                        // ~98 bit
}
function normRecovery(s) { return normCode(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function validateCeoCode(code) {
  const c = normCode(code);
  if (c.length < 8) throw new LockError('WEAK_CEO', 'Mã CEO cần ít nhất 8 ký tự.');
  if (new Set(c).size < 4) throw new LockError('WEAK_CEO', 'Mã CEO quá dễ đoán (cần ít nhất 4 ký tự khác nhau).');
  return c;
}
function validatePin(pin, label = 'Mã') {
  const c = normCode(pin);
  if (c.length < 4 || c.length > 32) throw new LockError('BAD_PIN', `${label} cần từ 4 đến 32 ký tự.`);
  return c;
}

// ── Trạng thái ───────────────────────────────────────────
function emptyState() {
  return { v: 1, counter: 0, ceo: null, recovery: null, groupLocks: {}, chromeLocks: {}, warnings: { groups: {}, chromes: {} }, events: [] };
}
function cloneState(s) {
  const c = JSON.parse(JSON.stringify(s || emptyState()));
  c.groupLocks = c.groupLocks || {}; c.chromeLocks = c.chromeLocks || {};
  c.warnings = c.warnings || {}; c.warnings.groups = c.warnings.groups || {}; c.warnings.chromes = c.warnings.chromes || {};
  c.events = Array.isArray(c.events) ? c.events : [];
  return c;
}
function addEvent(state, type, detail, at = Date.now()) {
  state.events.push({ at, type, detail: detail || '' });
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
}
function isEnabled(state) { return !!(state && state.ceo); }

// Thư mục profile so KHÔNG phân biệt hoa thường (Windows không phân biệt: "profile 3" = "Profile 3")
const dk = d => String(d == null ? '' : d).toLowerCase();
function chromeLockRec(state, dir) {
  const locksMap = (state && state.chromeLocks) || {};
  if (locksMap[dir]) return locksMap[dir];
  const k = Object.keys(locksMap).find(x => dk(x) === dk(dir));
  return k ? locksMap[k] : null;
}
function groupLockOf(state, dir) {
  for (const [g, L] of Object.entries((state && state.groupLocks) || {})) {
    if ((L.members || []).some(m => dk(m) === dk(dir))) return g;
  }
  return null;
}
// Khóa đang áp lên 1 Chrome: { type:'chrome' } | { type:'group', group } | { type:'all' } (khóa toàn bộ khi phát hiện sửa file) | null
function lockOf(state, dir, ctx) {
  if (ctx && ctx.failClosed) {
    if (ctx.failClosedDirs === 'all' || (ctx.failClosedDirs && (ctx.failClosedDirs.has(dir) || ctx.failClosedDirs.has(dk(dir))))) return { type: 'all' };
  }
  if (!state) return null;
  if (chromeLockRec(state, dir)) return { type: 'chrome' };
  const g = groupLockOf(state, dir);
  return g ? { type: 'group', group: g } : null;
}
function lockedDirs(state) {
  const set = new Set(Object.keys((state && state.chromeLocks) || {}));
  for (const L of Object.values((state && state.groupLocks) || {})) for (const d of (L.members || [])) set.add(d);
  return set;
}

function requireEnabled(state) { if (!isEnabled(state)) throw new LockError('NOT_ENABLED', 'Chưa bật tính năng khóa (chưa đặt mã CEO).'); }
function isCeo(state, code) { return isEnabled(state) && verifySecret(code, state.ceo); }
function requireCeo(state, code) {
  requireEnabled(state);
  if (!isCeo(state, code)) throw new LockError('BAD_CODE', 'Mã CEO không đúng.');
}

// Mã nào mở được Chrome này: 'ceo' | 'pin' | null
function checkOpenCode(state, dir, code, ctx) {
  const L = lockOf(state, dir, ctx);
  if (!L) return 'free';
  if (isCeo(state, code)) return 'ceo';
  if (L.type === 'chrome') return verifySecret(code, chromeLockRec(state, dir).pin) ? 'pin' : null;
  if (L.type === 'group') return verifySecret(code, state.groupLocks[L.group].pin) ? 'pin' : null;
  return null;                                                    // khóa toàn bộ: chỉ mã CEO
}

// ── Thao tác (thuần: trả về trạng thái MỚI, không sửa trạng thái cũ) ──
function setupCeo(prev, ceoCode, at = Date.now()) {
  const s = cloneState(prev);
  if (isEnabled(s)) throw new LockError('ALREADY', 'Đã có mã CEO. Muốn đổi thì dùng "Đổi mã CEO".');
  const c = validateCeoCode(ceoCode);
  const recoveryKey = generateRecoveryKey();
  s.ceo = hashSecret(c); s.recovery = hashSecret(normRecovery(recoveryKey));
  addEvent(s, 'setup', 'Bật tính năng khóa, đặt mã CEO', at);
  return { state: s, recoveryKey };
}

// Đổi mã CEO bằng mã CEO cũ HOẶC mã khẩn cấp (dùng mã khẩn cấp thì cấp mã khẩn cấp mới)
function changeCeo(prev, oldCodeOrRecovery, newCode, at = Date.now()) {
  const s = cloneState(prev);
  requireEnabled(s);
  const c = validateCeoCode(newCode);
  let via = null;
  if (verifySecret(oldCodeOrRecovery, s.ceo)) via = 'ceo';
  else if (verifySecret(normRecovery(oldCodeOrRecovery), s.recovery)) via = 'recovery';
  if (!via) throw new LockError('BAD_CODE', 'Mã CEO cũ (hoặc mã khẩn cấp) không đúng.');
  s.ceo = hashSecret(c);
  let recoveryKey = null;
  if (via === 'recovery') { recoveryKey = generateRecoveryKey(); s.recovery = hashSecret(normRecovery(recoveryKey)); }
  addEvent(s, 'ceo-change', via === 'recovery' ? 'Đặt lại mã CEO bằng mã khẩn cấp' : 'Đổi mã CEO', at);
  return { state: s, recoveryKey };
}

function lockChrome(prev, ceoCode, dir, pin, at = Date.now()) {
  const s = cloneState(prev);
  requireCeo(s, ceoCode);
  if (!dir) throw new LockError('BAD_TARGET', 'Thiếu Chrome cần khóa.');
  const cur = lockOf(s, dir);
  if (cur) throw new LockError('ONE_LAYER', cur.type === 'group'
    ? `Chrome này đang thuộc nhóm khóa "${cur.group}". Mỗi Chrome chỉ 1 lớp khóa.`
    : 'Chrome này đã khóa riêng.');
  const p = pin ? validatePin(pin, 'Mã khóa') : generatePin();
  s.chromeLocks[dir] = { pin: hashSecret(p), createdAt: at };
  addEvent(s, 'lock-chrome', dir, at);
  return { state: s, pin: p };
}

function lockGroup(prev, ceoCode, group, members, pin, at = Date.now()) {
  const s = cloneState(prev);
  requireCeo(s, ceoCode);
  if (!group) throw new LockError('BAD_TARGET', 'Thiếu tên nhóm.');
  if (s.groupLocks[group]) throw new LockError('ALREADY', `Nhóm "${group}" đã khóa.`);
  const list = [...new Set(members || [])];
  const conflicts = list.filter(d => lockOf(s, d));
  if (conflicts.length) throw new LockError('ONE_LAYER', `Có ${conflicts.length} Chrome trong nhóm đang có khóa khác (mỗi Chrome chỉ 1 lớp khóa): ${conflicts.join(', ')}. Gỡ khóa đó trước hoặc bỏ Chrome đó khỏi nhóm.`, { conflicts });
  const p = pin ? validatePin(pin, 'Mã nhóm') : generatePin();
  s.groupLocks[group] = { pin: hashSecret(p), members: list, createdAt: at };
  addEvent(s, 'lock-group', `${group} (${list.length} Chrome)`, at);
  return { state: s, pin: p };
}

// Gỡ khóa (chỉ mã CEO). target: { type:'chrome', dir } | { type:'group', group }
function removeLock(prev, ceoCode, target, at = Date.now()) {
  const s = cloneState(prev);
  requireCeo(s, ceoCode);
  if (target.type === 'chrome') {
    const k = Object.keys(s.chromeLocks).find(x => dk(x) === dk(target.dir));
    if (!k) throw new LockError('NOT_LOCKED', 'Chrome này không khóa riêng.');
    delete s.chromeLocks[k];
    addEvent(s, 'unlock-chrome', target.dir, at);
  } else {
    if (!s.groupLocks[target.group]) throw new LockError('NOT_LOCKED', `Nhóm "${target.group}" không khóa.`);
    delete s.groupLocks[target.group];
    addEvent(s, 'unlock-group', target.group, at);
  }
  return { state: s };
}

// Cấp lại mã khóa (chỉ mã CEO)
function resetPin(prev, ceoCode, target, pin, at = Date.now()) {
  const s = cloneState(prev);
  requireCeo(s, ceoCode);
  const rec = target.type === 'chrome' ? chromeLockRec(s, target.dir) : s.groupLocks[target.group];
  if (!rec) throw new LockError('NOT_LOCKED', 'Mục này chưa khóa.');
  const p = pin ? validatePin(pin, 'Mã khóa') : generatePin();
  rec.pin = hashSecret(p);
  addEvent(s, 'reset-pin', target.type === 'chrome' ? target.dir : target.group, at);
  return { state: s, pin: p };
}

function requireGroupAuth(s, group, code) {
  const L = s.groupLocks[group];
  if (!L) throw new LockError('NOT_LOCKED', `Nhóm "${group}" không khóa.`);
  if (isCeo(s, code) || verifySecret(code, L.pin)) return L;
  throw new LockError('BAD_CODE', `Mã nhóm "${group}" không đúng.`);
}

// Thêm Chrome CHƯA khóa vào nhóm khóa (mã nhóm hoặc mã CEO)
function addMember(prev, code, group, dir, at = Date.now()) {
  const s = cloneState(prev);
  const L = requireGroupAuth(s, group, code);
  const cur = lockOf(s, dir);
  if (cur && !(cur.type === 'group' && cur.group === group)) throw new LockError('ONE_LAYER', cur.type === 'group'
    ? `Chrome này đang thuộc nhóm khóa "${cur.group}". Mỗi Chrome chỉ 1 lớp khóa.`
    : 'Chrome này đang khóa riêng. Mỗi Chrome chỉ 1 lớp khóa — cần mã CEO gỡ khóa riêng trước.');
  if (!L.members.some(m => dk(m) === dk(dir))) L.members.push(dir);
  addEvent(s, 'add-member', `${dir} → ${group}`, at);
  return { state: s };
}

// Gỡ Chrome khỏi nhóm khóa (mã nhóm hoặc mã CEO) → Chrome hết khóa
function removeMember(prev, code, group, dir, at = Date.now()) {
  const s = cloneState(prev);
  const L = requireGroupAuth(s, group, code);
  L.members = L.members.filter(d => dk(d) !== dk(dir));
  addEvent(s, 'remove-member', `${dir} ← ${group}`, at);
  return { state: s };
}

// Đổi tên nhóm: nhóm khóa cần mã nhóm/CEO; cảnh báo nhóm đi theo tên mới
function renameGroup(prev, code, oldName, newName, at = Date.now()) {
  const s = cloneState(prev);
  if (!newName || oldName === newName) return { state: s };
  if (s.groupLocks[newName] || s.warnings.groups[newName]) throw new LockError('ALREADY', `Đã có nhóm "${newName}" đang khóa hoặc có cảnh báo — đổi sang tên khác.`);
  if (s.groupLocks[oldName]) {
    requireGroupAuth(s, oldName, code);
    s.groupLocks[newName] = s.groupLocks[oldName]; delete s.groupLocks[oldName];
  }
  if (s.warnings.groups[oldName]) { s.warnings.groups[newName] = s.warnings.groups[oldName]; delete s.warnings.groups[oldName]; }
  addEvent(s, 'rename-group', `${oldName} → ${newName}`, at);
  return { state: s };
}

// Xóa nhóm: nhóm khóa chỉ mã CEO xóa được (tránh chủ nhóm xóa nhóm để gỡ khóa hàng loạt)
function deleteGroup(prev, code, group, at = Date.now()) {
  const s = cloneState(prev);
  if (s.groupLocks[group]) { requireCeo(s, code); delete s.groupLocks[group]; }
  const w = s.warnings.groups[group];
  if (w && w.code && !isCeo(s, code) && !verifySecret(code, w.code)) {
    throw new LockError('BAD_CODE', `Nhóm "${group}" có cảnh báo có mã — cần mã cảnh báo của nhóm hoặc mã CEO để xóa nhóm.`);
  }
  delete s.warnings.groups[group];
  addEvent(s, 'delete-group', group, at);
  return { state: s };
}

// ── Cảnh báo ─────────────────────────────────────────────
// target: { type:'group', group } | { type:'chrome', dir }
function warningRec(s, target) { return target.type === 'group' ? s.warnings.groups[target.group] : s.warnings.chromes[target.dir]; }
function lockPinOf(s, target) {
  if (target.type === 'group') return s.groupLocks[target.group] && s.groupLocks[target.group].pin;
  const c = chromeLockRec(s, target.dir);
  if (c) return c.pin;
  const g = groupLockOf(s, target.dir);                       // Chrome khóa theo nhóm: mã nhóm là mã khóa của Chrome đó
  return g ? s.groupLocks[g].pin : null;
}
// Ai được sửa cảnh báo: mã cảnh báo hiện có / mã khóa của chính nhóm-Chrome đó / mã CEO.
// Cảnh báo MỚI trên mục CHƯA khóa: ai cũng tạo được nhưng phải đặt mã cảnh báo.
function canEditWarning(s, target, code) {
  const rec = warningRec(s, target);
  if (isCeo(s, code)) return 'ceo';
  const lp = lockPinOf(s, target);
  if (lp && verifySecret(code, lp)) return 'pin';
  if (rec && rec.code && verifySecret(code, rec.code)) return 'warning';
  if (!rec && !lp) return 'new';
  return null;
}

// opts: { text, enabled, newCode } ; text rỗng + enabled=false = xóa cảnh báo
function setWarning(prev, target, code, opts, at = Date.now()) {
  const s = cloneState(prev);
  // Cảnh báo MỚI trên mục chưa khóa: bắt buộc đặt mã cảnh báo (kể cả CEO) — kiểm TRƯỚC khi kiểm mã,
  // để lệnh này không thành chỗ dò mã CEO không giới hạn.
  if (!warningRec(s, target) && !lockPinOf(s, target) && !(opts && opts.newCode)) {
    throw new LockError('NEED_CODE', 'Đặt mã cảnh báo (4–32 ký tự) để người khác không tắt được cảnh báo của Sếp/nhân sự.');
  }
  const auth = canEditWarning(s, target, code);
  if (!auth) throw new LockError('BAD_CODE', 'Mã không đúng (cần mã cảnh báo, mã khóa của mục này hoặc mã CEO).');
  const text = String((opts && opts.text) || '').trim().slice(0, 2000);
  const bucket = target.type === 'group' ? s.warnings.groups : s.warnings.chromes;
  const key = target.type === 'group' ? target.group : target.dir;
  if (!text && opts && opts.enabled === false && !(opts && opts.newCode)) {
    delete bucket[key];
    addEvent(s, 'warning-delete', key, at);
    return { state: s };
  }
  const old = bucket[key];
  let codeRec = old ? old.code : null;
  if (opts && opts.newCode) codeRec = hashSecret(validatePin(opts.newCode, 'Mã cảnh báo'));
  if (!codeRec && auth === 'new') throw new LockError('NEED_CODE', 'Đặt mã cảnh báo (4–32 ký tự) để người khác không tắt được cảnh báo của Sếp/nhân sự.');
  bucket[key] = { text, enabled: opts && opts.enabled !== undefined ? !!opts.enabled : true, code: codeRec, updatedAt: at };
  addEvent(s, 'warning-set', key, at);
  return { state: s };
}

// Cảnh báo áp lên 1 Chrome khi mở: nhóm (theo config + nhóm khóa) rồi tới Chrome
function warningsFor(state, dir, configGroups) {
  const out = [];
  if (!state || !state.warnings) return out;
  const groups = new Set(configGroups || []);
  const L = lockOf(state, dir); if (L && L.type === 'group') groups.add(L.group);
  for (const g of groups) {
    const w = state.warnings.groups[g];
    if (w && w.enabled && w.text) out.push({ source: 'group', name: g, text: w.text });
  }
  const c = state.warnings.chromes[dir];
  if (c && c.enabled && c.text) out.push({ source: 'chrome', name: dir, text: c.text });
  return out;
}

// Thông tin công khai (không có mã băm) cho giao diện / cổng MCP
function publicView(state, ctx) {
  const s = state || emptyState();
  const pubW = b => Object.fromEntries(Object.entries(b || {}).map(([k, w]) => [k, { text: w.text, enabled: !!w.enabled, hasCode: !!w.code }]));
  return {
    enabled: isEnabled(s),
    failClosed: !!(ctx && ctx.failClosed),
    failClosedAll: !!(ctx && ctx.failClosed && ctx.failClosedDirs === 'all'),
    failClosedDirs: ctx && ctx.failClosed && ctx.failClosedDirs !== 'all' ? [...(ctx.failClosedDirs || [])] : [],
    chromeLocks: Object.keys(s.chromeLocks || {}),
    groupLocks: Object.fromEntries(Object.entries(s.groupLocks || {}).map(([g, L]) => [g, [...(L.members || [])]])),
    warnings: { groups: pubW(s.warnings && s.warnings.groups), chromes: pubW(s.warnings && s.warnings.chromes) },
    eventCount: (s.events || []).length,
  };
}

// Tin nhắn cấp mã để dán vào Fiine
function fiineMessage({ kind, name, pin, chromeNames }) {
  const lines = [
    kind === 'group' ? `🔒 Mã mở nhóm Chrome "${name}": ${pin}` : `🔒 Mã mở Chrome "${name}": ${pin}`,
  ];
  if (kind === 'group' && chromeNames && chromeNames.length) lines.push(`Gồm ${chromeNames.length} Chrome: ${chromeNames.join(', ')}`);
  lines.push('Cách dùng: mở Chrome Manager by UP Media → bấm mở Chrome → nhập mã khi được hỏi. Chrome giữ mở khóa tới khi tắt Chrome đó.');
  if (kind === 'group') lines.push('Mã nhóm cũng dùng để thêm Chrome chưa khóa vào nhóm hoặc gỡ Chrome ra khỏi nhóm.');
  lines.push('Không chia sẻ mã này cho người khác.');
  return lines.join('\n');
}

// ── Niêm phong + lưu trữ ─────────────────────────────────
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function macOf(state, key) { return crypto.createHmac('sha256', key).update(canonical(state)).digest('base64'); }
function sealDoc(state, key) { return { state, mac: macOf(state, key) }; }
function verifyDoc(doc, key) {
  if (!doc || !doc.state || typeof doc.mac !== 'string' || !key) return false;
  const a = Buffer.from(doc.mac, 'base64'), b = Buffer.from(macOf(doc.state, key), 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sealString(doc) { return `${doc.state.counter}:${doc.mac}`; }
function parseSeal(s) {
  const m = /^(\d+):([A-Za-z0-9+/=]+)$/.exec(String(s || '').trim());
  return m ? { counter: Number(m[1]), mac: m[2] } : null;
}

// Đọc file tài liệu khóa: { missing } | { corrupt } | { doc }
function readDocFile(file, fsi = fs) {
  let raw;
  try { raw = fsi.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { corrupt: true }; }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !doc.state || typeof doc.state !== 'object') return { corrupt: true };
    return { doc };
  } catch { return { corrupt: true }; }
}
function writeFileAtomic(file, text, fsi = fs) {
  fsi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fsi.writeFileSync(tmp, text, 'utf8');
  fsi.renameSync(tmp, file);
}

// Đánh giá KHÔNG có khóa bí mật (cổng MCP; hoặc app khi mất khóa): dữ liệu có bị đụng không.
// Không kiểm được chữ ký nên chỉ so bộ đếm + mac với dấu niêm phong. Có dấu hiệu bị đụng → khóa TOÀN BỘ
// (người sửa file có thể đã xóa luôn dấu vết Chrome nào từng khóa; CEO nhập mã 1 lần để mở lại).
function evaluateUnverified({ primary, mirror, seal }) {
  const docs = [primary, mirror].filter(r => r && r.doc).map(r => r.doc);
  const best = docs.slice().sort((a, b) => (b.state.counter || 0) - (a.state.counter || 0))[0];
  const anyData = docs.length > 0 || (primary && primary.corrupt) || (mirror && mirror.corrupt);
  if (!anyData && !seal) return { state: emptyState(), failClosed: false, failClosedDirs: new Set() };
  let failClosed = false;
  if (seal) {
    const primaryOk = !!(primary && primary.doc && primary.doc.state.counter === seal.counter && primary.doc.mac === seal.mac);
    if (!primaryOk) failClosed = true;
  } else if ((primary && primary.corrupt) || (mirror && mirror.corrupt) || (primary && primary.missing && mirror && mirror.doc)) {
    failClosed = true;
  }
  return { state: best ? cloneState(best.state) : emptyState(), failClosed, failClosedDirs: failClosed ? 'all' : new Set() };
}

// Gói khóa bí mật + BẢN NEO, keyStore cất dạng chuỗi (app mã hóa bằng Windows DPAPI qua safeStorage):
// { v:2, k:<khóa base64>, s:<toàn bộ trạng thái khóa mới nhất> }. Bản neo là bản đáng tin nhất (người sửa file
// thường không sửa được bản đã mã hóa): file khóa bị sửa / xóa / chép đè bản cũ → khôi phục từ bản neo.
function packBlob(key, state) { return JSON.stringify({ v: 2, k: key.toString('base64'), s: state }); }
function parseBlob(raw) {
  if (raw == null) return null;
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 32) return { key: raw, state: null };            // dạng cũ: chỉ có khóa
    raw = raw.toString('utf8');
  }
  try {
    const o = JSON.parse(String(raw));
    const key = Buffer.from(String((o && o.k) || ''), 'base64');
    if (key.length !== 32) return null;
    const st = o.s && typeof o.s === 'object' ? cloneState(o.s) : null;
    return { key, state: st };
  } catch { return null; }
}

// Kho dữ liệu khóa: file chính + bản dự phòng (ký HMAC) + bản neo (mã hóa DPAPI, giữ khóa bí mật) + dấu niêm phong registry.
// keyStore: { load(): string|Buffer|null, save(string) } · sealStore: { read(): string|null, write(string) }
function createLockStore({ primaryPath, mirrorPath, keyStore, sealStore, fsi = fs, now = () => Date.now() }) {
  let key = null;
  const safe = f => { try { return f(); } catch { return null; } };

  // Ghi: file chính (lỗi → báo lỗi thao tác) → bản dự phòng → bản neo (lỗi → báo lỗi) → dấu niêm phong registry
  function persist(state) {
    const s = cloneState(state);
    s.counter = (s.counter || 0) + 1;
    if (!key) key = crypto.randomBytes(32);
    const doc = sealDoc(s, key);
    const text = JSON.stringify(doc, null, 1);
    writeFileAtomic(primaryPath, text, fsi);
    try { writeFileAtomic(mirrorPath, text, fsi); } catch { /* bản dự phòng lỗi không chặn */ }
    keyStore.save(packBlob(key, s));
    try { sealStore.write(sealString(doc)); } catch { /* registry lỗi không chặn (dùng cho cổng MCP) */ }
    return s;
  }
  function failClosed(state, problem, extra) {
    return { state, status: 'failclosed', failClosed: true, failClosedDirs: 'all', problem, ...(extra || {}) };
  }

  // → { state, status: 'empty'|'ok'|'restored'|'failclosed', failClosed, failClosedDirs, problem, canReset }
  // KHÔNG ném lỗi: ghi lại bản khôi phục lỗi thì vẫn trả trạng thái đã kiểm (không bao giờ "mở toang" vì lỗi ghi).
  function load() {
    const blob = parseBlob(safe(() => keyStore.load()));
    const seal = parseSeal(safe(() => sealStore.read()));
    const primary = readDocFile(primaryPath, fsi);
    const mirror = readDocFile(mirrorPath, fsi);
    const nothing = primary.missing && mirror.missing;
    key = blob ? blob.key : null;

    if (!blob) {
      if (nothing && !seal) return { state: emptyState(), status: 'empty', failClosed: false, failClosedDirs: new Set() };
      // Mất khóa bí mật: không kiểm được chữ ký → khóa toàn bộ. Chỉ tin mã CEO / mã khẩn cấp trong file khi 2 bản
      // GIỐNG HỆT nhau và khớp dấu niêm phong; không thì chỉ còn "đặt lại từ đầu".
      const ev = evaluateUnverified({ primary, mirror, seal });
      const trusted = !!(primary.doc && mirror.doc && seal && canonical(primary.doc) === canonical(mirror.doc)
        && primary.doc.state.counter === seal.counter && primary.doc.mac === seal.mac);
      const state = cloneState(ev.state);
      if (!trusted) { state.ceo = null; state.recovery = null; }
      return failClosed(state, nothing ? 'Dữ liệu khóa và khóa bí mật bị xóa' : 'Mất khóa bí mật — không kiểm được dữ liệu khóa',
        { canReset: !isEnabled(state) && !state.recovery });
    }

    // Bản mới nhất đáng tin: bản neo, hoặc file có chữ ký đúng mới hơn (máy tắt đột ngột giữa lúc ghi file và ghi bản neo)
    const signed = [primary, mirror].filter(r => r.doc && verifyDoc(r.doc, key)).map(r => r.doc)
      .sort((a, b) => (b.state.counter || 0) - (a.state.counter || 0));
    let best = blob.state;
    if (signed[0] && (!best || (signed[0].state.counter || 0) > (best.counter || 0))) best = signed[0].state;
    if (!best) {
      const state = cloneState(evaluateUnverified({ primary, mirror, seal }).state);
      state.ceo = null; state.recovery = null;
      return failClosed(state, nothing ? 'Dữ liệu khóa bị xóa' : 'Dữ liệu khóa bị sửa', { canReset: true });
    }
    best = cloneState(best);
    // Cả bản neo lẫn file đều cũ hơn dấu niêm phong → bị chép đè bản cũ ở mọi nơi → khóa toàn bộ (mã CEO lấy từ bản neo)
    if (seal && seal.counter > (best.counter || 0)) {
      return failClosed(best, 'Dữ liệu khóa bị chép đè bằng bản cũ', { canReset: !isEnabled(best) && !best.recovery });
    }
    const bestMac = macOf(best, key);
    const isBest = r => !!(r.doc && r.doc.mac === bestMac && r.doc.state.counter === best.counter && verifyDoc(r.doc, key));
    let problem = null;
    if (!isBest(primary)) problem = primary.missing ? 'File khóa chính bị xóa — đã khôi phục' : 'File khóa chính bị sửa hoặc chép đè bản cũ — đã khôi phục';
    else if (!isBest(mirror)) problem = mirror.missing ? 'Bản dự phòng bị xóa — đã ghi lại' : 'Bản dự phòng bị sửa — đã ghi lại';
    else if (seal && (seal.counter !== best.counter || seal.mac !== bestMac)) problem = 'Dấu niêm phong trong registry bị sửa — đã ghi lại';
    const needWrite = !!problem || !seal || !blob.state || (blob.state.counter || 0) !== best.counter;
    let state = best;
    if (problem) addEvent(state, 'tamper-restored', problem, now());
    if (needWrite) {
      try { state = persist(state); }
      catch (e) { if (problem) problem += ` (chưa ghi lại được: ${(e && e.message) || e})`; }
    }
    if (problem) return { state, status: 'restored', failClosed: false, failClosedDirs: new Set(), problem };
    return { state, status: 'ok', failClosed: false, failClosedDirs: new Set() };
  }

  function save(state) { return persist(state); }

  // Khóa toàn bộ → CEO (hoặc mã khẩn cấp) xác nhận. Mã kiểm bằng dữ liệu đáng tin mà load() đã chọn
  // (bản neo / file có chữ ký / 2 bản giống hệt khớp dấu niêm phong) — không bao giờ bằng mã CEO trong file chưa kiểm được.
  function recover(loaded, code) {
    const s = cloneState(loaded.state);
    if (!isEnabled(s) && !s.recovery) throw new LockError('NO_ANCHOR', 'Không còn mã CEO nào kiểm được trên máy này — chỉ còn cách "Đặt lại từ đầu".');
    const viaCeo = isCeo(s, code);
    const viaRec = !viaCeo && s.recovery && verifySecret(normRecovery(code), s.recovery);
    if (!viaCeo && !viaRec) throw new LockError('BAD_CODE', 'Mã CEO (hoặc mã khẩn cấp) không đúng.');
    addEvent(s, 'tamper-recovered', `${loaded.problem || 'Phát hiện sửa dữ liệu khóa'} — CEO xác nhận khôi phục`, now());
    return persist(s);
  }
  // Đặt lại từ đầu: CHỈ khi không còn mã CEO / mã khẩn cấp nào kiểm được. Mọi khóa cũ bị bỏ; nhật ký cũ giữ lại.
  function reset(loaded, newCeo) {
    if (!loaded || !loaded.canReset) throw new LockError('NOT_ALLOWED', 'Chỉ đặt lại từ đầu được khi không còn mã CEO nào kiểm được.');
    const r = setupCeo(emptyState(), newCeo, now());
    r.state.events = [...((loaded.state && loaded.state.events) || []), ...r.state.events].slice(-MAX_EVENTS);
    addEvent(r.state, 'tamper-reset', `${loaded.problem || 'Mất dữ liệu khóa'} — đặt lại từ đầu, mọi khóa cũ bị bỏ`, now());
    r.state.counter = (loaded.state && loaded.state.counter) || 0;
    key = crypto.randomBytes(32);
    return { state: persist(r.state), recoveryKey: r.recoveryKey };
  }

  return { load, save, recover, reset, hasKey: () => !!key };
}

module.exports = {
  LockError, hashSecret, verifySecret, generatePin, generateRecoveryKey, normRecovery,
  validateCeoCode, validatePin, emptyState, cloneState, isEnabled, lockOf, lockedDirs, isCeo, checkOpenCode, chromeLockRec,
  setupCeo, changeCeo, lockChrome, lockGroup, removeLock, resetPin, addMember, removeMember, renameGroup, deleteGroup,
  canEditWarning, setWarning, warningsFor, publicView, fiineMessage,
  canonical, macOf, sealDoc, verifyDoc, sealString, parseSeal, readDocFile, evaluateUnverified, createLockStore, packBlob, parseBlob,
};
