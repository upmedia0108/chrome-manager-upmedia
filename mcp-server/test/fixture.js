// Dựng một "máy giả": Chrome User Data + config.json của Chrome Manager, để test không cần Windows.
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-mcp-'));
  const ud = path.join(root, 'User Data');
  fs.mkdirSync(ud);
  const infoCache = {};
  const cfgProfiles = {};
  function addProfile(dir, chromeName, saved, extra = {}) {
    fs.mkdirSync(path.join(ud, dir));
    const prefs = { profile: { name: chromeName, using_default_name: /^Person \d+$/.test(chromeName) } };
    if (extra.email) prefs.account_info = [{ email: extra.email, full_name: chromeName }];
    fs.writeFileSync(path.join(ud, dir, 'Preferences'), JSON.stringify(prefs), 'utf8');
    infoCache[dir] = { name: chromeName, is_using_default_name: prefs.profile.using_default_name };
    if (saved) cfgProfiles[dir] = saved;
  }
  addProfile('Default', 'Sếp', { shortcutName: 'Tuyển UP', groups: ['Nhân sự UP'], subGroups: { 'Nhân sự UP': ['HCTH'] } });
  addProfile('Profile 14', 'Đinh Thị Thanh', { shortcutName: 'Đinh Thị Thanh', groups: ['Nhân sự UP'], subGroups: { 'Nhân sự UP': ['VHDA'] }, notes: 'Ads Queen Spa', pinned: true }, { email: 'thanh.dt@gmail.com' });
  for (let i = 2; i <= 10; i++) {
    addProfile(`Profile ${i}`, `Person ${i}`, { shortcutName: `Seeding FB ${String(i - 1).padStart(2, '0')}`, groups: ['Social'], subGroups: { Social: 'FB' } });
  }
  addProfile('Profile 11', 'Thanh Hà', null);
  addProfile('Profile 12', 'Person 12', { shortcutName: 'Thanh Hà KH', groups: ['Khách hàng'] });
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }), 'utf8');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    settings: { chromeUserDataPath: ud },
    groups: ['Social', 'Digital', 'Nhân sự UP', 'Khách hàng'],
    groupSubs: { Social: ['FB', 'Tiktok'], 'Nhân sự UP': ['HCTH', 'VHDA'] },
    profiles: cfgProfiles,
  }), 'utf8');
  return {
    root, userData: ud, configPath,
    env: { UPM_CONFIG_PATH: configPath, UPM_CHROME_USER_DATA: ud },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
module.exports = { makeFixture };
