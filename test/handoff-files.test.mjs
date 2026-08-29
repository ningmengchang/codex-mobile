import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandoffFileStore } from '../server/handoff-files.mjs';

test('handoff files are private, stable per thread, and return only a short read instruction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-handoff-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { dataDir: directory, handoffMaxBytes: 5 * 1024 * 1024 };
  const store = createHandoffFileStore(config);

  const first = await store.write({
    content: '# 交接包\n\n第一版内容',
    sourceAgentId: 'gpt',
    threadId: 'thread/unsafe:id',
  });
  assert.equal(fs.readFileSync(first.filePath, 'utf8'), '# 交接包\n\n第一版内容');
  assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(first.filePath)).mode & 0o777, 0o700);
  assert.match(first.fileName, /^codex-handoff-gpt-[a-f0-9]{24}\.md$/);
  assert.match(first.instruction, new RegExp(first.filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(first.instruction, /第一版内容/);

  const second = await store.write({
    content: '# 交接包\n\n第二版内容',
    sourceAgentId: 'gpt',
    threadId: 'thread/unsafe:id',
  });
  assert.equal(second.filePath, first.filePath);
  assert.equal(fs.readFileSync(second.filePath, 'utf8'), '# 交接包\n\n第二版内容');
});

test('handoff file store rejects content above its configured ceiling', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-handoff-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createHandoffFileStore({ dataDir: directory, handoffMaxBytes: 16 });
  await assert.rejects(
    store.write({ content: '超'.repeat(6), sourceAgentId: 'gpt', threadId: 'thread-1' }),
    /超过 16 字节上限/,
  );
});
