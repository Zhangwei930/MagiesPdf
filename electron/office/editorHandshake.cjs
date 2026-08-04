/**
 * The messages a document server sends the editor so that it opens a document.
 *
 * The editor never asks for these. It opens a socket, registers a handler and
 * waits, so the host has to volunteer the whole sequence: first what a server
 * announces on connect, then what it would normally only send in reply to an
 * `auth` the editor does not send in this configuration.
 *
 * Every field here earned its place by the editor failing without it. The
 * licence in particular is not optional: the app layer reads its capabilities
 * from it, and its absence surfaces much later as an opaque `changesError`
 * about `mode.canCoAuthoring` being undefined.
 */

const BUILD_VERSION = '9.4.0';
const BUILD_NUMBER = 9;

/** Sent as soon as the socket is up, before the editor asks for anything. */
function connectMessages({ sessionId }) {
  return [
    // The transport handshake. It carries no `type`; the client reads it as the
    // engine.io packet it would normally get from a real server.
    {
      maxPayload: 100000000,
      pingInterval: 25000,
      pingTimeout: 20000,
      sid: sessionId,
      upgrades: [],
    },
    {
      type: 'license',
      license: {
        type: 3,
        buildNumber: BUILD_NUMBER,
        buildVersion: BUILD_VERSION,
        light: false,
        mode: 0,
        rights: 1,
        protectionSupport: true,
        isAnonymousSupport: true,
        liveViewerSupport: true,
        branding: false,
        customization: true,
        // The Connector is a paid ONLYOFFICE add-on we do not have; saying
        // otherwise would leave the editor waiting on messages nothing sends.
        advancedApi: false,
      },
    },
  ];
}

/** Sent once the socket is up: who is editing, and where the document is. */
function documentMessages({ sessionId, urls, user, readOnly = false }) {
  const participant = {
    connectionId: sessionId,
    encrypted: false,
    id: user.id,
    idOriginal: user.id,
    indexUser: 1,
    isCloseCoAuthoring: false,
    isLiveViewer: readOnly,
    username: user.name,
    view: readOnly,
  };

  return [
    { type: 'authChanges', changes: [] },
    {
      type: 'auth',
      result: 1,
      sessionId,
      participants: [participant],
      locks: [],
      indexUser: 1,
      buildVersion: BUILD_VERSION,
      buildNumber: BUILD_NUMBER,
      licenseType: 3,
      editorType: 2,
      mode: readOnly ? 'view' : 'edit',
      permissions: {
        comment: true,
        chat: false,
        download: true,
        edit: !readOnly,
        fillForms: !readOnly,
        modifyFilter: !readOnly,
        protect: !readOnly,
        print: true,
        review: !readOnly,
        copy: true,
      },
    },
    // `urls` maps each part of the document — the editor binary and every
    // extracted image — to somewhere the editor can fetch it.
    { type: 'documentOpen', data: { type: 'open', status: 'ok', data: urls } },
  ];
}

module.exports = { connectMessages, documentMessages };
