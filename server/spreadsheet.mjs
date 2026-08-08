import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from './security.mjs';

const PREVIEW_SCRIPT = fileURLToPath(new URL('./xlsx-preview.py', import.meta.url));
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function runPreview(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [PREVIEW_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AppError('读取 Excel 超时。', 504, 'SPREADSHEET_TIMEOUT')));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new AppError('Excel 在线预览内容过大。', 413, 'SPREADSHEET_PREVIEW_TOO_LARGE')));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => finish(() => {
      if (error.code === 'ENOENT') reject(new AppError('系统未安装 Python Excel 预览组件。', 501, 'SPREADSHEET_TOOLS_MISSING'));
      else reject(error);
    }));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        reject(new AppError(`读取 Excel 失败：${Buffer.concat(stderr).toString('utf8').trim() || `退出码 ${code}`}`, 422, 'SPREADSHEET_FAILED'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new AppError('Excel 预览数据格式不正确。', 500, 'SPREADSHEET_INVALID_OUTPUT'));
      }
    }));
  });
}

export function readWorkbook(filePath) {
  return runPreview(['workbook', filePath]);
}

export function readWorksheet(filePath, index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AppError('工作表编号无效。', 400, 'INVALID_SHEET_INDEX');
  }
  return runPreview(['sheet', filePath, String(index)]);
}
