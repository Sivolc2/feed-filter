// One entry per supported site. Loaded as a content script (before content.js) and imported by
// the background worker and the settings page, so it must not touch the page at load time.
//
//   prefix, origin   item ids are "<prefix>:<id>"; item links must start with origin + "/"
//   pages            kinds of page: [label, filtered by default]
//   kind(path)       which kind of page a path is
//   tiles            selector for one feed item (nested matches are ignored)
//   id(tile)         stable id for the item, or null to leave the tile alone. Must be cheap.
//   read(tile)       { text, author, url, group?, short? } for an item not seen before, or null
//   menu             selector for the item's own menu button, where a "Not interested" entry exists
//   verified         how the selectors were last checked against the real site
const text = (el, sel) => ((sel ? el.querySelector(sel) : el)?.textContent || '').replace(/\s+/g, ' ').trim();
const visibleText = el => el.innerText.replace(/\s+/g, ' ').trim();
const attr = (el, sel, name) => el.querySelector(sel)?.getAttribute(name) || '';
function hash(s) { let a = 0xdeadbeef, b = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); } return (a >>> 0).toString(36) + (b >>> 0).toString(36); }

globalThis.FF_SITES = {
  youtube: {
    label: 'YouTube', prefix: 'yt', origin: 'https://www.youtube.com', hosts: ['www.youtube.com'], verified: 'live search page; logged-in home by observation',
    pages: { home: ['Home', true], search: ['Search results', true], watch: ['Watch page sidebar', true], subscriptions: ['Subscriptions', false], other: ['Everything else (channels, playlists, history)', false] },
    kind: p => p === '/' ? 'home' : p === '/results' ? 'search' : p === '/watch' ? 'watch' : p.startsWith('/feed/subscriptions') ? 'subscriptions' : 'other',
    tiles: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model',
    link: tile => { const href = attr(tile, 'a[href*="/watch?v="], a[href^="/shorts/"]', 'href'); return href.startsWith('/') ? href : ''; },
    id(tile) { const href = this.link(tile); if (!href) return null; return href.startsWith('/shorts/') ? href.split('/')[2].split('?')[0] : new URLSearchParams(href.split('?')[1]).get('v'); },
    read(tile) {
      const href = this.link(tile);
      const title = text(tile, '#video-title, .ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model__title, h3');
      const channel = text(tile, 'ytd-channel-name a, .ytContentMetadataViewModelMetadataText, .yt-content-metadata-view-model__metadata-text, a[href^="/@"]');
      return title ? { text: `${title} — ${channel}`, author: channel, url: href, short: href.startsWith('/shorts/') } : null;
    },
    menu: 'button[aria-label="More actions"], button[aria-label="Action menu"]',
  },

  x: {
    label: 'X', prefix: 'x', origin: 'https://x.com', hosts: ['x.com', 'twitter.com'], verified: 'logged-in timeline by observation',
    pages: { home: ['Home timeline', true], search: ['Search and Explore', true], other: ['Everything else (profiles, threads, notifications)', false] },
    kind: p => p === '/home' ? 'home' : p.startsWith('/search') || p.startsWith('/explore') ? 'search' : 'other',
    tiles: 'article',
    // X serves two layouts: the classic one with data-testid hooks and a newer one with bare articles.
    link: tile => { const href = (tile.querySelector('a[href*="/status/"] time')?.closest('a') || tile.querySelector('a[href*="/status/"]'))?.getAttribute('href') || ''; return href.startsWith('/') ? href : ''; },
    // Posts from protected accounts are private: never read them.
    id(tile) { const href = this.link(tile); return href && !tile.querySelector('[data-testid="icon-lock"]') ? href.split('/status/')[1].split(/[/?]/)[0] : null; },
    read(tile) { const href = this.link(tile), author = href.split('/')[1], body = text(tile, '[data-testid="tweetText"]') || visibleText(tile); return body ? { text: `@${author}: ${body}`, author, url: href } : null; },
    menu: '[data-testid="caret"]',
  },

  reddit: {
    label: 'Reddit', prefix: 'rd', origin: 'https://www.reddit.com', hosts: ['www.reddit.com'], verified: 'not checked against the live site',
    pages: { home: ['Home, Popular and All', true], subreddit: ['Subreddit listings', true], search: ['Search results', true], other: ['Everything else (comment pages, profiles)', false] },
    kind: p => /^\/(r\/(popular|all)\/?.*|best|hot|new|top|rising)?\/?$/.test(p) ? 'home' : p.startsWith('/search') ? 'search' : /^\/r\/[^/]+\/?(hot|new|top|rising)?\/?$/.test(p) ? 'subreddit' : 'other',
    tiles: 'shreddit-post',
    id: tile => (tile.getAttribute('id') || '').replace(/^t3_/, '') || null,
    read(tile) {
      const title = tile.getAttribute('post-title') || text(tile, '[slot="title"]'), sub = tile.getAttribute('subreddit-prefixed-name') || '', link = tile.getAttribute('permalink') || '';
      return title && link.startsWith('/') ? { text: `${title} — ${sub}`, author: sub, group: 'u/' + (tile.getAttribute('author') || ''), url: link } : null;
    },
  },

  hackernews: {
    label: 'Hacker News', prefix: 'hn', origin: 'https://news.ycombinator.com', hosts: ['news.ycombinator.com'], verified: 'live front page',
    pages: { home: ['Front page, New, Ask, Show', true], other: ['Everything else (comment threads)', false] },
    kind: p => /^\/(news|newest|front|ask|show|best)?$/.test(p) ? 'home' : 'other',
    // The veil goes on the title cell, since a table row cannot hold one.
    tiles: 'tr.athing > td.title:last-child',
    id: tile => /^\d+$/.test(tile.parentElement.id) ? tile.parentElement.id : null,
    read(tile) { const title = text(tile, '.titleline > a'), site = text(tile, '.sitestr'); return title ? { text: `${title} — ${site || 'news.ycombinator.com'}`, author: site, url: '/item?id=' + tile.parentElement.id } : null; },
  },

  bluesky: {
    label: 'Bluesky', prefix: 'bs', origin: 'https://bsky.app', hosts: ['bsky.app'], verified: 'live Discover feed, logged out',
    pages: { home: ['Home feeds', true], search: ['Search', true], other: ['Everything else (profiles, threads, notifications)', false] },
    kind: p => p === '/' ? 'home' : p.startsWith('/search') ? 'search' : 'other',
    tiles: '[data-testid^="feedItem-by-"]',
    link: tile => { const href = attr(tile, 'a[href*="/post/"]', 'href'); return href.startsWith('/profile/') ? href : ''; },
    id(tile) { return this.link(tile).split('/post/')[1]?.split(/[/?]/)[0] || null; },
    read(tile) { const author = tile.dataset.testid.slice('feedItem-by-'.length), body = text(tile, '[data-testid="postText"]'); return body ? { text: `@${author}: ${body}`, author, url: this.link(tile) } : null; },
  },

  threads: {
    label: 'Threads', prefix: 'th', origin: 'https://www.threads.com', hosts: ['www.threads.com', 'www.threads.net'], verified: 'live home feed, logged out',
    pages: { home: ['Home feeds', true], search: ['Search', true], other: ['Everything else (profiles, threads, activity)', false] },
    kind: p => /^\/(for_you|following)?\/?$/.test(p) ? 'home' : p.startsWith('/search') ? 'search' : 'other',
    tiles: '[data-pressable-container]',
    link: tile => { const href = tile.querySelector('time')?.closest('a')?.getAttribute('href') || ''; return /^\/@[^/]+\/post\//.test(href) ? href : ''; },
    id(tile) { return this.link(tile).split('/post/')[1]?.split(/[/?]/)[0] || null; },
    read(tile) { const href = this.link(tile), author = href.split('/')[1].slice(1), body = visibleText(tile); return body ? { text: `@${author}: ${body}`, author, url: href } : null; },
  },

  facebook: {
    label: 'Facebook', prefix: 'fb', origin: 'https://www.facebook.com', hosts: ['www.facebook.com'], verified: 'live public page, logged out; not the logged-in home feed',
    pages: { home: ['Home feed', true], other: ['Everything else (groups, pages, profiles, Watch)', false] },
    kind: p => p === '/' || p === '/home.php' ? 'home' : 'other',
    tiles: 'div[role="article"]',
    // Only posts Facebook itself marks "Shared with Public" are ever read. Friends-only and group posts are private.
    public: tile => !!tile.querySelector('svg[title^="Shared with Public"]'),
    key: tile => text(tile, '[data-ad-rendering-role="profile_name"]') + '|' + text(tile, '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]').slice(0, 200),
    // Facebook hides post links until they are hovered, so the id is a hash of who wrote it and how it starts.
    id(tile) { if (!this.public(tile)) return null; const key = this.key(tile); return key.length > 12 ? hash(key) : null; },
    read(tile) {
      const author = text(tile, '[data-ad-rendering-role="profile_name"]'), body = text(tile, '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]');
      const link = [...tile.querySelectorAll('a[href^="https://www.facebook.com/"]')].map(a => a.getAttribute('href').split('?')[0]).find(h => /\/(posts|videos|reel|permalink|photos?)\//.test(h));
      return body && this.public(tile) ? { text: `${author}: ${body}`, author, url: link || '/' } : null;
    },
  },

  linkedin: {
    label: 'LinkedIn', prefix: 'li', origin: 'https://www.linkedin.com', hosts: ['www.linkedin.com'], verified: 'not checked against the live site',
    // Off by default: the selectors are unverified, and posts in this feed may be visible to connections only.
    pages: { home: ['Home feed', false], other: ['Everything else', false] },
    kind: p => p.startsWith('/feed') && !p.startsWith('/feed/update') ? 'home' : 'other',
    tiles: 'div[data-urn^="urn:li:activity:"]',
    id: tile => tile.dataset.urn.split(':').pop().replace(/\D/g, '') || null,
    read(tile) {
      const author = text(tile, '.update-components-actor__title span[aria-hidden="true"]') || text(tile, '.update-components-actor__title'), body = text(tile, '.update-components-text, .feed-shared-update-v2__description');
      return body ? { text: `${author}: ${body}`, author, url: '/feed/update/' + tile.dataset.urn + '/' } : null;
    },
  },
};
