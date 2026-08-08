import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, parseCookies, safeEqual, signClaims, verifyClaims } from './security.mjs';

export const COOKIE_NAME = 'codex_mobile_session';

function pairingPath(config) {
  return path.join(config.dataDir, 'pairing.json');
}

export function createPairingCode(config, now = Date.now()) {
  const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  const record = {
    hash: crypto.createHmac('sha256', config.secret).update(code).digest('hex'),
    expiresAt: now + 10 * 60 * 1000,
  };
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pairingPath(config), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { code, expiresAt: record.expiresAt };
}

export function exchangePairingCode(code, config, now = Date.now()) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(pairingPath(config), 'utf8'));
  } catch {
    throw new AppError('没有有效配对码，请在电脑上重新生成。', 401, 'PAIRING_REQUIRED');
  }
  if (!record.expiresAt || record.expiresAt < now) {
    throw new AppError('配对码已经过期，请重新生成。', 401, 'PAIRING_EXPIRED');
  }
  const received = crypto.createHmac('sha256', config.secret).update(String(code ?? '')).digest('hex');
  if (!safeEqual(record.hash, received)) {
    throw new AppError('配对码不正确。', 401, 'PAIRING_INVALID');
  }
  try { fs.unlinkSync(pairingPath(config)); } catch {}
  const issuedAt = Math.floor(now / 1000);
  return signClaims({
    kind: 'session',
    sid: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + config.sessionTtlSeconds,
  }, config.secret);
}

export function requireSession(request, config, now = Date.now()) {
  const token = parseCookies(request)[COOKIE_NAME];
  const claims = verifyClaims(token, config.secret, now);
  if (claims.kind !== 'session') throw new AppError('请重新配对。', 401, 'SESSION_REQUIRED');
  return claims;
}

export function sessionCookie(token, config) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlSeconds}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
