// Second half of the end-to-end run: X, import/export, trust boundaries, a hostile server, popup, live site.
import http from 'node:http';
import { mock, calls, store, setStore, settled, tile, isolated } from './harness.mjs';

const { t, ctx, sw, close, options, popup, api, noticeText, badge, clearHistory, errors, KEY, YT } = globalThis.__shared;
const opt = ctx.pages().find(p => p.url() === options);
const yt = ctx.pages().find(p => p.url().startsWith(YT));

try {
  // ---------------------------------------------------------------- X
  t.section('X timeline');
  await setStore(sw, { threshold: 0.5 }); // the refine test above moved it
  await clearHistory();
  const xStart = (await calls(sw)).length;
  const x = await ctx.newPage();
  await x.goto('https://x.com/home');
  await settled(x);
  const xc = (await calls(sw)).slice(xStart);
  t.check('good post kept, bait post veiled', (await tile(x, 'x:101'))?.state === 'keep' && (await tile(x, 'x:102'))?.veiled, [await tile(x, 'x:101'), await tile(x, 'x:102'), await noticeText(x), xc.map(c => c.text.slice(0, 30))]);
  t.check('protected post is never read or sent', (await tile(x, 'x:103')) === null && !xc.some(c => c.text.includes('family')));
  t.check('newer bare layout is handled', (await tile(x, 'x:104'))?.veiled === true && xc.some(c => c.text.startsWith('@newlayout:')), await tile(x, 'x:104'));
  t.check('a quoted post is not judged separately', (await tile(x, 'x:999')) === null && !xc.some(c => c.text.startsWith('@other')) && (await tile(x, 'x:105')).state === 'keep');
  t.check('never-keep works on handles', (await tile(x, 'x:106')).veiled && /never-keep/.test((await tile(x, 'x:106')).label));
  t.check('always-keep works on handles', (await tile(x, 'x:107')).state === 'keep' && !xc.some(c => /NeverGuy|alwaysgal/.test(c.text)));
  await x.click('[data-ff-id="x:101"] .ff-down', { force: true });
  await x.waitForTimeout(900);
  t.check('downvote on X picks Not interested, not Mute or Block', (await x.evaluate(() => [window.__notInterested.join(), window.__wrongMenu])).join() === '101,', await x.evaluate(() => [window.__notInterested, window.__wrongMenu]));
  await x.goto('https://x.com/someone/status/55');
  await x.waitForTimeout(1200);
  t.check('threads, profiles and notifications are left alone by default', await x.evaluate(() => !document.querySelector('[data-ff]')));
  await setStore(sw, { signal: false });
  await x.goto('https://x.com/home'); await settled(x);
  await x.click('[data-ff-id="x:105"] .ff-down', { force: true });
  await x.waitForTimeout(900);
  t.check('with the signal switched off a downvote stays local', (await x.evaluate(() => window.__notInterested.length)) === 0 && (await store(sw, 'i:x:105'))['i:x:105'].vote === -1);
  await setStore(sw, { signal: true });
  await x.close();

  // ---------------------------------------------------------------- export / import
  t.section('export and import');
  await opt.bringToFront(); await opt.reload(); await opt.waitForSelector('#list .item');
  const [download] = await Promise.all([opt.waitForEvent('download', { timeout: 8000 }), opt.click('#export')]);
  const exported = JSON.parse(await (await import('node:fs')).promises.readFile(await download.path(), 'utf8'));
  const raw = JSON.stringify(exported);
  t.check('export holds criteria, settings and votes', exported.app === 'feed-filter' && exported.keep.includes('new AI research') && exported.never.includes('HypeDaily') && exported.votes.length >= 1 && exported.pages.youtube.search === false, Object.keys(exported));
  t.check('export never contains the key or a server address', !raw.includes(KEY) && !raw.includes('apiKey') && !raw.includes('serverUrl'));
  // wipe everything but the key, then bring it back from the file
  const all = await store(sw);
  await sw.evaluate(keys => chrome.storage.local.remove(keys), Object.keys(all).filter(k => k !== 'apiKey'));
  await opt.reload(); await opt.waitForTimeout(600);
  await opt.setInputFiles('#importFile', { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await opt.waitForFunction(() => /Imported/.test(document.getElementById('cal').textContent), null, { timeout: 8000 }).catch(() => {});
  const back = await store(sw);
  t.check('import restores criteria, lists, pages and votes', back.keep.includes('new AI research') && back.never.includes('HypeDaily') && back.pages.youtube.search === false && Object.keys(back).filter(k => k.startsWith('i:') && back[k].vote).length === exported.votes.length, [await opt.textContent('#cal'), await opt.textContent('#status')]);
  const hostile = {
    app: 'feed-filter', version: 1, apiKey: 'sk-or-STOLEN', serverUrl: 'https://evil.example', lastError: { message: '<img>' }, stats: {}, enabled: 'yes',
    signal: 'no', always: 5, never: ['x'], dailyCap: -5, pages: { youtube: { home: 'x', evil: true }, evil: { home: true }, __proto__: { polluted: true } }, mode: 'evil', threshold: 99,
    keep: 'A perfectly reasonable set of criteria that is long enough to pass.',
    votes: [
      { id: 'yt:ok1', source: 'youtube', text: 'fine', url: 'https://www.youtube.com/watch?v=ok1', vote: 1 },
      { id: 'yt:bad1', source: 'youtube', text: 'js', url: 'javascript:alert(1)', vote: 1 },
      { id: 'yt:bad2', source: 'youtube', text: 'elsewhere', url: 'https://evil.example/', vote: 1 },
      { id: '../../x', source: 'youtube', text: 'id', url: 'https://www.youtube.com/', vote: 1 },
      { id: 'yt:bad3', source: 'scan', text: 'src', url: 'https://www.youtube.com/', vote: 1 },
      { id: 'yt:bad4', source: 'youtube', text: 'vote', url: 'https://www.youtube.com/', vote: 'up' },
      { id: 'yt:bad5', source: 'youtube', text: 7, url: 'https://www.youtube.com/', vote: 1 },
      null, 'string', 42,
    ],
  };
  await opt.setInputFiles('#importFile', { name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) });
  await opt.waitForFunction(() => /Imported/.test(document.getElementById('cal').textContent) && /skipped/.test(document.getElementById('cal').textContent), null, { timeout: 8000 }).catch(() => {});
  const after = await store(sw);
  t.check('a hostile import cannot set the key or a server', after.apiKey === KEY && after.serverUrl === undefined);
  t.check('a hostile import cannot plant bad votes or links', after['i:yt:ok1']?.vote === 1 && !Object.keys(after).some(k => /bad\d|\.\./.test(k)), Object.keys(after).filter(k => k.startsWith('i:')).slice(0, 12));
  t.check('a hostile import cannot store junk settings', typeof after.always === 'string' && typeof after.never === 'string' && after.dailyCap === 100000 && after.signal === true && after.mode !== 'evil' && after.threshold !== 99 && !after.pages.evil && after.pages.youtube.evil === undefined && after.pages.youtube.home === true && ({}).polluted === undefined, { always: after.always, never: after.never, dailyCap: after.dailyCap, signal: after.signal, mode: after.mode, threshold: after.threshold, pages: after.pages });
  t.check('settings page still renders after a hostile import', await opt.evaluate(() => !document.querySelector('#list img') && document.getElementById('status').textContent === ''), await opt.textContent('#status'));
  const tryImport = async (name, content, pattern, label) => {
    await opt.setInputFiles('#importFile', { name, mimeType: 'application/json', buffer: Buffer.from(content) });
    await opt.waitForTimeout(500);
    t.check(label, pattern.test(await opt.textContent('#status')), await opt.textContent('#status'));
  };
  await tryImport('junk.json', '{not json', /not valid JSON/, 'a non-JSON import is refused');
  await tryImport('other.json', '{"app":"something-else","version":1}', /not a Feed filter export/, 'a foreign file is refused');
  await tryImport('null.json', 'null', /not a Feed filter export/, 'a null import is refused');
  await tryImport('big.json', 'x'.repeat(5_100_000), /too large/, 'an oversized import is refused');
  await tryImport('shortkeep.json', '{"app":"feed-filter","version":1,"keep":"hi"}', /between 20 and 4000/, 'an import with unusable criteria is refused');

  // ---------------------------------------------------------------- what a web page can reach
  t.section('trust boundary');
  await yt.bringToFront(); await yt.goto(YT); await settled(yt);
  t.check('page scripts cannot see or message the extension', await yt.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage));
  const iso = expr => isolated(ctx, yt, expr);
  const grab = await iso(`chrome.storage.local.get(null).then(v => Object.keys(v), e => 'blocked: ' + e.message)`);
  t.check('a content script cannot read extension storage (so not the key)', typeof grab === 'string' ? grab.startsWith('blocked') : !!grab?.threw, grab);
  const put = await iso(`chrome.storage.local.set({ serverUrl: 'https://evil.example' }).then(() => 'written', e => 'blocked: ' + e.message)`);
  t.check('a content script cannot write extension storage', (typeof put === 'string' ? put.startsWith('blocked') : !!put?.threw) && (await store(sw, 'serverUrl')).serverUrl === undefined, put);
  for (const [path, body] of [['/api/keep', { keep: 'x'.repeat(60) }], ['/ext/clear', {}], ['/api/items'], ['/ext/export'], ['/api/state', { enabled: false }], ['/api/state'], ['/api/refine', {}], ['/ext/import', { app: 'feed-filter', version: 1 }], ['/ext/test'], ['/nope'], [null], [{ a: 1 }]]) {
    const res = await iso(`chrome.runtime.sendMessage(${JSON.stringify({ path, body })})`);
    t.check(`a content script may not call ${JSON.stringify(path)}`, res?.error === 'Not allowed.', res);
  }
  t.check('settings untouched by refused calls', (await store(sw, 'enabled')).enabled !== false && (await store(sw, 'keep')).keep.includes('perfectly reasonable'));
  const flood = (await calls(sw)).length;
  const many = Array.from({ length: 500 }, (_, i) => ({ id: 'yt:flood' + i, source: 'youtube', text: 'flood ' + i, url: 'https://www.youtube.com/watch?v=flood' + i }));
  const floodRes = await iso(`chrome.runtime.sendMessage(${JSON.stringify({ path: '/api/judge', body: { items: many } })}).then(r => Object.keys(r.results || {}).length)`);
  t.check('a flood of items in one message is capped', floodRes === 60 && (await calls(sw)).length - flood === 60, [floodRes, (await calls(sw)).length - flood]);
  const weird = await iso(`chrome.runtime.sendMessage({ path: '/api/judge', body: { items: [{ id: 'yt:w1', source: 'youtube', text: 'x', url: 'javascript:alert(1)' }, { id: 'yt:w2', source: 'x', text: {}, url: 'https://x.com/a' }, { id: 'nope', source: 'youtube', text: 'x', url: 'https://www.youtube.com/' }, null, 5] } }).then(r => Object.keys(r.results))`);
  t.check('malformed items from a page are dropped', Array.isArray(weird) && weird.length === 0, weird);
  for (const body of [{ items: 'abc' }, { items: null }, null, 'x', { items: { length: 5 } }]) {
    const res = await iso(`chrome.runtime.sendMessage(${JSON.stringify({ path: '/api/judge', body })}).then(r => r.state ? 'ok' : r.error)`);
    t.check(`a malformed judge body ${JSON.stringify(body)} is survived`, res === 'ok', res);
  }
  for (const vote of [5, '1', true, { a: 1 }]) {
    const res = await iso(`chrome.runtime.sendMessage(${JSON.stringify({ path: '/api/vote', body: { id: 'yt:v3', vote } })})`);
    t.check(`a vote of ${JSON.stringify(vote)} is refused`, res?.error === 'Bad vote.', res);
  }
  t.check('a vote for a made-up id is refused', (await iso(`chrome.runtime.sendMessage({ path: '/api/vote', body: { id: '<img>', vote: 1 } })`))?.error === 'Bad vote.');
  t.check('service worker survived all of that', (await iso(`chrome.runtime.sendMessage({ path: '/ext/config' }).then(r => typeof r.signal)`)) === 'boolean');

  // ---------------------------------------------------------------- a hostile or broken server
  t.section('custom server');
  let reply = () => ({});
  const seen = [];
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: data });
      const out = reply(req.url, data ? JSON.parse(data) : null);
      res.setHeader('Content-Type', 'application/json');
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const serverUrl = `http://127.0.0.1:${srv.address().port}`;
  await setStore(sw, { serverUrl });
  const viaServer = async (fn, label, expect) => {
    reply = fn;
    await yt.goto(YT);
    await settled(yt, 12000).catch(() => {});
    const stuck = await yt.evaluate(() => !!document.querySelector('[data-ff="pending"]'));
    const v8 = await tile(yt, 'yt:v8');
    t.check(`${label}: nothing stuck on checking`, !stuck);
    t.check(`${label}: ${expect.name}`, expect(v8, await noticeText(yt)), [v8, await noticeText(yt)]);
  };
  const unfiltered = (v, n) => v?.state === '' && !v.veiled && !!n;
  await viaServer(() => ({}), 'empty reply', unfiltered);
  await viaServer(() => 'null', 'null reply', unfiltered);
  await viaServer(() => '<html>not json</html>', 'non-JSON reply', unfiltered);
  await viaServer(() => ({ error: 'E'.repeat(5000) }), 'error reply', (v, n) => unfiltered(v, n) && n.length < 400);
  await viaServer(() => ({ state: 'x', results: [] }), 'wrong types', unfiltered);
  await viaServer((_p, body) => ({ state: { enabled: true, mode: 'fast', threshold: 'x', block_shorts: 1, pages: null, signal: 'x' }, results: Object.fromEntries((body?.items || []).map(i => [i.id, { p: '<img src=x onerror=1>', vote: 'x', rule: 'never' }])) }),
    'hostile fields', function unfilteredWithoutError(v, n) { return v?.state === '' && !v.veiled && n === null; });
  await viaServer((_p, body) => ({ state: { enabled: true, mode: 'fast', threshold: 0.5, block_shorts: true }, results: Object.fromEntries((body?.items || []).map(i => [i.id, { p: 9, vote: null }])), meta: { scored: 'x', cost: {} } }),
    'out-of-range scores', function unfilteredWithoutError(v, n) { return v?.state === '' && n === null; });
  await viaServer((p, body) => p === '/api/judge' ? ({ state: { enabled: true, mode: 'fast', threshold: 0.5, block_shorts: true }, results: Object.fromEntries(body.items.map(i => [i.id, { p: /DRAMA|CRAZIEST/.test(i.text) ? 0.1 : 0.9, vote: null }])) }) : ({ enabled: true, mode: 'fast', threshold: 0.5, block_shorts: true }),
    'well-behaved server', function filtered(v, n) { return v?.veiled === true && n === null; });
  t.check('the key is never sent to a custom server', !seen.some(s => JSON.stringify(s).includes(KEY)) && !seen.some(s => s.headers.authorization));
  t.check('lists still apply in front of a server', !seen.some(s => /HypeDaily|Hustle Hub/.test(s.body)));
  t.check('stats survive junk from a server', Number.isFinite((await store(sw, 'stats')).stats[new Date().toLocaleDateString('en-CA')].cost));
  srv.close();
  await viaServer(() => ({}), 'server down', (v, n) => unfiltered(v, n) && /Could not reach your judge server at 127\.0\.0\.1/.test(n));
  await sw.evaluate(() => chrome.storage.local.remove('serverUrl'));

  // ---------------------------------------------------------------- popup
  t.section('popup');
  const pop = await ctx.newPage();
  await pop.goto(popup);
  await pop.waitForTimeout(400);
  t.check('popup reflects the state', await pop.isChecked('#enabled') && await pop.isChecked('input[value=fast]'));
  await pop.uncheck('#enabled');
  await pop.waitForTimeout(400);
  t.check('popup can switch the filter off', (await store(sw, 'enabled')).enabled === false);
  await yt.bringToFront();
  await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.sendMessage(tab.id, { type: 'ff-refresh' }); });
  await settled(yt);
  t.check('switching off clears veils without a reload', await yt.evaluate(() => !document.querySelector('[data-ff="hide"]') && getComputedStyle(document.querySelector('ytd-ad-slot-renderer')).display !== 'none'));
  await pop.bringToFront(); await pop.check('#enabled'); await pop.waitForTimeout(400);
  await yt.bringToFront();
  await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.sendMessage(tab.id, { type: 'ff-refresh' }); });
  await settled(yt);
  t.check('switching back on restores them', (await tile(yt, 'yt:v8'))?.veiled === true);
  await pop.close();

  // ---------------------------------------------------------------- storage stays bounded
  t.section('storage');
  await sw.evaluate(() => { const o = {}; for (let i = 0; i < 4300; i++) o['i:yt:old' + i] = { source: 'youtube', text: 't' + i, url: 'https://www.youtube.com/watch?v=old' + i, seen_at: i, ...(i < 5 ? { vote: 1 } : {}) }; return chrome.storage.local.set(o); });
  await opt.bringToFront(); await opt.reload(); await opt.waitForTimeout(1500);
  const left = Object.keys(await store(sw)).filter(k => k.startsWith('i:'));
  t.check('old unvoted history is pruned, votes are kept', left.length <= 4010 && ['old0', 'old4'].every(k => left.includes('i:yt:' + k)) && !left.includes('i:yt:old10'), left.length);
  await opt.click('#clear'); await opt.waitForTimeout(600);
  t.check('clear history empties it', Object.keys(await store(sw)).filter(k => k.startsWith('i:')).length === 0 && (await store(sw, 'apiKey')).apiKey === KEY);

  // ---------------------------------------------------------------- the real site (needs network)
  if (process.env.LIVE) {
    t.section('live youtube.com');
    await ctx.unroute('https://www.youtube.com/**');
    await setStore(sw, { pages: { youtube: { home: true, search: true, watch: true, subscriptions: false, other: false }, x: { home: true, search: true, other: false } }, always: '', never: '' });
    await mock(sw, { scores: { the: 0.9, a: 0.1 } });
    const live = await ctx.newPage();
    try {
      await live.goto('https://www.youtube.com/results?search_query=fourier+transform+explained', { timeout: 30000 });
      await live.waitForSelector('ytd-video-renderer', { timeout: 20000 });
      await settled(live, 15000);
      const got = await live.evaluate(() => ({ judged: document.querySelectorAll('[data-ff="keep"], [data-ff="hide"]').length, tiles: document.querySelectorAll('ytd-video-renderer').length, authors: [...document.querySelectorAll('[data-ff-id]')].length }));
      t.check('live search page: most result tiles are judged', got.judged >= 5 && got.judged >= got.tiles * 0.7, got);
      const texts = (await calls(sw)).slice(-got.judged).map(c => c.text);
      t.check('live search page: title and channel are both read', texts.filter(x => / — \S/.test(x)).length >= texts.length * 0.8, texts.slice(0, 4));
      const hidden = await live.evaluate(() => { const el = document.querySelector('[data-ff="hide"]'); if (!el) return null; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 60, r.top + 40); return hit?.className; });
      t.check('live search page: a hidden tile is really covered', hidden === null || hidden === 'ff-veil', hidden);
      await live.mouse.move(300, 300); await live.mouse.move(320, 340); await live.waitForTimeout(1500);
      t.check('live search page: veils survive hovering', await live.evaluate(() => [...document.querySelectorAll('[data-ff="hide"]')].every(el => getComputedStyle(el.querySelector(':scope > .ff-veil')).display !== 'none')));
    } catch (e) {
      console.log('NOTE  live youtube.com check could not run:', e.message.split('\n')[0]);
    }
    await live.close();
  }
} catch (e) {
  t.check('test run completed without crashing', false, e.stack);
}
try { await (await import('./e2e-sites.mjs')).run(globalThis.__shared); } catch (e) { t.check('site tests completed without crashing', false, e.stack); }
t.check('no uncaught errors in any extension page or the service worker', errors.length === 0, errors.slice(0, 5));
await close();
process.exit(t.done() ? 1 : 0);
