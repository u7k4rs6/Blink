# Blink: Frontend Spec

The developer is not a frontend person, so this spec removes taste from the critical path. The rule that makes it look good by default: the data is the visual. Big mono numbers, sparklines, a health grid, a tile grid. One accent colour, generous spacing, one typeface for text and one mono for numbers, motion only for the launch reveal.

## 0. Design tokens

Paper, not the earlier dark theme. The system is a visible 14 px cell grid,
hairline rules, very large light display type, and monospace micro labels in
wide uppercase, after craft.wild.as.

| Token | Value |
|-------|-------|
| Paper (background) | `#FFFFFF` |
| Surface | `#FAFAFA` |
| Border | `#E3E3E3` |
| Ink (text primary) | `#0A0A0A` |
| Text muted | `#6E6E6E` |
| Accent (up, good) | `#1A7F37` |
| Warn | `#9A6700` |
| Fail | `#C1341A` |
| Hairline | `rgba(10, 10, 10, .12)` |
| Grid line | `rgba(10, 10, 10, .06)` |
| Text face | `"Helvetica Neue", Helvetica, Inter, system-ui, ...` |
| Mono face | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| Cell | 14 px. Every spacing value is a multiple |
| Spacing scale | 14, 28, 42, 56, 84, 112 |
| Gutter | 56 px |
| Radius | 26 px, one value everywhere |
| Max content width | 1176 px |

### Fill colours, which are never text

| Token | Value | Contrast on paper |
|-------|-------|---|
| Neon | `#D8FF00` | 1.15:1 |
| Yellow | `#F5C518` | 1.63:1 |
| Blue | `#3B5BD9` | 5.70:1 |
| Navy | `#1C2541` | 15.10:1 |
| Red (fill) | `#E0492A` | 4.07:1 |

Neon and yellow exist only as large blocks of colour: pixel cells, the hero
field, a fill behind nothing that has to be read. Using either as a status
colour would put a 1.15:1 value on the one page whose job is being legible.
This is the part of the reference system easiest to get wrong by pulling hex
codes out of a screenshot, so it is written down.

### Two deliberate departures from the reference

1. Muted text is `#6E6E6E` (5.10:1), not the reference's `#8B8B8B` (3.41:1),
   which that site sets at 10 px. Copying it would have imported a legibility
   bug into every micro label on the page.
2. Status colours are darkened relatives rather than the reference's own red,
   so each passes AA against paper. Measured with `contrast()` in `tokens.ts`
   and asserted by test, not eyeballed.

### The background pixel field

A canvas behind the page. The cursor deposits heat into a grid, heat decays each
frame, and thresholds map heat to the fill ramp: navy, blue, yellow, red, neon
from cold to hot. The trail is the cooling, which is why a hover highlight does
not look like this.

| | Value | Why |
|---|---|---|
| Field cell | 9 px | **Not the 14 px layout cell.** The drawing grid and the spacing grid are separate decisions; using 14 for both made the trail chunky and half again as wide |
| Brush radius | 4 field cells, 36 px | Sized off a screen RECORDING. A still of a fast sweep shows accumulated heat along a path, not the brush, and sizing from it gave a 90px radius that reads as a stain |
| Deposit | 0.34 per move, interpolated between events | A fast sweep fires few pointermove events, so endpoint-only deposits draw a dotted line |
| Decay | 0.965 a frame, hard zero below 0.02 | It must reach exactly zero, or the loop never stops on a visitor's machine |
| Dither | Bottom 0.12 of the coldest band, from a stable per cell hash | This is what makes the edge read as pixels instead of a circle |
| Pac-Man | Released by a click, dismissed by moving the cursor. 8 cells of radius | Something the visitor did, not something they wait out |
| Idle shapes | After 2.4s still, the blob BECOMES a heart, star, smiley or spark, held 1.5s then released | The blob becomes the shape. It does not spawn one nearby, which would be two objects |
| Heading arrow | Near a heading (300px across, 60px up or down) the blob becomes an arrow facing it in one of four directions, about 80px on its long axis. The round brush is suppressed and the field cools at 0.72 | Two thresholds, not a radius. 260px missed the right of a card; 380px made the cursor an arrow everywhere, because headings are dense here. Direction: inside the heading's columns is always vertical, outside it follows whichever axis the heading's centre is further along |
| Recomputed on | pointermove **and scroll**, and on scroll a shape that stops being one is cleared and replaced with the blob in the same frame | Scroll moves the heading rather than the cursor. Clearing the state alone leaves the old shape fading where a blob should be |
| Image hover | The screenshot holds at about 46 blocks for 14 frames, then resolves to sharp over 58, and the overlay removes itself | Holding it pixelated hides the card's evidence. At 300ms nobody could tell it had happened at all |

It does nothing without a fine pointer and nothing under
`prefers-reduced-motion`. The canvas is `pointer-events: none`, because it
covers the viewport and would otherwise be a full screen shield over the one
control the site exists for. The board and the cards carry a translucent paper backdrop with a blur: they
sit above the field, so an opaque one hides every effect underneath it while the
effect goes on being drawn correctly. Readable text over a moving colour is the
thing the blur buys.

### Type

Numbers are always larger than the label above them, and a label is always a
monospace uppercase micro label. **Monospace data is not a label and is never
uppercased**: the health wall prints snapshot ids and ISO timestamps in it, and
`text-transform: uppercase` turned `snap_dl6c3hu908ru` into an id that does not
exist. `.label` transforms, `.mono` does not.

Colour carries only three meanings: accent for live and good, warn for degraded,
fail for down. No gradients, no shadows, no illustrations. The one ornament is
the hero field, and it is drawn from real canary history so it cannot show a
healthy pattern the checks did not earn.

## 1. Catalog page

Mobile first, single column at 360 px, two columns from 720 px.

**Live board strip**, sticky at the top, four cells in a row that wraps to 2 x 2 on mobile:

`INSTANCES RUNNING 1` · `LAUNCHED TODAY 34` · `MEDIAN FORK 1.14s` · `CREDITS $16.42 / $20.00`

The credit gauge is a thin horizontal bar under its number, accent-filled, with the used portion in muted grey. It updates over SSE every 5 seconds. If the SSE stream drops, the numbers stay and a small muted dot next to the strip goes grey with the tooltip "last updated 40s ago". Numbers never vanish and never show a spinner.

**App cards**, one per catalog entry:

- 16:10 canary screenshot, real, with a small mono caption reading the canary timestamp.
- App name, one-line description, category chip.
- "Try this first", three numbered lines, at most 8 words each.
- Footer row: license, upstream link, and last fork time for that app in mono.
- Launch button, full width on mobile, with the slots indicator inline: `Launch · 2 of 2 slots free`. When 0 slots are free the button reads `Join queue · 1 ahead of you` and stays enabled.
- If the app's canary is failing, the button is disabled and the card shows `Down since 14:20` in fail colour with a link to the health wall. Never a broken launch.

## 2. Launch sequence

Tapping Launch replaces the card content in place with the timer panel. No page navigation, no modal.

**The timer has two moments, not one.** Measured warm path for Gitea: the instance is **ready at about 4.0 s** and the app is **in the visitor's browser at about 5.5 s**. A single number counting to 5.0 and then freezing is five seconds of dead air on a phone, and it also hides the more interesting fact, which is that most of that time is not Blink's code.

A mono number at 56 px counts up in hundredths from 0.00 s, driven by `requestAnimationFrame` against a server-anchored start time. It **stops twice**:

| At | Number does | Label reads |
|---|---|---|
| ~4.0 s | first stop, accent flash | `ready` |
| ~5.5 s | second stop, final | `in your browser` |

Between the two stops the number keeps counting, so the visitor sees motion the whole way rather than a frozen digit. The first stop is the honest moment the instance became usable; the second is the honest moment they could see it.

State pills fill left to right beneath:

| State | Label | Note |
|-------|-------|------|
| 1 | `queued` | Only shown if actually queued, with position and estimated wait under it |
| 2 | `resuming your instance` or `building your instance` | Chosen before the timer starts, never changed mid-run |
| 3 | `checking it answers` | The loopback health check. Typically 281 ms, so this pill is a blink |
| 4 | `ready` | First stop |
| 5 | `loading it in your browser` | The visitor's own first request |

### The tail is published as a platform number, not an app number

**Decision, 2026-09-03, and it is reversible in one edit.** The p50 is published **per app**: Gitea 5.5 s, Jaeger 5.3 s, a 2.9% spread. The **p95 is published once, pooled across apps, as a platform figure.**

The reason is that the tail is not an app property and the data says so. Sorted Gitea warm resumes: eighteen samples between 3.3 s and 4.1 s, then 5.3 s, 10.0 s, 15.8 s. Jaeger: nineteen between 3.0 s and 4.1 s, then one at 8.9 s. Eighteen of Gitea's twenty are *faster* than Jaeger's median. Gitea's p95 is worse only because it drew two slow resumes instead of one, and at n=20 the difference between "p95 is 12 s" and "p95 is 6 s" is a single draw.

Publishing Gitea 11.9 s against Jaeger 6.5 s would attribute to Gitea something there is no evidence is Gitea's. Pooling gives **3 of 40 warm launches over 8 s, and a pooled p95 of 10.5 s**, whose subject is the platform, which is what actually varies.

This does not conflict with the rule below. That rule forbids averaging apps into an app-shaped number. This reports a platform number as a platform number, and every per-app number stays per app.

**What would overturn it:** more samples. n=20 is enough for a median and not for a tail, and a tail claim is precisely the one this sample size cannot support. If a later run shows the slow resumes concentrating in one app, the p95 goes back onto the cards and this section is deleted.

**The headline names its app.** It reads `Gitea, in your browser in N seconds`, never a bare number and never a number belonging to no particular app. Gitea is what the recording shows and what the first catalog card shows, so Gitea's measurement is the one the headline carries.

**Blending two apps into one figure is forbidden for the same reason blending cold and warm is forbidden (D2).** An average of two apps describes no launch anyone ever had. If Gitea and Jaeger diverge, both numbers appear on their own cards and the headline still names Gitea; it does not quietly become a mean. The rule is the same one the whole project rests on: publish a number something actually measured, and say what it measured.

**The headline number on the page is the one the visitor experienced, not the one that flatters.** Leading with 3.7 s and putting 5.0 s in the detail reads as a dodge even when the detail is right there. Leading with 5.0 s and then showing that most of it is not Blink's code is the stronger claim, because the 281 ms figure is the one that is actually ours and it is the best number on the page.

### The decomposition, directly beneath the timer, not behind a link

Rendered as four rows the moment the timer stops. Exact copy, written to be understood in one read by someone who does not know what a sandbox is:

```
Your Gitea took 5.5 seconds to reach your browser.
Here is every part of that.

  3.6s   Solari woke your private machine from a snapshot
  0.3s   Gitea started answering inside it
  1.3s   your browser fetched the first page over the internet

  0.3s of those 5.5 seconds was the app itself.
  The rest was waking a real computer and talking to it.

  Across both apps, about one launch in twelve takes
  10 seconds or more. In those launches the extra time
  is in the wake step, not the app.
```

Three rules for that block. It never rounds in Blink's favour. It never uses the words latency, p50, provisioning or orchestration. And the last two lines are the point of the whole panel: they say plainly which part is the app and which part is physics, and they let a reader draw the conclusion themselves rather than being told it is fast.

On a cold launch the same block appears with the measured cold numbers and a first line reading `No warm machine was free, so yours was built from scratch.`

Animation, exactly three: the state pills fill with a 120 ms ease, the panel border pulses accent once over 400 ms at each of the timer's two stops, and the instance link slides up 8 px at the second stop. Everything else is Blink. `prefers-reduced-motion` removes both.

Reveal: on mobile the instance opens in a new tab immediately on ready, no second tap. On desktop, if G2 passed, the iframe fades in below the toolbar; if G2 failed, a full-width accent button reads `Open your Gitea instance` and opens a new tab.

## 3. Instance page and toolbar (D5)

**Desktop with iframe (G2 pass):** toolbar as a 56 px bar across the top, instance iframe filling the rest of the viewport with a 1 px border.

**New tab plus toolbar (G2 fail, and all mobile):** the Blink tab becomes a toolbar page. Centre column, max 480 px: the countdown as the hero, then the buttons stacked, then a muted line reading `Your instance is open in the other tab`. On mobile the toolbar is a fixed bottom bar with the countdown left and a `···` that opens the rest as a sheet.

Toolbar contents in order:

1. **Countdown**, mono, `09:41`, turning warn under 2:00 and fail under 0:30.
2. **Extend +10 min**, disabled after use with the label `extended once`.
3. **Invite link**, a copy button on the `previewUrl` with the caption `anyone with this link can use your instance until it expires`. The URL carries a one-hour `pt_token` (`00-verification.md` V21), so it is a bearer capability and the caption is literally true. It is rendered only here, into the launching session's own page. It never reaches a log line, an OG image, the share page, the canary log, or a swarm report.
4. **Swarm**, opens the grid (section 4). Disabled with a reason on Free if slots are short.
5. **Destroy**, fail colour outline, single confirm, always visible, never behind a menu.

> **There is no Terminal button, and it is not greyed out either.** A `pty` panel was specified for v1.5 and has been cut to v2, blocked on a network control existing. G6 established that outbound cannot be restricted at any layer (`00-verification.md` V57), and a shell turns "the app can make outbound requests" into "the visitor can make any outbound request, interactively". A disabled control invites someone to enable it, so it is absent rather than disabled.

**Cost receipt modal**, shown on destroy, on expiry, and on lost instance:

```
Session receipt
Sandbox   1 vCPU / 2 GB   10m 00s   0.1667 h x $0.057/h = $0.0095
Browsers  12 tiles        45s       0.15 h  x $0.10/h  = $0.0150
                                            Total       = $0.0245
Plan: Starter. Rates from Solari pricing, computed locally.
```

The arithmetic is shown, not just the total. A partial receipt on a lost instance says `instance ended early (lost)` above the same table.

## 4. Swarm grid (v1.5)

12 tiles in 4 x 3 on desktop, 2 x 6 scrolling on mobile, 3 x 1 on Free. Each tile is a 4:3 frame of relayed screencast with a mono badge in the corner showing that tile's load time, and a thin border that goes accent when the tile matches the majority hash, warn when it does not.

Above the grid: `p95 640ms · 12/12 consistent · 31s remaining` in mono, plus a hard-stop bar counting down the 45-second cap.

**On the page itself, above the grid, one line in muted text:** `1.24s median is preview-domain routing under 12-way concurrency. The instance itself answers in under 1ms.` That line is not decoration. Without it a reviewer reads `p95 1242ms` and concludes the instance is slow, when the instance is the fastest thing on the screen.

**Expect per-tile load times near 1.2 s, and do not treat that as the instance being slow.** G5 measured the preview domain at **p50 265 ms per request sequentially** but **p50 1242 ms under 12 simultaneous clients** (V59), against an app service time of ~0 ms over loopback. Each of the 12 browsers is a fresh cookie jar performing its own `__pt_preview` token handshake (V60), which is a candidate cause. So the grid's own numbers are dominated by preview-domain routing under concurrency, not by the app. The tile badges say `load` rather than anything implying the instance is the bottleneck.

The honest comparison belongs on the page, because the true number for the app is the more impressive one:

| measured | value |
|---|---|
| instance response over loopback | **p50 0 ms**, max 1 ms |
| one request through previewUrl | p50 265 ms |
| twelve simultaneous through previewUrl | p50 1242 ms |

This is also the strongest thing the Swarm grid demonstrates: twelve real browsers hit a machine that was forked seconds ago and it answers each of them in under a millisecond of its own time.

Below the grid: a filmstrip of each tile's final screenshot at 80 px tall, horizontally scrollable, tapping one opens it full size with its hash and timing.

Degraded tiles (backpressure, section 7 of the architecture doc) show a muted `throttled` chip rather than freezing silently. A tile that failed to load shows its error text, not a blank box.

On completion, a `Share this run` button produces a static report page at `/swarm/:id` with the grid as final screenshots, all timings, p95, the consistency verdict, and the **app** id. No live feed on the shared page, so it costs nothing to serve.

**It carries no instance metadata.** The earlier spec said "app and instance metadata", and instance metadata is exactly where a `previewUrl` ends up on a permanently public page. The report has no instance id, no host and no URL (`03-security-and-access.md` section 3.4). It serves `X-Robots-Tag: noindex, nofollow, noarchive` and is disallowed in `robots.txt`, as does the share page at `/s/:token`.

## 5. Health wall and metrics

One row per app: name, a 24-cell canary strip for the last 24 runs (accent, warn, fail), last-run timestamp, current snapshot id and build date, and mono p50 and p95 for today.

**Each row also states what its canary actually asked**, in the app's own terms: `created an issue and read it back`, `ran a query against the sample database`, `completed a socket handshake`, `fetched the bundle and a font`, `returned a trace with spans`. Never `200 OK`, and never a bare tick.

This is not decoration. A status-code canary would have shown a green wall for a Gitea instance that was serving its **installer** (`00-verification.md` V73) and for an Uptime Kuma sitting in its database wizard (V70). Both answered their health path with 200 while being unusable. The strip promises the card is real, so it has to say what it checked.

Below, one chart per app: fork-time p50 and p95 per day for the last 14 days, cold and warm as two lines, drawn as a plain SVG line chart with no library, no legend box, and direct end-of-line labels. Two lines, two colours, that is the whole chart.

### Why every app gets its own number

A short block of prose above the per-app charts, because the comparison is the most interesting thing this page has and a reader will not derive it from four charts:

> Every app here is a different program with different startup work, and they are all served by the same platform. That splits the wait into a part that barely changes and a part that does.
>
> Waking the machine costs about the same no matter which app is on it. What differs is what the app does once it wakes. Gitea rewrites its own configuration and restarts before it will answer. Jaeger reopens its span store. One of those is slower than the other, and neither is something the platform can help with.
>
> So when two apps take different amounts of time, the difference is the app, not the machine. That is why the numbers below are per app, and why there is no single Blink number: an average across apps would describe a launch that nobody ever had.

**The comparison table** sits under that prose, one row per app, columns: `ready p50`, `ready p95`, `in browser p50`, `in browser p95`, `platform share`, `app share`. The last two split each total into the part that was waking the machine and the part that was the app starting, which is the whole argument in two columns.

If the apps land close together, that is itself the finding and the prose says so instead: the platform cost dominates and the app barely matters, which is a stronger statement about Solari than any single number.

### The soak figure says which number it is

The page carries a soak line, and **it names which of two different numbers it is showing.** They are not interchangeable and a merged figure is forbidden.

- **Continuous:** the longest uninterrupted stretch of soaking. This is the claim worth making, because it is the only one that can catch a leak appearing after many hours or drift in a long-lived process.
- **Accumulated:** distinct hours covered across separate runs. Real evidence, and a weaker statement, because no single process lived that long.

The soak runs on the deployed host precisely so the first number can be the one shown (`01-prd.md` section 9). If for any reason it cannot be, the page says so in the same plain language the cold and warm labels use:

> Soaked continuously for 6 hours on the host that serves this page.

or, when only chunked evidence exists:

> Soaked for 24 hours total across 9 separate runs. Longest uninterrupted stretch: 3 hours.

Never `Soaked for 24 hours` when the 24 is accumulated. The rule is the same one the cold and warm labels follow and the same one behind publishing p95 pooled rather than per app: **a number on this page states what it measures, and where two readings differ, the page shows the weaker one rather than the flattering one.** This page is the credibility of the whole project; a figure that means less than it appears to costs more than the smaller honest figure does.

Below that, the public canary log: reverse-chronological mono lines, `14:02:11 gitea ok fork 980ms health 240ms`, including failures and outages verbatim. Nothing is filtered out. This page is the credibility of the whole project, so it is linked from the footer of every page and from the post.

## 6. Queue and error states

| State | Copy |
|-------|------|
| Queued | `You are 2nd in line. About 3 minutes.` with a live position and a Leave queue link. |
| Daily ceiling reached | `Blink has hit its daily budget of 6 sandbox-hours. It resets at midnight UTC. Here is a recording of a launch, and the health wall is live.` |
| Out of credits | `The month's Solari credits are spent. The site stays up, launches are off until the 1st.` with the credit gauge at zero and the recorded launch inline. |
| Per-IP limit | `You have launched 5 instances today from this network. That is the cap.` |
| Solari unreachable | `Solari is not responding right now. Launches are paused. The canary log below shows exactly when it started.` |
| App down | `Gitea failed its last canary at 14:20 and is off the catalog until it passes.` |
| Instance lost | `Your instance ended early. Here is what it cost up to that point.` |

Every error names the limit or the cause and gives a number. No generic apologies, no error codes on their own, no dead ends: each state offers the recorded launch, another app, or the health wall.

## 7. Share page (fork-my-state)

`/s/:token`. Shows the app card, who-made-this framing (`someone set up this Gitea and shared its state`), the expiry date, the fork counter (`forked 4 times`), a single Launch button that runs the cold path against the share snapshot, and a small `Report this` link that is always visible, not tucked in a footer. Before the snapshot is created, the source visitor sees a plain warning that everything they typed will be copied into a public link.

**Creating a share snapshot is a ~10 second operation, not a ~1 second one, and the UI must say so.** G4 measured snapshot creation at **10.3 to 11.4 seconds** on a bare template; a seeded app will be slower. The Launch timer's language does not transfer: that timer counts up to a sub-second reveal and freezes on a number worth showing off. This one is a wait, and pretending otherwise makes it feel broken.

So the Share button gets its own state, not the Launch timer:

| State | Copy |
|---|---|
| 1 | `Saving your instance. This takes about 10 seconds.` with an indeterminate progress bar, not a counting-up timer |
| 2 | `Almost there.` after 8 s, so a slow one does not read as a hang |
| 3 | `Your link is ready.` with the URL, the 7-day expiry, and the copy button |
| Failed | `Could not save your instance. Nothing was shared.` plus the reason, and the instance keeps running |

No mono counter, no accent flash, no frozen number. The number is not the point here and showing one invites a comparison with the launch number that this operation will always lose. Share links are also capped at 12 live at once (`02-architecture.md` section 2.8): at the cap the button is disabled with `Sharing is temporarily full, try again in a few minutes` rather than failing after the wait.

## 8. OG images and badge

OG image per app, generated at snapshot build time by screenshotting a 1200 x 630 server-rendered page: app name, canary screenshot, the app's current warm and cold p50 in big mono, and the Blink wordmark. Same generator for a share link, with the fork count and expiry. The screenshotted page is a server-rendered catalog page, never a live instance, so no `pt_token` can reach the image. If the G1 kill criterion deletes the warm pool, the OG image carries one number, not two.

Try-it badge for READMEs:

```markdown
[![Try Gitea instantly](https://blink.example/badge/gitea.svg)](https://blink.example/a/gitea)
```

The SVG is served from the cache and shows the app's current median fork time, so a maintainer's README carries a live number.

**The OG generator never renders a link as text and is never pointed at a live `previewUrl`.** It screenshots a server-rendered catalog page, so no token can reach the image (`03-security-and-access.md` section 3.4).

## 9. Accessibility and performance

Accessibility: semantic landmarks, one `h1` per page, all controls reachable and operable by keyboard with a visible accent focus ring, `aria-live="polite"` on the timer's state label (not the counting digits, which would flood a screen reader), text contrast at 4.5:1 or better against `#FFFFFF`, touch targets at 44 px minimum, and the consistency flag conveyed by an icon and text as well as border colour.

Performance budget for the visitor path: server-rendered HTML, no client-side framework on the catalog page, under 40 KB of JavaScript on any page except the Swarm grid, no web fonts (system stack plus system mono), canary screenshots served as AVIF with WebP fallback under 60 KB each and lazy-loaded below the fold. First contentful paint under 1 second on a mid-range phone over 4G. Zero client-side Solari calls anywhere (D8); the only client requests that reach Solari indirectly are Launch, Extend, Destroy, and Swarm, and each goes through the Blink API.

## 10. The post

**Recording, 30 to 45 seconds, portrait, phone screen only, no voiceover, no music.**

| Time | Shot |
|------|------|
| 0:00 to 0:04 | The post on a phone, thumb taps the link |
| 0:04 to 0:08 | Catalog paints, live board strip visible, thumb scrolls to the Gitea card |
| 0:08 to 0:10 | Tap Launch |
| 0:10 to 0:14 | Timer counts. **First stop at ~3.7 s on `ready`**, then it keeps counting and **stops again at ~5.0 s on `in your browser`** as Gitea paints. Hold 1 second, then the decomposition block fades in beneath and holds 2 seconds. This beat is now 4 seconds rather than 3, and it is the most important shot in the recording: it is the only place the viewer learns that 0.3 s of the 5.0 s was the app |
| 0:14 to 0:22 | The seeded PR is opened, a comment is typed and posted, it appears |
| 0:22 to 0:27 | Back to the toolbar, copy the invite link, countdown visible |
| 0:27 to 0:38 | Tap Swarm, 12 tiles fill in, per-tile timings and p95 land, hold on the grid |
| 0:38 to 0:43 | Cut to the receipt modal with the arithmetic, hold 2 seconds |

No captions except one line at the end: the number and the cost. Record it after the 24-hour soak, on the real production site, in one take, unedited apart from trimming. A cut is fine; a fake is not.

**Post text (X variant, under 120 words):**

> **Post 1**
>
> I built Blink on @solari: pick an open source app, tap Launch, and a real seeded instance of it is in your browser in 5.5 seconds.
>
> Not a screenshot, not a shared demo. Your own machine, forked from a snapshot, dead in 10 minutes.
>
> 5.5s sounds slow until you see the split.
>
> **Post 2**
>
> 3.6s waking a private machine from a snapshot
> 0.3s the app starting inside it
> 1.3s your browser fetching the first page
>
> The app is the fastest part. Most of what you wait for is a real computer waking up.
>
> **Post 3**
>
> Five apps: Gitea, Jaeger, Excalidraw, Uptime Kuma, Metabase.
>
> Across all of them, about one launch in twelve takes over 10 seconds. I publish that too.
>
> Every fork time, every canary failure, and my credit balance are public.
>
> @harrychow

**LinkedIn variant:** same content, one thought per line, with two extra lines at the top framing the problem ("trying self-hosted software means installing it, so most people never try it") and one at the end naming the reliability angle (canary log, honest cold and warm numbers, budget ceilings that are visible rather than hidden).

**First reply, both platforms:** repo link, cookbook example link (`examples/blink`), and the health wall link, in that order, one line each.

## 11. Non-goals

No accounts. No dark mode toggle (the site is dark, that is the design). No dashboards beyond the health wall. No AI element of any kind. No third-party analytics. No cookie banner, because there are no tracking cookies to consent to.

## Verification status of this doc

Phase 0 ran 2026-09-03. Full record in `00-verification.md`. This doc's tags were always the most gate-dependent of the four, and they mostly still are.

**Resolved:**

1. `previewUrl` carries a one-hour `pt_token` (V21). Section 3's invite-link caption is literally accurate, and section 8 now states why no token can reach an OG image.
2. Item 5 below is partly settled by reasoning rather than measurement. Gitea, Jaeger and Excalidraw render usable first screens unauthenticated. Uptime Kuma's own health check is "`GET /` returns the login page" and Metabase gates on setup, so those two **will** screenshot a login screen unless the canary logs in first. The contingency applies to exactly those two apps and can be scheduled now rather than discovered later.

**Still [UNVERIFIED]:**

1. Whether the desktop iframe layout is used at all depends on G2 (framing headers on `previewUrl`). Nothing about the preview domain's headers is published, so this is entirely a measurement.
2. The recording beat at 0:10 to 0:13 assumes a warm resume near 1 second. The real number from G1 replaces it, and the post text is written after G1, not before. **Good news from G5: there is no ~1.2 s floor.** The preview domain costs about 265 ms per request sequentially, and the health check now runs over loopback where service time is ~0 ms (V59), so fork-to-healthy is a fork-speed number rather than a routing number. G1 reports fork, health-complete and previewUrl-first-byte separately so the reveal can be timed honestly. **Still open**: snapshots restore memory as well as disk (V22), so cold may land within noise of warm, and if the G1 kill criterion fires there is no "warm resume" label to show at all. The recording's central beat, and the post line about never blending cold and warm, both wait on G1.
3. Screencast tile frame rate and grid smoothness at 12 tiles depend on G5. Unblocked: `cdpEndpoint` comes back directly on `sessions.create()` (V11), and Starter allows 20 concurrent browsers against a needed 12 (V28).
4. Whether snapshot storage is billed (Q18) changes nothing visual, but it decides whether the credit gauge is complete. The gauge is **labelled an estimate** regardless, because Solari exposes no balance endpoint to reconcile against (`00-verification.md` V55): the caption reads `estimated from our own ledger` rather than implying a reading. An unlabelled gauge that drifts is worse than an honest estimate, and this page's whole argument is that the numbers on it are real.
5. `blink.example` is a placeholder domain; the real hostname is set before the badge and OG URLs are published. The project was renamed from `instant` to **Blink** after these docs were first written, so the wordmark, badge URLs, OG URLs, post text and the cookbook example path (now `examples/blink`, D12) all carry the new name and none of them are final until the hostname is.
6. Whether the two login-gated apps' canary screenshots need a scripted login before capture. See the resolved note above: they do.
