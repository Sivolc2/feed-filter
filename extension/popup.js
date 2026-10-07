const send = (path, body) => chrome.runtime.sendMessage({ path, body });
const msg = document.getElementById('msg');

function paint(state) {
  if (!state || state.error) { msg.textContent = state ? state.error : 'The extension did not answer.'; return; }
  document.getElementById('enabled').checked = state.enabled;
  document.getElementById('block_shorts').checked = state.block_shorts;
  document.querySelector(`input[value="${state.mode === 'smart' ? 'smart' : 'fast'}"]`).checked = true;
}

async function change(body) {
  paint(await send('/api/state', body));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'ff-refresh' }).catch(() => {}); // no feed on this tab: nothing to do
}

send('/api/state').then(paint);
chrome.storage.local.get(['apiKey', 'serverUrl', 'lastError']).then(s => {
  if (!s.apiKey && !s.serverUrl) msg.textContent = 'Add your OpenRouter key in settings.';
  else if (s.lastError && Date.now() - s.lastError.at < 3600e3) msg.textContent = s.lastError.message;
});
for (const id of ['enabled', 'block_shorts']) document.getElementById(id).onchange = e => change({ [id]: e.target.checked });
for (const radio of document.querySelectorAll('input[name=mode]')) radio.onchange = e => change({ mode: e.target.value });
document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
