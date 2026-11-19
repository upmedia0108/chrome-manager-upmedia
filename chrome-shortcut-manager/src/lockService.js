// Dịch vụ khóa Chrome cho app (v1.11): nối lõi src/locks.js với cấu hình app, theo dõi "mở khóa đến khi tắt Chrome đó",
// chặn đoán mã, ẩn thông tin Chrome đang khóa. KHÔNG require Electron — main.js truyền phụ thuộc vào (để test được).
'use strict';
const locks = require('./locks');

const GRACE_MS = 45 * 1000;        // vừa mở khóa: chờ Chrome khởi động, chưa xét đóng
const WIN_CHECK_MS = 15 * 1000;    // đọc danh sách cửa sổ (PowerShell) tối đa mỗi 15 giây
const TICK_MS = 5 * 1000;
const MAX_FAILS = 5, BLOCK_MS = 5 * 60 * 1000;   // sai 5 lần / mục → chặn mục đó 5 phút
const MAX_FAILS_ALL = 15;                          // sai tổng cộng 15 lần (mọi mục) trong 5 phút → chặn mọi lần nhập mã 5 phút
                                                   // (mã CEO mở được mọi mục nên không thể dò bằng cách đổi mục)

function createLockService({ store, configStore, getUserDataPath, getLoadedDirs, listWindows, deleteShortcutsForDir = () => {},
  displayName = d => d, onChange = () => {}, now = () => Date.now(), autoTimer = true }) {
  let loaded = { state: locks.emptyState(), status: 'empty', failClosed: false, failClosedDirs: new Set(), problem: null };
  const unlocked = new Map();      // dir chữ thường → { dir, at, misses }
  const fails = new Map();         // khóa chặn đoán → { count, until }
  let timer = null, lastWin = 0, ticking = false;

  const k = d => String(d || '').toLowerCase();
  const ctx = () => ({ failClosed: loaded.failClosed, failClosedDirs: loaded.failClosedDirs });

  // Đọc lỗi bất ngờ → KHÓA TOÀN BỘ (không bao giờ coi như "chưa bật")
  function reload() {
    try { loaded = store.load(); }
    catch (e) {
      loaded = { state: locks.emptyState(), status: 'failclosed', failClosed: true, failClosedDirs: 'all',
        problem: `Không đọc được dữ liệu khóa (${(e && e.message) || e})`, loadError: true };
    }
    unlocked.clear(); return loaded;
  }
  function lockOf(dir) { return locks.lockOf(loaded.state, dir, ctx()); }
  function isUnlocked(dir) { return unlocked.has(k(dir)); }
  function isBlocked(dir) { return !!lockOf(dir) && !isUnlocked(dir); }
  function isLocked(dir) { return !!lockOf(dir); }
  function state() { return loaded.state; }

  function commit(newState) {
    loaded = { state: store.save(newState), status: 'ok', failClosed: false, failClosedDirs: new Set(), problem: null };
    onChange();
  }
  function guardNotFailClosed() {
    if (loaded.failClosed) throw new locks.LockError('FAIL_CLOSED', 'Đang khóa toàn bộ vì phát hiện dữ liệu khóa bị sửa/xóa — nhập mã CEO ở thanh cảnh báo đỏ để khôi phục trước.');
  }
  function limiterCheck(id) {
    for (const k of [id, '__all']) {
      const f = fails.get(k);
      if (f && f.until > now()) {
        const m = Math.ceil((f.until - now()) / 60000);
        throw new locks.LockError('TOO_MANY', `Nhập sai quá nhiều lần. Thử lại sau ${m} phút.`);
      }
    }
  }
  function limiterFail(id) {
    const t = now();
    const bump = (k, max) => {
      let f = fails.get(k);
      if (!f || (f.first && t - f.first > BLOCK_MS && f.until <= t)) f = { count: 0, until: 0, first: t };
      f.count += 1;
      if (f.count >= max) { f.until = t + BLOCK_MS; f.count = 0; f.first = t; }
      fails.set(k, f);
    };
    bump(id, MAX_FAILS);
    bump('__all', MAX_FAILS_ALL);
  }
  function limiterOk(id) { fails.delete(id); }

  // Chạy 1 thao tác: bắt lỗi khóa thành { success:false, code, error }, đếm sai mã theo limitId
  function run(limitId, fn) {
    try {
      if (limitId) limiterCheck(limitId);
      const out = fn() || {};
      if (limitId) limiterOk(limitId);
      return { success: true, ...out };
    } catch (e) {
      if (e && e.code === 'BAD_CODE' && limitId) limiterFail(limitId);
      if (e instanceof locks.LockError) return { success: false, code: e.code, error: e.message, conflicts: e.conflicts };
      return { success: false, error: (e && e.message) || String(e) };
    }
  }

  function cfg() { return configStore.getConfig(); }
  function groupsOf(dir) { const p = (cfg().profiles || {})[dir] || {}; return p.groups || (p.group ? [p.group] : []); }
  function membersFromConfig(group) {
    return Object.entries(cfg().profiles || {}).filter(([, p]) => (p.groups || (p.group ? [p.group] : [])).includes(group)).map(([d]) => d);
  }
  function limitIdFor(dir) {
    const L = lockOf(dir);
    if (!L) return null;
    return L.type === 'group' ? `group:${L.group}` : L.type === 'chrome' ? `chrome:${dir}` : 'all';
  }

  // ── Trạng thái cho giao diện ──
  function status() {
    return { ...locks.publicView(loaded.state, ctx()), status: loaded.status, problem: loaded.problem || null,
      canReset: !!loaded.canReset, unlocked: [...unlocked.values()].map(u => u.dir),
      tamperCount: (loaded.state.events || []).filter(e => /^tamper/.test(e.type)).length };
  }
  // Ẩn thông tin Chrome đang khóa (chưa mở khóa) trước khi gửi sang giao diện
  function redactProfile(p) {
    const lock = lockOf(p.profileDirectory);
    const unl = isUnlocked(p.profileDirectory);
    const out = { ...p, lock: lock || null, unlocked: unl };
    if (lock && !unl) Object.assign(out, { notes: '', googleAccounts: [], email: null, gaiaName: null, chromeGaiaNames: [], avatarPath: null });
    return out;
  }

  // ── Mã CEO ──
  const setup = ceo => run(null, () => { guardNotFailClosed(); const r = locks.setupCeo(loaded.state, ceo, now()); commit(r.state); return { recoveryKey: r.recoveryKey }; });
  const changeCeo = (old, neu) => run('ceo', () => { guardNotFailClosed(); const r = locks.changeCeo(loaded.state, old, neu, now()); commit(r.state); return { recoveryKey: r.recoveryKey }; });
  const events = ceo => run('ceo', () => {
    if (!locks.isCeo(loaded.state, ceo)) throw new locks.LockError('BAD_CODE', 'Mã CEO không đúng.');
    return { events: (loaded.state.events || []).slice().reverse() };
  });
  const recover = code => run('ceo', () => {
    if (loaded.loadError) reload();                                          // thử đọc lại trước
    if (!loaded.failClosed) { onChange(); return { status: loaded.status }; }
    store.recover(loaded, code);
    reload(); onChange();
    return { status: loaded.status };
  });
  // Đặt lại từ đầu — chỉ khi không còn mã CEO nào kiểm được (mất khóa bí mật + dữ liệu không đáng tin)
  const reset = newCeo => run(null, () => {
    if (!loaded.failClosed || !loaded.canReset) throw new locks.LockError('NOT_ALLOWED', 'Chỉ đặt lại từ đầu được khi không còn mã CEO nào kiểm được.');
    const r = store.reset(loaded, newCeo);
    reload(); onChange();
    return { recoveryKey: r.recoveryKey };
  });

  // ── Khóa / gỡ / cấp mã ──
  function lockChrome(ceo, dir, pin) {
    return run('ceo', () => {
      guardNotFailClosed();
      const r = locks.lockChrome(loaded.state, ceo, dir, pin, now());
      commit(r.state); unlocked.delete(k(dir)); deleteShortcutsForDir(dir);
      return { pin: r.pin, message: locks.fiineMessage({ kind: 'chrome', name: displayName(dir), pin: r.pin }) };
    });
  }
  function lockGroup(ceo, group, pin) {
    return run('ceo', () => {
      guardNotFailClosed();
      const members = membersFromConfig(group);
      const r = locks.lockGroup(loaded.state, ceo, group, members, pin, now());
      commit(r.state);
      for (const d of members) { unlocked.delete(k(d)); deleteShortcutsForDir(d); }
      return { pin: r.pin, members, message: locks.fiineMessage({ kind: 'group', name: group, pin: r.pin, chromeNames: members.map(displayName) }) };
    });
  }
  const removeLock = (ceo, target) => run('ceo', () => { guardNotFailClosed(); commit(locks.removeLock(loaded.state, ceo, target, now()).state); });
  function resetPin(ceo, target, pin) {
    return run('ceo', () => {
      guardNotFailClosed();
      const r = locks.resetPin(loaded.state, ceo, target, pin, now());
      commit(r.state);
      const isGroup = target.type === 'group';
      const members = isGroup ? ((r.state.groupLocks[target.group] || {}).members || []) : [];
      return { pin: r.pin, message: locks.fiineMessage({ kind: target.type, name: isGroup ? target.group : displayName(target.dir), pin: r.pin, chromeNames: members.map(displayName) }) };
    });
  }

  // ── Thành viên nhóm khóa (đồng bộ luôn config.json) ──
  function addMember(code, group, dir) {
    return run(`group:${group}`, () => {
      guardNotFailClosed();
      commit(locks.addMember(loaded.state, code, group, dir, now()).state);
      const groups = groupsOf(dir);
      if (!groups.includes(group)) configStore.saveProfileConfig(dir, { groups: [...groups, group] });
      unlocked.delete(k(dir));
      deleteShortcutsForDir(dir);
    });
  }
  function removeMember(code, group, dir) {
    return run(`group:${group}`, () => {
      guardNotFailClosed();
      commit(locks.removeMember(loaded.state, code, group, dir, now()).state);
      const p = (cfg().profiles || {})[dir] || {};
      const subGroups = { ...(p.subGroups || {}) }; delete subGroups[group];
      configStore.saveProfileConfig(dir, { groups: groupsOf(dir).filter(g => g !== group), subGroups });
      unlocked.delete(k(dir));
    });
  }
  // Đổi tên / xóa nhóm (gọi TRƯỚC khi đổi config)
  const hasLockOrWarn = g => !!(loaded.state.groupLocks[g] || loaded.state.warnings.groups[g]);
  function renameGroup(code, oldName, newName) {
    if (!newName || oldName === newName) return { success: true };
    // Không gộp vào nhóm đang có (gộp sẽ đưa Chrome vào nhóm khóa mà không khóa, hoặc thay cảnh báo của nhóm kia)
    const existing = (cfg().groups || []).includes(newName) || hasLockOrWarn(newName);
    if (existing && (hasLockOrWarn(oldName) || hasLockOrWarn(newName))) {
      return { success: false, code: 'ALREADY', error: `Đã có nhóm "${newName}" — nhóm đang khóa hoặc có cảnh báo không gộp được, đặt tên khác.` };
    }
    const id = loaded.state.groupLocks[oldName] ? `group:${oldName}` : null;
    return run(id, () => {
      if (!hasLockOrWarn(oldName)) return {};
      guardNotFailClosed();
      commit(locks.renameGroup(loaded.state, code, oldName, newName, now()).state);
    });
  }
  // Xóa nhóm: nhóm khóa cần mã CEO; nhóm có cảnh báo có mã cần mã cảnh báo hoặc mã CEO.
  // Chưa nhập mã → NEED_CODE (không tính là nhập sai).
  function deleteGroups(code, names) {
    const touched = (names || []).filter(hasLockOrWarn);
    const needCode = touched.filter(g => loaded.state.groupLocks[g] || (loaded.state.warnings.groups[g] || {}).code);
    if (needCode.length && !String(code || '').trim()) {
      return { success: false, code: 'NEED_CODE', error: 'Cần mã để xóa nhóm.', groups: needCode, needCeo: needCode.some(g => loaded.state.groupLocks[g]) };
    }
    return run(needCode.length ? (needCode.some(g => loaded.state.groupLocks[g]) ? 'ceo' : `warn-group:${needCode[0]}`) : null, () => {
      if (!touched.length) return {};
      guardNotFailClosed();
      let s = loaded.state;
      for (const g of touched) s = locks.deleteGroup(s, code, g, now()).state;
      commit(s);
    });
  }

  // ── Mở khóa đến khi tắt Chrome đó ──
  function unlock(dir, code) {
    return run(limitIdFor(dir), () => {
      const via = locks.checkOpenCode(loaded.state, dir, code, ctx());
      if (!via) throw new locks.LockError('BAD_CODE', 'Mã không đúng.');
      if (via !== 'free') {
        unlocked.set(k(dir), { dir, at: now(), misses: 0 });
        if (!loaded.failClosed) {
          const s = locks.cloneState(loaded.state);
          s.events.push({ at: now(), type: 'open', detail: `${dir} (${via === 'ceo' ? 'mã CEO' : 'mã khóa'})` });
          if (s.events.length > 200) s.events = s.events.slice(-200);
          commit(s);
        }
        ensureWatcher();
      }
      return { via };
    });
  }
  // Mở nhiều Chrome bằng 1 mã (vd mã nhóm cho cả nhóm): trả Chrome nào mở khóa được
  function unlockMany(dirs, code) {
    const ok = [], fail = [];
    for (const d of dirs || []) {
      if (!isBlocked(d)) { ok.push(d); continue; }
      const r = unlock(d, code);
      (r.success ? ok : fail).push(d);
      if (!r.success && r.code === 'TOO_MANY') return { success: false, code: r.code, error: r.error, ok, fail };
    }
    return { success: fail.length === 0, ok, fail };
  }
  function relock(dir) { unlocked.delete(k(dir)); onChange(); return { success: true }; }
  // Đóng tất cả Chrome → mọi Chrome đang mở khóa khóa lại ngay
  function relockAll() { if (unlocked.size) { unlocked.clear(); onChange(); } return { success: true }; }

  function ensureWatcher() {
    if (!autoTimer || timer || !unlocked.size) return;
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  // 1 nhịp theo dõi: Chrome đã mở khóa mà đóng hẳn (không khóa file + không còn cửa sổ, 2 lần liên tiếp) → khóa lại
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      if (!unlocked.size) { if (timer) { clearInterval(timer); timer = null; } return; }
      const t = now();
      let loadedSet = new Set();
      try { loadedSet = getLoadedDirs(getUserDataPath()); } catch { /* bỏ qua */ }
      const due = [...unlocked.entries()].filter(([, u]) => t - u.at >= GRACE_MS);
      let winSet = null, winTried = false;
      if (due.length && t - lastWin >= WIN_CHECK_MS) {
        lastWin = t; winTried = true;
        try {
          const w = await listWindows();
          if (w && w.ok) winSet = new Set(w.windows.filter(x => x.dir).map(x => x.dir.toLowerCase()));
        } catch { /* bỏ qua */ }
      }
      let changed = false;
      for (const [key, u] of due) {
        let seen;
        if (winSet) seen = winSet.has(key);         // còn cửa sổ = còn mở (Chrome chạy ngầm giữ file nhưng đã đóng cửa sổ → coi như tắt)
        else if (winTried) seen = loadedSet.has(key); // không đọc được cửa sổ: dựa vào khóa file
        else continue;                              // chưa tới lượt đọc cửa sổ: chưa kết luận
        if (seen) u.misses = 0;
        else if (++u.misses >= 2) { unlocked.delete(key); changed = true; }
      }
      if (changed) onChange();
      if (!unlocked.size && timer) { clearInterval(timer); timer = null; }
    } finally { ticking = false; }
  }

  // ── Cảnh báo ──
  function setWarning(target, code, opts) {
    const id = target.type === 'group' ? `warn-group:${target.group}` : `warn-chrome:${target.dir}`;
    return run(id, () => { guardNotFailClosed(); commit(locks.setWarning(loaded.state, target, code, opts, now()).state); });
  }
  function warningsFor(dirs) {
    const out = {};
    for (const d of dirs || []) out[d] = locks.warningsFor(loaded.state, d, groupsOf(d));
    return out;
  }

  return {
    reload, status, redactProfile, lockOf, isLocked, isBlocked, isUnlocked, state,
    setup, changeCeo, events, recover, reset, lockChrome, lockGroup, removeLock, resetPin,
    addMember, removeMember, renameGroup, deleteGroups, unlock, unlockMany, relock, relockAll, tick,
    setWarning, warningsFor,
    _unlocked: unlocked,
  };
}

module.exports = { createLockService, GRACE_MS, WIN_CHECK_MS, MAX_FAILS };
