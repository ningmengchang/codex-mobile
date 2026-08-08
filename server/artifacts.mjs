import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyFile, fileMetadata, findRecentFiles, IGNORED_DIRECTORIES } from './files.mjs';
import { assertAllowedPath, createArtifactToken, isInside } from './security.mjs';

const execFileAsync = promisify(execFile);

function entryState(entryPath) {
  const stat = fs.lstatSync(entryPath);
  return {
    path: entryPath,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    uid: stat.uid,
    gid: stat.gid,
    dev: stat.dev,
  };
}

export function snapshotTree(rootPath, options = {}) {
  const maxVisited = options.maxVisited ?? 30_000;
  const result = new Map();
  const rootState = entryState(rootPath);
  result.set(rootPath, rootState);
  const queue = [rootPath];
  let visited = 0;
  while (queue.length && visited < maxVisited) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > maxVisited) break;
      if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      try {
        const state = entryState(fullPath);
        if (state.dev !== rootState.dev) continue;
        result.set(fullPath, state);
        if (state.isDirectory) queue.push(fullPath);
      } catch {
        // Files may disappear while a command is replacing them.
      }
    }
  }
  return result;
}

function changed(before, after) {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.uid !== after.uid || before.gid !== after.gid;
}

function nearestExistingAncestor(filePath, before) {
  let current = filePath;
  while (true) {
    if (before.has(current)) return before.get(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class ArtifactTracker {
  constructor(config, eventHub, options = {}) {
    this.config = config;
    this.eventHub = eventHub;
    this.execFile = options.execFile ?? execFileAsync;
    this.captures = new Map();
    this.threadProjects = new Map();
    this.items = [];
    this.storePath = path.join(config.dataDir, 'artifacts.json');
    this.targetUid = fs.statSync('/home/ningmengchang').uid;
    this.targetGid = fs.statSync('/home/ningmengchang').gid;
    this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (Array.isArray(parsed.items)) this.items = parsed.items.slice(-1000);
      if (parsed.threadProjects && typeof parsed.threadProjects === 'object') {
        this.threadProjects = new Map(Object.entries(parsed.threadProjects));
      }
    } catch {}
  }

  #persist() {
    const temp = `${this.storePath}.tmp`;
    const data = JSON.stringify({
      items: this.items.slice(-1000),
      threadProjects: Object.fromEntries(this.threadProjects),
    });
    fs.writeFileSync(temp, `${data}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.storePath);
  }

  registerThread(threadId, cwd) {
    if (!threadId || !cwd) return;
    const allowed = assertAllowedPath(cwd, this.config.allowedRoots);
    this.threadProjects.set(threadId, allowed);
  }

  begin(threadId, cwd) {
    const root = assertAllowedPath(cwd, this.config.allowedRoots);
    this.registerThread(threadId, root);
    this.captures.set(threadId, {
      threadId,
      turnId: null,
      cwd: root,
      before: snapshotTree(root),
      protocolChanges: new Map(),
      startedAt: Date.now(),
    });
  }

  bindTurn(threadId, turnId) {
    const capture = this.captures.get(threadId);
    if (capture) capture.turnId = turnId;
  }

  recordProtocolChanges(threadId, turnId, changes = []) {
    const capture = this.captures.get(threadId);
    if (!capture) return;
    if (turnId) capture.turnId = turnId;
    for (const change of changes) {
      if (!change?.path) continue;
      const candidate = path.isAbsolute(change.path) ? change.path : path.join(capture.cwd, change.path);
      if (!isInside(capture.cwd, path.resolve(candidate))) continue;
      capture.protocolChanges.set(path.resolve(candidate), change.kind ?? 'modified');
    }
  }

  async finish(threadId, turnId = null) {
    const capture = this.captures.get(threadId);
    if (!capture) return [];
    this.captures.delete(threadId);
    if (turnId) capture.turnId = turnId;
    const after = snapshotTree(capture.cwd);
    const changedPaths = new Map(capture.protocolChanges);

    for (const [entryPath, state] of after) {
      const previous = capture.before.get(entryPath);
      if (!previous) changedPaths.set(entryPath, 'added');
      else if (changed(previous, state)) changedPaths.set(entryPath, 'modified');
    }
    for (const entryPath of capture.before.keys()) {
      if (!after.has(entryPath)) changedPaths.set(entryPath, 'deleted');
    }

    await this.#restoreOwnership(capture, after, changedPaths);
    const artifacts = [];
    for (const [entryPath, status] of changedPaths) {
      const state = after.get(entryPath);
      if (state?.isDirectory || entryPath === capture.cwd) continue;
      const exists = Boolean(state?.isFile);
      let metadata = {
        name: path.basename(entryPath),
        relativePath: path.relative(capture.cwd, entryPath),
        fileKind: classifyFile(entryPath),
        size: 0,
        modifiedAt: new Date().toISOString(),
      };
      if (exists) {
        try { metadata = fileMetadata(entryPath, capture.cwd); } catch {}
      }
      artifacts.push({
        id: `${capture.threadId}:${capture.turnId ?? 'unknown'}:${metadata.relativePath}`,
        threadId: capture.threadId,
        turnId: capture.turnId,
        projectPath: capture.cwd,
        path: entryPath,
        status: status === 'delete' ? 'deleted' : status,
        capturedAt: new Date().toISOString(),
        ...metadata,
      });
    }

    const ids = new Set(artifacts.map((item) => item.id));
    this.items = this.items.filter((item) => !ids.has(item.id)).concat(artifacts).slice(-1000);
    this.#persist();
    this.eventHub?.publish('artifacts', { threadId, turnId: capture.turnId, items: this.present(artifacts) });
    return this.present(artifacts);
  }

  async finishAll() {
    for (const threadId of [...this.captures.keys()]) {
      try { await this.finish(threadId); } catch {}
    }
  }

  #shouldRestoreOwnership(entryPath, capture, after) {
    const current = after.get(entryPath);
    if (!current || current.isSymbolicLink || current.dev !== after.get(capture.cwd)?.dev) return false;
    if (current.uid !== 0 && current.gid !== 0) return false;
    const previous = capture.before.get(entryPath);
    if (previous) return previous.uid === this.targetUid && previous.gid === this.targetGid;
    const ancestor = nearestExistingAncestor(path.dirname(entryPath), capture.before);
    return Boolean(ancestor && ancestor.uid === this.targetUid && ancestor.gid === this.targetGid);
  }

  async #restoreOwnership(capture, after, changedPaths) {
    const paths = [...changedPaths.keys()]
      .filter((entryPath) => this.#shouldRestoreOwnership(entryPath, capture, after))
      .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      if (!batch.length) continue;
      try {
        await this.execFile(this.config.ownershipHelper, batch, { timeout: 30_000 });
        await this.execFile(this.config.ownershipHelper, ['--check', ...batch], { timeout: 30_000 });
      } catch (error) {
        this.eventHub?.publish('ownership-error', {
          threadId: capture.threadId,
          paths: batch.map((item) => path.relative(capture.cwd, item)),
          message: error.message,
        });
      }
    }
  }

  present(items) {
    return items.map(({ path: filePath, ...item }) => ({
      ...item,
      available: item.status !== 'deleted' && fs.existsSync(filePath),
      token: item.status !== 'deleted' && fs.existsSync(filePath)
        ? createArtifactToken(filePath, this.config)
        : null,
    }));
  }

  list(threadId) {
    const tracked = this.items.filter((item) => item.threadId === threadId).slice().reverse();
    if (tracked.length) return this.present(tracked);
    const cwd = this.threadProjects.get(threadId);
    if (!cwd || !fs.existsSync(cwd)) return [];
    return findRecentFiles(cwd, { limit: 40 }).map(({ path: filePath, ...metadata }) => ({
      id: `recent:${threadId}:${metadata.relativePath}`,
      threadId,
      turnId: null,
      projectPath: cwd,
      path: undefined,
      status: 'recent',
      capturedAt: metadata.modifiedAt,
      ...metadata,
      available: true,
      token: createArtifactToken(filePath, this.config),
    }));
  }
}
