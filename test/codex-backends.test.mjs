import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexBackendManager } from '../server/codex-backends.mjs';

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
