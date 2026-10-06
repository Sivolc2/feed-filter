# Feed filter

A Chrome/Brave extension that blacks out YouTube and X feed items that don't match criteria
you write in plain English. A fast classifier (TypeSafe's Jev) scores each title or post in
about a third of a second; your 👍/👎 votes tune it.

## Install

1. Get an OpenRouter API key at https://openrouter.ai/keys and add a few dollars of credit. Fast mode costs roughly $0.02 per thousand items.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose this folder.
3. The settings page opens. Paste your key, press **Save**, then **Test**.
4. Edit the criteria under "What to keep" to describe what you want and what you want to avoid, and save.
5. Open YouTube or X. Tiles go black while they are checked and stay black if they fail.

## Use

- Click a black tile to peek. Use the 👍 👎 badge in a tile's corner to correct the judge.
- A 👎 on a feed tile also picks "Not interested" in that tile's own YouTube or X menu, so the site hears it too. This works with the sites in English and can be switched off in settings. Votes made on the settings page don't do this.
- After a few dozen votes, open the settings page (toolbar icon, "Settings and calibration") and press **Refine criteria from my votes**. It rewrites your criteria, shows how well the rewrite matches your votes, and changes nothing until you press Apply.
- Fast mode uses Jev. Smart mode uses Claude Sonnet through the same key: slower, costs more, sometimes better on subtle cases.
- Shorts, ad slots and YouTube's hover previews are hidden while the filter is on.

## Privacy

Titles, channel names and post text from the feeds you view are sent to openrouter.ai to be
scored (TypeSafe in fast mode, Anthropic in smart mode). Your key, criteria, votes and history
stay in this browser profile; the key is stored unencrypted. If the judge can't be reached,
feeds are left unfiltered.

## Files

`content.js` and `content.css` read and veil tiles. `background.js` routes requests to
`local.js` (the judge) or, if you set a server URL under Advanced, to your own server.
`options.*` is the settings and calibration page, `popup.*` the toolbar menu.
