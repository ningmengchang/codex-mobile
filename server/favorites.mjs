import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LIMIT = 50;

function normalizeText(value, field, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TypeError(`${field}不能为空`);
  if (text.length > maxLength) throw new TypeError(`${field}过长`);
  return text;
}

export function normalizeFavorite(value) {
  if (!value || typeof value !== 'object') throw new TypeError('收藏内容无效');
  const updatedAt = Number(value.updatedAt);
  return {
    id: normalizeText(value.id, '会话 ID', 200),
    backend: typeof value.backend === 'string' && value.backend.trim()
      ? normalizeText(value.backend, 'Agent', 32).toLowerCase()
      : 'gpt',
    name: normalizeText(value.name || '未命名会话', '会话名称', 200),
    cwd: normalizeText(value.cwd, '项目目录', 4096),
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : Date.now(),
  };
}

function uniqueNewest(items, limit) {
  const unique = new Map();
  for (const value of items) {
    let item;
    try { item = normalizeFavorite(value); } catch { continue; }
    const key = `${item.backend}:${item.id}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit);
}

export class FavoritesStore {
  constructor(options) {
    this.filePath = options.filePath ?? path.join(options.dataDir, 'favorites.json');
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.items = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return uniqueNewest(Array.isArray(parsed) ? parsed : parsed?.data ?? [], this.limit);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 2, data: this.items }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  list(backend = null) {
    return this.items
      .filter((item) => !backend || item.backend === backend)
      .map((item) => ({ ...item }));
  }

  upsert(value) {
    const item = normalizeFavorite(value);
    this.items = uniqueNewest([
      item,
      ...this.items.filter((entry) => entry.id !== item.id || entry.backend !== item.backend),
    ], this.limit);
    this.#write();
    return this.list();
  }

  import(items) {
    const existing = new Set(this.items.map((item) => `${item.backend}:${item.id}`));
    const additions = uniqueNewest(items, this.limit)
      .filter((item) => !existing.has(`${item.backend}:${item.id}`));
    if (additions.length) {
      this.items = uniqueNewest([...this.items, ...additions], this.limit);
      this.#write();
    }
    return this.list();
  }

  rename(id, name, backend = 'gpt') {
    const targetId = normalizeText(id, '会话 ID', 200);
    const targetName = normalizeText(name, '会话名称', 200);
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== targetId || item.backend !== backend || item.name === targetName) return item;
      changed = true;
      return { ...item, name: targetName, updatedAt: Date.now() };
    });
    if (changed) this.#write();
    return this.list();
  }

  remove(id, backend = 'gpt') {
    const targetId = normalizeText(id, '会话 ID', 200);
    const next = this.items.filter((item) => item.id !== targetId || item.backend !== backend);
    if (next.length !== this.items.length) {
      this.items = next;
      this.#write();
    }
    return this.list();
  }
}

export function createFavoritesStore(config) {
  return new FavoritesStore({ dataDir: config.dataDir });
}
