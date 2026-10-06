// Reads feed tiles, asks the judge (via background.js) about them, and blacks out the ones that fail.
// If the judge errors (no key, server down) tiles are left unfiltered.
const YT = location.host.includes('youtube');
const TILES = YT
  ? 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model'
  : 'article';

const text = (el, sel) => (el.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

function extract(tile) {
  if (YT) {
    const href = tile.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]')?.getAttribute('href');
    if (!href) return null;
    const short = href.startsWith('/shorts/');
    const id = short ? href.split('/')[2].split('?')[0] : new URLSearchParams(href.split('?')[1]).get('v');
    const title = text(tile, '#video-title, .ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model__title, h3');
    const channel = text(tile, 'ytd-channel-name a, .ytContentMetadataViewModelMetadataText, .yt-content-metadata-view-model__metadata-text, a[href^="/@"]');
    if (!id || !title) return null;
    return { id: 'yt:' + id, source: 'youtube', short, text: `${title} — ${channel}`, url: 'https://www.youtube.com' + href };
  }
  // X serves two layouts: the classic one with data-testid hooks and a newer one with bare articles.
  const link = (tile.querySelector('a[href*="/status/"] time')?.closest('a') || tile.querySelector('a[href*="/status/"]'))?.getAttribute('href');
  const body = text(tile, '[data-testid="tweetText"]') || tile.innerText.replace(/\s+/g, ' ').trim();
  if (!link || !body) return null;
  return { id: 'x:' + link.split('/status/')[1].split(/[/?]/)[0], source: 'x', text: `@${link.split('/')[1]}: ${body}`, url: 'https://x.com' + link };
}

const send = (path, body) => new Promise(done => chrome.runtime.sendMessage({ path, body }, r => done(chrome.runtime.lastError || !r ? { error: 'unreachable' } : r)));

const sleep = ms => new Promise(done => setTimeout(done, ms));
// The sites' menus ignore a bare click(); they need the pointer events that precede one.
const press = el => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })); };

// Passes a downvote on to the site by choosing "Not interested" in the tile's own menu. English UI only.
async function signal(tile) {
  if ((await chrome.storage.local.get({ signal: true })).signal === false) return;
  const button = tile.querySelector(YT ? 'button[aria-label="More actions"], button[aria-label="Action menu"]' : '[data-testid="caret"]');
  if (!button) return;
  press(button);
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.getClientRects().length && e.textContent.trim().startsWith('Not interested'));
    if (item) return press(item);
  }
  press(document.body); // no such entry: close the menu again
}

// Verdicts live here and on data-ff, not in classes: the sites rewrite a tile's class list
// and children when it is hovered or re-rendered, and sweep() repaints from this map.
const verdicts = new Map(); // id -> { state: '' | 'pending' | 'hide' | 'keep', label, p, vote }

function decorate(tile) {
  const veil = document.createElement('div');
  veil.className = 'ff-veil';
  veil.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); show(tile, 'keep'); }, true);
  const badge = document.createElement('div');
  badge.className = 'ff-badge';
  badge.append(document.createElement('span'));
  for (const [label, value] of [['👍', 1], ['👎', -1]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = value > 0 ? 'ff-up' : 'ff-down';
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      send('/api/vote', { id: tile.dataset.ffId, vote: value });
      show(tile, value < 0 ? 'hide' : 'keep', value < 0 ? 'downvoted · click to peek' : undefined, undefined, value);
      if (value < 0) signal(tile);
    }, true);
    badge.append(b);
  }
  tile.append(veil, badge);
}

function paint(tile) {
  const v = verdicts.get(tile.dataset.ffId);
  if (!tile.querySelector(':scope > .ff-veil')) decorate(tile);
  tile.dataset.ff = v.state;
  tile.dataset.ffVote = v.vote > 0 ? 'up' : v.vote < 0 ? 'down' : '';
  tile.querySelector(':scope > .ff-veil').textContent = v.label || '';
  tile.querySelector(':scope > .ff-badge > span').textContent = v.p == null ? '' : v.p.toFixed(2);
}

function show(tile, state, label, p, vote) {
  const old = verdicts.get(tile.dataset.ffId) || {};
  verdicts.set(tile.dataset.ffId, { state, label: label ?? old.label, p: p ?? old.p, vote: vote ?? old.vote });
  paint(tile);
}

let queue = [], timer = null;

function sweep() {
  for (const tile of document.querySelectorAll(TILES)) {
    if (tile.parentElement.closest(TILES)) continue;
    const item = extract(tile);
    if (!item) continue;
    // YouTube reuses tile elements for new videos, so key on the id rather than the element.
    if (tile.dataset.ffId === item.id && tile.dataset.ff !== undefined && tile.querySelector(':scope > .ff-veil')) continue;
    tile.dataset.ffId = item.id;
    if (verdicts.has(item.id)) { paint(tile); continue; }
    show(tile, 'pending', 'checking…');
    queue.push({ tile, item });
  }
  if (queue.length && !timer) timer = setTimeout(flush, 300);
}

async function flush() {
  timer = null;
  const batch = queue.splice(0, 40);
  const res = await send('/api/judge', { items: batch.filter(b => !b.item.short).map(b => b.item) });
  const state = res.state;
  document.documentElement.classList.toggle('ff-on', !!(state && state.enabled));
  document.documentElement.classList.toggle('ff-noshorts', !!(state && state.enabled && state.block_shorts));
  for (const { tile, item } of batch) {
    if (tile.dataset.ffId !== item.id) continue;
    const r = res.results && res.results[item.id];
    if (res.error || !state.enabled) show(tile, '', '');
    else if (item.short) show(tile, state.block_shorts ? 'hide' : '', 'Short');
    else if (!r || r.p == null) show(tile, '', '');
    else show(tile, (r.vote ? r.vote > 0 : r.p >= state.threshold) ? 'keep' : 'hide', r.vote < 0 ? 'downvoted · click to peek' : `filtered · ${r.p.toFixed(2)} · click to peek`, r.p, r.vote);
  }
  if (queue.length) timer = setTimeout(flush, 0);
}

new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true });
sweep();
