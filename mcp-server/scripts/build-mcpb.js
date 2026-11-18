// Đóng gói file cài .mcpb cho Claude Desktop: npm run pack
// Kết quả: dist/Chrome-Manager-UP-Media-MCP-<version>.mcpb (thư mục dist/ không đưa lên Git)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const manifest = require('../manifest.json');
if (manifest.version !== version) {
  console.error(`Lệch version: package.json ${version} ≠ manifest.json ${manifest.version}`);
  process.exit(1);
}
const out = path.join(root, 'dist', `Chrome-Manager-UP-Media-MCP-${version}.mcpb`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const run = cmd => execSync(cmd, { cwd: root, stdio: 'inherit' });
run('node scripts/sync-shared.js');
run('npm test');
run('npm ci --omit=dev');
run('npx --yes @anthropic-ai/mcpb@2.1.2 validate manifest.json');
run(`npx --yes @anthropic-ai/mcpb@2.1.2 pack . "${out}"`);
run('npm install --no-audit --no-fund');   // trả lại đủ thư viện cho bước kiểm tra
run(`node scripts/smoke-bundle.js "${out}"`);
console.log('Xong:', out);
