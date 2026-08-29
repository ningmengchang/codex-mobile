import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoffPackage, readGitSnapshot, redactHandoffSecrets } from '../server/handoff-package.mjs';

function turn(id, user, agent, plan = '') {
  return {
    id,
    status: 'completed',
    items: [
      ...(user ? [{ id: `${id}-u`, type: 'userMessage', content: [{ type: 'text', text: user }] }] : []),
      ...(agent ? [{ id: `${id}-a`, type: 'agentMessage', text: agent }] : []),
      ...(plan ? [{ id: `${id}-p`, type: 'plan', text: plan }] : []),
    ],
  };
}

test('handoff package contains only portable visible context and redacts credentials', () => {
  const payload = buildHandoffPackage({
    thread: { id: 'thread-1', name: '原生 GPT 会话', cwd: '/workspace/demo', status: 'idle' },
    sourceAgent: 'GPT',
    sourceAgentId: 'gpt',
    generatedAt: new Date('2026-08-29T08:00:00+08:00'),
    turns: [
      turn('turn-1', '完成 PRD；API_KEY=super-secret-value', '已经完成初稿。'),
      turn('turn-2', '继续完善', '文档已更新，Bearer abcdefghijklmnop', '1. 核对文档\n2. 完成验收'),
    ],
    artifacts: [{ relativePath: 'docs/最终 PRD.md', modifiedAt: '2026-08-29T07:00:00+08:00' }],
    gitSnapshot: { available: true, branch: 'master', head: 'abc123', subject: 'feat: PRD', status: ' M docs/最终 PRD.md' },
  });

  assert.equal(payload.format, 'codex-mobile-handoff/v1');
  assert.equal(payload.sourceAgent, 'gpt');
  assert.equal(payload.sourceAgentLabel, 'GPT');
  assert.match(payload.content, /不包含模型隐藏推理/);
  assert.match(payload.content, /完成 PRD/);
  assert.match(payload.content, /核对文档/);
  assert.match(payload.content, /docs\/最终 PRD\.md/);
  assert.match(payload.content, /分支：master/);
  assert.match(payload.content, /\[已隐藏凭据\]/);
  assert.doesNotMatch(payload.content, /super-secret-value|abcdefghijklmnop/);
  assert.equal(payload.bytes, Buffer.byteLength(payload.content, 'utf8'));
});

test('handoff package stays bounded and preserves latest visible turns', () => {
  const turns = Array.from({ length: 40 }, (_, index) => turn(
    `turn-${index + 1}`,
    `问题-${index + 1}-${'甲'.repeat(500)}`,
    `回答-${index + 1}-${'乙'.repeat(500)}`,
  ));
  const payload = buildHandoffPackage({
    thread: { id: 'large-thread', name: '大会话', cwd: '/workspace/demo' },
    sourceAgent: 'DeepSeek', sourceAgentId: 'deepseek', turns,
    recentTurnLimit: 4, maxBytes: 16 * 1024,
    artifacts: Array.from({ length: 60 }, (_, index) => ({ relativePath: `docs/${index}-${'长'.repeat(80)}.md` })),
    gitSnapshot: { available: false },
  });

  assert(payload.bytes <= 16 * 1024, `交接包超出限制：${payload.bytes}`);
  assert.equal(payload.truncated, true);
  assert.match(payload.content, /较早的 \d+ 个回合未包含/);
  assert.match(payload.content, /问题-40/);
  assert.match(payload.content, /给接力 Agent 的要求/);
});

test('file handoff packages can grow beyond the legacy 64 KB ceiling up to 5 MB', () => {
  const turns = Array.from({ length: 80 }, (_, index) => turn(
    `large-turn-${index + 1}`,
    `大交接问题-${index + 1}-${'甲'.repeat(4000)}`,
    `大交接回答-${index + 1}-${'乙'.repeat(4000)}`,
  ));
  const payload = buildHandoffPackage({
    thread: { id: 'five-megabyte-thread', name: '大交接会话', cwd: '/workspace/demo' },
    sourceAgent: 'GPT', sourceAgentId: 'gpt', turns,
    recentTurnLimit: 500, maxBytes: 5 * 1024 * 1024,
    artifacts: [], gitSnapshot: { available: false },
  });

  assert(payload.bytes > 64 * 1024, `交接包仍受旧上限限制：${payload.bytes}`);
  assert(payload.bytes <= 5 * 1024 * 1024, `交接包超出 5 MB：${payload.bytes}`);
  assert.equal(payload.maxBytes, 5 * 1024 * 1024);
  assert.equal(payload.turnCount, 80);
  assert.equal(payload.truncated, false);
  assert.match(payload.content, /大交接问题-1/);
  assert.match(payload.content, /大交接回答-80/);
});

test('handoff redaction covers pairing codes and common tokens', () => {
  const redacted = redactHandoffSecrets('配对码 12345678\npassword: hunter2\nsk-abcdefghijklmnopqrstuvwxyz');
  assert.doesNotMatch(redacted, /12345678|hunter2|sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /\[已隐藏\]/);
  assert.match(redacted, /\[已隐藏凭据\]|\[已隐藏 API Key\]/);
});

test('git snapshot uses execFile arguments without a shell', async () => {
  const calls = [];
  const snapshot = await readGitSnapshot('/workspace/demo', {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      const command = args.slice(2).join(' ');
      if (command === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n' };
      if (command === 'branch --show-current') return { stdout: 'feature/handoff\n' };
      if (command === 'rev-parse --short=12 HEAD') return { stdout: '0123456789ab\n' };
      if (command === 'log -1 --format=%s') return { stdout: 'feat: handoff\n' };
      if (command === 'status --short --branch --untracked-files=normal') return { stdout: '## feature/handoff\n' };
      throw new Error(`unexpected ${command}`);
    },
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.branch, 'feature/handoff');
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.file, 'git');
    assert.deepEqual(call.args.slice(0, 2), ['-C', '/workspace/demo']);
    assert.equal(call.options.shell, undefined);
  }
});
