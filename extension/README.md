# Feed filter (extension)

A Chrome/Brave extension that blacks out feed items that don't match criteria you write in
plain English, on YouTube, X, Reddit, Hacker News, Bluesky, Threads, Facebook and LinkedIn. A fast classifier (TypeSafe's Jev) scores each title or post in
about a third of a second; your 👍/👎 votes tune it.

## Install

1. Get an OpenRouter API key at https://openrouter.ai/keys and add a few dollars of credit. Fast mode costs roughly $0.02 per thousand items.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose this folder.
3. The settings page opens. Paste your key, press **Save**, then **Test**.
4. Under "What to keep", pick a starting profile or write your own, and save.
5. Open a supported site. Tiles go black while they are checked and stay black if they fail.

## Use

- **Peek and vote.** Click a black tile to peek. Use the 👍 👎 badge in a tile's corner to correct the judge; the button you pressed stays lit.
- **Tell the site too.** On YouTube and X, a 👎 on a feed tile also picks "Not interested" in that tile's own menu. This needs the sites in English and can be switched off. Votes made on the settings page don't do this.
- **Refine.** After a few dozen votes, press **Refine criteria from my votes** on the settings page. It rewrites your criteria, shows how well the rewrite matches your votes, and changes nothing until you press Apply.
- **Lists.** Put channel names, @handles, subreddits (`r/name`), Reddit users (`u/name`) or Hacker News sites (`example.com`) under "Always keep" or "Never keep", one per line. They skip the judge.
- **Where to filter.** Tick the kinds of page to filter on each site. By default that is home feeds and search. LinkedIn is off until you switch it on. On Facebook only posts marked "Shared with Public" are ever read.
- **Fast or smart.** Fast mode uses Jev. Smart mode uses Claude Sonnet through the same key: slower, costs more, sometimes better on subtle cases.
- **Cost.** The settings page shows items seen, share filtered and dollars spent. "Stop after N newly scored items a day" is a hard cap; verdicts already known keep applying after it is reached.
- **Move or share a setup.** Export writes criteria, settings and votes to a file, without the key. Import reads one back.

Shorts, ad slots and YouTube's hover previews are hidden on pages where the filter is on.

## When something is wrong

The feed is left unfiltered and a notice appears at the bottom right saying why: no key, a
rejected key, no credit, rate limiting, or no connection. The toolbar icon shows "!" and the
popup repeats the message.

## Privacy

Titles, channel names and post text from the kinds of page you switched on are sent to
openrouter.ai to be scored (TypeSafe in fast mode, Anthropic in smart mode). Posts from
protected X accounts, and Facebook posts not shared publicly, are never read. Your key, criteria, votes and history stay in this
browser profile; the key is stored unencrypted and only this extension's own pages can read it.

## Files

| File | Role |
|---|---|
| `sites.js` | One entry per supported site: where its feed items are and how to read them. |
| `content.js`, `content.css` | Find tiles on the page, veil them, show the vote badge and notices. |
| `background.js` | Routes every request, checks who is asking, applies lists, caps and stats. |
| `local.js` | The judge: calls OpenRouter, caches scores, calibrates. |
| `options.*`, `popup.*` | Settings and calibration page, toolbar menu. |
