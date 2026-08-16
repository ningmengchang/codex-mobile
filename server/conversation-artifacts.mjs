import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileMetadata, IGNORED_DIRECTORIES, isDocumentPath } from './files.mjs';
import { assertAllowedPath, createArtifactToken, isInside } from './security.mjs';

const NOISE_EXTENSIONS = new Set([
  '.db', '.lock', '.log', '.shm', '.sqlite', '.sqlite3', '.swp', '.tmp', '.wal',
]);
const NOISE_NAMES = new Set(['desktop.ini', 'thumbs.db']);
const MAX_REFERENCED_DOCUMENTS = 2_000;
const MAX_DIRECTORY_DOCUMENTS = 500;
const MAX_DIRECTORY_DEPTH = 6;
const MAX_DIRECTORY_VISITS = 8_000;
const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 200;

export function isArtifactPathVisible(relativePath) {
  const segments = String(relativePath ?? '').split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => segment.startsWith('.') || IGNORED_DIRECTORIES.has(segment))) return false;
  const name = segments.at(-1).toLowerCase();
  if (NOISE_NAMES.has(name) || name.startsWith('~$')) return false;
  return !NOISE_EXTENSIONS.has(path.extname(name));
}

function trustedRolloutPath(thread, config) {
  if (typeof thread?.path !== 'string' || !thread.path) return null;
  try {
    const sessionsRoot = fs.realpathSync(path.join(config.codexHome, 'sessions'));
    const filePath = fs.realpathSync(thread.path);
    if (!isInside(sessionsRoot, filePath) || path.extname(filePath) !== '.jsonl') return null;
    if (!fs.statSync(filePath).isFile()) return null;
    return filePath;
  } catch {
    return null;
  }
}

function assistantMessageText(record) {
  const payload = record?.payload ?? {};
  if (record?.type === 'event_msg' && payload.type === 'task_complete') {
    return typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
  }
  if (record?.type === 'event_msg' && payload.type === 'agent_message') {
    return typeof payload.message === 'string' ? payload.message : '';
  }
  if (record?.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item ?? {};
    if (!['AgentMessage', 'agentMessage'].includes(item.type)) return '';
    if (typeof item.text === 'string') return item.text;
    return (Array.isArray(item.content) ? item.content : []).map((part) => part?.text ?? '').join('\n');
  }
  if (record?.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return (Array.isArray(payload.content) ? payload.content : []).map((part) => part?.text ?? '').join('\n');
  }
  return '';
}

function addReference(references, value) {
  const candidate = String(value ?? '').trim();
  if (candidate) references.add(candidate);
}

function collectReferences(text, references) {
  for (const match of String(text).matchAll(/\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    addReference(references, match[1].replace(/^<|>$/g, ''));
  }
  for (const match of String(text).matchAll(/`([^`\n]+)`/g)) {
    if (match[1].includes('/') || match[1].startsWith('file:')) addReference(references, match[1]);
  }
  for (const match of String(text).matchAll(/(?:file:\/\/)?\/(?:home|opt|srv|var)\/[^\s<>"'`)\]]+/g)) {
    addReference(references, match[0]);
  }
}

function processLine(entry, line) {
  if (!line.includes('agent_message') && !line.includes('AgentMessage')
      && !line.includes('last_agent_message') && !line.includes('"role":"assistant"')) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const text = assistantMessageText(record);
  if (text) {
    const previousSize = entry.references.size;
    collectReferences(text, entry.references);
    if (entry.references.size !== previousSize) {
      entry.referencesVersion += 1;
      entry.documentPathsCache = null;
    }
  }
}

function resetEntry(entry, stat) {
  entry.offset = 0;
  entry.remainder = '';
  entry.device = stat.dev;
  entry.inode = stat.ino;
  entry.references.clear();
  entry.referencesVersion += 1;
  entry.documentPathsCache = null;
}

async function syncEntry(entry, filePath) {
  const stat = await fs.promises.stat(filePath);
  if (entry.device !== stat.dev || entry.inode !== stat.ino || stat.size < entry.offset) resetEntry(entry, stat);
  if (stat.size === entry.offset) return;
  const stream = fs.createReadStream(filePath, {
    start: entry.offset,
    end: stat.size - 1,
    encoding: 'utf8',
    highWaterMark: 256 * 1024,
  });
  let buffer = entry.remainder;
  for await (const chunk of stream) {
    buffer += chunk;
    let start = 0;
    while (true) {
      const newline = buffer.indexOf('\n', start);
      if (newline < 0) break;
      processLine(entry, buffer.slice(start, newline));
      start = newline + 1;
    }
    buffer = buffer.slice(start);
  }
  entry.remainder = buffer;
  entry.offset = stat.size;
}

function decodedReference(raw) {
  let value = String(raw ?? '').trim().replace(/[，。；,;]+$/g, '');
  if (!value || /^(?:https?:|mailto:|tel:|data:|blob:)/i.test(value)) return null;
  if (value.startsWith('file:')) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  try { value = decodeURIComponent(value); } catch {}
  value = value.split('#', 1)[0].split('?', 1)[0];
  return value || null;
}

function resolveReference(raw, cwd, config) {
  const decoded = decodedReference(raw);
  if (!decoded) return null;
  const initial = path.isAbsolute(decoded) ? decoded : path.resolve(cwd, decoded);
  const candidates = [initial];
  const withoutPosition = initial.replace(/:(\d+)(?::\d+)?$/, '');
  if (withoutPosition !== initial) candidates.push(withoutPosition);
  for (const candidate of candidates) {
    try {
      const filePath = assertAllowedPath(candidate, config.allowedRoots);
      if (!isInside(cwd, filePath)) continue;
      const stat = fs.statSync(filePath);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      const relativePath = path.relative(cwd, filePath) || path.basename(filePath);
      if (!isArtifactPathVisible(relativePath)) continue;
      return filePath;
    } catch {}
  }
  return null;
}

function collectDirectoryDocuments(directory, cwd) {
  if (directory === cwd) return [];
  const documents = [];
  const queue = [{ directory, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_DIRECTORY_VISITS && documents.length < MAX_DIRECTORY_DOCUMENTS) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_DIRECTORY_VISITS || documents.length >= MAX_DIRECTORY_DOCUMENTS) break;
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(current.directory, entry.name);
      if (!isInside(cwd, candidate)) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_DIRECTORY_DEPTH) queue.push({ directory: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !isDocumentPath(candidate)) continue;
      const relativePath = path.relative(cwd, candidate);
      if (isArtifactPathVisible(relativePath)) documents.push(candidate);
    }
  }
  return documents;
}

function referencedDocuments(resolved, cwd) {
  let stat;
  try { stat = fs.statSync(resolved); } catch { return []; }
  if (stat.isFile()) return isDocumentPath(resolved) ? [resolved] : [];
  if (stat.isDirectory()) return collectDirectoryDocuments(resolved, cwd);
  return [];
}

function loadPersistentCache(cachePath) {
  if (!cachePath) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return new Map();
    return new Map(parsed.entries
      .filter((entry) => typeof entry?.filePath === 'string')
      .map((entry) => [entry.filePath, entry]));
  } catch {
    return new Map();
  }
}

function contextForThread(thread, config, cache, persisted) {
  const filePath = trustedRolloutPath(thread, config);
  if (!filePath || !thread?.id || !thread?.cwd) return null;
  let cwd;
  try {
    cwd = assertAllowedPath(thread.cwd, config.allowedRoots);
    if (!fs.statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  let entry = cache.get(filePath);
  if (!entry) {
    const stat = fs.statSync(filePath);
    const saved = persisted.get(filePath);
    const validSaved = saved
      && saved.device === stat.dev
      && saved.inode === stat.ino
      && Number.isFinite(saved.offset)
      && saved.offset >= 0
      && saved.offset <= stat.size
      && !(saved.offset === stat.size && saved.mtimeMs !== stat.mtimeMs);
    entry = {
      offset: validSaved ? saved.offset : 0,
      remainder: '',
      device: stat.dev,
      inode: stat.ino,
      references: new Set(validSaved && Array.isArray(saved.references) ? saved.references : []),
      referencesVersion: validSaved ? 1 : 0,
      documentPathsCache: null,
      loading: Promise.resolve(),
      pending: false,
      watchers: new Set(),
      updatedAt: validSaved ? saved.updatedAt ?? 0 : 0,
    };
    cache.set(filePath, entry);
  }
  return { thread, filePath, cwd, entry };
}

function needsSync(entry, filePath) {
  if (entry.pending) return true;
  try {
    const stat = fs.statSync(filePath);
    return entry.device !== stat.dev || entry.inode !== stat.ino || entry.offset !== stat.size;
  } catch {
    return false;
  }
}

function documentPaths(entry, cwd, config) {
  const cached = entry.documentPathsCache;
  if (cached?.cwd === cwd && cached.referencesVersion === entry.referencesVersion) return cached.paths;
  const unique = new Set();
  for (const reference of entry.references) {
    const resolved = resolveReference(reference, cwd, config);
    if (!resolved) continue;
    for (const documentPath of referencedDocuments(resolved, cwd)) {
      unique.add(documentPath);
      if (unique.size >= MAX_REFERENCED_DOCUMENTS) break;
    }
    if (unique.size >= MAX_REFERENCED_DOCUMENTS) break;
  }
  const paths = [...unique];
  entry.documentPathsCache = { cwd, referencesVersion: entry.referencesVersion, paths };
  return paths;
}

function materializeDocuments(context, config) {
  const { thread, cwd, entry } = context;
  const items = [];
  for (const resolved of documentPaths(entry, cwd, config)) {
    try {
      const metadata = fileMetadata(resolved, cwd);
      items.push({
        id: `conversation:${thread.id}:${metadata.relativePath}`,
        threadId: thread.id,
        turnId: null,
        projectPath: cwd,
        source: 'conversation',
        status: 'linked',
        capturedAt: metadata.modifiedAt,
        ...metadata,
        available: true,
        token: createArtifactToken(resolved, config),
      });
    } catch {}
  }
  return items.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

export function createConversationArtifacts(config, options = {}) {
  const cache = new Map();
  const cachePath = config.dataDir ? path.join(config.dataDir, 'conversation-artifacts-cache.json') : null;
  const persisted = loadPersistentCache(cachePath);
  let persistQueue = Promise.resolve();

  function persistEntry(filePath, entry) {
    if (!cachePath) return Promise.resolve();
    let stat;
    try { stat = fs.statSync(filePath); } catch { return Promise.resolve(); }
    const remainderBytes = Buffer.byteLength(entry.remainder, 'utf8');
    persisted.set(filePath, {
      filePath,
      device: entry.device,
      inode: entry.inode,
      offset: Math.max(0, entry.offset - remainderBytes),
      mtimeMs: stat.mtimeMs,
      references: [...entry.references],
      updatedAt: Date.now(),
    });
    const entries = [...persisted.values()]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_CACHE_ENTRIES);
    persisted.clear();
    for (const item of entries) persisted.set(item.filePath, item);
    persistQueue = persistQueue.then(async () => {
      const temp = `${cachePath}.tmp`;
      await fs.promises.writeFile(temp, `${JSON.stringify({ version: CACHE_VERSION, entries })}\n`, { mode: 0o600 });
      await fs.promises.rename(temp, cachePath);
    }).catch(() => {});
    return persistQueue;
  }

  function scheduleSync(context) {
    const { thread, filePath, entry } = context;
    entry.watchers.add(thread.id);
    if (entry.pending) return entry.loading;
    entry.pending = true;
    entry.loading = (async () => {
      await syncEntry(entry, filePath);
      entry.updatedAt = Date.now();
      await persistEntry(filePath, entry);
    })().catch((error) => {
      options.onError?.({ threadId: thread.id, error });
    }).finally(() => {
      entry.pending = false;
      const watchers = [...entry.watchers];
      entry.watchers.clear();
      for (const threadId of watchers) options.onReady?.({ threadId });
    });
    return entry.loading;
  }

  async function list(thread) {
    const context = contextForThread(thread, config, cache, persisted);
    if (!context) return [];
    if (needsSync(context.entry, context.filePath)) await scheduleSync(context);
    else if (context.entry.pending) await context.entry.loading;
    return materializeDocuments(context, config);
  }

  function snapshot(thread) {
    const context = contextForThread(thread, config, cache, persisted);
    if (!context) return { items: [], pending: false };
    const pending = needsSync(context.entry, context.filePath);
    if (pending) void scheduleSync(context);
    return { items: materializeDocuments(context, config), pending };
  }

  return {
    list,
    snapshot,
    clear() {
      cache.clear();
      persisted.clear();
    },
  };
}
