import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class AppError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertAllowedPath(candidate, allowedRoots, options = {}) {
  const resolved = path.resolve(candidate);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT' && options.allowMissing) {
      const parent = fs.realpathSync(path.dirname(resolved));
      real = path.join(parent, path.basename(resolved));
    } else if (error.code === 'ENOENT') {
      throw new AppError('文件不存在或已经被移动。', 404, 'NOT_FOUND');
    } else {
      throw error;
    }
  }
  if (!allowedRoots.some((root) => isInside(root, real))) {
    throw new AppError('路径不在允许的项目目录中。', 403, 'PATH_NOT_ALLOWED');
  }
  return real;
}

function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signClaims(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyClaims(token, secret, now = Date.now()) {
  if (typeof token !== 'string') throw new AppError('凭据无效。', 401, 'INVALID_TOKEN');
  const [payload, received, extra] = token.split('.');
  if (!payload || !received || extra) throw new AppError('凭据无效。', 401, 'INVALID_TOKEN');
  const expected = hmac(payload, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new AppError('凭据签名无效。', 401, 'INVALID_TOKEN');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('凭据内容损坏。', 401, 'INVALID_TOKEN');
  }
  if (!claims.exp || claims.exp < Math.floor(now / 1000)) {
    throw new AppError('凭据已经过期。', 401, 'TOKEN_EXPIRED');
  }
  return claims;
}

export function createArtifactToken(filePath, config, now = Date.now()) {
  return signClaims({
    kind: 'artifact',
    path: filePath,
    exp: Math.floor(now / 1000) + config.artifactTtlSeconds,
    nonce: crypto.randomBytes(8).toString('base64url'),
  }, config.secret);
}

export function verifyArtifactToken(token, config, now = Date.now()) {
  const claims = verifyClaims(token, config.secret, now);
  if (claims.kind !== 'artifact' || typeof claims.path !== 'string') {
    throw new AppError('产出物链接无效。', 401, 'INVALID_ARTIFACT_TOKEN');
  }
  return { ...claims, path: assertAllowedPath(claims.path, config.allowedRoots) };
}

export function parseCookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError('请求来源无效。', 403, 'INVALID_ORIGIN');
  }
  if (parsed.host !== request.headers.host) {
    throw new AppError('拒绝跨站请求。', 403, 'CROSS_ORIGIN_REQUEST');
  }
}

export function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
