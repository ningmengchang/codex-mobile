import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError, assertAllowedPath } from './security.mjs';

const HELPER = fileURLToPath(new URL('./terminal-pty.py', import.meta.url));
const MAX_BUFFER = 256 * 1024;
const IDLE_MS = 30 * 60 * 1000;
const LIFETIME_MS = 8 * 60 * 60 * 1000;
const reject = (message, status = 400) => { throw new AppError(message, status, 'TERMINAL_ERROR'); };
const size = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

export function createTerminalManager(config) {
  const sessions = new Map();
  function owned(id, owner, backend) {
    const session = sessions.get(id);
    if (!session || session.owner !== owner || session.backend !== backend) reject('终端不存在、已过期或不属于当前登录与 Agent。', 404);
    return session;
  }
  function stop(session) {
    session.running = false;
    session.child.kill('SIGTERM');
  }
  function metadata(session) {
    return { id: session.id, threadId: session.threadId, backend: session.backend, cwd: session.cwd,
      running: session.running, nextSeq: session.nextSeq, exitCode: session.exitCode ?? null };
  }
  const timer = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.touched > IDLE_MS || Date.now() - session.created > LIFETIME_MS) {
        stop(session);
        sessions.delete(id);
      }
    }
  }, 30_000);
  timer.unref();
  return {
    async create({ owner, backend, threadId, cwd, acknowledged }) {
      if (acknowledged !== true) reject('请先确认手动终端的权限说明。');
      if (process.getuid?.() === 0) reject('为保护电脑，禁止以 root 身份启动网页终端。', 403);
      if (!owner || typeof threadId !== 'string' || !threadId || threadId.length > 160) reject('缺少终端所属会话。');
      const directory = assertAllowedPath(cwd, config.allowedRoots);
      if (!fs.statSync(directory).isDirectory()) reject('终端工作目录不是目录。');
      for (const session of sessions.values()) {
        if (session.owner === owner && session.backend === backend && session.threadId === threadId && session.running) {
          await session.ready;
          return metadata(session);
        }
        if (session.owner === owner && session.backend === backend && session.threadId === threadId && !session.running) {
          stop(session); sessions.delete(session.id);
        }
      }
      if (sessions.size >= 12 || [...sessions.values()].filter(s => s.owner === owner).length >= 4) {
        reject('最多保留 4 个终端，请先结束不需要的终端。', 429);
      }
      const user = os.userInfo();
      // Do not pass gateway secrets, provider keys or Node/Python injection variables.
      const env = { HOME: user.homedir, USER: user.username, LOGNAME: user.username,
        PATH: `${user.homedir}/.local/bin:/usr/local/bin:/usr/bin:/bin`, SHELL: '/bin/bash',
        LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
        HISTFILE: '/dev/null', PS1: '\\W \\$ ' };
      const child = spawn('/usr/bin/python3', ['-u', HELPER], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const session = { id: crypto.randomUUID(), owner, backend, threadId, cwd: directory,
        child, running: true, nextSeq: 1, buffer: Buffer.alloc(0), start: 0, end: 0,
        touched: Date.now(), created: Date.now() };
      sessions.set(session.id, session);
      let resolveReady, rejectReady;
      session.ready = new Promise((resolve, rejectPromise) => { resolveReady = resolve; rejectReady = rejectPromise; });
      const timeout = setTimeout(() => { stop(session); rejectReady(new AppError('启动终端超时。', 503)); }, 5000);
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        pending += chunk;
        if (pending.length > MAX_BUFFER * 2) { stop(session); return; }
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let event;
          try { event = JSON.parse(line); } catch { stop(session); break; }
          if (event.type === 'ready') { clearTimeout(timeout); resolveReady(); }
          if (event.type === 'output') {
            const bytes = Buffer.from(event.data, 'base64');
            session.end += bytes.length;
            session.buffer = Buffer.concat([session.buffer, bytes]);
            if (session.buffer.length > MAX_BUFFER) session.buffer = Buffer.from(session.buffer.subarray(-MAX_BUFFER));
            session.start = session.end - session.buffer.length;
            session.touched = Date.now();
          }
          if (event.type === 'exit') { session.running = false; session.exitCode = event.code; }
        }
      });
      child.stderr.resume(); // Never forward transport tracebacks or environment details to clients.
      child.stdin.on('error', () => { session.running = false; });
      child.on('error', () => { session.running = false; clearTimeout(timeout); rejectReady(new AppError('无法启动终端，请检查 Python 3。', 503)); });
      child.on('close', code => { session.running = false; session.exitCode ??= code; clearTimeout(timeout); rejectReady(new AppError('终端进程已退出。', 503)); });
      try { await session.ready; } catch (error) { sessions.delete(session.id); throw error; }
      return metadata(session);
    },
    read(id, owner, backend, cursor = 0) {
      const s = owned(id, owner, backend);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > s.end) reject('终端输出游标无效。');
      const start = Math.max(cursor, s.start);
      return { ...metadata(s), cursor: s.end, truncated: cursor < s.start,
        data: s.buffer.subarray(start - s.start).toString('base64') };
    },
    input(id, owner, backend, { seq, data }) {
      const s = owned(id, owner, backend);
      if (!Number.isSafeInteger(seq) || seq < 1 || typeof data !== 'string' || Buffer.byteLength(data) > 16384) reject('终端输入无效或过长。');
      if (seq === s.nextSeq - 1 && s.lastInput === data) return { nextSeq: s.nextSeq };
      if (seq !== s.nextSeq) reject('终端输入顺序冲突，请重新打开终端。', 409);
      if (!s.running || !s.child.stdin.writable) reject('终端已结束，请重新打开。', 409);
      if (s.child.stdin.writableLength > 65536) reject('终端忙，请稍后输入。', 429);
      s.child.stdin.write(`${JSON.stringify({ type: 'input', data: Buffer.from(data).toString('base64') })}\n`);
      s.nextSeq++; s.lastInput = data; s.touched = Date.now();
      return { nextSeq: s.nextSeq };
    },
    resize(id, owner, backend, { cols, rows }) {
      const s = owned(id, owner, backend);
      if (!size(cols, 2, 500) || !size(rows, 2, 200)) reject('终端尺寸无效。');
      if (s.running && s.child.stdin.writable) s.child.stdin.write(`${JSON.stringify({ type: 'resize', cols, rows })}\n`);
      return { ok: true };
    },
    remove(id, owner, backend) { const s = owned(id, owner, backend); stop(s); sessions.delete(id); return { ok: true }; },
    close() { clearInterval(timer); for (const s of sessions.values()) stop(s); sessions.clear(); },
  };
}
