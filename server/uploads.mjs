import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, assertAllowedPath } from './security.mjs';

function validateFilename(value) {
  const name = typeof value === 'string' ? value : '';
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new AppError('文件名不正确。', 400, 'INVALID_UPLOAD_NAME');
  }
  if (name.startsWith('.')) {
    throw new AppError('暂不支持上传隐藏文件。', 400, 'HIDDEN_UPLOAD_NOT_ALLOWED');
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new AppError('文件名过长。', 400, 'UPLOAD_NAME_TOO_LONG');
  }
  return name;
}

function existingTarget(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function uploadError(error, request) {
  if (error instanceof AppError) return error;
  if (error?.code === 'EEXIST') return new AppError('同名文件已存在。', 409, 'FILE_EXISTS');
  if (request.aborted || error?.code === 'ECONNRESET' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new AppError('上传已中断，请重试。', 400, 'UPLOAD_ABORTED');
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return new AppError('当前目录没有写入权限。', 403, 'UPLOAD_WRITE_DENIED');
  }
  return error;
}

export async function receiveUpload(request, options) {
  const directory = assertAllowedPath(options.directory, options.allowedRoots);
  if (!fs.statSync(directory).isDirectory()) {
    throw new AppError('上传目标必须是文件夹。', 400, 'NOT_A_DIRECTORY');
  }
  const name = validateFilename(options.fileName);
  const destination = path.join(directory, name);
  assertAllowedPath(destination, options.allowedRoots, { allowMissing: true });

  const existing = existingTarget(destination);
  if (existing?.isSymbolicLink()) {
    throw new AppError('不能覆盖符号链接。', 400, 'UPLOAD_SYMLINK_NOT_ALLOWED');
  }
  if (existing && !existing.isFile()) {
    throw new AppError('同名目录已存在。', 409, 'UPLOAD_TARGET_NOT_FILE');
  }
  if (existing && !options.overwrite) {
    throw new AppError('同名文件已存在。', 409, 'FILE_EXISTS');
  }

  const maxBytes = Number(options.maxBytes);
  const declaredBytes = Number.parseInt(request.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new AppError('文件超过上传大小限制。', 413, 'UPLOAD_TOO_LARGE');
  }

  let receivedBytes = 0;
  let temporaryPath = path.join(directory, `.codex-mobile-upload-${process.pid}-${crypto.randomUUID()}`);
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(new AppError('文件超过上传大小限制。', 413, 'UPLOAD_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(request, limiter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o644 }));
    if (options.overwrite) {
      await fs.promises.rename(temporaryPath, destination);
      temporaryPath = null;
    } else {
      await fs.promises.link(temporaryPath, destination);
      await fs.promises.unlink(temporaryPath);
      temporaryPath = null;
    }
    return { path: assertAllowedPath(destination, options.allowedRoots), size: receivedBytes, overwritten: Boolean(existing) };
  } catch (error) {
    throw uploadError(error, request);
  } finally {
    if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}
