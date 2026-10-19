const fs = require('fs');
const path = require('path');
const os = require('os');

function getPossibleUserDataPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const home = os.homedir();
  const drives = ['C', 'D', 'E', 'F'];

  const paths = [
    path.join(localAppData, 'Google', 'Chrome', 'User Data'),
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  ];

  for (const drive of drives) {
    paths.push(`${drive}:\\No Delete\\Google\\Chrome\\User Data`);
    paths.push(`${drive}:\\Google\\Chrome\\User Data`);
    paths.push(`${drive}:\\Chrome\\User Data`);
    paths.push(`${drive}:\\Users\\${os.userInfo().username}\\AppData\\Local\\Google\\Chrome\\User Data`);
  }

  return paths;
}

function findUserDataPath(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  for (const p of getPossibleUserDataPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readPreferences(profilePath) {
  try {
    const prefsPath = path.join(profilePath, 'Preferences');
    if (!fs.existsSync(prefsPath)) return {};
    const raw = fs.readFileSync(prefsPath, 'utf8');
    const prefs = JSON.parse(raw);
    return {
      name: prefs?.profile?.name || null,
      avatarIndex: prefs?.profile?.avatar_index ?? null,
      gaiaName: prefs?.profile?.gaia_name || null,
      email: prefs?.profile?.user_name || null
    };
  } catch {
    return {};
  }
}

// Đọc danh sách profile mà CHÍNH CHROME tự khai trong Local State (profile.info_cache).
// Đây là "nguồn chân lý" về số profile Chrome đang có trên máy (giống menu đổi profile của Chrome).
// Trả về object { "Default": { name }, "Profile 1": { name }, ... }
function readInfoCache(userDataPath) {
  try {
    const lsPath = path.join(userDataPath, 'Local State');
    if (!fs.existsSync(lsPath)) return {};
    const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
    return (ls && ls.profile && ls.profile.info_cache) || {};
  } catch {
    return {};
  }
}

// Danh sách profile theo Local State (để UI so sánh/hiển thị)
function getInfoCacheProfiles(userDataPath) {
  const ic = readInfoCache(userDataPath);
  return Object.keys(ic).map(dir => ({
    profileDirectory: dir,
    name: (ic[dir] && ic[dir].name) || dir,
  }));
}

// Tìm ảnh avatar thực của profile (Google Profile Picture)
function findProfileAvatar(profilePath) {
  const candidates = [
    path.join(profilePath, 'Google Profile Picture.png'),
    path.join(profilePath, 'Google Profile.png'),
    path.join(profilePath, 'Avatar.png')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getNextProfileDirectory(userDataPath) {
  const entries = fs.readdirSync(userDataPath);
  let max = 0;
  for (const e of entries) {
    const m = e.match(/^Profile (\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `Profile ${max + 1}`;
}

function scanProfiles(customUserDataPath) {
  const userDataPath = findUserDataPath(customUserDataPath);
  if (!userDataPath) throw new Error('NOT_FOUND_USER_DATA');

  const infoCache = readInfoCache(userDataPath);
  const entries = fs.readdirSync(userDataPath);
  const profiles = [];
  const foundDirs = new Set();

  for (const entry of entries) {
    const isDefault = entry === 'Default';
    const isProfile = /^Profile \d+$/.test(entry);
    if (!isDefault && !isProfile) continue;

    const profilePath = path.join(userDataPath, entry);
    try {
      if (!fs.statSync(profilePath).isDirectory()) continue;
    } catch { continue; }

    // LƯU Ý: bản cũ bỏ qua profile không có file "Preferences" → gây "quét thiếu"
    // (profile mới tạo/đồng bộ dở chưa có Preferences). Nay vẫn nhận, lấy tên từ
    // Local State (info_cache) nếu không đọc được Preferences.
    const prefs = readPreferences(profilePath);
    const avatarPath = findProfileAvatar(profilePath);
    const icName = infoCache[entry] && infoCache[entry].name;

    foundDirs.add(entry);
    profiles.push({
      profileDirectory: entry,
      profilePath,
      chromeProfileName: prefs.name || icName || entry,
      gaiaName: prefs.gaiaName || null,
      email: prefs.email || null,
      avatarIndex: prefs.avatarIndex,
      avatarPath: avatarPath || null,
      shortcutName: '',
      group: 'Khác',
      hasShortcut: false
    });
  }

  profiles.sort((a, b) => {
    if (a.profileDirectory === 'Default') return -1;
    if (b.profileDirectory === 'Default') return 1;
    const numA = parseInt(a.profileDirectory.replace('Profile ', '')) || 0;
    const numB = parseInt(b.profileDirectory.replace('Profile ', '')) || 0;
    return numA - numB;
  });

  // So sánh với danh sách Chrome tự khai (info_cache) → tìm profile bị thiếu khi quét
  const machineProfiles = getInfoCacheProfiles(userDataPath);
  const missing = computeMissingProfiles(machineProfiles, foundDirs, userDataPath);

  return {
    profiles,
    userDataPath,
    machineCount: machineProfiles.length,
    machineProfiles,
    missing,
  };
}

// Xóa các "profile ma" khỏi Local State của Chrome (các entry Chrome còn nhớ nhưng thư mục đã mất).
// LƯU Ý: chỉ nên gọi khi Chrome ĐÃ ĐÓNG, nếu không Chrome có thể ghi đè lại Local State khi thoát.
function removeProfilesFromLocalState(userDataPath, dirs) {
  try {
    const lsPath = path.join(userDataPath, 'Local State');
    if (!fs.existsSync(lsPath)) return { ok: false, removed: 0 };
    const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
    if (!ls.profile || !ls.profile.info_cache) return { ok: false, removed: 0 };
    const targets = new Set(dirs || []);
    let removed = 0;
    for (const d of targets) {
      if (ls.profile.info_cache[d] !== undefined) { delete ls.profile.info_cache[d]; removed++; }
    }
    // Dọn thêm ở các danh sách phụ nếu có
    if (Array.isArray(ls.profile.profiles_order))
      ls.profile.profiles_order = ls.profile.profiles_order.filter(d => !targets.has(d));
    if (Array.isArray(ls.profile.last_active_profiles))
      ls.profile.last_active_profiles = ls.profile.last_active_profiles.filter(d => !targets.has(d));
    if (removed > 0) fs.writeFileSync(lsPath, JSON.stringify(ls), 'utf8');
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, removed: 0, error: e.message };
  }
}

// Hàm logic thuần (có test): từ danh sách Chrome tự khai + tập dir đã quét → profile bị thiếu + lý do.
// existsFn cho phép test không phụ thuộc ổ đĩa thật.
function computeMissingProfiles(machineProfiles, foundDirs, userDataPath, existsFn) {
  const found = foundDirs instanceof Set ? foundDirs : new Set(foundDirs || []);
  const exists = existsFn || (dir => {
    try { return fs.existsSync(path.join(userDataPath, dir)); } catch { return false; }
  });
  return (machineProfiles || [])
    .filter(m => !found.has(m.profileDirectory))
    .map(m => {
      const standard = m.profileDirectory === 'Default' || /^Profile \d+$/.test(m.profileDirectory);
      let reason;
      if (!exists(m.profileDirectory)) reason = 'Thư mục không còn trên máy (Chrome vẫn nhớ trong Local State)';
      else if (!standard) reason = 'Tên thư mục không theo chuẩn Default / Profile N';
      else reason = 'Thư mục có nhưng chưa đọc được dữ liệu';
      return { profileDirectory: m.profileDirectory, name: m.name, reason };
    });
}

module.exports = {
  scanProfiles,
  findUserDataPath,
  getPossibleUserDataPaths,
  getNextProfileDirectory,
  getInfoCacheProfiles,
  computeMissingProfiles,
  removeProfilesFromLocalState,
};
