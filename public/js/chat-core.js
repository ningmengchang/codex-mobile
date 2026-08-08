/**
 * 聊天数据层（纯逻辑，不直接操作 DOM）
 *
 * 规则：
 * 1. 分页：thread/turns/list 按游标取更早回合，返回的 data 为降序，统一转为升序（turnsAsc）。
 * 2. 合并去重：refresh 时服务端条目优先，客户端 SSE 独有条目按 id + 内容键合并，绝不丢项；
 *    同一回合内“相同类型 + 相同文本”的卡片只保留一份。
 * 3. 回合追加：新回合由视图层 append，本模块只负责状态合并。
 */
import { api } from './http.js';
import { state, THREAD_CACHE_MAX, MAIN_ITEM_TYPES, DELIVERABLE_KINDS, DELIVERABLE_KEYWORDS } from './state.js';
import { escapeHtml, markdown, formatTurnTime } from './format.js';

export async function fetchTurnPage(threadId, options = {}) {
  const query = new URLSearchParams({
    pageSize: String(options.pageSize ?? 20),
    direction: options.direction ?? 'desc',
  });
  if (options.cursor) query.set('cursor', options.cursor);
  const result = await api(`/api/threads/${encodeURIComponent(threadId)}/turns?${query}`);
  const data = Array.isArray(result.data) ? result.data : [];
  return { turnsAsc: [...data].reverse(), nextCursor: result.nextCursor ?? null };
}

export function sameTurn(left, right) {
  return left.status === right.status && (left.items ?? []).length === (right.items ?? []).length;
}

export function mergeTurns(loaded, incoming, mode) {
  const loadedById = new Map(loaded.map((turn) => [turn.id, turn]));
  const incomingById = new Map(incoming.map((turn) => [turn.id, turn]));
  let changed = false;
  const result = [];
  if (mode === 'prepend') {
    for (const turn of incoming) {
      const existing = loadedById.get(turn.id);
      if (existing) {
        if (!sameTurn(existing, turn)) changed = true;
        result.push(turn);
      } else {
        changed = true;
        result.push(turn);
      }
    }
    for (const turn of loaded) {
      if (!incomingById.has(turn.id)) result.push(turn);
    }
  } else {
    for (const turn of loaded) {
      const fresh = incomingById.get(turn.id);
      if (fresh) {
        const freshItems = fresh.items ?? [];
        const freshItemIds = new Set(freshItems.map((item) => item.id));
        const extraItems = (turn.items ?? []).filter((item) => !freshItemIds.has(item.id));
        const mergedTurn = { ...fresh, items: dedupeItems([...freshItems, ...extraItems]) };
        if (!sameTurn(turn, mergedTurn) || extraItems.length) changed = true;
        result.push(mergedTurn);
      } else {
        result.push(turn);
      }
    }
    for (const turn of incoming) {
      if (!loadedById.has(turn.id)) {
        changed = true;
        result.push(turn);
      }
    }
  }
  return { turns: result, changed };
}

export function isToolItem(item) {
  return !MAIN_ITEM_TYPES.has(item.type);
}

export function itemContentKey(item) {
  if (!item) return null;
  if (item.type === 'userMessage') {
    const text = (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
    return text ? `userMessage:${text}` : `userMessage:id:${item.id}`;
  }
  if (item.type === 'agentMessage') {
    return `agentMessage:${(item.text ?? '').trim()}`;
  }
  if (item.type === 'plan') {
    const text = (item.text ?? item.payload?.text ?? item.content ?? '').trim();
    return text ? `plan:${text}` : `plan:id:${item.id}`;
  }
  if (item.type === 'structuredPlan') {
    const steps = (item.plan ?? item.steps ?? []).map((entry) => `${entry.step ?? entry.text ?? entry.title ?? entry.description ?? ''}:${entry.status ?? entry.state ?? 'pending'}`).join('\n');
    const text = `${(item.explanation ?? '').trim()}\n${steps}`.trim();
    return text ? `structuredPlan:${text}` : `structuredPlan:id:${item.id}`;
  }
  return null;
}

export function dedupeItems(items) {
  const seenIds = new Set();
  const seenContent = new Set();
  const result = [];
  for (const item of items) {
    if (!item) continue;
    if (item.id && seenIds.has(item.id)) continue;
    const contentKey = itemContentKey(item);
    if (contentKey && seenContent.has(contentKey)) continue;
    if (item.id) seenIds.add(item.id);
    if (contentKey) seenContent.add(contentKey);
    result.push(item);
  }
  return result;
}

export function artifactSortTime(artifact) {
  return new Date(artifact.modifiedAt || artifact.capturedAt || 0).getTime() || 0;
}

export function isDeliverableArtifact(artifact) {
  if (!artifact) return false;
  if (DELIVERABLE_KINDS.has(artifact.fileKind)) return true;
  const haystack = `${artifact.name ?? ''}`.toLowerCase();
  return DELIVERABLE_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function buildTurnArtifactIndex(artifacts) {
  const index = new Map();
  for (const artifact of artifacts) {
    if (!artifact.available || !isDeliverableArtifact(artifact)) continue;
    let list = index.get(artifact.turnId);
    if (!list) {
      list = [];
      index.set(artifact.turnId, list);
    }
    list.push(artifact);
  }
  return index;
}

export function turnArtifactsHtml(turnId, index = buildTurnArtifactIndex(state.artifacts)) {
  const items = (index.get(turnId) ?? []).slice().sort((a, b) => artifactSortTime(b) - artifactSortTime(a));
  if (!items.length) return '';
  const chips = items.slice(0, 3).map((artifact) => `<button type="button" class="turn-artifact-chip" data-artifact-id="${escapeHtml(artifact.id)}"><i class="chip-icon">${escapeHtml(artifact.fileKind.slice(0, 4))}</i><span>${escapeHtml(artifact.name)}</span></button>`).join('');
  return `<div class="turn-artifacts"><span class="turn-artifacts-label">本次产出</span><div class="turn-artifacts-scroll">${chips}</div><button type="button" class="turn-artifacts-more">全部</button></div>`;
}

export function itemInnerHtml(item) {
  if (item.type === 'userMessage') {
    const text = (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    return `<div class="bubble">${markdown(text)}<button type="button" class="copy-question" data-copy-text="${escapeHtml(text)}" aria-label="复制问题" title="复制问题">⧉</button></div>`;
  }
  if (item.type === 'agentMessage') {
    return `<div class="agent-card ${state.activeTurnId ? 'status-running' : ''}">${markdown(item.text ?? '')}</div>`;
  }
  return null;
}

export function itemHtml(item, turnId) {
  if (!item) return '';
  const attrs = `data-turn-id="${escapeHtml(turnId ?? '')}" data-item-id="${escapeHtml(item.id ?? '')}"`;
  if (item.type === 'userMessage') {
    return `<article class="message user" ${attrs}>${itemInnerHtml(item)}</article>`;
  }
  if (item.type === 'agentMessage') {
    return `<article class="message" ${attrs}>${itemInnerHtml(item)}</article>`;
  }
  if (item.type === 'plan') {
    const text = item.text ?? item.payload?.text ?? item.content ?? '';
    return `<details class="tool-card plan-card" open ${attrs}><summary><span class="tool-badge">PLAN</span>方案草案</summary><div class="tool-content agent-card">${text ? markdown(text) : '<p>方案正在生成…</p>'}</div></details>`;
  }
  if (item.type === 'structuredPlan') {
    const steps = (item.plan ?? item.steps ?? []).map((entry, index) => {
      const status = entry.status ?? entry.state ?? 'pending';
      const icon = status === 'completed' ? '✓' : (status === 'inProgress' || status === 'in_progress' ? '●' : String(index + 1));
      const step = entry.step ?? entry.text ?? entry.title ?? entry.description ?? '';
      return `<div class="plan-step" data-status="${escapeHtml(status)}"><i>${escapeHtml(icon)}</i><span>${escapeHtml(step)}</span></div>`;
    }).join('');
    return `<article class="plan-card" ${attrs}><header><span>PLAN</span><strong>当前方案进度</strong></header>${item.explanation ? `<p class="plan-explanation">${escapeHtml(item.explanation)}</p>` : ''}<div class="plan-steps">${steps || '<div class="plan-step"><i>·</i><span>正在整理方案…</span></div>'}</div></article>`;
  }
  if (item.type === 'reasoning') {
    return `<details class="tool-card" ${attrs}><summary><span class="tool-badge">THINK</span>${escapeHtml((item.summary ?? [])[0] ?? '推理过程')}</summary><div class="tool-content"><pre>${escapeHtml([...(item.summary ?? []), ...(item.content ?? [])].join('\n'))}</pre></div></details>`;
  }
  if (item.type === 'commandExecution') {
    const stateLabel = item.status ?? 'running';
    return `<details class="tool-card" ${attrs}><summary><span class="tool-badge">CMD</span>${escapeHtml(stateLabel)} · ${escapeHtml(item.command ?? '命令')}</summary><div class="tool-content"><pre>${escapeHtml(item.aggregatedOutput ?? '')}</pre></div></details>`;
  }
  if (item.type === 'fileChange') {
    const changes = (item.changes ?? []).map((change) => `<strong>${escapeHtml(change.kind)} · ${escapeHtml(change.path)}</strong><pre>${escapeHtml(change.diff ?? '')}</pre>`).join('');
    return `<details class="tool-card" ${attrs}><summary><span class="tool-badge">DIFF</span>${item.changes?.length ?? 0} 个文件变化</summary><div class="tool-content">${changes}</div></details>`;
  }
  if (item.type === 'turnDiff') {
    return `<details class="tool-card" ${attrs}><summary><span class="tool-badge">DIFF</span>当前回合差异</summary><div class="tool-content"><pre>${escapeHtml(item.diff ?? '')}</pre></div></details>`;
  }
  const label = item.type === 'mcpToolCall' ? `${item.server ?? 'MCP'} / ${item.tool ?? 'tool'}` : item.type;
  return `<details class="tool-card" ${attrs}><summary><span class="tool-badge">TOOL</span>${escapeHtml(label)}</summary><div class="tool-content"><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></div></details>`;
}

export function turnSectionHtml(turn, index, artifactIndex) {
  const duration = turn.durationMs ? ` · ${(turn.durationMs / 1000).toFixed(1)}s` : '';
  const mode = state.turnModes.get(turn.id);
  const modeLabel = mode ? ` · ${mode === 'plan' ? '规划' : '执行'}` : '';
  const allLoaded = !state.turnsNextCursor;
  const timeLabel = (turn.startedAt || turn.completedAt) ? ` · ${formatTurnTime(turn.startedAt ?? turn.completedAt)}` : '';
  const ordinal = allLoaded ? `回合 ${index + 1}` : '';
  const items = dedupeItems(turn.items ?? []);
  const mainItems = items.filter((item) => !isToolItem(item));
  const toolItems = items.filter(isToolItem);
  const toolsHtml = toolItems.length
    ? `<details class="turn-tools"><summary><span class="tool-badge">TOOLS</span>工具与思考 · ${toolItems.length}</summary><div class="turn-tools-content">${toolItems.map((item) => itemHtml(item, turn.id)).join('')}</div></details>`
    : '';
  return `<section data-turn="${escapeHtml(turn.id)}"><div class="turn-divider">${ordinal}${modeLabel} · ${escapeHtml(turn.status)}${duration}${timeLabel}</div>${mainItems.map((item) => itemHtml(item, turn.id)).join('')}${toolsHtml}${turnArtifactsHtml(turn.id, artifactIndex)}</section>`;
}

export function ensureTurn(turnId) {
  let turn = state.turns.find((item) => item.id === turnId);
  if (!turn) {
    turn = { id: turnId, status: 'inProgress', items: [] };
    state.turns.push(turn);
  }
  return turn;
}

export function upsertItem(turnId, item) {
  if (!item?.id) return;
  const turn = ensureTurn(turnId);
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) turn.items[index] = { ...turn.items[index], ...item };
  else if (item.type === 'userMessage') {
    const itemText = (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const duplicateIndex = turn.items.findIndex((candidate) => {
      if (candidate.type !== 'userMessage') return false;
      const candidateText = (candidate.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      return candidateText === itemText;
    });
    if (duplicateIndex >= 0) turn.items[duplicateIndex] = { ...turn.items[duplicateIndex], ...item };
    else turn.items.push(item);
  } else {
    turn.items.push(item);
  }
}

export function cacheThread(threadId, entry) {
  state.threadCache.delete(threadId);
  state.threadCache.set(threadId, entry);
  if (state.threadCache.size > THREAD_CACHE_MAX) {
    const oldest = state.threadCache.keys().next().value;
    state.threadCache.delete(oldest);
  }
}
