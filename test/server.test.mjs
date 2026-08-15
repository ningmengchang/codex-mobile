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
    if (method === 'thread/name/set') {
      this.lastSetName = params;
      return { thread: { id: params.threadId, name: params.name, cwd: this.project, turns: [], preview: '', status: 'idle', updatedAt: 2 } };
    }
    if (method === 'thread/delete') {
      this.lastDelete = params;
      return { deleted: true };
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
  const markdownPath = path.join(project, 'guide.md');
  const outputDirectory = path.join(project, '最终材料');
  const outputFile = path.join(outputDirectory, '最终报告.md');
  const relatedPngPath = path.join(project, 'related.png');
  const chinesePngPath = path.join(project, '上汽电池护照状态机-流程图-1.png');
  const dingtalkPngPath = path.join(project, 'dingtalk.png');
  const renderedPage = path.join(cacheDir, 'page-2.jpg');
  fs.writeFileSync(pdfPath, '%PDF-1.4 test fixture');
  fs.writeFileSync(officePath, 'office test fixture');
  fs.writeFileSync(spreadsheetPath, 'spreadsheet test fixture');
  fs.writeFileSync(markdownPath, '# Guide\n\n![图](./related.png)');
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(outputFile, '# 最终报告\n');
  fs.writeFileSync(relatedPngPath, Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(chinesePngPath, Buffer.from([5, 6, 7, 8]));
  fs.writeFileSync(dingtalkPngPath, Buffer.from([9, 9, 9, 9]));
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
  const dingtalk = {
    sentFiles: [],
    listMessages: async ({ limit: _limit, before: _before } = {}) => ({
      data: [
        { id: 'msg-1', type: 'text', content: '测试消息', text: '测试消息', title: '测试消息', createdAt: '2026-08-09 10:00:00' },
        { id: 'msg-media', type: 'file', content: '[文件] a.txt fileId: f1', text: 'a.txt', title: 'a.txt', fileId: 'f1', createdAt: '2026-08-09 09:00:00' },
      ],
      hasMore: false,
      nextCursor: null,
    }),
    downloadMedia: async (id) => {
      if (id !== 'msg-media') throw new Error('该消息没有可下载的媒体');
      return { filePath: dingtalkPngPath, fileName: 'dingtalk.png' };
    },
    createTodo: async ({ title, due }) => ({ success: true, result: { taskId: 'todo-1', title, due } }),
    sendFileToSelf: async (filePath, fileName) => {
      dingtalk.sentFiles.push({ filePath, fileName });
      return { success: true, result: { messageId: 'send-1', fileName } };
    },
  };
  const installedSkillNames = [];
  let marketSearchQuery = null;
  const skillMarket = {
    listCommunitySkills: async (search = '') => {
      marketSearchQuery = search;
      return [
        { name: 'alpha-skill', installed: true, description: '', repo: 'demo/alpha', path: '', stars: 10, score: 60 },
        { name: 'beta-skill', installed: false, description: 'beta 描述', repo: 'demo/beta', path: 'skills/beta', stars: 99, score: 88 },
      ];
    },
    listOfficialSkills: async () => [
      { name: 'official-skill', installed: false, description: '官方描述', repo: 'openai/skills', path: 'skills/.curated/official-skill' },
    ],
    installCommunitySkill: async ({ repo, path: skillPath, name }) => {
      if (repo !== 'demo/beta' || skillPath !== 'skills/beta') throw new Error('技能不在当前社区列表中');
      installedSkillNames.push(name);
      return { installed: true };
    },
    installOfficialSkill: async (name) => {
      if (name !== 'official-skill') throw new Error('技能不在官方精选列表中');
      installedSkillNames.push(name);
      return { installed: true };
    },
  };
  const app = createCodexMobileServer({
    config,
    bridge,
    dingtalk,
    skillMarket,
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
    const appScript = await fetch(`${base}/app.js?v=81`);
    assert.equal(appScript.status, 200);
    assert.equal(appScript.headers.get('cache-control'), 'no-cache');
    const appShell = await fetch(`${base}/`);
    assert.equal((await appShell.text()).includes('/app.js?v=81'), true);
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
    assert.equal(payload.defaultModel, 'pinned-model');
    assert.equal(payload.defaultEffort, 'max');
    assert.deepEqual(payload.favorites, []);
    assert.equal(typeof payload.catalogsReady, 'boolean');
    const catalogs = await fetch(`${base}/api/catalogs`, { headers: { Cookie: cookie } });
    assert.equal(catalogs.status, 200);
    const catalogPayload = await catalogs.json();
    assert.equal(catalogPayload.models[0].id, 'test-model');
    assert.deepEqual(catalogPayload.collaborationModes.map((mode) => mode.mode), ['plan', 'default']);
    assert.equal(catalogPayload.defaultModel, 'pinned-model');
    const originalArtifactList = app.tracker.list.bind(app.tracker);
    app.tracker.list = (threadId) => threadId === 'artifact-page-thread'
      ? Array.from({ length: 235 }, (_, index) => ({
        id: `artifact-${index}`,
        name: index === 205 ? '最终 PRD.md' : `文件-${index}.txt`,
        relativePath: index === 205 ? 'docs/最终 PRD.md' : `tmp/文件-${index}.txt`,
      }))
      : originalArtifactList(threadId);
    const artifactPage = await fetch(`${base}/api/threads/artifact-page-thread/artifacts?limit=100&offset=100`, { headers: { Cookie: cookie } });
    assert.equal(artifactPage.status, 200);
    const artifactPageBody = await artifactPage.json();
    assert.equal(artifactPageBody.data.length, 100);
    assert.equal(artifactPageBody.data[0].id, 'artifact-100');
    assert.equal(artifactPageBody.total, 235);
    assert.equal(artifactPageBody.nextOffset, 200);
    const artifactSearch = await fetch(`${base}/api/threads/artifact-page-thread/artifacts?search=${encodeURIComponent('最终 PRD')}&limit=20`, { headers: { Cookie: cookie } });
    const artifactSearchBody = await artifactSearch.json();
    assert.equal(artifactSearchBody.total, 1);
    assert.equal(artifactSearchBody.data[0].id, 'artifact-205');
    assert.equal(artifactSearchBody.nextOffset, null);
    const projectEntries = await fetch(`${base}/api/projects?path=${encodeURIComponent(project)}`, { headers: { Cookie: cookie } });
    assert.equal(projectEntries.status, 200);
    const projectEntriesBody = await projectEntries.json();
    const projectMarkdown = projectEntriesBody.entries.find((entry) => entry.name === 'guide.md');
    const projectDirectory = projectEntriesBody.entries.find((entry) => entry.name === '最终材料');
    assert.equal(projectMarkdown.isDirectory, false);
    assert.equal(projectMarkdown.fileKind, 'markdown');
    assert.equal(projectMarkdown.path, markdownPath);
    assert.equal(typeof projectMarkdown.token, 'string');
    assert.equal(projectDirectory.path, outputDirectory);
    assert.equal(projectDirectory.isDirectory, true);
    assert.equal(projectDirectory.fileKind, 'directory');
    const uploadedName = '手机上传.txt';
    const uploadedPath = path.join(project, uploadedName);
    const uploaded = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent(uploadedName)}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('第一版'),
    });
    assert.equal(uploaded.status, 201);
    const uploadedBody = await uploaded.json();
    assert.equal(uploadedBody.uploaded, true);
    assert.equal(uploadedBody.overwritten, false);
    assert.equal(uploadedBody.artifact.name, uploadedName);
    assert.equal(fs.readFileSync(uploadedPath, 'utf8'), '第一版');
    const duplicateUpload = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent(uploadedName)}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('不应覆盖'),
    });
    assert.equal(duplicateUpload.status, 409);
    assert.equal((await duplicateUpload.json()).error, 'FILE_EXISTS');
    assert.equal(fs.readFileSync(uploadedPath, 'utf8'), '第一版');
    const overwritten = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent(uploadedName)}&overwrite=1`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('第二版'),
    });
    assert.equal(overwritten.status, 200);
    assert.equal((await overwritten.json()).overwritten, true);
    assert.equal(fs.readFileSync(uploadedPath, 'utf8'), '第二版');
    const invalidUpload = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent('../escape.txt')}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('escape'),
    });
    assert.equal(invalidUpload.status, 400);
    assert.equal((await invalidUpload.json()).error, 'INVALID_UPLOAD_NAME');
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
    const uploadSymlinkPath = path.join(project, 'upload-link.txt');
    fs.symlinkSync(markdownPath, uploadSymlinkPath);
    const symlinkUpload = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent('upload-link.txt')}&overwrite=1`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('symlink'),
    });
    assert.equal(symlinkUpload.status, 400);
    assert.equal((await symlinkUpload.json()).error, 'UPLOAD_SYMLINK_NOT_ALLOWED');
    assert.equal(fs.readFileSync(markdownPath, 'utf8'), '# Guide\n\n![图](./related.png)');
    const oversizedUpload = await fetch(`${base}/api/projects/upload?path=${encodeURIComponent(project)}&name=${encodeURIComponent('oversized.bin')}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(config.maxFileBytes + 1),
    });
    assert.equal(oversizedUpload.status, 413);
    assert.equal((await oversizedUpload.json()).error, 'UPLOAD_TOO_LARGE');
    assert.equal(fs.existsSync(path.join(project, 'oversized.bin')), false);
    assert.equal(fs.readdirSync(project).some((name) => name.startsWith('.codex-mobile-upload-')), false);
    const uploadEntries = await fetch(`${base}/api/projects?path=${encodeURIComponent(project)}`, { headers: { Cookie: cookie } });
    assert((await uploadEntries.json()).entries.some((entry) => entry.name === uploadedName && entry.fileKind === 'text'));
    const managedDirectoryName = '手机新建目录';
    const managedDirectoryPath = path.join(project, managedDirectoryName);
    const createdDirectory = await fetch(`${base}/api/projects/entries`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: project, name: managedDirectoryName, type: 'directory' }),
    });
    assert.equal(createdDirectory.status, 201);
    assert.equal((await createdDirectory.json()).artifact.fileKind, 'directory');
    assert.equal(fs.statSync(managedDirectoryPath).isDirectory(), true);
    const managedFileName = '新建说明.txt';
    const managedFilePath = path.join(managedDirectoryPath, managedFileName);
    const createdFile = await fetch(`${base}/api/projects/entries`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: managedDirectoryPath, name: managedFileName, type: 'file', content: '手机创建的内容' }),
    });
    assert.equal(createdFile.status, 201);
    assert.equal((await createdFile.json()).artifact.fileKind, 'text');
    assert.equal(fs.readFileSync(managedFilePath, 'utf8'), '手机创建的内容');
    fs.writeFileSync(path.join(managedDirectoryPath, '待递归删除.txt'), 'nested');
    const duplicateEntry = await fetch(`${base}/api/projects/entries`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: managedDirectoryPath, name: managedFileName, type: 'file' }),
    });
    assert.equal(duplicateEntry.status, 409);
    assert.equal((await duplicateEntry.json()).error, 'ENTRY_EXISTS');
    const invalidEntry = await fetch(`${base}/api/projects/entries`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: project, name: '../越界.txt', type: 'file' }),
    });
    assert.equal(invalidEntry.status, 400);
    assert.equal((await invalidEntry.json()).error, 'INVALID_ENTRY_NAME');
    const outsideEntry = await fetch(`${base}/api/projects/entries`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/', name: '越界.txt', type: 'file' }),
    });
    assert.equal(outsideEntry.status, 403);
    const nonRecursiveDelete = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: managedDirectoryPath, confirmName: managedDirectoryName, recursive: false }),
    });
    assert.equal(nonRecursiveDelete.status, 409);
    assert.equal((await nonRecursiveDelete.json()).error, 'DIRECTORY_NOT_EMPTY');
    const mismatchedDelete = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: managedFilePath, confirmName: '错误名称', recursive: false }),
    });
    assert.equal(mismatchedDelete.status, 400);
    assert.equal((await mismatchedDelete.json()).error, 'DELETE_CONFIRMATION_MISMATCH');
    const deletedFile = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: managedFilePath, confirmName: managedFileName, recursive: false }),
    });
    assert.equal(deletedFile.status, 200);
    assert.equal((await deletedFile.json()).deleted, true);
    assert.equal(fs.existsSync(managedFilePath), false);
    const deletedDirectory = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: managedDirectoryPath, confirmName: managedDirectoryName, recursive: true }),
    });
    assert.equal(deletedDirectory.status, 200);
    assert.equal((await deletedDirectory.json()).isDirectory, true);
    assert.equal(fs.existsSync(managedDirectoryPath), false);
    const rootDelete = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: root, confirmName: path.basename(root), recursive: true }),
    });
    assert.equal(rootDelete.status, 403);
    assert.equal((await rootDelete.json()).error, 'PROJECT_ROOT_DELETE_FORBIDDEN');
    const outsideDelete = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/hosts', confirmName: 'hosts', recursive: false }),
    });
    assert.equal(outsideDelete.status, 403);
    const symlinkDelete = await fetch(`${base}/api/projects/entry`, {
      method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: uploadSymlinkPath, confirmName: path.basename(uploadSymlinkPath), recursive: false }),
    });
    assert.equal(symlinkDelete.status, 400);
    assert.equal((await symlinkDelete.json()).error, 'ENTRY_SYMLINK_NOT_ALLOWED');
    assert.equal(fs.existsSync(uploadSymlinkPath), true);
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
    const importedFavorites = await fetch(`${base}/api/favorites/import`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'thread-legacy', name: '网页版旧收藏', cwd: project, updatedAt: 1 }] }),
    });
    assert.equal(importedFavorites.status, 200);
    assert.deepEqual((await importedFavorites.json()).data.map((item) => item.id), ['thread-legacy']);
    const favoriteCreated = await fetch(`${base}/api/favorites`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'thread-1', name: '收藏的会话', cwd: project, updatedAt: 2 }),
    });
    assert.equal(favoriteCreated.status, 200);
    assert.deepEqual((await favoriteCreated.json()).data.map((item) => item.id), ['thread-1', 'thread-legacy']);
    const favorites = await fetch(`${base}/api/favorites`, { headers: { Cookie: cookie } });
    assert.equal(favorites.status, 200);
    assert.equal((await favorites.json()).data.length, 2);
    const renamed = await fetch(`${base}/api/threads/thread-1/name`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '新名字' }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(bridge.lastSetName, { threadId: 'thread-1', name: '新名字' });
    const favoritesAfterRename = await fetch(`${base}/api/favorites`, { headers: { Cookie: cookie } });
    assert.equal((await favoritesAfterRename.json()).data.find((item) => item.id === 'thread-1').name, '新名字');
    const invalidName = await fetch(`${base}/api/threads/thread-1/name`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(invalidName.status, 400);
    const removed = await fetch(`${base}/api/threads/thread-1/delete`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(bridge.lastDelete, { threadId: 'thread-1' });
    assert.deepEqual(await removed.json(), { deleted: true, result: { deleted: true } });
    const favoritesAfterDelete = await fetch(`${base}/api/favorites`, { headers: { Cookie: cookie } });
    assert.deepEqual((await favoritesAfterDelete.json()).data.map((item) => item.id), ['thread-legacy']);
    const favoriteDeleted = await fetch(`${base}/api/favorites/thread-legacy`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(favoriteDeleted.status, 200);
    assert.deepEqual((await favoriteDeleted.json()).data, []);
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
    const relatedToken = encodeURIComponent(createArtifactToken(markdownPath, config));
    const related = await fetch(`${base}/api/artifacts/${relatedToken}/related?path=${encodeURIComponent('related.png')}`, { headers: { Cookie: cookie } });
    assert.equal(related.status, 200);
    assert.equal(related.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await related.arrayBuffer())], [1, 2, 3, 4]);
    const escapedRelated = await fetch(`${base}/api/artifacts/${relatedToken}/related?path=${encodeURIComponent('/etc/hostname')}`, { headers: { Cookie: cookie } });
    assert.equal(escapedRelated.status, 403);
    const missing = await fetch(`${base}/api/artifacts/${relatedToken}/related?path=${encodeURIComponent('nope.png')}`, { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);
    const chineseName = '上汽电池护照状态机-流程图-1.png';
    const chineseSingle = await fetch(`${base}/api/artifacts/${relatedToken}/related?path=${encodeURIComponent(chineseName)}`, { headers: { Cookie: cookie } });
    assert.equal(chineseSingle.status, 200);
    assert.deepEqual([...new Uint8Array(await chineseSingle.arrayBuffer())], [5, 6, 7, 8]);
    const chineseDouble = await fetch(`${base}/api/artifacts/${relatedToken}/related?path=${encodeURIComponent(encodeURIComponent(chineseName))}`, { headers: { Cookie: cookie } });
    assert.equal(chineseDouble.status, 200);
    assert.deepEqual([...new Uint8Array(await chineseDouble.arrayBuffer())], [5, 6, 7, 8]);
    const resolvedDirectory = await fetch(`${base}/api/files/resolve`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outputDirectory, cwd: project }),
    });
    assert.equal(resolvedDirectory.status, 200);
    const resolvedDirectoryBody = await resolvedDirectory.json();
    assert.equal(resolvedDirectoryBody.artifact.fileKind, 'directory');
    assert.equal(resolvedDirectoryBody.artifact.isDirectory, true);
    const directoryToken = encodeURIComponent(resolvedDirectoryBody.artifact.token);
    const directoryMeta = await fetch(`${base}/api/artifacts/${directoryToken}/meta`, { headers: { Cookie: cookie } });
    assert.equal(directoryMeta.status, 200);
    assert.equal((await directoryMeta.json()).fileKind, 'directory');
    const directory = await fetch(`${base}/api/artifacts/${directoryToken}/directory`, { headers: { Cookie: cookie } });
    assert.equal(directory.status, 200);
    const directoryBody = await directory.json();
    assert.equal(directoryBody.data[0].name, '最终报告.md');
    assert.equal(directoryBody.data[0].fileKind, 'markdown');
    assert.equal(directoryBody.parent.name, 'demo');
    const escapedFile = await fetch(`${base}/api/files/resolve`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/hostname', cwd: project }),
    });
    assert.equal(escapedFile.status, 403);
    const deniedDingtalk = await fetch(`${base}/api/dingtalk/messages`);
    assert.equal(deniedDingtalk.status, 401);
    const messages = await fetch(`${base}/api/dingtalk/messages`, { headers: { Cookie: cookie } });
    assert.equal(messages.status, 200);
    const messagesBody = await messages.json();
    assert.equal(messagesBody.data[0].id, 'msg-1');
    const media = await fetch(`${base}/api/dingtalk/media/msg-media/raw`, { headers: { Cookie: cookie } });
    assert.equal(media.status, 200);
    assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [9, 9, 9, 9]);
    const mediaMissing = await fetch(`${base}/api/dingtalk/media/msg-missing/raw`, { headers: { Cookie: cookie } });
    assert.equal(mediaMissing.status, 404);
    const todo = await fetch(`${base}/api/dingtalk/todos`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '整理周报' }),
    });
    assert.equal(todo.status, 200);
    assert.equal((await todo.json()).result.taskId, 'todo-1');
    const todoInvalid = await fetch(`${base}/api/dingtalk/todos`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    assert.equal(todoInvalid.status, 400);
    const sent = await fetch(`${base}/api/artifacts/${pdfToken}/send-dingtalk`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).sent, true);
    assert.deepEqual(dingtalk.sentFiles, [{ filePath: pdfPath, fileName: 'sample.pdf' }]);
    const sentBadToken = await fetch(`${base}/api/artifacts/not-a-token/send-dingtalk`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(sentBadToken.status, 401);
    const market = await fetch(`${base}/api/skills/market?search=beta`, { headers: { Cookie: cookie } });
    assert.equal(market.status, 200);
    const marketBody = await market.json();
    assert.equal(marketBody.data.length, 2);
    assert.equal(marketSearchQuery, 'beta');
    assert.equal(marketBody.data[1].stars, 99);
    const official = await fetch(`${base}/api/skills/market/official`, { headers: { Cookie: cookie } });
    assert.equal(official.status, 200);
    const officialBody = await official.json();
    assert.equal(officialBody.data.length, 1);
    assert.equal(officialBody.data[0].name, 'official-skill');
    const installOk = await fetch(`${base}/api/skills/market/install`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'demo/beta', path: 'skills/beta', name: 'beta-skill' }),
    });
    assert.equal(installOk.status, 200);
    assert.deepEqual(installedSkillNames, ['beta-skill']);
    const installInvalid = await fetch(`${base}/api/skills/market/install`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'not-listed/foo', path: 'skills/foo', name: 'foo' }),
    });
    assert.equal(installInvalid.status, 400);
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
