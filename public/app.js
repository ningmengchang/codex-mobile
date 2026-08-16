import { $, $$, toast } from './js/dom.js';
import { api, post } from './js/http.js';
import { escapeHtml, markdown, formatBytes, formatTime, formatDateTime, escapeAttribute } from './js/format.js';
import { renderMermaid, setMermaidTheme } from './js/mermaid-renderer.js';
import { initKeyboardInsets } from './js/keyboard.js';
import { initDingtalk, initFileShare, loadDingtalkMessages, openFileShare, startDingtalkPolling, stopDingtalkPolling } from './js/dingtalk.js';
import { initSkillMarket } from './js/skill-market.js';
import { debug } from './js/debug.js';
import {
  state,
  UI_STATE,
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
  isDocumentArtifact,
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

function applyTheme(theme, options = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  state.theme = next;
  document.documentElement.dataset.theme = next;
  $('#themeColorMeta').content = next === 'light' ? '#f3f5f7' : '#101318';
  $('#themeSelect').value = next;
  setMermaidTheme(next);
  if (options.persist) localStorage.setItem('codex-mobile-theme', next);
  if (options.rerender && state.currentThread) {
    state.timelineRenderedVersion = -1;
    renderTimeline(false);
  }
}

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
  $('#startupScreen').hidden = true;
  $('#app').hidden = true;
  $('#loginScreen').hidden = false;
  setTimeout(() => $('#pairCode').focus(), 50);
}

function showStartup(label = '正在恢复工作现场…') {
  $('#startupScreen').querySelector('p').textContent = label;
  $('#startupScreen').hidden = false;
  $('#loginScreen').hidden = true;
  $('#app').hidden = true;
}

function showApp() {
  $('#startupScreen').hidden = true;
  $('#loginScreen').hidden = true;
  $('#app').hidden = false;
  if (state.currentThread) {
    const chat = $('#chatView');
    chat.scrollTop = chat.scrollHeight;
    scrollTimelineToBottom();
  }
}

function setConnection(status, label) {
  const pill = $('#connectionStatus');
  pill.dataset.state = status;
  pill.querySelector('span').textContent = label;
}

function isFullscreenActive() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement || isDisplayModeFullscreen());
}

function isDisplayModeFullscreen() {
  return window.matchMedia?.('(display-mode: fullscreen)')?.matches === true;
}

let autoFullscreenFallbackBound = false;

function autoFullscreenFallback(event) {
  if (event.target.closest?.('#fullscreenButton')) return;
  unbindAutoFullscreenFallback();
  enterFullscreen();
}

function unbindAutoFullscreenFallback() {
  if (!autoFullscreenFallbackBound) return;
  autoFullscreenFallbackBound = false;
  document.removeEventListener('pointerdown', autoFullscreenFallback, true);
  document.removeEventListener('touchstart', autoFullscreenFallback, true);
  document.removeEventListener('keydown', autoFullscreenFallback, true);
}

function bindAutoFullscreenFallback() {
  if (autoFullscreenFallbackBound) return;
  autoFullscreenFallbackBound = true;
  document.addEventListener('pointerdown', autoFullscreenFallback, { capture: true });
  document.addEventListener('touchstart', autoFullscreenFallback, { capture: true });
  document.addEventListener('keydown', autoFullscreenFallback, { capture: true });
}

function enterFullscreen() {
  const enter = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (!enter) {
    toast('当前浏览器不支持全屏，添加到主屏幕可获得接近全屏体验');
    return Promise.resolve(false);
  }
  return Promise.resolve(enter.call(document.documentElement)).then(() => {
    unbindAutoFullscreenFallback();
    return true;
  }).catch(() => false);
}

function tryAutoFullscreen() {
  if (isFullscreenActive()) return;
  enterFullscreen().then((ok) => {
    if (!ok) bindAutoFullscreenFallback();
  });
}

function updateFullscreenButton() {
  const button = $('#fullscreenButton');
  if (!button) return;
  const active = isFullscreenActive();
  const icon = button.querySelector('i');
  if (icon) icon.textContent = active ? '⤢' : '⛶';
  button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  button.setAttribute('title', active ? '退出全屏' : '全屏');
  button.setAttribute('aria-pressed', String(active));
  const enterIcon = button.querySelector('#fullscreenIconEnter');
  const exitIcon = button.querySelector('#fullscreenIconExit');
  if (enterIcon) {
    if (active) enterIcon.setAttribute('hidden', '');
    else enterIcon.removeAttribute('hidden');
  }
  if (exitIcon) {
    if (active) exitIcon.removeAttribute('hidden');
    else exitIcon.setAttribute('hidden', '');
  }
  document.body.classList.toggle('fullscreen-active', active);
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  if (isDisplayModeFullscreen()) {
    toast('全屏模式下请用系统手势退出（下拉状态栏）');
    return;
  }
  enterFullscreen();
}

let uiStateTimer = null;

function isCompactNavigation() {
  return window.matchMedia?.('(max-width: 780px)')?.matches === true;
}

function navigationRoute() {
  const hash = window.location.hash.replace(/^#/, '');
  for (const view of ['chat', 'artifacts']) {
    const prefix = `${view}/`;
    if (!hash.startsWith(prefix)) continue;
    try { return { view, threadId: decodeURIComponent(hash.slice(prefix.length)) }; } catch { return { view: 'threads' }; }
  }
  if (['threads', 'favorites', 'artifacts', 'projects', 'chat'].includes(hash)) return { view: hash };
  return null;
}

function navigationHash(view, threadId = state.currentThread?.id) {
  return ['chat', 'artifacts'].includes(view) && threadId
    ? `#${view}/${encodeURIComponent(threadId)}`
    : `#${view}`;
}

function updateNavigationHistory(view, mode = 'none', threadId = state.currentThread?.id) {
  if (!isCompactNavigation() || mode === 'none') return;
  const contextual = ['chat', 'artifacts'].includes(view);
  const nextState = { codexMobile: true, view, threadId: contextual ? threadId ?? null : null };
  const hash = navigationHash(view, threadId);
  if (mode === 'replace') history.replaceState(nextState, '', hash);
  else if (window.location.hash !== hash) history.pushState(nextState, '', hash);
}

function saveUiState() {
  if (state.currentThread?.id) localStorage.setItem(UI_STATE.thread, state.currentThread.id);
  const activeTab = document.querySelector('.view.active')?.dataset.view;
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
  const route = navigationRoute();
  if (isCompactNavigation()) {
    if (route?.view === 'chat' && route.threadId) {
      showTab('threads', { history: 'replace' });
      await openThread(route.threadId, { history: 'push' });
    } else if (route?.view === 'artifacts' && route.threadId) {
      const opened = await openThread(route.threadId, { history: 'none' });
      if (opened) showTab('artifacts', { history: 'none', threadId: route.threadId });
      else showTab('threads', { history: 'replace' });
    } else if (route?.view === 'favorites' || (!route && savedTab === 'favorites')) {
      state.threadFavoriteOnly = true;
      showTab('threads', { history: 'replace' });
    } else {
      showTab('threads', { history: 'replace' });
    }
    if (savedDraft && state.currentThread?.id === savedThreadId) {
      $('#promptInput').value = savedDraft;
      resizeComposer();
    }
    saveUiState();
    return;
  }
  if (savedThreadId) {
    try {
      const opened = await openThread(savedThreadId, { history: 'none' });
      if (!opened) throw new Error('保存的会话无法恢复');
    } catch {
      localStorage.removeItem(UI_STATE.thread);
      sessionStorage.removeItem(UI_STATE.draft);
    }
  }
  const activeView = document.querySelector('.view.active')?.dataset.view;
  if (['chat', 'threads', 'projects', 'favorites'].includes(savedTab) && savedTab !== activeView) {
    showTab(savedTab);
  }
  const input = $('#promptInput');
  if (savedDraft && state.currentThread?.id === savedThreadId) {
    input.value = savedDraft;
    resizeComposer();
  }
  saveUiState();
}

async function initialize() {
  applyTheme(state.theme);
  const auth = await api('/api/auth/status');
  if (!auth.authenticated) {
    showLogin();
    return;
  }
  showStartup();
  const { threadsPromise, favoritesPromise } = await loadBootstrap();
  void loadRuntimeCatalogs();
  await Promise.all([
    threadsPromise.catch((error) => toast(error.message, 'error')),
    favoritesPromise.catch((error) => toast(error.message, 'error')),
    restoreUiState().catch((error) => toast(error.message, 'error')),
  ]);
  showApp();
  connectEvents();
  tryAutoFullscreen();
}

async function loadBootstrap() {
  setConnection('connecting', '连接中');
  state.bootstrap = await api('/api/bootstrap');
  const runtimeParts = [state.bootstrap.runtime.user, 'SSH'];
  if (state.bootstrap.runtime.codexHome) runtimeParts.push(state.bootstrap.runtime.codexHome);
  $('#settingsRuntime').textContent = runtimeParts.join(' · ');
  setConnection(state.bootstrap.appServer.ready ? 'online' : 'connecting', state.bootstrap.appServer.ready ? '已连接' : 'Codex 启动中');
  for (const request of state.bootstrap.pendingRequests ?? []) state.approvals.set(request.id, request);
  for (const activity of state.bootstrap.threadActivities ?? []) applyThreadActivity(activity, { render: false });
  renderApprovals();
  renderModels();
  renderModeControls();
  const initialProject = state.currentProject || state.bootstrap.projects.current.path;
  state.currentProject = initialProject;
  localStorage.setItem('codex-mobile-project', initialProject);
  $('#currentProjectName').textContent = initialProject.split('/').filter(Boolean).at(-1) || initialProject;
  if (initialProject === state.bootstrap.projects.current.path) renderProjects(state.bootstrap.projects);
  else state.projectBrowser = null;
  return {
    threadsPromise: loadThreads(),
    favoritesPromise: loadFavoriteThreads(state.bootstrap.favorites),
  };
}

async function loadRuntimeCatalogs() {
  try {
    const result = await api('/api/catalogs');
    if (!state.bootstrap) return;
    state.bootstrap.account = result.account;
    state.bootstrap.models = result.models ?? [];
    state.bootstrap.collaborationModes = result.collaborationModes ?? [];
    state.bootstrap.defaultModel = result.defaultModel ?? state.bootstrap.defaultModel;
    state.bootstrap.defaultEffort = result.defaultEffort ?? state.bootstrap.defaultEffort;
    renderModels();
    renderModeControls();
  } catch (error) {
    debug.log('bootstrap', 'catalog-background-failed', { message: error.message });
  }
}

function renderModels() {
  const select = $('#modelSelect');
  select.replaceChildren();
  const availableModelIds = new Set();
  for (const model of state.bootstrap.models ?? []) {
    const id = model.id ?? model.model ?? model.slug;
    if (!id) continue;
    availableModelIds.add(id);
    select.add(new Option(model.displayName ?? model.display_name ?? id, id));
  }

  const configuredDefault = state.bootstrap?.defaultModel || '';
  const catalogDefault = availableModelIds.has(configuredDefault)
    ? configuredDefault
    : ([...availableModelIds][0] || configuredDefault);
  const savedModelAvailable = Boolean(state.model && availableModelIds.has(state.model));

  if (availableModelIds.size && state.model && !savedModelAvailable) {
    state.model = null;
    localStorage.removeItem('codex-mobile-model');
  }

  const selectedModel = savedModelAvailable ? state.model : catalogDefault;
  if (selectedModel && !availableModelIds.has(selectedModel)) {
    select.add(new Option(selectedModel, selectedModel));
  }
  select.value = selectedModel || '';
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

function setCurrentProjectDirectory(projectPath, options = {}) {
  if (!projectPath) return false;
  const changed = state.currentProject !== projectPath;
  state.currentProject = projectPath;
  localStorage.setItem('codex-mobile-project', projectPath);
  $('#currentProjectName').textContent = projectPath.split('/').filter(Boolean).at(-1) || projectPath;
  if (options.clearConversation && state.currentThread?.cwd !== projectPath) {
    state.currentThread = null;
    state.turns = [];
    state.turnsNextCursor = null;
    state.activeTurnId = null;
    state.pendingTurnMode = null;
    state.turnModes.clear();
    state.questionCursor = 0;
    state.selectedMentions = [];
    state.currentArtifact = null;
    localStorage.removeItem(UI_STATE.thread);
    clearArtifactState();
    state.timelineVersion += 1;
    renderMentions();
    renderArtifacts();
    renderTimeline();
    renderChatHeader();
    updateScrollLatestButton();
    updateLoadOlderButton();
  }
  return changed;
}

async function selectProject(projectPath, userInitiated = true) {
  try {
    setCurrentProjectDirectory(projectPath, { clearConversation: userInitiated });
    await loadThreads();
    if (userInitiated) {
      if (state.pendingCodexMessage) {
        const draft = state.pendingCodexMessage;
        state.pendingCodexMessage = null;
        if (!state.currentThread) await newThread();
        if (!state.currentThread) return;
        showTab('chat', { history: 'push', threadId: state.currentThread.id });
        $('#promptInput').value = draft;
        resizeComposer();
        $('#promptInput').focus();
      } else {
        showTab('threads', { history: 'push' });
      }
    }
  } catch (error) {
    state.currentProject = state.bootstrap?.projects?.current?.path ?? null;
    toast(error.message, 'error');
  }
}

let projectBrowseSeq = 0;

async function browseProjects(projectPath = '') {
  const seq = ++projectBrowseSeq;
  const query = projectPath ? `?path=${encodeURIComponent(projectPath)}` : '';
  const newThreadButton = $('#mobileNewThreadButton');
  newThreadButton.disabled = true;
  try {
    const data = await api(`/api/projects${query}`);
    if (seq !== projectBrowseSeq) return;
    renderProjects(data);
  } finally {
    if (seq === projectBrowseSeq) newThreadButton.disabled = false;
  }
}

function defaultFileBrowserPath() {
  return state.currentThread?.cwd
    ?? state.currentProject
    ?? state.bootstrap?.projects?.current?.path
    ?? '';
}

function openDefaultFileBrowser() {
  const projectPath = defaultFileBrowserPath();
  if (state.projectBrowser?.current?.path === projectPath) {
    renderProjects(state.projectBrowser);
    return;
  }
  $('#projectUpButton').hidden = true;
  $('#projectPath').textContent = projectPath;
  $('#projectList').innerHTML = '<div class="empty-list">正在读取当前会话目录…</div>';
  browseProjects(projectPath).catch((error) => toast(error.message, 'error'));
}

function renderProjects(data) {
  state.projectBrowser = data;
  setCurrentProjectDirectory(data.current.path, { clearConversation: true });
  $('#projectPath').textContent = data.current.path;
  $('#projectPath').setAttribute('aria-label', `管理当前目录 ${data.current.path}`);
  $('#projectPath').title = '点击或长按管理当前目录';
  $('#projectUpButton').hidden = !data.parent;
  const list = $('#projectList');
  list.replaceChildren();
  for (const entry of data.entries) {
    const isDirectory = entry.isDirectory !== false;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-button${isDirectory ? '' : ' project-file'}`;
    const details = isDirectory
      ? '文件夹'
      : `${artifactKindLabel(entry.fileKind)} · ${formatBytes(entry.size)}${entry.modifiedAt ? ` · ${formatTime(entry.modifiedAt)}` : ''}`;
    button.innerHTML = `<i>${isDirectory ? '⌁' : escapeHtml(artifactKindLabel(entry.fileKind))}</i><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(details)}</small></span><b>›</b>`;
    button.setAttribute('aria-label', isDirectory ? `进入文件夹 ${entry.name}，长按管理` : `预览文件 ${entry.name}，长按管理`);
    bindLongPress(button, () => showFileActions(entry, button));
    button.addEventListener('click', () => {
      if (isDirectory) browseProjects(entry.path).catch((error) => toast(error.message, 'error'));
      else openArtifact(entry);
    });
    if (isDirectory) {
      list.append(button);
    } else {
      const row = document.createElement('div');
      row.className = 'project-file-row';
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'project-file-share';
      share.textContent = '分享';
      share.setAttribute('aria-label', `分享文件 ${entry.name}`);
      share.addEventListener('click', () => openFileShare(entry));
      row.append(button, share);
      list.append(row);
    }
  }
  if (!data.entries.length) list.innerHTML = '<div class="empty-list">当前目录为空</div>';
  if (data.truncated) {
    const notice = document.createElement('div');
    notice.className = 'project-truncated';
    notice.textContent = '当前目录内容较多，显示前 300 项。';
    list.append(notice);
  }
}

let projectUploadInProgress = false;
let pendingProjectUploadDirectory = null;

function projectUploadButtons() {
  return $$('#desktopUploadProjectFilesButton, #uploadProjectFilesButton');
}

function openProjectFilePicker(directory) {
  if (!directory) {
    toast('当前目录尚未加载完成。', 'error');
    return;
  }
  pendingProjectUploadDirectory = directory;
  $('#projectFileInput').click();
}

async function uploadProjectFile(file, directory, overwrite = false) {
  const query = new URLSearchParams({ path: directory, name: file.name });
  if (overwrite) query.set('overwrite', '1');
  return api(`/api/projects/upload?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

async function uploadProjectFiles(files, requestedDirectory = null) {
  if (projectUploadInProgress || !files.length) return;
  const directory = requestedDirectory ?? state.projectBrowser?.current?.path;
  if (!directory) {
    toast('当前目录尚未加载完成。', 'error');
    return;
  }

  projectUploadInProgress = true;
  const buttons = projectUploadButtons();
  for (const button of buttons) button.disabled = true;
  let uploaded = 0;
  let skipped = 0;
  const failures = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      for (const button of buttons) button.textContent = `上传中 ${index + 1}/${files.length}`;
      try {
        await uploadProjectFile(file, directory);
        uploaded += 1;
      } catch (error) {
        if (error.code === 'FILE_EXISTS') {
          const overwrite = window.confirm(`“${file.name}”已经存在，是否覆盖？`);
          if (!overwrite) {
            skipped += 1;
            continue;
          }
          try {
            await uploadProjectFile(file, directory, true);
            uploaded += 1;
          } catch (overwriteError) {
            failures.push(`${file.name}：${overwriteError.message}`);
          }
        } else {
          failures.push(`${file.name}：${error.message}`);
        }
      }
    }
    if (uploaded && state.projectBrowser?.current?.path === directory) await browseProjects(directory);
    if (uploaded) toast(uploaded === 1 ? '文件已上传。' : `${uploaded} 个文件已上传。`);
    if (skipped) toast(`${skipped} 个同名文件未覆盖。`);
    if (failures.length) toast(failures[0] + (failures.length > 1 ? `（另有 ${failures.length - 1} 个失败）` : ''), 'error');
  } finally {
    projectUploadInProgress = false;
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = '↑ 上传';
    }
  }
}

const LONG_PRESS_MS = 550;
let fileActionTarget = null;
let fileActionSource = null;

function hideFileUploadPopover() {
  $('#fileUploadPopover').hidden = true;
  if (fileActionSource) {
    fileActionSource.classList.remove('context-active');
    fileActionSource.setAttribute('aria-expanded', 'false');
  }
  fileActionSource = null;
  fileActionTarget = null;
}

function showFileActions(target, source = null, anchor = 'entry') {
  hideFileUploadPopover();
  fileActionTarget = target;
  fileActionSource = source;
  const isDirectory = target?.isDirectory !== false;
  const isCurrent = target?.isCurrent === true;
  $('#fileActionTargetName').textContent = `${isCurrent ? '当前目录' : isDirectory ? '文件夹' : '文件'} · ${target?.name || target?.path || ''}`;
  $('#uploadProjectFilesButton').hidden = !isDirectory;
  $('#createProjectFileButton').hidden = !isDirectory;
  $('#createProjectDirectoryButton').hidden = !isDirectory;
  $('#deleteProjectEntryButton').hidden = isCurrent;
  const visibleActions = $$('#fileUploadPopover .file-action-buttons > button:not([hidden])').length;
  $('#fileUploadPopover .file-action-buttons').classList.toggle('single', visibleActions === 1);
  $('#fileUploadPopover').dataset.anchor = anchor;
  $('#fileUploadPopover').hidden = false;
  if (source) {
    source.classList.add('context-active');
    source.setAttribute('aria-expanded', 'true');
  }
  navigator.vibrate?.(12);
}

function bindLongPress(element, callback) {
  let timer = null;
  let start = null;
  let suppressClick = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  element.setAttribute('aria-haspopup', 'menu');
  element.setAttribute('aria-expanded', 'false');
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    cancel();
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      callback();
    }, LONG_PRESS_MS);
  });
  element.addEventListener('pointermove', (event) => {
    if (!timer || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) cancel();
  });
  element.addEventListener('pointerup', () => {
    cancel();
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 120);
  });
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('contextmenu', (event) => event.preventDefault());
  element.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  });
}

const SCREEN_SWIPE_AXIS_LOCK = 10;

function bindScreenSwipe(element, handlers) {
  let gesture = null;
  let suppressClickUntil = 0;
  let settleTimer = null;
  const findTouch = (touches, identifier) => {
    for (let index = 0; index < touches.length; index += 1) {
      if (touches[index].identifier === identifier) return touches[index];
    }
    return null;
  };
  const clearVisual = () => {
    clearTimeout(settleTimer);
    element.style.removeProperty('transition');
    element.style.removeProperty('transform');
    element.classList.remove('screen-swipe-active');
  };
  const settleVisual = () => {
    clearTimeout(settleTimer);
    element.style.transition = 'transform .16s ease-out';
    element.style.transform = 'translate3d(0, 0, 0)';
    settleTimer = setTimeout(clearVisual, 180);
  };
  const reset = (settle = false) => {
    gesture = null;
    if (settle) settleVisual();
    else clearVisual();
  };
  element.addEventListener('touchstart', (event) => {
    if (!isCompactNavigation() || !element.classList.contains('active')) return;
    if (event.touches.length !== 1) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"], .thread-filters, dialog')) return;
    const touch = event.touches[0];
    gesture = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      axis: null,
    };
    clearVisual();
  }, { passive: true, capture: true });
  element.addEventListener('touchmove', (event) => {
    if (!gesture) return;
    const touch = findTouch(event.touches, gesture.identifier);
    if (!touch) return;
    gesture.x = touch.clientX;
    gesture.y = touch.clientY;
    const dx = gesture.x - gesture.startX;
    const dy = gesture.y - gesture.startY;
    if (!gesture.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SCREEN_SWIPE_AXIS_LOCK) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical';
      if (gesture.axis === 'vertical') {
        reset(false);
        return;
      }
    }
    event.preventDefault();
    const attemptedDirection = dx < 0 ? 'left' : 'right';
    const directionSign = attemptedDirection === 'left' ? -1 : 1;
    const enabled = typeof handlers[attemptedDirection] === 'function';
    const offset = directionSign * Math.min(enabled ? 72 : 14, Math.abs(dx) * (enabled ? .42 : .12));
    element.classList.add('screen-swipe-active');
    element.style.transition = 'none';
    element.style.transform = `translate3d(${offset}px, 0, 0)`;
  }, { passive: false, capture: true });
  element.addEventListener('touchend', (event) => {
    if (!gesture) return;
    const touch = findTouch(event.changedTouches, gesture.identifier);
    if (touch) {
      gesture.x = touch.clientX;
      gesture.y = touch.clientY;
    }
    const dx = gesture.x - gesture.startX;
    const dy = gesture.y - gesture.startY;
    const threshold = Math.min(96, Math.max(64, element.clientWidth * .18));
    const completedDirection = dx < 0 ? 'left' : 'right';
    const callback = handlers[completedDirection];
    const completed = gesture.axis === 'horizontal' && typeof callback === 'function'
      && Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2;
    gesture = null;
    if (!completed) {
      settleVisual();
      return;
    }
    suppressClickUntil = Date.now() + 140;
    navigator.vibrate?.(8);
    element.style.transition = 'transform .08s ease-out';
    element.style.transform = `translate3d(${completedDirection === 'left' ? -72 : 72}px, 0, 0)`;
    settleTimer = setTimeout(() => {
      clearVisual();
      callback();
    }, 70);
  }, { capture: true });
  element.addEventListener('touchcancel', () => reset(true), { capture: true });
  element.addEventListener('click', (event) => {
    if (Date.now() > suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function cycleThreadGestureFilter() {
  if (state.threadScope === 'all' && !state.threadFavoriteOnly && state.currentProject) {
    state.threadScope = 'directory';
    loadThreads().catch((error) => toast(error.message, 'error'));
    return;
  }
  if (!state.threadFavoriteOnly) {
    const scopeChanged = state.threadScope !== 'all';
    state.threadScope = 'all';
    state.threadFavoriteOnly = true;
    if (scopeChanged) loadThreads().catch((error) => toast(error.message, 'error'));
    else renderThreads();
    return;
  }
  state.threadScope = 'all';
  state.threadFavoriteOnly = false;
  renderThreads();
}

function initNegativeScreenGestures() {
  bindScreenSwipe($('#threadsView'), {
    left: cycleThreadGestureFilter,
    right: () => showTab('projects', { history: 'push' }),
  });
  bindScreenSwipe($('#projectsView'), {
    left: () => backFromProjects({ gesture: true }),
  });
}

let projectCreateType = 'file';
let projectCreateDirectory = null;
let projectDeleteTarget = null;

function openProjectCreateDialog(type, directory) {
  if (!directory) {
    toast('目标目录尚未加载完成。', 'error');
    return;
  }
  hideFileUploadPopover();
  projectCreateType = type;
  projectCreateDirectory = directory;
  const isDirectory = type === 'directory';
  $('#projectCreateTitle').textContent = isDirectory ? '新建文件夹' : '新建文件';
  $('#projectCreatePath').textContent = directory;
  $('#projectCreateName').value = '';
  $('#projectCreateContent').value = '';
  $('#projectCreateContentField').hidden = isDirectory;
  $('#projectCreateDialog').showModal();
  requestAnimationFrame(() => $('#projectCreateName').focus());
}

function closeProjectCreateDialog() {
  $('#projectCreateDialog').close();
  projectCreateDirectory = null;
}

async function confirmProjectCreate() {
  const name = $('#projectCreateName').value.trim();
  if (!projectCreateDirectory || !name) {
    toast('请输入名称。', 'error');
    return;
  }
  const button = $('#confirmProjectCreateButton');
  button.disabled = true;
  try {
    await post('/api/projects/entries', {
      directory: projectCreateDirectory,
      name,
      type: projectCreateType,
      ...(projectCreateType === 'file' ? { content: $('#projectCreateContent').value } : {}),
    });
    const refreshDirectory = projectCreateDirectory;
    closeProjectCreateDialog();
    if (state.projectBrowser?.current?.path === refreshDirectory) await browseProjects(refreshDirectory);
    toast(projectCreateType === 'directory' ? '文件夹已创建。' : '文件已创建。');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function openProjectDeleteDialog(target) {
  if (target?.isCurrent) return;
  if (!target?.path) {
    hideFileUploadPopover();
    toast('无法识别删除目标，请刷新文件目录后重试。', 'error');
    return;
  }
  hideFileUploadPopover();
  projectDeleteTarget = target;
  const isDirectory = target.isDirectory !== false;
  const currentCwd = state.currentThread?.cwd;
  const currentWarning = currentCwd === target.path ? ' 这是当前会话的工作目录，删除后该会话可能无法继续执行。' : '';
  $('#projectDeleteMessage').textContent = isDirectory
    ? `确定删除文件夹“${target.name}”以及其中的全部内容吗？${currentWarning}`
    : `确定删除文件“${target.name}”吗？`;
  $('#projectDeleteDialog').showModal();
}

function closeProjectDeleteDialog() {
  $('#projectDeleteDialog').close();
  projectDeleteTarget = null;
}

async function confirmProjectDelete() {
  const target = projectDeleteTarget;
  if (!target) return;
  const button = $('#confirmProjectDeleteButton');
  button.disabled = true;
  try {
    const result = await api('/api/projects/entry', {
      method: 'DELETE',
      body: JSON.stringify({
        path: target.path,
        confirmName: target.name,
        recursive: target.isDirectory !== false,
      }),
    });
    closeProjectDeleteDialog();
    if (state.currentProject === target.path) {
      state.currentProject = result.parent;
      localStorage.setItem('codex-mobile-project', result.parent);
      $('#currentProjectName').textContent = result.parent.split('/').filter(Boolean).at(-1) || result.parent;
    }
    if (state.projectBrowser?.current?.path === result.parent) await browseProjects(result.parent);
    toast(target.isDirectory !== false ? '文件夹已删除。' : '文件已删除。');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

const THREAD_STATUS_LABELS = {
  waiting: '待处理',
  planning: '规划中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已停止',
  idle: '',
};

let threadListRequestSeq = 0;

function threadCollectionScope() {
  const directoryScoped = !isCompactNavigation() || state.threadScope === 'directory';
  if (!directoryScoped) return { key: 'all', cwd: null };
  const cwd = state.currentProject || null;
  return { key: cwd ? `cwd:${cwd}` : 'cwd:', cwd };
}

function currentDirectoryName() {
  const path = state.currentProject ?? '';
  return path.split('/').filter(Boolean).at(-1) || path || '当前目录';
}

function updateThreadFilterControls() {
  const directoryButton = $('#currentDirectoryThreadFilter');
  if (directoryButton) {
    const path = state.currentProject ?? '';
    directoryButton.textContent = path ? `当前 · ${currentDirectoryName()}` : '当前目录';
    directoryButton.title = path ? `只看目录：${path}` : '请先在文件目录中选择目录';
    directoryButton.setAttribute('aria-label', directoryButton.title);
    directoryButton.disabled = !path;
  }
  $$('#threadFilters [data-thread-scope]').forEach((button) => {
    const active = button.dataset.threadScope === state.threadScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const favoriteButton = $('#threadFavoriteToggle');
  if (favoriteButton) {
    favoriteButton.classList.toggle('active', state.threadFavoriteOnly);
    favoriteButton.setAttribute('aria-pressed', String(state.threadFavoriteOnly));
  }
  $$('#threadFilters [data-thread-filter]').forEach((button) => {
    const active = button.dataset.threadFilter === state.threadFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function activateThreadCollection(scope) {
  const cached = state.threadCollections.get(scope.key);
  state.threadListScopeKey = scope.key;
  state.threads = cached ? [...cached.threads] : [];
  state.threadsNextCursor = cached?.nextCursor ?? null;
  state.threadsLoadingMore = false;
  state.threadsScopeLoading = !cached;
  renderThreads();
}

function rememberThreadCollection(scopeKey) {
  state.threadCollections.set(scopeKey, {
    threads: [...state.threads],
    nextCursor: state.threadsNextCursor,
  });
}

function patchThreadCollections(threadId, patch) {
  for (const collection of state.threadCollections.values()) {
    const index = collection.threads.findIndex((thread) => thread.id === threadId);
    if (index >= 0) collection.threads[index] = { ...collection.threads[index], ...patch };
  }
}

function removeThreadFromCollections(threadId) {
  for (const collection of state.threadCollections.values()) {
    collection.threads = collection.threads.filter((thread) => thread.id !== threadId);
  }
}

function inferredThreadActivity(thread) {
  const raw = String(threadStatusType(thread) ?? '').toLowerCase().replaceAll('_', '');
  const running = ['active', 'running', 'inprogress', 'busy', 'working'].some((value) => raw.includes(value));
  return {
    threadId: thread.id,
    status: running ? 'running' : 'idle',
    phase: null,
    activeTurnId: null,
    attentionCount: 0,
    unreadCount: 0,
    completedAt: null,
    updatedAt: thread.updatedAt ?? null,
  };
}

function threadActivity(thread) {
  if (!thread?.id) return inferredThreadActivity({ id: '', status: 'idle' });
  return state.threadRuntimeById.get(thread.id) ?? thread.activity ?? inferredThreadActivity(thread);
}

function applyThreadActivity(activity, options = {}) {
  if (!activity?.threadId) return;
  const previous = state.threadRuntimeById.get(activity.threadId) ?? {};
  const next = { ...previous, ...activity };
  state.threadRuntimeById.set(activity.threadId, next);
  const index = state.threads.findIndex((thread) => thread.id === activity.threadId);
  if (index >= 0) state.threads[index] = { ...state.threads[index], activity: next };
  patchThreadCollections(activity.threadId, { activity: next });
  const cached = state.threadCache.get(activity.threadId);
  if (cached?.thread) cached.thread = { ...cached.thread, activity: next };
  if (state.currentThread?.id === activity.threadId) {
    state.currentThread = { ...state.currentThread, activity: next };
    if (['completed', 'failed', 'interrupted', 'idle'].includes(next.status)) state.activeTurnId = null;
    else if (next.activeTurnId) state.activeTurnId = next.activeTurnId;
    renderChatHeader();
    renderModeControls();
    renderPlanDecision();
  }
  if (options.render !== false) renderThreads();
}

function hydrateThreadActivities(threads) {
  for (const thread of threads) {
    const activity = thread.activity ?? inferredThreadActivity(thread);
    state.threadRuntimeById.set(thread.id, activity);
  }
}

async function loadThreads(options = {}) {
  if (!state.currentProject && !isCompactNavigation()) return;
  const scope = threadCollectionScope();
  if (!scope.cwd && scope.key !== 'all') {
    activateThreadCollection(scope);
    state.threadsScopeLoading = false;
    renderThreads();
    return;
  }
  const append = options.append === true;
  if (append && state.threadFavoriteOnly) return;
  if (append && state.threadListScopeKey !== scope.key) return;
  if (append && (!state.threadsNextCursor || state.threadsLoadingMore)) return;
  if (!append && state.threadListScopeKey !== scope.key) activateThreadCollection(scope);
  const seq = ++threadListRequestSeq;
  if (append) state.threadsLoadingMore = true;
  const params = new URLSearchParams({ limit: isCompactNavigation() ? '50' : '100' });
  if (scope.cwd) params.set('cwd', scope.cwd);
  if (append && state.threadsNextCursor) params.set('cursor', state.threadsNextCursor);
  renderThreadLoadMore();
  try {
    const result = await api(`/api/threads?${params}`);
    if (seq !== threadListRequestSeq || scope.key !== threadCollectionScope().key) return;
    const incoming = result.data ?? [];
    hydrateThreadActivities(incoming);
    if (append) {
      const next = new Map(state.threads.map((thread) => [thread.id, thread]));
      for (const thread of incoming) next.set(thread.id, thread);
      state.threads = [...next.values()];
    } else {
      state.threads = incoming;
    }
    state.threadsNextCursor = result.nextCursor ?? null;
    state.threadsScopeLoading = false;
    rememberThreadCollection(scope.key);
    renderThreads();
  } finally {
    if (seq === threadListRequestSeq) {
      state.threadsLoadingMore = false;
      if (scope.key === threadCollectionScope().key) state.threadsScopeLoading = false;
      renderThreads();
      renderThreadLoadMore();
    }
  }
}

function renderThreadLoadMore() {
  const button = $('#loadMoreThreadsButton');
  if (!button) return;
  button.hidden = state.threadFavoriteOnly || state.threadsScopeLoading
    || (!state.threadsNextCursor && !state.threadsLoadingMore);
  button.disabled = state.threadsLoadingMore;
  button.textContent = state.threadsLoadingMore ? '正在加载…' : '加载更多会话';
}

const FAVORITES_KEY = 'codex-mobile-favorite-threads';
const FAVORITES_MIGRATION_KEY = 'codex-mobile-favorites-server-v1';

function legacyFavoriteThreads() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setFavoriteThreads(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || unique.has(item.id)) continue;
    unique.set(item.id, item);
  }
  state.favoriteThreads = [...unique.values()].slice(0, 50);
}

function favoriteThreads() {
  return state.favoriteThreads;
}

async function loadFavoriteThreads(bootstrapFavorites) {
  const initial = Array.isArray(bootstrapFavorites)
    ? bootstrapFavorites
    : (await api('/api/favorites')).data;
  setFavoriteThreads(initial);
  const legacy = legacyFavoriteThreads();
  if (!localStorage.getItem(FAVORITES_MIGRATION_KEY) && legacy.length) {
    const result = await post('/api/favorites/import', { items: legacy });
    setFavoriteThreads(result.data);
    localStorage.removeItem(FAVORITES_KEY);
    localStorage.setItem(FAVORITES_MIGRATION_KEY, '1');
  }
  renderThreads();
}

async function upsertFavoriteThread(item) {
  const result = await post('/api/favorites', item);
  setFavoriteThreads(result.data);
}

async function removeFavoriteThread(threadId) {
  const result = await api(`/api/favorites/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
  setFavoriteThreads(result.data);
}

function isThreadFavorite(threadId) {
  return favoriteThreads().some((item) => item.id === threadId);
}

async function toggleThreadFavorite(thread) {
  if (isThreadFavorite(thread.id)) {
    await removeFavoriteThread(thread.id);
    toast('已取消收藏');
  } else {
    await upsertFavoriteThread({
      id: thread.id,
      name: thread.name || thread.preview || '未命名会话',
      cwd: thread.cwd || state.currentProject,
      updatedAt: thread.updatedAt,
    });
    toast('已收藏');
  }
  renderThreads();
}

function renderChatHeader() {
  const header = $('#chatDetailHeader');
  if (!header) return;
  const thread = state.currentThread;
  header.hidden = !thread;
  if (!thread) return;
  const activity = threadActivity(thread);
  $('#chatDetailName').textContent = thread.name || thread.preview || '未命名会话';
  const parts = [threadProjectName(thread)];
  const status = THREAD_STATUS_LABELS[activity.status];
  if (status) parts.push(status);
  $('#chatDetailMeta').textContent = parts.join(' · ');
}

function backToThreadHome(options = {}) {
  if (isCompactNavigation() && window.location.hash.startsWith('#chat/')) {
    history.back();
    return;
  }
  showTab('threads', { history: options.history ?? 'replace' });
}

function openCurrentThreadArtifacts(options = {}) {
  if (!state.currentThread?.id) {
    toast('请先打开会话');
    return;
  }
  showTab('artifacts', {
    history: options.history ?? 'push',
    threadId: state.currentThread.id,
  });
}

function backFromArtifacts() {
  const contextualRoute = window.location.hash.startsWith('#artifacts/');
  if (isCompactNavigation() && contextualRoute && history.state?.codexMobile) {
    history.back();
    return;
  }
  if (state.currentThread?.id) {
    showTab('chat', { history: 'replace', threadId: state.currentThread.id });
    return;
  }
  showTab('threads', { history: 'replace' });
}

let projectReturnAnimationTimer = null;

function backFromProjects(options = {}) {
  hideFileUploadPopover();
  if (options.gesture) {
    clearTimeout(projectReturnAnimationTimer);
    document.body.classList.add('returning-from-projects');
    projectReturnAnimationTimer = setTimeout(() => {
      document.body.classList.remove('returning-from-projects');
      projectReturnAnimationTimer = null;
    }, 240);
  }
  if (isCompactNavigation() && window.location.hash === '#projects' && history.state?.codexMobile) {
    history.back();
    return;
  }
  showTab('threads', { history: 'replace' });
}

function openThreadActionDialog(thread, source = 'list') {
  state.threadAction = thread;
  const fromChat = source === 'chat';
  $('#threadArtifactsAction').hidden = !fromChat;
  $('#threadRenameAction').hidden = fromChat;
  $('#threadDeleteAction').hidden = fromChat;
  $('#threadDeleteConfirm').hidden = true;
  $('#threadDeleteName').textContent = thread.name || thread.preview || '未命名会话';
  $('#threadActionDialog').showModal();
}

function closeThreadActionDialog() {
  $('#threadActionDialog').close();
  $('#threadArtifactsAction').hidden = true;
  state.threadAction = null;
}

function openThreadArtifactsAction() {
  const thread = state.threadAction;
  if (!thread || thread.id !== state.currentThread?.id) {
    closeThreadActionDialog();
    toast('请先打开对应会话');
    return;
  }
  $('#threadActionDialog').close();
  $('#threadArtifactsAction').hidden = true;
  state.threadAction = null;
  openCurrentThreadArtifacts();
}

function openThreadRenameDialog() {
  const thread = state.threadAction;
  if (!thread) return;
  $('#threadActionDialog').close();
  $('#threadRenameInput').value = thread.name || thread.preview || '';
  $('#threadRenameDialog').showModal();
  requestAnimationFrame(() => $('#threadRenameInput').focus());
}

async function confirmThreadRename() {
  const thread = state.threadAction;
  if (!thread) return;
  const name = $('#threadRenameInput').value.trim();
  if (!name) {
    toast('名称不能为空', 'error');
    return;
  }
  try {
    await post(`/api/threads/${encodeURIComponent(thread.id)}/name`, { name });
    thread.name = name;
    if (state.currentThread?.id === thread.id) state.currentThread.name = name;
    const index = state.threads.findIndex((item) => item.id === thread.id);
    if (index >= 0) state.threads[index] = { ...state.threads[index], name };
    patchThreadCollections(thread.id, { name });
    setFavoriteThreads(favoriteThreads().map((entry) => entry.id === thread.id ? { ...entry, name, updatedAt: Date.now() } : entry));
    $('#threadRenameDialog').close();
    state.threadAction = null;
    renderThreads();
    renderChatHeader();
    toast('已重命名');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function confirmThreadDelete() {
  if (!state.threadAction) return;
  $('#threadDeleteConfirm').hidden = false;
}

async function confirmThreadDeleteOk() {
  const thread = state.threadAction;
  if (!thread) return;
  try {
    await post(`/api/threads/${encodeURIComponent(thread.id)}/delete`, {});
    state.threads = state.threads.filter((item) => item.id !== thread.id);
    removeThreadFromCollections(thread.id);
    setFavoriteThreads(favoriteThreads().filter((entry) => entry.id !== thread.id));
    if (state.currentThread?.id === thread.id) {
      state.currentThread = null;
      state.turns = [];
      state.turnsNextCursor = null;
      state.activeTurnId = null;
      state.timelineVersion += 1;
      localStorage.removeItem(UI_STATE.thread);
      renderTimeline();
      renderChatHeader();
      renderThreads();
      saveUiState();
      if (isCompactNavigation()) showTab('threads', { history: 'replace' });
    } else {
      renderThreads();
    }
    $('#threadActionDialog').close();
    state.threadAction = null;
    toast('会话已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function threadStatusPriority(activity) {
  return { waiting: 0, planning: 1, running: 1, failed: 2, interrupted: 2, completed: 2, idle: 3 }[activity.status] ?? 3;
}

function favoriteThreadList() {
  const threadsById = new Map();
  for (const collection of state.threadCollections.values()) {
    for (const thread of collection.threads) threadsById.set(thread.id, thread);
  }
  for (const thread of state.threads) threadsById.set(thread.id, thread);
  return favoriteThreads().map((favorite) => {
    const thread = threadsById.get(favorite.id) ?? {};
    return {
      ...favorite,
      ...thread,
      name: favorite.name || thread.name,
      cwd: favorite.cwd || thread.cwd,
      updatedAt: Math.max(favorite.updatedAt ?? 0, thread.updatedAt ?? 0),
    };
  });
}

function threadMatchesScope(thread) {
  if (isCompactNavigation() && state.threadScope === 'directory' && thread.cwd !== state.currentProject) return false;
  return true;
}

function threadMatchesFilter(thread) {
  if (!threadMatchesScope(thread)) return false;
  const activity = threadActivity(thread);
  if (state.threadFavoriteOnly && !isThreadFavorite(thread.id)) return false;
  if (state.threadFilter === 'active' && !['planning', 'running'].includes(activity.status)) return false;
  if (state.threadFilter === 'attention' && activity.status !== 'waiting') return false;
  if (state.threadFilter === 'unread' && !(activity.unreadCount > 0)) return false;
  const query = state.threadSearch.trim().toLowerCase();
  if (!query) return true;
  return `${thread.name ?? ''} ${thread.preview ?? ''} ${thread.cwd ?? ''}`.toLowerCase().includes(query);
}

function sortedThreads(threads) {
  return [...threads].sort((left, right) => {
    const priority = threadStatusPriority(threadActivity(left)) - threadStatusPriority(threadActivity(right));
    if (priority !== 0) return priority;
    return Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0);
  });
}

function threadProjectName(thread) {
  const cwd = thread.cwd ?? '';
  return cwd.split('/').filter(Boolean).at(-1) || cwd || '未知项目';
}

function createThreadItem(thread) {
  const activity = threadActivity(thread);
  const item = document.createElement('div');
  item.className = `thread-item thread-state-${activity.status}${state.currentThread?.id === thread.id ? ' active' : ''}`;
  item.setAttribute('role', 'link');
  item.tabIndex = 0;
  const title = thread.name || thread.preview || '未命名会话';
  const preview = thread.preview && thread.preview !== title ? thread.preview : '打开查看会话内容';
  const statusLabel = THREAD_STATUS_LABELS[activity.status] ?? '';
  const starred = isThreadFavorite(thread.id);
  const unread = activity.unreadCount > 0 ? `<b class="thread-unread" aria-label="${activity.unreadCount} 条未读完成">${activity.unreadCount > 9 ? '9+' : activity.unreadCount}</b>` : '';
  const status = statusLabel ? `<span class="thread-status" data-status="${escapeAttribute(activity.status)}">${escapeHtml(statusLabel)}</span>` : '';
  item.innerHTML = `<span class="thread-state-marker" data-status="${escapeAttribute(activity.status)}" aria-hidden="true"></span><span class="thread-main"><span class="thread-title-row"><strong>${escapeHtml(title)}</strong><time>${escapeHtml(formatTime(thread.updatedAt))}</time></span><span class="thread-preview">${escapeHtml(preview)}</span><span class="thread-meta"><span>${escapeHtml(threadProjectName(thread))}</span>${status}${unread}</span></span><span class="thread-row-actions"><button type="button" class="thread-star${starred ? ' on' : ''}" aria-label="${starred ? '取消收藏' : '收藏'}" title="${starred ? '取消收藏' : '收藏'}">${starred ? '★' : '☆'}</button><button type="button" class="thread-more" aria-label="会话操作" title="会话操作">⋯</button></span>`;
  const activate = (event) => {
    if (event.target.closest('.thread-star')) {
      toggleThreadFavorite(thread).catch((error) => toast(error.message, 'error'));
      return;
    }
    if (event.target.closest('.thread-more')) {
      openThreadActionDialog(thread);
      return;
    }
    openThread(thread.id, { history: 'push' });
  };
  item.addEventListener('click', activate);
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate(event);
  });
  return item;
}

function appendThreadGroup(list, label, threads) {
  if (!threads.length) return;
  const heading = document.createElement('p');
  heading.className = 'thread-section-label';
  heading.textContent = label;
  list.append(heading);
  for (const thread of threads) list.append(createThreadItem(thread));
}

function renderThreadSummary() {
  const filteredFavorites = state.threadFavoriteOnly
    ? favoriteThreadList().filter(threadMatchesFilter)
    : null;
  const activities = state.threads.map((thread) => threadActivity(thread));
  const active = activities.filter((activity) => ['planning', 'running'].includes(activity.status)).length;
  const attention = activities.filter((activity) => activity.status === 'waiting').length;
  const unread = activities.reduce((total, activity) => total + (activity.unreadCount ?? 0), 0);
  const summary = $('#threadSummary');
  if (summary) {
    const parts = [];
    if (attention) parts.push(`${attention} 个待处理`);
    if (active) parts.push(`${active} 个进行中`);
    if (unread) parts.push(`${unread} 个未读`);
    const directory = state.threadScope === 'directory' ? currentDirectoryName() : '';
    if (filteredFavorites) summary.textContent = [directory, `${filteredFavorites.length} 个收藏`].filter(Boolean).join(' · ');
    else if (state.threadsScopeLoading) summary.textContent = directory ? `正在加载 ${directory}…` : '正在加载会话…';
    else if (parts.length) summary.textContent = [directory, ...parts].filter(Boolean).join(' · ');
    else summary.textContent = directory ? `${directory} · ${state.threads.length} 个会话` : `${state.threads.length} 个最近会话`;
  }
}

function renderThreads() {
  updateThreadFilterControls();
  renderThreadSummary();
  const desktop = $('#desktopThreadList');
  desktop.replaceChildren();
  if (!state.threads.length) desktop.innerHTML = '<div class="empty-list">这个项目还没有会话</div>';
  else for (const thread of sortedThreads(state.threads)) desktop.append(createThreadItem(thread));

  const mobile = $('#mobileThreadList');
  mobile.replaceChildren();
  if (state.threadsScopeLoading && !state.threadFavoriteOnly) {
    mobile.innerHTML = '<div class="thread-list-skeleton" role="status" aria-label="正在加载会话"><span class="thread-skeleton-row"></span><span class="thread-skeleton-row"></span><span class="thread-skeleton-row"></span></div>';
    renderThreadLoadMore();
    return;
  }
  const source = state.threadFavoriteOnly ? favoriteThreadList() : state.threads;
  const filtered = sortedThreads(source.filter(threadMatchesFilter));
  if (!filtered.length) {
    const favoriteEmpty = state.threadFavoriteOnly;
    const filteredEmpty = state.threadSearch || state.threadFilter !== 'all';
    const directoryEmpty = state.threadScope === 'directory' && state.currentProject;
    const scopedFavorites = favoriteEmpty ? source.filter(threadMatchesScope) : [];
    const message = favoriteEmpty
      ? !favoriteThreads().length
        ? '还没有收藏的会话'
        : !scopedFavorites.length && directoryEmpty
          ? `${currentDirectoryName()} 目录下没有收藏的会话`
          : '没有符合条件的收藏'
      : filteredEmpty
      ? '没有符合条件的会话'
      : directoryEmpty
        ? `${currentDirectoryName()} 目录下暂无会话`
        : '还没有会话，右滑到文件目录后点击右下角 + 新建';
    mobile.innerHTML = `<div class="empty-list">${escapeHtml(message)}</div>`;
    renderThreadLoadMore();
    return;
  }
  const highlighted = filtered.filter((thread) => threadStatusPriority(threadActivity(thread)) < 3);
  const recent = filtered.filter((thread) => threadStatusPriority(threadActivity(thread)) === 3);
  appendThreadGroup(mobile, '待处理与进行中', highlighted);
  const recentLabel = state.threadFavoriteOnly
    ? (highlighted.length ? '其他收藏' : '收藏会话')
    : (highlighted.length ? '最近会话' : '全部会话');
  appendThreadGroup(mobile, recentLabel, recent);
  renderThreadLoadMore();
}

async function newThread(options = {}) {
  const cwd = options.cwd ?? state.currentProject;
  if (!cwd) {
    showTab('projects', { history: 'push' });
    toast('请先选择项目');
    return;
  }
  setCurrentProjectDirectory(cwd, { clearConversation: true });
  try {
    const result = await post('/api/threads', {
      cwd,
      model: effectiveModel() || undefined,
    });
    state.currentThread = result.thread;
    if (result.thread.activity) applyThreadActivity(result.thread.activity, { render: false });
    state.turns = result.thread.turns ?? [];
    state.turnsNextCursor = null;
    clearArtifactState();
    state.timelineVersion += 1;
    state.questionCursor = 0;
    state.activeTurnId = null;
    state.turnModes.clear();
    renderTimeline();
    renderChatHeader();
    await loadThreads();
    showTab('chat', { history: 'push', threadId: result.thread.id });
    $('#promptInput').focus();
    saveUiState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setArtifacts(next) {
  const documents = next.filter((artifact) => artifact.available !== false
    && artifact.status !== 'deleted' && isDocumentArtifact(artifact));
  if (!sameArtifactSet(state.artifacts, documents)) {
    state.artifacts = documents;
    state.artifactsVersion += 1;
    return true;
  }
  state.artifacts = documents;
  return false;
}

function clearArtifactState() {
  state.artifactRequestSeq += 1;
  setArtifacts([]);
  state.artifactsThreadId = null;
  state.artifactsTotal = 0;
  state.artifactsNextOffset = null;
  state.artifactSearchResults = null;
  state.artifactSearchTotal = 0;
  state.artifactSearchNextOffset = null;
  state.artifactSearchLoading = false;
  state.artifactsLoadingMore = false;
  state.artifactsHistoryPending = false;
  clearTimeout(artifactHistoryRefreshTimer);
  artifactHistoryRefreshTimer = null;
  state.artifactQuery = '';
  state.artifactsRenderedVersion = -1;
  const search = $('#artifactSearch');
  if (search) search.value = '';
}

function threadStatusType(thread) {
  const value = thread?.status;
  if (typeof value === 'string') return value;
  return typeof value?.type === 'string' ? value.type : null;
}

function activeTurnFromSnapshot(thread, turns) {
  if (['idle', 'notLoaded'].includes(threadStatusType(thread))) return null;
  return [...turns].reverse().find((turn) => turn.status === 'inProgress')?.id ?? null;
}

function applyThreadData(thread, turns, seq = state.threadLoadSeq) {
  if (seq !== state.threadLoadSeq) return false;
  state.currentThread = thread;
  if (thread.activity) applyThreadActivity(thread.activity, { render: false });
  state.currentProject = thread.cwd;
  localStorage.setItem('codex-mobile-project', state.currentProject);
  $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
  state.turns = turns;
  state.timelineVersion += 1;
  state.questionCursor = 0;
  state.turnModes.clear();
  state.activeTurnId = threadActivity(thread).activeTurnId ?? activeTurnFromSnapshot(thread, turns);
  state.pinnedToBottom = true;
  updateScrollLatestButton();
  renderTimeline();
  renderChatHeader();
  renderApprovals();
  syncViewChrome('chat');
  renderThreads();
  saveUiState();
  return true;
}

async function markThreadRead(threadId) {
  if (!threadId) return;
  const activity = state.threadRuntimeById.get(threadId);
  if (!activity?.unreadCount) return;
  try {
    const result = await post(`/api/threads/${encodeURIComponent(threadId)}/read`, {});
    if (result.activity) applyThreadActivity(result.activity);
  } catch (error) {
    debug.log('thread', 'mark-read-failed', { threadId, message: error.message });
  }
}

async function openThread(threadId, options = {}) {
  debug.log('thread', 'open-start', { threadId });
  const seq = ++state.threadLoadSeq;
  showTab('chat', { history: options.history ?? 'push', threadId });
  const cached = state.threadCache.get(threadId);
  if (cached) {
    clearArtifactState();
    setArtifacts(cached.artifacts ?? []);
    state.artifactsThreadId = cached.artifactsLoaded === true ? threadId : null;
    state.artifactsTotal = cached.artifactsTotal ?? state.artifacts.length;
    state.artifactsNextOffset = cached.artifactsNextOffset ?? null;
    renderArtifacts();
    state.turnsNextCursor = cached.turnsNextCursor ?? null;
    applyThreadData(cached.thread, cached.turns, seq);
    state.threadOpenedAt = Date.now();
    updateLoadOlderButton();
    void markThreadRead(threadId);
    post(`/api/threads/${encodeURIComponent(threadId)}/resume`).catch((error) => toast(`会话恢复失败：${error.message}`, 'error'));
    loadArtifacts(threadId).then(() => {
      const entry = state.threadCache.get(threadId);
      if (!entry || state.currentThread?.id !== threadId) return;
      entry.artifacts = state.artifacts.slice();
      entry.artifactsTotal = state.artifactsTotal;
      entry.artifactsNextOffset = state.artifactsNextOffset;
      entry.artifactsLoaded = true;
    }).catch((error) => toast(error.message, 'error'));
    refreshCurrentThread({ seq, skipArtifacts: true }).catch(() => {});
    return true;
  }
  showThreadLoading();
  try {
    const read = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if (seq !== state.threadLoadSeq) return false;
    const fullTurns = read.thread.turns ?? [];
    clearArtifactState();
    let page = null;
    try {
      page = await fetchTurnPage(threadId);
    } catch {
      page = null;
    }
    if (seq !== state.threadLoadSeq) return false;
    const turns = page && page.turnsAsc.length ? page.turnsAsc : fullTurns;
    state.turnsNextCursor = page && page.turnsAsc.length ? page.nextCursor : null;
    cacheThread(threadId, {
      thread: read.thread,
      turns: turns.slice(),
      artifacts: [],
      artifactsLoaded: false,
      turnsNextCursor: state.turnsNextCursor,
      cachedAt: Date.now(),
    });
    applyThreadData(read.thread, turns, seq);
    updateLoadOlderButton();
    post(`/api/threads/${encodeURIComponent(threadId)}/resume`).catch((error) => toast(`会话恢复失败：${error.message}`, 'error'));
    try {
      await loadArtifacts(threadId);
      const entry = state.threadCache.get(threadId);
      if (entry && state.currentThread?.id === threadId) {
        entry.artifacts = state.artifacts.slice();
        entry.artifactsTotal = state.artifactsTotal;
        entry.artifactsNextOffset = state.artifactsNextOffset;
        entry.artifactsLoaded = true;
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      if (seq === state.threadLoadSeq) {
        hideThreadLoading();
        state.threadOpenedAt = Date.now();
        void markThreadRead(threadId);
        debug.log('thread', 'open-complete', { threadId });
      }
    }
    return true;
  } catch (error) {
    if (seq === state.threadLoadSeq) {
      hideThreadLoading();
      toast(error.message, 'error');
      if (isCompactNavigation()) showTab('threads', { history: 'replace' });
    }
    return false;
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
      const previousActivity = threadActivity(state.currentThread);
      const incomingActivity = read.thread.activity ?? inferredThreadActivity(read.thread);
      const metaChanged = state.currentThread.updatedAt !== read.thread.updatedAt
        || state.currentThread.name !== read.thread.name
        || threadStatusType(state.currentThread) !== threadStatusType(read.thread)
        || previousActivity.status !== incomingActivity.status
        || previousActivity.unreadCount !== incomingActivity.unreadCount;
      state.currentThread = read.thread;
      applyThreadActivity(incomingActivity, { render: false });
      state.currentProject = read.thread.cwd;
      localStorage.setItem('codex-mobile-project', state.currentProject);
      $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
      if (merged.changed || metaChanged) {
        state.turns = merged.turns;
        state.activeTurnId = incomingActivity.activeTurnId ?? activeTurnFromSnapshot(read.thread, state.turns);
        if (page && page.turnsAsc.length) state.turnsNextCursor = page.nextCursor;
        state.timelineVersion += 1;
        renderTimeline();
        updateLoadOlderButton();
      }
      renderChatHeader();
      renderApprovals();
      renderThreads();
      const entry = state.threadCache.get(threadId);
      if (entry) {
        entry.thread = read.thread;
        entry.turns = state.turns.slice();
        entry.turnsNextCursor = state.turnsNextCursor;
        entry.cachedAt = Date.now();
      }
      if (!options.skipArtifacts) {
        await loadArtifacts(threadId);
        if (entry && state.currentThread?.id === threadId) {
          entry.artifacts = state.artifacts.slice();
          entry.artifactsTotal = state.artifactsTotal;
          entry.artifactsNextOffset = state.artifactsNextOffset;
          entry.artifactsLoaded = true;
        }
      }
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

function terminalActivityStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('interrupt') || status.includes('cancel') || status.includes('stop')) return 'interrupted';
  return 'completed';
}

function applyCodexRuntimeEvent(method, params, threadId, turnId) {
  if (!threadId) return;
  const previous = state.threadRuntimeById.get(threadId) ?? {
    threadId, status: 'idle', phase: null, activeTurnId: null, unreadCount: 0, attentionCount: 0,
  };
  if (method === 'turn/started') {
    const phase = threadId === state.currentThread?.id && state.pendingTurnMode
      ? state.pendingTurnMode
      : previous.phase;
    applyThreadActivity({
      ...previous,
      threadId,
      status: phase === 'plan' ? 'planning' : 'running',
      phase: phase === 'plan' ? 'plan' : 'default',
      activeTurnId: params.turn?.id ?? turnId ?? previous.activeTurnId,
      updatedAt: Date.now(),
    });
  } else if (method === 'turn/completed') {
    const status = terminalActivityStatus(params.turn?.status ?? params.status);
    const alreadyTerminal = ['completed', 'failed', 'interrupted'].includes(previous.status)
      && !previous.activeTurnId;
    applyThreadActivity({
      ...previous,
      threadId,
      status,
      phase: null,
      activeTurnId: null,
      unreadCount: alreadyTerminal ? (previous.unreadCount ?? 0) : (previous.unreadCount ?? 0) + 1,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

function handleCodex(message) {
  const { method, params = {} } = message;
  const threadId = params.threadId ?? params.thread_id ?? params.thread?.id;
  const turnId = params.turnId ?? params.turn_id;
  const itemId = params.itemId ?? params.item_id;
  if (state.threadOpenedAt && message.at) {
    const eventAt = typeof message.at === 'number' ? message.at : Date.parse(message.at);
    if (Number.isFinite(eventAt) && eventAt < state.threadOpenedAt) {
      debug.log('sse', 'ignored-old', { method, at: message.at });
      return;
    }
  }
  debug.log('sse', 'process', { method, threadId });
  applyCodexRuntimeEvent(method, params, threadId, turnId);
  if (method === 'thread/started' && (isCompactNavigation() || params.thread?.cwd === state.currentProject)) loadThreads().catch(() => {});
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
    void markThreadRead(threadId);
    refreshCurrentThread({ force: true, seq: state.threadLoadSeq }).catch(() => renderTimeline(false, true));
  }
}

function approvalTitle(method) {
  if (method.includes('commandExecution') || method === 'execCommandApproval') return '允许执行命令？';
  if (method.includes('fileChange') || method === 'applyPatchApproval') return '允许修改文件？';
  if (method.includes('permissions')) return 'Codex 需要额外权限';
  if (method.includes('requestUserInput')) return 'Codex 正在等你的回答';
  if (method === 'mcpServer/elicitation/request') return 'MCP 服务请求确认';
  return 'Codex 请求确认';
}

function isQuestionRequest(request) {
  return request?.method === 'item/tool/requestUserInput' || request?.method?.endsWith('/requestUserInput');
}

function isMcpElicitationRequest(request) {
  return request?.method === 'mcpServer/elicitation/request';
}

function approvalThreadId(request) {
  const params = request?.params ?? {};
  return params.threadId ?? params.thread_id ?? params.thread?.id ?? null;
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
  const chatActive = document.querySelector('.view.active')?.dataset.view === 'chat';
  const requests = [...state.approvals.values()].filter((request) => {
    if (!chatActive || !state.currentThread) return false;
    const threadId = approvalThreadId(request);
    return !threadId || threadId === state.currentThread.id;
  });
  const head = document.createElement('div');
  head.className = 'approval-drawer-head';
  head.innerHTML = '<i></i><strong>Codex 需要你处理</strong>';
  const scroll = document.createElement('div');
  scroll.className = 'approval-drawer-scroll';
  for (const request of requests) {
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
    const summary = params.message || params.reason || params.cwd || autoResolution || '请在手机端确认后，Codex 才会继续。';
    card.innerHTML = `<div class="approval-head"><span class="approval-symbol">!</span><div><h3>${escapeHtml(approvalTitle(request.method))}</h3><p>${escapeHtml(summary)}</p></div></div>${command ? `<div class="approval-command">${escapeHtml(command)}</div>` : ''}${questions}<div class="approval-actions"></div>`;
    const actions = card.querySelector('.approval-actions');
    if (questionRequest) {
      actions.append(actionButton('提交回答', 'answer', true));
    } else {
      actions.append(actionButton('拒绝', 'decline'));
      actions.append(actionButton('本次允许', 'accept', true));
      if (!isMcpElicitationRequest(request)) actions.append(actionButton('本会话允许', 'acceptForSession'));
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
  stack.hidden = requests.length === 0;
  stack.classList.toggle('visible', requests.length > 0);
  document.body.classList.toggle('approval-open', requests.length > 0);
  if (requests.length) {
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
  for (const item of left) {
    seen.set(item.id, `${item.available ? 1 : 0}:${item.token ? 1 : 0}:${item.status ?? ''}:${item.modifiedAt ?? ''}:${item.name ?? ''}`);
  }
  for (const item of right) {
    if (seen.get(item.id) !== `${item.available ? 1 : 0}:${item.token ? 1 : 0}:${item.status ?? ''}:${item.modifiedAt ?? ''}:${item.name ?? ''}`) return false;
  }
  return true;
}

function artifactPathKey(item) {
  return `${item.projectPath ?? ''}\0${item.relativePath ?? item.name ?? item.id ?? ''}`;
}

let artifactHistoryRefreshTimer = null;

function scheduleArtifactHistoryRefresh(threadId, delay = 1200) {
  clearTimeout(artifactHistoryRefreshTimer);
  artifactHistoryRefreshTimer = null;
  if (!state.artifactsHistoryPending || threadId !== state.currentThread?.id) return;
  artifactHistoryRefreshTimer = setTimeout(async () => {
    if (threadId !== state.currentThread?.id) return;
    try {
      await loadArtifacts(threadId);
      const query = state.artifactQuery.trim();
      if (!state.artifactsHistoryPending && query && threadId === state.currentThread?.id) {
        await loadArtifactSearch(query);
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }, delay);
}

function mergeArtifactPage(current, incoming) {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

async function loadArtifacts(expectedThreadId = state.currentThread?.id, options = {}) {
  if (!expectedThreadId) {
    clearArtifactState();
    renderArtifacts();
    return;
  }
  const append = options.append === true;
  const offset = append ? state.artifactsNextOffset : 0;
  if (append && offset == null) return;
  const seq = ++state.artifactRequestSeq;
  state.artifactsLoadingMore = append;
  const query = new URLSearchParams({ limit: '100', offset: String(offset ?? 0) });
  try {
    const result = await api(`/api/threads/${encodeURIComponent(expectedThreadId)}/artifacts?${query}`);
    if (expectedThreadId !== state.currentThread?.id || seq !== state.artifactRequestSeq) return;
    const next = result.data ?? [];
    setArtifacts(append ? mergeArtifactPage(state.artifacts, next) : next);
    state.artifactsThreadId = expectedThreadId;
    state.artifactsTotal = Number.isFinite(result.total) ? result.total : state.artifacts.length;
    state.artifactsNextOffset = Number.isFinite(result.nextOffset) ? result.nextOffset : null;
    state.artifactsHistoryPending = result.scope?.historyPending === true;
    scheduleArtifactHistoryRefresh(expectedThreadId);
    refreshTimelineAfterArtifacts();
  } finally {
    if (seq === state.artifactRequestSeq) {
      state.artifactsLoadingMore = false;
      state.artifactsRenderedVersion = -1;
      renderArtifacts();
    }
  }
}

async function loadArtifactSearch(queryText, options = {}) {
  const queryTextTrimmed = queryText.trim();
  if (!queryTextTrimmed || !state.currentThread) {
    state.artifactSearchResults = null;
    state.artifactSearchTotal = 0;
    state.artifactSearchNextOffset = null;
    state.artifactsRenderedVersion = -1;
    renderArtifacts();
    return;
  }
  const append = options.append === true;
  const offset = append ? state.artifactSearchNextOffset : 0;
  if (append && offset == null) return;
  const threadId = state.currentThread.id;
  const seq = ++state.artifactRequestSeq;
  state.artifactsLoadingMore = append;
  if (!append) {
    state.artifactSearchResults = [];
    state.artifactSearchLoading = true;
    state.artifactsRenderedVersion = -1;
    renderArtifacts();
  }
  try {
    const query = new URLSearchParams({ search: queryTextTrimmed, limit: '100', offset: String(offset ?? 0) });
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/artifacts?${query}`);
    if (threadId !== state.currentThread?.id || queryTextTrimmed !== state.artifactQuery.trim() || seq !== state.artifactRequestSeq) return;
    const incoming = (result.data ?? []).filter((artifact) => artifact.available !== false
      && artifact.status !== 'deleted' && isDocumentArtifact(artifact));
    state.artifactSearchResults = append
      ? mergeArtifactPage(state.artifactSearchResults ?? [], incoming)
      : incoming;
    state.artifactSearchTotal = Number.isFinite(result.total) ? result.total : state.artifactSearchResults.length;
    state.artifactSearchNextOffset = Number.isFinite(result.nextOffset) ? result.nextOffset : null;
    state.artifactsHistoryPending = result.scope?.historyPending === true;
    scheduleArtifactHistoryRefresh(threadId);
  } finally {
    if (seq === state.artifactRequestSeq) {
      state.artifactSearchLoading = false;
      state.artifactsLoadingMore = false;
      state.artifactsRenderedVersion = -1;
      renderArtifacts();
    }
  }
}

function rankArtifacts(artifacts) {
  return [...artifacts].sort((left, right) => artifactSortTime(right) - artifactSortTime(left));
}

function artifactKindLabel(kind) {
  const labels = {
    markdown: 'MD', pdf: 'PDF', office: 'OFFICE', image: 'IMG', text: 'TXT',
    html: 'HTML', audio: 'AUDIO', video: 'VIDEO', archive: 'ZIP', binary: 'FILE',
  };
  return labels[kind] ?? String(kind || 'file').toUpperCase().slice(0, 6);
}

function createArtifactCard(artifact) {
  const card = document.createElement('article');
  const modifiedText = formatDateTime(artifact.modifiedAt || artifact.capturedAt);
  card.className = `artifact-card ${artifact.available ? '' : 'deleted'}`;
  card.innerHTML = `
    <div class="artifact-card-main"><strong title="${escapeHtml(artifact.name)}">${escapeHtml(artifact.name)}</strong><span class="artifact-kind">${escapeHtml(artifactKindLabel(artifact.fileKind))}</span></div>
    ${modifiedText ? `<small class="artifact-time">修改于 ${escapeHtml(modifiedText)}</small>` : ''}
    <div class="artifact-actions"><button data-action="share" data-artifact-id="${escapeHtml(artifact.id)}" ${artifact.available ? '' : 'disabled'}>分享</button><button data-action="preview" data-artifact-id="${escapeHtml(artifact.id)}" ${artifact.available ? '' : 'disabled'}>预览</button></div>`;
  return card;
}

function renderArtifacts() {
  const list = $('#artifactList');
  const detailName = $('#artifactDetailName');
  const scope = $('#artifactScope');
  const thread = state.currentThread;
  if (detailName) detailName.textContent = thread?.name || thread?.preview || '未命名会话';
  if (scope) {
    scope.textContent = thread
      ? `${state.artifactsHistoryPending ? '历史文档同步中…' : '全部历史文档'} · ${threadProjectName(thread)}`
      : '请先选择会话';
  }
  const query = state.artifactQuery.trim().toLowerCase();
  const renderKey = `${query}|${state.artifactsNextOffset}|${state.artifactSearchNextOffset}|${state.artifactsLoadingMore}|${state.artifactsHistoryPending}`;
  if (state.artifactsRenderedVersion === state.artifactsVersion && state.artifactsRenderKey === renderKey) return;
  state.artifactsRenderKey = renderKey;
  state.artifactsRenderedVersion = state.artifactsVersion;
  list.replaceChildren();
  const items = query ? (state.artifactSearchResults ?? []) : state.artifacts;
  if (!items.length && state.artifactSearchLoading) {
    list.innerHTML = '<div class="empty-list">正在搜索产出物…</div>';
    return;
  }
  if (!items.length && !query) {
    list.innerHTML = state.artifactsHistoryPending
      ? '<div class="empty-list">页面已经可以使用，正在后台补齐历史文档…</div>'
      : '<div class="empty-list">这个会话的历史记录中还没有可展示的文档。<br>Markdown、Word、Excel、PPT、PDF 和文本文件会出现在这里。</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty-list">没有匹配“${escapeHtml(state.artifactQuery.trim())}”的产出物。<br>换个关键词试试。</div>`;
    return;
  }
  const ranked = rankArtifacts(items);
  const header = document.createElement('div');
  header.className = 'artifact-section';
  header.textContent = '历史文档';
  list.append(header);
  for (const artifact of ranked) list.append(createArtifactCard(artifact));
  const nextOffset = query ? state.artifactSearchNextOffset : state.artifactsNextOffset;
  const total = query ? state.artifactSearchTotal : state.artifactsTotal;
  if (nextOffset != null) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'artifact-more';
    more.dataset.action = 'load-more';
    more.disabled = state.artifactsLoadingMore;
    more.textContent = state.artifactsLoadingMore
      ? '正在加载…'
      : `继续加载 · 已加载 ${items.length}/${total}`;
    list.append(more);
  }
}

function refreshTimelineAfterArtifacts() {
  if (document.querySelector('.view.active')?.dataset.view === 'chat') updateTurnArtifactsStrips();
}

function rewriteArtifactUrls(html, token) {
  const rewrite = (url) => {
    const raw = url.trim();
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    const trimmed = decoded.replace(/^\.\//, '');
    if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(trimmed)) return null;
    return `/api/artifacts/${token}/related?path=${encodeURIComponent(trimmed)}`;
  };
  return html
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (match, prefix, url, suffix) => {
      const rewritten = rewrite(url);
      return rewritten === null ? match : `${prefix}${rewritten}${suffix}`;
    })
    .replace(/(<a\b[^>]*\bhref=")([^"]+)(")/gi, (match, prefix, url, suffix) => {
      const rewritten = rewrite(url);
      return rewritten === null ? match : `${prefix}${rewritten}${suffix}`;
    });
}

function isLocalArtifactHref(href) {
  const value = String(href ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('/api/')) return false;
  if (/^(?:https?:|mailto:|tel:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('file:');
}

async function openLinkedArtifact(href) {
  const result = await post('/api/files/resolve', {
    path: href,
    cwd: state.currentProject,
  });
  if (!result.artifact) throw new Error('文件链接解析失败');
  await openArtifact(result.artifact);
}

function createDirectoryEntry(item, label = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'directory-entry';
  const icon = document.createElement('i');
  icon.textContent = item.isDirectory ? '▰' : '◇';
  const content = document.createElement('span');
  const name = document.createElement('strong');
  name.textContent = label || item.name;
  const details = document.createElement('small');
  details.textContent = item.isDirectory
    ? '目录'
    : `${artifactKindLabel(item.fileKind)} · ${formatBytes(item.size)}`;
  const arrow = document.createElement('b');
  arrow.textContent = '›';
  content.append(name, details);
  button.append(icon, content, arrow);
  button.addEventListener('click', () => openArtifact(item));
  return button;
}

async function renderDirectoryPreview(token, body) {
  const result = await api(`/api/artifacts/${token}/directory`);
  body.className = 'preview-body directory-preview';
  body.replaceChildren();
  const list = document.createElement('div');
  list.className = 'directory-list';
  if (result.parent) list.append(createDirectoryEntry(result.parent, '返回上一级'));
  for (const item of result.data ?? []) list.append(createDirectoryEntry(item));
  if (!list.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-list';
    empty.textContent = '这个目录是空的';
    list.append(empty);
  }
  body.append(list);
  if (result.truncated) {
    const notice = document.createElement('div');
    notice.className = 'document-truncated';
    notice.textContent = '目录内容较多，当前显示前 500 项。';
    body.append(notice);
  }
}

async function openArtifact(artifact) {
  if (!artifact.token) return;
  const body = $('#previewBody');
  state.currentArtifact = null;
  $('#sharePreviewButton').hidden = true;
  try {
    const token = encodeURIComponent(artifact.token);
    const meta = await api(`/api/artifacts/${token}/meta`);
    state.currentArtifact = { ...artifact, ...meta, token: artifact.token };
    $('#previewKind').textContent = meta.isDirectory ? '目录' : `${meta.fileKind} · ${formatBytes(meta.size)}`;
    $('#previewTitle').textContent = meta.name;
    const raw = `/api/artifacts/${token}/raw`;
    body.className = 'preview-body';
    body.replaceChildren();
    body.innerHTML = '<div class="preview-loading"><span></span>正在准备预览…</div>';
    $('#downloadArtifactButton').hidden = Boolean(meta.isDirectory);
    $('#sharePreviewButton').hidden = Boolean(meta.isDirectory);
    $('#downloadArtifactButton').href = `${raw}?download=1`;
    $('#downloadArtifactButton').download = meta.name;
    if (!$('#previewDialog').open) $('#previewDialog').showModal();
    if (meta.isDirectory) {
      await renderDirectoryPreview(token, body);
    } else if (meta.fileKind === 'markdown' || meta.fileKind === 'text') {
      const response = await fetch(raw, { credentials: 'same-origin' });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.message || '文件读取失败');
      }
      const text = await response.text();
      body.innerHTML = meta.fileKind === 'markdown'
        ? `<article class="agent-card">${rewriteArtifactUrls(markdown(text), token)}</article>`
        : `<pre>${escapeHtml(text)}</pre>`;
      if (meta.fileKind === 'markdown') void renderMermaid(body).catch(() => toast('流程图渲染失败', 'error'));
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
  showTab('chat', { history: 'push', threadId: state.currentThread?.id });
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
        state.currentThread = { ...state.currentThread, ...result.thread };
        if (result.thread.activity) applyThreadActivity(result.thread.activity, { render: false });
        state.currentProject = result.thread.cwd;
        localStorage.setItem('codex-mobile-project', state.currentProject);
        $('#currentProjectName').textContent = state.currentProject.split('/').at(-1);
        const threadIndex = state.threads.findIndex((thread) => thread.id === result.thread.id);
        const updatedThread = {
          ...(threadIndex >= 0 ? state.threads[threadIndex] : {}),
          ...state.currentThread,
          preview: text,
          updatedAt: Date.now(),
        };
        if (threadIndex >= 0) state.threads[threadIndex] = updatedThread;
        else state.threads.unshift(updatedThread);
        renderChatHeader();
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
      if (!result.thread?.activity && turn.status !== 'completed') {
        applyThreadActivity({
          ...threadActivity(state.currentThread),
          threadId: state.currentThread.id,
          status: body.mode === 'plan' ? 'planning' : 'running',
          phase: body.mode,
          activeTurnId: result.turn.id,
          updatedAt: Date.now(),
        });
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
    const result = await post(`/api/threads/${encodeURIComponent(state.currentThread.id)}/turns/${encodeURIComponent(state.activeTurnId)}/interrupt`);
    if (result.activity) applyThreadActivity(result.activity);
    toast('正在停止');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function syncViewChrome(name = document.querySelector('.view.active')?.dataset.view, threadId = state.currentThread?.id) {
  const chatDetail = isCompactNavigation() && name === 'chat' && Boolean(threadId);
  const artifactsDetail = isCompactNavigation() && name === 'artifacts' && Boolean(threadId);
  const projectDetail = isCompactNavigation() && name === 'projects';
  document.body.classList.toggle('mobile-chat-detail', chatDetail);
  document.body.classList.toggle('mobile-artifacts-detail', artifactsDetail);
  document.body.classList.toggle('mobile-project-detail', projectDetail);
  document.body.classList.toggle('mobile-thread-home', isCompactNavigation() && name === 'threads');
  renderChatHeader();
  renderApprovals();
}

function showTab(name, options = {}) {
  if (name === 'favorites') {
    state.threadFavoriteOnly = true;
    name = 'threads';
    if (isCompactNavigation() && (options.history ?? 'none') === 'none') options = { ...options, history: 'replace' };
  }
  if (isCompactNavigation() && ['chat', 'artifacts'].includes(name) && !state.currentThread && !options.threadId) name = 'threads';
  if (name !== 'projects' && !$('#fileUploadPopover').hidden) hideFileUploadPopover();
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  syncViewChrome(name, options.threadId);
  updateNavigationHistory(name, options.history ?? 'none', options.threadId);
  if (name === 'chat') {
    renderTimeline(false);
    updateTurnArtifactsStrips();
  }
  if (name === 'threads') {
    renderThreads();
    if (state.threadListScopeKey !== threadCollectionScope().key) {
      loadThreads().catch((error) => toast(error.message, 'error'));
    }
  }
  if (name === 'artifacts' && state.currentThread && state.artifactsThreadId !== state.currentThread.id) {
    loadArtifacts().catch((error) => toast(error.message, 'error'));
  }
  if (name === 'projects') openDefaultFileBrowser();
  if (name === 'dingtalk') {
    loadDingtalkMessages(true).catch((error) => toast(error.message, 'error'));
    startDingtalkPolling();
  } else {
    stopDingtalkPolling();
  }
  updateJumpButton();
  saveUiState();
}

async function handleNavigationChange() {
  if (!isCompactNavigation()) return;
  const route = navigationRoute() ?? { view: 'threads' };
  if (route.view === 'chat' && route.threadId) {
    if (state.currentThread?.id === route.threadId) showTab('chat', { history: 'none', threadId: route.threadId });
    else await openThread(route.threadId, { history: 'none' });
    return;
  }
  if (route.view === 'artifacts' && route.threadId) {
    if (state.currentThread?.id !== route.threadId) {
      const opened = await openThread(route.threadId, { history: 'none' });
      if (!opened) return;
    }
    showTab('artifacts', { history: 'none', threadId: route.threadId });
    return;
  }
  if (route.view === 'artifacts') {
    if (state.currentThread?.id) showTab('chat', { history: 'replace', threadId: state.currentThread.id });
    else showTab('threads', { history: 'replace' });
    return;
  }
  showTab(route.view === 'chat' ? 'threads' : route.view, { history: 'none' });
}

function connectEvents() {
  state.events?.close();
  const subscribedAt = Date.now();
  const events = new EventSource('/api/events');
  state.events = events;
  events.onopen = () => {
    setConnection('online', '已连接');
    syncPendingRequests().catch(() => {});
    loadThreads().catch(() => {});
    const openedRecently = state.threadOpenedAt && Date.now() - state.threadOpenedAt < 1500;
    if (state.currentThread && !state.activeTurnId && !openedRecently) {
      debug.log('refresh', 'sse-auto', { openedRecently: false });
      refreshCurrentThread().catch(() => {});
    } else {
      debug.log('refresh', 'sse-skipped', { openedRecently });
    }
  };
  events.onerror = () => setConnection('offline', '正在重连');
  events.addEventListener('bridge-status', (event) => {
    const status = JSON.parse(event.data);
    setConnection(status.ready ? 'online' : 'connecting', status.ready ? '已连接' : 'Codex 重启中');
  });
  events.addEventListener('bridge-error', (event) => toast(JSON.parse(event.data).message, 'error'));
  events.addEventListener('favorites', (event) => {
    setFavoriteThreads(JSON.parse(event.data).data);
    renderThreads();
  });
  events.addEventListener('thread-activity', (event) => {
    const activity = JSON.parse(event.data);
    const previous = state.threadRuntimeById.get(activity.threadId);
    applyThreadActivity(activity);
    const eventAt = Date.parse(activity.at ?? '');
    const isLive = !Number.isFinite(eventAt) || eventAt >= subscribedAt - 1000;
    const becameTerminal = ['completed', 'failed', 'interrupted'].includes(activity.status)
      && !['completed', 'failed', 'interrupted'].includes(previous?.status);
    if (isLive && becameTerminal && activity.threadId !== state.currentThread?.id) {
      const thread = state.threads.find((item) => item.id === activity.threadId);
      const name = thread?.name || thread?.preview || '后台会话';
      const label = THREAD_STATUS_LABELS[activity.status] || '状态已更新';
      navigator.vibrate?.([80, 40, 80]);
      toast(`${name}：${label}`);
    }
  });
  events.addEventListener('codex', (event) => handleCodex(JSON.parse(event.data)));
  events.addEventListener('approval', (event) => {
    const request = JSON.parse(event.data);
    state.approvals.set(request.id, request);
    const threadId = approvalThreadId(request);
    const currentActivity = threadId ? state.threadRuntimeById.get(threadId) : null;
    if (threadId && currentActivity?.status !== 'waiting') {
      applyThreadActivity({
        ...(currentActivity ?? { threadId, unreadCount: 0 }),
        threadId,
        status: 'waiting',
        attentionCount: Math.max(1, currentActivity?.attentionCount ?? 0),
      });
    }
    const visibleHere = !threadId || threadId === state.currentThread?.id;
    const chatActive = document.querySelector('.view.active')?.dataset.view === 'chat';
    if (visibleHere && chatActive) {
      for (const selector of ['#settingsSheet', '#skillSheet', '#previewDialog', '#fileShareDialog']) {
        const dialog = $(selector);
        if (dialog?.open) dialog.close();
      }
    }
    renderApprovals();
    navigator.vibrate?.([120, 60, 120]);
    toast(visibleHere && chatActive ? 'Codex 正在等待确认' : '有会话正在等待你处理');
  });
  events.addEventListener('approval-resolved', (event) => {
    const data = JSON.parse(event.data);
    const request = state.approvals.get(data.id);
    state.approvals.delete(data.id);
    const threadId = approvalThreadId(request);
    const activity = threadId ? state.threadRuntimeById.get(threadId) : null;
    if (activity?.status === 'waiting') {
      applyThreadActivity({
        ...activity,
        status: activity.activeTurnId ? (activity.phase === 'plan' ? 'planning' : 'running') : 'idle',
        attentionCount: Math.max(0, (activity.attentionCount ?? 1) - 1),
      });
    }
    renderApprovals();
  });
  events.addEventListener('artifacts', (event) => {
    const data = JSON.parse(event.data);
    if (data.threadId === state.currentThread?.id) {
      const changes = data.items ?? [];
      if (!changes.length) return;
      const removedPaths = new Set(changes
        .filter((item) => item.available === false || item.status === 'deleted')
        .map(artifactPathKey));
      const incoming = changes.filter((item) => item.available !== false
        && item.status !== 'deleted' && isDocumentArtifact(item));
      const incomingPaths = new Set(incoming.map(artifactPathKey));
      const existingPaths = new Set(state.artifacts.map(artifactPathKey));
      const addedCount = incoming.filter((item) => !existingPaths.has(artifactPathKey(item))).length;
      const removedCount = state.artifacts.filter((item) => removedPaths.has(artifactPathKey(item))).length;
      const next = [...incoming, ...state.artifacts.filter((item) => {
        const key = artifactPathKey(item);
        return !removedPaths.has(key) && !incomingPaths.has(key);
      })];
      if (setArtifacts(next)) {
        state.artifactsThreadId = data.threadId;
        state.artifactsTotal = Math.max(state.artifacts.length, state.artifactsTotal + addedCount - removedCount);
        renderArtifacts();
        refreshTimelineAfterArtifacts();
        if (incoming.length) toast(`发现 ${incoming.length} 个文档`);
      }
    }
  });
  events.addEventListener('artifact-history-ready', (event) => {
    const data = JSON.parse(event.data);
    if (data.threadId !== state.currentThread?.id) return;
    state.artifactsHistoryPending = true;
    scheduleArtifactHistoryRefresh(data.threadId, 0);
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
    showStartup('正在初始化工作现场…');
    const { threadsPromise, favoritesPromise } = await loadBootstrap();
    void loadRuntimeCatalogs();
    await Promise.all([
      threadsPromise.catch((error) => toast(error.message, 'error')),
      favoritesPromise.catch((error) => toast(error.message, 'error')),
      restoreUiState().catch((error) => toast(error.message, 'error')),
    ]);
    showApp();
    connectEvents();
    tryAutoFullscreen();
  } catch (error) {
    showLogin();
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
$('#closeThreadActionButton').addEventListener('click', closeThreadActionDialog);
$('#chatBackButton').addEventListener('click', () => backToThreadHome());
$('#artifactBackButton').addEventListener('click', backFromArtifacts);
$('#chatThreadMoreButton').addEventListener('click', () => {
  if (state.currentThread) openThreadActionDialog(state.currentThread, 'chat');
});
$('#threadArtifactsAction').addEventListener('click', openThreadArtifactsAction);
$('#threadRenameAction').addEventListener('click', openThreadRenameDialog);
$('#threadDeleteAction').addEventListener('click', confirmThreadDelete);
$('#threadDeleteCancel').addEventListener('click', () => { $('#threadDeleteConfirm').hidden = true; });
$('#threadDeleteOk').addEventListener('click', confirmThreadDeleteOk);
$('#closeThreadRenameButton').addEventListener('click', () => { $('#threadRenameDialog').close(); state.threadAction = null; });
$('#threadRenameCancel').addEventListener('click', () => { $('#threadRenameDialog').close(); state.threadAction = null; });
$('#threadRenameConfirm').addEventListener('click', confirmThreadRename);
$('#threadRenameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    confirmThreadRename();
  }
});
$('#promptInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.innerWidth > 780) sendPrompt(event);
});
$('#interruptButton').addEventListener('click', interruptTurn);
$('#fullscreenButton').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
$$('#modeSwitch button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#approvalReviewerSelect').addEventListener('change', (event) => {
  state.approvalsReviewer = ['auto_review', 'user', 'never'].includes(event.target.value) ? event.target.value : 'never';
  localStorage.setItem('codex-mobile-approvals-reviewer', state.approvalsReviewer);
  renderModeControls();
});
$('#themeSelect').addEventListener('change', (event) => {
  applyTheme(event.target.value, { persist: true, rerender: true });
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
  if (document.visibilityState === 'visible') {
    syncPendingRequests().catch(() => {});
    loadThreads().catch(() => {});
  }
});
$('#mobileNewThreadButton').addEventListener('click', () => newThread({
  cwd: state.projectBrowser?.current?.path ?? state.currentProject,
}));
$('#refreshThreadsButton').addEventListener('click', () => loadThreads().catch((error) => toast(error.message, 'error')));
$('#loadMoreThreadsButton').addEventListener('click', () => loadThreads({ append: true }).catch((error) => toast(error.message, 'error')));
$('#threadSearch').addEventListener('input', (event) => {
  state.threadSearch = event.target.value;
  renderThreads();
});
$$('#threadFilters [data-thread-scope]').forEach((button) => button.addEventListener('click', () => {
  const nextScope = button.dataset.threadScope;
  if (!['all', 'directory'].includes(nextScope) || nextScope === state.threadScope) return;
  state.threadScope = nextScope;
  loadThreads().catch((error) => toast(error.message, 'error'));
}));
$('#threadFavoriteToggle').addEventListener('click', () => {
  state.threadFavoriteOnly = !state.threadFavoriteOnly;
  renderThreads();
});
$$('#threadFilters [data-thread-filter]').forEach((button) => button.addEventListener('click', () => {
  state.threadFilter = button.dataset.threadFilter;
  renderThreads();
}));
$('#threadsView').addEventListener('scroll', (event) => {
  const view = event.currentTarget;
  if (view.scrollHeight - view.scrollTop - view.clientHeight < 160) {
    loadThreads({ append: true }).catch((error) => toast(error.message, 'error'));
  }
}, { passive: true });
$('#refreshArtifactsButton').addEventListener('click', () => loadArtifacts().catch((error) => toast(error.message, 'error')));
$('#loadOlderButton').addEventListener('click', () => loadOlderTurns().catch((error) => toast(error.message, 'error')));
initChatScroll();
initKeyboardInsets();
initDingtalk(showTab);
initFileShare();
initSkillMarket({
  refreshInstalled: async () => {
    skillsCache = null;
    try {
      const result = await api('/api/skills');
      skillsCache = result.data ?? [];
    } catch (error) {
      skillsCache = [];
      toast(error.message, 'error');
    }
    renderSkills(skillsCache);
  },
});
let artifactSearchTimer = null;
$('#artifactSearch').addEventListener('input', (event) => {
  clearTimeout(artifactSearchTimer);
  state.artifactQuery = event.target.value;
  artifactSearchTimer = setTimeout(() => {
    loadArtifactSearch(state.artifactQuery).catch((error) => toast(error.message, 'error'));
  }, 180);
});
$('#artifactList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'load-more') {
    button.disabled = true;
    const action = state.artifactQuery.trim()
      ? loadArtifactSearch(state.artifactQuery, { append: true })
      : loadArtifacts(state.currentThread?.id, { append: true });
    action.catch((error) => toast(error.message, 'error'));
    return;
  }
  const artifact = [...(state.artifactSearchResults ?? []), ...state.artifacts]
    .find((item) => item.id === button.dataset.artifactId);
  if (!artifact) return;
  if (button.dataset.action === 'share' && artifact.available) openFileShare(artifact);
  else if (button.dataset.action === 'preview' && artifact.available) openArtifact(artifact);
});
$('#timeline').addEventListener('click', (event) => {
  const link = event.target.closest('.agent-card a');
  const href = link?.getAttribute('href');
  if (link && isLocalArtifactHref(href)) {
    event.preventDefault();
    openLinkedArtifact(href).catch((error) => toast(error.message, 'error'));
    return;
  }
  const chip = event.target.closest('.turn-artifact-chip');
  if (chip) {
    const artifact = state.artifacts.find((item) => item.id === chip.dataset.artifactId);
    if (artifact) openArtifact(artifact);
    return;
  }
  if (event.target.closest('.turn-artifacts-more')) openCurrentThreadArtifacts();
});
$('#projectUpButton').addEventListener('click', () => browseProjects(state.projectBrowser.parent).catch((error) => toast(error.message, 'error')));
bindLongPress($('#projectPath'), () => {
  const current = state.projectBrowser?.current;
  if (current) showFileActions({ ...current, isDirectory: true, isCurrent: true }, $('#projectPath'));
});
$('#projectPath').addEventListener('click', () => {
  const current = state.projectBrowser?.current;
  if (current) showFileActions({ ...current, isDirectory: true, isCurrent: true }, $('#projectPath'));
});
$('#desktopUploadProjectFilesButton').addEventListener('click', () => openProjectFilePicker(state.projectBrowser?.current?.path));
$('#uploadProjectFilesButton').addEventListener('click', () => {
  const directory = fileActionTarget?.path ?? state.projectBrowser?.current?.path;
  hideFileUploadPopover();
  openProjectFilePicker(directory);
});
$('#createProjectFileButton').addEventListener('click', () => openProjectCreateDialog('file', fileActionTarget?.path));
$('#createProjectDirectoryButton').addEventListener('click', () => openProjectCreateDialog('directory', fileActionTarget?.path));
$('#deleteProjectEntryButton').addEventListener('click', () => openProjectDeleteDialog(fileActionTarget));
$('#projectFileInput').addEventListener('change', (event) => {
  const files = [...event.target.files];
  const directory = pendingProjectUploadDirectory;
  pendingProjectUploadDirectory = null;
  event.target.value = '';
  uploadProjectFiles(files, directory).catch((error) => toast(error.message, 'error'));
});
initNegativeScreenGestures();
document.addEventListener('pointerdown', (event) => {
  if ($('#fileUploadPopover').hidden) return;
  if (event.target.closest('#fileUploadPopover, [aria-expanded="true"]')) return;
  hideFileUploadPopover();
});
$('#closeProjectCreateButton').addEventListener('click', closeProjectCreateDialog);
$('#cancelProjectCreateButton').addEventListener('click', closeProjectCreateDialog);
$('#confirmProjectCreateButton').addEventListener('click', confirmProjectCreate);
$('#projectCreateDialog').addEventListener('close', () => { projectCreateDirectory = null; });
$('#projectCreateName').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    confirmProjectCreate();
  }
});
$('#closeProjectDeleteButton').addEventListener('click', closeProjectDeleteDialog);
$('#cancelProjectDeleteButton').addEventListener('click', closeProjectDeleteDialog);
$('#confirmProjectDeleteButton').addEventListener('click', confirmProjectDelete);
$('#projectDeleteDialog').addEventListener('close', () => { projectDeleteTarget = null; });
$('#closePreviewButton').addEventListener('click', () => $('#previewDialog').close());
$('#sharePreviewButton').addEventListener('click', () => openFileShare(state.currentArtifact));
$('#modifyArtifactButton').addEventListener('click', modifyCurrentArtifact);
window.addEventListener('popstate', () => { handleNavigationChange().catch((error) => toast(error.message, 'error')); });
window.matchMedia?.('(max-width: 780px)')?.addEventListener?.('change', () => {
  syncViewChrome();
  loadThreads().catch(() => {});
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
initialize().catch((error) => {
  toast(error.message, 'error');
  showLogin();
});
