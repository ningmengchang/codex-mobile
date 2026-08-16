import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export class AppServerBridge extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.spawn = options.spawn ?? spawn;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.serverRequests = new Map();
    this.counter = 0;
    this.ready = false;
    this.starting = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  status() {
    return {
      ready: this.ready,
      pid: this.child?.pid ?? null,
      pendingRequests: this.serverRequests.size,
    };
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.#startProcess().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #startProcess() {
    const env = {
      ...process.env,
      HOME: this.config.home ?? process.env.HOME,
      CODEX_HOME: this.config.codexHome,
    };
    const child = this.spawn(this.config.codexBin, this.config.appServerArgs, {
      cwd: '/',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';

    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    child.on('error', (error) => this.emit('bridgeError', error));
    child.on('exit', (code, signal) => this.#onExit(child, code, signal));

    try {
      const initialized = await this.#requestRaw('initialize', {
        clientInfo: { name: 'codex-mobile', title: 'Codex Mobile', version: '0.2.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      }, 30_000);
      this.#write({ method: 'initialized' });
      this.ready = true;
      this.emit('status', this.status());
      return initialized;
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  async request(method, params = undefined, timeoutMs = 60_000) {
    await this.start();
    return this.#requestRaw(method, params, timeoutMs);
  }

  #requestRaw(method, params, timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex App Server 未运行。'));
    const id = `mobile:${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ method, id, params });
    });
  }

  #write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.#handle(JSON.parse(line));
      } catch (error) {
        this.emit('bridgeError', new Error(`无法解析 App Server 消息：${error.message}`));
      }
    }
  }

  #handle(message) {
    if (Object.hasOwn(message, 'id') && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (message.error) {
        const error = new Error(message.error.message ?? `Codex 请求失败：${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      const publicId = crypto.randomUUID();
      const request = {
        id: publicId,
        upstreamId: message.id,
        method: message.method,
        params: message.params ?? {},
        createdAt: Date.now(),
      };
      this.serverRequests.set(publicId, request);
      this.emit('serverRequest', { id: publicId, method: request.method, params: request.params });
      return;
    }

    if (message.method) this.emit('notification', message);
  }

  getServerRequests() {
    return [...this.serverRequests.values()].map(({ upstreamId: _upstreamId, ...request }) => request);
  }

  respondToServerRequest(publicId, result) {
    const request = this.serverRequests.get(publicId);
    if (!request) throw new Error('审批请求不存在或已经处理。');
    this.serverRequests.delete(publicId);
    this.#write({ id: request.upstreamId, result });
    this.emit('serverRequestResolved', { id: publicId, method: request.method });
  }

  rejectServerRequest(publicId, code = -32601, message = 'Unsupported client request') {
    const request = this.serverRequests.get(publicId);
    if (!request) return;
    this.serverRequests.delete(publicId);
    this.#write({ id: request.upstreamId, error: { code, message } });
    this.emit('serverRequestResolved', { id: publicId, method: request.method });
  }

  #onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server 已断开。'));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.emit('status', { ...this.status(), code, signal });
    if (!this.stopping) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.start().catch((error) => this.emit('bridgeError', error));
      }, 1500);
    }
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

export function approvalResponse(method, params, body) {
  const action = body?.action;
  if (method === 'mcpServer/elicitation/request') {
    const normalizedAction = action === 'acceptForSession' ? 'accept' : action;
    const actions = new Set(['accept', 'decline', 'cancel']);
    if (!actions.has(normalizedAction)) throw new Error('MCP 请求确认决定无效。');
    return {
      action: normalizedAction,
      content: normalizedAction === 'accept' ? (body?.content ?? null) : null,
      _meta: body?._meta ?? null,
    };
  }
  if (method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval') {
    const decisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    if (!decisions.has(action)) throw new Error('审批决定无效。');
    return { decision: action };
  }
  if (method === 'item/permissions/requestApproval') {
    const scope = body?.scope === 'session' ? 'session' : 'turn';
    if (action === 'decline' || action === 'cancel') return { permissions: {}, scope };
    if (action !== 'accept' && action !== 'acceptForSession') throw new Error('权限审批决定无效。');
    const requested = params.permissions ?? {};
    return {
      permissions: Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null)),
      scope: action === 'acceptForSession' ? 'session' : scope,
    };
  }
  if (method === 'item/tool/requestUserInput') {
    const answers = body?.answers;
    if (!answers || typeof answers !== 'object') throw new Error('必须填写问题答案。');
    return {
      answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, {
        answers: Array.isArray(value) ? value.map(String) : [String(value)],
      }])),
    };
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    const legacy = {
      accept: 'approved',
      acceptForSession: 'approved_for_session',
      decline: { denied: { rejection: String(body?.reason ?? '用户拒绝') } },
      cancel: 'abort',
    }[action];
    if (!legacy) throw new Error('审批决定无效。');
    return { decision: legacy };
  }
  throw new Error(`暂不支持处理 ${method}`);
}
