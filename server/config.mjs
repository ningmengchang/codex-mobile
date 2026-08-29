import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = '/home/ningmengchang/ideaProjects';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function ensurePrivateSecret(secretPath) {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    const value = fs.readFileSync(secretPath, 'utf8').trim();
    if (value) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  return secret;
}

function loadRoots(rawRoots) {
  return [...new Set((rawRoots || DEFAULT_ROOT)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => fs.realpathSync(path.resolve(entry))))];
}

export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? process.env.CODEX_MOBILE_DATA_DIR ?? '/var/lib/codex-mobile';
  const cacheDir = overrides.cacheDir ?? process.env.CODEX_MOBILE_CACHE_DIR ?? '/var/cache/codex-mobile';
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const secretPath = overrides.secretPath ?? path.join(dataDir, 'secret');
  const codexBin = overrides.codexBin
    ?? process.env.CODEX_MOBILE_CODEX_BIN
    ?? (fs.existsSync('/opt/codex-mobile/bin/codex')
      ? '/opt/codex-mobile/bin/codex'
      : '/home/ningmengchang/.local/bin/codex');
  const codexHome = overrides.codexHome ?? process.env.CODEX_HOME ?? '/root/.codex';
  const appServerArgs = overrides.appServerArgs ?? ['app-server', '--stdio'];
  const defaultModel = overrides.defaultModel
    ?? process.env.CODEX_MOBILE_DEFAULT_MODEL
    ?? 'gpt-5.6-sol';
  const defaultEffort = overrides.defaultEffort
    ?? process.env.CODEX_MOBILE_DEFAULT_EFFORT
    ?? 'max';
  const skillsRoots = overrides.skillsRoots
    ?? (process.env.CODEX_MOBILE_SKILLS_ROOTS
      ? process.env.CODEX_MOBILE_SKILLS_ROOTS.split(path.delimiter).filter(Boolean)
      : ['/home/ningmengchang/.codex/skills', '/home/ningmengchang/.agents/skills']);
  const deepseekHome = process.env.CODEX_MOBILE_DEEPSEEK_HOME ?? '/home/ningmengchang/.codex-ds';
  const deepseekSkillsRoots = process.env.CODEX_MOBILE_DEEPSEEK_SKILLS_ROOTS
    ? process.env.CODEX_MOBILE_DEEPSEEK_SKILLS_ROOTS.split(path.delimiter).filter(Boolean)
    : [path.join(deepseekHome, 'skills'), '/home/ningmengchang/.agents/skills'];
  const codexBackends = overrides.codexBackends ?? [
    {
      id: 'gpt',
      label: 'GPT',
      description: '设备码登录 · OpenAI',
      codexBin,
      codexHome,
      appServerArgs,
      defaultModel,
      defaultEffort,
      skillsRoots,
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      description: '独立本地配置',
      codexBin: process.env.CODEX_MOBILE_DEEPSEEK_BIN ?? '/home/ningmengchang/.local/bin/codex-ds',
      codexHome: deepseekHome,
      appServerArgs,
      defaultModel: process.env.CODEX_MOBILE_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      defaultEffort: process.env.CODEX_MOBILE_DEEPSEEK_EFFORT ?? 'high',
      skillsRoots: deepseekSkillsRoots,
    },
  ];
  return {
    host: overrides.host ?? process.env.CODEX_MOBILE_HOST ?? '127.0.0.1',
    port: overrides.port ?? positiveInteger(process.env.CODEX_MOBILE_PORT, 3765),
    dataDir,
    cacheDir,
    secretPath,
    secret: overrides.secret ?? process.env.CODEX_MOBILE_SECRET ?? ensurePrivateSecret(secretPath),
    allowedRoots: overrides.allowedRoots
      ? overrides.allowedRoots.map((entry) => fs.realpathSync(path.resolve(entry)))
      : loadRoots(process.env.CODEX_MOBILE_ALLOWED_ROOTS),
    skillsRoots,
    codexBin,
    codexHome,
    sessionTtlSeconds: overrides.sessionTtlSeconds
      ?? positiveInteger(process.env.CODEX_MOBILE_SESSION_TTL_SECONDS, 30 * 24 * 60 * 60),
    artifactTtlSeconds: overrides.artifactTtlSeconds
      ?? positiveInteger(process.env.CODEX_MOBILE_ARTIFACT_TTL_SECONDS, 24 * 60 * 60),
    maxFileBytes: overrides.maxFileBytes
      ?? positiveInteger(process.env.CODEX_MOBILE_MAX_FILE_BYTES, 512 * 1024 * 1024),
    maxBodyBytes: overrides.maxBodyBytes
      ?? positiveInteger(process.env.CODEX_MOBILE_MAX_BODY_BYTES, 2 * 1024 * 1024),
    handoffMaxBytes: overrides.handoffMaxBytes
      ?? positiveInteger(process.env.CODEX_MOBILE_HANDOFF_MAX_BYTES, 64 * 1024),
    handoffRecentTurns: overrides.handoffRecentTurns
      ?? positiveInteger(process.env.CODEX_MOBILE_HANDOFF_RECENT_TURNS, 20),
    defaultModel,
    defaultEffort,
    ownershipHelper: overrides.ownershipHelper
      ?? process.env.CODEX_MOBILE_OWNERSHIP_HELPER
      ?? '/root/.codex/bin/fix-ningmengchang-ownership',
    targetUser: overrides.targetUser ?? process.env.CODEX_MOBILE_TARGET_USER ?? 'ningmengchang',
    targetGroup: overrides.targetGroup ?? process.env.CODEX_MOBILE_TARGET_GROUP ?? 'ningmengchang',
    logLevel: overrides.logLevel ?? process.env.CODEX_MOBILE_LOG_LEVEL ?? 'info',
    appServerArgs,
    codexBackends,
    defaultBackendId: overrides.defaultBackendId ?? process.env.CODEX_MOBILE_DEFAULT_BACKEND ?? 'gpt',
    backendStatePath: overrides.backendStatePath ?? path.join(dataDir, 'codex-backend.json'),
    home: overrides.home ?? os.homedir(),
    disableAppServer: overrides.disableAppServer ?? false,
  };
}
