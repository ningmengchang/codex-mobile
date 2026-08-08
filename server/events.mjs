export class EventHub {
  constructor(options = {}) {
    this.capacity = options.capacity ?? 1000;
    this.sequence = 0;
    this.history = [];
    this.clients = new Set();
  }

  publish(type, data) {
    const event = { id: ++this.sequence, type, data, at: new Date().toISOString() };
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    const encoded = this.encode(event);
    for (const client of this.clients) client.write(encoded);
    return event;
  }

  encode(event) {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`;
  }

  connect(response, lastEventId = 0) {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');
    for (const event of this.history) {
      if (event.id > lastEventId) response.write(this.encode(event));
    }
    this.clients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    const close = () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    };
    response.on('close', close);
    response.on('error', close);
  }

  close() {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
