// Every page talks to the judge through here: { path, body } in, JSON out, { error } on failure.
// With a server URL set in the options the call is relayed to that server; otherwise the
// judge runs in the extension (local.js) with the user's own key.
import { routes, settings } from './local.js';

async function handle({ path, body }) {
  const { serverUrl } = await settings();
  if (serverUrl && path.startsWith('/api/')) {
    const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch(serverUrl.replace(/\/+$/, '') + path, init);
    return res.json();
  }
  if (!routes[path]) throw new Error(`Not available without a server: ${path}`);
  return routes[path](body);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg)
    .then(result => { chrome.action.setBadgeText({ text: result.error ? '!' : '' }); reply(result); })
    .catch(e => { chrome.action.setBadgeText({ text: '!' }); reply({ error: e.message }); });
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });
