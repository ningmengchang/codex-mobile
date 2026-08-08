import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { serverInfo: { name: 'fake-codex', version: 'test' } } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'test/echo') {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === 'test/approval') {
    send({ id: 'approval-upstream', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'pwd', cwd: '/tmp',
    } });
    send({ id: message.id, result: { queued: true } });
    return;
  }
  if (message.id === 'approval-upstream' && message.result) {
    send({ method: 'test/approvalResolved', params: { result: message.result } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
