import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexBackendManager } from '../server/codex-backends.mjs';
import { loadConfig } from '../server/config.mjs';
import { listSkills } from '../server/skills.mjs';

test('every Codex instance shares the primary skills directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-skills-'));
  try {
    const config = loadConfig({
      dataDir: path.join(directory, 'data'),
      cacheDir: path.join(directory, 'cache'),
      allowedRoots: [directory],
    });
    const shared = '/home/ningmengchang/.codex/skills';
    // DeepSeek 保持独立（它自己有一份副本，按用户要求不改动），
    // 其余实例都共享主实例的技能目录。
    for (const id of ['glm', 'codex1', 'codex2', 'codex3']) {
      const backend = config.codexBackends.find((item) => item.id === id);
      assert.ok(backend, `缺少 ${id} 后端`);
      assert.ok(backend.skillsRoots.includes(shared), `${id} 未包含主实例技能目录：${backend.skillsRoots.join(':')}`);
    }
    // 主实例技能目录里的技能必须能被列出来（手机端"技能"弹窗的数据来源）。
    const names = listSkills({ skillsRoots: config.codexBackends.find((item) => item.id === 'glm').skillsRoots })
      .map((skill) => skill.name);
    assert.ok(names.length > 1, `GLM 技能列表过少：${names.join(',')}`);
    assert.ok(names.includes('saic-prd-format'), `GLM 缺少主实例技能：${names.join(',')}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex backend selection is persisted outside both Codex homes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-backends-'));
  const dataDir = path.join(directory, 'mobile-data');
  const gptHome = path.join(directory, '.codex');
  const deepseekHome = path.join(directory, '.codex-ds');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(gptHome);
  fs.mkdirSync(deepseekHome);
  const config = {
    dataDir,
    codexBin: '/bin/true', codexHome: gptHome, appServerArgs: ['app-server', '--stdio'],
    defaultModel: 'gpt-model', defaultEffort: 'max', skillsRoots: [path.join(gptHome, 'skills')],
    codexBackends: [
      {
        id: 'gpt', label: 'GPT', available: true, codexBin: '/bin/true', codexHome: gptHome,
        appServerArgs: ['app-server', '--stdio'], defaultModel: 'gpt-model', defaultEffort: 'max',
        skillsRoots: [path.join(gptHome, 'skills')],
      },
      {
        id: 'deepseek', label: 'DeepSeek', available: true, codexBin: '/bin/true', codexHome: deepseekHome,
        appServerArgs: ['app-server', '--stdio'], defaultModel: 'deepseek-v4-flash', defaultEffort: 'high',
        skillsRoots: [path.join(deepseekHome, 'skills')],
      },
    ],
  };
  try {
    const manager = new CodexBackendManager(config);
    assert.equal(manager.activeId(), 'gpt');
    manager.apply('deepseek');
    assert.equal(config.codexHome, deepseekHome);
    assert.equal(config.defaultModel, 'deepseek-v4-flash');
    assert.equal(fs.existsSync(path.join(gptHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(deepseekHome, 'config.toml')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-backend.json'), 'utf8')).active, 'deepseek');

    const restartedConfig = { ...config, codexHome: gptHome, defaultModel: 'gpt-model' };
    const restarted = new CodexBackendManager(restartedConfig);
    assert.equal(restarted.activeId(), 'deepseek');
    assert.equal(restartedConfig.codexHome, deepseekHome);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('API key agents stay unavailable until their key file holds a key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-glm-'));
  const dataDir = path.join(directory, 'mobile-data');
  const gptHome = path.join(directory, '.codex');
  const glmHome = path.join(directory, '.codex-glm');
  const keyFile = path.join(glmHome, 'key.env');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(gptHome);
  fs.mkdirSync(glmHome);
  fs.writeFileSync(keyFile, 'ZHIPU_API_KEY=\n', { mode: 0o600 });
  const backends = () => [
    {
      id: 'gpt', label: 'GPT', available: true, codexBin: '/bin/true', codexHome: gptHome,
      appServerArgs: ['app-server', '--stdio'], defaultModel: 'gpt-model', defaultEffort: 'max',
      skillsRoots: [path.join(gptHome, 'skills')],
    },
    {
      id: 'glm', label: 'GLM', description: '智谱 Coding Plan · 独立本地配置',
      codexBin: '/bin/true', codexHome: glmHome,
      appServerArgs: ['app-server', '--stdio'], defaultModel: 'glm-5.3', defaultEffort: 'max',
      skillsRoots: [path.join(glmHome, 'skills')], keyFile, keyName: 'ZHIPU_API_KEY',
    },
  ];
  try {
    const locked = new CodexBackendManager({
      dataDir, codexBin: '/bin/true', codexHome: gptHome, appServerArgs: ['app-server', '--stdio'],
      defaultModel: 'gpt-model', defaultEffort: 'max', codexBackends: backends(),
    });
    assert.equal(locked.get('glm').available, false);
    assert.throws(() => locked.apply('glm'), /不可用/);
    assert.equal(locked.activeId(), 'gpt');
    assert.equal(fs.existsSync(path.join(dataDir, 'codex-backend.json')), false);

    fs.writeFileSync(keyFile, 'ZHIPU_API_KEY=sk-glm-test\n', { mode: 0o600 });
    const ready = new CodexBackendManager({
      dataDir, codexBin: '/bin/true', codexHome: gptHome, appServerArgs: ['app-server', '--stdio'],
      defaultModel: 'gpt-model', defaultEffort: 'max', codexBackends: backends(),
    });
    assert.equal(ready.get('glm').available, true);
    // 填好 key.env 后无需重启网关：同一实例的下一次查询就应变为可用。
    assert.equal(locked.get('glm').available, true);
    assert.equal(locked.list().find((item) => item.id === 'glm').available, true);
    locked.apply('glm');
    assert.equal(locked.activeId(), 'glm');
    ready.apply('glm');
    assert.equal(ready.activeId(), 'glm');
    assert.equal(ready.runtime('glm').codexHome, glmHome);
    assert.equal(ready.runtime('glm').defaultModel, 'glm-5.3');
    assert.equal(fs.existsSync(path.join(glmHome, 'config.toml')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-backend.json'), 'utf8')).active, 'glm');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('device code agents stay unavailable until auth.json holds a refresh token', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-device-'));
  const dataDir = path.join(directory, 'mobile-data');
  const gptHome = path.join(directory, '.codex');
  const codex1Home = path.join(directory, '.codex1');
  const authFile = path.join(codex1Home, 'auth.json');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(gptHome);
  fs.mkdirSync(codex1Home);
  const backends = () => [
    {
      id: 'gpt', label: 'GPT', available: true, codexBin: '/bin/true', codexHome: gptHome,
      appServerArgs: ['app-server', '--stdio'], defaultModel: 'gpt-model', defaultEffort: 'max',
      skillsRoots: [],
    },
    {
      id: 'codex1', label: 'Codex1', description: '设备码登录 · 备用账号 1',
      codexBin: '/bin/true', codexHome: codex1Home,
      appServerArgs: ['app-server', '--stdio'], defaultModel: 'gpt-model', defaultEffort: 'max',
      skillsRoots: [], authFile,
    },
  ];
  const create = () => new CodexBackendManager({
    dataDir, codexBin: '/bin/true', codexHome: gptHome, appServerArgs: ['app-server', '--stdio'],
    defaultModel: 'gpt-model', defaultEffort: 'max', codexBackends: backends(),
  });
  try {
    const manager = create();
    assert.equal(manager.get('codex1').state, 'login_required');
    assert.equal(manager.get('codex1').available, false);
    assert.equal(manager.list().find((item) => item.id === 'codex1').available, false);
    assert.throws(() => manager.apply('codex1'), /不可用/);
    assert.equal(manager.activeId(), 'gpt');

    // 模拟设备码登录完成：auth.json 带 refresh_token 与 id_token 里的 email。
    const claims = Buffer.from(JSON.stringify({ email: 'codex1@example.com' })).toString('base64url');
    fs.writeFileSync(authFile, `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh', access_token: 'access', id_token: `header.${claims}.signature` },
      last_refresh: '2026-09-16T00:00:00Z',
    })}\n`, { mode: 0o600 });

    // 同一个实例无需重启即可变为可选。
    assert.equal(manager.get('codex1').state, 'ready');
    assert.equal(manager.get('codex1').available, true);
    assert.equal(manager.get('codex1').account, 'codex1@example.com');
    assert.equal(manager.list().find((item) => item.id === 'codex1').account, 'codex1@example.com');
    manager.apply('codex1');
    assert.equal(manager.activeId(), 'codex1');
    assert.equal(manager.runtime('codex1').codexHome, codex1Home);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-backend.json'), 'utf8')).active, 'codex1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
