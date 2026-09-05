import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createChatImageStore } from '../server/chat-images.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('codex-mobile-image'),
]);

function requestFor(buffer, contentType = 'image/png') {
  const request = Readable.from([buffer]);
  request.headers = { 'content-length': String(buffer.length), 'content-type': contentType };
  request.aborted = false;
  return request;
}

test('chat image store validates, signs, resolves and decorates local images', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-chat-images-'));
  const store = createChatImageStore({
    dataDir: directory,
    secret: 'image-test-secret',
    maxInputImageBytes: 1024,
    maxInputImages: 4,
    chatImageTokenTtlSeconds: 60,
    chatImagePendingTtlSeconds: 60,
  });

  const uploaded = await store.upload(requestFor(PNG), { fileName: '手机截图.png' });
  assert.equal(uploaded.name, '手机截图.png');
  assert.equal(uploaded.mimeType, 'image/png');
  assert.equal(uploaded.size, PNG.length);
  assert.match(uploaded.previewUrl, /^\/api\/chat-images\//);

  const resolved = store.resolveToken(uploaded.token);
  assert.equal(fs.readFileSync(resolved.path).equals(PNG), true);
  assert.equal(resolved.mimeType, 'image/png');
  assert.deepEqual(store.resolveInputs([{ token: uploaded.token }]), [{ type: 'localImage', path: resolved.path }]);

  const decorated = store.decorateTurn({
    id: 'turn-image',
    items: [{ id: 'user-image', type: 'userMessage', content: [
      { type: 'local_image', path: resolved.path },
      { type: 'text', text: '分析截图' },
    ] }],
  });
  assert.equal(decorated.items[0].content[0].imageId, uploaded.id);
  assert.match(decorated.items[0].content[0].previewUrl, /^\/api\/chat-images\//);

  await assert.rejects(
    store.upload(requestFor(Buffer.from('not an image'))),
    (error) => error.code === 'UNSUPPORTED_IMAGE_TYPE',
  );
  await assert.rejects(
    store.upload(requestFor(PNG, 'image/jpeg')),
    (error) => error.code === 'IMAGE_TYPE_MISMATCH',
  );
  assert.throws(
    () => store.resolveInputs(Array.from({ length: 5 }, () => uploaded.token)),
    (error) => error.code === 'TOO_MANY_IMAGES',
  );
});
