import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppServerBridge, approvalResponse } from './app-server.mjs';
import { ArtifactTracker } from './artifacts.mjs';
import { clearSessionCookie, COOKIE_NAME, exchangePairingCode, requireSession, sessionCookie } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { convertOfficeToPdf, getPdfPageCount, renderPdfPage } from './convert.mjs';
import { createDingTalk } from './dingtalk.mjs';
import { EventHub } from './events.mjs';
import { classifyFile, fileMetadata, mimeType } from './files.mjs';
import { listSkills } from './skills.mjs';
import { readWorkbook, readWorksheet } from './spreadsheet.mjs';
import {
  AppError,
  assertAllowedPath,
  assertSameOrigin,
  isInside,
  verifyArtifactToken,
} from './security.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/js/dom.js', ['js/dom.js', 'text/javascript; charset=utf-8']],
  ['/js/http.js', ['js/http.js', 'text/javascript; charset=utf-8']],
  ['/js/format.js', ['js/format.js', 'text/javascript; charset=utf-8']],
  ['/js/state.js', ['js/state.js', 'text/javascript; charset=utf-8']],
  ['/js/chat-core.js', ['js/chat-core.js', 'text/javascript; charset=utf-8']],
  ['/js/chat-view.js', ['js/chat-view.js', 'text/javascript; charset=utf-8']],
  ['/js/mermaid-renderer.js', ['js/mermaid-renderer.js', 'text/javascript; charset=utf-8']],
  ['/js/keyboard.js', ['js/keyboard.js', 'text/javascript; charset=utf-8']],
  ['/js/loading.js', ['js/loading.js', 'text/javascript; charset=utf-8']],
  ['/js/dingtalk.js', ['js/dingtalk.js', 'text/javascript; charset=utf-8']],
  ['/js/debug.js', ['js/debug.js', 'text/javascript; charset=utf-8']],
  ['/vendor/marked.esm.js', ['vendor/marked.esm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/purify.js', ['vendor/purify.js', 'text/javascript; charset=utf-8']],
  ['/vendor/mermaid.min.js', ['vendor/mermaid.min.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

const APP_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

const OWNER_INSTRUCTIONS = `This Codex process runs as the desktop user ningmengchang. Ordinary project files under /home/ningmengchang are user-owned artifacts and must remain owned by ningmengchang:ningmengchang. Do not change ownership of Docker bind mounts, databases, VM data, .git, dependency caches, or service-managed storage. If an artifact is unexpectedly root-owned, classify it first and only then use /root/.codex/bin/fix-ningmengchang-ownership on the exact confirmed user-owned paths. Keep authentication under /home/ningmengchang/.codex unchanged.`;
const MAX_DOCUMENT_PREVIEW_PAGES = 300;
const TURN_MODES = new Set(['default', 'plan']);
const APPROVAL_REVIEWERS = new Set(['auto_review', 'user', 'never']);
const EXECUTE_MODE_INSTRUCTIONS = '执行模式：直接实施用户的请求，不要先输出完整方案或规划；除非用户明确要求方案/设计/规划，才先设计方案。';

function json(response, statusCode, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    ...APP_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  response.end(payload);
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError('请求内容过大。', 413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new AppError('JSON 请求格式不正确。', 400, 'INVALID_JSON');
  }
}

function serveStatic(request, response, pathname) {
  const item = STATIC_FILES.get(pathname);
  if (!item) return false;
  const [filename, contentType] = item;
  const payload = fs.readFileSync(path.join(PUBLIC_ROOT, filename));
  response.writeHead(200, {
    ...APP_HEADERS,
    'Cache-Control': filename === 'sw.js' || filename === 'index.html' ? 'no-cache' : 'public, max-age=300',
    'Content-Type': contentType,
    'Content-Length': payload.length,
  });
  if (request.method === 'HEAD') response.end();
  else response.end(payload);
  return true;
}

function safeFilename(name) {
  return encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function streamFile(request, response, filePath, options = {}) {
  const stat = fs.statSync(filePath);
  const contentType = options.contentType ?? mimeType(filePath);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cache ?? 'private, max-age=60',
    'Content-Disposition': `${options.download ? 'attachment' : 'inline'}; filename*=UTF-8''${safeFilename(options.filename ?? path.basename(filePath))}`,
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentType.startsWith('text/html') || contentType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "sandbox allow-scripts; default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; object-src 'none'";
  }
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match?.[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
    if (!match || start < 0 || end < start || end >= stat.size) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
}

function log(config, level, message, details = '') {
  if (config.logLevel === 'silent') return;
  if (level === 'debug' && config.logLevel !== 'debug') return;
  process.stderr.write(`[codex-mobile] ${level}: ${message}${details ? ` ${details}` : ''}\n`);
}

function routeMatch(pathname, expression) {
  const match = expression.exec(pathname);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function validateProject(candidate, config) {
  const project = assertAllowedPath(candidate, config.allowedRoots);
  if (!fs.statSync(project).isDirectory()) throw new AppError('工作目录必须是文件夹。', 400, 'NOT_A_DIRECTORY');
  return project;
}

function threadAllowed(thread, config) {
  const cwd = path.resolve(String(thread?.cwd ?? '/'));
  return config.allowedRoots.some((root) => isInside(root, cwd));
}

function isThreadGone(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'THREAD_NOT_FOUND'
    || error?.code === 'THREAD_GONE'
    || message.includes('no rollout found')
    || message.includes('thread not found')
    || message.includes('rollout');
}

function resolveRelatedPath(baseDir, relative, config) {
  const candidates = [relative];
  if (relative.includes('%')) {
    try {
      const decoded = decodeURIComponent(relative);
      if (decoded !== relative) candidates.push(decoded);
    } catch {}
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return assertAllowedPath(path.resolve(baseDir, candidate), config.allowedRoots);
    } catch (error) {
      if (error?.code === 'PATH_NOT_ALLOWED') throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new AppError('文件不存在或已经被移动。', 404, 'NOT_FOUND');
}

async function documentPdfPath(filePath, config, tools) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new AppError('目录不能作为文件预览。', 400, 'NOT_A_FILE');
  if (stat.size > config.maxFileBytes) throw new AppError('文件超过预览大小限制。', 413, 'FILE_TOO_LARGE');
  const kind = classifyFile(filePath);
  if (kind === 'pdf') return filePath;
  if (kind === 'office') return tools.convertOfficeToPdf(filePath, config.cacheDir);
  throw new AppError('此文件不是 PDF 或受支持的 Office 文档。', 415, 'NOT_DOCUMENT');
}

function spreadsheetFilePath(filePath, config) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new AppError('目录不能作为 Excel 预览。', 400, 'NOT_A_FILE');
  if (stat.size > config.maxFileBytes) throw new AppError('文件超过预览大小限制。', 413, 'FILE_TOO_LARGE');
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new AppError('此格式暂不支持表格预览，请使用版式预览。', 415, 'NOT_XLSX');
  }
  return filePath;
}

function listProjects(config, requestedPath) {
  const current = requestedPath
    ? validateProject(requestedPath, config)
    : config.allowedRoots[0];
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .slice(0, 300)
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const root = config.allowedRoots.find((item) => isInside(item, current)) ?? current;
  return {
    current: { name: path.basename(current), path: current },
    parent: current !== root ? path.dirname(current) : null,
    root,
    entries,
  };
}

async function listThreads(bridge, config, cwd) {
  const data = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await bridge.request('thread/list', {
      cursor,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      ...(cwd ? { cwd } : {}),
    });
    data.push(...(result?.data ?? []).filter((thread) => threadAllowed(thread, config)));
    cursor = result?.nextCursor ?? null;
    if (!cursor) break;
  }
  return data;
}

function userInput(body, cwd, config) {
  if (typeof body.text !== 'string' || !body.text.trim()) {
    throw new AppError('请输入要交给 Codex 的内容。', 400, 'TEXT_REQUIRED');
  }
  const input = [{ type: 'text', text: body.text.trim(), text_elements: [] }];
  for (const mention of Array.isArray(body.mentions) ? body.mentions : []) {
    const absolute = assertAllowedPath(path.isAbsolute(mention) ? mention : path.join(cwd, mention), config.allowedRoots);
    if (!isInside(cwd, absolute)) throw new AppError('引用文件不在当前项目中。', 403, 'MENTION_OUTSIDE_PROJECT');
    input.push({ type: 'mention', name: path.basename(absolute), path: absolute });
  }
  return input;
}

function turnSettings(body, cwd, catalogs, config) {
  const mode = body.mode == null ? 'default' : String(body.mode);
  if (!TURN_MODES.has(mode)) throw new AppError('不支持的协作模式。', 400, 'INVALID_MODE');
  const approvalsReviewer = body.approvalsReviewer == null ? 'auto_review' : String(body.approvalsReviewer);
  if (!APPROVAL_REVIEWERS.has(approvalsReviewer)) {
    throw new AppError('不支持的审批方式。', 400, 'INVALID_APPROVALS_REVIEWER');
  }
  const defaultModel = catalogs.models.find((model) => model.isDefault)?.id
    ?? catalogs.models[0]?.id;
  const model = body.model ? String(body.model) : (config.defaultModel ?? defaultModel);
  if (!model) throw new AppError('Codex 没有返回可用模型，请刷新页面后重试。', 503, 'MODEL_UNAVAILABLE');
  const preset = catalogs.collaborationModes.find((item) => item.mode === mode);
  const effort = body.effort
    ? String(body.effort)
    : (config.defaultEffort ?? preset?.reasoning_effort ?? preset?.reasoningEffort ?? null);
  const executionMode = mode === 'default';
  return {
    model,
    ...(body.effort ? { effort } : {}),
    approvalPolicy: mode === 'plan' || approvalsReviewer === 'never' ? 'never' : 'on-request',
    ...(approvalsReviewer !== 'never' ? { approvalsReviewer } : {}),
    collaborationMode: {
      mode,
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: executionMode ? EXECUTE_MODE_INSTRUCTIONS : null,
      },
    },
    sandboxPolicy: mode === 'plan'
      ? { type: 'readOnly', networkAccess: false }
      : approvalsReviewer === 'never'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
  };
}

function wireBridge(bridge, tracker, hub, config) {
  bridge.on('status', (status) => hub.publish('bridge-status', status));
  bridge.on('bridgeError', (error) => {
    log(config, 'error', 'App Server bridge error', error.stack ?? error.message);
    hub.publish('bridge-error', { message: error.message });
  });
  bridge.on('stderr', (chunk) => log(config, 'debug', 'app-server', chunk.trim()));
  bridge.on('serverRequest', (request) => hub.publish('approval', request));
  bridge.on('serverRequestResolved', (request) => hub.publish('approval-resolved', request));
  bridge.on('notification', (message) => {
    const params = message.params ?? {};
    if (message.method === 'thread/started' && params.thread) tracker.registerThread(params.thread.id, params.thread.cwd);
    if (message.method === 'turn/started') tracker.bindTurn(params.threadId, params.turn?.id ?? params.turnId);
    if (message.method === 'item/completed' && params.item?.type === 'fileChange') {
      tracker.recordProtocolChanges(params.threadId, params.turnId, params.item.changes);
    }
    if (message.method === 'turn/completed') {
      tracker.finish(params.threadId, params.turn?.id ?? params.turnId)
        .catch((error) => hub.publish('artifact-error', { message: error.message }));
    }
    hub.publish('codex', message);
  });
}

export function createCodexMobileServer(options = {}) {
  const config = options.config ?? loadConfig(options.configOverrides);
  const hub = options.hub ?? new EventHub();
  const bridge = options.bridge ?? new AppServerBridge(config);
  const tracker = options.tracker ?? new ArtifactTracker(config, hub);
  const dingtalk = options.dingtalk ?? createDingTalk(config);
  const documentTools = {
    convertOfficeToPdf: options.convertOfficeToPdf ?? convertOfficeToPdf,
    getPdfPageCount: options.getPdfPageCount ?? getPdfPageCount,
    renderPdfPage: options.renderPdfPage ?? renderPdfPage,
  };
  const spreadsheetTools = {
    readWorkbook: options.readWorkbook ?? readWorkbook,
    readWorksheet: options.readWorksheet ?? readWorksheet,
  };
  const pairingAttempts = [];
  const catalogs = { models: [], collaborationModes: [] };
  const threadMeta = new Map();
  if (typeof bridge.on === 'function') wireBridge(bridge, tracker, hub, config);

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    let pathname = '/';
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      pathname = url.pathname;
      if ((request.method === 'GET' || request.method === 'HEAD') && serveStatic(request, response, pathname)) return;
      if (request.method === 'GET' && pathname === '/healthz') {
        json(response, 200, { status: 'ok', appServer: bridge.status() });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/auth/status') {
        try {
          requireSession(request, config);
          json(response, 200, { authenticated: true });
        } catch {
          json(response, 200, { authenticated: false });
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/auth/pair') {
        assertSameOrigin(request);
        const now = Date.now();
        while (pairingAttempts.length && pairingAttempts[0] < now - 60_000) pairingAttempts.shift();
        if (pairingAttempts.length >= 8) throw new AppError('尝试次数过多，请稍后重试。', 429, 'RATE_LIMITED');
        pairingAttempts.push(now);
        const body = await readBody(request, 4096);
        const token = exchangePairingCode(body.code, config);
        json(response, 200, { authenticated: true }, { 'Set-Cookie': sessionCookie(token, config) });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        assertSameOrigin(request);
        json(response, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie() });
        return;
      }

      requireSession(request, config);
      if (!['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request);

      if (request.method === 'GET' && pathname === '/api/skills') {
        json(response, 200, { data: listSkills(config) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/events') {
        hub.connect(response, Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        const [account, models, collaborationModes] = await Promise.all([
          bridge.request('account/read', { refreshToken: false }).catch((error) => ({ error: error.message })),
          bridge.request('model/list', { limit: 100, includeHidden: false }).catch(() => ({ data: [] })),
          bridge.request('collaborationMode/list', {}).catch(() => ({ data: [] })),
        ]);
        catalogs.models = models?.data ?? [];
        catalogs.collaborationModes = collaborationModes?.data ?? [];
        json(response, 200, {
          account,
          models: catalogs.models,
          collaborationModes: catalogs.collaborationModes,
          defaultModel: config.defaultModel
            ?? catalogs.models.find((model) => model.isDefault)?.id
            ?? catalogs.models[0]?.id
            ?? null,
          defaultEffort: config.defaultEffort ?? null,
          appServer: bridge.status(),
          pendingRequests: bridge.getServerRequests(),
          projects: listProjects(config),
          runtime: {
            user: (() => { try { return os.userInfo().username; } catch { return config.targetUser; } })(),
            codexHome: config.codexHome,
          },
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/projects') {
        json(response, 200, listProjects(config, url.searchParams.get('path')));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/threads') {
        const cwd = url.searchParams.get('cwd');
        const project = cwd ? validateProject(cwd, config) : null;
        const threads = await listThreads(bridge, config, project);
        for (const thread of threads) {
          tracker.registerThread(thread.id, thread.cwd);
          threadMeta.set(thread.id, { cwd: thread.cwd });
        }
        json(response, 200, { data: threads });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/threads') {
        const body = await readBody(request, config.maxBodyBytes);
        const cwd = validateProject(body.cwd, config);
        const result = await bridge.request('thread/start', {
          cwd,
          runtimeWorkspaceRoots: [cwd],
          ...(body.model ? { model: String(body.model) } : {}),
          ...(!body.model && config.defaultModel ? { model: config.defaultModel } : {}),
          serviceName: 'codex-mobile',
          developerInstructions: OWNER_INSTRUCTIONS,
          ephemeral: false,
        });
        tracker.registerThread(result.thread.id, cwd);
        threadMeta.set(result.thread.id, { cwd });
        json(response, 201, result);
        return;
      }

      let match = routeMatch(pathname, /^\/api\/threads\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        const result = await bridge.request('thread/read', { threadId: match[0], includeTurns: false });
        if (!threadAllowed(result.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
        tracker.registerThread(result.thread.id, result.thread.cwd);
        threadMeta.set(result.thread.id, { cwd: result.thread.cwd });
        json(response, 200, result);
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/name$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new AppError('会话名称不能为空。', 400, 'NAME_REQUIRED');
        if (name.length > 100) throw new AppError('会话名称过长。', 400, 'NAME_TOO_LONG');
        const result = await bridge.request('thread/name/set', { threadId: match[0], name });
        json(response, 200, result);
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/delete$/);
      if (request.method === 'POST' && match) {
        const result = await bridge.request('thread/delete', { threadId: match[0] });
        threadMeta.delete(match[0]);
        json(response, 200, { deleted: true, result });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/resume$/);
      if (request.method === 'POST' && match) {
        const result = await bridge.request('thread/resume', {
          threadId: match[0],
          developerInstructions: OWNER_INSTRUCTIONS,
          excludeTurns: true,
        });
        if (!threadAllowed(result.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
        tracker.registerThread(result.thread.id, result.cwd);
        threadMeta.set(result.thread.id, { cwd: result.cwd });
        json(response, 200, result);
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/turns$/);
      if (request.method === 'GET' && match) {
        const pageSize = Math.min(Math.max(Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20, 1), 50);
        const cursor = url.searchParams.get('cursor') || undefined;
        const sortDirection = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
        const result = await bridge.request('thread/turns/list', {
          threadId: match[0],
          cursor,
          pageSize,
          sortDirection,
          itemsView: 'full',
        });
        json(response, 200, { data: result?.data ?? [], nextCursor: result?.nextCursor ?? null });
        return;
      }
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const cwd = validateProject(body.cwd ?? threadMeta.get(match[0])?.cwd, config);
        if (!catalogs.models.length) {
          const models = await bridge.request('model/list', { limit: 100, includeHidden: false });
          catalogs.models = models?.data ?? [];
        }
        if (!catalogs.collaborationModes.length) {
          const modes = await bridge.request('collaborationMode/list', {}).catch(() => ({ data: [] }));
          catalogs.collaborationModes = modes?.data ?? [];
        }
        const settings = turnSettings(body, cwd, catalogs, config);
        let activeThreadId = match[0];
        let recreated = false;
        try {
          const resumed = await bridge.request('thread/resume', {
            threadId: match[0],
            developerInstructions: OWNER_INSTRUCTIONS,
          });
          if (resumed.cwd) threadMeta.set(match[0], { cwd: resumed.cwd });
        } catch (error) {
          if (!isThreadGone(error)) throw error;
          recreated = true;
        }
        tracker.begin(activeThreadId, cwd);
        try {
          let result;
          try {
            result = await bridge.request('turn/start', {
              threadId: activeThreadId,
              input: userInput(body, cwd, config),
              cwd,
              runtimeWorkspaceRoots: [cwd],
              ...settings,
            });
          } catch (error) {
            if (!isThreadGone(error)) throw error;
            await tracker.finish(activeThreadId);
            const started = await bridge.request('thread/start', {
              cwd,
              runtimeWorkspaceRoots: [cwd],
              ...(body.model ? { model: String(body.model) } : {}),
              ...(!body.model && config.defaultModel ? { model: config.defaultModel } : {}),
              serviceName: 'codex-mobile',
              developerInstructions: OWNER_INSTRUCTIONS,
              ephemeral: false,
            });
            activeThreadId = started.thread.id;
            threadMeta.set(activeThreadId, { cwd });
            tracker.begin(activeThreadId, cwd);
            result = await bridge.request('turn/start', {
              threadId: activeThreadId,
              input: userInput(body, cwd, config),
              cwd,
              runtimeWorkspaceRoots: [cwd],
              ...settings,
            });
            recreated = true;
          }
          tracker.bindTurn(activeThreadId, result.turn.id);
          json(response, 201, {
            ...result,
            thread: { id: activeThreadId, cwd },
            recreated,
          });
        } catch (error) {
          await tracker.finish(activeThreadId);
          throw error;
        }
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/steer$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const cwd = validateProject(body.cwd, config);
        const result = await bridge.request('turn/steer', {
          threadId: match[0],
          expectedTurnId: String(body.turnId),
          input: userInput(body, cwd, config),
        });
        json(response, 200, result);
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && match) {
        const result = await bridge.request('turn/interrupt', { threadId: match[0], turnId: match[1] });
        json(response, 200, result ?? { interrupted: true });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/artifacts$/);
      if (request.method === 'GET' && match) {
        json(response, 200, { data: tracker.list(match[0]) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/requests') {
        json(response, 200, { data: bridge.getServerRequests() });
        return;
      }
      match = routeMatch(pathname, /^\/api\/requests\/([^/]+)\/respond$/);
      if (request.method === 'POST' && match) {
        const requestItem = bridge.getServerRequests().find((item) => item.id === match[0]);
        if (!requestItem) throw new AppError('审批请求不存在或已经处理。', 404, 'REQUEST_NOT_FOUND');
        const body = await readBody(request, config.maxBodyBytes);
        bridge.respondToServerRequest(match[0], approvalResponse(requestItem.method, requestItem.params, body));
        json(response, 200, { resolved: true });
        return;
      }

      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/meta$/);
      if (request.method === 'GET' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const root = config.allowedRoots.find((item) => isInside(item, claims.path));
        json(response, 200, { ...fileMetadata(claims.path, root), fileKind: classifyFile(claims.path) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/related$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && match) {
        const claims = verifyArtifactToken(match[0], config);
        const relative = url.searchParams.get('path');
        if (!relative || relative.includes('\0')) throw new AppError('缺少相对路径。', 400, 'RELATED_PATH_REQUIRED');
        const resolved = resolveRelatedPath(path.dirname(claims.path), relative, config);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new AppError('相对路径不是文件。', 400, 'NOT_A_FILE');
        if (stat.size > config.maxFileBytes) throw new AppError('文件超过预览大小限制。', 413, 'FILE_TOO_LARGE');
        streamFile(request, response, resolved, { contentType: mimeType(resolved) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/send-dingtalk$/);
      if (request.method === 'POST' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const stat = fs.statSync(claims.path);
        if (!stat.isFile()) throw new AppError('目录不能发送。', 400, 'NOT_A_FILE');
        if (stat.size > config.maxFileBytes) throw new AppError('文件超过发送大小限制。', 413, 'FILE_TOO_LARGE');
        try {
          const result = await dingtalk.sendFileToSelf(claims.path, path.basename(claims.path));
          json(response, 200, { sent: true, result });
        } catch (error) {
          throw new AppError(error.message || '钉钉发送失败', 502, 'DINGTALK_SEND_ERROR');
        }
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/workbook$/);
      if (request.method === 'GET' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const workbook = await spreadsheetTools.readWorkbook(spreadsheetFilePath(claims.path, config));
        json(response, 200, workbook);
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/workbook\/sheets\/(\d+)$/);
      if (request.method === 'GET' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const worksheet = await spreadsheetTools.readWorksheet(
          spreadsheetFilePath(claims.path, config),
          Number.parseInt(match[1], 10),
        );
        json(response, 200, worksheet);
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/document$/);
      if (request.method === 'GET' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const pdf = await documentPdfPath(claims.path, config, documentTools);
        const totalPages = await documentTools.getPdfPageCount(pdf);
        json(response, 200, {
          pages: Math.min(totalPages, MAX_DOCUMENT_PREVIEW_PAGES),
          totalPages,
          truncated: totalPages > MAX_DOCUMENT_PREVIEW_PAGES,
        });
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/document\/pages\/(\d+)$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && match) {
        const claims = verifyArtifactToken(match[0], config);
        const pageNumber = Number.parseInt(match[1], 10);
        const pdf = await documentPdfPath(claims.path, config, documentTools);
        const totalPages = await documentTools.getPdfPageCount(pdf);
        if (pageNumber < 1 || pageNumber > Math.min(totalPages, MAX_DOCUMENT_PREVIEW_PAGES)) {
          throw new AppError('PDF 页码不存在。', 404, 'PAGE_NOT_FOUND');
        }
        const image = await documentTools.renderPdfPage(pdf, config.cacheDir, pageNumber);
        streamFile(request, response, image, {
          contentType: 'image/jpeg',
          filename: `${path.parse(claims.path).name}-page-${pageNumber}.jpg`,
          cache: 'private, max-age=86400',
        });
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/(raw|office)$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && match) {
        const claims = verifyArtifactToken(match[0], config);
        const stat = fs.statSync(claims.path);
        if (!stat.isFile()) throw new AppError('目录不能作为文件预览。', 400, 'NOT_A_FILE');
        if (stat.size > config.maxFileBytes) throw new AppError('文件超过预览大小限制。', 413, 'FILE_TOO_LARGE');
        if (match[1] === 'office') {
          if (classifyFile(claims.path) !== 'office') throw new AppError('不是支持的 Office 文件。', 415, 'NOT_OFFICE');
          const pdf = await convertOfficeToPdf(claims.path, config.cacheDir);
          streamFile(request, response, pdf, { contentType: 'application/pdf', filename: `${path.parse(claims.path).name}.pdf` });
        } else {
          streamFile(request, response, claims.path, { download: url.searchParams.get('download') === '1' });
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/dingtalk/messages') {
        try {
          const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
          const before = url.searchParams.get('before') || undefined;
          json(response, 200, await dingtalk.listMessages({ limit, before }));
        } catch (error) {
          throw new AppError(error.message || '钉钉服务异常', 502, 'DINGTALK_ERROR');
        }
        return;
      }
      match = routeMatch(pathname, /^\/api\/dingtalk\/media\/([^/]+)\/(raw|download)$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && match) {
        try {
          const media = await dingtalk.downloadMedia(match[0]);
          streamFile(request, response, media.filePath, {
            contentType: mimeType(media.filePath),
            download: match[1] === 'download',
            filename: media.fileName,
          });
        } catch (error) {
          throw new AppError(error.message || '钉钉媒体下载失败', 404, 'DINGTALK_MEDIA_NOT_FOUND');
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/dingtalk/todos') {
        const body = await readBody(request, config.maxBodyBytes);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) throw new AppError('待办标题不能为空。', 400, 'TODO_TITLE_REQUIRED');
        if (title.length > 500) throw new AppError('待办标题过长。', 400, 'TODO_TITLE_TOO_LONG');
        try {
          json(response, 200, await dingtalk.createTodo({ title, due: body.due || undefined }));
        } catch (error) {
          throw new AppError(error.message || '钉钉待办创建失败', 502, 'DINGTALK_TODO_ERROR');
        }
        return;
      }
      throw new AppError('没有找到该接口。', 404, 'NOT_FOUND');
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(error.message || '服务出现内部错误。', 500, error.code || 'INTERNAL_ERROR');
      log(config, appError.statusCode >= 500 ? 'error' : 'debug', appError.message, error.stack ?? '');
      if (!response.headersSent) json(response, appError.statusCode, { error: appError.code, message: appError.message });
      else response.destroy();
    } finally {
      log(config, 'debug', `${request.method} ${pathname}`, `${Date.now() - startedAt}ms`);
    }
  });

  return { server, config, bridge, tracker, hub, dingtalk };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const app = createCodexMobileServer();
  app.server.listen(app.config.port, app.config.host, () => {
    log(app.config, 'info', `listening on http://${app.config.host}:${app.config.port}`);
    log(app.config, 'info', `Codex App Server uses CODEX_HOME=${app.config.codexHome}`);
    app.bridge.start().catch((error) => log(app.config, 'error', 'unable to start app-server', error.stack ?? error.message));
  });
  const shutdown = async () => {
    await app.tracker.finishAll();
    app.hub.close();
    await app.bridge.stop();
    app.server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
