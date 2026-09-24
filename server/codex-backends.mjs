import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const BACKEND_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function cloneRuntime(backend) {
  return {
    codexBin: backend.codexBin ?? '/opt/codex-mobile/bin/codex',
    codexHome: backend.codexHome ?? process.env.CODEX_HOME ?? '/home/ningmengchang/.codex',
    appServerArgs: [...(backend.appServerArgs ?? ['app-server', '--stdio'])],
    defaultModel: backend.defaultModel ?? null,
    defaultEffort: backend.defaultEffort ?? null,
    skillsRoots: [...(backend.skillsRoots ?? [])],
  };
}

function hasKeyMaterial(keyFile, keyName) {
  try {
    const content = fs.readFileSync(keyFile, 'utf8');
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${keyName}\\s*=\\s*(\\S.*)$`, 'm');
    return Boolean(content.match(pattern)?.[1]?.trim());
  } catch {
    return false;
  }
}

function accountFromIdToken(idToken) {
  try {
    const payload = String(idToken ?? '').split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = typeof claims?.email === 'string' ? claims.email.trim() : '';
    return email || null;
  } catch {
    return null;
  }
}

function readAuthState(authFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const tokens = parsed?.tokens ?? {};
    if (!tokens.refresh_token) return { loggedIn: false, account: null };
    // 只读解析 id_token 里的 email，用于在手机上区分是哪个账号；解析失败不影响功能。
    return { loggedIn: true, account: accountFromIdToken(tokens.id_token) };
  } catch {
    return { loggedIn: false, account: null };
  }
}

// 每次查询都实时判定，因此新账号登录、补 key 之后无需重启网关即可生效。
function backendState(backend, override = null) {
  if (typeof override === 'boolean') return override ? 'ready' : 'disabled';
  try {
    fs.accessSync(backend.codexBin, fs.constants.X_OK);
    if (!fs.statSync(backend.codexHome).isDirectory()) return 'missing';
  } catch {
    return 'missing';
  }
  // 设备码实例：缺少 auth.json（未登录）时置灰，避免切过去停在“Codex 启动中”。
  if (backend.authFile && !readAuthState(backend.authFile).loggedIn) return 'login_required';
  // 需要外部 API Key 的 Agent（例如 GLM）在 key 文件填写之前保持不可用。
  if (backend.keyFile && backend.keyName && !hasKeyMaterial(backend.keyFile, backend.keyName)) return 'key_required';
  return 'ready';
}

function isAvailable(backend, override = null) {
  return backendState(backend, override) === 'ready';
}

function normalizeBackend(value, fallbackRuntime) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? '').trim().toLowerCase();
  if (!BACKEND_ID.test(id)) return null;
  const codexBin = String(value.codexBin ?? fallbackRuntime.codexBin ?? '').trim();
  const codexHome = String(value.codexHome ?? fallbackRuntime.codexHome ?? '').trim();
  if (!codexBin || !codexHome) return null;
  const appServerArgs = Array.isArray(value.appServerArgs) && value.appServerArgs.length
    ? value.appServerArgs.map(String)
    : [...(fallbackRuntime.appServerArgs ?? ['app-server', '--stdio'])];
  const skillsRoots = Array.isArray(value.skillsRoots)
    ? value.skillsRoots.map(String).filter(Boolean)
    : [...(fallbackRuntime.skillsRoots ?? [])];
  const keyFile = String(value.keyFile ?? '').trim();
  const keyName = String(value.keyName ?? '').trim();
  const authFile = String(value.authFile ?? '').trim();
  const availableOverride = typeof value.available === 'boolean' ? value.available : null;
  return {
    id,
    label: String(value.label ?? id).trim() || id,
    description: String(value.description ?? '').trim(),
    codexBin,
    codexHome,
    appServerArgs,
    defaultModel: String(value.defaultModel ?? fallbackRuntime.defaultModel ?? '').trim() || null,
    defaultEffort: String(value.defaultEffort ?? fallbackRuntime.defaultEffort ?? '').trim() || null,
    skillsRoots,
    keyFile: keyFile || null,
    keyName: keyName || null,
    authFile: authFile || null,
    availableOverride,
    available: isAvailable({ codexBin, codexHome, keyFile, keyName, authFile }, availableOverride),
  };
}

function readSelectedId(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof parsed?.active === 'string' ? parsed.active : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeSelectedId(filePath, active) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, active }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export class CodexBackendManager {
  constructor(config, options = {}) {
    this.config = config;
    this.filePath = options.filePath ?? config.backendStatePath ?? path.join(config.dataDir, 'codex-backend.json');
    const fallbackRuntime = cloneRuntime(config);
    const configured = options.backends ?? config.codexBackends ?? [];
    this.backends = new Map(configured
      .map((backend) => normalizeBackend(backend, fallbackRuntime))
      .filter(Boolean)
      .map((backend) => [backend.id, backend]));
    if (!this.backends.size) {
      const fallback = normalizeBackend({ id: 'gpt', label: 'GPT', available: true }, fallbackRuntime);
      this.backends.set(fallback.id, fallback);
    }
    const requested = options.activeId ?? readSelectedId(this.filePath) ?? config.defaultBackendId ?? 'gpt';
    const selected = this.backends.get(requested);
    const firstAvailable = [...this.backends.values()].find((backend) => backend.available);
    this.activeBackendId = selected?.available ? selected.id : (firstAvailable?.id ?? this.backends.keys().next().value);
    this.apply(this.activeBackendId, { persist: false });
  }

  activeId() {
    return this.activeBackendId;
  }

  get(id) {
    const backend = this.backends.get(String(id ?? '').trim().toLowerCase()) ?? null;
    // 可用性实时计算：填好 key.env 后无需重启服务即可看到并切换到该 Agent。
    if (!backend) return null;
    const state = backendState(backend, backend.availableOverride);
    return {
      ...backend,
      state,
      available: state === 'ready',
      account: state === 'ready' && backend.authFile ? readAuthState(backend.authFile).account : null,
    };
  }

  runtime(id) {
    const backend = this.get(id);
    return backend ? cloneRuntime(backend) : null;
  }

  list() {
    return [...this.backends.values()].map((backend) => {
      const state = backendState(backend, backend.availableOverride);
      return {
        id: backend.id,
        label: backend.label,
        description: backend.description,
        state,
        available: state === 'ready',
        account: state === 'ready' && backend.authFile ? readAuthState(backend.authFile).account : null,
        active: backend.id === this.activeBackendId,
      };
    });
  }

  payload() {
    return { active: this.activeBackendId, data: this.list() };
  }

  apply(id, options = {}) {
    const backend = this.get(id);
    if (!backend) throw Object.assign(new Error('未知的 Codex Agent。'), { code: 'BACKEND_NOT_FOUND' });
    if (!backend.available) throw Object.assign(new Error(`${backend.label} 当前不可用。`), { code: 'BACKEND_UNAVAILABLE' });
    Object.assign(this.config, cloneRuntime(backend), { activeBackendId: backend.id });
    this.activeBackendId = backend.id;
    if (options.persist !== false) writeSelectedId(this.filePath, backend.id);
    return this.payload();
  }
}

export function createCodexBackendManager(config, options) {
  return new CodexBackendManager(config, options);
}
