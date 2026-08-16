import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadActivityStore, requestThreadId } from '../server/thread-activity.mjs';

test('thread activity tracks independent running, attention and completion states', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-activity-'));
  const changes = [];
  const store = new ThreadActivityStore({ dataDir: directory, onChange: (value) => changes.push(value) });

  store.start('thread-a', 'turn-a', 'plan', 100);
  store.start('thread-b', 'turn-b', 'default', 110);
  assert.equal(store.get('thread-a').status, 'planning');
  assert.equal(store.get('thread-b').status, 'running');

  const request = { id: 'request-a', params: { threadId: 'thread-a' } };
  assert.equal(requestThreadId(request), 'thread-a');
  store.waitForInput(request);
  assert.equal(store.get('thread-a').status, 'waiting');
  assert.equal(store.get('thread-a').attentionCount, 1);
  assert.equal(store.get('thread-b').status, 'running');

  store.resolveRequest({ id: 'request-a' });
  assert.equal(store.get('thread-a').status, 'planning');
  store.complete('thread-a', 'turn-a', 'completed', 200);
  store.complete('thread-a', 'turn-a', 'completed', 210);
  assert.equal(store.get('thread-a').status, 'completed');
  assert.equal(store.get('thread-a').unreadCount, 1);
  assert.equal(store.get('thread-b').status, 'running');

  store.complete('thread-b', 'turn-b', 'interrupted', 215);
  store.complete('thread-b', 'turn-b', 'completed', 216);
  assert.equal(store.get('thread-b').status, 'interrupted');
  assert.equal(store.get('thread-b').unreadCount, 1);

  store.markSeen('thread-a', 220);
  assert.equal(store.get('thread-a').status, 'idle');
  assert.equal(store.get('thread-a').unreadCount, 0);
  assert(changes.length >= 6);
});

test('thread activity survives reload and reconciles stale running snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-activity-'));
  const store = new ThreadActivityStore({ dataDir: directory });
  store.start('thread-running', 'turn-running', 'default', 100);
  store.complete('thread-done', 'turn-done', 'failed', 200);

  const restored = new ThreadActivityStore({ dataDir: directory });
  assert.equal(restored.get('thread-running').status, 'running');
  assert.equal(restored.get('thread-done').status, 'failed');
  assert.equal(restored.get('thread-done').unreadCount, 1);

  const stale = restored.reconcile({ id: 'thread-running', status: 'idle' }, 5000);
  assert.equal(stale.activity.status, 'idle');
  const active = restored.reconcile({ id: 'thread-active', status: { type: 'active' } }, 6000);
  assert.equal(active.activity.status, 'running');
});
