import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './security.mjs';

const ROLLOUT_CURSOR = /^rollout:v1:(asc|desc):(\d+)$/;
const MAIN_ITEM_MARKERS = [
  '"item":{"type":"UserMessage"',
  '"item":{"type":"AgentMessage"',
  '"item":{"type":"Plan"',
];

function timestampSeconds(value) {
  const milliseconds = Date.parse(value ?? '');
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function normalizedContent(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => ({
      type: 'text',
      text: typeof part?.text === 'string' ? part.text : '',
      text_elements: Array.isArray(part?.text_elements) ? part.text_elements : [],
    }))
    .filter((part) => part.text);
}

function normalizeItem(item) {
  if (!item?.id) return null;
  if (item.type === 'UserMessage') {
    return { id: item.id, type: 'userMessage', content: normalizedContent(item.content) };
  }
  if (item.type === 'AgentMessage') {
    const text = normalizedContent(item.content).map((part) => part.text).join('\n');
    return { id: item.id, type: 'agentMessage', text, phase: item.phase ?? null };
  }
  if (item.type === 'Plan') {
    return { id: item.id, type: 'plan', text: typeof item.text === 'string' ? item.text : '' };
  }
  return null;
}

function resetEntry(entry, stat) {
  entry.offset = 0;
  entry.remainder = '';
  entry.device = stat.dev;
  entry.inode = stat.ino;
  entry.turns = [];
  entry.turnsById = new Map();
  entry.itemIdsByTurn = new Map();
}

function ensureTurn(entry, turnId, defaults = {}) {
  if (!turnId) return null;
  let turn = entry.turnsById.get(turnId);
  if (!turn) {
    turn = { id: turnId, status: 'inProgress', items: [], ...defaults };
    entry.turnsById.set(turnId, turn);
    entry.itemIdsByTurn.set(turnId, new Set());
    entry.turns.push(turn);
  } else {
    for (const [key, value] of Object.entries(defaults)) {
      if (value != null && turn[key] == null) turn[key] = value;
    }
  }
  return turn;
}

function processRolloutLine(entry, line) {
  if (!line.includes('"type":"event_msg"')) return;
  const taskStarted = line.includes('"type":"task_started"');
  const taskComplete = line.includes('"type":"task_complete"');
  const itemCompleted = line.includes('"type":"item_completed"')
    && MAIN_ITEM_MARKERS.some((marker) => line.includes(marker));
  if (!taskStarted && !taskComplete && !itemCompleted) return;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const payload = record.payload ?? {};
  if (payload.type === 'task_started') {
    const turn = ensureTurn(entry, payload.turn_id, {
      startedAt: payload.started_at ?? timestampSeconds(record.timestamp),
    });
    if (turn) turn.status = 'inProgress';
    return;
  }
  if (payload.type === 'task_complete') {
    const turn = ensureTurn(entry, payload.turn_id, {
      startedAt: payload.started_at ?? null,
    });
    if (!turn) return;
    turn.status = 'completed';
    turn.completedAt = payload.completed_at ?? timestampSeconds(record.timestamp);
    turn.durationMs = payload.duration_ms ?? turn.durationMs ?? null;
    return;
  }
  if (payload.type !== 'item_completed') return;
  const item = normalizeItem(payload.item);
  if (!item) return;
  const turn = ensureTurn(entry, payload.turn_id, {
    startedAt: payload.started_at_ms ? Math.floor(payload.started_at_ms / 1000) : null,
  });
  if (!turn) return;
  const itemIds = entry.itemIdsByTurn.get(turn.id);
  if (itemIds.has(item.id)) {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    return;
  }
  itemIds.add(item.id);
  turn.items.push(item);
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

async function syncEntry(entry, filePath) {
  const stat = await fs.promises.stat(filePath);
  if (entry.device !== stat.dev || entry.inode !== stat.ino || stat.size < entry.offset) {
    resetEntry(entry, stat);
  }
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
      processRolloutLine(entry, buffer.slice(start, newline));
      start = newline + 1;
    }
    buffer = buffer.slice(start);
  }
  entry.remainder = buffer;
  entry.offset = stat.size;
}

function cursorOffset(cursor, direction) {
  const match = String(cursor ?? '').match(ROLLOUT_CURSOR);
  if (!match || match[1] !== direction) return null;
  return Number.parseInt(match[2], 10);
}

function paginate(turns, pageSize, direction, offset = 0) {
  if (direction === 'asc') {
    const data = turns.slice(offset, offset + pageSize);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor: nextOffset < turns.length ? `rollout:v1:asc:${nextOffset}` : null,
      source: 'rollout',
    };
  }
  const end = Math.max(0, turns.length - offset);
  const start = Math.max(0, end - pageSize);
  const data = turns.slice(start, end).reverse();
  const nextOffset = offset + data.length;
  return {
    data,
    nextCursor: start > 0 ? `rollout:v1:desc:${nextOffset}` : null,
    source: 'rollout',
  };
}

function threadStatusType(thread) {
  const value = thread?.status;
  if (typeof value === 'string') return value;
  return typeof value?.type === 'string' ? value.type : null;
}

function reconcileIdleThread(turns, thread) {
  if (!['idle', 'notLoaded'].includes(threadStatusType(thread)) || !turns.length) return turns;
  const latest = turns.at(-1);
  if (latest?.status === 'inProgress') latest.status = 'interrupted';
  return turns;
}

function shouldUseRollout(nativeResult, turns, direction) {
  if (!turns.length) return false;
  const nativeTurns = Array.isArray(nativeResult?.data) ? nativeResult.data : [];
  if (!nativeTurns.length) return true;
  const nativeBoundary = nativeTurns[0];
  const rolloutBoundary = direction === 'asc' ? turns[0] : turns.at(-1);
  if (nativeBoundary?.id !== rolloutBoundary?.id) return true;
  if (nativeResult?.nextCursor == null && turns.length > nativeTurns.length) return true;
  if (rolloutBoundary?.status === 'completed' && nativeBoundary?.status !== 'completed') return true;
  return false;
}

export function isRolloutCursor(cursor) {
  return ROLLOUT_CURSOR.test(String(cursor ?? ''));
}

export function createRolloutHistory(config) {
  const cache = new Map();

  async function readTurns(thread) {
    const filePath = trustedRolloutPath(thread, config);
    if (!filePath) return [];
    let entry = cache.get(filePath);
    if (!entry) {
      entry = {
        offset: 0,
        remainder: '',
        device: null,
        inode: null,
        turns: [],
        turnsById: new Map(),
        itemIdsByTurn: new Map(),
        loading: Promise.resolve(),
      };
      cache.set(filePath, entry);
    }
    entry.loading = entry.loading.then(() => syncEntry(entry, filePath));
    await entry.loading;
    return entry.turns.map((turn) => ({ ...turn, items: turn.items.map((item) => ({ ...item })) }));
  }

  return {
    async resolvePage({ thread, nativeResult, pageSize, direction, cursor }) {
      const turns = reconcileIdleThread(await readTurns(thread), thread);
      if (isRolloutCursor(cursor)) {
        const offset = cursorOffset(cursor, direction);
        return offset == null ? null : paginate(turns, pageSize, direction, offset);
      }
      if (cursor || !shouldUseRollout(nativeResult, turns, direction)) return null;
      return paginate(turns, pageSize, direction);
    },
    readTurns,
    clear() {
      cache.clear();
    },
  };
}
