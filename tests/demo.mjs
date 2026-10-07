// Records docs/demo.gif and docs/settings.png from the real extension running on the fixture feed.
//   node demo.mjs && python3 make_gif.py
import fs from 'node:fs';
import { launch, mock, setStore, settled } from './harness.mjs';

const out = 'frames';
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
const { ctx, sw, close, options } = await launch({ viewport: { width: 1000, height: 640 } });
await setStore(sw, { apiKey: 'sk-or-demo', signal: false, keep: 'Decide whether a video or post is a high-signal use of this viewer\'s attention. The viewer WANTS: physics, mathematics and engineering explained with real depth. The viewer wants to AVOID: clickbait, outrage and drama, reaction content, listicles and engagement bait. Is this item worth the viewer\'s attention?' });
const page = await ctx.newPage();
let n = 0;
const shot = async ms => { await page.screenshot({ path: `${out}/${String(n++).padStart(2, '0')}_${ms}.png` }); };

await mock(sw, { delay: 100000 });
await page.goto('https://www.youtube.com/?plain');
await page.waitForSelector('[data-ff="pending"]');
await page.waitForTimeout(300);
await shot(1100);                                   // every tile is checked first
await mock(sw, { delay: 0 });
await sw.evaluate(() => chrome.storage.local.get(null).then(all => chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('i:')))));
await page.goto('https://www.youtube.com/?plain');
await settled(page);
await shot(2600);                                   // verdicts
const box = await page.locator('[data-ff-id="yt:v2"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 60);
await page.click('[data-ff-id="yt:v2"] > .ff-veil');
await shot(1700);                                   // peek
await page.hover('[data-ff-id="yt:v2"] .ff-badge');
await page.click('[data-ff-id="yt:v2"] .ff-down', { force: true });
await page.waitForTimeout(400);
await shot(1700);                                   // downvote
await page.hover('[data-ff-id="yt:v3"] .ff-badge');
await page.click('[data-ff-id="yt:v3"] .ff-up', { force: true });
await page.waitForTimeout(400);
await shot(2600);                                   // upvote

await page.setViewportSize({ width: 1000, height: 1180 });
await page.goto(options);
await page.waitForSelector('#list .item');
await page.screenshot({ path: '../docs/settings.png' });
await close();
console.log(`${n} frames`);
