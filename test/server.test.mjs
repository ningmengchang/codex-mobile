import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPairingCode } from '../server/auth.mjs';
import { createCodexMobileServer } from '../server/index.mjs';
import { createArtifactToken } from '../server/security.mjs';

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待测试条件超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeBridge extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.turn = 0;
    this.serverRequests = new Map();
    this.responses = [];
    this.failRollout = null;
    this.nextThreadId = null;
    this.threadList = [];
    this.threadListNextCursor = null;
    this.reconfigurations = [];
    this.restartCount = 0;
    this.rejectDuplicateResumes = false;
    this.resumedThreads = new Set();
    this.activeWriterThreads = new Set();
    this.dynamicThreads = new Map();
    this.forkCount = 0;
    this.threadTurns = null;
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
  async reconfigure(runtime) {
    this.reconfigurations.push(runtime);
    return this.status();
  }
  async restart() {
    this.restartCount += 1;
    this.resumedThreads.clear();
    this.emit('status', { ready: false, pid: null, pendingRequests: 0 });
    this.emit('status', this.status());
    return this.status();
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true };
    if (method === 'account/rateLimits/read') return {
      rateLimits: {
        limitId: 'codex', limitName: null,
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
    };
    if (method === 'model/list') return { data: [{ id: 'test-model', displayName: 'Test', isDefault: true }] };
    if (method === 'collaborationMode/list') return { data: [
      { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
    ] };
    if (method === 'thread/list') {
      this.lastThreadListParams = params;
      const dynamic = [...this.dynamicThreads.values()]
        .filter((thread) => !params.cwd || thread.cwd === params.cwd);
      return { data: [...dynamic, ...this.threadList], nextCursor: this.threadListNextCursor };
    }
    if (method === 'thread/start') return { thread: {
      id: this.nextThreadId ?? 'thread-1', cwd: params.cwd, turns: [], preview: '', status: 'idle', updatedAt: 1,
    }, cwd: params.cwd };
    if (method === 'thread/read') return { thread: this.dynamicThreads.get(params.threadId) ?? {
      id: params.threadId, cwd: this.project, turns: [], preview: '', status: 'idle', updatedAt: 1,
    } };
    if (method === 'thread/turns/list') {
      this.lastTurnsListParams = params;
      if (this.threadTurns) {
        const ordered = params.sortDirection === 'desc' ? [...this.threadTurns].reverse() : [...this.threadTurns];
        const cursorMatch = String(params.cursor ?? '').match(/^turn-cursor:(\d+)$/);
        const offset = cursorMatch ? Number.parseInt(cursorMatch[1], 10) : 0;
        const data = ordered.slice(offset, offset + params.pageSize);
        const nextOffset = offset + data.length;
        return {
          data,
          nextCursor: nextOffset < ordered.length ? `turn-cursor:${nextOffset}` : null,
        };
      }
      return { data: [{ id: 'turn-9', status: 'completed', items: [] }], nextCursor: 'cursor-next' };
    }
    if (method === 'thread/name/set') {
      this.lastSetName = params;
      const existing = this.dynamicThreads.get(params.threadId);
      const thread = { ...(existing ?? { id: params.threadId, cwd: this.project, turns: [], preview: '', status: 'idle' }), name: params.name, updatedAt: 2 };
      if (existing) this.dynamicThreads.set(params.threadId, thread);
      return { thread };
    }
    if (method === 'thread/delete') {
      this.lastDelete = params;
      this.dynamicThreads.delete(params.threadId);
      return { deleted: true };
    }
    if (method === 'thread/unsubscribe') {
      this.resumedThreads.delete(params.threadId);
      return { status: 'unsubscribed' };
    }
    if (method === 'thread/fork') {
      this.forkCount += 1;
      const thread = {
        id: `fork-${params.threadId}-${this.forkCount}`, forkedFromId: params.threadId, cwd: params.cwd,
        turns: [], preview: '', status: 'idle', updatedAt: 2,
      };
      this.dynamicThreads.set(thread.id, thread);
      return { thread, cwd: params.cwd };
    }
    if (method === 'thread/resume') {
      if (this.failRollout && params.threadId === this.failRollout) {
        throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: 'THREAD_NOT_FOUND' });
      }
      if (this.rejectDuplicateResumes && this.resumedThreads.has(params.threadId)) {
        throw new Error(`thread ${params.threadId} already has an active writer`);
      }
      if (this.activeWriterThreads.has(params.threadId)) {
        throw new Error(`thread ${params.threadId} already has an active writer`);
      }
      this.resumedThreads.add(params.threadId);
      return { thread: {
      id: params.threadId, cwd: this.project, turns: [], preview: '', status: 'idle', updatedAt: 1,
    }, cwd: this.project };
    }
    if (method === 'turn/start') {
      if (this.failRollout && params.threadId === this.failRollout) {
        throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: 'THREAD_NOT_FOUND' });
      }
      if (params.threadId === 'thread-history') {
        return { turn: { id: 'turn-history', status: 'inProgress', items: [] } };
      }
      if (params.threadId === 'fork-thread-locked') {
        return { turn: { id: 'turn-forked', status: 'inProgress', items: [] } };
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
  const copyTarget = path.join(root, 'copy-target');
  const dataDir = path.join(directory, 'data');
  const cacheDir = path.join(directory, 'cache');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(copyTarget, { recursive: true });
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
  const renderedPage = path.join(cacheDir, 'page-2.jpg');
  fs.writeFileSync(pdfPath, '%PDF-1.4 test fixture');
  fs.writeFileSync(officePath, 'office test fixture');
  fs.writeFileSync(spreadsheetPath, 'spreadsheet test fixture');
  fs.writeFileSync(markdownPath, '# Guide\n\n![图](./related.png)');
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(outputFile, '# 最终报告\n');
  fs.writeFileSync(relatedPngPath, Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(chinesePngPath, Buffer.from([5, 6, 7, 8]));
  fs.writeFileSync(renderedPage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const config = {
    host: '127.0.0.1', port: 0, dataDir, cacheDir, secret: 'server-secret',
    allowedRoots: [root], codexHome: '/root/.codex', sessionTtlSeconds: 60,
    artifactTtlSeconds: 60, maxFileBytes: 1024 * 1024, maxBodyBytes: 64 * 1024,
    ownershipHelper: '/bin/true', logLevel: 'silent',
    defaultModel: 'pinned-model', defaultEffort: 'max',
    handoffMaxBytes: 64 * 1024, handoffRecentTurns: 20,
    skillsRoots: [skillsRoot],
    codexBackends: [
      {
        id: 'gpt', label: 'GPT', available: true, codexBin: '/bin/true', codexHome: '/root/.codex',
        appServerArgs: ['app-server', '--stdio'], defaultModel: 'pinned-model', defaultEffort: 'max',
        skillsRoots: [skillsRoot],
      },
      {
        id: 'deepseek', label: 'DeepSeek', available: true, codexBin: '/bin/true', codexHome: path.join(directory, '.codex-ds'),
        appServerArgs: ['app-server', '--stdio'], defaultModel: 'deepseek-v4-flash', defaultEffort: 'high',
        skillsRoots: [skillsRoot],
      },
    ],
  };
  const rendered = [];
  const bridge = new FakeBridge();
  bridge.project = project;
  const dingtalk = {
    sentFiles: [],
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
    rolloutHistory: {
      readTurns: async () => [{
        id: 'incomplete-rollout-turn', status: 'completed',
        items: [{ id: 'incomplete-plan', type: 'plan', text: '不完整的本地方案记录' }],
      }],
      resolvePage: async () => null,
    },
    writerRecycleDelayMs: 5,
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
    readGitSnapshot: async (cwd) => ({
      available: true, branch: 'master', head: 'abc123', subject: '测试提交', status: `## master\n M ${path.relative(cwd, markdownPath)}`,
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const appScript = await fetch(`${base}/app.js`);
    assert.equal(appScript.status, 200);
    assert.equal(appScript.headers.get('cache-control'), 'no-cache');
    const appShell = await fetch(`${base}/`);
    assert.match(await appShell.text(), /\/app\.js\?v=\d+/);
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
    const accountStatus = await fetch(`${base}/api/account/status`, { headers: { Cookie: cookie } });
    assert.equal(accountStatus.status, 200);
    const accountStatusPayload = await accountStatus.json();
    assert.equal(accountStatusPayload.available, true);
    assert.equal(accountStatusPayload.account.planType, 'pro');
    assert.equal(accountStatusPayload.rateLimits.primary.usedPercent, 23);
    assert.equal(accountStatusPayload.rateLimits.secondary.windowDurationMins, 10_080);
    assert.equal(accountStatusPayload.rateLimitResetCredits.availableCount, 1);
    assert.equal(payload.defaultModel, 'pinned-model');
    assert.equal(payload.defaultEffort, 'max');
    assert.deepEqual(payload.favorites, []);
    assert.equal(payload.backends.active, 'gpt');
    assert.deepEqual(payload.backends.data.map((item) => item.id), ['gpt', 'deepseek']);
    assert.equal(typeof payload.catalogsReady, 'boolean');
    const catalogs = await fetch(`${base}/api/catalogs`, { headers: { Cookie: cookie } });
    assert.equal(catalogs.status, 200);
    const catalogPayload = await catalogs.json();
    assert.equal(catalogPayload.models[0].id, 'test-model');
    assert.deepEqual(catalogPayload.collaborationModes.map((mode) => mode.mode), ['plan', 'default']);
    assert.equal(catalogPayload.defaultModel, 'pinned-model');
    bridge.threadTurns = [
      { id: 'handoff-turn-1', status: 'completed', items: [
        { id: 'handoff-user-1', type: 'userMessage', content: [{ type: 'text', text: '实现手动交接包' }] },
        { id: 'handoff-agent-1', type: 'agentMessage', text: '已经完成后端读取。' },
      ] },
      { id: 'handoff-turn-2', status: 'completed', items: [
        { id: 'handoff-plan-1', type: 'plan', text: '下一步补齐前端复制入口。' },
      ] },
    ];
    const startsBeforeHandoff = bridge.calls.filter((call) => call.method === 'turn/start').length;
    const handoff = await fetch(`${base}/api/threads/thread-1/handoff`, { headers: { Cookie: cookie } });
    assert.equal(handoff.status, 200);
    const handoffPayload = await handoff.json();
    assert.equal(handoffPayload.format, 'codex-mobile-handoff/v1');
    assert.equal(handoffPayload.sourceAgent, 'gpt');
    assert.equal(handoffPayload.sourceAgentLabel, 'GPT');
    assert.equal(handoffPayload.storage, 'file');
    assert.match(handoffPayload.content, /请读取本机交接包文件/);
    assert.equal(handoffPayload.content, handoffPayload.instruction);
    assert.equal(path.dirname(handoffPayload.filePath), path.join(dataDir, 'handoffs'));
    const storedHandoff = fs.readFileSync(handoffPayload.filePath, 'utf8');
    assert.match(storedHandoff, /实现手动交接包/);
    assert.match(storedHandoff, /下一步补齐前端复制入口/);
    assert.match(storedHandoff, /分支：master/);
    assert.doesNotMatch(storedHandoff, /不完整的本地方案记录/);
    assert.equal(fs.statSync(handoffPayload.filePath).mode & 0o777, 0o600);
    assert.equal(handoffPayload.fileBytes, Buffer.byteLength(storedHandoff, 'utf8'));
    assert.equal(handoffPayload.bytes, handoffPayload.fileBytes);
    assert.equal(bridge.calls.filter((call) => call.method === 'turn/start').length, startsBeforeHandoff);

    bridge.threadTurns = Array.from({ length: 65 }, (_, index) => ({
      id: `paged-handoff-${index + 1}`,
      status: 'completed',
      items: [{
        id: `paged-user-${index + 1}`,
        type: 'userMessage',
        content: [{ type: 'text', text: `分页交接问题-${index + 1}` }],
      }],
    }));
    config.handoffRecentTurns = 60;
    const pagedHandoff = await fetch(`${base}/api/threads/thread-1/handoff`, { headers: { Cookie: cookie } });
    assert.equal(pagedHandoff.status, 200);
    const pagedHandoffPayload = await pagedHandoff.json();
    const pagedHandoffContent = fs.readFileSync(pagedHandoffPayload.filePath, 'utf8');
    assert.match(pagedHandoffContent, /分页交接问题-1/);
    assert.match(pagedHandoffContent, /分页交接问题-6/);
    assert.match(pagedHandoffContent, /分页交接问题-65/);
    assert.doesNotMatch(pagedHandoffContent, /分页交接问题-5(?:\D|$)/);
    assert(bridge.calls.some((call) => call.method === 'thread/turns/list' && call.params.cursor === 'turn-cursor:50'));
    config.handoffRecentTurns = 20;
    bridge.threadTurns = null;
    const originalArtifactList = app.tracker.list.bind(app.tracker);
    app.tracker.list = (threadId) => threadId === 'artifact-page-thread'
      ? Array.from({ length: 235 }, (_, index) => ({
        id: `artifact-${index}`,
        name: index === 205 ? '最终 PRD.md' : index === 234 ? 'implementation.js' : `文件-${index}.txt`,
        relativePath: index === 205 ? 'docs/最终 PRD.md' : index === 234 ? 'src/implementation.js' : `tmp/文件-${index}.txt`,
      }))
      : originalArtifactList(threadId);
    const artifactPage = await fetch(`${base}/api/threads/artifact-page-thread/artifacts?limit=100&offset=100`, { headers: { Cookie: cookie } });
    assert.equal(artifactPage.status, 200);
    const artifactPageBody = await artifactPage.json();
    assert.equal(artifactPageBody.data.length, 100);
    assert.equal(artifactPageBody.data[0].id, 'artifact-100');
    assert.equal(artifactPageBody.total, 234);
    assert.equal(artifactPageBody.nextOffset, 200);
    assert.equal(artifactPageBody.data.some((item) => item.name.endsWith('.js')), false);
    assert.equal(artifactPageBody.scope.kind, 'documents');
    assert.equal(artifactPageBody.scope.history, true);
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
    bridge.rejectDuplicateResumes = true;
    const historicalResume = await fetch(`${base}/api/threads/thread-history/resume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(historicalResume.status, 200);
    const repeatedResume = await fetch(`${base}/api/threads/thread-history/resume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(repeatedResume.status, 200);
    assert.equal(bridge.calls.filter((call) => call.method === 'thread/resume' && call.params.threadId === 'thread-history').length, 0);
    assert.equal(bridge.calls.filter((call) => call.method === 'thread/read' && call.params.threadId === 'thread-history').length, 2);
    const historicalTurn = await fetch(`${base}/api/threads/thread-history/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '恢复后发送', mode: 'default', approvalsReviewer: 'auto_review',
      }),
    });
    assert.equal(historicalTurn.status, 201);
    assert.equal(bridge.calls.filter((call) => call.method === 'thread/resume' && call.params.threadId === 'thread-history').length, 1);
    bridge.rejectDuplicateResumes = false;
    bridge.activeWriterThreads.add('thread-locked');
    const lockedResume = await fetch(`${base}/api/threads/thread-locked/resume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(lockedResume.status, 200);
    assert.equal((await lockedResume.json()).readOnly, true);
    const lockedTurn = await fetch(`${base}/api/threads/thread-locked/turns`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({
        cwd: project, text: '从手机继续', mode: 'default', approvalsReviewer: 'auto_review',
      }),
    });
    assert.equal(lockedTurn.status, 409);
    const lockedPayload = await lockedTurn.json();
    assert.equal(lockedPayload.error, 'THREAD_ACTIVE_WRITER');
    assert.match(lockedPayload.message, /终端或另一个 Codex 进程/);
    assert.equal(bridge.calls.some((call) => call.method === 'thread/fork' && call.params.threadId === 'thread-locked'), false);
    bridge.activeWriterThreads.clear();
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
    assert.equal(planCall.params.collaborationMode.mode, 'plan');
    assert.equal(planCall.params.collaborationMode.settings.model, 'pinned-model');
    assert.equal(planCall.params.collaborationMode.settings.reasoning_effort, 'max');
    assert.match(planCall.params.collaborationMode.settings.developer_instructions, /每个用户回合最多调用一次 request_user_input/);
    assert.match(planCall.params.collaborationMode.settings.developer_instructions, /同一用户回合不得再次调用 request_user_input/);
    bridge.threadList = [{
      id: 'thread-1', cwd: project, name: '并行测试', preview: '正在规划', status: { type: 'active' }, updatedAt: 3,
    }];
    bridge.threadListNextCursor = 'thread-page-2';
    const threadPage = await fetch(`${base}/api/threads?limit=25`, { headers: { Cookie: cookie } });
    assert.equal(threadPage.status, 200);
    const threadPagePayload = await threadPage.json();
    assert.equal(threadPagePayload.nextCursor, 'thread-page-2');
    assert.equal(threadPagePayload.data[0].activity.status, 'planning');
    assert.equal(bridge.lastThreadListParams.limit, 25);
    assert.equal(bridge.lastThreadListParams.cursor, null);
    bridge.threadList = [
      { id: 'thread-1', cwd: project, name: '有效会话', preview: '', status: { type: 'notLoaded' }, updatedAt: 3 },
      { id: 'thread-missing', cwd: path.join(root, 'deleted-project'), name: '目录已删除', preview: '', status: { type: 'notLoaded' }, updatedAt: 2 },
    ];
    bridge.threadListNextCursor = null;
    const resilientThreadPage = await fetch(`${base}/api/threads?limit=25`, { headers: { Cookie: cookie } });
    assert.equal(resilientThreadPage.status, 200);
    assert.deepEqual((await resilientThreadPage.json()).data.map((thread) => thread.id), ['thread-1']);
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
    bridge.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-4', status: 'completed' } },
    });
    await waitFor(() => bridge.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === 'thread-1'));
    assert.equal(bridge.restartCount, 0);
    const activityRead = await fetch(`${base}/api/threads/thread-1`, { headers: { Cookie: cookie } });
    assert.equal(activityRead.status, 200);
    assert.equal((await activityRead.json()).thread.activity.status, 'completed');
    const markedRead = await fetch(`${base}/api/threads/thread-1/read`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(markedRead.status, 200);
    assert.equal((await markedRead.json()).activity.status, 'idle');
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
    bridge.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-history', turn: { id: 'turn-history', status: 'completed' } },
    });
    bridge.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'thread-recreated', turn: { id: 'turn-5', status: 'completed' } },
    });
    await waitFor(() => bridge.restartCount === 1);
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
    const copied = await fetch(`${base}/api/threads/thread-copy/copy`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: copyTarget, name: '可用副本', requestId: 'copy-test-0001' }),
    });
    assert.equal(copied.status, 201);
    const copiedPayload = await copied.json();
    assert.equal(copiedPayload.copied, true);
    assert.equal(copiedPayload.replayed, false);
    assert.equal(copiedPayload.thread.cwd, copyTarget);
    assert.equal(copiedPayload.thread.name, '可用副本');
    assert.notEqual(copiedPayload.thread.id, 'thread-copy');
    assert.deepEqual(
      app.hub.history.filter((event) => event.type === 'thread-copy-progress'
        && event.data.requestId === 'copy-test-0001').map((event) => event.data.stage),
      ['reading', 'forking', 'naming', 'history', 'directory', 'completed'],
    );
    const forkCall = bridge.calls.find((call) => call.method === 'thread/fork' && call.params.threadId === 'thread-copy');
    assert.equal(forkCall.params.cwd, copyTarget);
    assert.deepEqual(forkCall.params.runtimeWorkspaceRoots, [copyTarget]);
    assert.equal(forkCall.params.excludeTurns, true);
    assert.equal(forkCall.params.deferGoalContinuation, true);
    assert(bridge.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === copiedPayload.thread.id));
    const copiedReplay = await fetch(`${base}/api/threads/thread-copy/copy`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: copyTarget, name: '可用副本', requestId: 'copy-test-0001' }),
    });
    assert.equal(copiedReplay.status, 200);
    assert.equal((await copiedReplay.json()).thread.id, copiedPayload.thread.id);
    assert.equal(bridge.calls.filter((call) => call.method === 'thread/fork' && call.params.threadId === 'thread-copy').length, 1);
    const invalidCopyRequest = await fetch(`${base}/api/threads/thread-copy/copy`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: copyTarget, name: '副本', requestId: 'short' }),
    });
    assert.equal(invalidCopyRequest.status, 400);
    const escapedCopy = await fetch(`${base}/api/threads/thread-copy/copy`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/', name: '副本', requestId: 'copy-test-0002' }),
    });
    assert.equal(escapedCopy.status, 403);
    app.threadActivity.start('thread-copy-busy', 'turn-copy-busy', 'default');
    const busyCopy = await fetch(`${base}/api/threads/thread-copy-busy/copy`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: copyTarget, name: '副本', requestId: 'copy-test-0003' }),
    });
    assert.equal(busyCopy.status, 409);
    assert.equal((await busyCopy.json()).error, 'THREAD_COPY_BUSY');
    app.threadActivity.complete('thread-copy-busy', 'turn-copy-busy', 'completed');
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
    const directoryResponse = await fetch(`${base}/api/artifacts/${directoryToken}/directory`, { headers: { Cookie: cookie } });
    assert.equal(directoryResponse.status, 200);
    const directoryBody = await directoryResponse.json();
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
    assert.equal(messages.status, 404);
    const media = await fetch(`${base}/api/dingtalk/media/msg-media/raw`, { headers: { Cookie: cookie } });
    assert.equal(media.status, 404);
    const todo = await fetch(`${base}/api/dingtalk/todos`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '整理周报' }),
    });
    assert.equal(todo.status, 404);
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
    const backends = await fetch(`${base}/api/runtime/backends`, { headers: { Cookie: cookie } });
    assert.equal(backends.status, 200);
    assert.equal((await backends.json()).active, 'gpt');
    const switched = await fetch(`${base}/api/runtime/backend`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'deepseek', force: true }),
    });
    assert.equal(switched.status, 200);
    const switchedBody = await switched.json();
    assert.equal(switchedBody.active, 'deepseek');
    assert.equal(switchedBody.defaultModel, 'deepseek-v4-flash');
    assert.equal(app.backendManager.activeId(), 'deepseek');
    assert.equal(app.config.codexHome, path.join(directory, '.codex-ds'));
    assert.equal(bridge.reconfigurations.at(-1).defaultModel, 'deepseek-v4-flash');
    const persistedBackend = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-backend.json'), 'utf8'));
    assert.equal(persistedBackend.active, 'deepseek');
    const switchedBack = await fetch(`${base}/api/runtime/backend`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'gpt', force: true }),
    });
    assert.equal(switchedBack.status, 200);
    assert.equal((await switchedBack.json()).active, 'gpt');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
