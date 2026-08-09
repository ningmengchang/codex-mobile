import { $, toast } from './dom.js';
import { api, post } from './http.js';
import { escapeHtml } from './format.js';
import { state } from './state.js';
import { debug } from './debug.js';

let dingtalkPollTimer = null;
let currentDingtalkMessage = null;
let navigateTo = () => {};

function renderDingtalkMessages() {
  const list = $('#dingtalkMessageList');
  list.replaceChildren();
  if (state.dingtalkLoading) {
    list.innerHTML = '<div class="empty-list">正在加载钉钉消息…</div>';
    return;
  }
  if (!state.dingtalkMessages.length) {
    list.innerHTML = '<div class="empty-list">还没有收到发给自己的消息。<br>在钉钉里发给自己，稍后刷新即可。</div>';
    return;
  }
  for (const message of state.dingtalkMessages) {
    const card = document.createElement('article');
    card.className = `dingtalk-message type-${escapeHtml(message.type)}`;
    const media = message.fileId
      ? `<a class="dingtalk-download" href="/api/dingtalk/media/${encodeURIComponent(message.id)}/download" download>下载</a>`
      : '';
    const preview = message.type === 'image' && message.fileId
      ? `<img class="dingtalk-media-image" src="/api/dingtalk/media/${encodeURIComponent(message.id)}/raw" alt="${escapeHtml(message.text || message.title || '图片')}">`
      : '';
    card.innerHTML = `
      <div class="dingtalk-message-head"><span class="dingtalk-type">${escapeHtml(message.type)}</span><time>${escapeHtml(message.createdAt ?? '')}</time></div>
      <div class="dingtalk-message-body">${escapeHtml(message.text || message.title || message.content || '')}</div>
      ${preview}
      ${message.url ? `<a class="dingtalk-link" href="${escapeHtml(message.url)}" target="_blank" rel="noopener">打开链接</a>` : ''}
      ${media}
      <div class="dingtalk-actions">
        <button type="button" data-action="todo" data-message-id="${escapeHtml(message.id)}">生成待办</button>
        <button type="button" data-action="codex" data-message-id="${escapeHtml(message.id)}">交给 Codex</button>
      </div>`;
    card.querySelector('[data-action="todo"]').addEventListener('click', () => openDingtalkTodo(message));
    card.querySelector('[data-action="codex"]').addEventListener('click', () => sendMessageToCodex(message));
    list.append(card);
  }
  if (state.dingtalkHasMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'artifact-more';
    more.textContent = '加载更多';
    more.addEventListener('click', () => loadDingtalkMessages(false));
    list.append(more);
  }
}

export async function loadDingtalkMessages(reset = true) {
  if (state.dingtalkLoading) return;
  if (reset) {
    state.dingtalkCursor = null;
    state.dingtalkHasMore = false;
  }
  state.dingtalkLoading = true;
  renderDingtalkMessages();
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (state.dingtalkCursor) query.set('before', state.dingtalkCursor);
    const result = await api(`/api/dingtalk/messages?${query}`);
    if (reset) state.dingtalkMessages = result.data ?? [];
    else state.dingtalkMessages.push(...(result.data ?? []));
    state.dingtalkCursor = result.nextCursor ?? null;
    state.dingtalkHasMore = Boolean(result.hasMore);
    debug.log('dingtalk', 'loaded', { count: state.dingtalkMessages.length });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.dingtalkLoading = false;
    renderDingtalkMessages();
  }
}

export function startDingtalkPolling() {
  stopDingtalkPolling();
  dingtalkPollTimer = setInterval(() => {
    if (document.querySelector('.view.active')?.dataset.view === 'dingtalk') {
      loadDingtalkMessages(true);
    }
  }, 30_000);
}

export function stopDingtalkPolling() {
  if (dingtalkPollTimer) {
    clearInterval(dingtalkPollTimer);
    dingtalkPollTimer = null;
  }
}

function openDingtalkTodo(message) {
  currentDingtalkMessage = message;
  $('#dingtalkTodoTitle').value = message.text || message.title || message.content || '';
  $('#dingtalkTodoDue').value = '';
  $('#dingtalkTodoDialog').showModal();
  requestAnimationFrame(() => $('#dingtalkTodoTitle').focus());
}

async function confirmDingtalkTodo() {
  const title = $('#dingtalkTodoTitle').value.trim();
  if (!title) {
    toast('待办标题不能为空', 'error');
    return;
  }
  let due;
  const dueInput = $('#dingtalkTodoDue').value;
  if (dueInput) {
    const date = new Date(dueInput);
    if (!Number.isNaN(date.getTime())) due = date.toISOString();
  }
  try {
    await post('/api/dingtalk/todos', { title, due });
    $('#dingtalkTodoDialog').close();
    currentDingtalkMessage = null;
    toast('钉钉待办已创建');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function sendMessageToCodex(message) {
  state.pendingCodexMessage = message.content || message.text || message.title || '';
  navigateTo('projects');
  toast('请选择执行目录');
}

export function initDingtalk(navigate) {
  navigateTo = navigate ?? (() => {});
  $('#refreshDingtalkButton').addEventListener('click', () => loadDingtalkMessages(true).catch((error) => toast(error.message, 'error')));
  $('#closeDingtalkTodoButton').addEventListener('click', () => $('#dingtalkTodoDialog').close());
  $('#cancelDingtalkTodoButton').addEventListener('click', () => $('#dingtalkTodoDialog').close());
  $('#confirmDingtalkTodoButton').addEventListener('click', confirmDingtalkTodo);
  $('#dingtalkTodoTitle').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      confirmDingtalkTodo();
    }
  });
}
