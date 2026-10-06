# Feed filter

Blacks out YouTube and X feed items that don't match criteria you write in plain English,
so the feed you see is closer to what you came for.

A fast classifier ([TypeSafe's Jev](https://openrouter.ai/typesafe), via OpenRouter) scores
each title or post in about a third of a second for roughly $0.02 per thousand items. Your
👍/👎 votes tune it: a larger model rewrites your criteria from the votes, the rewrite is
tested against them, and you decide whether to apply it.

There are two parts. Most people only need the first.

## 1. The extension (`extension/`)

Standalone. Works in Chrome, Brave and other Chromium browsers with your own OpenRouter key.

1. Get a key at https://openrouter.ai/keys and add a little credit.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, choose the `extension/` folder.
3. The settings page opens. Paste the key, **Save**, **Test**.
4. Describe what you want and don't want under "What to keep", and save.
5. Open YouTube or X.

Details and day-to-day use are in [extension/README.md](extension/README.md).

## 2. The optional server (`server.py`)

For a shared history across browsers, and for curated scans: it searches YouTube for terms
you list (this month's uploads only), pulls the latest uploads of channels you list, and
scores everything with the same judge. Python 3.9+ standard library, plus
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on the PATH for scans.

```bash
cp profile.example.json profile.json     # then edit: keep, searches, channels
echo "OPENROUTER_API_KEY=sk-or-..." > .env
python3 server.py                        # http://127.0.0.1:8953
```

Then set that URL under **Advanced** in the extension's settings. The server has no login:
bind it to loopback or a private network address (`FEED_HOST`), never a public one.
`feed-filter.service.example` is a systemd unit to start from.

| File | What it is |
|---|---|
| `profile.json` | `keep` is the criteria the judge reads. `searches` and `channels` drive "Scan my profile searches". |
| `judge.py` | Scoring, cache (`data/feed.db`), calibration. |
| `server.py`, `review.html` | The API and the review page. |

## Calibration

1. Vote 👍/👎 on the review or settings page, or on the badge in the corner of any feed tile.
2. "Use N" moves the threshold to where the judge best matches your votes.
3. "Refine criteria from my votes" rewrites the criteria, re-tests with Jev on the same votes, and shows before and after. Nothing changes until you press Apply.

## Privacy

Titles, channel names and post text from the feeds you view are sent to openrouter.ai to be
scored: by TypeSafe in fast mode, by Anthropic in smart mode. Nothing else leaves your
machine. Keep personal detail out of your criteria, since the criteria are sent with every item.

## Known limits

- The judge sees only the title and channel, or the post text and author. It cannot judge a video's content, length or date.
- Tile detection depends on YouTube's and X's page markup and will need fixing when they change it.
- Passing a 👎 on to the site as "Not interested" finds the menu entry by its English label.
- Jev is served from an alpha OpenRouter endpoint that may change.
- Hiding ad slots and scripted menu clicks may be against the sites' terms. Both only happen in your own browser; decide for yourself.

## License

MIT
