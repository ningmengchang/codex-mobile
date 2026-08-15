import { $, $$, toast } from './dom.js';
import { api, post } from './http.js';
import { escapeHtml } from './format.js';
import { debug } from './debug.js';

let refreshInstalled = () => {};
let currentInstall = null;
let discoverCache = null;
let discoverQuery = '';
let officialCache = null;
let searchTimer = null;

function emptyHint(list, message) {
  list.replaceChildren();
  const hint = document.createElement('p');
  hint.className = 'empty-list';
  hint.textContent = message;
  list.append(hint);
}

function renderDiscoverSkills(items) {
  const list = $('#skillDiscoverList');
  list.replaceChildren();
  if (!items.length) {
    emptyHint(list, '没有找到匹配的热门技能');
    return;
  }
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'skill-market-item';
    const action = item.installed
      ? '<span class="skill-installed">已安装</span>'
      : '<button type="button" data-install>安装</button>';
    const metrics = [];
    if (Number(item.stars) > 0) metrics.push(`<span class="skill-metric">⭐ ${item.stars}</span>`);
    if (Number(item.score) > 0) metrics.push(`<span class="skill-metric">评分 ${item.score}</span>`);
    const repo = item.repoUrl
      ? `<a class="skill-repo" href="${escapeHtml(item.repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.repo)}</a>`
      : `<small class="skill-repo">${escapeHtml(item.repo)}</small>`;
    card.innerHTML = `
      <div class="skill-market-main">
        <strong>${escapeHtml(item.name)}</strong>
        ${metrics.length ? `<span class="skill-metrics">${metrics.join('')}</span>` : ''}
        ${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}
        ${repo}
      </div>
      ${action}`;
    const button = card.querySelector('[data-install]');
    if (button) button.addEventListener('click', () => openSkillInstall(item, false));
    list.append(card);
  }
}

function renderOfficialSkills(items) {
  const list = $('#skillOfficialList');
  list.replaceChildren();
  if (!items.length) {
    emptyHint(list, '官方精选技能暂时不可用');
    return;
  }
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'skill-market-item';
    const action = item.installed
      ? '<span class="skill-installed">已安装</span>'
      : '<button type="button" data-install>安装</button>';
    const repo = item.repoUrl
      ? `<a class="skill-repo" href="${escapeHtml(item.repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.repo)}</a>`
      : (item.repo ? `<small class="skill-repo">${escapeHtml(item.repo)}</small>` : '');
    card.innerHTML = `
      <div class="skill-market-main">
        <strong>${escapeHtml(item.name)}</strong>
        ${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}
        ${repo}
      </div>
      ${action}`;
    const button = card.querySelector('[data-install]');
    if (button) button.addEventListener('click', () => openSkillInstall(item, true));
    list.append(card);
  }
}

async function loadDiscoverSkills(force = false) {
  const query = $('#skillMarketSearchInput')?.value.trim() ?? '';
  if (!force && discoverCache && discoverQuery === query) {
    renderDiscoverSkills(discoverCache);
    return;
  }
  discoverQuery = query;
  const list = $('#skillDiscoverList');
  emptyHint(list, query ? `正在搜索“${query}”…` : '正在加载热门技能…');
  try {
    const suffix = query ? `?search=${encodeURIComponent(query)}` : '';
    const result = await api(`/api/skills/market${suffix}`);
    discoverCache = result.data ?? [];
    renderDiscoverSkills(discoverCache);
    debug.log('skills', 'discover-loaded', { query, count: discoverCache.length });
  } catch (error) {
    emptyHint(list, error.message);
  }
}

async function loadOfficialSkills(force = false) {
  if (!force && officialCache) {
    renderOfficialSkills(officialCache);
    return;
  }
  const list = $('#skillOfficialList');
  emptyHint(list, '正在加载官方精选…');
  try {
    const result = await api('/api/skills/market/official');
    officialCache = result.data ?? [];
    renderOfficialSkills(officialCache);
    debug.log('skills', 'official-loaded', { count: officialCache.length });
  } catch (error) {
    emptyHint(list, error.message);
  }
}

function openSkillInstall(item, official = false) {
  currentInstall = { ...item, official };
  $('#skillInstallName').textContent = item.name;
  $('#skillInstallRepo').textContent = item.repo
    ? `${item.repo}${item.path ? ` · ${item.path}` : ''}`
    : '';
  $('#skillInstallDescription').textContent = item.description || '该技能暂无简介。';
  $('#skillPathPicker').hidden = true;
  $('#skillInstallDialog').showModal();
}

function closeSkillInstallDialog() {
  $('#skillInstallDialog').close();
  $('#skillPathPicker').hidden = true;
  currentInstall = null;
}

async function confirmSkillInstall() {
  if (!currentInstall) return;
  const button = $('#confirmSkillInstallButton');
  button.disabled = true;
  try {
    const picker = $('#skillPathPicker');
    const selectedPath = picker.hidden ? currentInstall.path : $('#skillInstallPathSelect').value;
    const installedName = currentInstall.name;
    const body = currentInstall.official
      ? { name: currentInstall.name }
      : {
          repo: currentInstall.repo,
          path: selectedPath || undefined,
          name: selectedPath && selectedPath !== '.'
            ? selectedPath.split('/').pop()
            : currentInstall.name,
        };
    await post('/api/skills/market/install', body);
    closeSkillInstallDialog();
    toast(`技能 ${installedName || body.name} 安装成功，将在下一次会话可用`);
    discoverCache = null;
    officialCache = null;
    await Promise.all([loadDiscoverSkills(true), loadOfficialSkills(true)]).catch(() => {});
    await refreshInstalled();
  } catch (error) {
    if (error.code === 'SKILL_PATH_REQUIRED' && Array.isArray(error.data?.candidates)) {
      const select = $('#skillInstallPathSelect');
      select.replaceChildren(...error.data.candidates.map((candidate) => {
        const option = document.createElement('option');
        option.value = candidate;
        option.textContent = candidate === '.' ? '仓库根目录' : candidate;
        return option;
      }));
      $('#skillPathPicker').hidden = false;
      $('#skillInstallDescription').textContent = '该仓库包含多个技能，请选择要安装的路径：';
      return;
    }
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function switchSkillTab(tab) {
  $$('#skillTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.skillTab === tab);
  });
  $('#skillList').hidden = tab !== 'installed';
  $('#skillMarketSearch').hidden = tab !== 'discover';
  $('#skillDiscoverList').hidden = tab !== 'discover';
  $('#skillOfficialList').hidden = tab !== 'official';
  if (tab === 'discover') loadDiscoverSkills();
  if (tab === 'official') loadOfficialSkills();
}

export function initSkillMarket(options = {}) {
  refreshInstalled = options.refreshInstalled ?? (() => {});
  $$('#skillTabs button').forEach((button) => {
    button.addEventListener('click', () => switchSkillTab(button.dataset.skillTab));
  });
  $('#skillMarketSearchInput')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDiscoverSkills(true), 300);
  });
  $('#closeSkillInstallButton').addEventListener('click', closeSkillInstallDialog);
  $('#cancelSkillInstallButton').addEventListener('click', closeSkillInstallDialog);
  $('#confirmSkillInstallButton').addEventListener('click', confirmSkillInstall);
}
