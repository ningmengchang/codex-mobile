import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationArtifacts, isArtifactPathVisible } from '../server/conversation-artifacts.mjs';
import { isDocumentPath } from '../server/files.mjs';

function append(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

test('conversation artifacts stay scoped to each rollout even when threads share a directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-conversation-artifacts-'));
  const codexHome = path.join(directory, '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '16');
  const project = path.join(directory, 'project');
  const outsideProject = path.join(directory, 'other-project');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(project, '历史成果'), { recursive: true });
  fs.mkdirSync(path.join(project, '.cache'), { recursive: true });
  fs.mkdirSync(outsideProject);
  const alpha = path.join(project, 'docs', 'alpha.md');
  const beta = path.join(project, 'docs', 'beta.pptx');
  const outside = path.join(outsideProject, 'outside.md');
  const hidden = path.join(project, '.cache', 'cache.log');
  const notes = path.join(project, 'docs', 'notes.txt');
  const source = path.join(project, 'docs', 'generator.js');
  const historicalDoc = path.join(project, '历史成果', '历史方案.docx');
  const historicalCode = path.join(project, '历史成果', 'build.ts');
  fs.writeFileSync(alpha, '# Alpha');
  fs.writeFileSync(beta, 'ppt');
  fs.writeFileSync(outside, '# Outside');
  fs.writeFileSync(hidden, 'noise');
  fs.writeFileSync(notes, '历史说明');
  fs.writeFileSync(source, 'export default {}');
  fs.writeFileSync(historicalDoc, 'docx');
  fs.writeFileSync(historicalCode, 'export {}');
  const rolloutA = path.join(sessions, 'rollout-a.jsonl');
  const rolloutB = path.join(sessions, 'rollout-b.jsonl');
  fs.writeFileSync(rolloutA, '');
  fs.writeFileSync(rolloutB, '');
  append(rolloutA, {
    type: 'event_msg',
    payload: {
      type: 'agent_message', phase: 'final_answer',
      message: `已完成：[alpha.md](${alpha})；忽略 [outside](${outside}) 和 [cache](${hidden})`,
    },
  });
  append(rolloutA, {
    type: 'event_msg',
    payload: {
      type: 'agent_message', phase: 'commentary',
      message: `历史处理中生成了 [notes](${notes})、[source](${source})，最终目录：[历史成果](${path.join(project, '历史成果')})`,
    },
  });
  append(rolloutB, {
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: '最终文件：`docs/beta.pptx`' },
  });
  const config = {
    codexHome, allowedRoots: [directory], secret: 'secret', artifactTtlSeconds: 60,
  };
  const index = createConversationArtifacts(config);
  try {
    const a = await index.list({ id: 'thread-a', cwd: project, path: rolloutA });
    const b = await index.list({ id: 'thread-b', cwd: project, path: rolloutB });
    assert.deepEqual(new Set(a.map((item) => item.relativePath)), new Set([
      'docs/alpha.md', 'docs/notes.txt', '历史成果/历史方案.docx',
    ]));
    assert.equal(a.some((item) => item.relativePath.endsWith('.js') || item.relativePath.endsWith('.ts')), false);
    assert.deepEqual(b.map((item) => item.relativePath), ['docs/beta.pptx']);
    assert.equal(a[0].source, 'conversation');
    assert.equal(a[0].available, true);
    assert.equal(typeof a[0].token, 'string');

    const added = path.join(project, 'docs', 'later.pdf');
    fs.writeFileSync(added, '%PDF');
    append(rolloutA, {
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: `[later.pdf](${added})` }],
      },
    });
    const refreshed = await index.list({ id: 'thread-a', cwd: project, path: rolloutA });
    assert.deepEqual(new Set(refreshed.map((item) => item.relativePath)), new Set([
      'docs/alpha.md', 'docs/notes.txt', 'docs/later.pdf', '历史成果/历史方案.docx',
    ]));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact visibility filters hidden state and runtime database noise', () => {
  assert.equal(isArtifactPathVisible('docs/final-report.docx'), true);
  assert.equal(isArtifactPathVisible('.codex/state.sqlite-wal'), false);
  assert.equal(isArtifactPathVisible('logs/server.log'), false);
  assert.equal(isArtifactPathVisible('node_modules/pkg/index.js'), false);
});

test('document detection includes common office and text documents but excludes code and web files', () => {
  for (const file of ['需求.md', '方案.docx', '清单.xlsx', '汇报.pptx', '报告.pdf', '说明.txt', '数据.csv']) {
    assert.equal(isDocumentPath(file), true, file);
  }
  for (const file of ['app.js', 'server.mjs', 'index.html', 'style.css', 'data.json', 'preview.png', 'build.apk']) {
    assert.equal(isDocumentPath(file), false, file);
  }
});

test('historical document indexing opens immediately and reuses its persistent cache', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-conversation-cache-'));
  const codexHome = path.join(directory, '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '16');
  const project = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(dataDir);
  const document = path.join(project, '历史报告.pdf');
  const rollout = path.join(sessions, 'rollout-cache.jsonl');
  fs.writeFileSync(document, '%PDF');
  const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'x'.repeat(900) } })}\n`;
  fs.writeFileSync(rollout, filler.repeat(5_000));
  append(rollout, {
    type: 'event_msg',
    payload: { type: 'agent_message', phase: 'commentary', message: `历史文件：[报告](${document})` },
  });
  const config = {
    codexHome, dataDir, allowedRoots: [directory], secret: 'secret', artifactTtlSeconds: 60,
  };
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const index = createConversationArtifacts(config, { onReady: resolveReady });
  try {
    const started = Date.now();
    const first = index.snapshot({ id: 'thread-cache', cwd: project, path: rollout });
    assert.equal(first.pending, true);
    assert.deepEqual(first.items, []);
    assert.ok(Date.now() - started < 100, '首次打开不应等待整份历史记录扫描');
    await ready;
    const completed = index.snapshot({ id: 'thread-cache', cwd: project, path: rollout });
    assert.equal(completed.pending, false);
    assert.deepEqual(completed.items.map((item) => item.relativePath), ['历史报告.pdf']);

    const restored = createConversationArtifacts(config).snapshot({ id: 'thread-cache', cwd: project, path: rollout });
    assert.equal(restored.pending, false);
    assert.deepEqual(restored.items.map((item) => item.relativePath), ['历史报告.pdf']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
