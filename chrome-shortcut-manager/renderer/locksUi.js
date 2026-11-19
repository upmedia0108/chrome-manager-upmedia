// Giao diện khóa Chrome bằng mã + cảnh báo khi mở (v1.11).
// Nạp TRƯỚC renderer.js; dùng biến / hàm của renderer.js (allProfiles, showToast, eh, ea, applyFilter…) lúc chạy.
// Mọi kiểm tra mã nằm ở phần nền (main.js + src/lockService.js) — giao diện chỉ hỏi mã rồi gửi đi.

let lockStatus = { enabled: false, failClosed: false, chromeLocks: [], groupLocks: {}, warnings: { groups: {}, chromes: {} }, unlocked: [], status: 'empty', problem: null };
let lockBannerDismissed = false;
let _lockRefreshTimer = null;

async function loadLockStatus() {
  try { lockStatus = await window.app.lockStatus(); } catch { /* giữ trạng thái cũ */ }
  renderLockBanner();
  renderLockSettings();
  return lockStatus;
}
function groupIsLocked(g) { return !!(lockStatus.groupLocks || {})[g]; }
function profileOf(dir) { return (typeof allProfiles !== 'undefined' ? allProfiles : []).find(x => x.profileDirectory === dir); }
function nameOfDir(dir) { const p = profileOf(dir); return p ? (p.shortcutName || p.chromeProfileName || dir) : dir; }
function lockLabel(lock) {
  if (!lock) return '';
  if (lock.type === 'group') return `Khóa nhóm "${lock.group}"`;
  if (lock.type === 'chrome') return 'Khóa riêng';
  return 'Khóa toàn bộ';
}
function isProfileBlocked(p) { return !!(p && p.lock && !p.unlocked); }
function lockErrorText(res) {
  if (res && Array.isArray(res.conflicts) && res.conflicts.length) {
    return `Có ${res.conflicts.length} Chrome đang có khóa khác (mỗi Chrome chỉ 1 lớp khóa): ${res.conflicts.map(nameOfDir).join(', ')}. Gỡ khóa đó trước hoặc bỏ Chrome đó khỏi nhóm.`;
  }
  return (res && res.error) || 'Không thực hiện được';
}

// ── Hộp thoại dùng chung ──────────────────────────────────
// inputs: [{ id, type: password|text|textarea|checkbox|select, label, placeholder, value, options:[{value,label}] }]
// buttons: [{ id, label, kind: primary|outline|secondary|danger, onClick(values) }] — có onClick thì bấm không đóng hộp thoại
function upmDialog({ title, html = '', inputs = [], buttons, width = 460 }) {
  buttons = buttons || [{ id: 'ok', label: 'Đồng ý', kind: 'primary' }, { id: 'cancel', label: 'Hủy', kind: 'outline' }];
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay upm-dialog';
    const lbl = inp => (inp.label ? `<label class="lk-hint">${eh(inp.label)}</label>` : '');
    const field = inp => {
      const ph = inp.placeholder ? ` placeholder="${ea(inp.placeholder)}"` : '';
      if (inp.type === 'textarea') return `<div class="upd-field">${lbl(inp)}<textarea class="form-input" data-id="${inp.id}"${ph}>${eh(inp.value || '')}</textarea></div>`;
      if (inp.type === 'checkbox') return `<label class="upd-check"><input type="checkbox" data-id="${inp.id}" ${inp.value ? 'checked' : ''}/> ${eh(inp.label || '')}</label>`;
      if (inp.type === 'select') return `<div class="upd-field">${lbl(inp)}<select class="form-input" data-id="${inp.id}">${(inp.options || []).map(o => `<option value="${ea(o.value)}">${eh(o.label)}</option>`).join('')}</select></div>`;
      return `<div class="upd-field">${lbl(inp)}<input class="form-input" type="${inp.type === 'password' ? 'password' : 'text'}" data-id="${inp.id}" value="${ea(inp.value || '')}"${ph} autocomplete="off" spellcheck="false"/></div>`;
    };
    ov.innerHTML = `<div class="modal" style="width:${width}px">
      <div class="modal-header"><h2>${title}</h2><button class="modal-close" data-act="__close">&times;</button></div>
      <div class="modal-body"><div class="upd-html">${html}</div>${inputs.map(field).join('')}
        <div class="upd-actions">${buttons.map(b => `<button class="btn btn-${b.kind || 'outline'} btn-sm" data-act="${ea(b.id)}">${b.label}</button>`).join('')}</div>
      </div></div>`;
    const values = () => {
      const v = {};
      ov.querySelectorAll('[data-id]').forEach(el => { v[el.dataset.id] = el.type === 'checkbox' ? el.checked : el.value; });
      return v;
    };
    let done = false;
    const finish = res => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove(); resolve(res);
    };
    // Bắt phím trước renderer.js: Esc chỉ đóng hộp thoại này; chặn phím tắt Ctrl+… của app khi hộp thoại đang mở
    const onKey = e => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); finish(null); return; }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && ov.contains(e.target)) {
        const primary = buttons.find(b => b.kind === 'primary');
        if (primary) { e.stopImmediatePropagation(); e.preventDefault(); ov.querySelector(`[data-act="${primary.id}"]`).click(); }
        return;
      }
      if (e.ctrlKey || e.metaKey) e.stopImmediatePropagation();   // giữ Ctrl+C / Ctrl+V mặc định của ô nhập
    };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = act.dataset.act;
      if (id === '__close' || id === 'cancel') return finish(null);
      const b = buttons.find(x => x.id === id);
      if (b && b.onClick) { b.onClick(values()); return; }
      finish({ button: id, values: values() });
    });
    document.body.appendChild(ov);
    const first = ov.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) setTimeout(() => { try { first.focus(); } catch { /* bỏ qua */ } }, 30);
  });
}

async function askCode({ title, message, placeholder = 'Nhập mã', okLabel = 'Xác nhận', cancelLabel = 'Hủy' }) {
  const r = await upmDialog({
    title: eh(title), width: 440,
    html: message ? `<p class="upd-msg">${eh(message)}</p>` : '',
    inputs: [{ id: 'code', type: 'password', placeholder }],
    buttons: [{ id: 'ok', label: eh(okLabel), kind: 'primary' }, { id: 'cancel', label: eh(cancelLabel), kind: 'outline' }],
  });
  if (!r || r.button !== 'ok') return null;
  return String(r.values.code || '').trim() || null;
}

function copyText(text, okMsg) {
  const done = () => showToast(okMsg || 'Đã sao chép', 'success');
  const fallback = () => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { showToast('Không sao chép được — bôi đen rồi bấm Ctrl+C', 'warning'); }
    ta.remove();
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
}

// Mã vừa cấp: hiện mã + tin nhắn dán Fiine (mã chỉ hiện lần này)
async function showPinIssued({ title, pin, message }) {
  await upmDialog({
    title: eh(title), width: 520,
    html: `<div class="pin-big">${eh(pin)}</div>
      <div class="lk-hint">Gửi mã cho nhân sự qua Fiine (gửi tay). Mã chỉ hiện lần này — app không lưu mã gốc; quên mã thì dùng mã CEO cấp lại.</div>
      <textarea class="form-input upd-fiine" readonly>${eh(message)}</textarea>`,
    buttons: [
      { id: 'copy', label: 'Sao chép tin nhắn Fiine', kind: 'primary', onClick: () => copyText(message, 'Đã sao chép — dán vào Fiine gửi nhân sự') },
      { id: 'cancel', label: 'Xong', kind: 'outline' },
    ],
  });
}
async function showRecoveryKey(key) {
  await upmDialog({
    title: 'Mã khẩn cấp — chỉ hiện 1 lần', width: 520,
    html: `<p class="upd-msg">Dùng mã này khi <b>quên mã CEO</b> hoặc khi app khóa toàn bộ vì phát hiện dữ liệu khóa bị sửa. Lưu ngay vào nơi an toàn (trình quản lý mật khẩu của Sếp), không lưu trên máy dùng chung.</p>
      <div class="pin-big pin-recovery">${eh(key)}</div>`,
    buttons: [
      { id: 'copy', label: 'Sao chép', kind: 'primary', onClick: () => copyText(key, 'Đã sao chép mã khẩn cấp') },
      { id: 'cancel', label: 'Tôi đã lưu', kind: 'outline' },
    ],
  });
}

// ── Lưu cấu hình profile: nhóm đang khóa phải qua mã nhóm ─
// Dùng thay cho window.app.saveProfileConfig ở mọi chỗ trong renderer.js.
async function saveProfileCfg(dir, data) {
  for (let i = 0; i < 6; i++) {
    const res = await window.app.saveProfileConfig(dir, data);
    if (!res || typeof res !== 'object' || res.success !== false) return res;
    if (res.locked) { showToast(res.error || 'Chrome đang khóa', 'warning'); scheduleLockRefresh(); return res; }
    if (res.code !== 'LOCKED_GROUP') { showToast(res.error || 'Không lưu được', 'error'); scheduleLockRefresh(); return res; }
    const g = res.group;
    const adding = (data.groups || []).includes(g);
    const code = await askCode({
      title: adding ? `Thêm vào nhóm khóa "${g}"` : `Gỡ khỏi nhóm khóa "${g}"`,
      message: adding
        ? `Nhóm "${g}" đang khóa. Nhập mã nhóm (hoặc mã CEO) để đưa "${nameOfDir(dir)}" vào nhóm — Chrome này sẽ bị khóa theo nhóm.`
        : `Nhóm "${g}" đang khóa. Nhập mã nhóm (hoặc mã CEO) để gỡ "${nameOfDir(dir)}" ra khỏi nhóm — Chrome này sẽ hết khóa.`,
      placeholder: 'Mã nhóm', okLabel: adding ? 'Thêm vào nhóm' : 'Gỡ khỏi nhóm',
    });
    if (!code) { scheduleLockRefresh(); return { success: false, cancelled: true }; }
    const r = adding ? await window.app.lockAddMember(code, g, dir) : await window.app.lockRemoveMember(code, g, dir);
    if (!r.success) { showToast(lockErrorText(r), 'error'); scheduleLockRefresh(); return r; }
    showToast(adding ? `Đã thêm vào nhóm khóa "${g}"` : `Đã gỡ khỏi nhóm khóa "${g}"`, 'success');
    scheduleLockRefresh();
  }
  return { success: false };
}

// ── Mở Chrome: hỏi mã nếu đang khóa, rồi pop-up cảnh báo ──
async function ensureUnlocked(dir) {
  const p = profileOf(dir);
  if (!isProfileBlocked(p)) return true;
  const n = nameOfDir(dir);
  const msg = p.lock.type === 'group'
    ? `"${n}" thuộc nhóm khóa "${p.lock.group}". Nhập mã nhóm (hoặc mã CEO). Chrome giữ mở khóa tới khi tắt Chrome đó.`
    : p.lock.type === 'chrome'
      ? `"${n}" đang khóa riêng. Nhập mã khóa (hoặc mã CEO). Chrome giữ mở khóa tới khi tắt Chrome đó.`
      : 'Đang khóa toàn bộ vì phát hiện dữ liệu khóa bị sửa hoặc xóa. Chỉ mã CEO mở được.';
  const code = await askCode({ title: 'Chrome đang khóa', message: msg, placeholder: p.lock.type === 'all' ? 'Mã CEO' : 'Mã khóa', okLabel: 'Mở khóa' });
  if (!code) return false;
  const r = await window.app.lockUnlock(dir, code);
  if (!r.success) { showToast(r.error || 'Mã không đúng', 'error'); return false; }
  p.unlocked = true;
  showToast('Đã mở khóa — giữ tới khi tắt Chrome này', 'success');
  scheduleLockRefresh();
  return true;
}

async function confirmWarnings(dirs) {
  let map = {};
  try { map = (await window.app.warningsFor(dirs)) || {}; } catch { return true; }
  const items = [], seen = new Set();
  for (const d of dirs) for (const w of (map[d] || [])) {
    const key = `${w.source}|${w.name}|${w.text}`;
    if (!seen.has(key)) { seen.add(key); items.push(w); }
  }
  if (!items.length) return true;
  const html = items.map(w => `<div class="warn-item">
      <div class="warn-src">${w.source === 'group' ? `Cảnh báo nhóm "${eh(w.name)}"` : `Cảnh báo Chrome "${eh(nameOfDir(w.name))}"`}</div>
      <div class="warn-text">${eh(w.text).replace(/\n/g, '<br>')}</div></div>`).join('');
  const r = await upmDialog({
    title: 'Cảnh báo trước khi mở Chrome', html, width: 540,
    buttons: [{ id: 'ok', label: dirs.length > 1 ? `Tôi đã đọc, mở ${dirs.length} Chrome` : 'Tôi đã đọc, mở Chrome', kind: 'primary' }, { id: 'cancel', label: 'Hủy', kind: 'outline' }],
  });
  return !!(r && r.button === 'ok');
}

async function openGate(dir) {
  const wasBlocked = isProfileBlocked(profileOf(dir));
  if (!(await ensureUnlocked(dir))) return false;
  if (await confirmWarnings([dir])) return true;
  if (wasBlocked) { await window.app.lockRelock(dir); const p = profileOf(dir); if (p) p.unlocked = false; scheduleLockRefresh(); }  // vừa mở khóa mà không mở → khóa lại ngay
  return false;
}

// Mở nhiều Chrome: mỗi nhóm khóa hỏi mã 1 lần; Chrome khóa riêng hỏi từng cái; rồi 1 pop-up cảnh báo chung.
// Trả về danh sách Chrome được phép mở.
async function batchGate(dirs) {
  const buckets = new Map();
  for (const d of dirs) {
    const p = profileOf(d);
    if (!isProfileBlocked(p)) continue;
    const key = p.lock.type === 'group' ? `g:${p.lock.group}` : p.lock.type === 'all' ? 'all' : `c:${d}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(d);
  }
  const skipped = new Set();
  for (const [key, ds] of buckets) {
    const title = key === 'all' ? 'Đang khóa toàn bộ — nhập mã CEO'
      : key.startsWith('g:') ? `Nhóm khóa "${key.slice(2)}" (${ds.length} Chrome)` : `"${nameOfDir(ds[0])}" đang khóa riêng`;
    const code = await askCode({ title, message: 'Nhập mã để mở. Bấm "Bỏ qua" để chỉ mở các Chrome khác.', placeholder: key === 'all' ? 'Mã CEO' : 'Mã khóa', okLabel: 'Mở khóa', cancelLabel: 'Bỏ qua' });
    if (!code) { ds.forEach(d => skipped.add(d)); continue; }
    const r = await window.app.lockUnlockMany(ds, code);
    (r.fail || []).forEach(d => skipped.add(d));
    if (!r.success) {
      ds.filter(d => !(r.ok || []).includes(d)).forEach(d => skipped.add(d));
      showToast(r.error || 'Mã không đúng — bỏ qua các Chrome này', 'error');
    }
    (r.ok || []).forEach(d => { const p = profileOf(d); if (p) p.unlocked = true; });
  }
  if (buckets.size) scheduleLockRefresh();
  const allowed = dirs.filter(d => !skipped.has(d));
  if (!allowed.length) return [];
  if (await confirmWarnings(allowed)) return allowed;
  const freshly = [...buckets.values()].flat().filter(d => allowed.includes(d));   // vừa mở khóa mà không mở → khóa lại ngay
  for (const d of freshly) { await window.app.lockRelock(d); const p = profileOf(d); if (p) p.unlocked = false; }
  if (freshly.length) scheduleLockRefresh();
  return [];
}

// ── Bảo vệ 1 Chrome ───────────────────────────────────────
async function openProtectChrome(dir) {
  const st = await loadLockStatus();
  const p = profileOf(dir) || { profileDirectory: dir };
  const name = nameOfDir(dir);
  const lock = p.lock;
  const w = (st.warnings.chromes || {})[dir];
  const html = `${lock ? `<div class="lk-status locked">${eh(lockLabel(lock))}${p.unlocked ? ' · đang mở khóa (tới khi tắt Chrome)' : ''}</div>` : '<div class="lk-status free">Chrome này chưa khóa</div>'}
    ${st.enabled ? '' : '<div class="lk-note">Chưa bật khóa bằng mã — vào Cài đặt → "Khóa Chrome bằng mã" để đặt mã CEO. Cảnh báo vẫn dùng được.</div>'}
    <div class="lk-sec-title">Cảnh báo khi mở Chrome này</div>
    <div class="lk-hint">Hiện pop-up mỗi lần mở. ${w ? 'Sửa, tắt cần mã cảnh báo, mã khóa của Chrome hoặc mã CEO.' : lock ? 'Lưu bằng mã khóa của Chrome hoặc mã CEO.' : 'Tự đặt mã cảnh báo để người khác không sửa, tắt được.'}</div>`;
  const inputs = [
    { id: 'text', type: 'textarea', value: w ? w.text : '', placeholder: 'Vd: Chrome của khách — không đăng bài cá nhân, không đổi mật khẩu' },
    { id: 'enabled', type: 'checkbox', label: 'Bật cảnh báo', value: w ? w.enabled : true },
    { id: 'newCode', type: 'password', placeholder: (!w && !lock) ? 'Đặt mã cảnh báo (4–32 ký tự)' : 'Đổi mã cảnh báo (bỏ trống nếu giữ nguyên)' },
  ];
  const buttons = [];
  if (st.enabled && !st.failClosed) {
    if (!lock) buttons.push({ id: 'lock', label: 'Khóa riêng Chrome này', kind: 'primary' });
    if (lock && lock.type === 'chrome') buttons.push({ id: 'reset', label: 'Cấp lại mã' }, { id: 'remove', label: 'Gỡ khóa' });
    if (lock && lock.type === 'group') buttons.push({ id: 'leave', label: `Gỡ khỏi nhóm "${eh(lock.group)}"` });
  }
  if (lock && p.unlocked) buttons.push({ id: 'relock', label: 'Khóa lại ngay' });
  buttons.push({ id: 'saveWarn', label: 'Lưu cảnh báo', kind: buttons.some(b => b.kind === 'primary') ? 'secondary' : 'primary' }, { id: 'cancel', label: 'Đóng' });
  const r = await upmDialog({ title: `Bảo vệ "${eh(name)}"`, html, inputs, buttons, width: 560 });
  if (!r) return;
  await doProtectAction(r, { type: 'chrome', dir }, { name, lock, warning: w });
}

// ── Bảo vệ 1 nhóm ─────────────────────────────────────────
async function openProtectGroup(group) {
  const st = await loadLockStatus();
  const lockedMembers = (st.groupLocks || {})[group];
  const inGroup = allProfiles.filter(p => (p.groups || []).includes(group)).map(p => p.profileDirectory);
  const w = (st.warnings.groups || {})[group];
  const html = `${lockedMembers ? `<div class="lk-status locked">Nhóm đang khóa · ${lockedMembers.length} Chrome</div>` : `<div class="lk-status free">Nhóm chưa khóa · ${inGroup.length} Chrome trong nhóm</div>`}
    ${st.enabled ? '' : '<div class="lk-note">Chưa bật khóa bằng mã — vào Cài đặt → "Khóa Chrome bằng mã" để đặt mã CEO. Cảnh báo vẫn dùng được.</div>'}
    ${lockedMembers ? '<div class="lk-hint">Thêm Chrome CHƯA khóa vào nhóm (cần mã nhóm) — Chrome sẽ khóa theo nhóm. Gỡ Chrome khỏi nhóm: bấm nút khiên trên thẻ Chrome đó.</div>' : ''}
    <div class="lk-sec-title">Cảnh báo cho cả nhóm</div>
    <div class="lk-hint">Hiện pop-up khi mở bất kỳ Chrome nào trong nhóm. ${w ? 'Sửa, tắt cần mã cảnh báo, mã nhóm hoặc mã CEO.' : lockedMembers ? 'Lưu bằng mã nhóm hoặc mã CEO.' : 'Tự đặt mã cảnh báo để người khác không sửa, tắt được.'}</div>`;
  const inputs = [];
  if (lockedMembers && st.enabled && !st.failClosed) {
    const free = allProfiles.filter(p => !p.lock).map(p => ({ value: p.profileDirectory, label: `${p.shortcutName || p.chromeProfileName || p.profileDirectory} (${p.profileDirectory})` }));
    inputs.push({ id: 'addDir', type: 'select', label: 'Thêm Chrome chưa khóa vào nhóm', options: [{ value: '', label: free.length ? '— Chọn Chrome —' : '(không còn Chrome nào chưa khóa)' }, ...free] });
  }
  inputs.push(
    { id: 'text', type: 'textarea', value: w ? w.text : '', placeholder: 'Vd: Nhóm Chrome khách hàng — chỉ dùng trong giờ làm, không đăng nhập tài khoản cá nhân' },
    { id: 'enabled', type: 'checkbox', label: 'Bật cảnh báo', value: w ? w.enabled : true },
    { id: 'newCode', type: 'password', placeholder: (!w && !lockedMembers) ? 'Đặt mã cảnh báo (4–32 ký tự)' : 'Đổi mã cảnh báo (bỏ trống nếu giữ nguyên)' },
  );
  const buttons = [];
  if (st.enabled && !st.failClosed) {
    if (!lockedMembers) buttons.push({ id: 'lockGroup', label: `Khóa nhóm (${inGroup.length} Chrome)`, kind: 'primary' });
    else buttons.push({ id: 'add', label: 'Thêm vào nhóm', kind: 'primary' }, { id: 'resetGroup', label: 'Cấp lại mã nhóm' }, { id: 'removeGroup', label: 'Gỡ khóa nhóm' });
  }
  buttons.push({ id: 'saveWarn', label: 'Lưu cảnh báo', kind: buttons.some(b => b.kind === 'primary') ? 'secondary' : 'primary' }, { id: 'cancel', label: 'Đóng' });
  const r = await upmDialog({ title: `Bảo vệ nhóm "${eh(group)}"`, html, inputs, buttons, width: 580 });
  if (!r) return;
  await doProtectAction(r, { type: 'group', group }, { name: group, lockedMembers, warning: w, count: inGroup.length });
}

async function doProtectAction(r, target, info) {
  const v = r.values || {};
  const ceo = msg => askCode({ title: 'Cần mã CEO', message: msg, placeholder: 'Mã CEO', okLabel: 'Xác nhận' });
  const isGroup = target.type === 'group';
  let res = null;
  switch (r.button) {
    case 'lock': {
      const c = await ceo(`Khóa riêng "${info.name}". App tự tạo mã 6 số để Sếp gửi người dùng Chrome này.`); if (!c) return;
      res = await window.app.lockChrome(c, target.dir);
      if (res.success) { scheduleLockRefresh(); return showPinIssued({ title: `Mã mở Chrome "${info.name}"`, pin: res.pin, message: res.message }); }
      break;
    }
    case 'lockGroup': {
      if (!info.count) return showToast(`Nhóm "${info.name}" chưa có Chrome nào — gán Chrome vào nhóm trước`, 'warning');
      const c = await ceo(`Khóa nhóm "${info.name}": ${info.count} Chrome trong nhóm khóa chung 1 mã. App tự tạo mã 6 số để Sếp gửi chủ nhóm.`); if (!c) return;
      res = await window.app.lockGroup(c, target.group);
      if (res.success) { scheduleLockRefresh(); return showPinIssued({ title: `Mã nhóm "${info.name}"`, pin: res.pin, message: res.message }); }
      break;
    }
    case 'reset': case 'resetGroup': {
      const c = await ceo(`Cấp mã mới cho ${isGroup ? `nhóm "${info.name}"` : `"${info.name}"`}. Mã cũ hết hiệu lực ngay.`); if (!c) return;
      res = await window.app.lockResetPin(c, target);
      if (res.success) return showPinIssued({ title: `Mã mới ${isGroup ? `nhóm "${info.name}"` : `Chrome "${info.name}"`}`, pin: res.pin, message: res.message });
      break;
    }
    case 'remove': case 'removeGroup': {
      const c = await ceo(`Gỡ khóa ${isGroup ? `nhóm "${info.name}" — mọi Chrome trong nhóm hết khóa` : `"${info.name}"`}.`); if (!c) return;
      res = await window.app.lockRemove(c, target);
      if (res.success) { showToast('Đã gỡ khóa', 'success'); scheduleLockRefresh(); }
      break;
    }
    case 'leave': {
      const g = info.lock.group;
      const c = await askCode({ title: `Gỡ khỏi nhóm "${g}"`, message: `Nhập mã nhóm (hoặc mã CEO). "${info.name}" sẽ hết khóa và không còn trong nhóm "${g}".`, placeholder: 'Mã nhóm', okLabel: 'Gỡ khỏi nhóm' }); if (!c) return;
      res = await window.app.lockRemoveMember(c, g, target.dir);
      if (res.success) { showToast(`Đã gỡ khỏi nhóm "${g}"`, 'success'); scheduleLockRefresh(); }
      break;
    }
    case 'add': {
      if (!v.addDir) return showToast('Chọn Chrome cần thêm vào nhóm', 'warning');
      const c = await askCode({ title: `Thêm vào nhóm "${target.group}"`, message: `Nhập mã nhóm (hoặc mã CEO) để đưa "${nameOfDir(v.addDir)}" vào nhóm — Chrome này sẽ khóa theo nhóm.`, placeholder: 'Mã nhóm', okLabel: 'Thêm vào nhóm' }); if (!c) return;
      res = await window.app.lockAddMember(c, target.group, v.addDir);
      if (res.success) { showToast(`Đã thêm "${nameOfDir(v.addDir)}" vào nhóm khóa`, 'success'); scheduleLockRefresh(); }
      break;
    }
    case 'relock':
      res = await window.app.lockRelock(target.dir);
      if (res.success) { showToast('Đã khóa lại', 'success'); scheduleLockRefresh(); }
      break;
    case 'saveWarn': {
      const text = String(v.text || '').trim();
      const locked = isGroup ? !!info.lockedMembers : !!info.lock;
      const isNew = !info.warning && !locked;
      if (!text && !info.warning) return showToast('Nhập nội dung cảnh báo', 'warning');
      if (isNew && !v.newCode) return showToast('Đặt mã cảnh báo (4–32 ký tự) để người khác không tắt được', 'warning');
      let code = '';
      if (!isNew) {
        code = await askCode({
          title: text ? 'Lưu cảnh báo' : 'Xóa cảnh báo',
          message: `Nhập mã cảnh báo, ${isGroup ? 'mã nhóm' : 'mã khóa của Chrome'} hoặc mã CEO.`,
          placeholder: 'Mã', okLabel: text ? 'Lưu' : 'Xóa',
        });
        if (!code) return;
      }
      const opts = text ? { text, enabled: !!v.enabled, newCode: v.newCode || undefined } : { text: '', enabled: false };
      res = await window.app.warningSet(target, code, opts);
      if (res.success) { showToast(text ? 'Đã lưu cảnh báo' : 'Đã xóa cảnh báo', 'success'); scheduleLockRefresh(); }
      break;
    }
    default: return;
  }
  if (res && !res.success) showToast(lockErrorText(res), 'error');
}

// ── Mã CEO: bật, đổi, quên, nhật ký, khôi phục ────────────
async function setupCeoFlow() {
  const r = await upmDialog({
    title: 'Bật khóa Chrome — đặt mã CEO', width: 500,
    html: '<p class="upd-msg">Mã CEO là "cửa sau": mở mọi Chrome và nhóm đang khóa, khóa và cấp mã cho nhân sự. Ít nhất 8 ký tự. Chỉ Sếp giữ — không đặt trùng mật khẩu khác.</p>',
    inputs: [{ id: 'a', type: 'password', placeholder: 'Mã CEO (ít nhất 8 ký tự)' }, { id: 'b', type: 'password', placeholder: 'Nhập lại mã CEO' }],
    buttons: [{ id: 'ok', label: 'Đặt mã CEO', kind: 'primary' }, { id: 'cancel', label: 'Hủy' }],
  });
  if (!r || r.button !== 'ok') return;
  if (r.values.a !== r.values.b) return showToast('Hai lần nhập không khớp', 'error');
  const res = await window.app.lockSetup(r.values.a);
  if (!res.success) return showToast(res.error, 'error');
  showToast('Đã bật khóa Chrome bằng mã', 'success');
  await showRecoveryKey(res.recoveryKey);
}
async function changeCeoFlow(useRecovery) {
  const r = await upmDialog({
    title: useRecovery ? 'Quên mã CEO — dùng mã khẩn cấp' : 'Đổi mã CEO', width: 480,
    inputs: [
      { id: 'old', type: 'password', placeholder: useRecovery ? 'Mã khẩn cấp (XXXX-XXXX-XXXX-XXXX-XXXX)' : 'Mã CEO hiện tại' },
      { id: 'a', type: 'password', placeholder: 'Mã CEO mới (ít nhất 8 ký tự)' },
      { id: 'b', type: 'password', placeholder: 'Nhập lại mã CEO mới' },
    ],
    buttons: [{ id: 'ok', label: 'Đổi mã', kind: 'primary' }, { id: 'cancel', label: 'Hủy' }],
  });
  if (!r || r.button !== 'ok') return;
  if (r.values.a !== r.values.b) return showToast('Hai lần nhập mã mới không khớp', 'error');
  const res = await window.app.lockChangeCeo(r.values.old, r.values.a);
  if (!res.success) return showToast(res.error, 'error');
  showToast('Đã đổi mã CEO', 'success');
  if (res.recoveryKey) await showRecoveryKey(res.recoveryKey);
}
const LOCK_EVENT_LABELS = {
  setup: 'Bật khóa', 'ceo-change': 'Đổi mã CEO', 'lock-chrome': 'Khóa riêng', 'lock-group': 'Khóa nhóm',
  'unlock-chrome': 'Gỡ khóa Chrome', 'unlock-group': 'Gỡ khóa nhóm', 'reset-pin': 'Cấp lại mã', 'add-member': 'Thêm vào nhóm khóa',
  'remove-member': 'Gỡ khỏi nhóm khóa', 'rename-group': 'Đổi tên nhóm', 'delete-group': 'Xóa nhóm', 'warning-set': 'Lưu cảnh báo',
  'warning-delete': 'Xóa cảnh báo', open: 'Mở bằng mã', 'tamper-restored': 'Phát hiện sửa file — đã khôi phục', 'tamper-recovered': 'Khôi phục sau khi khóa toàn bộ',
};
async function lockEventsFlow() {
  const code = await askCode({ title: 'Nhật ký bảo vệ', message: 'Nhập mã CEO để xem nhật ký khóa, mở bằng mã và các lần phát hiện sửa file.', placeholder: 'Mã CEO', okLabel: 'Xem' });
  if (!code) return;
  const res = await window.app.lockEvents(code);
  if (!res.success) return showToast(res.error, 'error');
  const withNames = s => eh(String(s || '')).replace(/\b(Profile \d+|Default)\b/g, m => `${eh(nameOfDir(m))} (${m})`);
  const rows = (res.events || []).map(e => `<tr><td class="ev-time">${eh(new Date(e.at).toLocaleString('vi-VN'))}</td><td class="ev-type${/^tamper/.test(e.type) ? ' ev-bad' : ''}">${eh(LOCK_EVENT_LABELS[e.type] || e.type)}</td><td>${withNames(e.detail)}</td></tr>`).join('');
  await upmDialog({
    title: 'Nhật ký bảo vệ', width: 720,
    html: `<div class="lk-events"><table><thead><tr><th>Thời gian</th><th>Việc</th><th>Chi tiết</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Chưa có sự kiện</td></tr>'}</tbody></table></div>`,
    buttons: [{ id: 'cancel', label: 'Đóng' }],
  });
}
async function recoverFlow() {
  const code = await askCode({ title: 'Khôi phục dữ liệu khóa', message: 'Nhập mã CEO (hoặc mã khẩn cấp). App lấy lại bản dữ liệu khóa đáng tin gần nhất, niêm phong lại và ghi vào nhật ký. Sau đó Sếp kiểm tra lại các khóa: khóa nào bị mất thì khóa lại và cấp mã mới.', placeholder: 'Mã CEO hoặc mã khẩn cấp', okLabel: 'Khôi phục' });
  if (!code) return;
  const res = await window.app.lockRecover(code);
  if (!res.success && res.code === 'NO_ANCHOR') { scheduleLockRefresh(); return showToast(res.error, 'error'); }
  if (!res.success) return showToast(res.error, 'error');
  showToast('Đã khôi phục — Sếp kiểm tra lại các Chrome, nhóm đang khóa (dữ liệu có thể đã bị sửa)', 'warning');
  scheduleLockRefresh();
}

// Đặt lại từ đầu: chỉ khi máy không còn mã CEO nào kiểm được (mất khóa bí mật + dữ liệu không đáng tin)
async function resetFlow() {
  const r = await upmDialog({
    title: 'Đặt lại khóa từ đầu', width: 520,
    html: '<p class="upd-msg">Máy này không còn mã CEO nào kiểm được (khóa bí mật và dữ liệu khóa đều bị xóa hoặc sửa). Đặt lại sẽ <b>bỏ mọi khóa cũ</b>, đặt mã CEO mới và ghi vào Nhật ký bảo vệ. Sau đó Sếp khóa lại các nhóm / Chrome và cấp mã mới cho nhân sự.</p>',
    inputs: [{ id: 'a', type: 'password', placeholder: 'Mã CEO mới (ít nhất 8 ký tự)' }, { id: 'b', type: 'password', placeholder: 'Nhập lại mã CEO mới' }],
    buttons: [{ id: 'ok', label: 'Đặt lại từ đầu', kind: 'danger' }, { id: 'cancel', label: 'Hủy' }],
  });
  if (!r || r.button !== 'ok') return;
  if (r.values.a !== r.values.b) return showToast('Hai lần nhập không khớp', 'error');
  const res = await window.app.lockReset(r.values.a);
  if (!res.success) return showToast(res.error, 'error');
  showToast('Đã đặt lại — Sếp khóa lại các nhóm / Chrome cần bảo vệ', 'warning');
  scheduleLockRefresh();
  await showRecoveryKey(res.recoveryKey);
}

// ── Thanh cảnh báo phát hiện sửa file ─────────────────────
function renderLockBanner() {
  let el = document.getElementById('lock-banner');
  if (!el) {
    const sc = document.getElementById('scan-compare');
    if (!sc) return;
    el = document.createElement('div'); el.id = 'lock-banner';
    sc.parentNode.insertBefore(el, sc);
  }
  if (lockStatus.failClosed) {
    el.className = 'lock-banner danger';
    if (lockStatus.canReset) {
      el.innerHTML = `<span><b>Dữ liệu khóa bị xóa hoặc sửa</b>${lockStatus.problem ? ` (${eh(lockStatus.problem)})` : ''}. Máy không còn mã CEO nào kiểm được — mọi Chrome đang khóa. Sếp đặt lại từ đầu bằng mã CEO mới.</span><button class="btn btn-danger btn-sm" id="btn-lock-reset">Đặt lại từ đầu</button>`;
      el.querySelector('#btn-lock-reset').onclick = resetFlow;
    } else {
      el.innerHTML = `<span><b>Phát hiện dữ liệu khóa bị sửa hoặc xóa</b>${lockStatus.problem ? ` (${eh(lockStatus.problem)})` : ''}. Mọi Chrome đang khóa cho tới khi nhập mã CEO.</span><button class="btn btn-danger btn-sm" id="btn-lock-recover">Nhập mã CEO để khôi phục</button>`;
      el.querySelector('#btn-lock-recover').onclick = recoverFlow;
    }
  } else if (lockStatus.status === 'restored' && lockStatus.problem && !lockBannerDismissed) {
    el.className = 'lock-banner warn';
    el.innerHTML = `<span><b>Phát hiện dữ liệu khóa bị sửa</b>: ${eh(lockStatus.problem)}. App đã tự khôi phục và ghi vào Nhật ký bảo vệ.</span><button class="btn btn-outline btn-sm" id="btn-lock-dismiss">Đã biết</button>`;
    el.querySelector('#btn-lock-dismiss').onclick = () => { lockBannerDismissed = true; renderLockBanner(); };
  } else { el.className = 'lock-banner hidden'; el.innerHTML = ''; }
}

// ── Mục "Khóa Chrome bằng mã" trong Cài đặt ───────────────
function renderLockSettings() {
  const body = document.querySelector('#modal-settings .modal-body');
  if (!body) return;
  let el = document.getElementById('lock-settings');
  if (!el) { el = document.createElement('div'); el.id = 'lock-settings'; el.className = 'settings-row'; body.insertBefore(el, body.children[1] || null); }
  const st = lockStatus;
  const nLock = (st.chromeLocks || []).length + Object.keys(st.groupLocks || {}).length;
  const desc = !st.enabled
    ? 'Khóa mở Chrome theo nhóm hoặc từng Chrome bằng mã; Sếp cấp mã cho nhân sự qua Fiine; mã CEO mở được tất cả. Cảnh báo khi mở Chrome dùng được cả khi chưa bật.'
    : `Đang bật · ${nLock} mục đang khóa${st.failClosed ? ' · đang khóa toàn bộ (phát hiện sửa file)' : ''}${st.tamperCount ? ` · ${st.tamperCount} lần phát hiện sửa file (xem Nhật ký)` : ''}. Khóa, cảnh báo: bấm nút khiên trên thẻ Chrome hoặc cạnh tên nhóm ở cột trái.`;
  el.innerHTML = `<div><div class="settings-label">Khóa Chrome bằng mã</div><div class="settings-desc">${eh(desc)}</div></div>
    <div class="lock-settings-actions">${!st.enabled
      ? '<button class="btn btn-primary btn-sm" data-lk="setup">Bật khóa (đặt mã CEO)</button>'
      : '<button class="btn btn-outline btn-sm" data-lk="change">Đổi mã CEO</button><button class="btn btn-outline btn-sm" data-lk="forgot">Quên mã CEO</button><button class="btn btn-outline btn-sm" data-lk="events">Nhật ký</button>'}</div>`;
  el.querySelectorAll('[data-lk]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.lk;
    if (a === 'setup') await setupCeoFlow();
    if (a === 'change') await changeCeoFlow(false);
    if (a === 'forgot') await changeCeoFlow(true);
    if (a === 'events') await lockEventsFlow();
    scheduleLockRefresh();
  }));
}

// ── Trang trí thẻ / hàng / nhóm ───────────────────────────
const SHIELD_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const LOCK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';

function decorateCardLock(card, profile) {
  const header = card.querySelector('.card-header');
  const blocked = isProfileBlocked(profile);
  if (profile.lock && header) {
    const b = document.createElement('button');
    b.className = `lock-badge${profile.unlocked ? ' unlocked' : ''}${profile.lock.type === 'all' ? ' all' : ''}`;
    b.title = profile.unlocked ? 'Đang mở khóa — tự khóa lại khi tắt Chrome này' : 'Chrome đang khóa — bấm để xem bảo vệ';
    b.innerHTML = `${profile.unlocked ? UNLOCK_SVG : LOCK_SVG}<span>${eh(profile.lock.type === 'group' ? profile.lock.group : lockLabel(profile.lock))}</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); openProtectChrome(profile.profileDirectory); });
    header.insertBefore(b, header.querySelector('.pin-toggle'));
  }
  const actions = card.querySelector('.card-actions');
  if (actions) {
    const pb = document.createElement('button');
    pb.className = 'btn btn-outline btn-icon btn-protect';
    pb.title = 'Bảo vệ: khóa bằng mã, cảnh báo khi mở';
    pb.innerHTML = SHIELD_SVG;
    pb.addEventListener('click', e => { e.stopPropagation(); openProtectChrome(profile.profileDirectory); });
    actions.insertBefore(pb, actions.querySelector('.btn-create'));
  }
  if (profile.lock) {
    card.classList.add('has-lock');
    // Chrome có khóa: không tạo shortcut Desktop (để không mở vòng qua app), không xóa (cần CEO gỡ khóa trước)
    card.querySelectorAll('.btn-create, .btn-del-profile').forEach(el => { el.disabled = true; el.title = 'Chrome đang khóa'; });
  }
  card.classList.toggle('is-locked', blocked);
  if (blocked) {
    const inp = card.querySelector('.input-name'); if (inp) { inp.disabled = true; inp.title = 'Chrome đang khóa — mở khóa để đổi tên'; }
    card.querySelectorAll('.notes-section, .account-badges, .btn-history, .btn-extensions, .add-group-btn, .remove-tag').forEach(el => { el.style.display = 'none'; });
  }
}
function decorateRowLock(row, profile) {
  if (!profile.lock) return;
  const nameEl = row.querySelector('.row-name strong');
  if (!nameEl) return;
  const s = document.createElement('span');
  s.className = `row-lock${profile.unlocked ? ' unlocked' : ''}`;
  s.innerHTML = profile.unlocked ? UNLOCK_SVG : LOCK_SVG;
  s.title = profile.unlocked ? 'Đang mở khóa — tự khóa lại khi tắt Chrome' : lockLabel(profile.lock);
  nameEl.parentNode.insertBefore(s, nameEl);
}
// HTML thêm vào mục nhóm ở cột trái
function sidebarGroupLockHtml(g) {
  return `${groupIsLocked(g) ? `<span class="sg-lock" title="Nhóm đang khóa">${LOCK_SVG}</span>` : ''}<button class="sg-protect" title="Bảo vệ nhóm: khóa bằng mã, cảnh báo khi mở">${SHIELD_SVG}</button>`;
}
function wireSidebarGroupProtect(el, g) {
  const b = el.querySelector('.sg-protect');
  if (b) b.addEventListener('click', e => { e.stopPropagation(); openProtectGroup(g); });
}

// ── Đổi tên / xóa nhóm trong "Quản lý nhóm" ───────────────
async function renameGroupWithLock(oldName, newName) {
  let code = '';
  if (groupIsLocked(oldName)) {
    code = await askCode({ title: `Đổi tên nhóm khóa "${oldName}"`, message: `Nhập mã nhóm (hoặc mã CEO) để đổi tên thành "${newName}".`, placeholder: 'Mã nhóm', okLabel: 'Đổi tên' });
    if (!code) return false;
  }
  const r = await window.app.renameGroupInProfiles(oldName, newName, code);
  if (r && typeof r === 'object' && r.success === false) { showToast(r.error || 'Không đổi được tên nhóm', 'error'); return false; }
  return true;
}
// Lưu danh sách nhóm; nhóm đang khóa bị xóa thì hỏi mã CEO. Trả true nếu đã lưu.
async function saveGroupListWithLock(groups) {
  let r = await window.app.saveGroups(groups);
  if (r && typeof r === 'object' && r.success === false) {
    if (!r.needCode) { showToast(r.error || 'Không lưu được', 'error'); return false; }
    const names = (r.groups || []).map(g => `"${g}"`).join(', ');
    const code = await askCode({
      title: 'Xóa nhóm được bảo vệ',
      message: r.needCeo
        ? `Nhóm ${names} đang khóa (hoặc có cảnh báo có mã). Xóa nhóm sẽ gỡ khóa, xóa cảnh báo của nhóm — cần mã CEO.`
        : `Nhóm ${names} có cảnh báo có mã. Xóa nhóm sẽ xóa cảnh báo — cần mã cảnh báo của nhóm hoặc mã CEO.`,
      placeholder: r.needCeo ? 'Mã CEO' : 'Mã cảnh báo hoặc mã CEO', okLabel: 'Xóa nhóm',
    });
    if (!code) return false;
    r = await window.app.saveGroups(groups, code);
    if (r && typeof r === 'object' && r.success === false) { showToast(r.error || 'Mã không đúng', 'error'); return false; }
  }
  return true;
}

// ── Làm mới khi dữ liệu khóa đổi ─────────────────────────
function scheduleLockRefresh() {
  clearTimeout(_lockRefreshTimer);
  _lockRefreshTimer = setTimeout(softRescanForLocks, 250);
}
async function softRescanForLocks() {
  await loadLockStatus();
  try {
    const result = await window.app.scanProfiles();
    allProfiles = result.profiles;
    for (const p of allProfiles) if (isProfileBlocked(p)) delete profileSocialCache[p.profileDirectory];   // không giữ dữ liệu đăng nhập của Chrome khóa
    updateStats(allProfiles);
  } catch { /* giữ danh sách cũ */ }
  renderSidebar(); applyFilter();
}
function initLockUi() {
  if (window.app.onLocksChanged) window.app.onLocksChanged(() => scheduleLockRefresh());
  renderLockSettings();
}
