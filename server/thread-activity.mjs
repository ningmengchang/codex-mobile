import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_LIMIT = 2000;

function finiteTime(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeTerminalStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('interrupt') || status.includes('cancel') || status.includes('stop')) return 'interrupted';
  return 'completed';
}

function rawThreadStatus(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.type === 'string') return value.type;
  if (value && typeof value.status === 'string') return value.status;
  return '';
}

function rawThreadIsActive(thread) {
  const status = rawThreadStatus(thread?.status).toLowerCase().replaceAll('_', '');
  if (!status) return false;
  return ['active', 'running', 'inprogress', 'busy', 'working'].some((value) => status.includes(value));
}

function rawThreadIsIdle(thread) {
  const status = rawThreadStatus(thread?.status).toLowerCase().replaceAll('_', '');
  return status === 'idle' || status === 'notloaded' || status === 'completed';
}

export function requestThreadId(value) {
  const params = value?.params ?? value ?? {};
  return params.threadId
    ?? params.thread_id
    ?? params.thread?.id
    ?? params.turn?.threadId
    ?? params.turn?.thread_id
    ?? null;
}

function normalizeStoredEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.threadId !== 'string' || !value.threadId) return null;
  const status = value.status === 'running' ? 'running' : 'idle';
  const phase = value.phase === 'plan' ? 'plan' : value.phase === 'default' ? 'default' : null;
  return {
    threadId: value.threadId,
    status,
    phase,
    activeTurnId: typeof value.activeTurnId === 'string' && value.activeTurnId ? value.activeTurnId : null,
    unreadCount: Math.max(0, Number.parseInt(value.unreadCount ?? '0', 10) || 0),
    lastTerminalStatus: ['completed', 'failed', 'interrupted'].includes(value.lastTerminalStatus)
      ? value.lastTerminalStatus
      : null,
    lastCompletionTurnId: typeof value.lastCompletionTurnId === 'string' && value.lastCompletionTurnId
      ? value.lastCompletionTurnId
      : null,
    completedAt: finiteTime(value.completedAt),
    updatedAt: finiteTime(value.updatedAt, Date.now()),
  };
}

export class ThreadActivityStore {
  constructor(options) {
    this.filePath = options.filePath ?? path.join(options.dataDir, 'thread-activity.json');
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.onChange = options.onChange ?? null;
    this.entries = this.#read();
    this.attentionRequests = new Map();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const values = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
      const entries = new Map();
      for (const value of values) {
        const entry = normalizeStoredEntry(value);
        if (entry && !entries.has(entry.threadId)) entries.set(entry.threadId, entry);
      }
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return new Map();
      throw error;
    }
  }

  #entry(threadId) {
    if (typeof threadId !== 'string' || !threadId) return null;
    let entry = this.entries.get(threadId);
    if (!entry) {
      entry = {
        threadId,
        status: 'idle',
        phase: null,
        activeTurnId: null,
        unreadCount: 0,
        lastTerminalStatus: null,
        lastCompletionTurnId: null,
        completedAt: null,
        updatedAt: Date.now(),
      };
      this.entries.set(threadId, entry);
    }
    return entry;
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const data = [...this.entries.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, this.limit);
    this.entries = new Map(data.map((entry) => [entry.threadId, entry]));
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, data }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  #emit(threadId, persist = true) {
    if (persist) this.#write();
    const activity = this.get(threadId);
    if (activity) this.onChange?.(activity);
    return activity;
  }

  #attentionCount(threadId) {
    let count = 0;
    for (const value of this.attentionRequests.values()) {
      if (value === threadId) count += 1;
    }
    return count;
  }

  get(threadId) {
    const entry = this.entries.get(threadId);
    const attentionCount = this.#attentionCount(threadId);
    if (!entry && attentionCount === 0) {
      return {
        threadId,
        status: 'idle',
        phase: null,
        activeTurnId: null,
        attentionCount: 0,
        unreadCount: 0,
        lastTerminalStatus: null,
        completedAt: null,
        updatedAt: null,
      };
    }
    const phase = entry?.phase ?? null;
    let status = 'idle';
    if (attentionCount > 0) status = 'waiting';
    else if (entry?.status === 'running') status = phase === 'plan' ? 'planning' : 'running';
    else if ((entry?.unreadCount ?? 0) > 0) status = entry?.lastTerminalStatus ?? 'completed';
    return {
      threadId,
      status,
      phase,
      activeTurnId: entry?.activeTurnId ?? null,
      attentionCount,
      unreadCount: entry?.unreadCount ?? 0,
      lastTerminalStatus: entry?.lastTerminalStatus ?? null,
      completedAt: entry?.completedAt ?? null,
      updatedAt: entry?.updatedAt ?? null,
    };
  }

  list() {
    const ids = new Set([...this.entries.keys(), ...this.attentionRequests.values()]);
    return [...ids].map((threadId) => this.get(threadId));
  }

  attach(thread) {
    if (!thread?.id) return thread;
    return { ...thread, activity: this.get(thread.id) };
  }

  reconcile(thread, now = Date.now()) {
    if (!thread?.id) return thread;
    const existing = this.entries.get(thread.id);
    if (rawThreadIsActive(thread)) {
      const entry = this.#entry(thread.id);
      if (entry.status !== 'running') {
        entry.status = 'running';
        entry.updatedAt = now;
        this.#emit(thread.id);
      }
    } else if (existing?.status === 'running' && rawThreadIsIdle(thread) && now - existing.updatedAt > 3000) {
      existing.status = 'idle';
      existing.phase = null;
      existing.activeTurnId = null;
      existing.updatedAt = now;
      this.#emit(thread.id);
    }
    return this.attach(thread);
  }

  start(threadId, turnId, phase = 'default', at = Date.now()) {
    const entry = this.#entry(threadId);
    if (!entry) return null;
    entry.status = 'running';
    entry.phase = phase === 'plan' ? 'plan' : 'default';
    entry.activeTurnId = typeof turnId === 'string' && turnId ? turnId : entry.activeTurnId;
    entry.updatedAt = finiteTime(at, Date.now());
    return this.#emit(threadId);
  }

  complete(threadId, turnId, status = 'completed', at = Date.now()) {
    const entry = this.#entry(threadId);
    if (!entry) return null;
    const completionTurnId = typeof turnId === 'string' && turnId ? turnId : null;
    const duplicate = completionTurnId && entry.lastCompletionTurnId === completionTurnId;
    const nextTerminalStatus = normalizeTerminalStatus(status);
    entry.status = 'idle';
    entry.phase = null;
    entry.activeTurnId = null;
    entry.lastTerminalStatus = duplicate && entry.lastTerminalStatus && nextTerminalStatus === 'completed'
      ? entry.lastTerminalStatus
      : nextTerminalStatus;
    entry.lastCompletionTurnId = completionTurnId ?? entry.lastCompletionTurnId;
    entry.completedAt = finiteTime(at, Date.now());
    entry.updatedAt = entry.completedAt;
    if (!duplicate) entry.unreadCount += 1;
    return this.#emit(threadId);
  }

  waitForInput(request) {
    const threadId = requestThreadId(request);
    if (!threadId || !request?.id) return null;
    this.#entry(threadId);
    this.attentionRequests.set(request.id, threadId);
    return this.#emit(threadId, false);
  }

  resolveRequest(request) {
    const requestId = typeof request === 'string' ? request : request?.id;
    const threadId = requestThreadId(request) ?? this.attentionRequests.get(requestId);
    if (!requestId || !threadId) return null;
    this.attentionRequests.delete(requestId);
    return this.#emit(threadId, false);
  }

  syncRequests(requests) {
    const previousThreadIds = new Set(this.attentionRequests.values());
    this.attentionRequests.clear();
    for (const request of Array.isArray(requests) ? requests : []) {
      const threadId = requestThreadId(request);
      if (threadId && request?.id) {
        this.#entry(threadId);
        this.attentionRequests.set(request.id, threadId);
      }
    }
    const nextThreadIds = new Set(this.attentionRequests.values());
    for (const threadId of new Set([...previousThreadIds, ...nextThreadIds])) this.#emit(threadId, false);
  }

  markSeen(threadId, at = Date.now()) {
    const entry = this.entries.get(threadId);
    if (!entry || entry.unreadCount === 0) return this.get(threadId);
    entry.unreadCount = 0;
    entry.updatedAt = Math.max(entry.updatedAt, finiteTime(at, Date.now()));
    return this.#emit(threadId);
  }

  remove(threadId) {
    const changed = this.entries.delete(threadId);
    for (const [requestId, value] of this.attentionRequests) {
      if (value === threadId) this.attentionRequests.delete(requestId);
    }
    if (changed) this.#write();
  }
}

export function createThreadActivityStore(config, options = {}) {
  return new ThreadActivityStore({ dataDir: config.dataDir, ...options });
}
