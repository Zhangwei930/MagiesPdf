const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MIRROR_BASE,
  MIRROR_MANIFEST_URL,
  GITHUB_API_LATEST,
  applyFeed,
  buildFeed,
  buildGithubUrl,
  buildMirrorUrl,
  detectPreferredFeed,
  isSafeDownloadTarget,
  pickFeeds,
  preferMirror,
  resolveUpdateChannel,
} = require('./releaseChannel.cjs');

describe('preferMirror / detectPreferredFeed', () => {
  it('is true for an explicit CN country', () => {
    assert.equal(preferMirror({ country: 'CN', locale: 'en-US', timeZone: 'UTC' }), true);
    assert.equal(detectPreferredFeed({ country: 'CN' }), 'mirror');
  });

  it('is true for a zh-CN locale (MagiesTerminal rule)', () => {
    assert.equal(preferMirror({ locale: 'zh-CN', timeZone: 'UTC' }), true);
    assert.equal(detectPreferredFeed({ locale: 'zh-CN' }), 'mirror');
  });

  it('is true for a zh-Hans locale', () => {
    assert.equal(preferMirror({ locale: 'zh-Hans-CN', timeZone: 'UTC' }), true);
  });

  it('is true for a mainland time zone even with an English locale', () => {
    assert.equal(preferMirror({ locale: 'en-US', timeZone: 'Asia/Shanghai' }), true);
  });

  it('is false for Hong Kong and Taipei, which reach GitHub fine', () => {
    assert.equal(preferMirror({ locale: 'zh-HK', timeZone: 'Asia/Hong_Kong' }), false);
    assert.equal(preferMirror({ locale: 'zh-TW', timeZone: 'Asia/Taipei' }), false);
  });

  it('is false for an overseas visitor', () => {
    assert.equal(preferMirror({ locale: 'en-GB', timeZone: 'Europe/London' }), false);
    assert.equal(detectPreferredFeed({ locale: 'en-GB', timeZone: 'Europe/London' }), 'github');
  });

  it('does not treat an unrelated locale starting with "zh" as mainland', () => {
    assert.equal(preferMirror({ locale: 'zh-SG', timeZone: 'Asia/Singapore' }), false);
  });

  it('tolerates a missing time zone', () => {
    assert.equal(preferMirror({ locale: 'en-US', timeZone: '' }), false);
  });
});

describe('resolveUpdateChannel', () => {
  it('uses latest-arm64 only for Windows arm64 (MagiesTerminal rule)', () => {
    assert.equal(resolveUpdateChannel('win32', 'arm64'), 'latest-arm64');
    assert.equal(resolveUpdateChannel('win32', 'x64'), 'latest');
    assert.equal(resolveUpdateChannel('darwin', 'arm64'), 'latest');
    assert.equal(resolveUpdateChannel('linux', 'arm64'), 'latest');
  });
});

describe('pickFeeds / buildFeed', () => {
  it('puts the mirror first for mainland users', () => {
    const feeds = pickFeeds({ locale: 'zh-CN', timeZone: 'Asia/Shanghai' });
    assert.equal(feeds[0].provider, 'generic');
    assert.equal(feeds[0].url, MIRROR_BASE);
    assert.equal(feeds[1].provider, 'github');
  });

  it('puts GitHub first for everyone else', () => {
    const feeds = pickFeeds({ locale: 'en-US', timeZone: 'America/New_York' });
    assert.equal(feeds[0].provider, 'github');
    assert.equal(feeds[1].provider, 'generic');
  });

  it('always offers both, so either can serve as the fallback', () => {
    for (const input of [{ locale: 'zh-CN' }, { locale: 'de-DE', timeZone: 'Europe/Berlin' }]) {
      assert.equal(pickFeeds(input).length, 2);
    }
  });

  it('embeds the arm64 channel on both feeds when requested', () => {
    const feeds = pickFeeds({
      locale: 'en-US',
      timeZone: 'UTC',
      platform: 'win32',
      arch: 'arm64',
    });
    assert.equal(feeds[0].channel, 'latest-arm64');
    assert.equal(feeds[1].channel, 'latest-arm64');
  });

  it('buildFeed produces generic mirror and github descriptors', () => {
    assert.deepEqual(buildFeed('mirror', 'latest'), {
      provider: 'generic',
      url: MIRROR_BASE,
      channel: 'latest',
    });
    assert.equal(buildFeed('github', 'latest-arm64').provider, 'github');
    assert.equal(buildFeed('github', 'latest-arm64').channel, 'latest-arm64');
  });

  it('exposes the mirror manifest URL used by MagiesTerminal dual-link', () => {
    assert.equal(MIRROR_MANIFEST_URL, `${MIRROR_BASE}/release.json`);
    assert.match(GITHUB_API_LATEST, /Zhangwei930\/MagiesPdf\/releases\/latest$/);
  });
});

describe('applyFeed', () => {
  it('sets channel on generic and github providers', () => {
    const feeds = [];
    const updater = {
      channel: 'latest',
      setFeedURL(options) {
        feeds.push({ ...options });
      },
    };

    applyFeed(updater, 'mirror', { platform: 'darwin', arch: 'x64' });
    assert.equal(feeds.at(-1).provider, 'generic');
    assert.equal(feeds.at(-1).url, MIRROR_BASE);
    assert.equal(feeds.at(-1).channel, 'latest');
    assert.equal(updater.channel, 'latest');

    applyFeed(updater, 'github', { platform: 'win32', arch: 'arm64' });
    assert.equal(feeds.at(-1).provider, 'github');
    assert.equal(feeds.at(-1).owner, 'Zhangwei930');
    assert.equal(feeds.at(-1).repo, 'MagiesPdf');
    assert.equal(feeds.at(-1).channel, 'latest-arm64');
    assert.equal(updater.channel, 'latest-arm64');
  });
});

describe('isSafeDownloadTarget', () => {
  it('accepts a mirror asset', () => {
    assert.equal(isSafeDownloadTarget(buildMirrorUrl('MagiesPdf-1.0.0-mac-arm64.dmg')), true);
  });

  it('accepts the mirror release.json used by dual-link version check', () => {
    assert.equal(isSafeDownloadTarget(MIRROR_MANIFEST_URL), true);
  });

  it('accepts a GitHub release asset', () => {
    assert.equal(
      isSafeDownloadTarget(
        'https://github.com/Zhangwei930/MagiesPdf/releases/download/v1.0.0/MagiesPdf-1.0.0-win-x64.exe',
      ),
      true,
    );
  });

  it('accepts the GitHub API latest endpoint', () => {
    assert.equal(isSafeDownloadTarget(GITHUB_API_LATEST), true);
  });

  it('accepts the GitHub CDN that release URLs redirect to', () => {
    assert.equal(isSafeDownloadTarget('https://objects.githubusercontent.com/whatever'), true);
  });

  it('rejects plain http', () => {
    assert.equal(isSafeDownloadTarget('http://dl.magies.top/magiespdf/stable/x.dmg'), false);
  });

  it('rejects another host entirely', () => {
    assert.equal(isSafeDownloadTarget('https://evil.example.com/MagiesPdf.dmg'), false);
  });

  it('rejects a different path on our own mirror host', () => {
    assert.equal(isSafeDownloadTarget('https://dl.magies.top/../etc/passwd'), false);
    assert.equal(isSafeDownloadTarget('https://dl.magies.top/other/x.dmg'), false);
    // MagiesTerminal path must not be accepted as MagiesPdf
    assert.equal(isSafeDownloadTarget('https://dl.magies.top/stable/x.dmg'), false);
  });

  it('rejects a different repo on github.com', () => {
    assert.equal(
      isSafeDownloadTarget('https://github.com/someone/else/releases/download/v1/x.dmg'),
      false,
    );
  });

  it('rejects a hostname that merely ends with our domain', () => {
    assert.equal(isSafeDownloadTarget('https://dl.magies.top.evil.com/magiespdf/stable/x'), false);
  });

  it('rejects malformed input', () => {
    assert.equal(isSafeDownloadTarget('not a url'), false);
    assert.equal(isSafeDownloadTarget(''), false);
  });
});

describe('url builders', () => {
  it('escapes a file name with spaces', () => {
    assert.ok(buildMirrorUrl('Magies Pdf.dmg').endsWith('Magies%20Pdf.dmg'));
    assert.ok(buildGithubUrl('Magies Pdf.dmg').endsWith('Magies%20Pdf.dmg'));
  });

  it('produces targets its own guard accepts', () => {
    // Regression guard: buildGithubUrl uses the `/releases/latest/download/`
    // alias, which an over-narrow guard would reject.
    assert.equal(isSafeDownloadTarget(buildMirrorUrl('a.dmg')), true);
    assert.equal(isSafeDownloadTarget(buildGithubUrl('a.dmg')), true);
  });
});
