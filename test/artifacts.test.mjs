import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactTracker, snapshotTree } from '../server/artifacts.mjs';

test('artifact tracker captures command-created files and limits ownership fixes to user trees', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-artifacts-'));
  const root = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(dataDir);
  fs.chownSync(root, 1000, 1000);
  const calls = [];
  const hubEvents = [];
  const config = {
    allowedRoots: [root], dataDir, secret: 'artifact-secret', artifactTtlSeconds: 60,
    ownershipHelper: '/fake/fix',
  };
  const tracker = new ArtifactTracker(config, { publish: (type, payload) => hubEvents.push({ type, payload }) }, {
    execFile: async (_command, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  });
  try {
    assert(snapshotTree(root).has(root));
    tracker.begin('thread-1', root);
    fs.writeFileSync(path.join(root, 'report.md'), '# Result\n');
    fs.writeFileSync(path.join(root, 'implementation.js'), 'export default {};\n');
    tracker.bindTurn('thread-1', 'turn-1');
    const artifacts = await tracker.finish('thread-1', 'turn-1');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, 'report.md');
    assert.equal(artifacts[0].status, 'added');
    assert.equal(artifacts[0].available, true);
    if (process.getuid?.() === 0) {
      assert(calls.some((args) => args.includes(path.join(root, 'report.md'))));
      assert(calls.some((args) => args[0] === '--check'));
    } else {
      assert.deepEqual(calls, [], '桌面用户创建的文件不应触发所有权修复');
    }
    assert.equal(hubEvents.at(-1).type, 'artifacts');
    assert.deepEqual(hubEvents.at(-1).payload.items.map((item) => item.relativePath), ['report.md']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact tracker records protocol-declared deletions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-delete-'));
  const root = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(dataDir);
  const file = path.join(root, 'old.txt');
  fs.writeFileSync(file, 'old');
  const tracker = new ArtifactTracker({
    allowedRoots: [root], dataDir, secret: 'secret', artifactTtlSeconds: 60, ownershipHelper: '/bin/true',
  }, null, { execFile: async () => ({}) });
  try {
    tracker.begin('thread-2', root);
    fs.unlinkSync(file);
    tracker.recordProtocolChanges('thread-2', 'turn-2', [{ path: 'old.txt', kind: 'delete' }]);
    const artifacts = await tracker.finish('thread-2', 'turn-2');
    assert.equal(artifacts[0].status, 'deleted');
    assert.equal(artifacts[0].available, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact tracker does not substitute unrelated recent directory files for an empty thread', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-artifact-scope-'));
  const root = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root, 'recent-but-unrelated.md'), '# unrelated');
  const tracker = new ArtifactTracker({
    allowedRoots: [root], dataDir, secret: 'secret', artifactTtlSeconds: 60, ownershipHelper: '/bin/true',
  }, null, { execFile: async () => ({}) });
  try {
    tracker.registerThread('empty-thread', root);
    assert.deepEqual(tracker.list('empty-thread'), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
