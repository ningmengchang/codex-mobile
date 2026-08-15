import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from './security.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_SCRIPTS_DIR = '/home/ningmengchang/.codex/skills/.system/skill-installer/scripts';
const MARKET_REPO = 'openai/skills';
const MARKET_PATH = 'skills/.curated';
const COMMUNITY_API = 'https://agentskillshub.top/api/skills';
const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6_000;

function parseDescription(source) {
  const match = String(source ?? '').match(/^---\n([\s\S]*?)\n---/);
  const meta = match?.[1] ?? '';
  return meta.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function createSkillMarket(config, options = {}) {
  const exec = options.exec ?? execFileAsync;
  const scriptsDir = options.scriptsDir ?? process.env.CODEX_MOBILE_SKILL_INSTALLER_SCRIPTS ?? DEFAULT_SCRIPTS_DIR;
  const codexHome = config.codexHome ?? process.env.CODEX_HOME ?? '/home/ningmengchang/.codex';
  const home = config.home ?? process.env.HOME ?? '/home/ningmengchang';
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const communityCache = { at: 0, items: [] };
  const officialCache = { at: 0, items: [] };

  async function run(args) {
    const { stdout } = await exec('python3', args, {
      cwd: scriptsDir,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  async function requestJson(url, { auth = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'codex-mobile/1.0',
    };
    const token = auth ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '' : '';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`上游接口返回 HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'codex-mobile/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) return '';
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function installedSkillNames() {
    const names = new Set();
    const roots = config.skillsRoots?.length
      ? config.skillsRoots
      : [path.join(codexHome, 'skills')];
    for (const root of roots) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        names.add(entry.name);
        if (entry.name === '.system') {
          try {
            for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
              if (sub.isDirectory()) names.add(sub.name);
            }
          } catch {}
        }
      }
    }
    return names;
  }

  function normalizeCommunityItem(raw, installed) {
    const repoFullName = String(raw.repo_full_name ?? raw.full_name ?? raw.repoFullName ?? raw.repo ?? '').trim();
    if (!repoFullName) return null;
    const repoName = String(raw.repo_name ?? repoFullName.split('/').pop() ?? repoFullName).trim() || repoFullName;
    const name = String(raw.skill_name ?? raw.name ?? raw.skillName ?? repoName).trim() || repoName;
    const rawPaths = Array.isArray(raw.paths) ? raw.paths : [];
    const pathValue = String(
      raw.skill_path ?? raw.path ?? raw.skillPath ?? rawPaths[0] ?? '',
    ).trim();
    return {
      name,
      description: String(raw.description ?? '').trim(),
      stars: Number(raw.stars ?? raw.stargazers_count ?? 0) || 0,
      score: Number(raw.score ?? raw.quality_score ?? 0) || 0,
      repo: repoFullName,
      repoUrl: String(raw.repo_url ?? raw.html_url ?? raw.repoUrl ?? `https://github.com/${repoFullName}`),
      path: pathValue,
      installed: installed.has(name) || installed.has(repoName),
    };
  }

  async function listCommunitySkills(search = '') {
    const query = String(search ?? '').trim();
    if (!query && Date.now() - communityCache.at < CACHE_TTL_MS && communityCache.items.length) {
      return communityCache.items;
    }
    let rawItems = [];
    try {
      const params = new URLSearchParams({
        category: 'codex-skill',
        sort_by: 'stars',
        sort_order: 'desc',
        page_size: '100',
      });
      if (query) params.set('search', query);
      const payload = await requestJson(`${COMMUNITY_API}?${params}`);
      rawItems = extractItems(payload);
    } catch {
      const params = new URLSearchParams({
        q: query ? `${query} codex-skill in:name,description,topics` : 'codex-skill in:name,description,topics',
        sort: 'stars',
        order: 'desc',
        per_page: '100',
      });
      const payload = await requestJson(`${GITHUB_API}/search/repositories?${params}`, { auth: true });
      rawItems = extractItems(payload);
    }
    const installed = installedSkillNames();
    const items = rawItems
      .map((raw) => normalizeCommunityItem(raw, installed))
      .filter(Boolean)
      .sort((a, b) => b.stars - a.stars || b.score - a.score);
    if (!query) {
      communityCache.at = Date.now();
      communityCache.items = items;
    }
    return items;
  }

  async function fetchOfficialDescription(name) {
    const url = `https://raw.githubusercontent.com/${MARKET_REPO}/main/${MARKET_PATH}/${encodeURIComponent(name)}/SKILL.md`;
    return parseDescription(await requestText(url));
  }

  async function listOfficialSkills(force = false) {
    if (!force && Date.now() - officialCache.at < CACHE_TTL_MS && officialCache.items.length) return officialCache.items;
    const stdout = await run(['list-skills.py', '--repo', MARKET_REPO, '--path', MARKET_PATH, '--format', 'json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('官方技能列表解析失败');
    }
    const items = await Promise.all((Array.isArray(parsed) ? parsed : []).map(async (entry) => ({
      name: entry.name,
      installed: Boolean(entry.installed),
      description: entry.installed ? '' : await fetchOfficialDescription(entry.name).catch(() => ''),
      stars: 0,
      score: 0,
      repo: MARKET_REPO,
      repoUrl: `https://github.com/${MARKET_REPO}/tree/main/${MARKET_PATH}/${encodeURIComponent(entry.name)}`,
      path: `${MARKET_PATH}/${entry.name}`,
    })));
    officialCache.items = items;
    officialCache.at = Date.now();
    return items;
  }

  async function installOfficialSkill(name) {
    const items = await listOfficialSkills(true);
    if (!items.some((entry) => entry.name === name)) throw new Error('技能不在官方精选列表中');
    await run(['install-skill-from-github.py', '--repo', MARKET_REPO, '--path', `${MARKET_PATH}/${name}`]);
    officialCache.at = 0;
    return { installed: true };
  }

  async function resolveSkillPaths(repo) {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      try {
        const repoInfo = await requestJson(`${GITHUB_API}/repos/${repo}`, { auth: true });
        const ref = repoInfo?.default_branch ?? 'main';
        const treePayload = await requestJson(
          `${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          { auth: true, timeoutMs: 15_000 },
        );
        const paths = [...new Set(
          (treePayload?.tree ?? [])
            .filter((entry) => entry.type === 'blob' && entry.path.toLowerCase() === 'skill.md' || entry.path.toLowerCase().endsWith('/skill.md'))
            .map((entry) => {
              const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
              return parent || '.';
            }),
        )];
        if (paths.length) return { paths, defaultBranch: ref };
      } catch {
        // 令牌解析失败时继续走归档扫描。
      }
    }
    return resolvePathsFromArchive(repo);
  }

  async function resolvePathsFromArchive(repo) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-skill-resolve-'));
    const zipPath = path.join(tempDir, 'repo.zip');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let response;
      try {
        response = await fetchImpl(`https://codeload.github.com/${repo}/zip/HEAD`, {
          headers: { 'User-Agent': 'codex-mobile/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`下载仓库失败：HTTP ${response.status}`);
      fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
      const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    paths = set()
    for name in archive.namelist():
        if name.lower().endswith("/skill.md"):
            parent = name.rsplit("/", 1)[0]
            rel = parent.split("/", 1)[1] if "/" in parent else "."
            paths.add(rel)
    print(json.dumps(sorted(paths)))
`;
      const { stdout } = await exec('python3', ['-c', script, zipPath], {
        cwd: scriptsDir,
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout);
      return { paths: Array.isArray(parsed) ? parsed.slice(0, 100) : [], defaultBranch: 'HEAD' };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function installCommunitySkill({ repo, path: skillPath, name } = {}) {
    const repoFull = String(repo ?? '').trim();
    if (!/^[^/]+\/[^/]+$/.test(repoFull)) throw new Error('仓库格式必须为 owner/repo。');
    const items = await listCommunitySkills();
    if (!items.some((item) => item.repo.toLowerCase() === repoFull.toLowerCase())) {
      throw new Error('该技能不在当前社区列表中');
    }
    const { paths, defaultBranch } = await resolveSkillPaths(repoFull);
    let targetPath = String(skillPath ?? '').trim();
    if (!targetPath) {
      if (!paths.length) throw new Error('在仓库中未找到 SKILL.md，无法一键安装。');
      if (paths.length > 1) {
        const error = new AppError('该仓库包含多个技能，请选择要安装的路径。', 400, 'SKILL_PATH_REQUIRED');
        error.data = { repo: repoFull, candidates: paths };
        throw error;
      }
      targetPath = paths[0];
    }
    if (!paths.includes(targetPath)) throw new Error('技能路径不在该仓库可安装路径中。');
    const targetName = String(name ?? '').trim() || (targetPath === '.' ? repoFull.split('/')[1] : targetPath.split('/').pop());
    await run([
      'install-skill-from-github.py',
      '--repo', repoFull,
      '--path', targetPath,
      '--name', targetName,
      '--ref', defaultBranch,
    ]);
    communityCache.at = 0;
    return { installed: true, name: targetName, repo: repoFull, path: targetPath };
  }

  return {
    listCommunitySkills,
    listOfficialSkills,
    installCommunitySkill,
    installOfficialSkill,
    resolveSkillPaths,
  };
}
