// Reads feed tiles, asks the judge (via background.js) about them, and blacks out the ones that fail.
// If the judge errors (no key, out of credit, server down) tiles are left unfiltered and a notice is shown.
const SITE_KEY = Object.keys(FF_SITES).find(key => FF_SITES[key].hosts.includes(location.host));
const site = FF_SITES[SITE_KEY];
const TILES = site.tiles;
const pageKind = () => site.kind(location.pathname);

const sleep = ms => new Promise(done => setTimeout(done, ms));
const send = (path, body) => new Promise(done => chrome.runtime.sendMessage({ path, body }, r => done(chrome.runtime.lastError || !r ? { error: 'Feed filter was reloaded. Refresh this page.' } : r)));

// Reads a tile the first time its item is seen. Returns the item to judge, or null to leave it alone.
function extract(tile, id) {
  const got = site.read(tile);
  if (!got || !got.text) return null;
  const url = got.url.startsWith('/') ? site.origin + got.url : got.url;
  return { id, source: SITE_KEY, short: !!got.short, author: got.author || '', group: got.group || '', text: got.text, url };
}

// The sites' menus ignore a bare click(); they need the pointer events that precede one.
const press = el => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })); };

// Passes a downvote on to the site by choosing "Not interested" in the tile's own menu, on the
// sites where such an entry exists. English UI only.
async function signal(tile) {
  if (!config.signal || !site.menu) return;
  const button = tile.querySelector(site.menu);
  if (!button) return;
  press(button);
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.getClientRects().length && e.textContent.trim().startsWith('Not interested'));
    if (item) return press(item);
  }
  press(document.body); // no such entry: close the menu again
}

// One notice at a time, bottom right. A message the user dismissed is not shown again on this page.
const dismissed = new Set();
function notice(message) {
  let box = document.getElementById('ff-notice');
  if (!message || dismissed.has(message)) { box?.remove(); return; }
  if (box?.dataset.message === message) return;
  box?.remove();
  box = document.createElement('div');
  box.id = 'ff-notice';
  box.dataset.message = message;
  const words = document.createElement('span');
  words.textContent = `Feed filter: ${message}`;
  const open = document.createElement('button');
  open.textContent = 'Settings';
  open.addEventListener('click', () => send('/ext/options'));
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => { dismissed.add(message); box.remove(); });
  box.append(words, open, close);
  document.documentElement.append(box);
}

// Verdicts live here and on data-ff, not in classes: the sites rewrite a tile's class list
// and children when it is hovered or re-rendered, and sweep() repaints from this map.
const verdicts = new Map(); // id -> { state: '' | 'pending' | 'hide' | 'keep', label, p, vote }

function decorate(tile) {
  const veil = document.createElement('div');
  veil.className = 'ff-veil';
  // isTrusted: only the person's own clicks count, never ones the page's scripts synthesise.
  veil.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (e.isTrusted) show(tile, 'keep'); }, true);
  const badge = document.createElement('div');
  badge.className = 'ff-badge';
  badge.append(document.createElement('span'));
  for (const [label, value] of [['👍', 1], ['👎', -1]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = value > 0 ? 'ff-up' : 'ff-down';
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (!e.isTrusted) return;
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
  tile.dataset.ffVote = v.noVote ? 'none' : v.vote > 0 ? 'up' : v.vote < 0 ? 'down' : '';
  tile.querySelector(':scope > .ff-veil').textContent = v.label || '';
  tile.querySelector(':scope > .ff-badge > span').textContent = v.p == null ? '' : v.p.toFixed(2);
}

// A verdict belongs to the item, so every tile showing that item is repainted.
function show(tile, state, label, p, vote) {
  const id = tile.dataset.ffId;
  setVerdict(id, state, label, p, vote);
  for (const el of document.querySelectorAll('[data-ff-id]')) if (el.dataset.ffId === id) paint(el);
}

function setVerdict(id, state, label, p, vote, noVote) {
  const old = verdicts.get(id) || {};
  verdicts.set(id, { state, label: label ?? old.label, p: p ?? old.p, vote: vote ?? old.vote, noVote: noVote ?? old.noVote });
}

let config = null; // { pages, signal } from the extension settings
let queue = [], timer = null, sweepTimer = null;

function setPageClasses(state) {
  const on = !!(state && state.enabled && config.pages[SITE_KEY]?.[pageKind()]);
  document.documentElement.classList.toggle('ff-on', on);
  document.documentElement.classList.toggle('ff-noshorts', on && !!state.block_shorts);
}

function sweep() {
  sweepTimer = null;
  if (!config.pages[SITE_KEY]?.[pageKind()]) {
    // This kind of page is switched off: take our marks away and leave it alone.
    clearMarks();
    setPageClasses(null);
    return;
  }
  for (const tile of document.querySelectorAll(TILES)) {
    if (tile.parentElement.closest(TILES)) continue;
    const raw = site.id(tile);
    if (!raw) continue;
    const id = site.prefix + ':' + raw;
    // Sites reuse tile elements for new items, so key on the id rather than the element.
    if (tile.dataset.ffId === id && tile.dataset.ff !== undefined && tile.querySelector(':scope > .ff-veil')) continue;
    if (verdicts.has(id)) { tile.dataset.ffId = id; paint(tile); continue; }
    // Only now read the tile's text: it is the costly part and is needed once per item.
    const item = extract(tile, id);
    if (!item) continue;
    tile.dataset.ffId = id;
    show(tile, 'pending', 'checking…');
    queue.push({ tile, item });
  }
  if (queue.length && !timer) timer = setTimeout(flush, 300);
}

async function flush() {
  timer = null;
  const batch = queue.splice(0, 40);
  const res = await send('/api/judge', { items: batch.filter(b => !b.item.short).map(({ item: { short, ...item } }) => item) });
  const state = res.state;
  if (state) { config = { pages: state.pages, signal: state.signal }; setPageClasses(state); }
  notice(res.error || res.notice || null);
  for (const { tile, item } of batch) {
    const r = res.results && res.results[item.id];
    // The verdict is recorded under the item id even if the site has since reused the tile for another item.
    if (res.error || !state || !state.enabled) setVerdict(item.id, '', '');
    else if (item.short) setVerdict(item.id, state.block_shorts ? 'hide' : '', 'Short · click to peek', undefined, undefined, true);
    else if (!r) setVerdict(item.id, '', '');
    else if (r.rule === 'never') setVerdict(item.id, 'hide', 'on your never-keep list · click to peek', undefined, undefined, true);
    else if (r.rule === 'always') setVerdict(item.id, 'keep', '', undefined, undefined, true);
    else if (typeof r.p !== 'number') setVerdict(item.id, '', '');
    else setVerdict(item.id, (r.vote ? r.vote > 0 : r.p >= state.threshold) ? 'keep' : 'hide', r.vote < 0 ? 'downvoted · click to peek' : `filtered · ${r.p.toFixed(2)} · click to peek`, r.p, r.vote);
  }
  // Repaint by id, not by batch entry: the same video can sit in several tiles, and a tile may
  // have been reused for another item while its verdict was on the way.
  for (const tile of document.querySelectorAll('[data-ff-id]')) if (verdicts.has(tile.dataset.ffId)) paint(tile);
  if (queue.length) timer = setTimeout(flush, 0);
}

function clearMarks() {
  for (const tile of document.querySelectorAll('[data-ff]')) { delete tile.dataset.ff; delete tile.dataset.ffId; delete tile.dataset.ffVote; }
  queue = [];
}

async function start() {
  const res = await send('/ext/config');
  if (res.error) return false;
  config = res;
  sweep();
  return true;
}

// The popup asks for a fresh look after a setting changes, instead of reloading the tab.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'ff-refresh') return;
  verdicts.clear();
  clearMarks();
  start();
});

start().then(ok => {
  // Pages change constantly; look again at most every 150ms.
  if (ok) new MutationObserver(() => { if (!sweepTimer) sweepTimer = setTimeout(sweep, 150); }).observe(document.body, { childList: true, subtree: true });
});
