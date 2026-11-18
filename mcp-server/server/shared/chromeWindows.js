// Nhận diện Chrome đang mở THEO TỪNG PROFILE + đưa đúng cửa sổ của profile lên trước (v1.10.6).
//
// Bối cảnh (chẩn đoán trên máy thật 18/11/2026, _chan-doan/): Chrome gom MỌI profile vào MỘT tiến trình
// trình duyệt; dòng lệnh của tiến trình đó chỉ còn --profile-directory của profile mở ĐẦU TIÊN → cách cũ
// (đọc dòng lệnh qua PowerShell CIM) chỉ thấy 1 Chrome, và cửa sổ chính của tiến trình là cửa sổ bất kỳ.
// Cách mới, đã đối chiếu khớp 3/3 Chrome đang mở trên máy Sếp:
//  1) ĐANG MỞ = Chrome đang khóa file dữ liệu của profile (Network/Cookies, Local Storage/leveldb/LOCK).
//     Node thuần, ~1ms/profile, không gọi PowerShell → dùng cho vòng làm mới 4 giây của app.
//  2) CỬA SỔ  = mỗi cửa sổ Chrome mang thuộc tính Windows (shell property store):
//     - RelaunchCommand: "...chrome.exe" --profile-directory="Profile 33"   (cửa sổ trình duyệt)
//     - AppUserModelID : "Chrome.UserData.Profile33" · Default = "Chrome" · app PWA = "Chrome._crx_<id>[.UserData.ProfileN]"
// File này được CHÉP sang mcp-server/server/shared/ (npm run sync) — sửa ở đây rồi chạy sync.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── 1) Đang mở: dò khóa file ─────────────────────────────
const LOCK_PROBE_FILES = [['Network', 'Cookies'], ['Cookies'], ['Local Storage', 'leveldb', 'LOCK']];

// true = Chrome đang khóa · false = không khóa · null = không có file (không kết luận)
function isFileLocked(file, fsi = fs) {
  let st;
  try { st = fsi.statSync(file); } catch { return null; }
  let fd;
  try { fd = fsi.openSync(file, 'r'); } catch { return true; }          // Chrome mở độc quyền → không mở được
  try {
    const n = fsi.readSync(fd, Buffer.alloc(16), 0, 16, 0);
    return st.size > 0 && n === 0;                                       // khóa vùng byte: mở được nhưng đọc ra 0
  } catch { return true; }                                               // khóa vùng byte: đọc báo lỗi
  finally { try { fsi.closeSync(fd); } catch { /* ignore */ } }
}

function isProfileLoaded(profilePath, fsi = fs) {
  return LOCK_PROBE_FILES.some(parts => isFileLocked(path.join(profilePath, ...parts), fsi) === true);
}

// Tập profile-directory (chữ thường) đang được Chrome mở
function getLoadedProfileDirs(userDataPath, fsi = fs) {
  const set = new Set();
  if (!userDataPath) return set;
  let entries = [];
  try { entries = fsi.readdirSync(userDataPath); } catch { return set; }
  for (const e of entries) {
    if (e !== 'Default' && !/^Profile \d+$/.test(e)) continue;
    if (isProfileLoaded(path.join(userDataPath, e), fsi)) set.add(e.toLowerCase());
  }
  return set;
}

// ── 2) Cửa sổ của profile ────────────────────────────────
// Mẫu dùng CHUNG cho JS (test) và PowerShell (chạy thật) — sửa ở đây là đổi cả hai.
const RELAUNCH_DIR_RE = '--profile-directory=(?:"([^"]+)"|(\\S+))';
const AUMID_PROFILE_RE = '\\.Profile(\\d+)$';

// Thư mục profile của 1 cửa sổ Chrome từ thuộc tính Windows (null = không xác định)
function windowProfileDir(aumid, relaunch) {
  const r = new RegExp(RELAUNCH_DIR_RE, 'i').exec(relaunch || '');
  if (r) return r[1] || r[2];
  const a = new RegExp(AUMID_PROFILE_RE, 'i').exec(aumid || '');
  if (a) return 'Profile ' + a[1];
  if (/^Chrome/i.test(aumid || '') && !/\.UserData\./i.test(aumid || '')) return 'Default';
  return null;
}

// Liệt kê cửa sổ hiện của chrome.exe: "hwnd<TAB>AppUserModelID<TAB>RelaunchCommand"
const WIN_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class UPMWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public long pad; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] public static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT v);
  public static string GetProp(IntPtr h, uint id) {
    try {
      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
      IPropertyStore ps;
      if (SHGetPropertyStoreForWindow(h, ref iid, out ps) != 0 || ps == null) return "";
      PROPERTYKEY k = new PROPERTYKEY(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = id;
      PROPVARIANT v; string r = "";
      if (ps.GetValue(ref k, out v) == 0) { if (v.vt == 31 && v.p != IntPtr.Zero) r = Marshal.PtrToStringUni(v.p); PropVariantClear(ref v); }
      Marshal.ReleaseComObject(ps);
      return r ?? "";
    } catch { return ""; }
  }
  public static List<string> List() {
    List<string> res = new List<string>();
    Dictionary<uint, bool> chrome = new Dictionary<uint, bool>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
      if (GetWindowTextLength(h) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool c;
      if (!chrome.TryGetValue(pid, out c)) {
        try { c = Process.GetProcessById((int)pid).ProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase); } catch { c = false; }
        chrome[pid] = c;
      }
      if (!c) return true;
      res.Add(h.ToInt64() + "\t" + GetProp(h, 5) + "\t" + GetProp(h, 2));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
`;

// Script PowerShell: tìm cửa sổ của profile → khôi phục nếu đang thu nhỏ (cửa sổ phóng to giữ nguyên) → đưa lên trước.
// Ưu tiên cửa sổ trình duyệt (có RelaunchCommand) hơn cửa sổ app PWA. In ra OK / NONE / BLOCKED.
function buildFocusScript(dir) {
  const target = String(dir).replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    WIN_CS.trim(),
    "'@",
    `$target='${target}'`,
    `$relRe='${RELAUNCH_DIR_RE}'`,
    `$aumRe='${AUMID_PROFILE_RE}'`,
    '$best=$null',
    'foreach($w in [UPMWin]::List()){',
    ' $f=$w -split "`t"',
    ' $d=$null',
    ' if($f[2] -match $relRe){ $d=$Matches[1]; if(-not $d){ $d=$Matches[2] } }',
    ' elseif($f[1] -match $aumRe){ $d="Profile "+$Matches[1] }',
    " elseif(($f[1] -like 'Chrome*') -and ($f[1] -notmatch '\\.UserData\\.')){ $d='Default' }",
    ' if($d -and ($d -eq $target)){ if(-not $best -or ($f[2] -and -not $best[2])){ $best=$f } }',
    '}',
    "if(-not $best){ Write-Output 'NONE'; exit }",
    '$h=[IntPtr][long]$best[0]',
    'if([UPMWin]::IsIconic($h)){ [UPMWin]::ShowWindowAsync($h,9) | Out-Null }',
    '$ok=[UPMWin]::SetForegroundWindow($h)',
    // Windows chặn chương trình nền giành focus → mẹo nhấn-nhả phím Alt rồi thử lại
    'if(-not $ok){ [UPMWin]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [UPMWin]::keybd_event(0x12,0,2,[UIntPtr]::Zero); $ok=[UPMWin]::SetForegroundWindow($h) }',
    "if($ok){ Write-Output 'OK' } else { Write-Output 'BLOCKED' }",
  ].join('\n');
}

// -EncodedCommand (UTF-16LE base64): tránh mọi lỗi dấu ngoặc kép khi truyền script qua dòng lệnh
function encodePowerShell(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

// → { success } | { success:false, notFound:true } (không có cửa sổ nào của profile) | { success:false, blocked:true }
function focusProfileWindow(dir) {
  if (process.platform !== 'win32') return Promise.resolve({ success: false, notFound: true });
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(buildFocusScript(dir))],
      { windowsHide: true, timeout: 12000 },
      (err, stdout) => {
        const out = String(stdout || '');
        if (/\bOK\b/.test(out)) resolve({ success: true });
        else if (/\bNONE\b/.test(out)) resolve({ success: false, notFound: true });
        else resolve({ success: false, blocked: /\bBLOCKED\b/.test(out), error: err ? err.message : undefined });
      });
  });
}

module.exports = {
  isFileLocked, isProfileLoaded, getLoadedProfileDirs,
  RELAUNCH_DIR_RE, AUMID_PROFILE_RE, windowProfileDir,
  buildFocusScript, encodePowerShell, focusProfileWindow,
};
