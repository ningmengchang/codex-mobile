import fs from 'node:fs';
import path from 'node:path';
import { AppError, assertAllowedPath } from './security.mjs';

function validateEntryName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new AppError('名称不正确。', 400, 'INVALID_ENTRY_NAME');
  }
  if (name.startsWith('.')) {
    throw new AppError('暂不支持操作隐藏文件。', 400, 'HIDDEN_ENTRY_NOT_ALLOWED');
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new AppError('名称过长。', 400, 'ENTRY_NAME_TOO_LONG');
  }
  return name;
}

function writableDirectory(directoryPath, allowedRoots) {
  const directory = assertAllowedPath(directoryPath, allowedRoots);
  if (!fs.statSync(directory).isDirectory()) {
    throw new AppError('目标位置必须是文件夹。', 400, 'NOT_A_DIRECTORY');
  }
  return directory;
}

function mutationError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === 'EEXIST') return new AppError('同名文件或文件夹已存在。', 409, 'ENTRY_EXISTS');
  if (error?.code === 'ENOENT') return new AppError('文件或文件夹不存在。', 404, 'ENTRY_NOT_FOUND');
  if (error?.code === 'ENOTEMPTY') return new AppError('文件夹不是空的。', 409, 'DIRECTORY_NOT_EMPTY');
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return new AppError('当前目录没有修改权限。', 403, 'ENTRY_WRITE_DENIED');
  }
  return error;
}

export async function createProjectEntry(options) {
  const directory = writableDirectory(options.directory, options.allowedRoots);
  const name = validateEntryName(options.name);
  const type = options.type === 'directory' ? 'directory' : options.type === 'file' ? 'file' : null;
  if (!type) throw new AppError('请选择新建文件或文件夹。', 400, 'INVALID_ENTRY_TYPE');
  const targetPath = path.join(directory, name);

  try {
    if (type === 'directory') {
      await fs.promises.mkdir(targetPath, { mode: 0o755 });
    } else {
      const content = typeof options.content === 'string' ? options.content : '';
      if (Buffer.byteLength(content, 'utf8') > options.maxContentBytes) {
        throw new AppError('新建文件内容过大。', 413, 'ENTRY_CONTENT_TOO_LARGE');
      }
      await fs.promises.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    }
    return { path: assertAllowedPath(targetPath, options.allowedRoots), type };
  } catch (error) {
    throw mutationError(error);
  }
}

export async function deleteProjectEntry(options) {
  const rawPath = typeof options.targetPath === 'string' ? options.targetPath : '';
  const requestedPath = rawPath ? path.resolve(rawPath) : '';
  if (!requestedPath || !path.isAbsolute(rawPath)) {
    throw new AppError('删除目标不正确。', 400, 'INVALID_ENTRY_PATH');
  }
  if (options.allowedRoots.some((root) => path.resolve(root) === requestedPath)) {
    throw new AppError('项目允许根目录不能删除。', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
  }

  const name = validateEntryName(path.basename(requestedPath));
  if (options.confirmName !== name) {
    throw new AppError('删除确认与目标不一致。', 400, 'DELETE_CONFIRMATION_MISMATCH');
  }
  const parent = writableDirectory(path.dirname(requestedPath), options.allowedRoots);
  const targetPath = path.join(parent, name);

  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new AppError('不能通过此功能删除符号链接。', 400, 'ENTRY_SYMLINK_NOT_ALLOWED');
    }
    assertAllowedPath(targetPath, options.allowedRoots);
    if (stat.isDirectory()) {
      const children = await fs.promises.readdir(targetPath);
      if (children.length && options.recursive !== true) {
        throw new AppError('文件夹不是空的，需要确认删除全部内容。', 409, 'DIRECTORY_NOT_EMPTY');
      }
      if (options.recursive === true) await fs.promises.rm(targetPath, { recursive: true, force: false });
      else await fs.promises.rmdir(targetPath);
    } else if (stat.isFile()) {
      await fs.promises.unlink(targetPath);
    } else {
      throw new AppError('暂不支持删除此类型的文件。', 400, 'ENTRY_TYPE_NOT_SUPPORTED');
    }
    return { deleted: true, name, path: targetPath, parent, isDirectory: stat.isDirectory() };
  } catch (error) {
    throw mutationError(error);
  }
}
