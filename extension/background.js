// Every page talks to the judge through here: { path, body } in, JSON out, { error } on failure.
// /api/* goes to the user's server if one is set, otherwise to the judge in local.js.
// /ext/* is always handled here. Content scripts run inside web pages, so they may only call
// the few routes in FROM_PAGES and cannot read the extension's storage (and so not the key).
import './sites.js';
import { routes as local, settings, clear, test, importVotes } from './local.js';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const FROM_PAGES = new Set(['/ext/config', '/api/judge', '/api/vote', '/ext/options']);
// An item is well-formed when its source is a known site, its id carries that site's prefix,
// and its link points at that site.
const ITEM_ID = /^[a-z]{1,4}:[\w-]{1,60}$/;
const wellFormed = it => !!it && typeof it.id === 'string' && ITEM_ID.test(it.id) && typeof it.url === 'string' && typeof it.text === 'string' && !!it.text.trim()
  && Object.hasOwn(FF_SITES, it.source) && it.id.startsWith(FF_SITES[it.source].prefix + ':') && it.url.startsWith(FF_SITES[it.source].origin + '/');
const today = () => new Date().toLocaleDateString('en-CA');
const names = list => new Set(String(list).split('\n').map(name).filter(Boolean));
const name = text => String(text || '').trim().replace(/^@/, '').toLowerCase();

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 60).filter(wellFormed)
    .map(it => ({ id: it.id, source: it.source, url: it.url.slice(0, 300), text: it.text.slice(0, 600), author: String(it.author || '').slice(0, 100), group: String(it.group || '').slice(0, 100) }));
}

async function backend(path, body, s) {
  if (!s.serverUrl) {
    if (!local[path]) throw new Error('That needs a judge server.');
    return local[path](body);
  }
  const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  let res;
  try {
    res = await (await fetch(s.serverUrl.replace(/\/+$/, '') + path, { ...init, signal: AbortSignal.timeout(25000) })).json();
  } catch {
    throw new Error(`Could not reach your judge server at ${new URL(s.serverUrl).host}.`);
  }
  if (!res || typeof res !== 'object') throw new Error('Your judge server sent an unexpected reply.');
  if (res.error) throw new Error(String(res.error).slice(0, 300));
  return res;
}

// A server reply is untrusted: keep only well-formed fields, so a bad one cannot break the pages.
function cleanState(state) {
  if (!state || typeof state !== 'object') throw new Error('The judge sent an unexpected reply.');
  const threshold = Number(state.threshold);
  return { enabled: state.enabled === true, mode: state.mode === 'smart' ? 'smart' : 'fast', threshold: threshold > 0 && threshold < 1 ? threshold : 0.5, block_shorts: state.block_shorts === true };
}
function cleanResults(results, items) {
  const out = {};
  for (const { id } of items) {
    const r = results?.[id];
    if (!r || typeof r !== 'object') continue;
    out[id] = { p: typeof r.p === 'number' && r.p >= 0 && r.p <= 1 ? r.p : null, vote: r.vote === 1 || r.vote === -1 ? r.vote : null };
  }
  return out;
}

// Stats updates are queued so that concurrent tabs don't overwrite each other's counts.
let statsQueue = Promise.resolve();
function addStats(delta) {
  statsQueue = statsQueue.then(async () => {
    const { stats = {} } = await chrome.storage.local.get('stats');
    const day = stats[today()] || { seen: 0, hidden: 0, scored: 0, cost: 0 };
    for (const k in delta) day[k] += delta[k];
    stats[today()] = day;
    for (const old of Object.keys(stats).sort().slice(0, -30)) delete stats[old];
    await chrome.storage.local.set({ stats });
  }).catch(() => {});
  return statsQueue;
}

async function judge(body, s) {
  const items = cleanItems(body?.items);
  const always = names(s.always), never = names(s.never);
  const results = {}, rest = [];
  for (const it of items) {
    // A list entry can name the author (channel, account, site) or the group it posted in (on Reddit, the user).
    const who = [name(it.author), name(it.group)].filter(Boolean);
    if (who.some(n => never.has(n))) results[it.id] = { p: null, vote: null, rule: 'never' };
    else if (who.some(n => always.has(n))) results[it.id] = { p: null, vote: null, rule: 'always' };
    else rest.push(it);
  }
  let state, meta = { scored: 0, cost: 0 };
  if (rest.length) {
    await statsQueue;
    const { stats = {} } = await chrome.storage.local.get('stats');
    // A server enforces its own cap (FEED_DAILY_CAP) and ignores this field.
    const budget = Math.max(0, s.dailyCap - (stats[today()]?.scored || 0));
    const res = await backend('/api/judge', { items: rest.map(({ author, group, ...it }) => it), budget }, s);
    state = cleanState(res.state);
    Object.assign(results, cleanResults(res.results, rest));
    if (res.meta) meta = res.meta;
  } else {
    state = cleanState(await backend('/api/state', undefined, s));
  }
  if (state.enabled && items.length) {
    const hidden = Object.values(results).filter(r => r.rule === 'never' || (!r.rule && (r.vote ? r.vote < 0 : r.p !== null && r.p < state.threshold))).length;
    await addStats({ seen: items.length, hidden, scored: Number(meta.scored) || 0, cost: Number(meta.cost) || 0 });
  }
  const notice = meta.capped === true ? `Daily limit of ${s.dailyCap} newly scored items reached, so new items are not being filtered. Raise it in settings, or wait until tomorrow.` : undefined;
  return { state: { ...state, signal: s.signal, pages: s.pages }, results, notice };
}

async function exportAll(s) {
  const data = await backend('/api/items', undefined, s);
  const voted = (data.voted || data.items.filter(it => it.vote)).filter(it => it.source !== 'scan');
  return {
    app: 'feed-filter', version: 1, exported_at: new Date().toISOString(),
    keep: data.keep, threshold: data.state.threshold, mode: data.state.mode, block_shorts: data.state.block_shorts,
    signal: s.signal, pages: s.pages, always: s.always, never: s.never, dailyCap: s.dailyCap,
    votes: voted.map(it => ({ id: it.id, source: it.source, text: it.text, url: it.url, vote: it.vote })),
  };
}

// An import file is untrusted: every field is checked, and it can never set the key or a server.
async function importAll(file, s) {
  if (!file || file.app !== 'feed-filter' || file.version !== 1) throw new Error('That is not a Feed filter export file.');
  const changes = {};
  if (typeof file.signal === 'boolean') changes.signal = file.signal;
  for (const list of ['always', 'never']) if (typeof file[list] === 'string') changes[list] = file[list].slice(0, 20000);
  if (Number.isInteger(file.dailyCap) && file.dailyCap >= 0 && file.dailyCap <= 1000000) changes.dailyCap = file.dailyCap;
  if (file.pages && typeof file.pages === 'object') {
    changes.pages = structuredClone(s.pages);
    for (const site in changes.pages) for (const kind in changes.pages[site]) {
      if (typeof file.pages[site]?.[kind] === 'boolean') changes.pages[site][kind] = file.pages[site][kind];
    }
  }
  await chrome.storage.local.set(changes);
  const stateChanges = {};
  if (typeof file.block_shorts === 'boolean') stateChanges.block_shorts = file.block_shorts;
  if (file.mode === 'fast' || file.mode === 'smart') stateChanges.mode = file.mode;
  if (Object.keys(stateChanges).length) await backend('/api/state', stateChanges, s);
  const votes = (Array.isArray(file.votes) ? file.votes : []).slice(0, 5000)
    .filter(v => wellFormed(v) && (v.vote === 1 || v.vote === -1))
    .map(v => ({ id: v.id, source: v.source, text: v.text.slice(0, 600), url: v.url.slice(0, 300), vote: v.vote }));
  if (!s.serverUrl) await importVotes(votes);
  if (typeof file.keep === 'string') await backend('/api/keep', { keep: file.keep, threshold: file.threshold }, s);
  return { votes: s.serverUrl ? 0 : votes.length, skippedVotes: s.serverUrl ? votes.length : (Array.isArray(file.votes) ? file.votes.length : 0) - votes.length };
}

const ext = {
  '/ext/config': (_body, s) => ({ pages: s.pages, signal: s.signal }),
  '/ext/options': () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
  '/ext/clear': () => clear(),
  '/ext/test': (_body, s) => (s.serverUrl ? backend('/api/state', undefined, s).then(() => ({ server: true })) : test()),
  '/ext/export': (_body, s) => exportAll(s),
  '/ext/import': (body, s) => importAll(body, s),
};

async function handle({ path, body }, trusted) {
  if (typeof path !== 'string' || (!trusted && !FROM_PAGES.has(path))) throw new Error('Not allowed.');
  const s = await settings();
  if (path === '/api/judge') return judge(body, s);
  if (path === '/api/vote') {
    if (!ITEM_ID.test(body?.id) || ![1, -1, null].includes(body.vote)) throw new Error('Bad vote.');
    return backend(path, { id: body.id, vote: body.vote }, s);
  }
  if (ext[path]) return ext[path](body, s);
  if (path.startsWith('/api/')) return backend(path, body, s);
  throw new Error('Not found.');
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Trusted means one of this extension's own pages (settings, popup), not a content script.
  const trusted = sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  handle(msg || {}, trusted)
    .then(async result => {
      if (msg.path === '/api/judge' && Object.keys(result.results).length) {
        chrome.action.setBadgeText({ text: '' });
        if ((await chrome.storage.local.get('lastError')).lastError) await chrome.storage.local.remove('lastError');
      }
      reply(result);
    })
    .catch(async e => {
      const message = String(e?.message || 'Something went wrong.');
      if (msg?.path === '/api/judge') {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#c9736b' });
        await chrome.storage.local.set({ lastError: { message, at: Date.now() } });
      }
      reply({ error: message });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });
