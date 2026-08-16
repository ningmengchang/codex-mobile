import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppServerBridge, approvalResponse } from './app-server.mjs';
import { ArtifactTracker } from './artifacts.mjs';
import { createConversationArtifacts } from './conversation-artifacts.mjs';
import { clearSessionCookie, COOKIE_NAME, exchangePairingCode, requireSession, sessionCookie } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { convertOfficeToPdf, getPdfPageCount, renderPdfPage } from './convert.mjs';
import { createDingTalk } from './dingtalk.mjs';
import { EventHub } from './events.mjs';
import { createFavoritesStore } from './favorites.mjs';
import { classifyFile, fileMetadata, isDocumentPath, mimeType } from './files.mjs';
import { listSkills } from './skills.mjs';
import { createSkillMarket } from './skill-market.mjs';
import { createRolloutHistory, isRolloutCursor } from './rollout-history.mjs';
import { readWorkbook, readWorksheet } from './spreadsheet.mjs';
import { createThreadActivityStore } from './thread-activity.mjs';
import { receiveUpload } from './uploads.mjs';
import { createProjectEntry, deleteProjectEntry } from './project-files.mjs';
import {
  AppError,
  assertAllowedPath,
  assertSameOrigin,
  createArtifactToken,
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
  ['/js/skill-market.js', ['js/skill-market.js', 'text/javascript; charset=utf-8']],
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
  const mustRevalidate = filename === 'sw.js' || filename === 'index.html'
    || filename.endsWith('.js') || filename.endsWith('.css');
  response.writeHead(200, {
    ...APP_HEADERS,
    'Cache-Control': mustRevalidate ? 'no-cache' : 'public, max-age=300',
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

function favoriteInput(value, config) {
  if (!value || typeof value !== 'object') throw new AppError('收藏内容无效。', 400, 'INVALID_FAVORITE');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : '';
  if (!id) throw new AppError('收藏缺少会话 ID。', 400, 'FAVORITE_ID_REQUIRED');
  if (id.length > 200) throw new AppError('会话 ID 过长。', 400, 'FAVORITE_ID_TOO_LONG');
  if (name.length > 200) throw new AppError('会话名称过长。', 400, 'FAVORITE_NAME_TOO_LONG');
  if (!cwd) throw new AppError('收藏缺少项目目录。', 400, 'FAVORITE_CWD_REQUIRED');
  return {
    id,
    name: name || '未命名会话',
    cwd: validateProject(cwd, config),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Math.max(0, Number(value.updatedAt)) : Date.now(),
  };
}

function resolveLinkedPath(rawPath, cwd, config) {
  let candidate = String(rawPath ?? '').trim();
  if (!candidate) throw new AppError('文件路径不能为空。', 400, 'FILE_PATH_REQUIRED');
  if (candidate.startsWith('file:')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      throw new AppError('文件链接格式不正确。', 400, 'INVALID_FILE_URL');
    }
  } else {
    try { candidate = decodeURIComponent(candidate); } catch {}
    candidate = candidate.split('#', 1)[0].split('?', 1)[0];
    if (!path.isAbsolute(candidate)) {
      candidate = path.resolve(validateProject(cwd, config), candidate);
    }
  }
  return assertAllowedPath(candidate, config.allowedRoots);
}

function linkedArtifact(filePath, config) {
  const root = config.allowedRoots.find((item) => isInside(item, filePath));
  const token = createArtifactToken(filePath, config);
  return {
    id: `linked:${token}`,
    projectPath: root,
    status: 'linked',
    ...fileMetadata(filePath, root),
    available: true,
    token,
  };
}

function listDirectory(directoryPath, config) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => {
      try { return linkedArtifact(path.join(directoryPath, entry.name), config); } catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  const root = config.allowedRoots.find((item) => isInside(item, directoryPath));
  const parentPath = path.dirname(directoryPath);
  const parent = directoryPath !== root && isInside(root, parentPath)
    ? linkedArtifact(parentPath, config)
    : null;
  return { data: entries.slice(0, 500), parent, truncated: entries.length > 500 };
}

function threadAllowed(thread, config) {
  try {
    const cwd = fs.realpathSync(path.resolve(String(thread?.cwd ?? '/')));
    return fs.statSync(cwd).isDirectory()
      && config.allowedRoots.some((root) => isInside(root, cwd));
  } catch {
    // Historical rollouts can outlive their workspace directory. They should
    // not make the entire conversation list fail to load.
    return false;
  }
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
  const allEntries = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
    .map((entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, path: entryPath, isDirectory: true, fileKind: 'directory' };
      }
      try { return { ...linkedArtifact(entryPath, config), path: entryPath }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  const entries = allEntries.slice(0, 300);
  const root = config.allowedRoots.find((item) => isInside(item, current)) ?? current;
  return {
    current: { name: path.basename(current), path: current },
    parent: current !== root ? path.dirname(current) : null,
    root,
    entries,
    truncated: allEntries.length > entries.length,
  };
}

async function listThreads(bridge, config, options = {}) {
  const result = await bridge.request('thread/list', {
    cursor: options.cursor || null,
    limit: Math.min(Math.max(options.limit ?? 100, 1), 100),
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return {
    data: (result?.data ?? []).filter((thread) => threadAllowed(thread, config)),
    nextCursor: result?.nextCursor ?? null,
  };
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

function wireBridge(bridge, tracker, threadActivity, hub, config) {
  bridge.on('status', (status) => hub.publish('bridge-status', status));
  bridge.on('bridgeError', (error) => {
    log(config, 'error', 'App Server bridge error', error.stack ?? error.message);
    hub.publish('bridge-error', { message: error.message });
  });
  bridge.on('stderr', (chunk) => log(config, 'debug', 'app-server', chunk.trim()));
  bridge.on('serverRequest', (request) => {
    threadActivity.waitForInput(request);
    hub.publish('approval', request);
  });
  bridge.on('serverRequestResolved', (request) => {
    threadActivity.resolveRequest(request);
    hub.publish('approval-resolved', request);
  });
  bridge.on('notification', (message) => {
    const params = message.params ?? {};
    if (message.method === 'thread/started' && params.thread) tracker.registerThread(params.thread.id, params.thread.cwd);
    if (message.method === 'turn/started') {
      const threadId = params.threadId ?? params.thread_id;
      const turnId = params.turn?.id ?? params.turnId ?? params.turn_id;
      tracker.bindTurn(threadId, turnId);
      const phase = threadActivity.get(threadId)?.phase ?? 'default';
      threadActivity.start(threadId, turnId, phase);
    }
    if (message.method === 'item/completed' && params.item?.type === 'fileChange') {
      tracker.recordProtocolChanges(params.threadId, params.turnId, params.item.changes);
    }
    if (message.method === 'turn/completed') {
      const threadId = params.threadId ?? params.thread_id;
      const turnId = params.turn?.id ?? params.turnId ?? params.turn_id;
      threadActivity.complete(threadId, turnId, params.turn?.status ?? params.status ?? 'completed');
      tracker.finish(threadId, turnId)
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
  const favorites = options.favorites ?? createFavoritesStore(config);
  const skillMarket = options.skillMarket ?? createSkillMarket(config);
  const rolloutHistory = options.rolloutHistory ?? createRolloutHistory(config);
  const conversationArtifacts = options.conversationArtifacts ?? createConversationArtifacts(config, {
    onReady: ({ threadId }) => hub.publish('artifact-history-ready', { threadId }),
    onError: ({ threadId, error }) => hub.publish('artifact-error', { threadId, message: error.message }),
  });
  const threadActivity = options.threadActivity ?? createThreadActivityStore(config, {
    onChange: (activity) => hub.publish('thread-activity', activity),
  });
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
  const catalogs = {
    account: null,
    models: [],
    collaborationModes: [],
    refreshedAt: 0,
    refreshPromise: null,
  };
  const catalogPayload = () => ({
    account: catalogs.account,
    models: catalogs.models,
    collaborationModes: catalogs.collaborationModes,
    defaultModel: config.defaultModel
      ?? catalogs.models.find((model) => model.isDefault)?.id
      ?? catalogs.models[0]?.id
      ?? null,
    defaultEffort: config.defaultEffort ?? null,
    catalogsReady: catalogs.refreshedAt > 0,
  });
  const refreshCatalogs = (force = false) => {
    const fresh = catalogs.refreshedAt && Date.now() - catalogs.refreshedAt < 10 * 60 * 1000;
    if (!force && fresh) return Promise.resolve(catalogPayload());
    if (catalogs.refreshPromise) return catalogs.refreshPromise;
    catalogs.refreshPromise = Promise.all([
      bridge.request('account/read', { refreshToken: false }).catch((error) => ({ error: error.message })),
      bridge.request('model/list', { limit: 100, includeHidden: false }).catch(() => ({ data: [] })),
      bridge.request('collaborationMode/list', {}).catch(() => ({ data: [] })),
    ]).then(([account, models, collaborationModes]) => {
      catalogs.account = account;
      catalogs.models = models?.data ?? [];
      catalogs.collaborationModes = collaborationModes?.data ?? [];
      catalogs.refreshedAt = Date.now();
      return catalogPayload();
    }).finally(() => {
      catalogs.refreshPromise = null;
    });
    return catalogs.refreshPromise;
  };
  const threadMeta = new Map();
  const rememberThread = (thread, fallbackCwd = null) => {
    if (!thread?.id) return;
    const previous = threadMeta.get(thread.id) ?? {};
    threadMeta.set(thread.id, {
      ...previous,
      cwd: thread.cwd ?? fallbackCwd ?? previous.cwd,
      path: thread.path ?? previous.path,
      status: thread.status ?? previous.status,
      name: thread.name ?? previous.name,
      updatedAt: thread.updatedAt ?? previous.updatedAt,
    });
  };
  const publishFavorites = (data = favorites.list()) => {
    hub.publish('favorites', { data });
    return data;
  };
  if (typeof bridge.on === 'function') wireBridge(bridge, tracker, threadActivity, hub, config);

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

      if (request.method === 'GET' && pathname === '/api/favorites') {
        json(response, 200, { data: favorites.list() });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/favorites/import') {
        const body = await readBody(request, config.maxBodyBytes);
        if (!Array.isArray(body.items)) throw new AppError('收藏列表格式不正确。', 400, 'INVALID_FAVORITES');
        const imported = [];
        for (const item of body.items.slice(0, 50)) {
          try { imported.push(favoriteInput(item, config)); } catch (error) {
            if (!(error instanceof AppError)) throw error;
          }
        }
        json(response, 200, { data: publishFavorites(favorites.import(imported)) });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/favorites') {
        const body = await readBody(request, config.maxBodyBytes);
        json(response, 200, { data: publishFavorites(favorites.upsert(favoriteInput(body, config))) });
        return;
      }
      const favoriteMatch = routeMatch(pathname, /^\/api\/favorites\/([^/]+)$/);
      if (request.method === 'DELETE' && favoriteMatch) {
        json(response, 200, { data: publishFavorites(favorites.remove(favoriteMatch[0])) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/skills') {
        json(response, 200, { data: listSkills(config) });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/files/resolve') {
        const body = await readBody(request, config.maxBodyBytes);
        const filePath = resolveLinkedPath(body.path, body.cwd, config);
        json(response, 200, { artifact: linkedArtifact(filePath, config) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/skills/market') {
        try {
          const search = url.searchParams.get('search') ?? '';
          json(response, 200, { data: await skillMarket.listCommunitySkills(search) });
        } catch (error) {
          throw new AppError(error.message || '技能市场加载失败', 502, 'SKILL_MARKET_ERROR');
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/skills/market/official') {
        try {
          json(response, 200, { data: await skillMarket.listOfficialSkills() });
        } catch (error) {
          throw new AppError(error.message || '官方技能加载失败', 502, 'SKILL_OFFICIAL_ERROR');
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/skills/market/install') {
        const body = await readBody(request, config.maxBodyBytes);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
        const skillPath = typeof body.path === 'string' ? body.path.trim() : '';
        if (!repo && !name) throw new AppError('请提供技能名称或仓库地址。', 400, 'SKILL_SOURCE_REQUIRED');
        try {
          const result = repo
            ? await skillMarket.installCommunitySkill({ repo, path: skillPath, name })
            : await skillMarket.installOfficialSkill(name);
          json(response, 200, result);
        } catch (error) {
          const wrapped = new AppError(error.message || '技能安装失败', 400, error?.code || 'SKILL_INSTALL_ERROR');
          wrapped.data = error?.data;
          throw wrapped;
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/events') {
        hub.connect(response, Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/catalogs') {
        json(response, 200, await refreshCatalogs(url.searchParams.get('refresh') === '1'));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        void refreshCatalogs().catch((error) => log(config, 'debug', 'Catalog refresh failed', error.message));
        const pendingRequests = bridge.getServerRequests();
        threadActivity.syncRequests(pendingRequests);
        json(response, 200, {
          ...catalogPayload(),
          appServer: bridge.status(),
          pendingRequests,
          threadActivities: threadActivity.list(),
          favorites: favorites.list(),
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
      if (request.method === 'POST' && pathname === '/api/projects/upload') {
        const requestedDirectory = url.searchParams.get('path');
        if (!requestedDirectory) throw new AppError('请选择上传目录。', 400, 'UPLOAD_DIRECTORY_REQUIRED');
        const directory = validateProject(requestedDirectory, config);
        const upload = await receiveUpload(request, {
          directory,
          fileName: url.searchParams.get('name'),
          overwrite: url.searchParams.get('overwrite') === '1',
          allowedRoots: config.allowedRoots,
          maxBytes: config.maxFileBytes,
        });
        json(response, upload.overwritten ? 200 : 201, {
          uploaded: true,
          overwritten: upload.overwritten,
          artifact: linkedArtifact(upload.path, config),
        });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/projects/entries') {
        const body = await readBody(request, config.maxBodyBytes);
        const created = await createProjectEntry({
          directory: body.directory,
          name: body.name,
          type: body.type,
          content: body.content,
          allowedRoots: config.allowedRoots,
          maxContentBytes: config.maxBodyBytes,
        });
        json(response, 201, { created: true, artifact: linkedArtifact(created.path, config) });
        return;
      }
      if (request.method === 'DELETE' && pathname === '/api/projects/entry') {
        const body = await readBody(request, config.maxBodyBytes);
        json(response, 200, await deleteProjectEntry({
          targetPath: body.path,
          confirmName: body.confirmName,
          recursive: body.recursive === true,
          allowedRoots: config.allowedRoots,
        }));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/threads') {
        const cwd = url.searchParams.get('cwd');
        const project = cwd ? validateProject(cwd, config) : null;
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 100);
        const cursor = url.searchParams.get('cursor') || null;
        const page = await listThreads(bridge, config, { cwd: project, limit, cursor });
        const threads = [];
        for (const item of page.data) {
          const thread = threadActivity.reconcile(item);
          try {
            tracker.registerThread(thread.id, thread.cwd);
          } catch (error) {
            // The directory can disappear between listing and registration.
            if (error?.code === 'NOT_FOUND' || error?.code === 'PATH_NOT_ALLOWED') continue;
            throw error;
          }
          rememberThread(thread);
          threads.push(thread);
        }
        json(response, 200, { data: threads, nextCursor: page.nextCursor });
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
        rememberThread(result.thread, cwd);
        json(response, 201, { ...result, thread: threadActivity.attach(result.thread) });
        return;
      }

      let match = routeMatch(pathname, /^\/api\/threads\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        const result = await bridge.request('thread/read', { threadId: match[0], includeTurns: false });
        if (!threadAllowed(result.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
        tracker.registerThread(result.thread.id, result.thread.cwd);
        rememberThread(result.thread);
        json(response, 200, { ...result, thread: threadActivity.reconcile(result.thread) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/name$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new AppError('会话名称不能为空。', 400, 'NAME_REQUIRED');
        if (name.length > 100) throw new AppError('会话名称过长。', 400, 'NAME_TOO_LONG');
        const result = await bridge.request('thread/name/set', { threadId: match[0], name });
        if (favorites.list().some((item) => item.id === match[0])) publishFavorites(favorites.rename(match[0], name));
        json(response, 200, { ...result, thread: threadActivity.attach(result.thread) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/delete$/);
      if (request.method === 'POST' && match) {
        const result = await bridge.request('thread/delete', { threadId: match[0] });
        threadMeta.delete(match[0]);
        threadActivity.remove(match[0]);
        if (favorites.list().some((item) => item.id === match[0])) publishFavorites(favorites.remove(match[0]));
        json(response, 200, { deleted: true, result });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/read$/);
      if (request.method === 'POST' && match) {
        json(response, 200, { activity: threadActivity.markSeen(match[0]) });
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
        rememberThread(result.thread, result.cwd);
        json(response, 200, { ...result, thread: threadActivity.attach(result.thread) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/turns$/);
      if (request.method === 'GET' && match) {
        const pageSize = Math.min(Math.max(Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20, 1), 50);
        const cursor = url.searchParams.get('cursor') || undefined;
        const sortDirection = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
        let meta = threadMeta.get(match[0]);
        if (!meta?.path) {
          const read = await bridge.request('thread/read', { threadId: match[0], includeTurns: false });
          if (!threadAllowed(read.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
          rememberThread(read.thread);
          meta = threadMeta.get(match[0]);
        }
        const result = isRolloutCursor(cursor) ? null : await bridge.request('thread/turns/list', {
          threadId: match[0],
          cursor,
          pageSize,
          sortDirection,
          itemsView: 'full',
        });
        const recovered = await rolloutHistory.resolvePage({
          thread: meta,
          nativeResult: result,
          pageSize,
          direction: sortDirection,
          cursor,
        });
        const page = recovered ?? result ?? { data: [], nextCursor: null };
        json(response, 200, { data: page.data ?? [], nextCursor: page.nextCursor ?? null });
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
          if (resumed.thread) rememberThread(resumed.thread, resumed.cwd);
          else if (resumed.cwd) rememberThread({ id: match[0], cwd: resumed.cwd });
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
            rememberThread(started.thread, cwd);
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
          const activity = threadActivity.start(activeThreadId, result.turn.id, body.mode ?? 'default');
          json(response, 201, {
            ...result,
            thread: { id: activeThreadId, cwd, activity },
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
        const activity = threadActivity.complete(match[0], match[1], 'interrupted');
        json(response, 200, { ...(result ?? { interrupted: true }), activity });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/artifacts$/);
      if (request.method === 'GET' && match) {
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 200);
        const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
        const search = String(url.searchParams.get('search') ?? '').trim().toLowerCase();
        const threadId = match[0];
        const tracked = tracker.list(threadId);
        let meta = threadMeta.get(threadId);
        if (!meta?.path) {
          const read = await bridge.request('thread/read', { threadId, includeTurns: false });
          if (!threadAllowed(read.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
          rememberThread(read.thread);
          meta = threadMeta.get(threadId);
        }
        const recoveredSnapshot = meta?.path
          ? (conversationArtifacts.snapshot?.({ id: threadId, ...meta })
            ?? { items: await conversationArtifacts.list({ id: threadId, ...meta }), pending: false })
          : { items: [], pending: false };
        const recovered = recoveredSnapshot.items ?? [];
        const seen = new Set();
        const items = [];
        for (const item of [...tracked, ...recovered]) {
          if (!isDocumentPath(item.relativePath ?? item.name) || item.available === false || item.status === 'deleted') continue;
          const key = `${item.projectPath ?? meta?.cwd ?? ''}\0${item.relativePath ?? item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(item);
        }
        items.sort((left, right) => {
          const leftTime = Date.parse(left.modifiedAt ?? left.capturedAt ?? '') || 0;
          const rightTime = Date.parse(right.modifiedAt ?? right.capturedAt ?? '') || 0;
          return rightTime - leftTime;
        });
        const filtered = search
          ? items.filter((item) => `${item.name ?? ''} ${item.relativePath ?? ''}`.toLowerCase().includes(search))
          : items;
        const nextOffset = offset + limit < filtered.length ? offset + limit : null;
        json(response, 200, {
          data: filtered.slice(offset, offset + limit),
          total: filtered.length,
          nextOffset,
          scope: {
            threadId,
            name: meta?.name ?? null,
            cwd: meta?.cwd ?? tracked[0]?.projectPath ?? null,
            source: tracked.length && recovered.length ? 'mixed' : recovered.length ? 'conversation' : 'tracked',
            kind: 'documents',
            history: true,
            historyPending: recoveredSnapshot.pending === true,
          },
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/requests') {
        const requests = bridge.getServerRequests();
        threadActivity.syncRequests(requests);
        json(response, 200, { data: requests });
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
        json(response, 200, fileMetadata(claims.path, root));
        return;
      }
      match = routeMatch(pathname, /^\/api\/artifacts\/([^/]+)\/directory$/);
      if (request.method === 'GET' && match) {
        const claims = verifyArtifactToken(match[0], config);
        const stat = fs.statSync(claims.path);
        if (!stat.isDirectory()) throw new AppError('该路径不是目录。', 400, 'NOT_A_DIRECTORY');
        json(response, 200, listDirectory(claims.path, config));
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
      if (!response.headersSent) {
        json(response, appError.statusCode, {
          error: appError.code,
          message: appError.message,
          ...(appError.data ? { data: appError.data } : {}),
        });
      }
      else response.destroy();
    } finally {
      log(config, 'debug', `${request.method} ${pathname}`, `${Date.now() - startedAt}ms`);
    }
  });

  return { server, config, bridge, tracker, hub, dingtalk, skillMarket, threadActivity, conversationArtifacts };
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
