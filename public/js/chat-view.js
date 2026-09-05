/**
 * 聊天视图层（DOM 渲染与滚动）
 *
 * 规则：
 * 1. 增量优先：新回合 appendTurnSection，已有回合 updateTimelineItem，绝不整条重建。
 * 2. 全量渲染仅三类场景：打开会话、刷新合并、加载全部后编号；>12 回合或 >80 项才分块。
 * 3. 分块渲染首帧同步重建并锚定原滚动位置，完成时只有原本在底部才滚到底。
 * 4. 底部跟随：pinnedToBottom 默认 true；上翻 >120px 暂停跟随并显示“回到最新”，<40px 恢复；
 *    程序化滚底一律瞬时（避免 smooth 动画造成“跳到顶部/缓慢滑到底”）。
 */
import { $, $$, toast } from './dom.js';
import { escapeAttribute } from './format.js';
import { state, CHUNKED_TURN_THRESHOLD, CHUNKED_ITEM_THRESHOLD, CHUNK_TURNS_PER_FRAME } from './state.js';
import { renderMermaid } from './mermaid-renderer.js';
import { debug } from './debug.js';
import { planDecisionReady } from './turn-state.js';
import { showThreadLoading, hideThreadLoading, updateThreadLoadingProgress } from './loading.js';
export { showThreadLoading, hideThreadLoading, updateThreadLoadingProgress };
import {
  fetchTurnPage,
  mergeTurns,
  buildTurnArtifactIndex,
  turnArtifactsHtml,
  itemHtml,
  itemInnerHtml,
  itemContentKey,
  isToolItem,
  turnSectionHtml,
} from './chat-core.js';

let timelineRenderJobId = 0;
let timelineRenderBusy = false;
let timelineRenderJobVersion = -1;
let jumpFlashTimer = null;
let olderScrollQueued = false;
let lastScrollTop = 0;
let scrollListenersBound = false;

function setScrollTopInstant(scrollEl, top) {
  const behavior = scrollEl.style.scrollBehavior;
  scrollEl.style.scrollBehavior = 'auto';
  scrollEl.scrollTop = top;
  scrollEl.style.scrollBehavior = behavior;
}

export function scrollTimelineToBottom(scroll = true) {
  if (!scroll || !state.pinnedToBottom) return;
  requestAnimationFrame(() => {
    setScrollTopInstant($('#chatView'), $('#chatView').scrollHeight);
  });
}

export function updateScrollLatestButton() {
  const button = $('#scrollLatestButton');
  if (!button) return;
  button.hidden = state.pinnedToBottom || !state.currentThread;
}

export function updateLoadOlderButton() {
  const button = $('#loadOlderButton');
  if (!button) return;
  const visible = Boolean(state.currentThread && state.turnsNextCursor && state.turns.length);
  button.hidden = !visible;
  button.disabled = state.turnsLoadingOlder;
  button.textContent = state.turnsLoadingOlder ? '正在加载…' : '加载更早历史 ↑';
}

function userMessagesNewestFirst() {
  const messages = [];
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = state.turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      if (items[itemIndex]?.type === 'userMessage') messages.push(items[itemIndex]);
    }
  }
  return messages;
}

export function updateJumpButton() {
  const button = $('#jumpQuestionButton');
  if (!button) return;
  const isChat = document.querySelector('.view.active')?.dataset.view === 'chat';
  const count = userMessagesNewestFirst().length;
  button.hidden = !isChat || count === 0;
  button.title = count ? `共 ${count} 条问题，逐条回退` : '';
}

export function jumpToLatestQuestion() {
  const messages = userMessagesNewestFirst();
  if (!messages.length) return;
  const target = messages[state.questionCursor % messages.length];
  state.questionCursor = (state.questionCursor + 1) % messages.length;
  let node = document.querySelector(`#timeline [data-item-id="${escapeAttribute(target.id)}"]`);
  if (!node) {
    renderTimeline(false, true);
    node = document.querySelector(`#timeline [data-item-id="${escapeAttribute(target.id)}"]`);
  }
  if (!node) return;
  for (const flashed of document.querySelectorAll('.message.user.flash')) flashed.classList.remove('flash');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  clearTimeout(jumpFlashTimer);
  jumpFlashTimer = setTimeout(() => node.classList.remove('flash'), 2000);
}

export function renderModeControls() {
  const planning = state.mode === 'plan';
  $('#chatView').dataset.mode = state.mode;
  for (const button of $$('#modeSwitch button')) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
    button.disabled = Boolean(state.activeTurnId);
  }
  $('#modelSelect').disabled = Boolean(state.activeTurnId);
  const backendSelect = $('#backendSelect');
  if (backendSelect) {
    const availableBackends = state.bootstrap?.backends?.data?.filter((item) => item.available).length ?? 0;
    backendSelect.disabled = state.backendSwitching || availableBackends < 2;
  }
  $('#effortSelect').disabled = Boolean(state.activeTurnId);
  $('#approvalReviewerSelect').disabled = Boolean(state.activeTurnId);
  $('#approvalReviewerSelect').value = state.approvalsReviewer;
  const effortOptions = [...$('#effortSelect').options].map((option) => option.value);
  $('#effortSelect').value = state.effort && effortOptions.includes(state.effort)
    ? state.effort
    : (state.bootstrap?.defaultEffort || 'max');
  $('#modeNotice').innerHTML = planning
    ? '<strong>规划模式 · 只读</strong><span>Codex 会先调研，必要时集中提问一次，再整理可确认的方案。</span>'
    : `<strong>执行模式 · 可写</strong><span>${state.approvalsReviewer === 'auto_review' ? '权限升级由 Codex 自动审查风险；高风险请求仍可能交给你确认。' : '需要额外权限时会在手机端逐次询问。'}</span>`;
  $('#promptInput').placeholder = planning
    ? '描述目标，Codex 会先调研并给出可确认的方案…'
    : '告诉 Codex 下一步做什么…';
}

export function renderPlanDecision() {
  const bar = $('#planDecisionBar');
  const activity = state.currentThread?.activity ?? state.threadRuntimeById.get(state.currentThread?.id);
  bar.hidden = Boolean(state.activeTurnId) || !planDecisionReady({
    turns: state.turns,
    turnModes: state.turnModes,
    activity,
  });
}

function finishTimelineRender(scroll, existingKeys = null) {
  debug.log('timeline', 'finish', { version: state.timelineVersion });
  const timeline = $('#timeline');
  const hiding = timeline.classList.contains('timeline-rendering');
  if (hiding && state.pinnedToBottom) {
    setScrollTopInstant($('#chatView'), $('#chatView').scrollHeight);
  }
  timeline.classList.remove('timeline-rendering');
  if (existingKeys) {
    for (const element of timeline.querySelectorAll('[data-turn-id][data-item-id]')) {
      const key = `${element.getAttribute('data-turn-id')}:${element.getAttribute('data-item-id')}`;
      if (existingKeys.has(key)) element.style.animation = 'none';
    }
  }
  state.timelineRenderedVersion = state.timelineVersion;
  timelineRenderBusy = false;
  $('#interruptButton').hidden = !state.activeTurnId;
  renderModeControls();
  renderPlanDecision();
  updateJumpButton();
  updateLoadOlderButton();
  scrollTimelineToBottom(scroll);
  void renderMermaid(timeline).catch(() => {});
}

function renderTimelineChunked(scroll) {
  debug.log('timeline', 'chunked-start', { turns: state.turns.length });
  const jobId = ++timelineRenderJobId;
  timelineRenderBusy = true;
  timelineRenderJobVersion = state.timelineVersion;
  const timeline = $('#timeline');
  if (!document.body.classList.contains('thread-loading-active')) {
    timeline.classList.add('timeline-rendering');
  }
  const scrollEl = $('#chatView');
  const maxBefore = scrollEl.scrollHeight - scrollEl.clientHeight;
  const anchorScroll = Math.min(scrollEl.scrollTop, Math.max(0, maxBefore));
  const wasNearBottom = maxBefore - scrollEl.scrollTop <= 160;
  timeline.innerHTML = '';
  const artifactIndex = buildTurnArtifactIndex(state.artifacts);
  const turns = state.turns;
  const total = turns.length;
  let cursor = 0;
  const restoreAnchor = () => {
    const max = timeline.scrollHeight - scrollEl.clientHeight;
    setScrollTopInstant(scrollEl, Math.min(anchorScroll, Math.max(0, max)));
  };
  const batch = () => {
    if (!timelineRenderBusy || jobId !== timelineRenderJobId) return;
    const end = Math.min(cursor + CHUNK_TURNS_PER_FRAME, total);
    const html = [];
    for (let index = cursor; index < end; index += 1) html.push(turnSectionHtml(turns[index], index, artifactIndex));
    const wrapper = document.createElement('template');
    wrapper.innerHTML = html.join('');
    timeline.appendChild(wrapper.content);
    cursor = end;
    restoreAnchor();
    updateThreadLoadingProgress(cursor, total);
    if (cursor < total) requestAnimationFrame(batch);
    else {
      updateTurnArtifactsStrips();
      finishTimelineRender(scroll && wasNearBottom);
    }
  };
  batch();
}

export function renderTimeline(scroll = true, force = false) {
  debug.log('timeline', 'render', { force, version: state.timelineVersion, busy: timelineRenderBusy });
  const timeline = $('#timeline');
  if (timelineRenderBusy) {
    if (!force && timelineRenderJobVersion === state.timelineVersion) return;
    timelineRenderBusy = false;
    timelineRenderJobId += 1;
  }
  if (!force && state.timelineRenderedVersion === state.timelineVersion && timeline.querySelector('[data-turn]')) {
    if (scroll) scrollTimelineToBottom();
    return;
  }
  const totalItems = state.turns.reduce((sum, turn) => sum + (turn.items ?? []).length, 0);
  $('#emptyState').hidden = Boolean(state.currentThread || totalItems);
  if (state.turns.length > CHUNKED_TURN_THRESHOLD || totalItems > CHUNKED_ITEM_THRESHOLD) {
    renderTimelineChunked(scroll);
    return;
  }
  const existingKeys = new Set([...timeline.querySelectorAll('[data-turn-id][data-item-id]')]
    .map((element) => `${element.getAttribute('data-turn-id')}:${element.getAttribute('data-item-id')}`));
  const artifactIndex = buildTurnArtifactIndex(state.artifacts);
  timeline.innerHTML = state.turns.map((turn, index) => turnSectionHtml(turn, index, artifactIndex)).join('');
  for (const element of timeline.querySelectorAll('[data-turn-id][data-item-id]')) {
    const key = `${element.getAttribute('data-turn-id')}:${element.getAttribute('data-item-id')}`;
    if (existingKeys.has(key)) element.style.animation = 'none';
  }
  finishTimelineRender(scroll, existingKeys);
}

export function updateTurnArtifactsStrips() {
  if (!state.turns.length) return;
  const artifactIndex = buildTurnArtifactIndex(state.artifacts);
  const sections = new Map([...document.querySelectorAll('#timeline [data-turn]')]
    .map((element) => [element.getAttribute('data-turn'), element]));
  let complete = true;
  for (const turn of state.turns) {
    const section = sections.get(turn.id);
    if (!section) {
      complete = false;
      continue;
    }
    const html = turnArtifactsHtml(turn.id, artifactIndex);
    const existing = section.querySelector('.turn-artifacts');
    if (html) {
      const wrapper = document.createElement('template');
      wrapper.innerHTML = html.trim();
      if (existing) existing.replaceWith(wrapper.content.firstChild);
      else section.appendChild(wrapper.content.firstChild);
    } else if (existing) {
      existing.remove();
    }
  }
  if (complete) state.timelineRenderedVersion = state.timelineVersion;
}

export function appendTurnSection(turn) {
  if (timelineRenderBusy) {
    timelineRenderBusy = false;
    timelineRenderJobId += 1;
  }
  const timeline = $('#timeline');
  timeline.classList.remove('timeline-rendering');
  const artifactIndex = buildTurnArtifactIndex(state.artifacts);
  const wrapper = document.createElement('template');
  wrapper.innerHTML = turnSectionHtml(turn, state.turns.length - 1, artifactIndex).trim();
  timeline.appendChild(wrapper.content);
  state.timelineRenderedVersion = state.timelineVersion;
  if (state.pinnedToBottom) scrollTimelineToBottom();
  void renderMermaid(timeline).catch(() => {});
}

export function updateTimelineItem(turnId, item) {
  if (!item?.id) return;
  const selector = `#timeline [data-turn-id="${escapeAttribute(turnId)}"][data-item-id="${escapeAttribute(item.id)}"]`;
  let node = document.querySelector(selector);
  if (!node && item.type === 'userMessage') {
    const key = itemContentKey(item);
    if (key) {
      node = document.querySelector(`#timeline [data-turn-id="${escapeAttribute(turnId)}"][data-content-key="${escapeAttribute(key)}"]`);
    }
  }
  if (!node && item.type === 'userMessage') {
    const text = (item.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const existing = [...document.querySelectorAll(`#timeline [data-turn-id="${escapeAttribute(turnId)}"].message.user`)].find((element) => {
      const copy = element.querySelector('.copy-question');
      return copy && copy.dataset.copyText === text;
    });
    if (existing) node = existing;
  }
  if (!node) {
    const section = document.querySelector(`#timeline [data-turn="${escapeAttribute(turnId)}"]`);
    if (section) {
      const template = document.createElement('template');
      template.innerHTML = itemHtml(item, turnId).trim();
      const element = template.content.firstChild;
      if (isToolItem(item)) {
        let content = section.querySelector('.turn-tools-content');
        if (!content) {
          const tools = document.createElement('details');
          tools.className = 'turn-tools';
          tools.innerHTML = '<summary><span class="tool-badge">TOOLS</span>工具与思考 · 0</summary><div class="turn-tools-content"></div>';
          const strip = section.querySelector('.turn-artifacts');
          if (strip) section.insertBefore(tools, strip);
          else section.appendChild(tools);
          content = tools.querySelector('.turn-tools-content');
        }
        content.appendChild(element);
        const summary = section.querySelector('.turn-tools > summary');
        if (summary) {
          const count = content.querySelectorAll(':scope > [data-item-id]').length;
          summary.innerHTML = `<span class="tool-badge">TOOLS</span>工具与思考 · ${count}`;
        }
      } else {
        section.appendChild(element);
      }
      scrollTimelineToBottom();
      return;
    }
    renderTimeline(false, true);
    return;
  }
  const inner = itemInnerHtml(item);
  if (inner !== null) {
    node.innerHTML = inner;
    node.dataset.itemId = item.id;
    const contentKey = itemContentKey(item);
    if (contentKey) node.dataset.contentKey = contentKey;
  } else {
    node.outerHTML = itemHtml(item, turnId);
  }
  if (!state.activeTurnId) void renderMermaid($('#timeline')).catch(() => {});
  scrollTimelineToBottom();
}

function prependTurnSections(turnsAsc) {
  const timeline = $('#timeline');
  const first = timeline.querySelector('[data-turn]');
  if (!first) {
    renderTimeline();
    return;
  }
  const artifactIndex = buildTurnArtifactIndex(state.artifacts);
  const wrapper = document.createElement('template');
  wrapper.innerHTML = turnsAsc.map((turn, index) => turnSectionHtml(turn, index, artifactIndex)).join('');
  const scrollEl = $('#chatView');
  const beforeHeight = timeline.scrollHeight;
  const beforeScroll = scrollEl.scrollTop;
  timeline.insertBefore(wrapper.content, first);
  const afterHeight = timeline.scrollHeight;
  setScrollTopInstant(scrollEl, beforeScroll + (afterHeight - beforeHeight));
  state.timelineRenderedVersion = state.timelineVersion;
  void renderMermaid(timeline).catch(() => {});
}

export async function loadOlderTurns() {
  if (!state.currentThread || !state.turnsNextCursor || state.turnsLoadingOlder) return;
  state.turnsLoadingOlder = true;
  updateLoadOlderButton();
  try {
    const threadId = state.currentThread.id;
    const page = await fetchTurnPage(threadId, { cursor: state.turnsNextCursor, direction: 'desc' });
    if (threadId !== state.currentThread?.id) return;
    if (!page.turnsAsc.length) {
      state.turnsNextCursor = null;
      updateLoadOlderButton();
      return;
    }
    const merged = mergeTurns(state.turns, page.turnsAsc, 'prepend');
    state.turns = merged.turns;
    state.turnsNextCursor = page.nextCursor;
    state.timelineVersion += 1;
    if (state.turnsNextCursor) prependTurnSections(page.turnsAsc);
    else renderTimeline();
    const entry = state.threadCache.get(threadId);
    if (entry) {
      entry.turns = state.turns.slice();
      entry.turnsNextCursor = state.turnsNextCursor;
    }
    updateLoadOlderButton();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.turnsLoadingOlder = false;
    updateLoadOlderButton();
  }
}

export function initChatScroll() {
  if (scrollListenersBound) return;
  scrollListenersBound = true;
  $('#scrollLatestButton').addEventListener('click', () => {
    state.pinnedToBottom = true;
    updateScrollLatestButton();
    scrollTimelineToBottom();
  });
  $('#chatView').addEventListener('scroll', () => {
    if (olderScrollQueued) return;
    olderScrollQueued = true;
    requestAnimationFrame(() => {
      olderScrollQueued = false;
      const scrollEl = $('#chatView');
      const current = scrollEl.scrollTop;
      if (timelineRenderBusy) return;
      const cameFromBelow = lastScrollTop > 80;
      lastScrollTop = current;
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (max - current <= 40) state.pinnedToBottom = true;
      else if (max - current > 120) state.pinnedToBottom = false;
      updateScrollLatestButton();
      if (cameFromBelow && state.turnsNextCursor && current < 80) loadOlderTurns().catch(() => {});
    });
  });
}
