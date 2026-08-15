import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRolloutHistory } from '../server/rollout-history.mjs';

function linesForTurn(number, text, answer) {
  const turnId = `turn-${number}`;
  return [
    { timestamp: `2026-08-11T0${number}:00:00.000Z`, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, started_at: number } },
    { timestamp: `2026-08-11T0${number}:00:01.000Z`, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', id: `user-${number}`, content: [{ type: 'text', text }] } } },
    { timestamp: `2026-08-11T0${number}:00:02.000Z`, type: 'response_item', payload: { type: 'custom_tool_call_output', output: '不应进入历史主消息' } },
    { timestamp: `2026-08-11T0${number}:00:03.000Z`, type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'AgentMessage', id: `agent-${number}`, content: [{ type: 'Text', text: answer }], phase: 'final_answer' } } },
    { timestamp: `2026-08-11T0${number}:00:04.000Z`, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, completed_at: number + 1, duration_ms: 1000 } },
  ];
}

function appendRecords(filePath, records) {
  fs.appendFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('rollout fallback returns the real latest turns and keeps cursor pagination', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-rollout-'));
  const codexHome = path.join(directory, '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '11');
  fs.mkdirSync(sessions, { recursive: true });
  const rolloutPath = path.join(sessions, 'rollout-test.jsonl');
  fs.writeFileSync(rolloutPath, '');
  appendRecords(rolloutPath, [
    ...linesForTurn(1, '问题 1', '回答 1'),
    ...linesForTurn(2, 'test', '收到'),
    ...linesForTurn(3, '最新问题', '最新回答'),
  ]);

  const history = createRolloutHistory({ codexHome });
  const thread = { id: 'thread-test', path: rolloutPath };
  const staleNative = {
    data: [
      { id: 'turn-2', status: 'interrupted', items: [] },
      { id: 'turn-1', status: 'completed', items: [] },
    ],
    nextCursor: null,
  };
  try {
    const latest = await history.resolvePage({
      thread, nativeResult: staleNative, pageSize: 2, direction: 'desc', cursor: undefined,
    });
    assert.equal(latest.source, 'rollout');
    assert.deepEqual(latest.data.map((turn) => turn.id), ['turn-3', 'turn-2']);
    assert.equal(latest.data[0].items[0].content[0].text, '最新问题');
    assert.equal(latest.data[0].items[1].text, '最新回答');
    assert.equal(latest.nextCursor, 'rollout:v1:desc:2');

    const older = await history.resolvePage({
      thread, nativeResult: null, pageSize: 2, direction: 'desc', cursor: latest.nextCursor,
    });
    assert.deepEqual(older.data.map((turn) => turn.id), ['turn-1']);
    assert.equal(older.nextCursor, null);

    appendRecords(rolloutPath, linesForTurn(4, '追加问题', '追加回答'));
    const refreshed = await history.resolvePage({
      thread, nativeResult: staleNative, pageSize: 2, direction: 'desc', cursor: undefined,
    });
    assert.deepEqual(refreshed.data.map((turn) => turn.id), ['turn-4', 'turn-3']);
    assert.equal(refreshed.data[0].items[1].text, '追加回答');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rollout fallback ignores paths outside CODEX_HOME sessions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-rollout-security-'));
  const codexHome = path.join(directory, '.codex');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const outside = path.join(directory, 'outside.jsonl');
  fs.writeFileSync(outside, '');
  try {
    const history = createRolloutHistory({ codexHome });
    assert.deepEqual(await history.readTurns({ path: outside }), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rollout fallback marks an unfinished tail interrupted when the thread is idle', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-rollout-idle-'));
  const codexHome = path.join(directory, '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '11');
  fs.mkdirSync(sessions, { recursive: true });
  const rolloutPath = path.join(sessions, 'rollout-stale.jsonl');
  fs.writeFileSync(rolloutPath, '');
  appendRecords(rolloutPath, [
    { timestamp: '2026-08-11T08:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-stale' } },
    { timestamp: '2026-08-11T08:00:01.000Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-stale', item: { type: 'UserMessage', id: 'user-stale', content: [{ type: 'text', text: '未完成问题' }] } } },
  ]);
  const history = createRolloutHistory({ codexHome });
  try {
    const idle = await history.resolvePage({
      thread: { id: 'thread-stale', path: rolloutPath, status: { type: 'idle' } },
      nativeResult: { data: [], nextCursor: null },
      pageSize: 20,
      direction: 'desc',
      cursor: undefined,
    });
    assert.equal(idle.data[0].status, 'interrupted');

    const notLoaded = await history.resolvePage({
      thread: { id: 'thread-stale', path: rolloutPath, status: { type: 'notLoaded' } },
      nativeResult: { data: [], nextCursor: null },
      pageSize: 20,
      direction: 'desc',
      cursor: undefined,
    });
    assert.equal(notLoaded.data[0].status, 'interrupted');

    const active = await history.resolvePage({
      thread: { id: 'thread-stale', path: rolloutPath, status: { type: 'active' } },
      nativeResult: { data: [], nextCursor: null },
      pageSize: 20,
      direction: 'desc',
      cursor: undefined,
    });
    assert.equal(active.data[0].status, 'inProgress');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
