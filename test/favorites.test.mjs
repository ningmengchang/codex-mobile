import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FavoritesStore } from '../server/favorites.mjs';

test('favorites persist, merge legacy data, rename and delete', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-favorites-'));
  const filePath = path.join(directory, 'favorites.json');
  try {
    const store = new FavoritesStore({ filePath });
    store.upsert({ id: 'thread-a', name: '会话 A', cwd: '/projects/a', updatedAt: 10 });
    store.import([
      { id: 'thread-a', name: '旧名字', cwd: '/projects/a', updatedAt: 20 },
      { id: 'thread-b', name: '会话 B', cwd: '/projects/b', updatedAt: 30 },
    ]);
    assert.deepEqual(store.list().map((item) => item.id), ['thread-b', 'thread-a']);
    assert.equal(store.list().find((item) => item.id === 'thread-a').name, '会话 A');

    const reloaded = new FavoritesStore({ filePath });
    assert.equal(reloaded.list().length, 2);
    reloaded.rename('thread-a', '会话 A 新名字');
    assert.equal(reloaded.list().find((item) => item.id === 'thread-a').name, '会话 A 新名字');
    reloaded.remove('thread-b');
    assert.deepEqual(reloaded.list().map((item) => item.id), ['thread-a']);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
