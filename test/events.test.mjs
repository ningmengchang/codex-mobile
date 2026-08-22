import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { EventHub } from '../server/events.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
  }

  writeHead() {}

  write(chunk) {
    this.chunks.push(String(chunk));
  }

  end() {
    this.emit('close');
  }

  text() {
    return this.chunks.join('');
  }
}

test('fresh SSE clients do not replay stale process history', () => {
  const hub = new EventHub();
  hub.publish('backend-changed', { active: 'deepseek' });
  hub.publish('backend-changed', { active: 'gpt' });

  const response = new FakeResponse();
  hub.connect(response, 0);
  assert.equal(response.text(), ': connected\n\n');
  response.end();
  hub.close();
});

test('reconnecting SSE clients replay only events after Last-Event-ID', () => {
  const hub = new EventHub();
  const first = hub.publish('thread-activity', { threadId: 'one' });
  hub.publish('thread-activity', { threadId: 'two' });

  const response = new FakeResponse();
  hub.connect(response, first.id);
  assert.doesNotMatch(response.text(), /"threadId":"one"/);
  assert.match(response.text(), /"threadId":"two"/);
  response.end();
  hub.close();
});
