const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(new URL('../web/app.js', `file://${__filename}`), 'utf8');
const snapshot = (generation, revision, content) => ({ generation, revision, content });
const settle = () => new Promise(resolve => setImmediate(resolve));

function createClient() {
  const elements = Object.fromEntries(['editor', 'status', 'copyButton', 'clearButton'].map(id => {
    const element = new EventTarget();
    Object.assign(element, { value: '', readOnly: true, dataset: {}, focus() {} });
    return [id, element];
  }));
  const timers = new Map();
  let nextTimer = 0;
  const window = new EventTarget();
  Object.assign(window, {
    isSecureContext: true,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  const requests = [];
  const streams = [];
  const navigator = { onLine: true, clipboard: { writeText: async () => {} } };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    window,
    navigator,
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    },
    EventSource: class extends EventTarget {
      constructor() { super(); streams.push(this); this.closed = false; }
      close() { this.closed = true; }
    }
  });
  vm.runInContext(source, context);

  function emit(stream, type, value) {
    const event = new Event(type);
    if (value) event.data = JSON.stringify(value);
    stream.dispatchEvent(event);
  }

  return {
    elements, window, navigator, requests, streams, timers,
    edit(value) {
      elements.editor.value = value;
      elements.editor.dispatchEvent(new Event('input'));
    },
    emit,
    paste(value, stream = streams.at(-1)) { emit(stream, 'paste', value); },
    async respond(request, value, status = 200) {
      request.resolve({ ok: status >= 200 && status < 300, status, json: async () => value });
      await settle();
    },
    async start(value) {
      await this.respond(requests.shift(), value);
      emit(streams.at(-1), 'open');
    },
    async tick(delay = 350) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.fn();
        }
      }
      await settle();
    }
  };
}

test('a clean tab accepts revision zero after a server restart and fences the old stream', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'before restart'));
  const oldStream = client.streams.at(-1);

  client.paste(snapshot('B', 0, ''));
  assert.equal(client.elements.editor.value, '');
  client.paste(snapshot('B', 1, 'after restart'));
  client.paste(snapshot('A', 10, 'stale old server'), oldStream);
  assert.equal(client.elements.editor.value, 'after restart');
  assert.equal(oldStream.closed, true);
});

test('a late pre-restart PUT cannot acknowledge a draft lost by the server restart', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'old text'));
  client.edit('local draft');
  await client.tick();
  const oldPut = client.requests.shift();

  client.paste(snapshot('B', 0, ''));
  await client.respond(oldPut, snapshot('A', 10, 'local draft'));
  assert.equal(client.elements.editor.value, 'local draft');
  assert.notEqual(client.elements.status.textContent, 'Saved');

  await client.tick();
  const retry = client.requests.shift();
  assert.ok(retry, 'draft must be saved in the new generation');
  assert.equal(JSON.parse(retry.options.body).content, 'local draft');
  await client.respond(retry, snapshot('B', 1, 'local draft'));
  client.paste(snapshot('B', 2, 'new remote edit'));
  assert.equal(client.elements.editor.value, 'new remote edit');
});

for (const retryDuringPut of [false, true]) {
  test(`a current-generation PUT acknowledgement preserves newer remote text${retryDuringPut ? ' after an online retry' : ''}`, async () => {
    const client = createClient();
    await client.start(snapshot('A', 9, 'old text'));
    client.edit('local save');
    await client.tick();
    const put = client.requests.shift();

    client.paste(snapshot('B', 0, ''));
    client.paste(snapshot('B', 2, 'newer remote text'));
    if (retryDuringPut) {
      client.window.dispatchEvent(new Event('online'));
      await client.tick(0);
      assert.equal(client.requests.length, 0, 'retry must wait for the in-flight PUT');
    }
    await client.respond(put, snapshot('B', 1, 'local save'));

    assert.equal(client.elements.editor.value, 'newer remote text');
    await client.tick();
    await client.tick(1500);
    assert.equal(client.requests.length, 0, 'an acknowledged edit must not be replayed');
    assert.equal(client.elements.editor.value, 'newer remote text');
  });
}

test('a current-generation PUT acknowledgement still queues newer local edits', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'old text'));
  client.edit('first edit');
  await client.tick();
  const put = client.requests.shift();
  client.paste(snapshot('B', 0, ''));
  client.edit('newer local edit');
  client.paste(snapshot('B', 2, 'remote edit'));
  await client.respond(put, snapshot('B', 1, 'first edit'));

  assert.equal(client.elements.editor.value, 'newer local edit');
  await client.tick();
  const nextPut = client.requests.shift();
  assert.equal(JSON.parse(nextPut.options.body).content, 'newer local edit');
  await client.respond(nextPut, snapshot('B', 3, 'newer local edit'));
  client.paste(snapshot('B', 4, 'next remote edit'));
  assert.equal(client.elements.editor.value, 'next remote edit');
  await client.tick();
  assert.equal(client.requests.length, 0);
});

test('PUT can discover a new server while SSE is disconnected and fence an unseen old generation', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'old text'));
  const oldStream = client.streams.at(-1);
  client.emit(oldStream, 'error');
  client.edit('saved during disconnect');
  await client.tick();
  await client.respond(client.requests.shift(), snapshot('C', 1, 'saved during disconnect'));
  assert.equal(client.elements.status.textContent, 'Saved');

  client.paste(snapshot('B', 100, 'delayed intermediate server'), oldStream);
  client.paste(snapshot('C', 2, 'current server'));
  assert.equal(client.elements.editor.value, 'current server');
});

test('a same-generation reconnect does not lower the revision frontier', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'latest'));
  const stream = client.streams.at(-1);
  client.emit(stream, 'error');
  client.emit(stream, 'open');
  client.paste(snapshot('A', 8, 'stale'));
  assert.equal(client.elements.editor.value, 'latest');
  assert.equal(client.streams.length, 1);
  client.paste(snapshot('A', 10, 'next'));
  assert.equal(client.elements.editor.value, 'next');
});

test('restart preserves newer edits made while a PUT was in flight', async () => {
  const client = createClient();
  await client.start(snapshot('A', 9, 'old text'));
  client.edit('first draft');
  await client.tick();
  const firstPut = client.requests.shift();
  client.edit('newer draft');
  client.paste(snapshot('B', 0, ''));
  await client.respond(firstPut, snapshot('A', 10, 'first draft'));
  assert.equal(client.elements.editor.value, 'newer draft');
  await client.tick();
  const nextPut = client.requests.shift();
  assert.equal(JSON.parse(nextPut.options.body).content, 'newer draft');
  await client.respond(nextPut, snapshot('B', 1, 'newer draft'));
  assert.equal(client.elements.status.textContent, 'Saved');
});

test('only the newest pending remote snapshot applies after the local save', async () => {
  const client = createClient();
  await client.start(snapshot('A', 1, 'initial'));
  client.edit('local');
  await client.tick();
  client.paste(snapshot('A', 3, 'older remote'));
  client.paste(snapshot('A', 4, 'newest remote'));
  assert.equal(client.elements.editor.value, 'local');
  await client.respond(client.requests.shift(), snapshot('A', 2, 'local'));
  assert.equal(client.elements.editor.value, 'newest remote');
});

for (const [name, content] of [
  ['short text', 'unsaved text'],
  ['large ASCII text', 'x'.repeat(70000)],
  ['large multibyte text', '🙂'.repeat(20000)]
]) {
  test(`canceling navigation preserves autosave of ${name}`, async () => {
    const client = createClient();
    await client.start(snapshot('A', 0, ''));
    client.edit(content);
    const event = new Event('beforeunload', { cancelable: true });
    assert.equal(client.window.dispatchEvent(event), false, 'unsaved text must warn before navigation');
    assert.equal(client.requests.length, 0, 'navigation must not create a parallel save');

    await client.tick();
    const request = client.requests.shift();
    assert.ok(request, 'canceling navigation must leave autosave scheduled');
    assert.equal(JSON.parse(request.options.body).content, content);
    assert.notEqual(request.options.keepalive, true);
    await client.respond(request, snapshot('A', 1, content));
    assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), true);
    assert.equal(client.requests.length, 0);
  });
}

test('navigation during a PUT preserves newer edits without starting a second PUT', async () => {
  const client = createClient();
  await client.start(snapshot('A', 0, ''));
  client.edit('first edit');
  await client.tick();
  const firstPut = client.requests.shift();
  client.edit('newer edit');

  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
  assert.equal(client.requests.length, 0);
  await client.respond(firstPut, snapshot('A', 1, 'first edit'));
  assert.equal(client.elements.editor.value, 'newer edit');
  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);

  await client.tick();
  const secondPut = client.requests.shift();
  assert.equal(JSON.parse(secondPut.options.body).content, 'newer edit');
  await client.respond(secondPut, snapshot('A', 2, 'newer edit'));
  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), true);
});

test('network and size errors retain navigation protection until a save succeeds', async () => {
  const client = createClient();
  await client.start(snapshot('A', 0, ''));
  client.edit('unacknowledged');
  await client.tick();
  client.requests.shift().reject(new Error('connection lost'));
  await settle();
  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);

  await client.tick(1500);
  await client.respond(client.requests.shift(), { error: 'too large' }, 413);
  assert.equal(client.elements.editor.value, 'unacknowledged');
  assert.equal(client.elements.status.textContent, 'Too large');
  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);

  client.edit('smaller');
  await client.tick();
  await client.respond(client.requests.shift(), snapshot('A', 1, 'smaller'));
  assert.equal(client.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), true);
});
