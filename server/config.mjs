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
  // 主实例的技能目录：所有 Agent 共享，保证每个实例都能用到同一批技能。
  const sharedSkillsRoot = '/home/ningmengchang/.codex/skills';
  const skillsRoots = overrides.skillsRoots
    ?? (process.env.CODEX_MOBILE_SKILLS_ROOTS
      ? process.env.CODEX_MOBILE_SKILLS_ROOTS.split(path.delimiter).filter(Boolean)
      : [sharedSkillsRoot, '/home/ningmengchang/.agents/skills']);
  const deepseekHome = process.env.CODEX_MOBILE_DEEPSEEK_HOME ?? '/home/ningmengchang/.codex-ds';
  const deepseekSkillsRoots = process.env.CODEX_MOBILE_DEEPSEEK_SKILLS_ROOTS
    ? process.env.CODEX_MOBILE_DEEPSEEK_SKILLS_ROOTS.split(path.delimiter).filter(Boolean)
    : [path.join(deepseekHome, 'skills'), '/home/ningmengchang/.agents/skills'];
  const glmHome = process.env.CODEX_MOBILE_GLM_HOME ?? '/home/ningmengchang/.codex-glm';
  const glmSkillsRoots = process.env.CODEX_MOBILE_GLM_SKILLS_ROOTS
    ? process.env.CODEX_MOBILE_GLM_SKILLS_ROOTS.split(path.delimiter).filter(Boolean)
    : [path.join(glmHome, 'skills'), sharedSkillsRoot, '/home/ningmengchang/.agents/skills'];
  // 额外的设备码登录实例：各自独立 CODEX_HOME，各自 codex login --device-auth。
  // 未登录（缺少 auth.json）时由 CodexBackendManager 实时置灰，不会误切。
  const deviceAccountBackends = [
    {
      id: 'codex1',
      label: 'Codex1',
      description: '设备码登录 · 备用账号 1',
      home: process.env.CODEX_MOBILE_CODEX1_HOME ?? '/home/ningmengchang/.codex1',
      skillsEnv: 'CODEX_MOBILE_CODEX1_SKILLS_ROOTS',
    },
    {
      id: 'codex2',
      label: 'Codex2',
      description: '设备码登录 · 备用账号 2',
      home: process.env.CODEX_MOBILE_CODEX2_HOME ?? '/home/ningmengchang/.codex2',
      skillsEnv: 'CODEX_MOBILE_CODEX2_SKILLS_ROOTS',
    },
    {
      id: 'codex3',
      label: 'Codex3',
      description: '设备码登录 · 备用账号 3',
      home: process.env.CODEX_MOBILE_CODEX3_HOME ?? '/home/ningmengchang/.codex3',
      skillsEnv: 'CODEX_MOBILE_CODEX3_SKILLS_ROOTS',
    },
  ].map((account) => {
    const skillsOverride = process.env[account.skillsEnv];
    return {
      id: account.id,
      label: account.label,
      description: account.description,
      codexBin,
      codexHome: account.home,
      appServerArgs,
      defaultModel,
      defaultEffort,
      skillsRoots: skillsOverride
        ? skillsOverride.split(path.delimiter).filter(Boolean)
        : [path.join(account.home, 'skills'), sharedSkillsRoot, '/home/ningmengchang/.agents/skills'],
      authFile: path.join(account.home, 'auth.json'),
    };
  });
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
    {
      id: 'glm',
      label: 'GLM',
      description: '智谱 Coding Plan · 独立本地配置',
      codexBin: process.env.CODEX_MOBILE_GLM_BIN ?? '/home/ningmengchang/.local/bin/codex-glm',
      codexHome: glmHome,
      appServerArgs,
      defaultModel: process.env.CODEX_MOBILE_GLM_MODEL ?? 'glm-5.3-flash',
      defaultEffort: process.env.CODEX_MOBILE_GLM_EFFORT ?? 'max',
      skillsRoots: glmSkillsRoots,
      keyFile: path.join(glmHome, 'key.env'),
      keyName: 'ZHIPU_API_KEY',
    },
    ...deviceAccountBackends,
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
    chatImageDir: overrides.chatImageDir
      ?? process.env.CODEX_MOBILE_CHAT_IMAGE_DIR
      ?? path.join(dataDir, 'chat-images'),
    maxInputImageBytes: overrides.maxInputImageBytes
      ?? positiveInteger(process.env.CODEX_MOBILE_MAX_INPUT_IMAGE_BYTES, 8 * 1024 * 1024),
    maxInputImages: overrides.maxInputImages
      ?? positiveInteger(process.env.CODEX_MOBILE_MAX_INPUT_IMAGES, 4),
    chatImageTokenTtlSeconds: overrides.chatImageTokenTtlSeconds
      ?? positiveInteger(process.env.CODEX_MOBILE_CHAT_IMAGE_TOKEN_TTL_SECONDS, 24 * 60 * 60),
    chatImagePendingTtlSeconds: overrides.chatImagePendingTtlSeconds
      ?? positiveInteger(process.env.CODEX_MOBILE_CHAT_IMAGE_PENDING_TTL_SECONDS, 24 * 60 * 60),
    handoffMaxBytes: overrides.handoffMaxBytes
      ?? positiveInteger(process.env.CODEX_MOBILE_HANDOFF_MAX_BYTES, 5 * 1024 * 1024),
    handoffRecentTurns: overrides.handoffRecentTurns
      ?? positiveInteger(process.env.CODEX_MOBILE_HANDOFF_RECENT_TURNS, 500),
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
