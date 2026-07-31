const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  collaboraEditorAction,
  checkCollaboraServer,
  collaboraDiscoveryUrl,
  normalizeCollaboraUrl,
} = require('./collabora.cjs');

describe('collaboraEditorAction', () => {
  it('selects and decodes the edit action for a document extension', () => {
    const discovery = `
      <wopi-discovery>
        <net-zone>
          <app name="application/vnd.openxmlformats-officedocument.wordprocessingml.document">
            <action name="edit" ext="docx" urlsrc="https://office.example.com/browser/editor?lang=en-US&amp;" />
          </app>
        </net-zone>
      </wopi-discovery>`;

    assert.equal(
      collaboraEditorAction(discovery, '.DOCX'),
      'https://office.example.com/browser/editor?lang=en-US&',
    );
  });

  it('fails when the server does not advertise an editor for the file', () => {
    assert.throws(
      () => collaboraEditorAction('<wopi-discovery />', '.xlsx'),
      /does not advertise/i,
    );
  });

  it('rejects an unsafe editor action even if discovery advertises it', () => {
    assert.throws(
      () => collaboraEditorAction(
        '<action name="edit" ext="docx" urlsrc="javascript:alert(1)" />',
        '.docx',
      ),
      /HTTPS/i,
    );
  });
});

describe('normalizeCollaboraUrl', () => {
  it('normalises a secure server URL to its origin', () => {
    assert.equal(normalizeCollaboraUrl('https://office.example.com/online/'), 'https://office.example.com');
  });

  it('allows insecure HTTP only for a local development server', () => {
    assert.equal(normalizeCollaboraUrl('http://localhost:9980'), 'http://localhost:9980');
    assert.equal(normalizeCollaboraUrl('http://127.0.0.1:9980/'), 'http://127.0.0.1:9980');
    assert.throws(() => normalizeCollaboraUrl('http://office.example.com'), /HTTPS/i);
  });

  it('rejects credentials, query strings and unsupported protocols', () => {
    assert.throws(() => normalizeCollaboraUrl('https://user:secret@office.example.com'), /credentials/i);
    assert.throws(() => normalizeCollaboraUrl('https://office.example.com/?token=secret'), /query/i);
    assert.throws(() => normalizeCollaboraUrl('file:///tmp/editor'), /HTTPS/i);
  });

  it('keeps an empty setting disabled', () => {
    assert.equal(normalizeCollaboraUrl(''), '');
  });
});

describe('collaboraDiscoveryUrl', () => {
  it('points at the standard WOPI discovery endpoint', () => {
    assert.equal(
      collaboraDiscoveryUrl('https://office.example.com'),
      'https://office.example.com/hosting/discovery',
    );
  });
});

describe('checkCollaboraServer', () => {
  it('accepts a discovery document from the configured server', async () => {
    const status = await checkCollaboraServer('https://office.example.com', async (url) => {
      assert.equal(url, 'https://office.example.com/hosting/discovery');
      return {
        ok: true,
        text: async () => '<wopi-discovery><net-zone /></wopi-discovery>',
      };
    });

    assert.deepEqual(status, {
      configured: true,
      reachable: true,
      serverUrl: 'https://office.example.com',
    });
  });

  it('returns a user-facing failure without swallowing the developer detail', async () => {
    const status = await checkCollaboraServer('https://office.example.com', async () => {
      throw new Error('certificate expired');
    });

    assert.equal(status.reachable, false);
    assert.match(status.error, /certificate expired/);
  });

  it('reports an unconfigured server without making a request', async () => {
    let called = false;
    const status = await checkCollaboraServer('', async () => {
      called = true;
      throw new Error('must not run');
    });

    assert.deepEqual(status, { configured: false, reachable: false, serverUrl: '' });
    assert.equal(called, false);
  });
});
