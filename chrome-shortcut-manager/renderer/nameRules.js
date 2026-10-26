// ── Quy tắc "Chưa đặt tên" ─────────────────────────────────
// Dùng chung cho renderer (bộ lọc sidebar, thống kê header, chấm vàng ở dạng hàng)
// và cho unit test (test/unit.test.js). Hàm thuần, không phụ thuộc Electron/DOM.
//
// Bối cảnh: khi profile chưa có tên trong app, main.js tự điền tên Chrome đang lưu
// (chromeProfileName) vào ô "Tên shortcut". Bản cũ coi "tên shortcut = tên Chrome"
// là chưa đặt → profile mà tên Chrome đã là tên thật (vd "Đinh Thị Thanh") bị xếp
// nhầm vào "Chưa đặt tên" dù đã có tên. Nay chỉ coi là chưa đặt khi tên thật sự
// vô nghĩa: trống / trùng tên thư mục / tên mặc định Chrome tự sinh.
(function (root) {
  // Tên mặc định Chrome tự sinh (EN + VI): "Person 1", "Người dùng 2", "Profile 14", "Your Chrome"…
  const DEFAULT_NAME_PATTERNS = [
    /^(person|user|profile|người|người dùng|hồ sơ)( \d+)?$/,
    /^(your chrome|chrome của bạn|default)$/,
  ];

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  function looksLikeDefaultName(name) {
    const n = norm(name).toLowerCase();
    return !n || DEFAULT_NAME_PATTERNS.some(re => re.test(n));
  }

  // p: { shortcutName, profileDirectory, chromeProfileName, chromeUsingDefaultName, chromeGaiaNames }
  function isUnnamedProfile(p) {
    if (!p) return true;
    const name = norm(p.shortcutName);
    if (!name) return true;                                // ô tên trống
    if (name === norm(p.profileDirectory)) return true;    // vẫn là "Profile 14" / "Default"
    if (looksLikeDefaultName(name)) return true;           // "Person 1", "Người dùng 2", "Your Chrome"…
    if (name !== norm(p.chromeProfileName)) return false;  // tên riêng, khác tên Chrome → đã đặt
    // Tên shortcut trùng tên Chrome đang lưu. Chỉ coi là "chưa đặt" khi chính Chrome
    // đánh dấu đây là tên mặc định nó tự sinh (Local State: is_using_default_name)
    // VÀ tên đó không phải tên tài khoản Google của profile.
    if (p.chromeUsingDefaultName !== true) return false;
    const gaia = (p.chromeGaiaNames || []).map(norm);
    return !gaia.includes(name);
  }

  const api = { isUnnamedProfile, looksLikeDefaultName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : this);
