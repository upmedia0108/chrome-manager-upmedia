const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { autoUpdater } = require('electron-updater');

// Chờ cookie do extension gửi về, khớp theo token
const pendingCookieCaptures = new Map();

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

const chromeProfiles = require('./src/chromeProfiles');
const shortcuts = require('./src/shortcuts');
const configStore = require('./src/configStore');
const storage = require('./src/storage');
const extensions = require('./src/extensions');
const extHost = require('./src/extHost');
const history = require('./src/history');
const accounts = require('./src/accounts');
const social = require('./src/socialAccounts');
const chromeWindows = require('./src/chromeWindows');
const locks = require('./src/locks');
const { createLockService } = require('./src/lockService');

// ── Khóa Chrome bằng mã (v1.11) — xem src/locks.js, src/lockService.js, CLAUDE.md Mục 20 ──
// Dữ liệu khóa: <userData>/locks.json (chính) + %LOCALAPPDATA%\UP Media\Chrome Manager\locks-backup.json (dự phòng)
// + dấu niêm phong HKCU\Software\UP Media\Chrome Manager → LockSeal; khóa niêm phong <userData>/lock.key (DPAPI qua safeStorage).
const LOCK_REG_KEY = 'HKCU\\Software\\UP Media\\Chrome Manager';
let lockSvc = null;
function lockSealStore() {
  return {
    read() {
      if (process.platform !== 'win32') return null;
      try {
        const out = execFileSync('reg', ['query', LOCK_REG_KEY, '/v', 'LockSeal'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /LockSeal\s+REG_SZ\s+(\S+)/.exec(out || '');
        return m ? m[1] : null;
      } catch { return null; }
    },
    write(v) {
      if (process.platform !== 'win32') return;
      execFileSync('reg', ['add', LOCK_REG_KEY, '/v', 'LockSeal', '/t', 'REG_SZ', '/d', v, '/f'], { windowsHide: true, stdio: 'ignore' });
    },
  };
}
// Khóa bí mật + mỏ neo (bộ đếm, băm mã CEO / mã khẩn cấp) — chuỗi JSON, mã hóa Windows DPAPI qua safeStorage
function lockKeyStore(file) {
  return {
    load() {
      let buf;
      try { buf = fs.readFileSync(file); } catch { return null; }
      try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'); }
      catch { return null; }
    },
    save(str) {
      const text = String(str);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8'));
      fs.renameSync(tmp, file);
    },
  };
}
// Tên Chrome (tên đặt trong app → tên trong Chrome → thư mục) cho tin nhắn cấp mã + xóa shortcut
function chromeDisplayNames(dir) {
  const saved = (configStore.getConfig().profiles || {})[dir] || {};
  const names = [saved.shortcutName];
  try {
    const udp = chromeProfiles.findUserDataPath(configStore.getConfig().settings?.chromeUserDataPath || null);
    const ls = JSON.parse(fs.readFileSync(path.join(udp, 'Local State'), 'utf8'));
    names.push(ls?.profile?.info_cache?.[dir]?.name);
  } catch { /* bỏ qua */ }
  names.push(dir);
  return [...new Set(names.filter(Boolean))];
}
function initLockService() {
  const userData = app.getPath('userData');
  const store = locks.createLockStore({
    primaryPath: path.join(userData, 'locks.json'),
    mirrorPath: path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'UP Media', 'Chrome Manager', 'locks-backup.json'),
    keyStore: lockKeyStore(path.join(userData, 'lock.key')),
    sealStore: lockSealStore(),
  });
  lockSvc = createLockService({
    store, configStore,
    getUserDataPath: () => currentUserDataPath(),
    getLoadedDirs: udp => chromeWindows.getLoadedProfileDirs(udp),
    listWindows: () => chromeWindows.listChromeWindows(),
    deleteShortcutsForDir: dir => { for (const n of chromeDisplayNames(dir)) { try { shortcuts.deleteShortcut(n); } catch { /* bỏ qua */ } } },
    displayName: dir => chromeDisplayNames(dir)[0],
    onChange: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('locks-changed'); },
  });
  try { lockSvc.reload(); } catch (e) { console.error('[locks] lỗi đọc dữ liệu khóa', e); }
}
// Chrome đang khóa và chưa mở khóa → kết quả trả về cho giao diện
function lockedBlock(dir) {
  if (!lockSvc || !lockSvc.isBlocked(dir)) return null;
  return { success: false, locked: true, lock: lockSvc.lockOf(dir), error: 'Chrome này đang khóa — nhập mã để mở.' };
}
const dirOfPath = p => path.basename(String(p || ''));
// Chrome đang khóa theo tên thư mục HOẶC theo đường dẫn (handler nhận cả hai thì kiểm cả hai)
function blockedAny(dir, profilePath) { return lockedBlock(dir) || (profilePath ? lockedBlock(dirOfPath(profilePath)) : null); }

let mainWindow;

// ── Tự chạy dưới quyền Administrator (khắc phục lỗi thỉnh thoảng không bắt được Unikey) ──
// Windows chỉ cho tiến trình gõ tiếng Việt vào cửa sổ CÙNG hoặc THẤP hơn mức toàn vẹn (UAC).
// Chạy app ở mức Administrator giúp nó nhận được ký tự Unikey ổn định hơn.
function isElevated() {
  return new Promise(resolve => {
    // "net session" chỉ chạy được khi có quyền Administrator → mã lỗi khác 0 nghĩa là chưa nâng quyền
    exec('net session', { windowsHide: true }, err => resolve(!err));
  });
}

// Trả về true nếu được phép tiếp tục chạy tiến trình hiện tại; false nếu đã relaunch bản nâng quyền và cần thoát.
async function ensureElevated() {
  if (process.platform !== 'win32') return true;
  if (!app.isPackaged) return true;              // môi trường dev: bỏ qua để không lặp UAC
  if (process.argv.includes('--elevated')) return true; // đã là bản được relaunch
  // Cho phép người dùng tắt tính năng trong Cài đặt
  const settings = configStore.getConfig().settings || {};
  if (settings.autoElevate === false) return true;
  if (await isElevated()) return true;

  return new Promise(resolve => {
    const exe = process.execPath.replace(/'/g, "''");
    const psCmd = `Start-Process -FilePath '${exe}' -ArgumentList '--elevated' -Verb RunAs`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], err => {
      if (err) {
        // Người dùng bấm "No" ở UAC (hoặc lỗi) → vẫn chạy tiếp bản thường để không mất phần mềm
        resolve(true);
      } else {
        // Đã mở bản nâng quyền → đóng bản thường này
        app.quit();
        resolve(false);
      }
    });
  });
}

// Menu tối giản: chỉ giữ nhóm "Chỉnh sửa" để phím Sao chép/Dán vẫn hoạt động,
// đồng thời BỎ các phím tắt mặc định (Ctrl+R nạp lại, Ctrl+Q thoát) để nhường cho phím tắt trong app.
function setupAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Chỉnh sửa',
      submenu: [
        { role: 'undo', label: 'Hoàn tác' },
        { role: 'redo', label: 'Làm lại' },
        { type: 'separator' },
        { role: 'cut', label: 'Cắt' },
        { role: 'copy', label: 'Sao chép' },
        { role: 'paste', label: 'Dán' },
        { role: 'selectAll', label: 'Chọn tất cả' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Chrome Manager by UP Media',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,   // Ẩn thanh menu (vẫn giữ phím Sao chép/Dán)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#f8fafc',
    show: false
  });
  // Cửa sổ chỉ hiện trang của app: chặn chuyển trang (kéo thả file .html…) và mở cửa sổ mới — trang lạ không được dùng window.app
  mainWindow.webContents.on('will-navigate', e => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();   // Mở toàn màn hình theo mặc định
    mainWindow.show();
  });
}

app.whenReady().then(async () => {
  configStore.init(app.getPath('userData'));

  if (!(await ensureElevated())) return;   // đã relaunch bản Administrator → thoát bản thường

  initLockService();
  setupAppMenu();
  createWindow();
  setupAutoUpdate();

  // Khởi động localhost host cho tiện ích tự đóng gói; cập nhật lại URL theo port mới
  try {
    extHost.init(app.getPath('userData'));
    extHost.onCookies(data => {
      if (!data || !data.token) return;
      const pend = pendingCookieCaptures.get(data.token);
      if (pend) { pendingCookieCaptures.delete(data.token); clearTimeout(pend.timer); pend.resolve(data.cookies || []); }
    });
    const p = await extHost.start(47810);
    extHost.writeTrigger();
    const exts = configStore.getExternalExtensions();
    if (p && exts.length) {
      extHost.rehostAll(exts);
      const pol = configStore.getExtPolicy();
      for (const e of exts) pol.updateUrls[e.id] = extHost.updateUrlFor(e.id);
      configStore.saveExtPolicy(pol);
      await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);
    }
  } catch { /* ignore */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Tự động cập nhật (electron-updater + GitHub Releases, repo Public) ──
// App tự kiểm tra bản mới trên GitHub, tải nền, rồi hỏi người dùng khởi động lại để cập nhật.
let _updateState = { status: 'idle', version: null, error: null };
function setupAutoUpdate() {
  if (!app.isPackaged) return;   // dev: bỏ qua
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info => { _updateState = { status: 'downloading', version: info?.version || null, error: null }; });
  autoUpdater.on('update-not-available', () => { _updateState = { status: 'none', version: null, error: null }; });
  autoUpdater.on('error', err => { _updateState = { status: 'error', version: null, error: (err && err.message) || String(err) }; });
  autoUpdater.on('update-downloaded', async info => {
    _updateState = { status: 'downloaded', version: info?.version || null, error: null };
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Đã có bản cập nhật mới',
        message: `Phiên bản mới ${info?.version || ''} đã tải xong.`,
        detail: 'Khởi động lại phần mềm để cập nhật ngay? (Các thao tác đang làm nên lưu trước.)',
        buttons: ['Để sau', 'Khởi động lại & cập nhật'],
        defaultId: 1,
        cancelId: 0,
      });
      if (response === 1) { setImmediate(() => autoUpdater.quitAndInstall()); }
    } catch { /* ignore */ }
  });

  // Kiểm tra khi khởi động (chờ cửa sổ sẵn sàng một chút)
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
}

// Kiểm tra cập nhật thủ công (nút trong Cài đặt)
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: false, dev: true, current: app.getVersion() };
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    const current = app.getVersion();
    const hasUpdate = !!(latest && latest !== current);
    return { ok: true, current, latest, hasUpdate, state: _updateState };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), current: app.getVersion() };
  }
});

// Scan
ipcMain.handle('scan-profiles', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  const { profiles, userDataPath, machineCount, machineProfiles, missing } = chromeProfiles.scanProfiles(customPath);
  configStore.saveSettings({ chromeUserDataPath: userDataPath });

  return {
    profiles: profiles.map((p, idx) => {
      const saved = config.profiles?.[p.profileDirectory] || {};
      const groups = saved.groups || (saved.group ? [saved.group] : []);
      const shortcutName = saved.shortcutName || p.chromeProfileName || p.profileDirectory;
      return {
        ...p,
        displayIndex: p.profileDirectory === 'Default' ? 0 : (parseInt(p.profileDirectory.replace('Profile ', '')) || idx + 1),
        shortcutName,
        groups,
        subGroups: saved.subGroups || {},
        notes: saved.notes || '',
        pinned: saved.pinned || false,
        hasShortcut: shortcuts.shortcutExists(shortcutName),
        cacheSize: null,
        googleAccounts: accounts.getGoogleAccounts(p.profilePath),
      };
    }).map(p => (lockSvc ? lockSvc.redactProfile(p) : p)),   // Chrome đang khóa: ẩn ghi chú, email
    userDataPath,
    machineCount,
    machineProfiles,
    missing,
  };
});

// Thông tin tài nguyên máy — dùng cho khuyến nghị chế độ Basic/Pro
ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus() || [];
  return {
    totalRAM: os.totalmem(),
    freeRAM: os.freemem(),
    cpuCount: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : '',
    platform: process.platform,
  };
});

ipcMain.handle('save-profile-config', async (_, profileDirectory, data) => {
  if (lockSvc && data && typeof data === 'object') {
    // Chrome đang khóa (chưa mở khóa): chỉ cho ghim / bỏ ghim
    if (lockSvc.isBlocked(profileDirectory) && Object.keys(data).some(k => k !== 'pinned')) return lockedBlock(profileDirectory);
    // Thêm / gỡ nhóm ĐANG KHÓA phải qua lock-add-member / lock-remove-member (cần mã nhóm)
    if (Array.isArray(data.groups)) {
      const saved = (configStore.getConfig().profiles || {})[profileDirectory] || {};
      const before = new Set(saved.groups || []), after = new Set(data.groups);
      const lockedGroups = Object.keys(lockSvc.state().groupLocks || {});
      const touched = lockedGroups.filter(g => before.has(g) !== after.has(g));
      if (touched.length) return { success: false, code: 'LOCKED_GROUP', group: touched[0], error: `Nhóm "${touched[0]}" đang khóa — cần mã nhóm để thêm hoặc gỡ Chrome.` };
    }
  }
  return configStore.saveProfileConfig(profileDirectory, data);
});

ipcMain.handle('check-duplicate-name', async (_, profileDirectory, name) => {
  if (!name || !name.trim()) return { isDuplicate: false };
  const config = configStore.getConfig();
  const profiles = config.profiles || {};
  for (const [dir, p] of Object.entries(profiles)) {
    if (dir === profileDirectory) continue;
    if ((p.shortcutName || '').trim().toLowerCase() === name.trim().toLowerCase()) {
      return { isDuplicate: true, conflictDir: dir, conflictName: p.shortcutName };
    }
  }
  return { isDuplicate: false };
});

// Chrome đang mở THEO TỪNG PROFILE (v1.10.6): dò khóa file dữ liệu của profile — xem src/chromeWindows.js.
// Bản cũ đọc dòng lệnh tiến trình chrome.exe → chỉ thấy profile mở ĐẦU TIÊN (Chrome gom mọi profile vào 1 tiến trình).
function currentUserDataPath() {
  return chromeProfiles.findUserDataPath(configStore.getConfig().settings?.chromeUserDataPath || null);
}

// Tập hợp các profile-directory (chữ thường) hiện đang được Chrome mở.
// Dùng để không mở chồng Chrome đã mở sẵn + nhãn "Đang mở" (làm mới mỗi 4 giây — nhẹ, không gọi PowerShell).
async function getRunningProfileDirs() {
  try { return chromeWindows.getLoadedProfileDirs(currentUserDataPath()); }
  catch { return new Set(); }
}

async function isChromeRunningForProfile(profileDirectory) {
  return (await getRunningProfileDirs()).has(String(profileDirectory || '').toLowerCase());
}

ipcMain.handle('delete-chrome-profile', async (_, profilePath, profileDirectory, displayName) => {
  if (lockSvc && (lockSvc.isLocked(profileDirectory) || lockSvc.isLocked(dirOfPath(profilePath)))) {
    return { success: false, locked: true, error: 'Chrome này đang khóa — cần mã CEO gỡ khóa trước khi xóa.' };
  }
  const running = await isChromeRunningForProfile(profileDirectory);
  if (running) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Chrome đang mở',
      message: `Không thể xóa — Chrome đang chạy profile "${displayName}"`,
      detail: 'Vui lòng đóng Chrome trước rồi thử lại.\nBấm nút "Đóng tất cả Chrome" trên toolbar để tắt tất cả.',
      buttons: ['OK']
    });
    return { success: false, cancelled: true };
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Xác nhận xóa profile',
    message: `Xóa tài khoản Chrome "${displayName}"?`,
    detail: `Hành động này sẽ XÓA VĨNH VIỄN tất cả dữ liệu của tài khoản này bao gồm: lịch sử duyệt web, cookie, mật khẩu đã lưu, bookmark...\n\nThư mục: ${profilePath}`,
    buttons: ['Hủy bỏ', 'XÓA VĨNH VIỄN'],
    defaultId: 0,
    cancelId: 0
  });

  if (response !== 1) return { success: false, cancelled: true };

  try {
    if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { recursive: true, force: true });
    configStore.deleteProfileConfig(profileDirectory);
    // Sửa gốc: dọn luôn tên profile khỏi Local State để Chrome không còn nhớ (tránh sinh "profile ma")
    try {
      const udp = chromeProfiles.findUserDataPath(configStore.getConfig().settings?.chromeUserDataPath || null);
      if (udp) chromeProfiles.removeProfilesFromLocalState(udp, [profileDirectory]);
    } catch { /* best-effort */ }
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Không xóa được: ' + err.message };
  }
});

// Dọn "profile ma": đóng toàn bộ Chrome rồi xóa các entry Chrome còn nhớ nhưng thư mục đã mất
ipcMain.handle('clean-ghost-profiles', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  // Phải đóng hẳn Chrome để Chrome không ghi đè lại Local State
  await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });
  await new Promise(r => setTimeout(r, 800));
  let userDataPath, missing;
  try { ({ userDataPath, missing } = chromeProfiles.scanProfiles(customPath)); }
  catch (err) { return { success: false, error: err.message }; }
  const dirs = (missing || []).map(m => m.profileDirectory);
  if (!dirs.length) return { success: true, removed: 0 };
  const res = chromeProfiles.removeProfilesFromLocalState(userDataPath, dirs);
  for (const d of dirs) configStore.deleteProfileConfig(d);
  return { success: res.ok, removed: res.removed || 0, error: res.error || null };
});

ipcMain.handle('kill-all-chrome', async () => {
  if (lockSvc) lockSvc.relockAll();   // đóng hết Chrome → Chrome đang mở khóa khóa lại ngay
  return new Promise(resolve => {
    exec('taskkill /F /IM chrome.exe /T', (err, stdout, stderr) => {
      const output = (stdout + stderr).toLowerCase();
      const notFound = output.includes('not found') || output.includes('không tìm thấy') || (err && err.code === 128);
      resolve({ success: true, notFound });
    });
  });
});

ipcMain.handle('create-shortcut', async (_, profileDirectory, shortcutName) => {
  if (lockSvc && lockSvc.isLocked(profileDirectory)) return { success: false, locked: true, error: 'Chrome đang khóa — không tạo shortcut ngoài Desktop (để không mở vòng qua app).' };
  try {
    const lnkPath = shortcuts.createShortcut({ profileDirectory, shortcutName });
    return { success: true, path: lnkPath };
  } catch (err) {
    if (err.message === 'CHROME_NOT_FOUND')
      return { success: false, error: 'Không tìm thấy Google Chrome trên máy.' };
    return { success: false, error: 'Không tạo được shortcut. Thử chạy app bằng quyền Administrator.' };
  }
});

ipcMain.handle('delete-shortcut', async (_, shortcutName) => {
  try {
    return { success: true, deleted: shortcuts.deleteShortcut(shortcutName) };
  } catch {
    return { success: false, error: 'Không xóa được shortcut.' };
  }
});

ipcMain.handle('open-profile', async (_, profileDirectory, opts) => {
  const blocked = lockedBlock(profileDirectory);
  if (blocked) return blocked;
  try {
    // Chrome đã mở sẵn profile này → đưa cửa sổ của nó lên trước thay vì mở chồng (trừ khi ép mở).
    // Không thấy cửa sổ nào (profile còn chạy ngầm) → mở cửa sổ mới như bình thường.
    if (!(opts && opts.force) && await isChromeRunningForProfile(profileDirectory)) {
      const f = await chromeWindows.focusProfileWindow(profileDirectory);
      if (!f.notFound) return { success: true, alreadyOpen: true, focused: !!f.success };
    }
    const config = configStore.getConfig();
    const userDataPath = config.settings?.chromeUserDataPath || null;
    syncChromeNameFor(profileDirectory);   // Hướng A: đồng bộ tên trước khi mở
    shortcuts.openProfile(profileDirectory, userDataPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message === 'CHROME_NOT_FOUND' ? 'Không tìm thấy Google Chrome.' : 'Không mở được profile.' };
  }
});

// Hướng A: đồng bộ tên thân thiện (shortcutName) lên tên hiển thị của Chrome trước khi mở profile.
// Chỉ chạy khi profile đang đóng (các handler mở đều kiểm tra trước đó), nên an toàn.
function syncChromeNameFor(dir) {
  try {
    const config = configStore.getConfig();
    const udp = chromeProfiles.findUserDataPath(config.settings?.chromeUserDataPath || null);
    const name = config.profiles?.[dir]?.shortcutName;
    if (udp && name) chromeProfiles.applyProfileName(udp, dir, name);
  } catch { /* best-effort */ }
}

// Trả về danh sách profile-directory đang được Chrome mở (chữ thường)
ipcMain.handle('get-running-profiles', async () => {
  return Array.from(await getRunningProfileDirs());
});

// Hướng A (thủ công): đồng bộ tên tất cả profile lên Chrome — đóng Chrome trước cho chắc
ipcMain.handle('sync-all-profile-names', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });
  await new Promise(r => setTimeout(r, 900));
  let userDataPath, profiles;
  try { ({ userDataPath, profiles } = chromeProfiles.scanProfiles(customPath)); }
  catch (err) { return { success: false, error: err.message }; }
  let count = 0;
  for (const p of (profiles || [])) {
    const name = config.profiles?.[p.profileDirectory]?.shortcutName;
    if (name && chromeProfiles.applyProfileName(userDataPath, p.profileDirectory, name)) count++;
  }
  return { success: true, count };
});

// Hướng B: đưa cửa sổ Chrome của 1 profile lên trước màn hình (tìm đúng cửa sổ theo thuộc tính Windows của từng cửa sổ;
// "Profile 1" không dính "Profile 14"; cửa sổ đang phóng to giữ nguyên) — src/chromeWindows.js
ipcMain.handle('focus-profile-window', async (_, profileDirectory) => {
  const dir = String(profileDirectory || '');
  if (!dir) return { success: false };
  const blocked = lockedBlock(dir);
  if (blocked) return blocked;
  return chromeWindows.focusProfileWindow(dir);
});

ipcMain.handle('open-profile-url', async (_, profileDirectory, url) => {
  const blocked = lockedBlock(profileDirectory);
  if (blocked) return blocked;
  try {
    const config = configStore.getConfig();
    const userDataPath = config.settings?.chromeUserDataPath || null;
    syncChromeNameFor(profileDirectory);
    shortcuts.openProfileWithUrl(profileDirectory, url, userDataPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-profiles-batch', async (_, profileDirectories) => {
  const config = configStore.getConfig();
  const userDataPath = config.settings?.chromeUserDataPath || null;
  const running = await getRunningProfileDirs();   // bỏ qua profile đã mở sẵn
  let ok = 0, fail = 0, skipped = 0, lockedSkipped = 0;
  for (const dir of profileDirectories) {
    if (lockSvc && lockSvc.isBlocked(dir)) { lockedSkipped++; continue; }   // Chrome đang khóa chưa nhập mã
    if (running.has(String(dir).toLowerCase())) { skipped++; continue; }
    try { syncChromeNameFor(dir); shortcuts.openProfile(dir, userDataPath); ok++; await new Promise(r => setTimeout(r, 350)); }
    catch { fail++; }
  }
  return { success: true, ok, fail, skipped, lockedSkipped };
});

ipcMain.handle('check-shortcut-exists', async (_, name) => shortcuts.shortcutExists(name));

ipcMain.handle('pick-user-data-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục Chrome User Data',
    properties: ['openDirectory'],
    buttonLabel: 'Chọn thư mục này'
  });
  if (result.canceled || !result.filePaths.length) return null;
  const chosen = result.filePaths[0];
  configStore.saveSettings({ chromeUserDataPath: chosen });
  return chosen;
});

ipcMain.handle('get-version', async () => app.getVersion());

// Mở link ngoài bằng trình duyệt mặc định (dùng cho danh sách tiện ích UP Media trên Store)
ipcMain.handle('open-external', async (_, url) => {
  try {
    if (!/^https:\/\//i.test(String(url || ''))) return { success: false, error: 'URL không hợp lệ' };
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('get-settings', async () => configStore.getConfig().settings || {});

ipcMain.handle('get-groups', async () => configStore.getGroups());
ipcMain.handle('save-groups', async (_, groups, code) => {
  // Nhóm bị xóa khỏi danh sách: nhóm đang khóa cần mã CEO (cảnh báo của nhóm đi theo)
  if (lockSvc) {
    const removed = (configStore.getGroups() || []).filter(g => !(groups || []).includes(g));
    const r = lockSvc.deleteGroups(code, removed);
    if (!r.success) {
      const st = lockSvc.state();
      const guarded = removed.filter(g => st.groupLocks[g] || (st.warnings.groups[g] || {}).code);
      return { ...r, needCode: true, needCeo: guarded.some(g => st.groupLocks[g]), groups: guarded };
    }
  }
  return configStore.saveGroups(groups);
});
ipcMain.handle('get-group-subs', async () => configStore.getGroupSubs());
ipcMain.handle('save-group-subs', async (_, groupSubs) => configStore.saveGroupSubs(groupSubs));

ipcMain.handle('create-chrome-profile', async (_, friendlyName, groups, subGroups, notes) => {
  try {
    const config = configStore.getConfig();
    const { userDataPath } = chromeProfiles.scanProfiles(config.settings?.chromeUserDataPath || null);
    const newDir = chromeProfiles.getNextProfileDirectory(userDataPath);
    const saveData = {};
    if (friendlyName && friendlyName.trim()) saveData.shortcutName = friendlyName.trim();
    // Nhóm đang khóa không gán thẳng được (cần mã nhóm) → bỏ ra, báo lại cho giao diện
    const lockedNow = new Set(lockSvc ? Object.keys(lockSvc.state().groupLocks || {}) : []);
    const strippedLockedGroups = (groups || []).filter(g => lockedNow.has(g));
    groups = (groups || []).filter(g => !lockedNow.has(g));
    if (Array.isArray(groups) && groups.length) saveData.groups = groups;
    if (subGroups && Object.keys(subGroups).length) saveData.subGroups = subGroups;
    if (notes && notes.trim()) saveData.notes = notes.trim();
    if (Object.keys(saveData).length) configStore.saveProfileConfig(newDir, saveData);
    shortcuts.openProfile(newDir, userDataPath);
    return { success: true, profileDirectory: newDir, strippedLockedGroups };
  } catch (err) {
    return { success: false, error: err.message === 'CHROME_NOT_FOUND' ? 'Không tìm thấy Google Chrome.' : err.message };
  }
});

ipcMain.handle('get-avatar-data-url', async (_, avatarPath) => {
  try {
    if (!avatarPath || !fs.existsSync(avatarPath)) return null;
    return 'data:image/png;base64,' + fs.readFileSync(avatarPath).toString('base64');
  } catch { return null; }
});

ipcMain.handle('get-cache-size', async (_, profilePath) => storage.getProfileCacheSize(profilePath));

ipcMain.handle('get-all-cache-sizes', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  const { profiles } = chromeProfiles.scanProfiles(customPath);
  const result = {};
  for (const p of profiles) result[p.profileDirectory] = storage.getProfileCacheSize(p.profilePath);
  return result;
});

ipcMain.handle('clear-cache', async (_, profilePath) => {
  try {
    const freed = storage.clearProfileCache(profilePath);
    return { success: true, freed, freedText: storage.formatBytes(freed) };
  } catch (err) {
    return { success: false, error: 'Không xóa được cache: ' + err.message };
  }
});

ipcMain.handle('clear-all-cache', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  const { profiles } = chromeProfiles.scanProfiles(customPath);
  let totalFreed = 0, errorCount = 0;
  for (const p of profiles) {
    try { totalFreed += storage.clearProfileCache(p.profilePath); }
    catch { errorCount++; }
  }
  return { success: true, freed: totalFreed, freedText: storage.formatBytes(totalFreed), errorCount };
});

// ── Quản lý tiện ích ──────────────────────────────────────
// 1. Liệt kê tiện ích của 1 profile
ipcMain.handle('list-profile-extensions', async (_, profilePath) => {
  try { return { success: true, items: extensions.listProfileExtensions(profilePath) }; }
  catch (err) { return { success: false, error: err.message, items: [] }; }
});

// Đếm số tiện ích của tất cả profile (cho chế độ hàng tinh gọn)
ipcMain.handle('count-all-extensions', async () => {
  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  const { profiles } = chromeProfiles.scanProfiles(customPath);
  const result = {};
  for (const p of profiles) {
    try { result[p.profileDirectory] = extensions.listProfileExtensions(p.profilePath).length; }
    catch { result[p.profileDirectory] = 0; }
  }
  return result;
});

// 3. Xóa 1 tiện ích khỏi TẤT CẢ profile + chặn tự cài lại (kể cả hàng chờ)
ipcMain.handle('delete-extension-everywhere', async (_, extId) => {
  if (!/^[a-p]{32}$/.test(extId || '')) return { success: false, error: 'ID tiện ích không hợp lệ' };
  // Đóng Chrome để mở khóa Preferences trước khi sửa
  await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });
  await new Promise(r => setTimeout(r, 800));

  const config = configStore.getConfig();
  const customPath = config.settings?.chromeUserDataPath || null;
  const { profiles } = chromeProfiles.scanProfiles(customPath);
  let totalRemoved = 0, profilesAffected = 0;
  for (const p of profiles) {
    const { removed } = extensions.removeExtensionIdsFromProfile(p.profilePath, [extId]);
    if (removed > 0) { totalRemoved += removed; profilesAffected++; }
  }

  await extensions.removeQueueForIds([extId]);

  // Cập nhật chính sách: bỏ khỏi forcelist, thêm vào blocklist
  const pol = configStore.getExtPolicy();
  pol.forcelist = pol.forcelist.filter(id => id !== extId);
  delete pol.updateUrls[extId];
  if (!pol.blocklist.includes(extId)) pol.blocklist.push(extId);
  configStore.saveExtPolicy(pol);
  // Gỡ khỏi danh sách tiện ích tự host nếu có
  const exts = configStore.getExternalExtensions().filter(e => e.id !== extId);
  configStore.saveExternalExtensions(exts);
  await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);

  return { success: true, totalRemoved, profilesAffected };
});

// 2B. Nhân bản 1 tiện ích ra TẤT CẢ Chrome qua chính sách force-install
ipcMain.handle('copy-extension-to-all', async (_, extId) => {
  if (!/^[a-p]{32}$/.test(extId || '')) return { success: false, error: 'ID tiện ích không hợp lệ' };
  const pol = configStore.getExtPolicy();
  pol.blocklist = pol.blocklist.filter(id => id !== extId);
  if (!pol.forcelist.includes(extId)) pol.forcelist.push(extId);
  configStore.saveExtPolicy(pol);
  const verify = await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);
  const written = (verify.idsWritten || []).includes(extId);
  return {
    success: written,
    hkcuOk: verify.hkcuOk, hklmOk: verify.hklmOk,
    error: written ? null : 'Không ghi được policy vào registry. Thử chạy phần mềm bằng quyền Administrator.',
  };
});

// Danh sách chính sách hiện tại (để UI hiển thị / gỡ)
ipcMain.handle('get-ext-policy', async () => configStore.getExtPolicy());
ipcMain.handle('clear-ext-policy-entry', async (_, extId) => {
  const pol = configStore.getExtPolicy();
  pol.forcelist = pol.forcelist.filter(id => id !== extId);
  pol.blocklist = pol.blocklist.filter(id => id !== extId);
  delete pol.updateUrls[extId];
  configStore.saveExtPolicy(pol);
  await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);
  return { success: true };
});

// P2: Nhập tiện ích NGOÀI STORE hàng loạt — đóng gói thư mục → host → force-install
ipcMain.handle('install-external-extension', async () => {
  const chromePath = shortcuts.findChrome();
  if (!chromePath) return { success: false, error: 'Không tìm thấy Google Chrome.' };
  if (!extHost.getPort()) return { success: false, error: 'Máy chủ nội bộ chưa sẵn sàng. Mở lại phần mềm rồi thử lại.' };

  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục tiện ích (đã giải nén, có manifest.json)',
    properties: ['openDirectory'],
    buttonLabel: 'Chọn thư mục này',
  });
  if (res.canceled || !res.filePaths.length) return { success: false, cancelled: true };

  let packed;
  try { packed = await extHost.packAndHost(chromePath, res.filePaths[0]); }
  catch (err) { return { success: false, error: err.message }; }

  // Lưu vào danh sách tự host + policy force-install với update URL nội bộ
  const exts = configStore.getExternalExtensions().filter(e => e.id !== packed.id);
  exts.push({ id: packed.id, version: packed.version, folder: res.filePaths[0], name: path.basename(res.filePaths[0]) });
  configStore.saveExternalExtensions(exts);

  const pol = configStore.getExtPolicy();
  pol.blocklist = pol.blocklist.filter(id => id !== packed.id);
  if (!pol.forcelist.includes(packed.id)) pol.forcelist.push(packed.id);
  pol.updateUrls[packed.id] = packed.updateUrl;
  configStore.saveExtPolicy(pol);
  const verify = await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);

  const written = (verify.idsWritten || []).includes(packed.id);
  return {
    success: written,
    id: packed.id, version: packed.version,
    error: written ? null : 'Không ghi được policy vào registry. Thử chạy phần mềm bằng quyền Administrator.',
  };
});

// ── Export / Import dữ liệu cấu hình profile (Excel) ──────
const COL = { dir: 'Thư mục', name: 'Tên profile', groups: 'Nhóm', subs: 'Danh mục con', notes: 'Ghi chú' };

function encodeSubGroups(subGroups) {
  return Object.entries(subGroups || {})
    .filter(([, arr]) => arr && arr.length)
    .map(([g, arr]) => `${g}: ${arr.join(', ')}`)
    .join('; ');
}
function decodeSubGroups(str) {
  const out = {};
  String(str || '').split(';').forEach(part => {
    const idx = part.indexOf(':');
    if (idx === -1) return;
    const g = part.slice(0, idx).trim();
    const subs = part.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
    if (g && subs.length) out[g] = subs;
  });
  return out;
}
function splitList(str) { return String(str || '').split(/[,;]/).map(s => s.trim()).filter(Boolean); }
// Lấy giá trị ô theo tên cột, chấp nhận cả có dấu lẫn không dấu / hoa thường
function pick(row, label) {
  if (row[label] != null) return row[label];
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,'');
  const want = norm(label);
  for (const k of Object.keys(row)) if (norm(k) === want) return row[k];
  return '';
}

ipcMain.handle('export-data', async () => {
  const config = configStore.getConfig();
  const { profiles } = chromeProfiles.scanProfiles(config.settings?.chromeUserDataPath || null);
  const rows = profiles.map(p => {
    const saved = config.profiles?.[p.profileDirectory] || {};
    return {
      [COL.dir]: p.profileDirectory,
      [COL.name]: saved.shortcutName || p.chromeProfileName || p.profileDirectory,
      [COL.groups]: (saved.groups || []).join(', '),
      [COL.subs]: encodeSubGroups(saved.subGroups),
      [COL.notes]: lockSvc && lockSvc.isLocked(p.profileDirectory) ? '(Chrome đang khóa — ghi chú không xuất ra file)' : (saved.notes || ''),
    };
  });

  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất dữ liệu ra Excel',
    defaultPath: `upmedia-chrome-export-${new Date().toISOString().slice(0, 10)}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (res.canceled || !res.filePath) return { success: false, cancelled: true };
  try {
    const ws = XLSX.utils.json_to_sheet(rows, { header: [COL.dir, COL.name, COL.groups, COL.subs, COL.notes] });
    ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 32 }, { wch: 42 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Profiles');
    XLSX.writeFile(wb, res.filePath);
    return { success: true, path: res.filePath, count: rows.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Tải file Excel mẫu để điền thông tin nhập hàng loạt
ipcMain.handle('export-template', async () => {
  const rows = [
    { [COL.dir]: '(để trống — tự tạo)', [COL.name]: 'Seeding FB 01', [COL.groups]: 'Seeding, BM', [COL.subs]: 'Seeding: Facebook', [COL.notes]: 'Ví dụ tài khoản seeding' },
    { [COL.dir]: '(để trống — tự tạo)', [COL.name]: 'Ads Meta 02', [COL.groups]: 'Ads', [COL.subs]: 'Ads: Meta, Google', [COL.notes]: '' },
    { [COL.dir]: '(để trống — tự tạo)', [COL.name]: '', [COL.groups]: '', [COL.subs]: '', [COL.notes]: '' },
  ];
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Lưu file Excel mẫu',
    defaultPath: 'upmedia-mau-nhap-profile.xlsx',
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (res.canceled || !res.filePath) return { success: false, cancelled: true };
  try {
    const ws = XLSX.utils.json_to_sheet(rows, { header: [COL.dir, COL.name, COL.groups, COL.subs, COL.notes] });
    ws['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 22 }, { wch: 32 }, { wch: 42 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau nhap');
    XLSX.writeFile(wb, res.filePath);
    return { success: true, path: res.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Import từ Excel → tự tạo Chrome profile mới cho từng dòng
ipcMain.handle('import-data', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập dữ liệu từ Excel',
    properties: ['openFile'],
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (res.canceled || !res.filePaths.length) return { success: false, cancelled: true };

  let rows;
  try {
    const wb = XLSX.readFile(res.filePaths[0]);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch { return { success: false, error: 'File Excel không đọc được.' }; }
  if (!rows.length) return { success: false, error: 'File không có dòng dữ liệu nào.' };

  const config = configStore.getConfig();
  const { userDataPath } = chromeProfiles.scanProfiles(config.settings?.chromeUserDataPath || null);

  // Gộp nhóm mới xuất hiện vào cấu hình
  const curGroups = new Set(configStore.getGroups() || []);
  const curSubs = configStore.getGroupSubs() || {};

  let nextIdx = 0;
  try {
    for (const e of fs.readdirSync(userDataPath)) {
      const m = e.match(/^Profile (\d+)$/);
      if (m) nextIdx = Math.max(nextIdx, parseInt(m[1]));
    }
  } catch {}

  let created = 0, failed = 0;
  for (const row of rows) {
    const name = String(pick(row, COL.name) || '').trim();
    const lockedNow = new Set(lockSvc ? Object.keys(lockSvc.state().groupLocks || {}) : []);
    const groups = splitList(pick(row, COL.groups)).filter(g => !lockedNow.has(g));   // nhóm đang khóa: phải thêm bằng mã nhóm
    const subGroups = decodeSubGroups(pick(row, COL.subs));
    for (const g of lockedNow) delete subGroups[g];
    const notes = String(pick(row, COL.notes) || '').trim();
    if (!name && !groups.length && !notes) continue;   // bỏ dòng trống

    groups.forEach(g => curGroups.add(g));
    for (const [g, subs] of Object.entries(subGroups)) {
      curSubs[g] = Array.from(new Set([...(curSubs[g] || []), ...subs]));
    }

    nextIdx++;
    const newDir = `Profile ${nextIdx}`;
    const saveData = {};
    if (name) saveData.shortcutName = name;
    if (groups.length) saveData.groups = groups;
    if (Object.keys(subGroups).length) saveData.subGroups = subGroups;
    if (notes) saveData.notes = notes;
    try {
      if (Object.keys(saveData).length) configStore.saveProfileConfig(newDir, saveData);
      shortcuts.openProfile(newDir, userDataPath);
      created++;
      await new Promise(r => setTimeout(r, 600));
    } catch { failed++; }
  }

  configStore.saveGroups(Array.from(curGroups));
  configStore.saveGroupSubs(curSubs);
  return { success: true, created, failed, total: rows.length };
});

// Xuất extension "Lấy cookie Facebook" ra Desktop để cài thủ công (load unpacked)
ipcMain.handle('export-cookie-extension', async () => {
  const srcDir = path.join(__dirname, 'assets', 'fb-cookie-extension');
  const destDir = path.join(shortcuts.getDesktopPath(), 'UP Media - FB Cookie Extension');
  try {
    copyDirRecursive(srcDir, destDir);
    shell.openPath(destDir);
    return { success: true, path: destDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Đóng gói extension Cookie Facebook thành ZIP sẵn sàng upload lên Chrome Web Store.
ipcMain.handle('zip-cookie-extension', async () => {
  const srcDir = path.join(__dirname, 'assets', 'fb-cookie-extension');
  const destZip = path.join(shortcuts.getDesktopPath(), 'fb-cookie-extension.zip');
  const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
  const command = [
    `$src = ${psQuote(srcDir)}`,
    `$dest = ${psQuote(destZip)}`,
    "Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dest -Force",
  ].join('; ');

  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], (error, _stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()));
        else resolve();
      });
    });
    shell.showItemInFolder(destZip);
    return { success: true, path: destZip };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-cookie-store-id', async (_, extId) => {
  const id = String(extId || '').trim();
  if (id && !/^[a-p]{32}$/.test(id)) {
    return { success: false, error: 'Extension ID phải gồm 32 ký tự từ a đến p.' };
  }
  const success = configStore.saveSettings({ cookieStoreExtId: id });
  return { success, error: success ? null : 'Không lưu được Extension ID.' };
});

// ── Xuất cookie Facebook qua localhost (opt-in) ───────────
ipcMain.handle('get-cookie-export-enabled', async () => ({
  enabled: !!(configStore.getConfig().settings || {}).cookieExportEnabled,
}));

ipcMain.handle('set-cookie-export-enabled', async (_, enabled) => {
  const pol = configStore.getExtPolicy();
  let exts = configStore.getExternalExtensions();
  const settings = configStore.getConfig().settings || {};

  if (enabled) {
    const chromePath = shortcuts.findChrome();
    if (!chromePath) return { success: false, error: 'Không tìm thấy Google Chrome.' };
    if (!extHost.getPort()) return { success: false, error: 'Máy chủ nội bộ chưa sẵn sàng.' };
    const srcDir = path.join(__dirname, 'assets', 'cookie-exporter');
    const dstDir = path.join(app.getPath('userData'), 'ext-host', 'cookie-exporter');
    try { copyDirRecursive(srcDir, dstDir); }
    catch (e) { return { success: false, error: 'Không sao chép được extension: ' + e.message }; }

    let packed;
    try { packed = await extHost.packAndHost(chromePath, dstDir); }
    catch (e) { return { success: false, error: e.message }; }
    extHost.writeTrigger();

    exts = exts.filter(e => e.id !== packed.id);
    exts.push({ id: packed.id, version: packed.version, folder: dstDir, name: 'UP Media Cookie Exporter', cookieExporter: true });
    configStore.saveExternalExtensions(exts);

    pol.blocklist = pol.blocklist.filter(id => id !== packed.id);
    if (!pol.forcelist.includes(packed.id)) pol.forcelist.push(packed.id);
    pol.updateUrls[packed.id] = packed.updateUrl;
    configStore.saveExtPolicy(pol);
    const verify = await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);
    if (!(verify.idsWritten || []).includes(packed.id))
      return { success: false, error: 'Không ghi được policy vào registry. Thử chạy bằng quyền Administrator.' };

    configStore.saveSettings({ cookieExportEnabled: true, cookieExporterId: packed.id });
    return { success: true, id: packed.id };
  } else {
    const id = settings.cookieExporterId;
    if (id) {
      pol.forcelist = pol.forcelist.filter(x => x !== id);
      delete pol.updateUrls[id];
      configStore.saveExtPolicy(pol);
      configStore.saveExternalExtensions(exts.filter(e => e.id !== id));
      await extensions.applyExtensionPolicy(pol.forcelist, pol.blocklist, pol.updateUrls);
    }
    configStore.saveSettings({ cookieExportEnabled: false });
    return { success: true };
  }
});

ipcMain.handle('export-facebook-cookies', async (_, profileDirectory) => {
  { const blocked = lockedBlock(profileDirectory); if (blocked) return blocked; }
  const settings = configStore.getConfig().settings || {};
  if (!settings.cookieExportEnabled) return { success: false, error: 'Chưa bật xuất cookie trong Cài đặt.' };
  const port = extHost.getPort();
  if (!port) return { success: false, error: 'Máy chủ nội bộ chưa sẵn sàng.' };

  const token = crypto.randomBytes(8).toString('hex');
  const url = `http://127.0.0.1:${port}/trigger.html?token=${token}&dir=${encodeURIComponent(profileDirectory)}`;
  const cookiesP = new Promise(resolve => {
    const timer = setTimeout(() => { pendingCookieCaptures.delete(token); resolve(null); }, 20000);
    pendingCookieCaptures.set(token, { resolve, timer });
  });
  try { shortcuts.openProfileWithUrl(profileDirectory, url, settings.chromeUserDataPath || null); }
  catch (e) { return { success: false, error: e.message }; }

  const cookies = await cookiesP;
  if (!cookies) return { success: false, error: 'Không nhận được phản hồi từ extension. Vào chrome://extensions kiểm tra "UP Media Cookie Exporter" đã được cài chưa. Nếu chưa: vào Cài đặt bật lại xuất cookie → ĐÓNG HẲN toàn bộ Chrome (cả khay đồng hồ) rồi mở lại.' };
  if (!cookies.length) return { success: false, error: 'Không tìm thấy cookie Facebook trong profile này.' };
  return { success: true, cookies };
});

// Bật/tắt khởi động cùng Windows
ipcMain.handle('get-auto-launch', async () => {
  try { return app.getLoginItemSettings().openAtLogin; }
  catch { return false; }
});
ipcMain.handle('set-auto-launch', async (_, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Bật/tắt tự chạy dưới quyền Administrator (mặc định BẬT)
ipcMain.handle('get-auto-elevate', async () => {
  const settings = configStore.getConfig().settings || {};
  return settings.autoElevate !== false;
});
ipcMain.handle('set-auto-elevate', async (_, enabled) => {
  const success = configStore.saveSettings({ autoElevate: !!enabled });
  return { success };
});

ipcMain.handle('get-profile-history', async (_, profilePath) => {
  if (lockedBlock(dirOfPath(profilePath))) return [];
  return history.getProfileHistory(profilePath, 25);
});

ipcMain.handle('get-google-accounts', async (_, profilePath) => {
  if (lockedBlock(dirOfPath(profilePath))) return [];
  return accounts.getGoogleAccounts(profilePath);
});

ipcMain.handle('get-social-status', async (_, profilePath, sites) => {
  if (lockedBlock(dirOfPath(profilePath))) return {};
  return social.getSocialStatus(profilePath, sites);
});

ipcMain.handle('get-social-sites', async () => {
  return configStore.getSocialSites() || social.DEFAULT_SOCIAL_SITES;
});

ipcMain.handle('get-cookies-for-domain', async (_, profilePath, domain) => {
  if (lockedBlock(dirOfPath(profilePath))) return [];
  return social.getCookiesForDomain(profilePath, domain);
});

ipcMain.handle('save-social-sites', async (_, sites) => {
  configStore.saveSocialSites(sites);
  return true;
});

ipcMain.handle('rename-group-in-profiles', async (_, oldName, newName, code) => {
  if (lockSvc) {
    const r = lockSvc.renameGroup(code, oldName, newName);   // nhóm khóa cần mã nhóm / mã CEO
    if (!r.success) return r;
  }
  return configStore.renameGroupInProfiles(oldName, newName);
});

ipcMain.handle('debug-social-status', async (_, profilePath, sites) => {
  if (lockedBlock(dirOfPath(profilePath))) return { error: 'Chrome đang khóa' };
  return social.debugSocialStatus(profilePath, sites);
});

// Kill all Chrome, open a specific profile fresh with debug port, wait for port to open.
// Used by the "Mở Chrome Debug" button in social diagnostic panel.
ipcMain.handle('kill-and-open-debug', async (_, profileDirectory) => {
  { const blocked = lockedBlock(profileDirectory); if (blocked) return blocked; }
  const { isPortOpen } = require('./src/chromeCdp');
  const config = configStore.getConfig();
  const userDataPath = config.settings?.chromeUserDataPath || null;

  // Kill Chrome and verify all processes are dead (up to 5s)
  await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const alive = await new Promise(resolve => {
      exec('wmic process where "name=\'chrome.exe\'" get ProcessId /format:list', (err, stdout) => {
        resolve(!err && stdout && stdout.includes('ProcessId=') && /ProcessId=\d+/.test(stdout));
      });
    });
    if (!alive) break;
    if (i === 9) {
      // Force kill again if still running after 5s
      await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Open profile with debug port
  try {
    shortcuts.openProfile(profileDirectory, userDataPath);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Poll for port 9223 to open (up to 20s — Chrome can be slow to start)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(9223)) return { success: true, port: 9223 };
  }
  return { success: false, error: 'CDP port 9223 không mở sau 20 giây. Chrome 130+ consumer build có thể đã tắt remote debugging. Thử đọc cookie khi Chrome đóng.' };
});

// Kill Chrome (all processes), read social status from unlocked file, reopen Chrome.
// Chrome releases the file lock immediately when the process exits.
ipcMain.handle('social-status-kill-reopen', async (_, profileDirectory, profilePath, sites) => {
  if (blockedAny(profileDirectory, profilePath)) return {};
  const config = configStore.getConfig();
  const userDataPath = config.settings?.chromeUserDataPath || null;

  // Kill all Chrome processes
  await new Promise(resolve => { exec('taskkill /F /IM chrome.exe /T', () => resolve()); });

  // Wait briefly — file lock releases as soon as chrome.exe exits
  await new Promise(r => setTimeout(r, 800));

  // Read cookies (Chrome is dead, no lock)
  const status = await social.getSocialStatus(profilePath, sites);

  // Reopen Chrome with the same profile
  try { shortcuts.openProfile(profileDirectory, userDataPath); } catch { /* ignore */ }

  return status;
});

// ── IPC khóa Chrome (v1.11) ──────────────────────────────
ipcMain.handle('lock-status', async () => lockSvc.status());
ipcMain.handle('lock-setup', async (_, ceo) => lockSvc.setup(ceo));
ipcMain.handle('lock-change-ceo', async (_, oldCode, newCode) => lockSvc.changeCeo(oldCode, newCode));
ipcMain.handle('lock-events', async (_, ceo) => lockSvc.events(ceo));
ipcMain.handle('lock-recover', async (_, code) => lockSvc.recover(code));
ipcMain.handle('lock-reset', async (_, newCeo) => lockSvc.reset(newCeo));
ipcMain.handle('lock-chrome', async (_, ceo, dir, pin) => lockSvc.lockChrome(ceo, dir, pin));
ipcMain.handle('lock-group', async (_, ceo, group, pin) => lockSvc.lockGroup(ceo, group, pin));
ipcMain.handle('lock-remove', async (_, ceo, target) => lockSvc.removeLock(ceo, target));
ipcMain.handle('lock-reset-pin', async (_, ceo, target, pin) => lockSvc.resetPin(ceo, target, pin));
ipcMain.handle('lock-add-member', async (_, code, group, dir) => lockSvc.addMember(code, group, dir));
ipcMain.handle('lock-remove-member', async (_, code, group, dir) => lockSvc.removeMember(code, group, dir));
ipcMain.handle('lock-unlock', async (_, dir, code) => lockSvc.unlock(dir, code));
ipcMain.handle('lock-unlock-many', async (_, dirs, code) => lockSvc.unlockMany(dirs, code));
ipcMain.handle('lock-relock', async (_, dir) => lockSvc.relock(dir));
ipcMain.handle('warning-set', async (_, target, code, opts) => lockSvc.setWarning(target, code, opts));
ipcMain.handle('warnings-for', async (_, dirs) => lockSvc.warningsFor(dirs));

ipcMain.handle('get-social-status-batch', async (_, profilePaths, sites) => {
  const results = {};
  for (const { dir, profilePath } of profilePaths) {
    if (blockedAny(dir, profilePath)) continue;   // Chrome đang khóa: không đọc trạng thái đăng nhập
    results[dir] = await social.getSocialStatus(profilePath, sites);
  }
  return results;
});
