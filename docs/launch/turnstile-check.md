# Proving Turnstile fires

**A control is tested by making it fire. Never by confirming it was installed.**

This project has now produced that failure twice. The first was `pkill`: a
self-destruct armed with a binary the image did not have, whose postcondition
asserted the script was written and executable. The second was Turnstile: server
verification written, tested, mapped to four threats in the security doc, and no
widget on the page, so no genuine token could ever be produced. Both were
green. Neither could fire.

So this check does not look at markup. It launches.

## Before you start

- The site is reachable at `https://blink.utkarshbahuguna.me`
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are both set, from the same widget
  in the Cloudflare dashboard. A site key from one widget and a secret from
  another fails every verification with no useful message
- `BLINK_TURNSTILE_DISABLED` is **not** set

```sh
BLINK_ENV_FILES="$HOME/Desktop/thrice/.env:./.env" sh deploy/tunnel/run.sh
```

## Test 1: a bad token is REFUSED

Through the public hostname, not localhost. Localhost proves the code path; this
proves the deployment.

```sh
curl -s -X POST \
  "https://blink.utkarshbahuguna.me/launch/jaeger?cf-turnstile-response=obviously-not-a-real-token"
```

**Expect:** `Could not verify you are a person (rejected: invalid-input-response)`

**Must NOT happen:** a launch panel. If you get `<div class="panel" data-launching=` the
control is not in the path and nothing below matters.

Confirm nothing was spent:

```sh
npm run sweep      # Live sandboxes: 0
```

A refusal that still created a sandbox is worse than no refusal, because it
costs money and looks safe.

## Test 2: NO token is refused

```sh
curl -s -X POST "https://blink.utkarshbahuguna.me/launch/jaeger"
```

**Expect:** a refusal naming `missing_token`. Blink short circuits before
asking Cloudflare when there is no token at all, so the code is ours rather
than theirs. It is still a refusal, and it costs no round trip.

This is the one an attacker actually tries. It is also what a broken widget
produces, so this test failing open would hide a front-end bug as well as
admitting a script.

## Test 3: a REAL token is accepted

This needs a browser, because only the widget can mint a valid token. That is
the point: if this passes, a real visitor's token works end to end.

1. Open `https://blink.utkarshbahuguna.me` in a browser
2. Confirm the Turnstile widget renders and completes
3. Press **Launch** on any app
4. **Expect:** the timer panel appears and reaches `in your browser`

**If the widget never appears**, the site key is wrong or the domain does not
match the widget's configured hostname. Check the browser console for a
Turnstile error rather than guessing.

## Test 4: a token cannot be REUSED

Turnstile tokens are single use. This is the detail most likely to look like a
bug, so confirm the behaviour is the correct one.

1. Launch once through the browser and let it succeed
2. Launch a second time immediately

**Expect:** the second launch also succeeds, because the page resets the widget
after every attempt and mints a fresh token.

**If the second launch is refused** with `timeout-or-duplicate`, the reset is not
happening and every visitor gets exactly one launch per page load.

## Test 5: the ledger agrees

```sh
tail -1 ~/.blink/instances.jsonl | python3 -m json.tool
npm run sweep
```

- `"settled": true` after you destroy the instance
- `Live sandboxes: 0`

A launch that passed Turnstile still has to be killed like any other.

## The result to record

| Test | Expected | Result |
|---|---|---|
| 1. bad token | refused, `rejected: invalid-input-response`, no sandbox created | **PASS** 2026-09-10, sweep clean |
| 2. no token | refused, `missing_token` | **PASS** 2026-09-10 |
| 3. real token | launch reaches `in your browser` | **operator only**, see below |
| 4. second launch | also succeeds, widget was reset | **operator only**, see below |
| 5. ledger | `settled: true`, zero live | **PASS** 2026-09-10 |

**Tests 3 and 4 cannot be automated, and that is the point.** Turnstile builds
its container and hidden input, fires its anti-automation checks, and then
declines to render a challenge for a driven browser: no iframe, no token. So
these two are run by hand, in a real browser, by whoever is deploying. If they
could be scripted the control would not be doing its job.

**All five pass, or Turnstile does not ship.** Four of them are one command each,
and the fifth is a browser click. This is fifteen minutes against a control that
is currently the only thing between a script and the budget.
