function normalizeCollaboraUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Collabora server must be a valid HTTPS URL');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Collabora server URL must not contain credentials');
  }
  if (parsed.search) throw new Error('Collabora server URL must not contain a query string');
  if (parsed.hash) throw new Error('Collabora server URL must not contain a fragment');

  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('Collabora server must use HTTPS (HTTP is allowed only on localhost)');
  }
  return parsed.origin;
}

function collaboraDiscoveryUrl(serverUrl) {
  const origin = normalizeCollaboraUrl(serverUrl);
  if (!origin) throw new Error('Collabora server is not configured');
  return `${origin}/hosting/discovery`;
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attributesOf(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1].toLowerCase()] = decodeXmlAttribute(match[3]);
  }
  return attributes;
}

function collaboraEditorAction(discovery, extension) {
  const expectedExtension = String(extension).replace(/^\./, '').toLowerCase();
  for (const match of String(discovery).matchAll(/<action\b[^>]*>/gi)) {
    const attributes = attributesOf(match[0]);
    if (
      attributes.name === 'edit' &&
      attributes.ext?.toLowerCase() === expectedExtension &&
      attributes.urlsrc
    ) {
      const action = new URL(attributes.urlsrc);
      const local = action.hostname === 'localhost' || action.hostname === '127.0.0.1' || action.hostname === '[::1]';
      if (action.username || action.password || (action.protocol !== 'https:' && !(local && action.protocol === 'http:'))) {
        throw new Error('Collabora editor action must use HTTPS (HTTP is allowed only on localhost)');
      }
      return attributes.urlsrc;
    }
  }
  throw new Error(`Collabora does not advertise an editor for .${expectedExtension}`);
}

async function fetchCollaboraDiscovery(serverUrl, fetcher = fetch) {
  const response = await fetcher(collaboraDiscoveryUrl(serverUrl), {
    headers: { Accept: 'application/xml,text/xml' },
    signal: globalThis.AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Collabora discovery returned HTTP ${response.status ?? 'error'}`);
  const body = await response.text();
  if (!/<(?:\w+:)?wopi-discovery\b/i.test(body)) {
    throw new Error('Collabora discovery response is not a WOPI discovery document');
  }
  return body;
}

async function getCollaboraEditorAction(serverUrl, extension, fetcher = fetch) {
  return collaboraEditorAction(await fetchCollaboraDiscovery(serverUrl, fetcher), extension);
}

async function checkCollaboraServer(serverUrl, fetcher = fetch) {
  const origin = normalizeCollaboraUrl(serverUrl);
  if (!origin) return { configured: false, reachable: false, serverUrl: '' };

  try {
    await fetchCollaboraDiscovery(origin, fetcher);
    return { configured: true, reachable: true, serverUrl: origin };
  } catch (cause) {
    return {
      configured: true,
      reachable: false,
      serverUrl: origin,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

module.exports = {
  checkCollaboraServer,
  collaboraDiscoveryUrl,
  collaboraEditorAction,
  fetchCollaboraDiscovery,
  getCollaboraEditorAction,
  normalizeCollaboraUrl,
};
