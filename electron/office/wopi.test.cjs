const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { createWopiHandler, createWopiStore } = require('./wopi.cjs');

const temporaryDirectories = [];

async function officeFile(name = 'Letter.docx', contents = 'first version') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-wopi-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe('WOPI store', () => {
  it('registers an Office file and authorizes it with an opaque token', async () => {
    const store = createWopiStore();
    const filePath = await officeFile();

    const session = await store.register(filePath);
    const info = await store.info(session.id, session.accessToken);

    assert.equal(info.BaseFileName, 'Letter.docx');
    assert.equal(info.Size, 13);
    assert.equal(info.UserCanWrite, true);
    assert.match(info.LastModifiedTime, /^\d{4}-\d{2}-\d{2}T/);
    await assert.rejects(store.info(session.id, 'wrong-token'), /unauthorized/i);
  });

  it('reads and saves the document without changing its path', async () => {
    const store = createWopiStore();
    const filePath = await officeFile('Budget.xlsx');
    const session = await store.register(filePath);

    assert.equal((await store.read(session.id, session.accessToken)).toString(), 'first version');
    await store.write(session.id, session.accessToken, Buffer.from('saved'), 'lock-one');

    assert.equal(await fs.readFile(filePath, 'utf8'), 'saved');
  });

  it('enforces Collabora locks when saving', async () => {
    const store = createWopiStore();
    const session = await store.register(await officeFile());

    assert.deepEqual(store.lock(session.id, session.accessToken, 'lock-one'), {
      ok: true,
      currentLock: 'lock-one',
    });
    assert.deepEqual(store.lock(session.id, session.accessToken, 'lock-two'), {
      ok: false,
      currentLock: 'lock-one',
    });
    await assert.rejects(
      store.write(session.id, session.accessToken, Buffer.from('blocked'), 'lock-two'),
      /lock mismatch/i,
    );
    assert.deepEqual(store.unlock(session.id, session.accessToken, 'lock-one'), {
      ok: true,
      currentLock: '',
    });
  });

  it('keeps every active session through the advertised capacity', async () => {
    const store = createWopiStore();
    const filePath = await officeFile();
    const sessions = [];
    for (let index = 0; index < 20; index += 1) {
      sessions.push(await store.register(filePath));
    }

    const first = sessions[0];
    assert.equal((await store.info(first.id, first.accessToken)).BaseFileName, 'Letter.docx');
  });
});

function request(method, url, { body = '', headers = {} } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    on(event, callback) {
      if (event === 'data') chunks.forEach(callback);
      if (event === 'end') queueMicrotask(callback);
      return this;
    },
  };
}

function response() {
  const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
  return {
    result,
    writeHead(status, headers = {}) {
      result.status = status;
      result.headers = headers;
    },
    end(body = '') {
      result.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
}

describe('WOPI HTTP handler', () => {
  it('serves file info and contents only with the session token', async () => {
    const store = createWopiStore();
    const session = await store.register(await officeFile());
    const handle = createWopiHandler(store);
    const infoResponse = response();

    assert.equal(
      await handle(
        request('GET', `/wopi/files/${session.id}?access_token=${session.accessToken}`),
        infoResponse,
      ),
      true,
    );
    assert.equal(infoResponse.result.status, 200);
    assert.equal(JSON.parse(infoResponse.result.body).BaseFileName, 'Letter.docx');

    const deniedResponse = response();
    await handle(request('GET', `/wopi/files/${session.id}?access_token=wrong`), deniedResponse);
    assert.equal(deniedResponse.result.status, 401);
  });

  it('accepts lock and save requests from Collabora', async () => {
    const store = createWopiStore();
    const filePath = await officeFile();
    const session = await store.register(filePath);
    const handle = createWopiHandler(store);
    const token = `access_token=${session.accessToken}`;

    const lockResponse = response();
    await handle(
      request('POST', `/wopi/files/${session.id}?${token}`, {
        headers: { 'x-wopi-override': 'LOCK', 'x-wopi-lock': 'lock-one' },
      }),
      lockResponse,
    );
    assert.equal(lockResponse.result.status, 200);

    const saveResponse = response();
    await handle(
      request('POST', `/wopi/files/${session.id}/contents?${token}`, {
        body: 'from collabora',
        headers: { 'x-wopi-lock': 'lock-one' },
      }),
      saveResponse,
    );
    assert.equal(saveResponse.result.status, 200);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'from collabora');
  });

  it('leaves non-WOPI routes for the REST handler', async () => {
    const handle = createWopiHandler(createWopiStore());
    assert.equal(await handle(request('GET', '/v1/health'), response()), false);
  });
});
