#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const codex = process.env.CODEX_MOBILE_CODEX_BIN
  ?? (fs.existsSync('/opt/codex-mobile/bin/codex')
    ? '/opt/codex-mobile/bin/codex'
    : '/home/ningmengchang/.local/bin/codex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-protocol-'));
const required = {
  'ClientRequest.ts': ['thread/start', 'thread/resume', 'thread/list', 'thread/read', 'thread/name/set', 'thread/delete', 'turn/start', 'turn/steer', 'turn/interrupt', 'model/list', 'collaborationMode/list', 'account/read'],
  'ServerRequest.ts': ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'],
  'ServerNotification.ts': ['turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta', 'turn/diff/updated'],
};

try {
  const result = spawnSync(codex, ['app-server', 'generate-ts', '--experimental', '--out', directory], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/root', CODEX_HOME: process.env.CODEX_HOME ?? '/root/.codex' },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || '无法生成协议类型');
  const missing = [];
  for (const [filename, methods] of Object.entries(required)) {
    const source = fs.readFileSync(path.join(directory, filename), 'utf8');
    for (const method of methods) if (!source.includes(`\"${method}\"`)) missing.push(method);
  }
  if (missing.length) throw new Error(`当前 Codex 缺少必要接口：${missing.join(', ')}`);
  process.stdout.write('Codex App Server 协议兼容：所有必要接口均存在。\n');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
