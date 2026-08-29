import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppServerBridge, approvalResponse } from './app-server.mjs';
import { ArtifactTracker } from './artifacts.mjs';
import { createCodexBackendManager } from './codex-backends.mjs';
import { createConversationArtifacts } from './conversation-artifacts.mjs';
import { clearSessionCookie, COOKIE_NAME, exchangePairingCode, requireSession, sessionCookie } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { convertOfficeToPdf, getPdfPageCount, renderPdfPage } from './convert.mjs';
import { createDingTalk } from './dingtalk.mjs';
import { EventHub } from './events.mjs';
import { createFavoritesStore } from './favorites.mjs';
import { classifyFile, fileMetadata, isDocumentPath, mimeType } from './files.mjs';
import { buildHandoffPackage, readGitSnapshot } from './handoff-package.mjs';
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
  ['/js/turn-state.js', ['js/turn-state.js', 'text/javascript; charset=utf-8']],
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
const THREAD_COPY_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const THREAD_COPY_RESULT_TTL_MS = 10 * 60 * 1000;
const EXECUTE_MODE_INSTRUCTIONS = '执行模式：直接实施用户的请求，不要先输出完整方案或规划；除非用户明确要求方案/设计/规划，才先设计方案。';
const PLAN_MODE_INSTRUCTIONS = [
  '规划模式交互规则：先通过只读检查解决可发现的问题，只询问会实质改变方案且无法从上下文推断的决策。',
  '每个用户回合最多调用一次 request_user_input，并把最多三个最关键的问题集中在同一张交互卡片中；不要把实现细节拆成连续多轮卡片。',
  '用户提交回答后，直接形成完整方案。其余未确认细节采用推荐默认值，并在方案中明确记录假设；同一用户回合不得再次调用 request_user_input。',
].join('\n');

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

function favoriteInput(value, config, backend = 'gpt') {
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
    backend,
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

function isActiveWriter(error) {
  return String(error?.message ?? '').includes('already has an active writer');
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

function uniqueTurns(turns) {
  const seen = new Set();
  return (Array.isArray(turns) ? turns : []).filter((turn) => {
    const id = String(turn?.id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function hasHandoffItems(turns) {
  const allowed = new Set(['usermessage', 'agentmessage', 'plan', 'structuredplan']);
  return turns.some((turn) => (turn?.items ?? []).some((item) => allowed.has(String(item?.type ?? '').toLowerCase())));
}

async function handoffTurns(bridge, rolloutHistory, thread, recentTurns) {
  try {
    const [oldest, latest] = await Promise.all([
      bridge.request('thread/turns/list', {
        threadId: thread.id,
        pageSize: 1,
        sortDirection: 'asc',
        itemsView: 'full',
      }),
      bridge.request('thread/turns/list', {
        threadId: thread.id,
        pageSize: Math.min(Math.max(recentTurns, 1), 50),
        sortDirection: 'desc',
        itemsView: 'full',
      }),
    ]);
    const latestChronological = [...(latest?.data ?? [])].reverse();
    const nativeTurns = uniqueTurns([...(oldest?.data ?? []), ...latestChronological]);
    if (nativeTurns.length && hasHandoffItems(nativeTurns)) return nativeTurns;
  } catch {}
  return rolloutHistory.readTurns(thread);
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
        developer_instructions: executionMode ? EXECUTE_MODE_INSTRUCTIONS : PLAN_MODE_INSTRUCTIONS,
      },
    },
    sandboxPolicy: mode === 'plan'
      ? { type: 'readOnly', networkAccess: false }
      : approvalsReviewer === 'never'
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
  };
}

function wireBridge(bridge, tracker, threadActivity, hub, config, lifecycle = {}) {
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
      lifecycle.onTurnStarted?.(threadId, turnId);
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
        .catch((error) => hub.publish('artifact-error', { message: error.message }))
        .finally(() => lifecycle.onTurnCompleted?.(threadId, turnId));
    }
    if (message.method === 'thread/closed') {
      lifecycle.onThreadClosed?.(params.threadId ?? params.thread_id ?? params.thread?.id);
    }
    hub.publish('codex', message);
  });
}

export function createCodexMobileServer(options = {}) {
  const config = options.config ?? loadConfig(options.configOverrides);
  const hub = options.hub ?? new EventHub();
  const backendManager = options.backendManager ?? createCodexBackendManager(config);
  const bridge = options.bridge ?? new AppServerBridge(config);
  const tracker = options.tracker ?? new ArtifactTracker(config, hub);
  const dingtalk = options.dingtalk ?? createDingTalk();
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
  const handoffTools = {
    readGitSnapshot: options.readGitSnapshot ?? readGitSnapshot,
  };
  const pairingAttempts = [];
  const catalogs = {
    account: null,
    models: [],
    collaborationModes: [],
    refreshedAt: 0,
    refreshPromise: null,
    generation: 0,
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
    const generation = catalogs.generation;
    const refresh = Promise.all([
      bridge.request('account/read', { refreshToken: false }).catch((error) => ({ error: error.message })),
      bridge.request('model/list', { limit: 100, includeHidden: false }).catch(() => ({ data: [] })),
      bridge.request('collaborationMode/list', {}).catch(() => ({ data: [] })),
    ]).then(([account, models, collaborationModes]) => {
      if (generation !== catalogs.generation) return catalogPayload();
      catalogs.account = account;
      catalogs.models = models?.data ?? [];
      catalogs.collaborationModes = collaborationModes?.data ?? [];
      catalogs.refreshedAt = Date.now();
      return catalogPayload();
    }).finally(() => {
      if (catalogs.refreshPromise === refresh) catalogs.refreshPromise = null;
    });
    catalogs.refreshPromise = refresh;
    return refresh;
  };
  const clearCatalogs = () => {
    catalogs.generation += 1;
    catalogs.account = null;
    catalogs.models = [];
    catalogs.collaborationModes = [];
    catalogs.refreshedAt = 0;
    catalogs.refreshPromise = null;
  };
  const attachedThreads = new Set();
  const attachingThreads = new Map();
  const releasingThreads = new Map();
  const activeWriterTurns = new Set();
  let startingWriterTurns = 0;
  const writerRecycleDelayMs = Math.max(0, options.writerRecycleDelayMs ?? 250);
  let writerRecycleTimer = null;
  let writerRecyclePromise = null;
  const cancelWriterRecycle = () => {
    if (!writerRecycleTimer) return;
    clearTimeout(writerRecycleTimer);
    writerRecycleTimer = null;
  };
  const clearAttachedThreads = () => {
    attachedThreads.clear();
    attachingThreads.clear();
    releasingThreads.clear();
  };
  const writerLifecycleIdle = () => activeWriterTurns.size === 0
    && startingWriterTurns === 0
    && (bridge.getServerRequests?.().length ?? 0) === 0;
  const recycleWriterProcess = async () => {
    if (!writerLifecycleIdle() || writerRecyclePromise) return;
    if (typeof bridge.restart !== 'function') return;
    writerRecyclePromise = bridge.restart()
      .catch((error) => {
        log(config, 'error', 'unable to recycle idle App Server writer', error.stack ?? error.message);
        hub.publish('bridge-error', { message: `会话 writer 释放失败：${error.message}` });
      })
      .finally(() => { writerRecyclePromise = null; });
    await writerRecyclePromise;
  };
  const scheduleWriterRecycle = () => {
    cancelWriterRecycle();
    if (!writerLifecycleIdle()) return;
    writerRecycleTimer = setTimeout(() => {
      writerRecycleTimer = null;
      recycleWriterProcess();
    }, writerRecycleDelayMs);
    writerRecycleTimer.unref?.();
  };
  const releaseThread = (threadId) => {
    const id = String(threadId ?? '');
    if (!id) return Promise.resolve();
    const existing = releasingThreads.get(id);
    if (existing) return existing;
    const pending = bridge.request('thread/unsubscribe', { threadId: id })
      .catch((error) => {
        const message = String(error?.message ?? '').toLowerCase();
        if (!message.includes('not loaded') && !message.includes('not subscribed')) {
          log(config, 'debug', `unable to unsubscribe thread ${id}`, error.message);
        }
      })
      .finally(() => {
        attachedThreads.delete(id);
        if (releasingThreads.get(id) === pending) releasingThreads.delete(id);
        scheduleWriterRecycle();
      });
    releasingThreads.set(id, pending);
    return pending;
  };
  const attachThread = async (threadId, params = {}) => {
    const id = String(threadId);
    cancelWriterRecycle();
    if (writerRecyclePromise) await writerRecyclePromise;
    const releasing = releasingThreads.get(id);
    if (releasing) await releasing;
    if (attachedThreads.has(id)) return Promise.resolve(null);
    const existing = attachingThreads.get(id);
    if (existing) return existing;
    const pending = bridge.request('thread/resume', {
      threadId: id,
      developerInstructions: OWNER_INSTRUCTIONS,
      ...params,
    }).then((result) => {
      attachedThreads.add(id);
      if (result?.thread?.id) attachedThreads.add(result.thread.id);
      return result;
    }).finally(() => {
      if (attachingThreads.get(id) === pending) attachingThreads.delete(id);
    });
    attachingThreads.set(id, pending);
    return pending;
  };
  if (typeof bridge.on === 'function') {
    bridge.on('status', (status) => {
      if (status?.ready === false) clearAttachedThreads();
    });
  }
  const writerLifecycle = {
    onTurnStarted(threadId) {
      if (threadId) activeWriterTurns.add(String(threadId));
    },
    onTurnCompleted(threadId) {
      if (!threadId) return;
      activeWriterTurns.delete(String(threadId));
      releaseThread(threadId);
    },
    onThreadClosed(threadId) {
      if (!threadId) return;
      const id = String(threadId);
      attachedThreads.delete(id);
      attachingThreads.delete(id);
      releasingThreads.delete(id);
      activeWriterTurns.delete(id);
    },
  };
  const threadMeta = new Map();
  const threadCopyRequests = new Map();
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
  const latestThreadTurn = async (threadId) => {
    const result = await bridge.request('thread/turns/list', {
      threadId,
      pageSize: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    return result?.data?.[0] ?? null;
  };
  const cleanupCopyRequests = (now = Date.now()) => {
    for (const [key, value] of threadCopyRequests) {
      if (value.expiresAt <= now) threadCopyRequests.delete(key);
    }
  };
  const copiedThreadAppearsInDirectory = async (threadId, cwd) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const page = await listThreads(bridge, config, { cwd, limit: 100 });
      if (page.data.some((thread) => thread.id === threadId)) return true;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    }
    return false;
  };
  const copyThreadToDirectory = async (sourceThreadId, body) => {
    const targetCwd = validateProject(body.cwd, config);
    const publishProgress = (stage, label) => hub.publish('thread-copy-progress', {
      requestId: body.requestId,
      sourceThreadId,
      stage,
      label,
    });
    cancelWriterRecycle();
    if (writerRecyclePromise) await writerRecyclePromise;
    startingWriterTurns += 1;
    let copiedThreadId = null;
    try {
      publishProgress('reading', '正在读取源会话历史');
      const source = await bridge.request('thread/read', { threadId: sourceThreadId, includeTurns: false });
      if (!threadAllowed(source.thread, config)) {
        throw new AppError('源会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
      }
      const activity = threadActivity.get(sourceThreadId);
      if (['running', 'planning', 'waiting'].includes(activity.status)) {
        throw new AppError('当前会话仍在执行或等待确认，请在任务结束后再复制。', 409, 'THREAD_COPY_BUSY');
      }
      const sourceName = String(source.thread?.name ?? source.thread?.preview ?? '未命名会话').trim() || '未命名会话';
      const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
      const copyName = requestedName || `${sourceName}（副本）`;
      if (copyName.length > 100) throw new AppError('副本名称过长。', 400, 'NAME_TOO_LONG');
      const sourceLatestTurn = await latestThreadTurn(sourceThreadId);
      publishProgress('forking', '正在创建完整会话副本');
      const forked = await bridge.request('thread/fork', {
        threadId: sourceThreadId,
        cwd: targetCwd,
        runtimeWorkspaceRoots: [targetCwd],
        developerInstructions: OWNER_INSTRUCTIONS,
        excludeTurns: true,
        deferGoalContinuation: true,
      });
      copiedThreadId = forked?.thread?.id;
      if (!copiedThreadId || copiedThreadId === sourceThreadId) {
        throw new AppError('Codex 没有返回有效的副本会话。', 502, 'THREAD_COPY_INVALID');
      }
      attachedThreads.add(copiedThreadId);
      publishProgress('naming', '正在写入副本名称和目标目录');
      const named = await bridge.request('thread/name/set', { threadId: copiedThreadId, name: copyName });
      const copied = await bridge.request('thread/read', { threadId: copiedThreadId, includeTurns: false });
      const copiedCwd = validateProject(copied.thread?.cwd, config);
      if (copiedCwd !== targetCwd) {
        throw new AppError('副本目录校验失败，Codex 返回了错误的工作目录。', 502, 'THREAD_COPY_CWD_MISMATCH');
      }
      publishProgress('history', '正在校验会话历史完整性');
      const copiedLatestTurn = await latestThreadTurn(copiedThreadId);
      if (sourceLatestTurn && copiedLatestTurn?.id !== sourceLatestTurn.id) {
        throw new AppError('副本历史校验失败，最新回合不完整。', 502, 'THREAD_COPY_HISTORY_MISMATCH');
      }
      publishProgress('directory', '正在校验目标目录索引');
      if (!await copiedThreadAppearsInDirectory(copiedThreadId, targetCwd)) {
        throw new AppError('副本目录索引校验失败，目标目录中无法找到新会话。', 502, 'THREAD_COPY_NOT_LISTED');
      }
      const verifiedThread = {
        ...(forked.thread ?? {}),
        ...(named?.thread ?? {}),
        ...(copied.thread ?? {}),
        id: copiedThreadId,
        name: copyName,
        cwd: targetCwd,
      };
      rememberThread(verifiedThread, targetCwd);
      tracker.registerThread(copiedThreadId, targetCwd);
      await releaseThread(copiedThreadId);
      publishProgress('completed', '复制完成，正在打开副本');
      return {
        copied: true,
        sourceThreadId,
        thread: threadActivity.attach(verifiedThread),
      };
    } catch (error) {
      publishProgress('failed', `复制失败：${error.message}`);
      if (copiedThreadId) {
        await bridge.request('thread/unsubscribe', { threadId: copiedThreadId }).catch(() => null);
        attachedThreads.delete(copiedThreadId);
        attachingThreads.delete(copiedThreadId);
        releasingThreads.delete(copiedThreadId);
        await bridge.request('thread/delete', { threadId: copiedThreadId }).catch((cleanupError) => {
          log(config, 'error', `unable to clean incomplete thread copy ${copiedThreadId}`, cleanupError.message);
        });
      }
      if (isActiveWriter(error)) {
        throw new AppError(
          '源会话正在终端或另一个 Codex 进程中使用，请退出占用进程后再复制。',
          409,
          'THREAD_ACTIVE_WRITER',
        );
      }
      throw error;
    } finally {
      startingWriterTurns = Math.max(0, startingWriterTurns - 1);
      if (copiedThreadId && writerLifecycleIdle()) scheduleWriterRecycle();
    }
  };
  const activeFavorites = () => favorites.list(backendManager.activeId());
  const publishFavorites = (data = activeFavorites()) => {
    hub.publish('favorites', { data });
    return data;
  };
  let backendSwitchPromise = null;
  const switchCodexBackend = async (id, { force = false } = {}) => {
    const target = backendManager.get(id);
    if (!target) throw new AppError('没有找到这个 Agent。', 404, 'BACKEND_NOT_FOUND');
    if (!target.available) throw new AppError(`${target.label} 当前不可用。`, 503, 'BACKEND_UNAVAILABLE');
    if (target.id === backendManager.activeId()) {
      return { backends: backendManager.payload(), ...catalogPayload(), appServer: bridge.status() };
    }
    if (backendSwitchPromise) throw new AppError('Agent 正在切换，请稍候。', 409, 'BACKEND_SWITCHING');
    const activeActivities = threadActivity.list()
      .filter((activity) => ['running', 'planning', 'waiting'].includes(activity.status));
    if (activeActivities.length && !force) {
      const error = new AppError('仍有会话正在执行或等待确认，切换会中断这些任务。', 409, 'BACKEND_BUSY');
      error.data = { activeThreads: activeActivities.map((activity) => activity.threadId) };
      throw error;
    }
    const previousId = backendManager.activeId();
    const previousRuntime = backendManager.runtime(previousId);
    const nextRuntime = backendManager.runtime(target.id);
    backendSwitchPromise = (async () => {
      await tracker.finishAll();
      try {
        if (typeof bridge.reconfigure !== 'function') throw new Error('当前 App Server 不支持运行时切换。');
        clearAttachedThreads();
        await bridge.reconfigure(nextRuntime);
        backendManager.apply(target.id);
      } catch (error) {
        try {
          await bridge.reconfigure(previousRuntime);
          backendManager.apply(previousId, { persist: false });
        } catch (rollbackError) {
          log(config, 'error', 'unable to roll back Codex backend', rollbackError.stack ?? rollbackError.message);
        }
        throw new AppError(`切换到 ${target.label} 失败：${error.message}`, 502, 'BACKEND_SWITCH_FAILED');
      }
      for (const activity of activeActivities) {
        threadActivity.complete(activity.threadId, activity.activeTurnId, 'interrupted');
      }
      threadActivity.syncRequests([]);
      threadMeta.clear();
      rolloutHistory.clear?.();
      conversationArtifacts.clear?.();
      clearCatalogs();
      const payload = { backends: backendManager.payload(), active: target.id };
      hub.publish('backend-changed', payload);
      publishFavorites();
      const refreshed = await refreshCatalogs(true);
      return { ...payload, ...refreshed, appServer: bridge.status() };
    })().finally(() => { backendSwitchPromise = null; });
    return backendSwitchPromise;
  };
  if (typeof bridge.on === 'function') wireBridge(bridge, tracker, threadActivity, hub, config, writerLifecycle);

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    let pathname = '/';
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      pathname = url.pathname;
      if ((request.method === 'GET' || request.method === 'HEAD') && serveStatic(request, response, pathname)) return;
      if (request.method === 'GET' && pathname === '/healthz') {
        json(response, 200, { status: 'ok', appServer: bridge.status(), backend: backendManager.activeId() });
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

      if (request.method === 'GET' && pathname === '/api/runtime/backends') {
        json(response, 200, backendManager.payload());
        return;
      }
      if (request.method === 'POST' && pathname === '/api/runtime/backend') {
        const body = await readBody(request, config.maxBodyBytes);
        json(response, 200, await switchCodexBackend(body.id, { force: body.force === true }));
        return;
      }

      if (request.method === 'GET' && pathname === '/api/favorites') {
        json(response, 200, { data: activeFavorites() });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/favorites/import') {
        const body = await readBody(request, config.maxBodyBytes);
        if (!Array.isArray(body.items)) throw new AppError('收藏列表格式不正确。', 400, 'INVALID_FAVORITES');
        const imported = [];
        for (const item of body.items.slice(0, 50)) {
          try { imported.push(favoriteInput(item, config, backendManager.activeId())); } catch (error) {
            if (!(error instanceof AppError)) throw error;
          }
        }
        favorites.import(imported);
        json(response, 200, { data: publishFavorites() });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/favorites') {
        const body = await readBody(request, config.maxBodyBytes);
        favorites.upsert(favoriteInput(body, config, backendManager.activeId()));
        json(response, 200, { data: publishFavorites() });
        return;
      }
      const favoriteMatch = routeMatch(pathname, /^\/api\/favorites\/([^/]+)$/);
      if (request.method === 'DELETE' && favoriteMatch) {
        favorites.remove(favoriteMatch[0], backendManager.activeId());
        json(response, 200, { data: publishFavorites() });
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
      if (request.method === 'GET' && pathname === '/api/account/status') {
        const accountResult = await bridge.request('account/read', { refreshToken: false })
          .catch((error) => ({ account: null, error: error.message }));
        const rateLimitResult = await bridge.request('account/rateLimits/read')
          .catch((error) => ({ rateLimits: null, rateLimitsByLimitId: null, error: error.message }));
        const rateLimits = rateLimitResult?.rateLimits ?? null;
        const rateLimitsByLimitId = rateLimitResult?.rateLimitsByLimitId ?? null;
        const available = Boolean(rateLimits || (rateLimitsByLimitId && Object.keys(rateLimitsByLimitId).length));
        json(response, 200, {
          backend: backendManager.activeId(),
          account: accountResult?.account ?? null,
          requiresOpenaiAuth: accountResult?.requiresOpenaiAuth ?? null,
          available,
          rateLimits,
          rateLimitsByLimitId,
          rateLimitResetCredits: rateLimitResult?.rateLimitResetCredits ?? null,
          message: available ? null : (rateLimitResult?.error || accountResult?.error || '当前 Agent 没有可用的额度数据。'),
        });
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
          favorites: activeFavorites(),
          backends: backendManager.payload(),
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
        attachedThreads.add(result.thread.id);
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
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/copy$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        if (!THREAD_COPY_REQUEST_ID.test(requestId)) {
          throw new AppError('复制请求标识无效。', 400, 'THREAD_COPY_REQUEST_ID_INVALID');
        }
        cleanupCopyRequests();
        const copyKey = `${backendManager.activeId()}:${match[0]}:${requestId}`;
        let entry = threadCopyRequests.get(copyKey);
        const replayed = Boolean(entry);
        if (!entry) {
          const promise = copyThreadToDirectory(match[0], body);
          entry = { promise, expiresAt: Date.now() + THREAD_COPY_RESULT_TTL_MS };
          threadCopyRequests.set(copyKey, entry);
        }
        try {
          const result = await entry.promise;
          json(response, replayed ? 200 : 201, { ...result, replayed });
        } catch (error) {
          if (threadCopyRequests.get(copyKey) === entry) threadCopyRequests.delete(copyKey);
          throw error;
        }
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/name$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request, config.maxBodyBytes);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new AppError('会话名称不能为空。', 400, 'NAME_REQUIRED');
        if (name.length > 100) throw new AppError('会话名称过长。', 400, 'NAME_TOO_LONG');
        const result = await bridge.request('thread/name/set', { threadId: match[0], name });
        if (activeFavorites().some((item) => item.id === match[0])) {
          favorites.rename(match[0], name, backendManager.activeId());
          publishFavorites();
        }
        json(response, 200, { ...result, thread: threadActivity.attach(result.thread) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/delete$/);
      if (request.method === 'POST' && match) {
        const result = await bridge.request('thread/delete', { threadId: match[0] });
        attachedThreads.delete(match[0]);
        attachingThreads.delete(match[0]);
        threadMeta.delete(match[0]);
        threadActivity.remove(match[0]);
        if (activeFavorites().some((item) => item.id === match[0])) {
          favorites.remove(match[0], backendManager.activeId());
          publishFavorites();
        }
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
        const result = await bridge.request('thread/read', { threadId: match[0], includeTurns: false });
        if (!threadAllowed(result.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
        const cwd = result.cwd ?? result.thread.cwd;
        tracker.registerThread(result.thread.id, cwd);
        rememberThread(result.thread, cwd);
        json(response, 200, { ...result, readOnly: true, thread: threadActivity.attach(result.thread) });
        return;
      }
      match = routeMatch(pathname, /^\/api\/threads\/([^/]+)\/handoff$/);
      if (request.method === 'GET' && match) {
        const result = await bridge.request('thread/read', { threadId: match[0], includeTurns: false });
        if (!threadAllowed(result.thread, config)) throw new AppError('会话不在允许的项目目录中。', 403, 'THREAD_NOT_ALLOWED');
        const cwd = result.cwd ?? result.thread.cwd;
        rememberThread(result.thread, cwd);
        const meta = threadMeta.get(result.thread.id) ?? result.thread;
        const turns = await handoffTurns(bridge, rolloutHistory, { ...result.thread, ...meta, cwd }, config.handoffRecentTurns);
        const recovered = meta?.path
          ? conversationArtifacts.snapshot?.({ id: result.thread.id, ...meta, cwd })?.items ?? []
          : [];
        const artifacts = [...tracker.list(result.thread.id), ...recovered]
          .sort((left, right) => {
            const leftTime = Date.parse(left.modifiedAt ?? left.capturedAt ?? '') || 0;
            const rightTime = Date.parse(right.modifiedAt ?? right.capturedAt ?? '') || 0;
            return rightTime - leftTime;
          });
        const backendId = backendManager.activeId();
        const backend = backendManager.get(backendId);
        const payload = buildHandoffPackage({
          thread: { ...result.thread, ...meta, cwd },
          turns,
          artifacts,
          activity: threadActivity.get(result.thread.id),
          sourceAgent: backend?.label ?? backendId,
          sourceAgentId: backendId,
          gitSnapshot: await handoffTools.readGitSnapshot(cwd),
          maxBytes: config.handoffMaxBytes,
          recentTurnLimit: config.handoffRecentTurns,
        });
        json(response, 200, payload);
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
        const requestedThreadId = match[0];
        cancelWriterRecycle();
        startingWriterTurns += 1;
        try {
          const body = await readBody(request, config.maxBodyBytes);
          const cwd = validateProject(body.cwd ?? threadMeta.get(requestedThreadId)?.cwd, config);
          if (!catalogs.models.length) {
            const models = await bridge.request('model/list', { limit: 100, includeHidden: false });
            catalogs.models = models?.data ?? [];
          }
          if (!catalogs.collaborationModes.length) {
            const modes = await bridge.request('collaborationMode/list', {}).catch(() => ({ data: [] }));
            catalogs.collaborationModes = modes?.data ?? [];
          }
          const settings = turnSettings(body, cwd, catalogs, config);
          let activeThreadId = requestedThreadId;
          let recreated = false;
          try {
            const resumed = await attachThread(requestedThreadId);
            if (resumed?.thread) rememberThread(resumed.thread, resumed.cwd);
            else if (resumed?.cwd) rememberThread({ id: requestedThreadId, cwd: resumed.cwd });
          } catch (error) {
            if (isActiveWriter(error)) {
              throw new AppError(
                '该会话正在终端或另一个 Codex 进程中使用。请先退出占用进程，再从手机继续。',
                409,
                'THREAD_ACTIVE_WRITER',
              );
            }
            if (isThreadGone(error)) recreated = true;
            else throw error;
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
              attachedThreads.add(activeThreadId);
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
            activeWriterTurns.add(activeThreadId);
            tracker.bindTurn(activeThreadId, result.turn.id);
            const activity = threadActivity.start(activeThreadId, result.turn.id, body.mode ?? 'default');
            json(response, 201, {
              ...result,
              thread: { id: activeThreadId, cwd, activity },
              recreated,
            });
          } catch (error) {
            activeWriterTurns.delete(activeThreadId);
            await tracker.finish(activeThreadId);
            if (attachedThreads.has(activeThreadId)) await releaseThread(activeThreadId);
            throw error;
          }
        } finally {
          startingWriterTurns = Math.max(0, startingWriterTurns - 1);
          if (writerLifecycleIdle() && releasingThreads.size > 0) scheduleWriterRecycle();
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
        activeWriterTurns.delete(match[0]);
        if (attachedThreads.has(match[0])) await releaseThread(match[0]);
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

  return {
    server, config, bridge, tracker, hub, dingtalk, skillMarket, threadActivity,
    conversationArtifacts, backendManager,
  };
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
