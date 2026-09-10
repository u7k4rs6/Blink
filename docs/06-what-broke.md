# What broke, and what each one taught

Every entry here is a bug found in this project, in this repository, by the
person who wrote it. They are kept because the interesting ones share a shape:
a control that exists, passes its own test, and cannot fire. A green signal is
worth exactly as much as the thing it actually measured.

The dated, evidenced version of all of this is
[`00-verification.md`](00-verification.md), 115 rows.

## Three mistakes we found in our own measuring

Every timing on this site is published as its parts rather than as a total. This section is why.

Three times now, a number here was wrong. Each one made Blink look **worse** than it is. None was caught by a test, because all three produced entirely plausible numbers. And all three had the same underlying shape, which is the part worth reading:

> **Every one of them was a number we derived rather than observed.**

**1. The health check was measuring the network, not the app.** The original design polled the app's health endpoint through its public URL. That route costs a few hundred milliseconds per request, and the poll loop runs up to 60 times, so "how long until the app is ready" was mostly "how long the internet takes". Health checks now run over loopback *inside* the machine. The app answers in **281 ms**. We would have published a far worse number and blamed the app for it.

**2. One timer measured two things and was named after one of them.** A field called `previewFirstByteMs` timed an API call to look up the URL *plus* the first request to it, and reported the sum as though it were network time. Splitting them is what revealed that the API call could be moved off the visitor's path entirely.

**3. We subtracted two numbers from different runs and believed the answer.** Having split that timer, we estimated the API call's cost by taking a measurement from one run and subtracting a measurement from another. It gave about 1,035 ms and it looked reasonable. When the split was measured directly on the next run it came back at **255 ms on a fresh machine and about 1,275 ms after a resume**: not one number at all, but two, five times apart, and the average of them was not either. An entire design decision had been justified on the arithmetic before anyone measured the thing.

The third is the one that changed how this project works. The first two were bugs; the third was a habit. Arithmetic across separate measurements feels like analysis and is actually a guess wearing a number's clothing. So the rule now is that a figure gets published only if something measured *it*, and anything derived is labelled as derived until it is not.

## Five bugs, and what separates them

### The first three: correct code, wrong job

**The ceiling race.** The budget guard read the total spent, compared it to a ceiling, then wrote a reservation. Three separate `await`s. Two visitors arriving together both read the same total, both passed the same check, and both were admitted: a 1,000 second ceiling ended up holding 1,100.

**The false-pass gates.** A measurement gate streamed zero frames and reported "within budget", because its threshold was `bandwidth <= expected` and zero satisfies it. Another concluded a security control had failed when it had never reached the test.

**The lock that locked nothing.** The fix for the first bug was a Postgres advisory lock. Run against the real database, it turned out that two callers sharing one connection get a second `BEGIN` that is a no-op against the open transaction, both bodies run inside the same transaction, the advisory lock is re-entrant within it, and the first `COMMIT` ends it for both. It issued every statement it claimed to issue and excluded nothing. No error, no exception, exit code zero, and a server NOTICE nobody was reading.

That third one is the sharpest of the three, because it was the *remedy* for the first, and it was wrong in the same way the thing it was fixing had been.

All three were code that did **exactly what it said and not what it needed to do**. That is why the tests missed them: every test was derived from the design, so it asked the same question the code answered and got the same answer. What caught all three was probing the behaviour instead of the description.

### The fourth was different, and worth separating

**The day boundary.** A `date` column read through node-pg becomes a JavaScript `Date` at **local** midnight. Formatting it with `toISOString()` converts to UTC first, so east of UTC the day shifts backwards. Every per-day ceiling would have been keyed to the wrong bucket for the first five and a half hours of every day: daily caps resetting early, spend counted against yesterday.

This one was not code doing the wrong job. **The design was right, and the code was correct in every environment it was tested in.** It was correct through the REST layer, which returns a date as a plain string. It was correct in the memory store, which never converts anything. It was correct in every unit test. It was wrong only in the real driver, in the real timezone, against the real database.

Different mechanism, same cost. The first three needed a better question; this one needed the real environment, because no amount of questioning a stand-in would have produced it.

### The fifth was a postcondition that asserted the wrong property

The guest-side self-destruct is the mechanism that stops an instance after ten minutes regardless of what the visitor is doing. It matters more than it sounds: the other two expiry layers are both defeatable by an active visitor, and there is no network-level control available at all, so this one carries abuse containment alone.

It was armed with `pkill`. The base image has no `procps`, so `pkill` does not exist. **It would have failed silently on every instance of every app.**

The recipe step that installs it passed on every build. Its postcondition asserted that the script was written and executable, which was true, and irrelevant. `pkill` would have printed "not found" into a log nobody reads, the process would have kept running, and the only remaining backstop is an idle timer that visitor traffic resets.

It was found because an unrelated memory measurement happened to need `pgrep`. That is luck, not process.

**The general rule, which is the most transferable thing in this file:**

> A control is tested by making it fire. Never by confirming it was installed.

"The file exists", "the flag is set", "the config parsed", "the handler is registered" are all statements about arrangements, and every one of them can be true while the control does nothing. The only evidence that a kill works is something dying. Every recipe now proves the mechanism by signalling the real process, and every control whose sole evidence was the existence of its own code has been made to fire at least once in a test.

So every control in the codebase now sits in one of two lists in `docs/05-control-audit.md`: proven by being driven to fire in a test, or explicitly named as unfired. There is no third list for controls that look covered. Three are in the second list: the self-destruct timer itself, which needs wall-clock time in a real sandbox and fires in the 24-hour soak; the dead-man refresh, which is specified and not implemented; and `assertZeroLive`, which only means anything against the live platform.

### What happened when the rule was actually applied

The audit that came out of the fifth bug turned every control into something that gets driven to its trip condition in a test. Writing those tests caught two more bugs, both in code written that same hour, and both of the same family as the one that prompted the audit.

The first was mine, minutes old. Making each recipe assert its prerequisites up front, I had Gitea's step assert `git`. The recipe apt-installs `git` six lines further down. It would have failed every Gitea build, and it would have failed with a message pointing at a missing binary rather than at the check that was wrong about when it ran. `prerequisiteStep` now refuses at construction to assert anything the base image is known to lack, so the class is gone rather than that one instance.

The second is the more interesting one, because it had no failure mode at all. The Uptime Kuma recipe recorded its snapshot under `uptime-kuma`; the gates look it up as `uptimekuma`. Nothing throws. The gate reads the registry, misses, and skips cleanly, which is exactly what it does when a snapshot has genuinely not been built yet. A whole app would have been quietly absent from every measurement, and the run would have looked correct. Registry keys now come from the app table rather than from a string literal, and a test reads every recipe's source to confirm it.

That second one is worth stating plainly, because it is the failure mode this project keeps producing: **not a break, but a success that means nothing.** A skipped gate, an installed script that cannot run, a postcondition about a file. None of them fail. All of them are silence dressed as a pass.

### The same bug again, in the health checks

The `pkill` failure was a postcondition that was true and irrelevant: the script had been written, and the script was executable, and neither fact was the one that mattered. Both were statements about an arrangement rather than a capability.

Every health check in this project was making the identical error, and it took Uptime Kuma to show it. Uptime Kuma 2.x refuses every socket connection until a database has been chosen, and sits in its setup wizard doing so. While sitting there it answers `GET /` with **200**. The health check asked for that 200 and got it, three consecutive builds running, against a server that could not accept a single client.

`GET /` returning 200 is true. It is also irrelevant. It proves a process is listening and holds no opinion about whether the application works, and for any app whose real interface is not an HTTP GET the two can disagree indefinitely with nothing to notice.

So every check now exercises the thing the app exists to do:

| App | What it now does |
|---|---|
| Gitea | Writes an issue through the API and reads it back, comparing the title. A read-only check passes against a Gitea whose disk is full, a state this project produced twice |
| Jaeger | Returns a seeded trace **with a non-zero span count**. A trace with no spans renders as a blank page |
| Metabase | Authenticates, then runs `select count(*)` against the sample database. A detached database leaves every question empty while the API stays up |
| Excalidraw | Fetches the JS bundle and a font, not the shell that references them. Any static server serving an empty directory returns an index.html |
| Uptime Kuma | Completes a socket.io handshake, its UI being websockets end to end |

Each reports what it asked as well as whether it passed, because a canary that says "down" without saying what it asked is a canary people learn to ignore. The priority was the canary specifically: it is the thing that promises a catalog card is real, and a canary built on status codes promises nothing.

Nine tests drive each check against a server that answers but cannot work, including one where Gitea accepts the write and returns a different issue on the read.

### The third time: the health check bug with a camera on it

Each catalog card carries a screenshot of a real instance, captured by the canary from the instance it just launched. Five cards, five green captures, five PNGs on disk with today's timestamp. Then someone looked at them.

Metabase showed **"This dashboard is empty"** under a card promising a seeded sample database. Excalidraw showed a blank white canvas with a single sentence clipped mid-word, which reads as an app that failed to load. Uptime Kuma showed two monitors whose names both truncated to "This instance..." and a last-checked time three weeks in the past, on an instance thirty seconds old. Two of the five actively contradicted the claim printed underneath them.

Nothing was broken. The apps were running, the instances were seeded, the captures succeeded. The capture just fired wherever the app happened to open:

- Metabase opens on a dashboard that is empty until a table x-ray has run, which needs field fingerprints a fresh fork has not computed.
- Excalidraw opens on whatever is in `localStorage`, and the seeded scene was one line of text. A canvas with one line on it photographs exactly like a canvas whose seed failed.
- Uptime Kuma opens on a monitor list. A list shows names; it does not show that anything has been checked recently, and the newest heartbeat in a snapshot is from the day the snapshot was built.

This is the health check bug in a third form. `GET / -> 200` proves a process is listening and holds no opinion about whether the app works. A screenshot of whatever page the app opens at proves the app rendered and holds no opinion about whether it has anything in it. Both are true postconditions about the wrong property, and both pass forever against an instance that is up and empty.

The fix has the same two parts the health checks had. Every capture now names its view deliberately, and every capture asserts what has to be on screen before the shutter opens:

| App | The view, and what has to be there |
|---|---|
| Gitea | The issue list of the seeded repo, which carries the three seeded issues and the one the canary just wrote. All three seeded titles present |
| Jaeger | The trace search results for the seeded service. At least one trace drawn |
| Metabase | An ad hoc question serialised into the URL, run against the sample database. More than ten cells of real rows, so a spinner or an error card fails |
| Excalidraw | The board, after a fourteen element diagram is written into the fork and loaded. Scene loaded and canvas mounted |
| Uptime Kuma | A monitor detail page reached by clicking the sidebar, not a guessed `/dashboard/1`. A renamed monitor with heartbeats on screen |

Writing those assertions produced two more findings in the same hour, both worth more than the bug they came from.

The first set of expressions counted CSS classes: `.issue.list li` for Gitea's pull requests, `.ResultItem` for Jaeger's traces, `.beat` for Uptime Kuma's heartbeats. Four of five returned zero on pages that were entirely correct. Gitea 1.27 does not use that class and the others were guesses at framework internals. So the fix was to stop guessing: a probe that forks one instance, drives the same script the canary drives, and prints what is actually on the screen. The assertions were then written against measured text, and they now name content the card is claiming (the seeded pull request by title, the trace count Jaeger prints above its list, the monitor name and the labels at each end of the heartbeat bar) rather than markup, which is a theme's business and changes between releases. Five probe runs, about a cent.

The second is the older pattern wearing new clothes. These expressions live in TypeScript template literals, where `\b` is a backspace character and `\d` is the letter d. Two of the five, written the obvious way, compiled to regexes that could not match anything. They were false on every page, correct or not. The symptom would have been two cards with no picture and no error recorded anywhere. That is the `pkill` failure exactly: code present, code shipped, code incapable of firing. It is now guarded by a test that runs each expression against a good page and against the page that actually shipped, and by a second that rejects any expression containing a literal backspace.

`shotExpect` is the part that generalises. It is one expression per app, evaluated in the page after the settle delay, and if it is not true the capture throws instead of writing a PNG. A card with no picture is a visible problem. A card with a picture of an empty app is an invisible one, and it was invisible for the entire time the feature had existed.

Gitea moved twice. The pull request list was correct and nearly empty, one row on a page of whitespace under a card promising a repo with things in it, and its tab bar read `Issues 4` beside card copy saying three, with nothing on screen to explain that the canary had filed the fourth. The issue list shows the seeded state and the health check that proves it in the same frame, so the count explains itself. The canary's own issue was titled `blink-canary-1788954172025`, which is unique but reads as noise; it is now `Blink canary check <timestamp> UTC`, still unique to the millisecond because the read back only proves anything if the title it compares could not have come from a previous run.

Two of the underlying fixes had to happen at fork time rather than in the snapshot, for the same reason Jaeger has a `postFork`. Uptime Kuma's monitor names are baked in and a rebuild fixes them; its heartbeat timestamps are not, and no rebuild ever will be, because the newest beat in any snapshot is as old as the snapshot. Excalidraw's scene could have been rebuilt, but a SIZE_LARGE build for a drawing is not a good trade, so the scene lives in one constant that both the recipe and the fork time write read, and they cannot drift.

One control had to be widened rather than added. The Uptime Kuma monitors may only point at loopback, because egress cannot be restricted and a seeded third-party URL would aim every instance Blink ever launches at somebody else's server. That control read the seed script for `url:` keys. Moving the monitors into a JSON constant turned the key into `"url":`, and the control went on passing while matching nothing, including its own "found at least one" guard, because the guard read the same source. It now scans for URLs rather than for the syntax that happened to contain them, and it scans the fork time script too. A control keyed to the shape of the thing it guards stops guarding the moment that shape changes.

### The signal nobody had read

The site runs from a laptop behind a Cloudflare Tunnel, so a Worker serves an offline page when the origin is unreachable. Building it, the trap was obvious enough to write down at the time: once the Worker is live, a broken origin renders as a working offline page. A visitor sees a calm apology whether the laptop is asleep, the server is wedged, or Blink is throwing 500s. So the page carries `x-blink-origin`, invisible to a visitor and one curl away for the operator, naming which of the three it is.

Then a visitor hit a real outage and saw the page. That was the first evidence the fallback fires at all. Nobody had ever read the header.

Reading it took a deliberate 46 second outage. It said `origin-530`, and the page it was attached to said this:

> **Blink is asleep right now.**
>
> The machine is awake but returned an error (status 530).

Four lines apart, on the same screen, to the same visitor.

Cloudflare's edge synthesises a status when it cannot reach a tunnel origin, so the Worker's `fetch` resolves with a response rather than throwing. The classifier read "a response arrived and it is 5xx" as "the origin answered and is failing", which is true of a 500 from Blink and false of 530, Cloudflare error 1033, **tunnel not connected**. That is the only failure this deployment routinely has. The classifier was wrong in exactly the case it was written for, and right everywhere else.

What makes this worth its own entry is not the mapping. It is that the fallback working for the visitor is what hid it. The page came up, the outage was handled, and the one part that was broken was the part whose whole job was to tell me which thing had broken. A signal that has never been read is not evidence. It is a plan to have evidence, and it fails silently the entire time it is untested, because there is nothing to notice.

### The check that passed while the front door was locked

Every health check in this project once asked `GET / -> 200`. Uptime Kuma proved that worthless by sitting in its setup wizard answering 200, so all five checks were upgraded to exercise the thing the app exists to do. Uptime Kuma's now completes a socket.io handshake, because its UI is websockets end to end.

Then someone pressed Launch and landed on an error page.

The app was fine. On loopback its root answers a **302 to `/dashboard`**, and `/dashboard` answers 200. The problem is the word *relative*. A `previewUrl` carries its capability in the query string, and a relative redirect throws the query away. Measured on a live fork:

| | |
|---|---|
| loopback `/` | 302 to `/dashboard` |
| loopback `/dashboard` | 200 |
| `previewUrl`, no cookie jar | **401** |
| `previewUrl`, with a cookie jar | 200 |
| `/dashboard`, token re-attached | 200 |

So a browser survives it, on the `__pt_preview` cookie alone, and everything without a cookie jar does not. That is the same mechanism as the `at()` bug two sections up, in a place nobody had looked.

What makes it worth its own entry is the check. The socket handshake passed continuously, and it was right to: socket.io is mounted independently of the SPA's routes, and the handshake URL carried the token because the code built it deliberately. **A working API and a broken front door are compatible.** The upgraded check tested the app's real interface, which was the whole lesson of the previous entry, and it still never asked the one question a visitor asks first.

Every check now loads the front door before it touches an API, through a `firstScreen()` that follows redirects the way a browser does: carrying cookies, and re-attaching the capability to every hop that dropped it. Each app asserts text identifying its own landing page, because "200 and some HTML" is the class of check this whole file exists to replace.

The part I would keep if I kept one thing: **I found this by clicking the button.** Not from a canary, not from a gate, not from the soak. Every layer said healthy, and every layer was measuring something true. The reviewer's path had been verified end to end for exactly one of the five apps, and the other four had only ever been checked by machines asking the questions I had thought to write down.

### A screenshot of something that existed for nobody but the canary

The five catalog cards each carry a screenshot of a real instance, captured by the canary from the instance it just launched. Earlier work made those captures land deliberately: not wherever the app happens to open, but on the one screen that proves the instance is seeded. That fixed a real problem and created a worse one, and it took a person clicking Launch to find it.

Checking all five first screens against their cards, only one matched. Gitea landed on its marketing page while the card showed the seeded repo. Jaeger landed on an empty search form while the card showed six traces. Uptime Kuma and Metabase landed on password prompts, and the site never printed the passwords anywhere: `src/web/*.ts` did not import the credentials module at all, while Uptime Kuma's card said **"logged in"**.

Those four are the same shape: the card photographs a deep path, the handover drops the visitor at `/`. Wrong destination, right screen. Excalidraw is worse than that, and it is the purest form of the pattern in this project.

Excalidraw's card showed a fourteen element diagram. The visitor got the empty splash screen. Not a different page: **the same page, in a state the visitor could never reach.** Excalidraw reads its document from `localStorage`, and the seeded board was written to a file on disk. The only thing that ever loaded that file into `localStorage` was `shotScript`, the script the canary injects into the page before it opens the shutter.

So the card was not showing the wrong screen. It was showing a state that **did not exist for anyone but the canary**, produced by machinery no visitor has, and it would have gone on showing it forever, because every check that could have caught it ran through the same injection. The canary was photographing its own reflection and the picture was accurate.

The fix is that the scene is injected into `index.html` ahead of the bundle, so the document is already there when the app boots, for everyone. It is guarded on the key being empty, so a visitor who draws something never has it overwritten by a reload.

**The rule this leaves behind:** when a check has to set something up before it can observe, ask who else performs that setup. If the answer is nobody, the check is measuring a state that only exists because it is being measured. Every capture in this project passes that question now, and the first screen test is the acceptance bar for the catalog: a card that does not match its arrival does not ship.

### Reproducing a symptom is not finding a cause

A visitor reported that Gitea arrived with its seeded data intact and no styling at all. Every asset failed.

I reproduced it in about four minutes. Fetch an asset from a live instance with no cookie and no token and the preview edge answers **401**; fetch the same path with either and it answers **200**. There was the failure, on demand, matching the symptom exactly. So the question became: why is the browser not sending the cookie?

That question occupied the next several hours. I measured the `Set-Cookie` attributes on a live fork and found it was `Partitioned`, which is unusual enough to look guilty. I checked whether a stale cookie from an earlier instance could poison a new one, and ruled it out because the `Domain` is host-scoped. I built a CDP probe that captures the cookie verdict on every subresource, navigated to Blink first so the partition context would match a real click-through, and read the partition key: `https://getsolari.com`, `hasCrossSiteAncestor: false`, every asset **sent**, zero failures. The reporter checked their own browser and got the identical partition key. We ruled out extensions. We ruled out the profile, because it failed in incognito too. I wrote a checklist of Chrome settings and policies. I checked the Public Suffix List, found `getsolari.com` absent, and concluded that every customer's sandbox shares one registrable site. I began scoping a Service Worker to make every request carry the token so we would never depend on the cookie again.

Then the reporter read the failing request:

```
/blink/welcome/arm/assets/img/favicon.png    404, with Gitea's own headers
```

**404, not 401.** From the app, not the edge. The token and the cookie had both worked perfectly the entire time. The path was simply wrong: `arm` had been prefixed onto it.

`blink-boot` takes `<root_url> <lifetime_seconds>`. The runner called it as `blink-boot arm 660`, inventing a subcommand the script does not have, so Gitea's `ROOT_URL` was set to the literal string `arm` on every launch. Gitea then emitted `arm/assets/...` as a relative URL, which the browser resolved against whatever page it was on. One wrong argument, in one line, since the day the launch path was written.

**What went wrong is not that I failed to guess it.** It is that I never read the failing request. I had a reproduction that produced the same visible symptom, and I treated that as evidence I had found the cause. It is not. It is evidence that two different faults can produce the same appearance, which is the ordinary case rather than the exception. Thirty seconds in the Network panel would have shown a 404 where I was assuming a 401, and none of the rest would have happened.

The part that makes this worth writing down rather than just admitting: **the wrong path produced a genuinely valuable finding.** `preview.getsolari.com` really is absent from the Public Suffix List, every customer's sandbox really does share one registrable site, and that really is worth reporting to the vendor. Being rewarded on the way is exactly what makes this failure mode so hard to abandon. Each step was competent work, each answered its question correctly, and the whole sequence was addressed to a problem that did not exist.

So the rule, stated so it can be checked rather than admired:

> Reproduce the symptom **and** read the actual failure before forming a theory. A reproduction that matches the symptom is a hypothesis, not a diagnosis, and the cheapest thing in the whole investigation is usually the one nobody does: look at the request that failed.

### A rule, because this is the third time

`blink-boot` survived every check for a reason worth stating plainly: **no check ever ran it.** The canary forked a snapshot and health-checked it. The first-screen bar forked a snapshot and rendered it. Neither ran the boot script, so both saw an instance whose `ROOT_URL` was still the placeholder, with correct asset URLs that no visitor was ever given. The bar cheerfully reported `assets OK: 9 loaded` for a page that arrived unstyled for a real person.

That is the third occurrence of one shape. V80: a fix applied to the visitor path and not to the canary, producing a false alarm indistinguishable from a true one. V103: a screenshot of a state produced by the canary's own injection script, which existed for nobody else. Now V107: a check forking a snapshot the launch path would have modified before anyone saw it.

Three instances is not a coincidence, so it stops being a note and becomes a rule:

> **Every check takes the visitor's path in full, including every step the launch path performs.** A check that forks the snapshot directly is testing an artefact no visitor ever receives. If the launch path runs a script, patches a config, or injects a file, the check runs it too, or the check is measuring a different machine.

The canary and the acceptance bar both run `blink-boot` now, with the same arguments and in the same order as a launch. The general form of the question, which is cheap to ask and has now paid three times: **what does the visitor's path do that this check does not?**

### A different mechanism: correct code, wrong environment

Every bug above was a test asking the wrong question. This one is not. It is a standard library function doing exactly what it documents, in code that is correct everywhere except the one place it runs.

`new URL(path, base)` resolves a relative path against a base and discards the base's query string. That is correct, specified, and what you want almost always. It is wrong when the query string **is the credential**.

Solari's `previewUrl` returns a capability URL: `https://<id>-3000.preview.getsolari.com/?pt_token=<token>`. The token in the query is the entire authorisation. So a liveness check that loads the page and then fetches an asset it references does this:

```js
const shell  = await fetch(base);                       // carries pt_token, 200
const bundle = await fetch(new URL(src, base));         // token gone, 401
```

The shell loads. The bundle 401s. Nothing in either line is wrong on its own terms.

The string-concatenation version of the same mistake is worse, because it fails less honestly. `` `${base}/api/v1/thing` `` against a URL that already has a query produces `https://host/?pt_token=X/api/v1/thing`: one URL, no path, and a token with a path glued to the end. It arrives as a 404 and reads like a missing endpoint.

**What generalises is where the bug is invisible.** A browser never shows it. The first response to a preview URL sets `__pt_preview`, the capability in cookie form (V60), and every subsequent request on that origin carries the cookie automatically. So the asset loads, the app works, and a human clicking through sees nothing wrong.

The bug appears only in clients without a cookie jar. Which is to say: it appears only in health checks, canaries, monitors, uptime probes, and CI smoke tests. **It is invisible in the environment your users are in and visible only in the environment your monitoring is in**, precisely inverted from the usual case, and that is the reason it survived until a soak tick caught it rather than any amount of manual checking.

The rule that falls out: any tooling that treats a `previewUrl` as base-plus-path will strip the token, and the failure will present as an authentication problem rather than a URL construction problem. You will go looking at tokens and expiry and find nothing wrong with either.

Fixed with one helper that every request goes through, which re-attaches the token after resolution, plus two tests that assert no request loses the token and no request loses its path.

### What the diagnostics were worth, as a number

The most transferable thing in this file is not a bug. It is the difference between two runs of the same class of work.

**Excalidraw cost $0.135 across eight failed attempts.** The cause was `ENOSPC`: a JavaScript install downloads platform binaries for every operating system it has heard of, and against 2198 MB of unrequestable disk they do not fit. Two of those attempts ran for twenty-five and forty minutes before failing, and reported `build failed` with a **blank** diagnostic underneath, because yarn writes progress with carriage returns and ANSI escapes and nothing that read the log stripped them. The log had content the entire time. A neighbouring check was successfully reading it in the same second.

**Uptime Kuma cost roughly $0.005 across nine failed attempts.** It hit a comparable pile: a database wizard blocking every connection, a `NOT NULL` constraint on a column the UI always sends and I omitted, a websocket origin check, a redirect appearing only after seeding. Every one of those was found on the first attempt that produced it, because each failure named the next thing.

Same class of work. Same number of failures. **Twenty-seven times the cost**, and the only difference was whether a failure could report itself.

The bugs were never expensive. The blindness was. Roughly $0.12 of that $0.135 was spent before the diagnostics worked and about $0.01 after, and once they worked the same bug that had cost $0.076 to not-find cost $0.00142 to find.

Three changes account for nearly all of it, and none is clever:

1. **Never let a failure be silent.** A step written as `a && b && echo OK` emits nothing when a middle link fails. Two separate diagnostics in this project were swallowed by that shape before it was recognised as a shape.
2. **Print the cause, not an end of the log.** Metabase put its cause at the head with two hundred stack frames after it. Yarn puts its cause in the middle and ends with `error Command failed with exit code 1`, which matches every error pattern and explains nothing. Neither end is reliably right, so the diagnostic prints a window around the first error *and* the tail.
3. **Ask whether the job is alive, not only whether it finished.** A detached job that never started is indistinguishable from one still working unless you check, and that distinction alone converted a forty-minute stall into a three-poll failure.

If you are building on sandboxes where every failed attempt costs credits and wall-clock time, spend the first hour on the diagnostics. The measurement above is what that hour is worth.

### The sixth: a control that could never fire, found by trying to use it

Turnstile is the abuse control. `03-security-and-access.md` maps it to four
threats. `src/turnstile/verify.ts` fails closed on an unreachable Cloudflare, a
non-200, a missing secret and a missing token, and seven tests drive each of
those paths. All green.

**There was no widget on the page.**

The server read `cf-turnstile-response` from the request. Nothing ever put one
there, because the catalog rendered no Turnstile element and loaded no Turnstile
script. So the only reachable outcome in production was a refusal, and the only
reason nobody noticed is that the secret was unset too, which produced the same
refusal for a different reason. Two absent things concealing each other.

It surfaced when the site went up on a real hostname and the first launch through
the public path returned `Could not verify you are a person (misconfigured)`. Not
from a test. From trying to use it.

This is the `pkill` failure in a different costume, and worth stating as its own
entry because the costume is what makes it hard to see. `pkill` was a control
whose *mechanism* was absent: the kill could not work. Turnstile was a control
whose *input* was absent: the check worked perfectly and was never given anything
to check. A test suite that exercises a verifier by calling it with tokens cannot
detect that nothing in the product produces a token. The verifier is not wrong.
The verifier is unreachable.

What made it expensive rather than embarrassing: with Turnstile inert, the per-IP
ceiling was the only thing between a script and the budget, and it was never
designed to carry that alone. The layered abuse story in the security doc was
describing a layer that did not exist.

The fix is the widget, and the check that proves it is in
`docs/launch/turnstile-check.md`. It refuses to look at markup. It sends a bad
token and requires a refusal, sends no token and requires a refusal, then opens a
browser and requires a real launch to succeed. **A control is tested by making it
fire**, and for an input-driven control that means producing a real input, which
in turn means the thing that produces it has to exist.

The generalisation, which is the part worth carrying: **testing a checker is not
testing the check.** Ask what supplies its input in production, and whether
anything in the test suite is that thing. If the answer is a fixture, the control
is unverified no matter how many tests pass.

### The one that keeps happening: a field name nobody checked against its contents

Three times now, a number has been published under a label that described a
different measurement. Not an invented number: a real one, measured correctly,
shown beside the wrong word.

**First.** The catalog card read `resolveMs`, the `previewUrl` round trip, and
printed it as `last fork 0.27s`. Fork to healthy is four to five times larger.

**Second.** The live board read `forkToHealthyMs` and printed `MEDIAN FORK
1.18s`. That field is the health poll **alone**, measured after `create()` had
already returned, so it is not the fork either. It is a component of the 4.0 s
ready figure, and a reader comparing 1.18 s on the board against 5.5 s in the
post would reasonably conclude one of them was a lie. Both were true.

**Third**, and the one that shows the mechanism: the second bug was found while
fixing the first, in the same file, and I still did not check the soak's own
field name against what the soak measured. I fixed the consumer and trusted the
producer's vocabulary.

The common cause is not carelessness about numbers. Every one of these was
measured properly and stored intact. The failure is that **a field name is an
assertion nobody tests.** `forkToHealthyMs` reads like the fork time. It is
assigned from `waitHealthyInGuest(...).ms`, which is the poll duration. Nothing
in the type system, the tests or the review catches the gap, because both sides
are internally consistent: the producer measures a real thing and the consumer
displays a real number.

Two rules came out of it, and both are enforced rather than remembered.

**Name a field after what produced it, not what it will be used for.** The board
now shows time to ready computed from `lifetimeStartedAt - createdAt` on real
launches, which is the interval a visitor experiences, and the card says `health
check 1.18s` because that is what the number is.

**A test asserts the source, not the shape.** `test/web.test.ts` reads
`server.ts` and fails if the ready figure is computed from the health poll. That
is an ugly test and it is the only kind that catches this, because a value-based
test cannot tell two plausible durations apart.

The general form, worth carrying to any dashboard: **for every number on a page,
ask which line of code assigned it, not what the label says it is.** Where those
two disagree, the label loses, and no amount of correct measurement upstream will
save you.

### A fix on the visitor path that never reached the monitor

Jaeger's traces aged out of its default query window, so a visitor would open an
empty screen. The fix was a `postFork` step that regenerates traces at launch, so
the data is fresh relative to when somebody arrives rather than when the snapshot
was built. Verified live: 0 traces before, 316 after.

The canary kept failing Jaeger anyway.

`postFork` had been wired into the launch path, which is what a visitor gets, and
not into the canary, which is the thing that checks what a visitor gets. The
canary forked the same snapshot, skipped the refresh, queried the same default
window, and found the same empty result for the same reason the fix existed to
prevent. The card went red for a bug that was already fixed.

**A false alarm is worse than a missed detection**, and this is the shape that
produces one. A monitor that misses a real failure is a gap you can reason about.
A monitor that reports a failure which is not happening teaches you to distrust
it, and the next real red cell gets the same shrug as this one. The failure mode
is not the wrong pixel on a page; it is the operator learning that the page lies.

What makes it hard to catch: the false alarm is **indistinguishable from the true
one**. Same app, same check, same message, same red cell. Nothing about the
symptom says "the product is fixed and the monitor is not". The only way to tell
is to know that the two code paths diverged, and the only way to know that is to
have asked.

**The rule: when fixing anything on the visitor path, check whether the canary
walks its own path to the same place. If it does, every fix has two sites.**

That is true here of more than `postFork`. The canary forks its own sandbox,
resolves its own `previewUrl`, runs its own liveness check and takes its own
screenshot. Every one of those is a second copy of something the launch path also
does, and every one is a place a fix can be applied once and needed twice. The
guard is a test that reads the canary's source and fails if it lacks the step,
because no output-level test can see a path that was never taken.

### The lesson that ties them together

A probe that sets up the easy case proves nothing.

The advisory lock had already been probed, deliberately, against the exact concern that it might not survive a connection pooler. That probe passed. It passed because it happened to open a separate connection for each caller, which is the arrangement where the lock works. The bug lived in the arrangement the probe did not set up, and the probe reported success in a way that read as thorough.

So a probe is only as good as the case it constructs, and the tempting case to construct is the one you can reason about. Two rules came out of it, and both are enforced in the test suite rather than remembered.

### A footnote to the same habit: an edit that reported success and did nothing

While fixing the cards, one of my edits matched on a comment that an earlier edit
had already reworded. The match failed, the replacement was a silent no-op, and
`shotUrl: null` stayed hardcoded. Every card would have read "no canary
screenshot yet" forever while the images existed and served correctly one route
away.

Nothing errored. The tooling reported a successful write, and it had written
nothing.

It was caught the same way the zero-frame relay pass and the `pkill` gap were
caught: by checking the rendered page against the file on disk instead of
trusting that the change took. The habit generalises past this project. **A tool
reporting that it did something is not evidence that the thing is now true**, and
the check is usually one command.

### Assert the property, not the trace

Two of the lock tests originally asserted an execution order: that caller `a` ran before caller `b`. Both went flaky against the real database, where a connection round trip is several hundred milliseconds and the test bodies are a few. The fast caller could finish before the slow one had issued its `BEGIN`, and the assertion failed.

**Both failed in the direction that impersonates a lock bug**, which is the most expensive false signal this codebase has. A lock suite reporting "these ran in the wrong order" reads as "the lock is broken", and the lock had in fact been broken twelve hours earlier, so the prior was against it. That is a bad combination: a flaky test that fails toward the failure you most recently had teaches you to distrust a fix that is actually working, or to accept a real regression as noise.

The fix was not more retries, a longer timeout, or looser tolerances. All of those keep asking a question the system does not have a stable answer to. It was **asking a different question**:

- not "did `a` run before `b`" but **"did these two overlap at all"**
- not "did `b` start while `a` held the lock" but **"did `b` have to wait for `a`"**, tested by having `a` hold for 2.5 seconds so that waiting would be unmistakable

Both are properties the design actually guarantees. The orderings were incidental facts that happened to be true on one machine, and an assertion about an incidental fact is a coin flip wearing a green tick.

### A shared contract can quietly test one implementation's arrangement

The store contract runs the same suite against the in-memory store and against Postgres, on the principle that the memory store is the reference and Postgres must match it.

The concurrency cases needed a second caller, and the suite originally handed them the same store object. That reads as obviously right and encodes an assumption the two implementations do not share: **they disagree about what the lock domain is.** For the memory store, the store *is* the domain, and a second independent store models a second process that shares nothing. For Postgres, the *database* is the domain, and two stores on two connections still contend, because that is exactly what two web requests are.

Passing one object for both meant the Postgres case tested two callers on a single connection, which is precisely the arrangement where the advisory lock silently excludes nothing. The shared contract was not testing Postgres against the memory store's behaviour; it was testing Postgres in the memory store's *shape*.

The suite now takes a `secondCaller` function per implementation and each says what it means. This is a general hazard of contract testing rather than anything specific to this project: the shared parts of a contract are easy to keep honest, and the setup is where one implementation's assumptions get in without being stated.

Two smaller instrumentation errors are recorded in the same spirit in `docs/gates/`: a cost line that billed twelve browser sessions that were never opened, and a gate that reported "0 frames streamed" as a pass because zero satisfied a "below budget" threshold. The second is why every gate now declares a minimum number of observations and returns INCONCLUSIVE below it.

The raw samples behind every published figure are in `docs/gates/data/`, so none of this has to be taken on trust.
