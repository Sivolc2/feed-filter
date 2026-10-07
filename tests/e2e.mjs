// End-to-end tests: the real extension in Chromium against fixture pages and a faked scoring API.
//   node e2e.mjs            (VERBOSE=1 for section names, LIVE=1 to also try the real youtube.com)
import http from 'node:http';
import { launch, mock, calls, store, setStore, settled, tile, isolated, reporter, SCORES } from './harness.mjs';

const t = reporter('extension');
const { ctx, sw, id, close, options, popup } = await launch();
const KEY = 'sk-or-test-KEY-123';
const YT = 'https://www.youtube.com/';
const api = (page, path, body) => page.evaluate(([path, body]) => chrome.runtime.sendMessage({ path, body }), [path, body]);
const noticeText = page => page.evaluate(() => document.getElementById('ff-notice')?.querySelector('span')?.textContent || null);
const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
const clearHistory = async () => { const all = await store(sw); await sw.evaluate(keys => chrome.storage.local.remove(keys), Object.keys(all).filter(k => k.startsWith('i:'))); };
const errors = [];
ctx.on('page', p => { p.on('pageerror', e => errors.push(`${p.url()}: ${e.message}`)); });
sw.on('console', m => { if (m.type() === 'error') errors.push('sw: ' + m.text()); });

try {
  // ---------------------------------------------------------------- install, no key yet
  t.section('first run without a key');
  await ctx.waitForEvent('page', { timeout: 5000 }).catch(() => {});
  const opt = ctx.pages().find(p => p.url() === options) || await ctx.newPage();
  t.check('settings page opens on install', ctx.pages().some(p => p.url() === options));
  if (opt.url() !== options) await opt.goto(options);
  const yt = await ctx.newPage();
  await yt.goto(YT);
  await settled(yt);
  t.check('without a key nothing is veiled', (await tile(yt, 'yt:v2'))?.veiled === false, await tile(yt, 'yt:v2'));
  t.check('without a key a notice says why', /Add your OpenRouter key/.test(await noticeText(yt)), await noticeText(yt));
  t.check('without a key nothing is sent anywhere', (await calls(sw)).length === 0);
  t.check('toolbar badge flags the problem', await badge() === '!');
  const [opened] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), yt.click('#ff-notice button:has-text("Settings")')]);
  t.check('notice opens the settings page', !!opened || ctx.pages().filter(p => p.url() === options).length >= 1);
  if (opened && opened !== opt) await opened.close();
  await yt.bringToFront();
  await yt.click('#ff-notice button[aria-label="Dismiss"]');
  await yt.evaluate(() => window.__more(2));
  await settled(yt);
  t.check('a dismissed notice stays dismissed', await noticeText(yt) === null);

  // ---------------------------------------------------------------- key entry
  t.section('key entry');
  await opt.bringToFront();
  await opt.fill('#apiKey', KEY);
  await opt.click('#saveKey');
  await opt.waitForTimeout(400);
  t.check('key is stored', (await store(sw, 'apiKey')).apiKey === KEY);
  t.check('key is never shown back', !(await opt.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input,textarea')].map(i => i.value).join())).includes(KEY));
  await opt.click('#test');
  await opt.waitForFunction(() => /Working/.test(document.getElementById('keyMsg').textContent), null, { timeout: 5000 }).catch(() => {});
  t.check('test button reports a score', /Working.*0\.91/.test(await opt.textContent('#keyMsg')), await opt.textContent('#keyMsg'));

  // ---------------------------------------------------------------- filtering on the feed
  t.section('filtering');
  await yt.bringToFront();
  await yt.goto(YT);
  await settled(yt);
  const expectKeep = ['v1', 'v3', 'v5', 'v7', 'v9', 'v11'], expectHide = ['v2', 'v4', 'v6', 'v8', 'v10', 'v12'];
  for (const v of expectKeep) t.check(`${v} is kept`, (await tile(yt, 'yt:' + v))?.state === 'keep' && !(await tile(yt, 'yt:' + v)).veiled, await tile(yt, 'yt:' + v));
  for (const v of expectHide) t.check(`${v} is veiled`, (await tile(yt, 'yt:' + v))?.state === 'hide' && (await tile(yt, 'yt:' + v)).veiled, await tile(yt, 'yt:' + v));
  t.check('veil shows the score', /filtered · 0\.05/.test((await tile(yt, 'yt:v2')).label), (await tile(yt, 'yt:v2')).label);
  t.check('the veil is what you hit when you click a hidden tile', await yt.evaluate(() => {
    const el = document.querySelector('[data-ff-id="yt:v2"]'); const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3)?.className === 'ff-veil';
  }));
  t.check('Shorts tile is veiled with no vote badge', (await tile(yt, 'yt:s1'))?.veiled && !(await tile(yt, 'yt:s1')).badge, await tile(yt, 'yt:s1'));
  t.check('Shorts are never sent to the judge', !(await calls(sw)).some(c => c.text?.includes('A short')));
  t.check('Shorts shelf is hidden', await yt.evaluate(() => getComputedStyle(document.querySelector('ytd-rich-shelf-renderer')).display === 'none'));
  t.check('ad slot is hidden', await yt.evaluate(() => getComputedStyle(document.querySelector('ytd-ad-slot-renderer')).display === 'none'));
  t.check('markup in a title is not executed on the feed', await yt.evaluate(() => window.__xss === undefined && !document.querySelector('.ff-veil img, .ff-badge img')));
  t.check('tile with a malformed id is left alone', await yt.evaluate(() => [...document.querySelectorAll('ytd-rich-item-renderer')].find(e => e.textContent.includes('malformed id')).dataset.ff) === '');
  t.check('tile with a javascript: link is ignored', await yt.evaluate(() => [...document.querySelectorAll('ytd-rich-item-renderer')].find(e => e.textContent.includes('javascript link')).dataset.ff) === undefined);
  const sent = await calls(sw);
  t.check('every call goes to openrouter.ai with the key', sent.length > 0 && sent.every(c => c.url.startsWith('https://openrouter.ai/api/') && c.auth === 'Bearer ' + KEY));
  t.check('the key is not in any page', !(await yt.evaluate(() => document.documentElement.outerHTML)).includes(KEY));
  t.check('badge cleared once filtering works', await badge() === '');

  t.section('peek and votes');
  await yt.click('[data-ff-id="yt:v2"] > .ff-veil');
  t.check('click on a veil peeks', (await tile(yt, 'yt:v2')).veiled === false);
  t.check('the peek click does not open the video', !(await yt.evaluate(() => window.__navigated)).includes('v2'));
  await yt.click('[data-ff-id="yt:v1"] .ff-down', { force: true });
  await yt.waitForTimeout(900);
  t.check('downvote is stored', (await store(sw, 'i:yt:v1'))['i:yt:v1']?.vote === -1, await store(sw, 'i:yt:v1'));
  t.check('downvote tells the site Not interested', (await yt.evaluate(() => window.__notInterested)).join() === 'v1', await yt.evaluate(() => window.__notInterested));
  t.check('downvote picked the right menu entry', await yt.evaluate(() => window.__blockedChannel === undefined && !document.querySelector('[role=menu]')));
  await yt.click('[data-ff-id="yt:v4"] .ff-up', { force: true });
  await yt.waitForTimeout(300);
  const v4 = await tile(yt, 'yt:v4');
  t.check('upvote reveals the tile and lights the button', v4.state === 'keep' && v4.vote === 'up' && !v4.veiled, v4);
  t.check('upvote sends no signal to the site', (await yt.evaluate(() => window.__notInterested)).join() === 'v1');
  t.check('upvote is stored', (await store(sw, 'i:yt:v4'))['i:yt:v4']?.vote === 1);
  await yt.evaluate(() => window.__forge());
  await yt.waitForTimeout(500);
  t.check('page scripts cannot forge votes', (await store(sw, 'i:yt:v3'))['i:yt:v3']?.vote === undefined && (await store(sw, 'i:yt:v6'))['i:yt:v6']?.vote === undefined);
  t.check('page scripts cannot peek or trigger signals', (await tile(yt, 'yt:v6')).veiled && (await yt.evaluate(() => window.__notInterested)).join() === 'v1');

  t.section('what the live sites do to tiles');
  await yt.evaluate(() => window.__more(4));
  await settled(yt);
  t.check('late-loaded tiles are judged', (await tile(yt, 'yt:late0'))?.state === 'hide' && (await tile(yt, 'yt:late3'))?.state === 'hide');
  await yt.evaluate(() => window.__rerender('v6'));
  await yt.waitForTimeout(500);
  t.check('a re-rendered tile gets its veil back', (await tile(yt, 'yt:v6'))?.veiled === true, await tile(yt, 'yt:v6'));
  await yt.evaluate(() => window.__reuse('v8', ['v99', 'Brand new GOOD video', 'GridMath']));
  await settled(yt);
  t.check('a tile reused for another video is judged afresh', (await tile(yt, 'yt:v99'))?.state === 'keep' && (await tile(yt, 'yt:v8')) === null, await tile(yt, 'yt:v99'));
  // A tile recycled while its verdict is still on the way must not leave that video stuck on "checking".
  await mock(sw, { delay: 900 });
  await yt.evaluate(() => { window.__more(1); });
  await yt.evaluate(() => { const g = document.getElementById('grid'); const el = document.createElement('ytd-rich-item-renderer'); el.id = 'racer'; g.append(el); });
  await yt.evaluate(() => { const el = document.getElementById('racer'); const a = document.createElement('a'); a.href = '/watch?v=race1'; const h = document.createElement('h3'); h.textContent = 'Racing GOOD tile'; el.append(a, h); });
  await yt.waitForTimeout(500);
  await yt.evaluate(() => { const el = document.getElementById('racer'); el.querySelector('a').href = '/watch?v=race2'; el.querySelector('h3').textContent = 'Second BAD occupant'; });
  await mock(sw, { delay: 0 });
  await settled(yt, 12000);
  await yt.evaluate(() => { const el = document.createElement('ytd-rich-item-renderer'); const a = document.createElement('a'); a.href = '/watch?v=race1'; const h = document.createElement('h3'); h.textContent = 'Racing GOOD tile'; el.append(a, h); document.getElementById('grid').append(el); });
  await settled(yt);
  t.check('a video whose tile was recycled mid-check is not stuck', (await tile(yt, 'yt:race1'))?.state === 'keep' && (await tile(yt, 'yt:race2'))?.state === 'hide', [await tile(yt, 'yt:race1'), await tile(yt, 'yt:race2')]);

  // The same video in two tiles at once (a result and a playlist card on the live site).
  await mock(sw, { delay: 600 });
  await yt.evaluate(() => { window.__more(1); const g = document.getElementById('grid'); const mk = () => { const el = document.createElement('ytd-rich-item-renderer'); const a = document.createElement('a'); a.href = '/watch?v=twin'; const h = document.createElement('h3'); h.textContent = 'Twin BAD video'; el.append(a, h); el.className = 'twin'; g.append(el); }; mk(); mk(); });
  await mock(sw, { delay: 0 });
  await settled(yt, 12000);
  t.check('a video shown in two tiles is veiled in both', await yt.evaluate(() => [...document.querySelectorAll('.twin')].map(e => e.dataset.ff).join()) === 'hide,hide', await yt.evaluate(() => [...document.querySelectorAll('.twin')].map(e => e.dataset.ff)));
  await yt.click('.twin >> nth=0 >> .ff-veil');
  t.check('peeking one copy reveals the other too', await yt.evaluate(() => [...document.querySelectorAll('.twin')].map(e => e.dataset.ff).join()) === 'keep,keep');

  const before = (await calls(sw)).length;
  await yt.goto(YT);
  await settled(yt);
  t.check('a reload is served from cache, no new calls', (await calls(sw)).length === before, [(await calls(sw)).length, before]);
  t.check('votes survive a reload', (await tile(yt, 'yt:v4')).vote === 'up' && (await tile(yt, 'yt:v1')).state === 'hide' && /downvoted/.test((await tile(yt, 'yt:v1')).label));
  t.check('a peek does not survive a reload', (await tile(yt, 'yt:v2')).veiled === true);

  // ---------------------------------------------------------------- settings page
  t.section('settings page');
  await opt.bringToFront();
  await opt.reload();
  await opt.waitForSelector('#list .item');
  t.check('history lists scored items', (await opt.locator('#list .item').count()) >= 12);
  t.check('markup in a title is shown as text, never run', await opt.evaluate(() => window.__xss === undefined && !document.querySelector('#list img, #list script, #list b') && document.getElementById('list').textContent.includes('<img src=x')));
  t.check('history links only point at the web', await opt.evaluate(() => [...document.querySelectorAll('#list a')].every(a => !a.getAttribute('href') || a.href.startsWith('https://'))));
  t.check('calibration counts the votes', /2 votes/.test(await opt.textContent('#cal')), await opt.textContent('#cal'));
  t.check('usage stats are shown with a cost', /Today: \d+ items seen, \d+% filtered, \d+ newly scored, \$0\.\d{4}/.test(await opt.textContent('#stats')), await opt.textContent('#stats'));
  await opt.click('#refine');
  await opt.waitForTimeout(500);
  t.check('refine refuses with too few votes', /at least 6/.test(await opt.textContent('#status')), await opt.textContent('#status'));
  await opt.fill('#keep', 'my half-written criteria that I have not saved yet');
  for (let i = 0; i < 5; i++) {
    const lit = await opt.locator('#list .votes button.on').count();
    await opt.locator('#list .item:not(:has(button.on)) .votes button.up').first().click();
    await opt.waitForFunction(n => document.querySelectorAll('#list .votes button.on').length > n, lit, { timeout: 4000 });
  }
  t.check('voting does not wipe unsaved criteria', await opt.inputValue('#keep') === 'my half-written criteria that I have not saved yet');
  await opt.reload(); await opt.waitForSelector('#list .item');
  await opt.click('#refine');
  await opt.waitForSelector('#proposal', { state: 'visible', timeout: 8000 }).catch(() => {});
  t.check('refine shows a proposal with before and after', /agreement on your 7 votes/.test(await opt.textContent('#propStats')), await opt.textContent('#propStats'));
  const keepBefore = (await store(sw, 'keep')).keep;
  t.check('a proposal changes nothing until applied', keepBefore === undefined || !keepBefore.includes('WANTS GOOD things'));
  await opt.click('#apply');
  await opt.waitForTimeout(1200);
  t.check('applying a proposal saves it', (await store(sw, 'keep')).keep.includes('WANTS GOOD things'));
  await opt.click('#presets button:has-text("AI builder")');
  t.check('a preset fills the box without saving', (await opt.inputValue('#keep')).includes('new AI research') && !(await store(sw, 'keep')).keep.includes('new AI research'));
  await opt.click('#saveKeep');
  await opt.waitForTimeout(1200);
  t.check('saving a preset stores it and rescoring happens', (await store(sw, 'keep')).keep.includes('new AI research') && (await opt.locator('#list .item').count()) >= 12);
  await opt.fill('#keep', 'short');
  await opt.click('#saveKeep');
  await opt.waitForTimeout(400);
  t.check('criteria that are too short are refused', /between 20 and 4000/.test(await opt.textContent('#status')) && (await store(sw, 'keep')).keep.includes('new AI research'));

  // ---------------------------------------------------------------- always / never lists
  t.section('lists');
  await opt.fill('#never', '  HypeDaily \n@NeverGuy');
  await opt.fill('#always', 'hustle hub\n@AlwaysGal\n');
  await opt.click('#saveLists');
  await opt.waitForTimeout(300);
  await clearHistory();
  const listStart = (await calls(sw)).length;
  await yt.bringToFront();
  await yt.goto(YT);
  await settled(yt);
  t.check('never-keep source is veiled', (await tile(yt, 'yt:v2')).veiled && /never-keep/.test((await tile(yt, 'yt:v2')).label) && (await tile(yt, 'yt:v10')).veiled);
  t.check('always-keep source is shown despite a low score', (await tile(yt, 'yt:v6')).state === 'keep' && (await tile(yt, 'yt:v12')).state === 'keep');
  t.check('listed sources are not sent to the judge', !(await calls(sw)).slice(listStart).some(c => /HypeDaily|Hustle Hub/.test(c.text)));
  t.check('unlisted sources are still judged', (await tile(yt, 'yt:v8')).state === 'hide' && (await tile(yt, 'yt:v3')).state === 'keep');

  // ---------------------------------------------------------------- per-page switches
  t.section('pages');
  await yt.goto(YT + 'feed/subscriptions');
  await yt.waitForTimeout(1200);
  t.check('subscriptions page is left alone by default', await yt.evaluate(() => !document.querySelector('[data-ff]') && getComputedStyle(document.querySelector('ytd-ad-slot-renderer')).display !== 'none'));
  await yt.goto(YT + 'feed/history');
  await yt.waitForTimeout(1200);
  t.check('history and other private pages are left alone by default', await yt.evaluate(() => !document.querySelector('[data-ff]')));
  await yt.evaluate(() => window.__go('/'));
  await settled(yt);
  t.check('moving to the home feed without a reload starts filtering', (await tile(yt, 'yt:v8'))?.veiled === true);
  await yt.evaluate(() => window.__go('/feed/library'));
  await yt.waitForTimeout(600);
  t.check('moving off the feed without a reload removes the veils', await yt.evaluate(() => !document.querySelector('[data-ff]') && !document.documentElement.classList.contains('ff-on')));
  await opt.bringToFront();
  await opt.locator('#pages-youtube label:has-text("Search results") input').uncheck();
  await opt.waitForTimeout(200);
  await yt.bringToFront();
  await yt.goto(YT + 'results?search_query=x');
  await yt.waitForTimeout(1200);
  t.check('a page kind can be switched off', await yt.evaluate(() => !document.querySelector('[data-ff]')));
  await yt.goto(YT + 'watch?v=abc');
  await settled(yt);
  t.check('other page kinds stay on', (await tile(yt, 'yt:v8'))?.veiled === true);

  // ---------------------------------------------------------------- daily cap
  t.section('daily cap');
  const day = new Date().toLocaleDateString('en-CA');
  const scoredToday = (await store(sw, 'stats')).stats[day].scored;
  await setStore(sw, { dailyCap: scoredToday });
  await yt.goto(YT);
  await settled(yt);
  await yt.evaluate(() => window.__more(3));
  await settled(yt);
  t.check('past the daily cap new items are not scored and a notice says so', /Daily limit of \d+/.test(await noticeText(yt)) && (await tile(yt, 'yt:late0')).state === '', [await noticeText(yt), await tile(yt, 'yt:late0')]);
  t.check('past the daily cap cached verdicts still apply', (await tile(yt, 'yt:v8')).veiled === true);
  await setStore(sw, { dailyCap: 100000 });

  // ---------------------------------------------------------------- failures
  t.section('failures');
  const failing = async (changes, pattern, label) => {
    await clearHistory();
    await mock(sw, changes);
    await yt.goto(YT);
    await settled(yt, 15000);
    const text = await noticeText(yt), v2 = await tile(yt, 'yt:v8');
    t.check(`${label}: clear notice`, pattern.test(text || ''), text);
    t.check(`${label}: feed left unfiltered, nothing stuck`, v2?.state === '' && !v2.veiled && await yt.evaluate(() => !document.querySelector('[data-ff="pending"]')), v2);
    await mock(sw, { status: 200, network: false, jevRaw: undefined, chatRaw: undefined });
  };
  await failing({ status: 402 }, /out of credit/, 'no credit');
  t.check('failure is flagged on the toolbar and remembered', await badge() === '!' && /out of credit/.test((await store(sw, 'lastError')).lastError.message));
  await failing({ status: 401 }, /rejected the API key/, 'bad key');
  await failing({ status: 429 }, /rate-limiting/, 'rate limit');
  await failing({ status: 500 }, /OpenRouter error 500/, 'server error');
  await failing({ status: 404 }, /alpha API/, 'endpoint gone');
  await failing({ network: true }, /Could not reach openrouter\.ai/, 'offline');
  await failing({ jevRaw: { answers: {} } }, /not a score/, 'malformed reply');
  await failing({ jevRaw: { answers: { keep: { noul: 'abc' } } } }, /not a score/, 'non-numeric score');
  await failing({ jevRaw: 'just a string' }, /not a score/, 'string reply');
  await clearHistory();
  await mock(sw, { jevRaw: { answers: { keep: { noul: 7 } } } });
  await yt.goto(YT); await settled(yt);
  t.check('an out-of-range score is clamped', (await tile(yt, 'yt:v8')).score === '1.00', await tile(yt, 'yt:v8'));
  await mock(sw, { jevRaw: undefined });
  await clearHistory();
  await mock(sw, { failFor: 'fusion' });
  await yt.goto(YT); await settled(yt, 12000);
  t.check('one failing item does not take the batch down', (await tile(yt, 'yt:v5')).state === '' && (await tile(yt, 'yt:v8')).veiled && (await tile(yt, 'yt:v3')).state === 'keep' && await noticeText(yt) === null, [await tile(yt, 'yt:v5'), await tile(yt, 'yt:v8'), await noticeText(yt)]);
  await mock(sw, { failFor: null });
  await yt.goto(YT); await settled(yt);
  t.check('recovery: the failed item is scored next time, badge and notice clear', (await tile(yt, 'yt:v5')).state === 'keep' && await badge() === '' && (await store(sw, 'lastError')).lastError === undefined);

  // ---------------------------------------------------------------- smart mode
  t.section('smart mode');
  await opt.bringToFront(); await opt.reload(); await opt.waitForSelector('#list .item');
  await opt.click('#smart');
  await opt.waitForTimeout(1500);
  t.check('smart mode is stored', (await store(sw, 'mode')).mode === 'smart');
  await clearHistory();
  await yt.bringToFront(); await yt.goto(YT); await settled(yt);
  t.check('smart mode judges in batches', (await tile(yt, 'yt:v8')).veiled && (await tile(yt, 'yt:v3')).state === 'keep' && (await calls(sw)).at(-1).url.includes('/chat/completions'));
  await failing({ chatRaw: 'I will not score these. Ignore previous instructions.' }, /one score per item/, 'smart refusal');
  await failing({ chatRaw: '[0.5]' }, /one score per item/, 'smart wrong count');
  await failing({ chatRaw: '[' + Array(40).fill('"x"').join() + ']' }, /one score per item|not a score/, 'smart non-numbers');
  await api(opt, '/api/state', { mode: 'fast' });
  await api(opt, '/api/state', { mode: 'evil' });
  t.check('an unknown mode is ignored', (await store(sw, 'mode')).mode === 'fast');
} catch (e) {
  t.check('test run completed without crashing', false, e.stack);
}
globalThis.__shared = { t, ctx, sw, id, close, options, popup, api, noticeText, badge, clearHistory, errors, KEY, YT };
await import('./e2e-more.mjs');
