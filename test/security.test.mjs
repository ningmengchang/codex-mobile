import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPairingCode, exchangePairingCode } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { assertAllowedPath, createArtifactToken, verifyArtifactToken, verifyClaims } from '../server/security.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-security-'));
  const root = path.join(directory, 'root');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'file.md'), '# ok\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
  return { directory, root, outside, config: {
    dataDir: path.join(directory, 'data'), secret: 'test-secret', artifactTtlSeconds: 60, allowedRoots: [root], sessionTtlSeconds: 60,
  } };
}

test('artifact tokens are signed, scoped, and expiring', () => {
  const item = fixture();
  try {
    const file = path.join(item.root, 'file.md');
    const token = createArtifactToken(file, item.config, 1_000);
    assert.equal(verifyArtifactToken(token, item.config, 1_001).path, file);
    assert.throws(() => verifyArtifactToken(`${token}x`, item.config, 1_001), /签名/);
    assert.throws(() => verifyClaims(token, item.config.secret, 100_000), /过期/);
  } finally {
    fs.rmSync(item.directory, { recursive: true, force: true });
  }
});

test('path checks reject traversal and escaping symlinks', () => {
  const item = fixture();
  try {
    fs.symlinkSync(path.join(item.outside, 'secret.txt'), path.join(item.root, 'escape'));
    assert.equal(assertAllowedPath(path.join(item.root, 'file.md'), [item.root]), path.join(item.root, 'file.md'));
    assert.throws(() => assertAllowedPath(path.join(item.root, '..', 'outside', 'secret.txt'), [item.root]), /允许/);
    assert.throws(() => assertAllowedPath(path.join(item.root, 'escape'), [item.root]), /允许/);
  } finally {
    fs.rmSync(item.directory, { recursive: true, force: true });
  }
});

test('pairing codes are one-time and expire', () => {
  const item = fixture();
  try {
    const pairing = createPairingCode(item.config, 10_000);
    const token = exchangePairingCode(pairing.code, item.config, 11_000);
    assert.equal(verifyClaims(token, item.config.secret, 11_000).kind, 'session');
    assert.throws(() => exchangePairingCode(pairing.code, item.config, 11_000), /配对码/);
    const expired = createPairingCode(item.config, 10_000);
    assert.throws(() => exchangePairingCode(expired.code, item.config, 700_001), /过期/);
  } finally {
    fs.rmSync(item.directory, { recursive: true, force: true });
  }
});

test('mobile config defaults to the supported GPT model', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-config-'));
  const root = path.join(directory, 'root');
  fs.mkdirSync(root);
  const previousDefaultModel = process.env.CODEX_MOBILE_DEFAULT_MODEL;
  delete process.env.CODEX_MOBILE_DEFAULT_MODEL;
  try {
    const config = loadConfig({
      dataDir: path.join(directory, 'data'),
      cacheDir: path.join(directory, 'cache'),
      secret: 'test-secret',
      allowedRoots: [root],
    });
    assert.equal(config.defaultModel, 'gpt-5.6-sol');
  } finally {
    if (previousDefaultModel === undefined) delete process.env.CODEX_MOBILE_DEFAULT_MODEL;
    else process.env.CODEX_MOBILE_DEFAULT_MODEL = previousDefaultModel;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
