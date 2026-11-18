// Kiểm tra file .mcpb sau khi đóng gói: giải nén ra thư mục tạm, khởi động server TỪ GÓI
// (không dùng node_modules của dự án) và gọi thử lệnh ở chế độ chạy khô.
// Dùng: node scripts/smoke-bundle.js <file.mcpb>
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { makeFixture } = require('../test/fixture');

(async () => {
  const file = path.resolve(process.argv[2]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-mcpb-'));
  const fx = makeFixture();
  try {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--yes', '@anthropic-ai/mcpb@2.1.2', 'unpack', file, dir], { stdio: 'ignore', shell: process.platform === 'win32' });
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(dir, 'server', 'index.js')], cwd: dir,
      env: { ...getDefaultEnvironment(), ...fx.env, UPM_MCP_DRY_RUN: '1', NODE_PATH: '' }, stderr: 'inherit',
    }));
    const names = (await client.listTools()).tools.map(t => t.name).sort().join(',');
    if (names !== 'mo_chrome,mo_link,mo_nhom,tim_chrome') throw new Error('Thiếu lệnh: ' + names);
    const r = await client.callTool({ name: 'mo_chrome', arguments: { ten: 'dinh thi thanh' } });
    if (!/--profile-directory=Profile 14/.test(r.content[0].text)) throw new Error('Lệnh mo_chrome sai: ' + r.content[0].text);
    await client.close();
    console.log('Gói .mcpb chạy tốt khi tách riêng:', names);
  } finally {
    fx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error('GÓI .mcpb LỖI:', e.message); process.exit(1); });
