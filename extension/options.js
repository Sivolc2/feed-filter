import { PRESETS, DEFAULTS, withPageDefaults } from './local.js';

const $ = id => document.getElementById(id);
const pct = x => Math.round(x * 100) + '%';
let data = null, proposal = null, local = {}, keepDirty = false;

async function api(path, body) {
  const res = await chrome.runtime.sendMessage({ path, body });
  if (!res || res.error) throw new Error(res ? res.error : 'The extension did not answer.');
  return res;
}

async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true; button.textContent = label; $('status').textContent = '';
  try { await fn(); } catch (e) { $('status').textContent = e.message; }
  button.disabled = false; button.textContent = old;
}

function checkbox(label, checked, onchange) {
  const wrap = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox'; box.checked = checked; box.onchange = () => onchange(box.checked);
  wrap.append(box, ' ' + label);
  return wrap;
}

function renderLocal() {
  $('apiKey').placeholder = local.apiKey ? 'Key saved. Paste a new one to replace it.' : 'OpenRouter API key (sk-or-…)';
  $('serverUrl').value = local.serverUrl;
  $('serverHint').style.display = local.serverUrl ? '' : 'none';
  $('serverLink').href = /^https?:\/\//.test(local.serverUrl) ? local.serverUrl : '';
  $('clear').style.display = local.serverUrl ? 'none' : '';
  $('signal').checked = local.signal;
  $('always').value = local.always; $('never').value = local.never;
  $('dailyCap').value = local.dailyCap;
  $('pages').replaceChildren(...Object.entries(FF_SITES).map(([key, site]) => {
    const block = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = site.label;
    const boxes = document.createElement('div');
    boxes.className = 'checks';
    boxes.id = 'pages-' + key;
    boxes.append(...Object.entries(site.pages).map(([kind, [label]]) =>
      checkbox(label, local.pages[key][kind], async on => {
        local.pages[key][kind] = on;
        await chrome.storage.local.set({ pages: local.pages });
      })));
    block.append(title, boxes);
    return block;
  }));
  if (local.lastError && Date.now() - local.lastError.at < 3600e3) $('status').textContent = `Last problem while filtering: ${local.lastError.message}`;

  const days = Object.entries(local.stats).sort().reverse();
  const sum = rows => rows.reduce((a, [, d]) => ({ seen: a.seen + d.seen, hidden: a.hidden + d.hidden, scored: a.scored + d.scored, cost: a.cost + d.cost }), { seen: 0, hidden: 0, scored: 0, cost: 0 });
  const line = (name, t) => `${name}: ${t.seen} items seen, ${t.seen ? pct(t.hidden / t.seen) : '0%'} filtered, ${t.scored} newly scored` + (local.serverUrl ? '' : `, $${t.cost.toFixed(4)}`);
  const today = new Date().toLocaleDateString('en-CA');
  $('stats').textContent = days.length
    ? `${line('Today', sum(days.filter(([d]) => d === today)))}. ${line('Last 30 days', sum(days))}.` + (local.serverUrl ? ' Cost is not tracked when a server does the scoring.' : '')
    : 'Nothing scored yet. Usage and cost will show here.';
}

async function load() {
  const stored = await chrome.storage.local.get({ ...DEFAULTS, stats: {} });
  local = { ...stored, pages: withPageDefaults(stored.pages) };
  renderLocal();
  try { data = await api('/api/items'); } catch (e) { $('status').textContent = e.message; return; }
  if (!keepDirty) $('keep').value = data.keep;
  render();
}

function render() {
  const s = data.state, c = data.calibration;
  $('enabled').checked = s.enabled; $('shorts').checked = s.block_shorts;
  $('fast').classList.toggle('on', s.mode === 'fast'); $('smart').classList.toggle('on', s.mode === 'smart');
  $('threshold').value = s.threshold; $('tval').textContent = s.threshold.toFixed(2);
  $('cal').textContent = c.votes
    ? `${c.votes} votes. The ${s.mode} judge agrees with ${pct(c.agreement)} of them at ${s.threshold.toFixed(2)}.`
    : 'No votes yet. Vote with the 👍 👎 buttons below or on the badge in the corner of any feed tile.';
  const better = c.votes && c.best_agreement > c.agreement;
  $('useBest').style.display = better ? '' : 'none';
  if (better) $('useBest').textContent = `Use ${c.best_threshold.toFixed(2)} (${pct(c.best_agreement)})`;

  // The source filter lists whatever sources the history actually holds.
  const sources = [...new Set(data.items.map(it => it.source))].sort();
  if (sources.join() !== [...$('source').options].slice(1).map(o => o.value).join()) {
    const picked = $('source').value;
    $('source').replaceChildren(new Option('All sources', ''), ...sources.map(key => new Option(FF_SITES[key]?.label || (key === 'scan' ? 'Scans' : key), key)));
    $('source').value = sources.includes(picked) ? picked : '';
  }
  const src = $('source').value, show = $('show').value;
  const items = data.items.filter(it => it.p !== null && (!src || it.source === src))
    .map(it => ({ ...it, keep: it.vote ? it.vote > 0 : it.p >= s.threshold }))
    .filter(it => show === 'all' || (show === 'unvoted' ? !it.vote : (show === 'keep') === it.keep))
    .sort((a, b) => b.p - a.p);
  $('count').textContent = items.length ? `${items.length} items` : 'Nothing yet. Browse YouTube or X and items will appear here.';
  $('list').replaceChildren(...items.map(row));
}

function row(it) {
  const el = document.createElement('div');
  el.className = 'item ' + (it.keep ? 'keep' : 'skip');
  const p = document.createElement('div'); p.className = 'p'; p.textContent = it.p.toFixed(2);
  const mid = document.createElement('div'); mid.className = 'title';
  const a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = it.text;
  // Items can come from a server or an import file: only ever link to a web address.
  if (/^https:\/\//.test(it.url)) a.href = it.url;
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = it.source + (it.q ? ' · ' + it.q : '');
  mid.append(a, meta);
  const votes = document.createElement('div'); votes.className = 'votes';
  for (const [cls, label, v] of [['up', '👍', 1], ['down', '👎', -1]]) {
    const b = document.createElement('button'); b.className = cls + (it.vote === v ? ' on' : ''); b.textContent = label;
    b.onclick = async () => { try { await api('/api/vote', { id: it.id, vote: it.vote === v ? null : v }); } catch (e) { $('status').textContent = e.message; } load(); };
    votes.append(b);
  }
  el.append(p, mid, votes);
  return el;
}

$('presets').replaceChildren(...Object.entries(PRESETS).map(([name, text]) => {
  const b = document.createElement('button');
  b.className = 'small'; b.textContent = name;
  b.onclick = () => { $('keep').value = text; keepDirty = true; $('status').textContent = ''; $('saveKeep').classList.add('on'); };
  return b;
}));

$('keep').oninput = () => { keepDirty = true; $('saveKeep').classList.add('on'); };

$('saveKey').onclick = async () => {
  const key = $('apiKey').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  await chrome.storage.local.remove('lastError');
  $('apiKey').value = ''; $('keyMsg').textContent = 'Saved.'; $('status').textContent = '';
  load();
};
$('test').onclick = () => busy($('test'), 'Testing…', async () => {
  $('keyMsg').textContent = '';
  const res = await api('/ext/test');
  $('keyMsg').textContent = res.server ? 'Server answered.' : `Working. A 3Blue1Brown video scores ${res.p.toFixed(2)} under your criteria.`;
});
$('saveServer').onclick = () => busy($('saveServer'), 'Saving…', async () => {
  const url = $('serverUrl').value.trim();
  if (url) {
    let origin;
    try { origin = new URL(url).origin; } catch { throw new Error('That is not a valid address.'); }
    if (!/^https?:\/\//.test(origin)) throw new Error('The server address must start with http:// or https://.');
    // The browser asks the user to allow this one host; nothing beyond openrouter.ai is granted up front.
    if (!(await chrome.permissions.request({ origins: [origin + '/*'] }))) throw new Error('Permission for that server was not granted.');
  }
  const old = local.serverUrl && new URL(local.serverUrl).origin;
  await chrome.storage.local.set({ serverUrl: url });
  if (old && (!url || new URL(url).origin !== old)) await chrome.permissions.remove({ origins: [old + '/*'] }).catch(() => {});
  await load();
});

const setState = async changes => { try { await api('/api/state', changes); } catch (e) { $('status').textContent = e.message; } load(); };
$('enabled').onchange = e => setState({ enabled: e.target.checked });
$('shorts').onchange = e => setState({ block_shorts: e.target.checked });
$('signal').onchange = e => chrome.storage.local.set({ signal: e.target.checked });
$('fast').onclick = () => setState({ mode: 'fast' });
$('smart').onclick = () => setState({ mode: 'smart' });
$('threshold').oninput = e => { $('tval').textContent = (+e.target.value).toFixed(2); };
$('threshold').onchange = e => setState({ threshold: +e.target.value });
$('useBest').onclick = () => setState({ threshold: data.calibration.best_threshold });
$('source').onchange = $('show').onchange = render;
$('dailyCap').onchange = async e => {
  const cap = Math.max(0, Math.floor(+e.target.value) || 0);
  e.target.value = cap;
  await chrome.storage.local.set({ dailyCap: cap });
};
$('saveLists').onclick = () => busy($('saveLists'), 'Saving…', async () => {
  await chrome.storage.local.set({ always: $('always').value.slice(0, 20000), never: $('never').value.slice(0, 20000) });
});
$('saveKeep').onclick = () => busy($('saveKeep'), 'Saving and rescoring…', async () => {
  await api('/api/keep', { keep: $('keep').value.trim(), threshold: data ? data.state.threshold : 0.5 });
  keepDirty = false;
  $('saveKeep').classList.remove('on');
  await load();
});
$('refine').onclick = () => busy($('refine'), 'Refining…', async () => {
  proposal = await api('/api/refine', {});
  $('propStats').textContent = `Jev agreement on your ${proposal.votes} votes: ${pct(proposal.before.agreement)} now, ${pct(proposal.after.agreement)} with this rewrite (threshold ${proposal.after.threshold.toFixed(2)}). Measured on the same votes it was written from.`;
  $('propText').textContent = proposal.keep;
  $('proposal').style.display = 'block';
});
$('discard').onclick = () => { $('proposal').style.display = 'none'; };
$('apply').onclick = () => busy($('apply'), 'Applying…', async () => {
  await api('/api/keep', { keep: proposal.keep, threshold: proposal.after.threshold });
  keepDirty = false;
  $('proposal').style.display = 'none';
  await load();
});
$('clear').onclick = () => busy($('clear'), 'Clearing…', async () => { await api('/ext/clear', {}); await load(); });

$('export').onclick = () => busy($('export'), 'Exporting…', async () => {
  const file = await api('/ext/export');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  link.download = `feed-filter-${new Date().toLocaleDateString('en-CA')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  $('cal').textContent = `Exported criteria, settings and ${file.votes.length} votes. The file does not contain your key.`;
});
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = e => busy($('import'), 'Importing…', async () => {
  const picked = e.target.files[0];
  e.target.value = '';
  if (!picked) return;
  if (picked.size > 5e6) throw new Error('That file is too large to be a Feed filter export.');
  let file;
  try { file = JSON.parse(await picked.text()); } catch { throw new Error('That file is not valid JSON.'); }
  const res = await api('/ext/import', file);
  keepDirty = false;
  await load();
  $('cal').textContent = `Imported criteria, settings and ${res.votes} votes.` + (res.skippedVotes ? ` ${res.skippedVotes} votes were skipped.` : '');
});
load();
