import { $, $$, toast } from './js/dom.js';
import { api, post } from './js/http.js';
import { escapeHtml, markdown, formatBytes, formatTime, escapeAttribute } from './js/format.js';
import {
  state,
  UI_STATE,
  DELIVERABLE_KINDS,
  DELIVERABLE_KEYWORDS,
  PINNED_ARTIFACTS_KEY,
  ARTIFACT_OTHER_PAGE,
  ARTIFACT_OTHER_STEP,
} from './js/state.js';
import {
  fetchTurnPage,
  mergeTurns,
  sameTurn,
  isToolItem,
  itemContentKey,
  dedupeItems,
  ensureTurn,
  upsertItem,
  cacheThread,
  isDeliverableArtifact,
  artifactSortTime,
  buildTurnArtifactIndex,
  turnArtifactsHtml,
  itemInnerHtml,
  itemHtml,
  turnSectionHtml,
} from './js/chat-core.js';
import {
  userMessagesNewestFirst,
  updateJumpButton,
  jumpToLatestQuestion,
  renderModeControls,
  renderPlanDecision,
  scrollTimelineToBottom,
  updateScrollLatestButton,
  updateLoadOlderButton,
  showThreadLoading,
  hideThreadLoading,
  finishTimelineRender,
  renderTimelineChunked,
  renderTimeline,
  updateTimelineItem,
  appendTurnSection,
  updateTurnArtifactsStrips,
  prependTurnSections,
  loadOlderTurns,
  initChatScroll,
} from './js/chat-view.js';

let skillsCache = null;

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try { document.execCommand('copy'); } finally { textarea.remove(); }
}

function showLogin() {
  state.events?.close();
  $('#app').hidden = true;
  $('#loginScreen').hidden = false;
  setTimeout(() => $('#pairCode').focus(), 50);
}

function showApp() {
  $('#loginScreen').hidden = true;
  $('#app').hidden = false;
}

function setConnection(status, label) {
  const pill = $('#connectionStatus');
  pill.dataset.state = status;
  pill.querySelector('span').textContent = label;
}

function isFullscreenActive() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function updateFullscreenButton() {
  const button = $('#fullscreenButton');
  if (!button) return;
  const active = isFullscreenActive();
  const icon = button.querySelector('i');
  const label = button.querySelector('span');
  if (icon) icon.textContent = active ? '⤢' : '⛶';
  if (label) label.textContent = active ? '退出全屏' : '全屏';
  button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  button.setAttribute('title', active ? '退出全屏' : '全屏');
  button.setAttribute('aria-pressed', String(active));
  document.body.classList.toggle('fullscreen-active', active);
}

let fullscreenPressTimer = null;
let fullscreenPopoverTimer = null;
let suppressControlClick = false;

function openFullscreenPopover() {
  const popover = $('#fullscreenPopover');
  if (!popover) return;
  popover.hidden = false;
  clearTimeout(fullscreenPopoverTimer);
  fullscreenPopoverTimer = setTimeout(closeFullscreenPopover, 3000);
}

function closeFullscreenPopover() {
  const popover = $('#fullscreenPopover');
  if (popover) popover.hidden = true;
  clearTimeout(fullscreenPopoverTimer);
}

function toggleFullscreen() {
  if (isFullscreenActive()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const enter = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (enter) {
    enter.call(document.documentElement);
  } else {
    toast('当前浏览器不支持全屏，添加到主屏幕可获得接近全屏体验');
  }
}

let uiStateTimer = null;

function saveUiState() {
  if (state.currentThread?.id) localStorage.setItem(UI_STATE.thread, state.currentThread.id);
  const activeTab = document.querySelector('.bottom-nav button.active')?.dataset.tab;
  if (activeTab) sessionStorage.setItem(UI_STATE.tab, activeTab);
  sessionStorage.setItem(UI_STATE.draft, $('#promptInput').value);
}

function scheduleUiStateSave() {
  clearTimeout(uiStateTimer);
  uiStateTimer = setTimeout(saveUiState, 250);
}

async function restoreUiState() {
  const savedThreadId = localStorage.getItem(UI_STATE.thread);
  const savedTab = sessionStorage.getItem(UI_STATE.tab);
  const savedDraft = sessionStorage.getItem(UI_STATE.draft) ?? '';
  if (savedThreadId && state.threads.some((thread) => thread.id === savedThreadId)) {
    try {
      await openThread(savedThreadId);
    } catch {
      localStorage.removeItem(UI_STATE.thread);
      sessionStorage.removeItem(UI_STATE.draft);
    }
  } else if (savedThreadId) {
    localStorage.removeItem(UI_STATE.thread);
    sessionStorage.removeItem(UI_STATE.draft);
  }
  if (['chat', 'threads', 'artifacts', 'projects'].includes(savedTab)) showTab(savedTab);
  const input = $('#promptInput');
  if (savedDraft && state.currentThread?.id === savedThreadId) {
    input.value = savedDraft;
    resizeComposer();
  }
  saveUiState();
}

async function initialize() {
  const auth = await api('/api/auth/status');
  if (!auth.authenticated) {
    showLogin();
    return;
  }
  showApp();
  await loadBootstrap();
  await restoreUiState().catch((error) => toast(error.message, 'error'));
  connectEvents();
}

async function loadBootstrap() {
  setConnection('connecting', '连接中');
  state.bootstrap = await api('/api/bootstrap');
  const runtimeParts = [state.bootstrap.runtime.user, 'SSH'];
  if (state.bootstrap.runtime.codexHome) runtimeParts.push(state.bootstrap.runtime.codexHome);
  $('#settingsRuntime').textContent = runtimeParts.join(' · ');
  setConnection(state.bootstrap.appServer.ready ? 'online' : 'connecting', state.bootstrap.appServer.ready ? '已连接' : 'Codex 启动中');
  for (const request of state.bootstrap.pendingRequests ?? []) state.approvals.set(request.id, request);
  renderApprovals();
  renderModels();
  renderModeControls();
  const initialProject = state.currentProject || state.bootstrap.projects.current.path;
  await selectProject(initialProject, false);
  renderProjects(state.bootstrap.projects);
}

function renderModels() {
  const select = $('#modelSelect');
  select.replaceChildren();
  for (const model of state.bootstrap.models ?? []) {
    const id = model.id ?? model.model ?? model.slug;
    if (!id) continue;
    select.add(new Option(model.displayName ?? model.display_name ?? id, id));
  }
  const saved = state.model && [...select.options].some((option) => option.value === state.model);
  select.value = saved ? state.model
    : (state.bootstrap?.defaultModel || state.bootstrap?.models?.[0]?.id || '');
}

function effectiveModel() {
  return $('#modelSelect').value || state.bootstrap?.defaultModel || state.bootstrap?.models?.[0]?.id || undefined;
}

function setMode(mode) {
  if (state.activeTurnId) {
    toast('当前回合结束后才能切换模式');
    return false;
  }
  if (!['default', 'plan'].includes(mode)) return false;
  state.mode = mode;
  localStorage.setItem('codex-mobile-mode', mode);
  renderModeControls();
  return true;
}

async function selectProject(projectPath, switchToChat = true) {
  try {
    state.currentProject = projectPath;
    localStorage.setItem('codex-mobile-project', projectPath);
    $('#currentProjectName').textContent = projectPath.split('/').filter(Boolean).at(-1) || projectPath;
    await loadThreads();
    if (switchToChat) showTab('chat');
  } catch (error) {
    state.currentProject = state.bootstrap?.projects?.current?.path ?? null;
    toast(error.message, 'error');
  }
}

async function browseProjects(projectPath = '') {
  const query = projectPath ? `?path=${encodeURIComponent(projectPath)}` : '';
  const data = await api(`/api/projects${query}`);
  renderProjects(data);
}

function renderProjects(data) {
  state.projectBrowser = data;
  $('#projectPath').textContent = data.current.path;
  $('#projectUpButton').hidden = !data.parent;
  const list = $('#projectList');
  list.replaceChildren();
  const choose = document.createElement('button');
  choose.className = 'project-button';
  choose.innerHTML = `<i>✓</i><span><strong>使用当前目录</strong><small>${escapeHtml(data.current.name)}</small></span><b>›</b>`;
  choose.addEventListener('click', () => selectProject(data.current.path));
  list.append(choose);
  for (const project of data.entries) {
    const button = document.createElement('button');
    button.className = 'project-button';
    button.innerHTML = `<i>⌁</i><span>${escapeHtml(project.name)}</span><b>›</b>`;
    button.addEventListener('click', () => browseProjects(project.path).catch((error) => toast(error.message, 'error')));
    list.append(button);
  }
}

async function loadThreads() {
  if (!state.currentProject) return;
  const result = await api(`/api/threads?cwd=${encodeURIComponent(state.currentProject)}`);
  state.threads = result.data ?? [];
  renderThreads();
}

function renderThreads() {
  for (const list of [$('#desktopThreadList'), $('#mobileThreadList')]) {
    list.replaceChildren();
    if (!state.threads.length) {
      list.innerHTML = '<div class="empty-list">这个项目还没有会话</div>';
      continue;
    }
    for (const thread of state.threads) {
      const button = document.createElement('button');
      button.className = `thread-item ${state.currentThread?.id === thread.id ? 'active' : ''}`;
      const title = thread.name || thread.preview || '未命名会话';
      const status = typeof thread.status === 'string' ? thread.status : Object.keys(thread.status ?? {})[0] ?? '';
      button.innerHTML = `<strong>${escapeHtml(title)}</strong><small>${escapeHtml(formatTime(thread.updatedAt))} · ${escapeHtml(status)}</small>`;
      button.addEventListener('click', () => openThread(thread.id));
      list.append(button);
    }
  }
}

async function newThread() {
  if (!state.currentProject) {
    showTab('projects');
    toast('请先选择项目');
    return;
  }
  try {
    const result = await post('/api/threads', {
      cwd: state.currentProject,
      model: effectiveModel() || undefined,
    });
    state.currentThread = result.thread;
    state.turns = result.thread.turns ?? [];
    state.timelineVersion += 1;
    state.questionCursor = 0;
    state.activeTurnId = null;
    state.turnModes.clear();
    renderTimeline();
    await loadThreads();
    showTab('chat');
    $('#promptInput').focus();
    saveUiState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setArtifacts(next) {
  if (!sameArtifactSet(state.artifacts, next)) {
    state.artifacts = next;
    state.artifactsVersion += 1;
    state.timelineVersion += 1;
    state.artifactOtherShown = ARTIFACT_OTHER_PAGE;
    return true;
  }
  state.artifacts = next;
  return false;
}

function applyThreadData(thread, turns, seq = state.threadLoadSeq) {
  if (seq !== state.threadLoadSeq) return false;
  state.currentThread = thread;
  state.currentProject = thread.cwd;
  localStorage.setItem('codex-mobile-project', state.currentProject);
  $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
  state.turns = turns;
  state.timelineVersion += 1;
  state.questionCursor = 0;
  state.turnModes.clear();
  const active = turns.find((turn) => turn.status === 'inProgress');
  state.activeTurnId = active?.id ?? null;
  state.pinnedToBottom = true;
  updateScrollLatestButton();
  renderTimeline();
  renderThreads();
  saveUiState();
  return true;
}

async function openThread(threadId) {
  const seq = ++state.threadLoadSeq;
  showTab('chat');
  const cached = state.threadCache.get(threadId);
  if (cached) {
    setArtifacts(cached.artifacts ?? []);
    renderArtifacts();
    state.turnsNextCursor = cached.turnsNextCursor ?? null;
    applyThreadData(cached.thread, cached.turns, seq);
    updateLoadOlderButton();
    post(`/api/threads/${encodeURIComponent(threadId)}/resume`).catch((error) => toast(`会话恢复失败：${error.message}`, 'error'));
    refreshCurrentThread({ seq }).catch(() => {});
    return;
  }
  showThreadLoading();
  try {
    const read = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if (seq !== state.threadLoadSeq) return;
    const fullTurns = read.thread.turns ?? [];
    setArtifacts([]);
    let page = null;
    try {
      page = await fetchTurnPage(threadId);
    } catch {
      page = null;
    }
    if (seq !== state.threadLoadSeq) return;
    const turns = page && page.turnsAsc.length ? page.turnsAsc : fullTurns;
    state.turnsNextCursor = page && page.turnsAsc.length ? page.nextCursor : null;
    cacheThread(threadId, {
      thread: read.thread,
      turns: turns.slice(),
      artifacts: [],
      turnsNextCursor: state.turnsNextCursor,
      cachedAt: Date.now(),
    });
    applyThreadData(read.thread, turns, seq);
    updateLoadOlderButton();
    post(`/api/threads/${encodeURIComponent(threadId)}/resume`).catch((error) => toast(`会话恢复失败：${error.message}`, 'error'));
    loadArtifacts(threadId).then(() => {
      const entry = state.threadCache.get(threadId);
      if (entry && state.currentThread?.id === threadId) entry.artifacts = state.artifacts.slice();
    }).catch((error) => toast(error.message, 'error'));
  } catch (error) {
    if (seq === state.threadLoadSeq) {
      hideThreadLoading();
      toast(error.message, 'error');
    }
  }
}

let refreshPromise = null;
let refreshEpoch = 0;
async function refreshCurrentThread(options = {}) {
  if (!state.currentThread) return;
  if (refreshPromise) {
    if (!options.force) return refreshPromise;
    refreshEpoch += 1;
    await refreshPromise.catch(() => {});
    if (options.seq !== undefined && options.seq !== state.threadLoadSeq) return;
  }
  const threadId = state.currentThread.id;
  const epoch = ++refreshEpoch;
  const run = (async () => {
    try {
      const read = await api(`/api/threads/${encodeURIComponent(threadId)}`);
      if (epoch !== refreshEpoch) return;
      if (options.seq !== undefined && options.seq !== state.threadLoadSeq) return;
      if (state.currentThread?.id !== threadId) return;
      const fullTurns = read.thread.turns ?? [];
      let page = null;
      try {
        page = await fetchTurnPage(threadId);
      } catch {
        page = null;
      }
      if (epoch !== refreshEpoch) return;
      if (options.seq !== undefined && options.seq !== state.threadLoadSeq) return;
      if (state.currentThread?.id !== threadId) return;
      const incoming = page && page.turnsAsc.length ? page.turnsAsc : fullTurns;
      const merged = mergeTurns(state.turns, incoming, 'refresh');
      const metaChanged = state.currentThread.updatedAt !== read.thread.updatedAt
        || state.currentThread.name !== read.thread.name
        || state.currentThread.status !== read.thread.status;
      state.currentThread = read.thread;
      state.currentProject = read.thread.cwd;
      localStorage.setItem('codex-mobile-project', state.currentProject);
      $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
      if (!merged.changed && !metaChanged) {
        renderThreads();
        return;
      }
      state.turns = merged.turns;
      if (page && page.turnsAsc.length) state.turnsNextCursor = page.nextCursor;
      state.timelineVersion += 1;
      renderTimeline();
      renderThreads();
      updateLoadOlderButton();
      const entry = state.threadCache.get(threadId);
      if (entry) {
        entry.thread = read.thread;
        entry.turns = state.turns.slice();
        entry.turnsNextCursor = state.turnsNextCursor;
        entry.cachedAt = Date.now();
      }
      await loadArtifacts(threadId);
      if (entry && state.currentThread?.id === threadId) entry.artifacts = state.artifacts.slice();
      saveUiState();
    } finally {
      if (refreshPromise === run) refreshPromise = null;
    }
  })();
  refreshPromise = run;
  return refreshPromise;
}

async function openSkillSheet() {
  $('#skillSheet').showModal();
  if (skillsCache) {
    renderSkills(skillsCache);
    return;
  }
  $('#skillList').innerHTML = '<p class="empty-list">正在加载技能…</p>';
  try {
    const result = await api('/api/skills');
    skillsCache = result.data ?? [];
  } catch (error) {
    skillsCache = [];
    toast(error.message, 'error');
  }
  renderSkills(skillsCache);
}

function renderSkills(skills) {
  const list = $('#skillList');
  list.replaceChildren();
  if (!skills.length) {
    list.innerHTML = '<p class="empty-list">没有可用技能</p>';
    return;
  }
  for (const skill of skills) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-item';
    button.innerHTML = `<strong>${escapeHtml(skill.name)}</strong>${skill.description ? `<small>${escapeHtml(skill.description)}</small>` : ''}`;
    button.addEventListener('click', () => insertSkill(skill.name));
    list.append(button);
  }
}

function insertSkill(name) {
  const input = $('#promptInput');
  const prefix = `$${name} `;
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${prefix}` : prefix;
  $('#skillSheet').close();
  resizeComposer();
  input.focus();
}

function handleCodex(message) {
  const { method, params = {} } = message;
  const threadId = params.threadId ?? params.thread_id ?? params.thread?.id;
  const turnId = params.turnId ?? params.turn_id;
  const itemId = params.itemId ?? params.item_id;
  if (method === 'thread/started' && params.thread?.cwd === state.currentProject) loadThreads().catch(() => {});
  if (!state.currentThread || threadId !== state.currentThread.id) return;
  if (method === 'turn/started') {
    const turn = params.turn ?? { id: turnId, status: 'inProgress', items: [] };
    state.activeTurnId = turn.id;
    if (state.pendingTurnMode) state.turnModes.set(turn.id, state.pendingTurnMode);
    const index = state.turns.findIndex((item) => item.id === turn.id);
    if (index >= 0) {
      const merged = { ...turn };
      if (!Array.isArray(merged.items) || merged.items.length === 0) delete merged.items;
      state.turns[index] = { ...state.turns[index], ...merged };
      state.timelineVersion += 1;
      renderTimeline();
    } else {
      state.turns.push(turn);
      state.timelineVersion += 1;
      state.pinnedToBottom = true;
      updateScrollLatestButton();
      appendTurnSection(turn);
    }
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'plan' && item.text == null) {
      item.text = item.payload?.text ?? item.content ?? '';
    }
    upsertItem(turnId, item);
    updateTimelineItem(turnId, item);
  } else if (method === 'item/agentMessage/delta') {
    const turn = ensureTurn(turnId);
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, type: 'agentMessage', text: '' }; turn.items.push(item); }
    item.text = `${item.text ?? ''}${params.delta ?? ''}`;
    updateTimelineItem(turnId, item);
  } else if (method === 'item/plan/delta') {
    const turn = ensureTurn(turnId);
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, type: 'plan', text: '' }; turn.items.push(item); }
    item.text = `${item.text ?? ''}${params.delta ?? params.text ?? ''}`;
    updateTimelineItem(turnId, item);
  } else if (method === 'item/commandExecution/outputDelta') {
    const turn = ensureTurn(turnId);
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, type: 'commandExecution', command: '执行命令', status: 'inProgress', aggregatedOutput: '' }; turn.items.push(item); }
    item.aggregatedOutput = `${item.aggregatedOutput ?? ''}${params.delta ?? ''}`;
    updateTimelineItem(turnId, item);
  } else if (method === 'turn/diff/updated') {
    const item = { id: `turn-diff-${turnId}`, type: 'turnDiff', diff: params.diff };
    upsertItem(turnId, item);
    updateTimelineItem(turnId, item);
  } else if (method === 'turn/plan/updated') {
    const rawPlan = params.plan ?? params.steps ?? params.plan?.steps ?? [];
    const item = {
      id: `structured-plan-${turnId}`,
      type: 'structuredPlan',
      explanation: params.explanation ?? params.summary ?? '',
      plan: rawPlan.map((entry) => ({
        step: entry.step ?? entry.text ?? entry.title ?? entry.description ?? '',
        status: entry.status ?? entry.state ?? 'pending',
      })),
    };
    upsertItem(turnId, item);
    updateTimelineItem(turnId, item);
  } else if (method === 'turn/completed') {
    const completed = params.turn ?? { status: 'completed' };
    const turn = ensureTurn(completed?.id ?? turnId);
    const merged = { ...completed, status: 'completed' };
    const incomingItems = Array.isArray(completed.items) && completed.items.length ? completed.items : null;
    if (incomingItems) merged.items = incomingItems;
    else delete merged.items;
    Object.assign(turn, merged);
    state.activeTurnId = null;
    state.pendingTurnMode = null;
    state.timelineVersion += 1;
    renderTimeline();
    renderPlanDecision();
    refreshCurrentThread({ force: true, seq: state.threadLoadSeq }).catch(() => renderTimeline(false, true));
  }
}

function approvalTitle(method) {
  if (method.includes('commandExecution') || method === 'execCommandApproval') return '允许执行命令？';
  if (method.includes('fileChange') || method === 'applyPatchApproval') return '允许修改文件？';
  if (method.includes('permissions')) return 'Codex 需要额外权限';
  if (method.includes('requestUserInput')) return 'Codex 正在等你的回答';
  return 'Codex 请求确认';
}

function isQuestionRequest(request) {
  return request?.method === 'item/tool/requestUserInput' || request?.method?.endsWith('/requestUserInput');
}

function questionHtml(question, requestId) {
  const questionId = escapeHtml(question.id);
  const inputName = `question-${escapeHtml(requestId)}-${questionId}`;
  const options = Array.isArray(question.options) ? question.options : [];
  let control;
  if (options.length) {
    const choices = options.map((option) => `<label class="question-option"><input type="radio" name="${inputName}" value="${escapeHtml(option.label)}"><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span></label>`).join('');
    const other = question.isOther
      ? `<label class="question-option other"><input type="radio" name="${inputName}" value="__other__"><span><strong>其他</strong><small>输入自己的回答</small></span></label><input class="question-other" type="${question.isSecret ? 'password' : 'text'}" autocomplete="off" placeholder="请输入其他回答">`
      : '';
    control = `<div class="question-options">${choices}${other}</div>`;
  } else {
    control = `<textarea class="question-freeform" rows="3" ${question.isSecret ? 'data-secret="true"' : ''} autocomplete="off" placeholder="请输入回答"></textarea>`;
  }
  return `<fieldset class="question-block" data-question="${questionId}"><legend><span>${escapeHtml(question.header || '问题')}</span>${escapeHtml(question.question)}</legend>${control}<p class="question-error" hidden>请先完成这个问题</p></fieldset>`;
}

function renderApprovals() {
  const stack = $('#approvalStack');
  stack.replaceChildren();
  const head = document.createElement('div');
  head.className = 'approval-drawer-head';
  head.innerHTML = '<i></i><strong>Codex 需要你处理</strong>';
  const scroll = document.createElement('div');
  scroll.className = 'approval-drawer-scroll';
  for (const request of state.approvals.values()) {
    const params = request.params ?? {};
    const card = document.createElement('article');
    card.className = 'approval-card';
    card.dataset.requestId = request.id;
    const command = Array.isArray(params.command) ? params.command.join(' ') : (params.command ?? '');
    const questionRequest = isQuestionRequest(request);
    const questions = questionRequest
      ? (params.questions ?? []).map((question) => questionHtml(question, request.id)).join('')
      : '';
    const autoResolution = params.autoResolutionMs
      ? `若不回答，Codex 会在约 ${Math.ceil(params.autoResolutionMs / 1000)} 秒后自行继续。`
      : '';
    const summary = params.reason || params.cwd || autoResolution || '请在手机端确认后，Codex 才会继续。';
    card.innerHTML = `<div class="approval-head"><span class="approval-symbol">!</span><div><h3>${escapeHtml(approvalTitle(request.method))}</h3><p>${escapeHtml(summary)}</p></div></div>${command ? `<div class="approval-command">${escapeHtml(command)}</div>` : ''}${questions}<div class="approval-actions"></div>`;
    const actions = card.querySelector('.approval-actions');
    if (questionRequest) {
      actions.append(actionButton('提交回答', 'answer', true));
    } else {
      actions.append(actionButton('拒绝', 'decline'));
      actions.append(actionButton('本次允许', 'accept', true));
      actions.append(actionButton('本会话允许', 'acceptForSession'));
    }
    for (const button of actions.querySelectorAll('button')) {
      button.addEventListener('click', () => respondApproval(request, button.dataset.action, card));
    }
    for (const option of card.querySelectorAll('.question-option')) {
      option.addEventListener('click', () => {
        option.closest('.question-block')?.classList.remove('invalid');
        if (option.classList.contains('other')) option.parentElement.querySelector('.question-other')?.focus();
      });
    }
    for (const input of card.querySelectorAll('.question-freeform, .question-other')) {
      input.addEventListener('input', () => input.closest('.question-block')?.classList.remove('invalid'));
    }
    scroll.append(card);
  }
  stack.append(head, scroll);
  stack.classList.toggle('visible', state.approvals.size > 0);
  document.body.classList.toggle('approval-open', state.approvals.size > 0);
  if (state.approvals.size) {
    requestAnimationFrame(() => scroll.querySelector('input, textarea, button')?.focus({ preventScroll: true }));
  }
}

function actionButton(label, action, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = label;
  if (primary) button.className = 'allow';
  return button;
}

async function respondApproval(request, action, card) {
  try {
    const body = { action };
    if (action === 'answer') {
      const answers = {};
      let valid = true;
      for (const block of card.querySelectorAll('.question-block')) {
        const selected = block.querySelector('input[type="radio"]:checked');
        const freeform = block.querySelector('.question-freeform');
        const value = selected?.value === '__other__'
          ? block.querySelector('.question-other')?.value.trim()
          : (selected?.value ?? freeform?.value.trim() ?? '');
        const complete = Boolean(value);
        block.classList.toggle('invalid', !complete);
        block.querySelector('.question-error').hidden = complete;
        if (!complete) valid = false;
        else answers[block.dataset.question] = [value];
      }
      if (!valid) {
        card.querySelector('.question-block.invalid input, .question-block.invalid textarea')?.focus();
        toast('请完成所有问题', 'error');
        return;
      }
      body.answers = answers;
    }
    card.querySelectorAll('button, input, textarea').forEach((element) => { element.disabled = true; });
    await post(`/api/requests/${encodeURIComponent(request.id)}/respond`, body);
    state.approvals.delete(request.id);
    renderApprovals();
    toast(action === 'decline' ? '已拒绝' : '已提交');
  } catch (error) {
    card.querySelectorAll('button, input, textarea').forEach((element) => { element.disabled = false; });
    toast(error.message, 'error');
  }
}

async function syncPendingRequests() {
  const result = await api('/api/requests');
  const fresh = new Map((result.data ?? []).map((request) => [request.id, request]));
  for (const [id, request] of state.approvals) {
    if (!fresh.has(id)) fresh.set(id, request);
  }
  state.approvals = fresh;
  renderApprovals();
}

function sameArtifactSet(left, right) {
  if (left.length !== right.length) return false;
  const seen = new Map();
  for (const item of left) seen.set(item.id, `${item.available ? 1 : 0}:${item.token ? 1 : 0}`);
  for (const item of right) {
    if (seen.get(item.id) !== `${item.available ? 1 : 0}:${item.token ? 1 : 0}`) return false;
  }
  return true;
}

async function loadArtifacts(expectedThreadId = state.currentThread?.id) {
  if (!expectedThreadId) {
    setArtifacts([]);
    renderArtifacts();
    return;
  }
  const result = await api(`/api/threads/${encodeURIComponent(expectedThreadId)}/artifacts`);
  if (expectedThreadId !== state.currentThread?.id) return;
  const next = result.data ?? [];
  setArtifacts(next);
  renderArtifacts();
  refreshTimelineAfterArtifacts();
}

function artifactPinKey(artifact) {
  return `${artifact.threadId ?? 'thread'}:${artifact.relativePath ?? artifact.name ?? artifact.id ?? ''}`;
}

function pinnedArtifactKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_ARTIFACTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toggleArtifactPin(artifact) {
  const key = artifactPinKey(artifact);
  const current = pinnedArtifactKeys();
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  localStorage.setItem(PINNED_ARTIFACTS_KEY, JSON.stringify(next));
  renderArtifacts();
}

function rankArtifacts(artifacts, pinnedKeys) {
  return artifacts.map((artifact) => ({
    artifact,
    pinned: pinnedKeys.has(artifactPinKey(artifact)),
    deliverable: isDeliverableArtifact(artifact),
  })).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.deliverable !== b.deliverable) return a.deliverable ? -1 : 1;
    return artifactSortTime(b.artifact) - artifactSortTime(a.artifact);
  });
}

function createArtifactCard(artifact, pinnedKeys) {
  const card = document.createElement('article');
  const pinned = pinnedKeys.has(artifactPinKey(artifact));
  card.className = `artifact-card ${artifact.available ? '' : 'deleted'}${pinned ? ' pinned' : ''}`;
  card.innerHTML = `<span class="file-icon">${escapeHtml(artifact.fileKind.slice(0, 4))}</span><div><strong>${escapeHtml(artifact.name)}</strong><small>${escapeHtml(artifact.status)} · ${escapeHtml(artifact.relativePath)}</small></div><div class="artifact-actions"><button type="button" class="pin-button${pinned ? ' pinned' : ''}" data-action="pin" data-artifact-id="${escapeHtml(artifact.id)}" aria-pressed="${pinned}" title="${pinned ? '取消置顶' : '置顶'}">📌</button><button data-action="preview" data-artifact-id="${escapeHtml(artifact.id)}" ${artifact.available ? '' : 'disabled'}>预览</button></div>`;
  return card;
}

function renderArtifacts() {
  const list = $('#artifactList');
  const query = state.artifactQuery.trim().toLowerCase();
  const pinnedArray = pinnedArtifactKeys();
  const pinnedKeys = new Set(pinnedArray);
  const renderKey = `${query}|${state.artifactOtherShown}|${pinnedArray.sort().join('\u0001')}`;
  if (state.artifactsRenderedVersion === state.artifactsVersion && state.artifactsRenderKey === renderKey) return;
  state.artifactsRenderKey = renderKey;
  state.artifactsRenderedVersion = state.artifactsVersion;
  list.replaceChildren();
  $('#artifactBadge').hidden = !state.artifacts.length;
  if (!state.artifacts.length) {
    list.innerHTML = '<div class="empty-list">当前会话还没有可展示的产出物。<br>Codex 修改或生成文件后会自动出现在这里。</div>';
    return;
  }
  let items = state.artifacts;
  if (query) {
    items = items.filter((artifact) => `${artifact.name} ${artifact.relativePath ?? ''}`.toLowerCase().includes(query));
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty-list">没有匹配“${escapeHtml(state.artifactQuery.trim())}”的产出物。<br>换个关键词试试。</div>`;
    return;
  }
  const ranked = rankArtifacts(items, pinnedKeys);
  const groups = [
    { label: '置顶', match: (entry) => entry.pinned },
    { label: '文档产出', match: (entry) => !entry.pinned && entry.deliverable },
    { label: '其他文件', match: (entry) => !entry.pinned && !entry.deliverable },
  ];
  for (const group of groups) {
    const entries = ranked.filter(group.match);
    if (!entries.length) continue;
    const header = document.createElement('div');
    header.className = 'artifact-section';
    header.textContent = group.label;
    list.append(header);
    const shown = group.label === '其他文件' ? entries.slice(0, state.artifactOtherShown) : entries;
    for (const entry of shown) list.append(createArtifactCard(entry.artifact, pinnedKeys));
    if (entries.length > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'artifact-more';
      more.dataset.action = 'more';
      more.textContent = `还有 ${entries.length - shown.length} 条 · 显示更多`;
      list.append(more);
    }
  }
}

function refreshTimelineAfterArtifacts() {
  if (document.querySelector('.view.active')?.dataset.view === 'chat') updateTurnArtifactsStrips();
}

async function openArtifact(artifact) {
  if (!artifact.token) return;
  const body = $('#previewBody');
  try {
    const token = encodeURIComponent(artifact.token);
    const meta = await api(`/api/artifacts/${token}/meta`);
    state.currentArtifact = artifact;
    $('#previewKind').textContent = `${meta.fileKind} · ${formatBytes(meta.size)}`;
    $('#previewTitle').textContent = meta.name;
    const raw = `/api/artifacts/${token}/raw`;
    body.className = 'preview-body';
    body.replaceChildren();
    body.innerHTML = '<div class="preview-loading"><span></span>正在准备预览…</div>';
    $('#downloadArtifactButton').href = `${raw}?download=1`;
    $('#downloadArtifactButton').download = meta.name;
    if (!$('#previewDialog').open) $('#previewDialog').showModal();
    if (meta.fileKind === 'markdown' || meta.fileKind === 'text') {
      const response = await fetch(raw, { credentials: 'same-origin' });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.message || '文件读取失败');
      }
      const text = await response.text();
      body.innerHTML = meta.fileKind === 'markdown' ? `<article class="agent-card">${markdown(text)}</article>` : `<pre>${escapeHtml(text)}</pre>`;
    } else if (meta.fileKind === 'image') {
      body.innerHTML = `<img src="${raw}" alt="${escapeHtml(meta.name)}">`;
    } else if (meta.fileKind === 'office' && meta.name.toLowerCase().endsWith('.xlsx')) {
      try {
        await renderSpreadsheetPreview(token, meta, body);
      } catch (error) {
        toast(`表格预览不可用，已切换版式：${error.message}`);
        await renderDocumentPreview(token, meta, body);
      }
    } else if (meta.fileKind === 'pdf' || meta.fileKind === 'office') {
      await renderDocumentPreview(token, meta, body);
    } else if (meta.fileKind === 'html') {
      body.innerHTML = `<iframe sandbox="" src="${raw}" title="${escapeHtml(meta.name)}"></iframe>`;
    } else if (meta.fileKind === 'audio') {
      body.innerHTML = `<audio controls src="${raw}"></audio>`;
    } else if (meta.fileKind === 'video') {
      body.innerHTML = `<video controls playsinline src="${raw}"></video>`;
    } else {
      body.innerHTML = '<div class="empty-list">此类型不能内嵌预览，可以下载后查看。</div>';
    }
  } catch (error) {
    if ($('#previewDialog').open) {
      body.className = 'preview-body';
      body.innerHTML = `<div class="preview-error"><strong>预览失败</strong><span>${escapeHtml(error.message)}</span><small>可以先下载原文件查看。</small></div>`;
    }
    toast(error.message, 'error');
  }
}

function previewModeBar(activeMode, onSpreadsheet, onDocument) {
  const bar = document.createElement('div');
  bar.className = 'preview-mode-bar';
  const spreadsheet = document.createElement('button');
  spreadsheet.type = 'button';
  spreadsheet.textContent = '表格';
  spreadsheet.classList.toggle('active', activeMode === 'spreadsheet');
  spreadsheet.addEventListener('click', onSpreadsheet);
  const documentButton = document.createElement('button');
  documentButton.type = 'button';
  documentButton.textContent = '版式';
  documentButton.classList.toggle('active', activeMode === 'document');
  documentButton.addEventListener('click', onDocument);
  bar.append(spreadsheet, documentButton);
  return bar;
}

function spreadsheetColumnName(column) {
  let value = column;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function applySpreadsheetStyle(cell, style = {}) {
  if (/^#[0-9a-f]{6}$/i.test(style.background ?? '')) cell.style.backgroundColor = style.background;
  if (/^#[0-9a-f]{6}$/i.test(style.color ?? '')) cell.style.color = style.color;
  if (style.bold) cell.style.fontWeight = '700';
  if (style.italic) cell.style.fontStyle = 'italic';
  if (['left', 'center', 'right', 'justify'].includes(style.horizontal)) cell.style.textAlign = style.horizontal;
  if (['top', 'center', 'bottom'].includes(style.vertical)) cell.style.verticalAlign = style.vertical === 'center' ? 'middle' : style.vertical;
  if (style.wrap) cell.classList.add('wrap');
  if (style.border) cell.classList.add('styled-border');
}

function renderWorksheetTable(worksheet, viewport, status) {
  const mergeStarts = new Map();
  const covered = new Set();
  for (const merge of worksheet.merges ?? []) {
    mergeStarts.set(`${merge.startRow}:${merge.startColumn}`, merge);
    for (let row = merge.startRow; row <= merge.endRow; row += 1) {
      for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
        if (row !== merge.startRow || column !== merge.startColumn) covered.add(`${row}:${column}`);
      }
    }
  }
  const table = document.createElement('table');
  table.className = 'spreadsheet-table';
  table.style.width = `${46 + (worksheet.widths ?? []).reduce((sum, width) => sum + (Number(width) || 76), 0)}px`;
  const columns = document.createElement('colgroup');
  const rowNumberColumn = document.createElement('col');
  rowNumberColumn.style.width = '46px';
  columns.append(rowNumberColumn);
  for (const width of worksheet.widths ?? []) {
    const column = document.createElement('col');
    column.style.width = `${Number(width) || 76}px`;
    columns.append(column);
  }
  table.append(columns);
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  heading.append(document.createElement('th'));
  for (let column = 1; column <= worksheet.renderedColumns; column += 1) {
    const header = document.createElement('th');
    header.textContent = spreadsheetColumnName(column);
    heading.append(header);
  }
  head.append(heading);
  table.append(head);
  const body = document.createElement('tbody');
  for (let row = 1; row <= worksheet.renderedRows; row += 1) {
    const tableRow = document.createElement('tr');
    tableRow.style.height = `${worksheet.heights?.[row - 1] ?? 24}px`;
    const rowNumber = document.createElement('th');
    rowNumber.textContent = String(row);
    tableRow.append(rowNumber);
    for (let column = 1; column <= worksheet.renderedColumns; column += 1) {
      if (covered.has(`${row}:${column}`)) continue;
      const cell = document.createElement('td');
      const [value = '', styleIndex = 0] = worksheet.data?.[row - 1]?.[column - 1] ?? [];
      cell.textContent = value;
      const merge = mergeStarts.get(`${row}:${column}`);
      if (merge) {
        cell.rowSpan = merge.endRow - merge.startRow + 1;
        cell.colSpan = merge.endColumn - merge.startColumn + 1;
      }
      applySpreadsheetStyle(cell, worksheet.styles?.[styleIndex]);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(body);
  viewport.replaceChildren(table);
  status.textContent = `${worksheet.name} · ${worksheet.rows} 行 × ${worksheet.columns} 列`;
  if (worksheet.truncated) {
    const notice = document.createElement('div');
    notice.className = 'spreadsheet-truncated';
    notice.textContent = `在线展示前 ${worksheet.renderedRows} 行、${worksheet.renderedColumns} 列；完整内容请下载或切换版式查看。`;
    viewport.append(notice);
  }
}

async function renderSpreadsheetPreview(token, meta, body) {
  body.className = 'preview-body spreadsheet-preview';
  body.innerHTML = '<div class="preview-loading"><span></span>正在读取工作表…</div>';
  const workbook = await api(`/api/artifacts/${token}/workbook`);
  if (!workbook.sheets?.length) throw new Error('工作簿没有可预览的工作表');
  const shell = document.createElement('div');
  shell.className = 'spreadsheet-shell';
  const controls = document.createElement('div');
  controls.className = 'spreadsheet-controls';
  controls.append(previewModeBar(
    'spreadsheet',
    () => {},
    () => renderDocumentPreview(token, meta, body).catch((error) => toast(error.message, 'error')),
  ));
  const status = document.createElement('span');
  status.className = 'spreadsheet-status';
  controls.append(status);
  const tabs = document.createElement('div');
  tabs.className = 'sheet-tabs';
  const viewport = document.createElement('div');
  viewport.className = 'spreadsheet-viewport';
  shell.append(controls, tabs, viewport);
  body.replaceChildren(shell);
  const loadSheet = async (sheet) => {
    tabs.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.sheet) === sheet.index);
      button.disabled = true;
    });
    status.textContent = `正在读取 ${sheet.name}…`;
    viewport.innerHTML = '<div class="preview-loading"><span></span>正在加载单元格…</div>';
    try {
      const worksheet = await api(`/api/artifacts/${token}/workbook/sheets/${sheet.index}`);
      renderWorksheetTable(worksheet, viewport, status);
    } finally {
      tabs.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  };
  for (const sheet of workbook.sheets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sheet = sheet.index;
    button.textContent = sheet.name;
    button.title = `${sheet.rows} 行 × ${sheet.columns} 列${sheet.hidden ? ' · 已隐藏' : ''}`;
    if (sheet.hidden) button.classList.add('hidden-sheet');
    button.addEventListener('click', () => loadSheet(sheet).catch((error) => toast(error.message, 'error')));
    tabs.append(button);
  }
  await loadSheet(workbook.sheets.find((sheet) => !sheet.hidden) ?? workbook.sheets[0]);
}

async function renderDocumentPreview(token, meta, body) {
  body.className = 'preview-body document-preview';
  const info = await api(`/api/artifacts/${token}/document`);
  const pages = document.createElement('div');
  pages.className = 'document-pages';
  for (let pageNumber = 1; pageNumber <= info.pages; pageNumber += 1) {
    const page = document.createElement('figure');
    page.className = 'document-page';
    const image = document.createElement('img');
    image.alt = `${meta.name} 第 ${pageNumber} 页`;
    image.loading = pageNumber <= 2 ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.src = `/api/artifacts/${token}/document/pages/${pageNumber}`;
    const caption = document.createElement('figcaption');
    caption.textContent = `${pageNumber} / ${info.totalPages}`;
    image.addEventListener('load', () => page.classList.add('is-loaded'));
    image.addEventListener('error', () => {
      page.classList.add('is-failed');
      caption.textContent = `第 ${pageNumber} 页加载失败，点按重试`;
    });
    page.addEventListener('click', () => {
      if (!page.classList.contains('is-failed')) return;
      page.classList.remove('is-failed');
      caption.textContent = `${pageNumber} / ${info.totalPages}`;
      image.src = `/api/artifacts/${token}/document/pages/${pageNumber}?retry=${Date.now()}`;
    });
    page.append(image, caption);
    pages.append(page);
  }
  body.replaceChildren();
  if (meta.name.toLowerCase().endsWith('.xlsx')) {
    body.append(previewModeBar(
      'document',
      () => renderSpreadsheetPreview(token, meta, body).catch((error) => toast(error.message, 'error')),
      () => {},
    ));
  }
  body.append(pages);
  if (info.truncated) {
    const notice = document.createElement('div');
    notice.className = 'document-truncated';
    notice.textContent = `文档共 ${info.totalPages} 页，在线预览前 ${info.pages} 页；完整内容请下载查看。`;
    body.append(notice);
  }
}

function modifyCurrentArtifact() {
  const artifact = state.currentArtifact;
  if (!artifact) return;
  if (!state.selectedMentions.includes(artifact.relativePath)) state.selectedMentions.push(artifact.relativePath);
  renderMentions();
  $('#previewDialog').close();
  showTab('chat');
  $('#promptInput').value = `请修改 ${artifact.name}：`;
  resizeComposer();
  $('#promptInput').focus();
}

function renderMentions() {
  const tray = $('#mentionTray');
  tray.replaceChildren();
  for (const mention of state.selectedMentions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mention-chip';
    button.textContent = `@${mention} ×`;
    button.addEventListener('click', () => {
      state.selectedMentions = state.selectedMentions.filter((item) => item !== mention);
      renderMentions();
    });
    tray.append(button);
  }
}

async function sendPrompt(event) {
  event.preventDefault();
  const input = $('#promptInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentThread) await newThread();
  if (!state.currentThread) return;
  const body = {
    text,
    cwd: state.currentProject,
    mentions: state.selectedMentions,
    model: effectiveModel(),
    effort: $('#effortSelect').value || undefined,
    mode: state.mode,
    approvalsReviewer: state.approvalsReviewer,
  };
  input.value = '';
  state.selectedMentions = [];
  renderMentions();
  resizeComposer();
  saveUiState();
  $('#sendButton').disabled = true;
  try {
    let result;
    if (state.activeTurnId) {
      result = await post(`/api/threads/${encodeURIComponent(state.currentThread.id)}/steer`, { ...body, turnId: state.activeTurnId });
      toast('已追加到当前任务');
    } else {
      state.pendingTurnMode = state.mode;
      result = await post(`/api/threads/${encodeURIComponent(state.currentThread.id)}/turns`, body);
      if (result.thread) {
        state.currentThread = result.thread;
        state.currentProject = result.thread.cwd;
        localStorage.setItem('codex-mobile-project', state.currentProject);
        $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
        renderThreads();
        if (result.recreated) {
          state.turns = [];
          state.turnsNextCursor = null;
          state.timelineVersion += 1;
          state.questionCursor = 0;
          state.turnModes.clear();
          toast('原会话在 Codex 重启后失效，已自动重建并继续执行');
        }
      }
      const turnExisted = state.turns.some((item) => item.id === result.turn.id);
      const turn = ensureTurn(result.turn.id);
      const existingItems = turn.items ?? [];
      const existingStatus = turn.status;
      Object.assign(turn, result.turn);
      if (existingStatus === 'completed' || turn.status === 'completed') {
        turn.status = 'completed';
        state.activeTurnId = null;
      } else {
        state.activeTurnId = result.turn.id;
      }
      state.turnModes.set(result.turn.id, body.mode);
      if (Array.isArray(result.turn.items)) {
        const freshIds = new Set(result.turn.items.map((item) => item.id));
        const extra = existingItems.filter((item) => !freshIds.has(item.id));
        turn.items = dedupeItems(extra.length ? [...result.turn.items, ...extra] : result.turn.items);
      }
      const localUserItem = { id: `local-${Date.now()}`, type: 'userMessage', content: [{ type: 'text', text }] };
      upsertItem(result.turn.id, localUserItem);
      if (turnExisted) {
        updateTimelineItem(result.turn.id, localUserItem);
      } else {
        state.timelineVersion += 1;
        appendTurnSection(turn);
      }
      state.pinnedToBottom = true;
      updateScrollLatestButton();
      scrollTimelineToBottom();
      state.questionCursor = 0;
    }
  } catch (error) {
    state.pendingTurnMode = null;
    input.value = text;
    renderModeControls();
    renderPlanDecision();
    toast(error.message, 'error');
  } finally {
    $('#sendButton').disabled = false;
  }
}

function refinePlan() {
  if (!setMode('plan')) return;
  const input = $('#promptInput');
  if (!input.value.trim()) input.value = '请继续完善方案，重点补充：';
  resizeComposer();
  input.focus();
}

function executePlan() {
  if (!setMode('default')) return;
  const input = $('#promptInput');
  input.value = '请按照刚刚确认的方案开始实施。实施过程中按计划更新进度，并完成必要验证。';
  resizeComposer();
  $('#planDecisionBar').hidden = true;
  $('#composer').requestSubmit();
}

async function interruptTurn() {
  if (!state.currentThread || !state.activeTurnId) return;
  try {
    await post(`/api/threads/${encodeURIComponent(state.currentThread.id)}/turns/${encodeURIComponent(state.activeTurnId)}/interrupt`);
    toast('正在停止');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function showTab(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  if (name === 'chat') renderTimeline(false);
  if (name === 'artifacts') loadArtifacts().catch((error) => toast(error.message, 'error'));
  if (name === 'projects' && state.projectBrowser) renderProjects(state.projectBrowser);
  updateJumpButton();
  saveUiState();
}

function connectEvents() {
  state.events?.close();
  const events = new EventSource('/api/events');
  state.events = events;
  events.onopen = () => {
    setConnection('online', '已连接');
    syncPendingRequests().catch(() => {});
    if (state.currentThread && !state.activeTurnId) refreshCurrentThread().catch(() => {});
  };
  events.onerror = () => setConnection('offline', '正在重连');
  events.addEventListener('bridge-status', (event) => {
    const status = JSON.parse(event.data);
    setConnection(status.ready ? 'online' : 'connecting', status.ready ? '已连接' : 'Codex 重启中');
  });
  events.addEventListener('bridge-error', (event) => toast(JSON.parse(event.data).message, 'error'));
  events.addEventListener('codex', (event) => handleCodex(JSON.parse(event.data)));
  events.addEventListener('approval', (event) => {
    const request = JSON.parse(event.data);
    state.approvals.set(request.id, request);
    for (const selector of ['#settingsSheet', '#skillSheet', '#previewDialog']) {
      const dialog = $(selector);
      if (dialog?.open) dialog.close();
    }
    showTab('chat');
    renderApprovals();
    navigator.vibrate?.([120, 60, 120]);
    toast('Codex 正在等待确认');
  });
  events.addEventListener('approval-resolved', (event) => {
    state.approvals.delete(JSON.parse(event.data).id);
    renderApprovals();
  });
  events.addEventListener('artifacts', (event) => {
    const data = JSON.parse(event.data);
    if (data.threadId === state.currentThread?.id) {
      const incoming = data.items ?? [];
      if (!incoming.length) return;
      const seen = new Set(incoming.map((item) => item.id));
      const next = [...incoming, ...state.artifacts.filter((item) => !seen.has(item.id))];
      if (setArtifacts(next)) {
        renderArtifacts();
        refreshTimelineAfterArtifacts();
        toast(`发现 ${incoming.length} 个产出物`);
      }
    }
  });
  for (const type of ['artifact-error', 'ownership-error']) {
    events.addEventListener(type, (event) => toast(JSON.parse(event.data).message || '产出物处理失败', 'error'));
  }
}

function resizeComposer() {
  const input = $('#promptInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}

$('#pairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#pairError').textContent = '';
  try {
    await post('/api/auth/pair', { code: $('#pairCode').value });
    $('#pairCode').value = '';
    showApp();
    await loadBootstrap();
    await restoreUiState().catch((error) => toast(error.message, 'error'));
    connectEvents();
  } catch (error) {
    $('#pairError').textContent = error.message;
  }
});
$('#composer').addEventListener('submit', sendPrompt);
$('#promptInput').addEventListener('input', () => {
  resizeComposer();
  scheduleUiStateSave();
});
$('#timeline').addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-question');
  if (!button) return;
  await copyText(button.dataset.copyText ?? '');
  toast('问题已复制');
});
$('#jumpQuestionButton').addEventListener('click', jumpToLatestQuestion);
$('#settingsButton').addEventListener('click', () => $('#settingsSheet').showModal());
$('#closeSettingsButton').addEventListener('click', () => $('#settingsSheet').close());
$('#skillButton').addEventListener('click', openSkillSheet);
$('#closeSkillButton').addEventListener('click', () => $('#skillSheet').close());
$('#promptInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.innerWidth > 780) sendPrompt(event);
});
$('#interruptButton').addEventListener('click', interruptTurn);
$('#fullscreenButton').addEventListener('click', (event) => {
  event.stopPropagation();
  suppressControlClick = false;
  toggleFullscreen();
  closeFullscreenPopover();
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#fullscreenPopover')) closeFullscreenPopover();
});
const controlButton = document.querySelector('.bottom-nav button.nav-primary');
if (controlButton) {
  const cancelFullscreenPress = () => clearTimeout(fullscreenPressTimer);
  controlButton.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearTimeout(fullscreenPressTimer);
    suppressControlClick = false;
    fullscreenPressTimer = setTimeout(() => {
      suppressControlClick = true;
      openFullscreenPopover();
    }, 450);
  });
  controlButton.addEventListener('pointermove', cancelFullscreenPress);
  controlButton.addEventListener('pointerup', cancelFullscreenPress);
  controlButton.addEventListener('pointercancel', cancelFullscreenPress);
  controlButton.addEventListener('pointerleave', cancelFullscreenPress);
}
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
$$('#modeSwitch button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#approvalReviewerSelect').addEventListener('change', (event) => {
  state.approvalsReviewer = ['auto_review', 'user', 'never'].includes(event.target.value) ? event.target.value : 'never';
  localStorage.setItem('codex-mobile-approvals-reviewer', state.approvalsReviewer);
  renderModeControls();
});
$('#modelSelect').addEventListener('change', (event) => {
  state.model = event.target.value;
  localStorage.setItem('codex-mobile-model', state.model);
});
$('#effortSelect').addEventListener('change', (event) => {
  state.effort = event.target.value;
  localStorage.setItem('codex-mobile-effort', state.effort);
});
$('#refinePlanButton').addEventListener('click', refinePlan);
$('#executePlanButton').addEventListener('click', executePlan);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncPendingRequests().catch(() => {});
});
$('#mobileNewThreadButton').addEventListener('click', newThread);
$('#refreshThreadsButton').addEventListener('click', () => loadThreads().catch((error) => toast(error.message, 'error')));
$('#refreshArtifactsButton').addEventListener('click', () => loadArtifacts().catch((error) => toast(error.message, 'error')));
$('#loadOlderButton').addEventListener('click', () => loadOlderTurns().catch((error) => toast(error.message, 'error')));
initChatScroll();
let artifactSearchTimer = null;
$('#artifactSearch').addEventListener('input', (event) => {
  clearTimeout(artifactSearchTimer);
  artifactSearchTimer = setTimeout(() => {
    state.artifactQuery = event.target.value;
    state.artifactOtherShown = ARTIFACT_OTHER_PAGE;
    renderArtifacts();
  }, 120);
});
$('#artifactList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'more') {
    state.artifactOtherShown += ARTIFACT_OTHER_STEP;
    renderArtifacts();
    return;
  }
  const artifact = state.artifacts.find((item) => item.id === button.dataset.artifactId);
  if (!artifact) return;
  if (button.dataset.action === 'pin') toggleArtifactPin(artifact);
  else if (button.dataset.action === 'preview' && artifact.available) openArtifact(artifact);
});
$('#timeline').addEventListener('click', (event) => {
  const chip = event.target.closest('.turn-artifact-chip');
  if (chip) {
    const artifact = state.artifacts.find((item) => item.id === chip.dataset.artifactId);
    if (artifact) openArtifact(artifact);
    return;
  }
  if (event.target.closest('.turn-artifacts-more')) showTab('artifacts');
});
$('#projectUpButton').addEventListener('click', () => browseProjects(state.projectBrowser.parent).catch((error) => toast(error.message, 'error')));
$('#closePreviewButton').addEventListener('click', () => $('#previewDialog').close());
$('#modifyArtifactButton').addEventListener('click', modifyCurrentArtifact);
$$('.bottom-nav button').forEach((button) => button.addEventListener('click', () => {
  if (suppressControlClick) {
    suppressControlClick = false;
    return;
  }
  if (button.dataset.tab) showTab(button.dataset.tab);
}));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
initialize().catch((error) => {
  toast(error.message, 'error');
  showLogin();
});
