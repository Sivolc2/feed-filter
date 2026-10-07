// Loads the real extension into Chromium and stands in for the outside world:
// youtube.com and x.com are served from fixtures, and openrouter.ai is faked inside the service worker.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(here, '../extension');
export const fixture = name => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

function browserPath() {
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath();
  // Fall back to any Chromium that Playwright downloaded earlier.
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const found = fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
    .map(d => path.join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
  if (!found) throw new Error('No Chromium found. Run: npx playwright install chromium');
  return found;
}

export const SCORES = {
  'Reinventing Entropy': 0.9, CRAZIEST: 0.05, Navier: 0.85, Reacting: 0.1, fusion: 0.8, millionaires: 0.03, CPU: 0.75, DRAMA: 0.04,
  Fourier: 0.9, INSANE: 0.08, neuron: 0.82, '5am': 0.12, 'Late arrival': 0.2, GOOD: 0.9, BAD: 0.1, 'neural network': 0.91,
};

export async function launch({ headless = true, viewport = { width: 1280, height: 800 } } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath(), headless: false, viewport,
    args: [...(headless ? ['--headless=new'] : []), `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];
  await ctx.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture('youtube.html') }));
  await ctx.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture('x.html') }));
  await installMock(sw);
  const close = async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); };
  return { ctx, sw, id, close, options: `chrome-extension://${id}/options.html`, popup: `chrome-extension://${id}/popup.html` };
}

// Replaces fetch inside the extension's service worker for openrouter.ai only.
export function installMock(sw) {
  return sw.evaluate(scores => {
    const mock = globalThis.__mock = { scores, status: 200, calls: [], failFor: null, jevRaw: undefined, chatRaw: undefined, network: false, delay: 0 };
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      if (!url.startsWith('https://openrouter.ai/')) return real(url, init);
      const body = JSON.parse(init.body);
      mock.calls.push({ url, auth: init.headers?.Authorization, text: body.state || body.messages?.[1]?.content });
      if (mock.delay) await new Promise(r => setTimeout(r, mock.delay));
      if (mock.network) throw new TypeError('Failed to fetch');
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
      if (mock.status !== 200) return json({ error: { message: 'mock failure' } }, mock.status);
      const score = text => { let p = 0.5; for (const [k, v] of Object.entries(mock.scores)) if (text.includes(k)) p = v; return p; };
      if (url.includes('/alpha/decisions')) {
        if (mock.failFor && body.state.includes(mock.failFor)) return json({ error: { message: 'mock failure' } }, 500);
        if (mock.jevRaw !== undefined) return json(mock.jevRaw);
        return json({ answers: { keep: { type: 'noul', noul: score(body.state) } }, usage: { cost: 0.00002 } });
      }
      const [system, user] = body.messages.map(m => m.content);
      let content;
      if (mock.chatRaw !== undefined) content = mock.chatRaw;
      else if (system.startsWith('You tune')) content = 'Decide whether this is worth attention. The viewer WANTS GOOD things and wants to AVOID BAD things. Is this item worth the viewer\'s attention?';
      else content = JSON.stringify(user.split('\n').map(score));
      return json({ choices: [{ message: { content } }], usage: { cost: 0.001 } });
    };
  }, SCORES);
}

export const mock = (sw, changes) => sw.evaluate(c => { Object.assign(globalThis.__mock, c); return globalThis.__mock.calls.length; }, changes || {});
export const calls = sw => sw.evaluate(() => globalThis.__mock.calls);
export const store = (sw, keys) => sw.evaluate(k => chrome.storage.local.get(k), keys ?? null);
export const setStore = (sw, obj) => sw.evaluate(o => chrome.storage.local.set(o), obj);

// Waits until no tile is still waiting for a verdict. Fails if one stays stuck.
export async function settled(page, timeout = 8000) {
  await page.waitForTimeout(700);
  await page.waitForFunction(() => !document.querySelector('[data-ff="pending"]'), null, { timeout });
  await page.waitForTimeout(150);
}

export const tile = (page, id) => page.evaluate(id => {
  const el = document.querySelector(`[data-ff-id="${id}"]`);
  if (!el) return null;
  const veil = el.querySelector(':scope > .ff-veil'), badge = el.querySelector(':scope > .ff-badge');
  return { state: el.dataset.ff, vote: el.dataset.ffVote, label: veil?.textContent, veiled: !!veil && getComputedStyle(veil).display !== 'none', badge: !!badge && getComputedStyle(badge).display !== 'none', score: badge?.querySelector('span')?.textContent };
}, id);

// Runs code in the content script's isolated world, where a compromised page process would sit.
export async function isolated(ctx, page, expression) {
  const client = await ctx.newCDPSession(page);
  const contexts = [];
  client.on('Runtime.executionContextCreated', e => contexts.push(e.context));
  await client.send('Runtime.enable');
  await page.waitForTimeout(200);
  const world = contexts.find(c => c.auxData?.type === 'isolated' && c.origin.startsWith('chrome-extension://'));
  if (!world) throw new Error('content script world not found');
  const res = await client.send('Runtime.evaluate', { contextId: world.id, expression, awaitPromise: true, returnByValue: true });
  await client.detach();
  if (res.exceptionDetails) return { threw: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res.result.value;
}

export function reporter(name) {
  let passed = 0, failed = 0;
  return {
    check(label, cond, detail) { if (cond) passed++; else { failed++; console.log(`FAIL  ${label}`, detail === undefined ? '' : JSON.stringify(detail)?.slice(0, 400)); } },
    section(title) { if (process.env.VERBOSE) console.log(`-- ${title}`); },
    done() { console.log(`${name}: ${passed} passed, ${failed} failed`); return failed; },
  };
}
