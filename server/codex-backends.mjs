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

function isAvailable(backend) {
  if (typeof backend.available === 'boolean') return backend.available;
  try {
    fs.accessSync(backend.codexBin, fs.constants.X_OK);
    return fs.statSync(backend.codexHome).isDirectory();
  } catch {
    return false;
  }
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
    available: isAvailable({ ...value, codexBin, codexHome }),
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
    return this.backends.get(String(id ?? '').trim().toLowerCase()) ?? null;
  }

  runtime(id) {
    const backend = this.get(id);
    return backend ? cloneRuntime(backend) : null;
  }

  list() {
    return [...this.backends.values()].map((backend) => ({
      id: backend.id,
      label: backend.label,
      description: backend.description,
      available: backend.available,
      active: backend.id === this.activeBackendId,
    }));
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
