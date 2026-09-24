import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTerminalManager } from '../server/terminal.mjs';
import { createTerminalWorkflows } from '../server/terminal-workflows.mjs';
import { expandTemplate, templateParameters, redactTerminalText } from '../public/js/terminal-utils.js';

const waitFor = async predicate => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error('等待终端超时');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-test-'));
  const manager = createTerminalManager({ allowedRoots: [directory] });
  t.after(async () => { manager.close(); await new Promise(resolve => setTimeout(resolve, 150)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, manager, params: { owner: 'owner', backend: 'gpt', threadId: 'thread', cwd: directory, acknowledged: true } };
}

test('real PTY: cwd, input replay protection, resize, Ctrl+C, session reuse and isolation', async t => {
  const { manager, directory, params } = fixture(t);
  const first = await manager.create(params);
  assert.equal((await manager.create(params)).id, first.id);
  const read = () => manager.read(first.id, 'owner', 'gpt');
  const output = () => Buffer.from(read().data, 'base64').toString();
  await waitFor(() => output().includes('$'));
  manager.resize(first.id, 'owner', 'gpt', { cols: 96, rows: 28 });
  const data = "printf 'ONCE_MARKER\\n' >> once.txt; pwd; stty size; printf 'READY_%s\\n' OK\r";
  manager.input(first.id, 'owner', 'gpt', { seq: 1, data });
  manager.input(first.id, 'owner', 'gpt', { seq: 1, data });
  assert.throws(() => manager.input(first.id, 'owner', 'gpt', { seq: 1, data: 'different' }));
  await waitFor(() => output().includes('READY_OK'));
  assert.equal(fs.readFileSync(path.join(directory, 'once.txt'), 'utf8'), 'ONCE_MARKER\n');
  assert.ok(output().includes(directory)); assert.ok(output().includes('28 96'));
  assert.throws(() => manager.read(first.id, 'another', 'gpt'));
  assert.throws(() => manager.read(first.id, 'owner', 'deepseek'));
  assert.throws(() => manager.read(first.id, 'owner', 'gpt', -1));
  manager.input(first.id, 'owner', 'gpt', { seq: 2, data: 'sleep 60\r' });
  await new Promise(resolve => setTimeout(resolve, 100));
  manager.input(first.id, 'owner', 'gpt', { seq: 3, data: '\x03' });
  manager.input(first.id, 'owner', 'gpt', { seq: 4, data: "printf 'AFTER_%s\\n' INTERRUPT\r" });
  await waitFor(() => output().includes('AFTER_INTERRUPT'));
  const second = await manager.create({ ...params, threadId: 'other-thread' });
  assert.notEqual(second.id, first.id);
  manager.remove(first.id, 'owner', 'gpt');
  assert.throws(() => read());
});

test('terminal rejects unconfirmed/path escapes and bounds output; end kills background jobs', async t => {
  const { manager, params, directory } = fixture(t);
  await assert.rejects(manager.create({ ...params, acknowledged: false }));
  await assert.rejects(manager.create({ ...params, cwd: '/tmp' }));
  fs.symlinkSync('/tmp', path.join(directory, 'escape'));
  await assert.rejects(manager.create({ ...params, cwd: path.join(directory, 'escape') }));
  const session = await manager.create(params);
  manager.input(session.id, 'owner', 'gpt', { seq: 1, data: "head -c 400000 /dev/zero | tr '\\0' x; printf 'DONE_%s\\n' BIG; sleep 120 & echo $! > child.pid\r" });
  await waitFor(() => fs.existsSync(path.join(directory, 'child.pid')));
  const result = manager.read(session.id, 'owner', 'gpt', 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.from(result.data, 'base64').length <= 256 * 1024);
  const pid = Number(fs.readFileSync(path.join(directory, 'child.pid'), 'utf8').trim());
  manager.remove(session.id, 'owner', 'gpt');
  await waitFor(() => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z'; } catch { return true; } });
});

test('workflow parameters are quoted, unsafe template contexts rejected, storage survives restart', t => {
  const { directory } = fixture(t);
  assert.deepEqual(templateParameters('printf %s {{value}}'), ['value']);
  const value = "hello'; touch /tmp/should-not-be-created; $(id)";
  const command = expandTemplate('printf %s {{value}}', { value });
  assert.equal(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' }), value);
  for (const bad of ['echo "{{value}}"', 'echo prefix{{value}}', 'cat <<EOF\n{{value}}\nEOF', 'echo $(echo {{value}})']) assert.throws(() => templateParameters(bad));
  assert.throws(() => expandTemplate('echo {{value}}', { value: '\nrm' }));
  assert.equal(redactTerminalText('API_KEY=abc password=xyz'), 'API_KEY=[已隐藏] password=[已隐藏]');
  const store = createTerminalWorkflows({ dataDir: directory });
  const item = store.save({ name: '日志', command: 'journalctl -u {{service}} -n {{lines}} --no-pager' });
  assert.equal(createTerminalWorkflows({ dataDir: directory }).list()[0].id, item.id);
  assert.equal(fs.statSync(path.join(directory, 'terminal-workflows.json')).mode & 0o777, 0o600);
  store.remove(item.id); assert.deepEqual(store.list(), []);
  fs.writeFileSync(path.join(directory, 'terminal-workflows.json'), 'broken');
  assert.throws(() => store.save({ name: 'test', command: 'pwd' }));
});
