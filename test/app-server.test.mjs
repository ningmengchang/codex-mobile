import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppServerBridge, approvalResponse } from '../server/app-server.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.mjs');

test('bridge initializes, correlates responses, and resolves server requests', async () => {
  const bridge = new AppServerBridge({
    codexBin: process.execPath,
    appServerArgs: [FIXTURE],
    codexHome: '/tmp/not-used',
  });
  try {
    await bridge.start();
    assert.equal(bridge.status().ready, true);
    assert.deepEqual(await bridge.request('test/echo', { value: 42 }), { value: 42 });
    const requestEvent = once(bridge, 'serverRequest');
    await bridge.request('test/approval');
    const [request] = await requestEvent;
    assert.equal(request.method, 'item/commandExecution/requestApproval');
    const notification = once(bridge, 'notification');
    bridge.respondToServerRequest(request.id, { decision: 'accept' });
    const [message] = await notification;
    assert.equal(message.method, 'test/approvalResolved');
    assert.deepEqual(message.params.result, { decision: 'accept' });
  } finally {
    await bridge.stop();
  }
});

test('approval response validates modern, permission, question, and legacy requests', () => {
  assert.deepEqual(approvalResponse('mcpServer/elicitation/request', {
    mode: 'url', url: 'https://example.test/confirm',
  }, { action: 'accept' }), {
    action: 'accept', content: null, _meta: null,
  });
  assert.deepEqual(approvalResponse('mcpServer/elicitation/request', {
    mode: 'form', requestedSchema: { type: 'object', properties: {} },
  }, { action: 'decline', content: { ignored: true } }), {
    action: 'decline', content: null, _meta: null,
  });
  assert.deepEqual(approvalResponse('mcpServer/elicitation/request', {}, {
    action: 'acceptForSession', content: { confirmed: true }, _meta: { source: 'mobile' },
  }), {
    action: 'accept', content: { confirmed: true }, _meta: { source: 'mobile' },
  });
  assert.deepEqual(approvalResponse('item/fileChange/requestApproval', {}, { action: 'accept' }), { decision: 'accept' });
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', {
    permissions: { network: { enabled: true }, fileSystem: null },
  }, { action: 'acceptForSession' }), {
    permissions: { network: { enabled: true } }, scope: 'session',
  });
  assert.deepEqual(approvalResponse('item/tool/requestUserInput', {}, { answers: { q1: 'A' } }), {
    answers: { q1: { answers: ['A'] } },
  });
  assert.deepEqual(approvalResponse('execCommandApproval', {}, { action: 'decline', reason: 'no' }), {
    decision: { denied: { rejection: 'no' } },
  });
});
