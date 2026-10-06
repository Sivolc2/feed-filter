const send = (path, body) => chrome.runtime.sendMessage({ path, body });

function paint(state) {
  if (state.error) { document.getElementById('msg').textContent = state.error; return; }
  document.getElementById('enabled').checked = state.enabled;
  document.getElementById('block_shorts').checked = state.block_shorts;
  document.querySelector(`input[value="${state.mode}"]`).checked = true;
}

async function change(body) {
  paint(await send('/api/state', body));
  chrome.tabs.reload();
}

send('/api/state').then(paint);
chrome.storage.local.get(['apiKey', 'serverUrl']).then(s => { if (!s.apiKey && !s.serverUrl) document.getElementById('msg').textContent = 'Add your OpenRouter key in settings.'; });
for (const id of ['enabled', 'block_shorts']) document.getElementById(id).onchange = e => change({ [id]: e.target.checked });
for (const radio of document.querySelectorAll('input[name=mode]')) radio.onchange = e => change({ mode: e.target.value });
document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
