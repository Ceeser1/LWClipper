'use strict';
// A small CDP client for the test instance on port 9442.
const PORT = Number(process.env.CDP_PORT) || 9442;

async function connect(match) {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find((p) => p.type === 'page' && (match ? match(p) : /index\.html/.test(p.url)));
  if (!page) throw new Error('no page: ' + JSON.stringify(list.map((p) => [p.type, p.url, p.title])));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  let id = 0;
  const waits = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waits.has(msg.id)) {
      waits.get(msg.id)(msg);
      waits.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((done) => {
    id += 1;
    waits.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.result.value;
  };
  return { send, evaluate, close: () => ws.close(), page };
}

module.exports = { connect, PORT };
