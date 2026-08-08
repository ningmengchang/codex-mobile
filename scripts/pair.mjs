#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPairingCode } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

if (process.getuid?.() !== 0) {
  process.stderr.write('配对命令必须以 root 运行，因为服务复用 /root/.codex。\n');
  process.exit(1);
}

const config = loadConfig();
const pairing = createPairingCode(config);
const pairingPath = path.join(config.dataDir, 'pairing.json');
try {
  const uid = Number.parseInt(execFileSync('id', ['-u', config.targetUser], { encoding: 'utf8' }).trim(), 10);
  const gid = Number.parseInt(execFileSync('id', ['-g', config.targetGroup], { encoding: 'utf8' }).trim(), 10);
  fs.chownSync(pairingPath, uid, gid);
} catch (error) {
  process.stderr.write(`警告：无法设置配对文件属主：${error.message}\n`);
}
process.stdout.write('\nCodex Mobile 配对码\n\n');
process.stdout.write(`  ${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}\n\n`);
process.stdout.write('10 分钟内有效，仅能使用一次。\n');
process.stdout.write(`过期时间：${new Date(pairing.expiresAt).toLocaleString('zh-CN')}\n\n`);
