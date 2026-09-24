import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from './security.mjs';
import { templateParameters } from '../public/js/terminal-utils.js';

export function createTerminalWorkflows(config) {
  const file = path.join(config.dataDir, 'terminal-workflows.json');
  const read = () => {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(value)) throw new Error('invalid'); return value; }
    catch (error) { if (error.code === 'ENOENT') return []; throw new AppError('常用操作文件损坏，请检查后再保存。', 500); }
  };
  function write(items) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(items), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  return {
    list: () => read(),
    save({ name, command }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new AppError('名称需为 1–60 个字符。');
      try { templateParameters(command); } catch (error) { throw new AppError(error.message); }
      const items = read();
      if (items.length >= 100) throw new AppError('最多收藏 100 个常用操作。');
      const item = { id: crypto.randomUUID(), name: name.trim(), command, updatedAt: Date.now() };
      write([item, ...items]); return item;
    },
    remove(id) { const items = read(); write(items.filter(item => item.id !== id)); return { ok: true }; },
  };
}
