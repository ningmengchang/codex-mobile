import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, isInside, signClaims, verifyClaims } from './security.mjs';

const IMAGE_TYPES = new Map([
  ['jpeg', { extension: '.jpg', mimeType: 'image/jpeg' }],
  ['png', { extension: '.png', mimeType: 'image/png' }],
  ['webp', { extension: '.webp', mimeType: 'image/webp' }],
]);
const STORED_IMAGE_NAME = /^([a-f0-9]{64})(\.jpg|\.png|\.webp)$/;

function detectImageType(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function displayName(value, fallback) {
  const basename = path.basename(String(value ?? '').replaceAll('\\', '/')).trim();
  if (!basename || basename === '.' || basename === '..') return fallback;
  return Buffer.byteLength(basename, 'utf8') <= 255 ? basename : fallback;
}

function uploadError(error, request) {
  if (error instanceof AppError) return error;
  if (request.aborted || error?.code === 'ECONNRESET' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new AppError('图片上传已中断，请重试。', 400, 'IMAGE_UPLOAD_ABORTED');
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return new AppError('图片存储目录不可写。', 500, 'IMAGE_STORAGE_DENIED');
  }
  return error;
}

export function createChatImageStore(config, options = {}) {
  const root = path.resolve(options.root ?? config.chatImageDir ?? path.join(config.dataDir, 'chat-images'));
  const maxBytes = Number(options.maxBytes ?? config.maxInputImageBytes ?? 8 * 1024 * 1024);
  const maxImages = Number(options.maxImages ?? config.maxInputImages ?? 4);
  const tokenTtlSeconds = Number(options.tokenTtlSeconds ?? config.chatImageTokenTtlSeconds ?? 24 * 60 * 60);
  const configuredPendingTtlMs = Number(config.chatImagePendingTtlSeconds) * 1000;
  const pendingTtlMs = Number(options.pendingTtlMs
    ?? (Number.isFinite(configuredPendingTtlMs) ? configuredPendingTtlMs : 24 * 60 * 60 * 1000));
  const maxSizeLabel = maxBytes >= 1024 * 1024
    ? `${Number((maxBytes / 1024 / 1024).toFixed(1))}MB`
    : `${Math.ceil(maxBytes / 1024)}KB`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);

  function storedPath(value) {
    const filePath = path.resolve(value);
    if (!isInside(realRoot, filePath)) throw new AppError('图片路径无效。', 403, 'IMAGE_PATH_NOT_ALLOWED');
    const match = STORED_IMAGE_NAME.exec(path.basename(filePath));
    if (!match) throw new AppError('图片路径无效。', 403, 'IMAGE_PATH_NOT_ALLOWED');
    const real = fs.realpathSync(filePath);
    if (!isInside(realRoot, real)) throw new AppError('图片路径无效。', 403, 'IMAGE_PATH_NOT_ALLOWED');
    return real;
  }

  function tokenForPath(filePath, now = Date.now()) {
    const safePath = storedPath(filePath);
    return signClaims({
      kind: 'chat-image',
      file: path.basename(safePath),
      exp: Math.floor(now / 1000) + tokenTtlSeconds,
    }, config.secret);
  }

  function previewUrl(filePath) {
    return `/api/chat-images/${encodeURIComponent(tokenForPath(filePath))}`;
  }

  function resolveToken(token, now = Date.now()) {
    const claims = verifyClaims(token, config.secret, now);
    if (claims.kind !== 'chat-image' || typeof claims.file !== 'string' || !STORED_IMAGE_NAME.test(claims.file)) {
      throw new AppError('图片凭据无效。', 401, 'INVALID_IMAGE_TOKEN');
    }
    const filePath = storedPath(path.join(realRoot, claims.file));
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = [...IMAGE_TYPES.values()].find((item) => item.extension === extension)?.mimeType;
    if (!mimeType) throw new AppError('图片格式不受支持。', 415, 'UNSUPPORTED_IMAGE_TYPE');
    return { path: filePath, mimeType, name: path.basename(filePath) };
  }

  async function upload(request, metadata = {}) {
    const declaredBytes = Number.parseInt(request.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new AppError(`图片超过 ${maxSizeLabel} 限制。`, 413, 'IMAGE_TOO_LARGE');
    }
    const temporaryPath = path.join(realRoot, `.upload-${process.pid}-${crypto.randomUUID()}`);
    let receivedBytes = 0;
    const hash = crypto.createHash('sha256');
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          callback(new AppError(`图片超过 ${maxSizeLabel} 限制。`, 413, 'IMAGE_TOO_LARGE'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(request, limiter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      if (!receivedBytes) throw new AppError('图片内容为空。', 400, 'EMPTY_IMAGE');
      const handle = await fs.promises.open(temporaryPath, 'r');
      const header = Buffer.alloc(16);
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(header, 0, header.length, 0));
      } finally {
        await handle.close();
      }
      const detected = detectImageType(header.subarray(0, bytesRead));
      if (!detected) throw new AppError('只支持 JPEG、PNG 和 WebP 图片。', 415, 'UNSUPPORTED_IMAGE_TYPE');
      const type = IMAGE_TYPES.get(detected);
      const declaredType = String(metadata.contentType ?? request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== type.mimeType) {
        throw new AppError('图片格式与文件内容不一致。', 415, 'IMAGE_TYPE_MISMATCH');
      }
      const digest = hash.digest('hex');
      const finalPath = path.join(realRoot, `${digest}${type.extension}`);
      try {
        await fs.promises.link(temporaryPath, finalPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      await fs.promises.chmod(finalPath, 0o600);
      const token = tokenForPath(finalPath);
      return {
        id: digest,
        name: displayName(metadata.fileName, `图片${type.extension}`),
        size: receivedBytes,
        mimeType: type.mimeType,
        token,
        previewUrl: `/api/chat-images/${encodeURIComponent(token)}`,
      };
    } catch (error) {
      throw uploadError(error, request);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  }

  function resolveInputs(tokens) {
    if (tokens == null) return [];
    if (!Array.isArray(tokens)) throw new AppError('图片列表格式不正确。', 400, 'INVALID_IMAGES');
    if (tokens.length > maxImages) throw new AppError(`一次最多发送 ${maxImages} 张图片。`, 400, 'TOO_MANY_IMAGES');
    const seen = new Set();
    const images = [];
    for (const value of tokens) {
      const token = typeof value === 'string' ? value : value?.token;
      if (!token) throw new AppError('图片凭据缺失。', 400, 'IMAGE_TOKEN_REQUIRED');
      const resolved = resolveToken(token);
      if (seen.has(resolved.path)) continue;
      seen.add(resolved.path);
      images.push({ type: 'localImage', path: resolved.path });
    }
    return images;
  }

  function markReferenced(inputs) {
    const now = new Date();
    for (const item of inputs ?? []) {
      if (item?.type !== 'localImage') continue;
      try { fs.utimesSync(storedPath(item.path), now, now); } catch {}
    }
  }

  function decorateContent(content) {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
      if (!['local_image', 'localImage'].includes(part?.type) || typeof part.path !== 'string') return part;
      try {
        const safePath = storedPath(part.path);
        return { ...part, previewUrl: previewUrl(safePath), imageId: path.parse(safePath).name };
      } catch {
        return part;
      }
    });
  }

  function decorateItem(item) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content)) return item;
    const content = decorateContent(item.content);
    return content === item.content ? item : { ...item, content };
  }

  function decorateTurn(turn) {
    if (!turn || typeof turn !== 'object' || !Array.isArray(turn.items)) return turn;
    return { ...turn, items: turn.items.map(decorateItem) };
  }

  function decorateTurns(turns) {
    return Array.isArray(turns) ? turns.map(decorateTurn) : turns;
  }

  function decorateProtocolMessage(message) {
    if (!message?.params) return message;
    let params = message.params;
    let changed = false;
    if (params.item) {
      const item = decorateItem(params.item);
      if (item !== params.item) { params = { ...params, item }; changed = true; }
    }
    if (params.turn) {
      const turn = decorateTurn(params.turn);
      if (turn !== params.turn) { params = changed ? { ...params, turn } : { ...params, turn }; changed = true; }
    }
    return changed ? { ...message, params } : message;
  }

  function cleanupPending(now = Date.now()) {
    for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('.upload-')) continue;
      const filePath = path.join(realRoot, entry.name);
      try {
        if (now - fs.statSync(filePath).mtimeMs > pendingTtlMs) fs.unlinkSync(filePath);
      } catch {}
    }
  }

  cleanupPending();
  return {
    root: realRoot,
    maxBytes,
    maxImages,
    upload,
    resolveToken,
    resolveInputs,
    markReferenced,
    decorateContent,
    decorateItem,
    decorateTurn,
    decorateTurns,
    decorateProtocolMessage,
    cleanupPending,
  };
}
