const $ = id => document.getElementById(id);
const pct = x => Math.round(x * 100) + '%';
let data = null, proposal = null, local = {};

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

async function load() {
  local = await chrome.storage.local.get({ apiKey: '', serverUrl: '', signal: true });
  $('signal').checked = local.signal;
  $('apiKey').placeholder = local.apiKey ? 'Key saved. Paste a new one to replace it.' : 'OpenRouter API key (sk-or-…)';
  $('serverUrl').value = local.serverUrl || '';
  $('serverHint').style.display = local.serverUrl ? '' : 'none';
  $('serverLink').href = local.serverUrl || '';
  $('clear').style.display = local.serverUrl ? 'none' : '';
  try { data = await api('/api/items'); } catch (e) { $('status').textContent = e.message; return; }
  $('keep').value = data.keep;
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
  const a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = it.text;
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = it.source + (it.q ? ' · ' + it.q : '');
  mid.append(a, meta);
  const votes = document.createElement('div'); votes.className = 'votes';
  for (const [cls, label, v] of [['up', '👍', 1], ['down', '👎', -1]]) {
    const b = document.createElement('button'); b.className = cls + (it.vote === v ? ' on' : ''); b.textContent = label;
    b.onclick = async () => { await api('/api/vote', { id: it.id, vote: it.vote === v ? null : v }); load(); };
    votes.append(b);
  }
  el.append(p, mid, votes);
  return el;
}

$('saveKey').onclick = async () => {
  const key = $('apiKey').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  $('apiKey').value = ''; $('keyMsg').textContent = 'Saved.';
  load();
};
$('test').onclick = () => busy($('test'), 'Testing…', async () => {
  $('keyMsg').textContent = '';
  if (local.serverUrl) { await api('/api/state'); $('keyMsg').textContent = 'Server answered.'; return; }
  const { p } = await api('/ext/test');
  $('keyMsg').textContent = `Working. A 3Blue1Brown video scores ${p.toFixed(2)} under your criteria.`;
});
$('saveServer').onclick = () => busy($('saveServer'), 'Saving…', async () => {
  const url = $('serverUrl').value.trim();
  // The browser asks the user to allow this one host; nothing beyond openrouter.ai is granted up front.
  if (url && !(await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] }))) throw new Error('Permission for that server was not granted.');
  await chrome.storage.local.set({ serverUrl: url });
  await load();
});

const setState = async changes => { try { await api('/api/state', changes); } catch (e) { $('status').textContent = e.message; } load(); };
$('enabled').onchange = e => setState({ enabled: e.target.checked });
$('signal').onchange = e => chrome.storage.local.set({ signal: e.target.checked });
$('shorts').onchange = e => setState({ block_shorts: e.target.checked });
$('fast').onclick = () => setState({ mode: 'fast' });
$('smart').onclick = () => setState({ mode: 'smart' });
$('threshold').oninput = e => { $('tval').textContent = (+e.target.value).toFixed(2); };
$('threshold').onchange = e => setState({ threshold: +e.target.value });
$('useBest').onclick = () => setState({ threshold: data.calibration.best_threshold });
$('source').onchange = $('show').onchange = render;
$('saveKeep').onclick = () => busy($('saveKeep'), 'Saving and rescoring…', async () => {
  await api('/api/keep', { keep: $('keep').value.trim(), threshold: data.state.threshold });
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
  $('proposal').style.display = 'none';
  await load();
});
$('clear').onclick = () => busy($('clear'), 'Clearing…', async () => { await api('/ext/clear', {}); await load(); });
load();
