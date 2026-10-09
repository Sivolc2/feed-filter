// The sites beyond YouTube and X: one fixture each, plus the real pages where they load without a login.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT, mock, calls, store, setStore, settled, tile, isolated } from './harness.mjs';

export async function run({ t, ctx, sw, clearHistory, noticeText }) {
  await import(path.join(EXT, 'sites.js'));
  const sites = globalThis.FF_SITES;

  t.section('site table');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const matched = manifest.content_scripts[0].matches.map(m => new URL(m.replace('/*', '/')).host).sort();
  t.check('every site host is in the manifest, and nothing else', matched.join() === Object.values(sites).flatMap(s => s.hosts).sort().join(), matched);
  const server = fs.readFileSync(path.join(EXT, '../server.py'), 'utf8');
  for (const [key, s] of Object.entries(sites)) t.check(`server knows ${key} with the same prefix and origin`, server.includes(`"${key}": ("${s.prefix}", "${s.origin}")`));
  t.check('prefixes are unique', new Set(Object.values(sites).map(s => s.prefix)).size === Object.keys(sites).length);
  t.check('every site has a home page kind and labels', Object.values(sites).every(s => s.pages.home && Object.values(s.pages).every(([label, on]) => typeof label === 'string' && typeof on === 'boolean')));

  await sw.evaluate(() => chrome.storage.local.remove(['pages', 'always', 'never']));
  await setStore(sw, { threshold: 0.5, never: 'r/memes\nspam.example\nmuted.bsky.social', always: 'u/TrustedUser' });
  await mock(sw, { scores: { GOOD: 0.9, BAD: 0.1 } });
  await clearHistory();
  const page = await ctx.newPage();
  const open = async url => { await page.goto(url); await settled(page); };
  const sentSince = async n => (await calls(sw)).slice(n).map(c => c.text);
  const state = async id => (await tile(page, id))?.state ?? null;

  // ---------------------------------------------------------------- Reddit
  t.section('Reddit');
  let mark = (await calls(sw)).length;
  await open('https://www.reddit.com/');
  t.check('reddit: good kept, bad veiled', await state('rd:a1') === 'keep' && (await tile(page, 'rd:a2'))?.veiled === true, [await tile(page, 'rd:a1'), await tile(page, 'rd:a2')]);
  t.check('reddit: title and subreddit are what is sent', (await sentSince(mark)).includes('A GOOD explanation of orbital mechanics — r/physics'), await sentSince(mark));
  t.check('reddit: never-keep works on a subreddit', (await tile(page, 'rd:a3'))?.veiled && /never-keep/.test((await tile(page, 'rd:a3')).label));
  t.check('reddit: always-keep works on a user', await state('rd:a4') === 'keep' && !(await sentSince(mark)).some(x => /memes|TrustedUser|trusted user/.test(x)));
  t.check('reddit: promoted post is hidden', await page.evaluate(() => getComputedStyle(document.querySelector('shreddit-ad-post')).display === 'none'));
  t.check('reddit: post with no id or a hostile link is left alone', await page.evaluate(() => [...document.querySelectorAll('shreddit-post')].filter(p => !p.dataset.ff).length) === 2 && !(await sentSince(mark)).some(x => /hostile link|no id/.test(x)), await sentSince(mark));
  await open('https://www.reddit.com/r/physics/comments/a1/slug/');
  t.check('reddit: comment pages are left alone by default', await page.evaluate(() => !document.querySelector('[data-ff]')));
  await open('https://www.reddit.com/r/physics/');
  t.check('reddit: subreddit listings are filtered', (await tile(page, 'rd:a2'))?.veiled === true);

  // ---------------------------------------------------------------- Hacker News
  t.section('Hacker News');
  mark = (await calls(sw)).length;
  await open('https://news.ycombinator.com/');
  t.check('hn: good kept, bad veiled', await state('hn:5001') === 'keep' && (await tile(page, 'hn:5002'))?.veiled === true, [await tile(page, 'hn:5001'), await tile(page, 'hn:5002')]);
  t.check('hn: a self post with no site is judged', await state('hn:5003') === 'keep' && (await sentSince(mark)).some(x => x.endsWith('— news.ycombinator.com')));
  t.check('hn: never-keep works on a site', (await tile(page, 'hn:5004'))?.veiled && /never-keep/.test((await tile(page, 'hn:5004')).label));
  t.check('hn: the veil sits in the title cell and the table stays intact', await page.evaluate(() => { const cell = document.querySelector('[data-ff-id="hn:5002"]'); return cell.tagName === 'TD' && cell.parentElement.children.length === 3 && !document.querySelector('tr > div'); }));
  t.check('hn: a row with a broken id is left alone', await page.evaluate(() => !document.getElementById('notanumber').querySelector('[data-ff]')));
  await open('https://news.ycombinator.com/item?id=5001');
  t.check('hn: comment threads are left alone by default', await page.evaluate(() => !document.querySelector('[data-ff]')));

  // ---------------------------------------------------------------- Bluesky
  t.section('Bluesky');
  mark = (await calls(sw)).length;
  await open('https://bsky.app/');
  t.check('bluesky: good kept, bad veiled', await state('bs:3aaa') === 'keep' && (await tile(page, 'bs:3bbb'))?.veiled === true, [await tile(page, 'bs:3aaa'), await tile(page, 'bs:3bbb')]);
  t.check('bluesky: a post with no text is left alone', await state('bs:3ccc') === null);
  t.check('bluesky: never-keep works on a handle', (await tile(page, 'bs:3ddd'))?.veiled === true && !(await sentSince(mark)).some(x => x.includes('muted')));
  await page.click('[data-ff-id="bs:3bbb"] > .ff-veil');
  t.check('bluesky: peeking does not open the post', (await page.evaluate(() => window.__clicked)).length === 0 && (await tile(page, 'bs:3bbb')).veiled === false);
  await page.click('[data-ff-id="bs:3aaa"] .ff-down', { force: true });
  await page.waitForTimeout(400);
  t.check('bluesky: voting does not open the post and is stored', (await page.evaluate(() => window.__clicked)).length === 0 && (await store(sw, 'i:bs:3aaa'))['i:bs:3aaa']?.vote === -1);

  // ---------------------------------------------------------------- Threads
  t.section('Threads');
  mark = (await calls(sw)).length;
  await open('https://www.threads.com/');
  t.check('threads: good kept, bad veiled', await state('th:Taaa') === 'keep' && (await tile(page, 'th:Tbbb'))?.veiled === true, [await tile(page, 'th:Taaa'), await tile(page, 'th:Tbbb')]);
  t.check('threads: a quoted post is not judged separately', await state('th:Qqq') === null && await state('th:Tccc') === 'keep' && !(await sentSince(mark)).some(x => x.startsWith('@other')), await sentSince(mark));
  t.check('threads: author is read from the post link', (await sentSince(mark)).some(x => x.startsWith('@mathgrid: ')));
  await open('https://www.threads.net/');
  t.check('threads: the older address works too', (await tile(page, 'th:Tbbb'))?.veiled === true);

  // ---------------------------------------------------------------- Facebook
  t.section('Facebook');
  mark = (await calls(sw)).length;
  await open('https://www.facebook.com/');
  const fb = await page.evaluate(() => [...document.querySelectorAll('#feed > [role=article]')].map(a => ({ who: a.querySelector('[data-ad-rendering-role=profile_name]')?.textContent || 'skeleton', ff: a.dataset.ff ?? null, id: a.dataset.ffId ?? null })));
  const by = who => fb.find(p => p.who === who);
  const fbSent = await sentSince(mark);
  t.check('facebook: public good post kept, public bad post veiled', by('Space Agency').ff === 'keep' && by('Outrage Page').ff === 'hide', fb);
  t.check('facebook: friends-only post is never read or sent', by('A Close Friend').ff === null && !fbSent.some(x => /family holiday|Close Friend/.test(x)), fbSent);
  t.check('facebook: private group post is never read or sent', by('Private Group Member').ff === null && !fbSent.some(x => /secret/i.test(x)));
  t.check('facebook: public group post is judged', by('Hobby Group Member').ff === 'keep');
  t.check('facebook: loading placeholders and text-less posts are left alone', by('skeleton').ff === null && by('Photo Page').ff === null);
  t.check('facebook: comments under a post are not judged or sent', await page.evaluate(() => !document.querySelector('[aria-label^="Comment by"]').dataset.ff) && !fbSent.some(x => x.includes('BAD comment')));
  t.check('facebook: ids are stable hashes and links stay on facebook.com', /^fb:[a-z0-9]{8,}$/.test(by('Space Agency').id) && (await store(sw, 'i:' + by('Space Agency').id))['i:' + by('Space Agency').id].url === 'https://www.facebook.com/SpaceAgency/posts/pfbid0abc', await store(sw, 'i:' + by('Space Agency').id));
  const firstId = by('Space Agency').id;
  await open('https://www.facebook.com/');
  t.check('facebook: the same post gets the same id on reload, served from cache', (await page.evaluate(() => document.querySelector('#feed > [role=article]').dataset.ffId)) === firstId && (await sentSince(mark)).length === fbSent.length);
  await open('https://www.facebook.com/groups/123');
  t.check('facebook: groups, pages and profiles are left alone by default', await page.evaluate(() => !document.querySelector('[data-ff]')));

  // ---------------------------------------------------------------- LinkedIn
  t.section('LinkedIn');
  mark = (await calls(sw)).length;
  await page.goto('https://www.linkedin.com/feed/');
  await page.waitForTimeout(1200);
  t.check('linkedin: off by default, nothing read or sent', await page.evaluate(() => !document.querySelector('[data-ff]')) && (await sentSince(mark)).length === 0);
  const pages = (await store(sw, 'pages')).pages || {};
  await setStore(sw, { pages: { ...pages, linkedin: { home: true, other: false } } });
  await open('https://www.linkedin.com/feed/');
  t.check('linkedin: once switched on, good kept and bad veiled', await state('li:7001') === 'keep' && (await tile(page, 'li:7002'))?.veiled === true, [await tile(page, 'li:7001'), await tile(page, 'li:7002')]);
  t.check('linkedin: author is read once, not doubled', (await sentSince(mark)).includes('Ada Engineer: A GOOD write-up of a migration'), await sentSince(mark));

  // ---------------------------------------------------------------- cross-site rules
  t.section('cross-site rules');
  const forge = body => isolated(ctx, page, `chrome.runtime.sendMessage(${JSON.stringify({ path: '/api/judge', body })}).then(r => Object.keys(r.results || {}))`);
  const good = { id: 'li:9', source: 'linkedin', text: 'GOOD', url: 'https://www.linkedin.com/feed/update/9/' };
  t.check('a well-formed item is accepted', (await forge({ items: [good] })).join() === 'li:9');
  t.check('an id with another site\'s prefix is refused', (await forge({ items: [{ ...good, id: 'yt:9' }] })).length === 0);
  t.check('a link to another site is refused', (await forge({ items: [{ ...good, url: 'https://www.facebook.com/x' }] })).length === 0);
  t.check('a link to a look-alike host is refused', (await forge({ items: [{ ...good, url: 'https://www.linkedin.com.evil.example/x' }] })).length === 0);
  t.check('an unknown source is refused', (await forge({ items: [{ ...good, source: 'constructor' }, { ...good, source: '__proto__' }, { ...good, source: 'scan' }] })).length === 0);
  const opt = ctx.pages().find(p => p.url().endsWith('/options.html'));
  await opt.bringToFront(); await opt.reload(); await opt.waitForSelector('#list .item');
  t.check('settings page lists every site with its switches', await opt.evaluate(n => document.querySelectorAll('#pages h3').length === n && !!document.querySelector('#pages-facebook input') && !document.querySelector('#pages-linkedin input').checked === false, Object.keys(sites).length), await opt.evaluate(() => [...document.querySelectorAll('#pages h3')].map(h => h.textContent)));
  t.check('history filter offers the sites that have items', await opt.evaluate(() => [...document.getElementById('source').options].map(o => o.textContent).join()), await opt.evaluate(() => [...document.getElementById('source').options].map(o => o.textContent)));
  t.check('history filter names sites properly', (await opt.evaluate(() => [...document.getElementById('source').options].map(o => o.textContent))).includes('Hacker News'));

  // ---------------------------------------------------------------- the real sites (need network, no login)
  if (process.env.LIVE) {
    t.section('live sites');
    await setStore(sw, { always: '', never: '' });
    await mock(sw, { scores: { e: 0.9 } });
    const live = async (name, host, url, ready, minimum, before) => {
      await ctx.unroute(`https://${host}/**`);
      const p = await ctx.newPage();
      try {
        if (before) await before();
        const from = (await calls(sw)).length;
        await p.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await p.waitForSelector(ready, { timeout: 20000 });
        await p.waitForTimeout(2500);
        await settled(p, 15000);
        const got = await p.evaluate(sel => ({ tiles: [...document.querySelectorAll(sel)].filter(e => !e.parentElement.closest(sel)).length, judged: document.querySelectorAll('[data-ff="keep"], [data-ff="hide"]').length, stuck: document.querySelectorAll('[data-ff="pending"]').length }), sites[name].tiles);
        const texts = await sentSince(from);
        t.check(`live ${name}: tiles are found and judged, none stuck`, got.judged >= minimum && got.stuck === 0, got);
        t.check(`live ${name}: text and author are read`, texts.length >= minimum && texts.every(x => x.length > 8) && texts.filter(x => /^(@?[\w.\- ]+: \S)|( — \S)/.test(x)).length >= texts.length * 0.8, texts.slice(0, 3).map(x => x.slice(0, 70)));
      } catch (e) {
        console.log(`NOTE  live ${name} check could not run:`, e.message.split('\n')[0]);
      }
      await p.close();
    };
    await live('hackernews', 'news.ycombinator.com', 'https://news.ycombinator.com/', 'tr.athing', 20);
    await live('bluesky', 'bsky.app', 'https://bsky.app/', '[data-testid^="feedItem-by-"]', 5);
    await live('threads', 'www.threads.com', 'https://www.threads.com/', '[data-pressable-container]', 3);
    const all = (await store(sw, 'pages')).pages;
    await live('facebook', 'www.facebook.com', 'https://www.facebook.com/NASA', 'div[role="article"] [data-ad-rendering-role="story_message"]', 1, () => setStore(sw, { pages: { ...all, facebook: { home: true, other: true } } }));
  }
  await page.close();
}
