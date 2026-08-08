import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPairingCode } from '../server/auth.mjs';
import { createCodexMobileServer } from '../server/index.mjs';
import { createArtifactToken } from '../server/security.mjs';

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.turn = 0;
    this.serverRequests = new Map();
    this.responses = [];
    this.failRollout = null;
    this.nextThreadId = null;
  }
  status() { return { ready: true, pid: 123, pendingRequests: 0 }; }
  getServerRequests() {
    return [...this.serverRequests.values()].map(({ upstreamId: _upstreamId, ...request }) => request);
  }
  respondToServerRequest(publicId, result) {
    const request = this.serverRequests.get(publicId);
    this.serverRequests.delete(publicId);
    this.responses.push({ id: publicId, result });
    this.emit('serverRequestResolved', { id: publicId, method: request?.method });
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'test-model', displayName: 'Test', isDefault: true }] };
    if (method === 'collaborationMode/list') return { data: [
      { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
    ] };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') return { thread: {
      id: this.nextThreadId ?? 'thread-1', cwd: params.cwd, turns: [], preview: '', status: 'idle', updatedAt: 1,
    }, cwd: params.cwd };
    if (method === 'thread/read') return { thread: {
      id: params.threadId, cwd: this.project, turns: [], preview: '', status: 'idle', updatedAt: 1,
    } };
    if (method === 'thread/turns/list') {
      this.lastTurnsListParams = params;
      return { data: [{ id: 'turn-9', status: 'completed', items: [] }], nextCursor: 'cursor-next' };
    }
    if (method === 'thread/resume') {
      if (this.failRollout && params.threadId === this.failRollout) {
        throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: 'THREAD_NOT_FOUND' });
      }
      return { thread: {
      id: params.threadId, cwd: this.project, turns: [], preview: '', status: 'idle', updatedAt: 1,
    }, cwd: this.project };
    }
    if (method === 'turn/start') {
      if (this.failRollout && params.threadId === this.failRollout) {
        throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: 'THREAD_NOT_FOUND' });
      }
      return { turn: { id: `turn-${++this.turn}`, status: 'inProgress', items: [] } };
    }
    throw new Error(`unexpected ${method}`);
  }
}

test('HTTP gateway requires pairing and exposes only allowlisted projects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-server-'));
  const root = path.join(directory, 'projects');
  const project = path.join(root, 'demo');
  const dataDir = path.join(directory, 'data');
  const cacheDir = path.join(directory, 'cache');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(cacheDir);
  const skillsRoot = path.join(directory, 'skills');
  fs.mkdirSync(path.join(skillsRoot, 'alpha-skill'), { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, 'beta-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: alpha 描述\n---\n正文');
  fs.writeFileSync(path.join(skillsRoot, 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\ndescription: beta 描述\n---\n正文');
  const pdfPath = path.join(project, 'sample.pdf');
  const officePath = path.join(project, 'sample.docx');
  const spreadsheetPath = path.join(project, 'sample.xlsx');
  const renderedPage = path.join(cacheDir, 'page-2.jpg');
  fs.writeFileSync(pdfPath, '%PDF-1.4 test fixture');
  fs.writeFileSync(officePath, 'office test fixture');
  fs.writeFileSync(spreadsheetPath, 'spreadsheet test fixture');
  fs.writeFileSync(renderedPage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const config = {
    host: '127.0.0.1', port: 0, dataDir, cacheDir, secret: 'server-secret',
    allowedRoots: [root], codexHome: '/root/.codex', sessionTtlSeconds: 60,
    artifactTtlSeconds: 60, maxFileBytes: 1024 * 1024, maxBodyBytes: 64 * 1024,
    ownershipHelper: '/bin/true', logLevel: 'silent',
    defaultModel: 'pinned-model', defaultEffort: 'max',
    skillsRoots: [skillsRoot],
  };
  const rendered = [];
  const bridge = new FakeBridge();
  bridge.project = project;
  const app = createCodexMobileServer({
    config,
    bridge,
    convertOfficeToPdf: async (filePath) => {
      assert.equal(filePath, officePath);
      return pdfPath;
    },
    getPdfPageCount: async (filePath) => {
      assert.equal(filePath, pdfPath);
      return 2;
    },
    renderPdfPage: async (filePath, receivedCacheDir, pageNumber) => {
      assert.equal(filePath, pdfPath);
      assert.equal(receivedCacheDir, cacheDir);
      rendered.push(pageNumber);
      return renderedPage;
    },
    readWorkbook: async (filePath) => {
      assert.equal(filePath, spreadsheetPath);
      return { sheets: [{ index: 0, name: 'Sheet1', rows: 2, columns: 2, hidden: false }] };
    },
    readWorksheet: async (filePath, index) => {
      assert.equal(filePath, spreadsheetPath);
      assert.equal(index, 0);
      return { index: 0, name: 'Sheet1', rows: 2, columns: 2, renderedRows: 2, renderedColumns: 2 };
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/api/bootstrap`);
    assert.equal(denied.status, 401);
    const pairing = createPairingCode(config);
    const paired = await fetch(`${base}/api/auth/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } });
    assert.equal(bootstrap.status, 200);
    const payload = await bootstrap.json();
    assert.equal(payload.runtime.user, os.userInfo().username);
    assert.equal(payload.models[0].id, 'test-model');
    assert.equal(payload.defaultModel, 'pinned-model');
    assert.equal(payload.defaultEffort, 'max');
    assert.deepEqual(payload.collaborationModes.map((mode) => mode.mode), ['plan', 'default']);
    const skills = await fetch(`${base}/api/skills`, { headers: { Cookie: cookie } });
    assert.equal(skills.status, 200);
    const skillNames = (await skills.json()).data.map((item) => item.name);
    assert(skillNames.includes('alpha-skill'));
    assert(skillNames.includes('beta-skill'));
    const created = await fetch(`${base}/api/threads`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project }),
    });
    assert.equal(created.status, 201);
    assert(bridge.calls.some((call) => call.method === 'thread/start' && call.params.cwd === project && call.params.model === 'pinned-model'));
    const planned = await fetch(`${base}/api/threads/thread-1/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '先制定方案', mode: 'plan', approvalsReviewer: 'user',
      }),
    });
    assert.equal(planned.status, 201);
    const planCall = bridge.calls.findLast((call) => call.method === 'turn/start');
    assert.equal(planCall.params.approvalPolicy, 'never');
    assert.equal(planCall.params.approvalsReviewer, 'user');
    assert.deepEqual(planCall.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.deepEqual(planCall.params.collaborationMode, {
      mode: 'plan',
      settings: { model: 'pinned-model', reasoning_effort: 'max', developer_instructions: null },
    });
    const executed = await fetch(`${base}/api/threads/thread-1/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '按方案实施', mode: 'default', approvalsReviewer: 'auto_review',
        model: 'override-model', effort: 'low',
      }),
    });
    assert.equal(executed.status, 201);
    const executeCall = bridge.calls.findLast((call) => call.method === 'turn/start');
    assert.equal(executeCall.params.approvalPolicy, 'on-request');
    assert.equal(executeCall.params.approvalsReviewer, 'auto_review');
    assert.equal(executeCall.params.model, 'override-model');
    assert.equal(executeCall.params.effort, 'low');
    assert.deepEqual(executeCall.params.collaborationMode.settings, {
      model: 'override-model', reasoning_effort: 'low',
      developer_instructions: '执行模式：直接实施用户的请求，不要先输出完整方案或规划；除非用户明确要求方案/设计/规划，才先设计方案。',
    });
    assert.deepEqual(executeCall.params.sandboxPolicy, {
      type: 'workspaceWrite', writableRoots: [project], networkAccess: false,
    });
    const defaultTurn = await fetch(`${base}/api/threads/thread-1/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '测试模型决定',
      }),
    });
    assert.equal(defaultTurn.status, 201);
    const defaultCall = bridge.calls.findLast((call) => call.method === 'turn/start');
    assert.equal(defaultCall.params.approvalPolicy, 'on-request');
    assert.equal(defaultCall.params.approvalsReviewer, 'auto_review');
    assert.deepEqual(defaultCall.params.sandboxPolicy, {
      type: 'workspaceWrite', writableRoots: [project], networkAccess: false,
    });
    assert(defaultCall.params.collaborationMode.settings.developer_instructions.includes('直接实施'));
    const neverTurn = await fetch(`${base}/api/threads/thread-1/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '测试从不问我', approvalsReviewer: 'never',
      }),
    });
    assert.equal(neverTurn.status, 201);
    const neverCall = bridge.calls.findLast((call) => call.method === 'turn/start');
    assert.equal(neverCall.params.approvalPolicy, 'never');
    assert.equal(neverCall.params.approvalsReviewer, undefined);
    assert.deepEqual(neverCall.params.sandboxPolicy, { type: 'dangerFullAccess' });
    const questionRequest = {
      id: 'req-question-1',
      upstreamId: 'upstream-question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', autoResolutionMs: 120_000,
        questions: [
          { id: 'mode', header: '方案', question: '选择方式？', isOther: true, options: [
            { label: '直接实施', description: '改动最小' }, { label: '分阶段实施' },
          ] },
          { id: 'note', question: '还有补充吗？' },
        ],
      },
    };
    bridge.serverRequests.set('req-question-1', questionRequest);
    bridge.emit('serverRequest', questionRequest);
    const pending = await fetch(`${base}/api/requests`, { headers: { Cookie: cookie } });
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).data[0], {
      id: 'req-question-1', method: 'item/tool/requestUserInput', params: questionRequest.params,
    });
    const answered = await fetch(`${base}/api/requests/req-question-1/respond`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'answer', answers: { mode: ['分阶段实施'], note: ['补充内容'] } }),
    });
    assert.equal(answered.status, 200);
    assert.deepEqual(bridge.responses[0].result, {
      answers: { mode: { answers: ['分阶段实施'] }, note: { answers: ['补充内容'] } },
    });
    bridge.failRollout = 'thread-stale';
    bridge.nextThreadId = 'thread-recreated';
    const recovered = await fetch(`${base}/api/threads/thread-stale/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: project, text: 'test', model: 'test-model' }),
    });
    assert.equal(recovered.status, 201);
    const recoveredPayload = await recovered.json();
    assert.equal(recoveredPayload.thread.id, 'thread-recreated');
    assert.equal(recoveredPayload.thread.cwd, project);
    assert.equal(recoveredPayload.recreated, true);
    assert.equal(recoveredPayload.turn.id, 'turn-5');
    assert(bridge.calls.some((call) => call.method === 'thread/start' && call.params.cwd === project && call.params.model === 'test-model'));
    const escaped = await fetch(`${base}/api/threads`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: '/' }),
    });
    assert.equal(escaped.status, 403);
    const turnsPage = await fetch(`${base}/api/threads/thread-1/turns?pageSize=7&cursor=abc`, {
      headers: { Cookie: cookie },
    });
    assert.equal(turnsPage.status, 200);
    assert.deepEqual(await turnsPage.json(), { data: [{ id: 'turn-9', status: 'completed', items: [] }], nextCursor: 'cursor-next' });
    assert.deepEqual(bridge.lastTurnsListParams, {
      threadId: 'thread-1', cursor: 'abc', pageSize: 7, sortDirection: 'desc', itemsView: 'full',
    });
    const ascPage = await fetch(`${base}/api/threads/thread-1/turns?direction=asc&pageSize=3`, {
      headers: { Cookie: cookie },
    });
    assert.equal(ascPage.status, 200);
    assert.equal(bridge.lastTurnsListParams.sortDirection, 'asc');
    assert.equal(bridge.lastTurnsListParams.cursor, undefined);
    const pdfToken = encodeURIComponent(createArtifactToken(pdfPath, config));
    const document = await fetch(`${base}/api/artifacts/${pdfToken}/document`, { headers: { Cookie: cookie } });
    assert.equal(document.status, 200);
    assert.deepEqual(await document.json(), { pages: 2, totalPages: 2, truncated: false });
    const page = await fetch(`${base}/api/artifacts/${pdfToken}/document/pages/2`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await page.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
    assert.deepEqual(rendered, [2]);
    const missingPage = await fetch(`${base}/api/artifacts/${pdfToken}/document/pages/3`, { headers: { Cookie: cookie } });
    assert.equal(missingPage.status, 404);
    const officeToken = encodeURIComponent(createArtifactToken(officePath, config));
    const officeDocument = await fetch(`${base}/api/artifacts/${officeToken}/document`, { headers: { Cookie: cookie } });
    assert.equal(officeDocument.status, 200);
    assert.deepEqual(await officeDocument.json(), { pages: 2, totalPages: 2, truncated: false });
    const spreadsheetToken = encodeURIComponent(createArtifactToken(spreadsheetPath, config));
    const workbook = await fetch(`${base}/api/artifacts/${spreadsheetToken}/workbook`, { headers: { Cookie: cookie } });
    assert.equal(workbook.status, 200);
    assert.deepEqual((await workbook.json()).sheets[0], { index: 0, name: 'Sheet1', rows: 2, columns: 2, hidden: false });
    const worksheet = await fetch(`${base}/api/artifacts/${spreadsheetToken}/workbook/sheets/0`, { headers: { Cookie: cookie } });
    assert.equal(worksheet.status, 200);
    assert.equal((await worksheet.json()).renderedRows, 2);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
