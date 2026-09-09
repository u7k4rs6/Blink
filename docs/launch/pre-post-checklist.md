# Pre-post checklist

Every line is a gate on publishing, not a wish. Each one names how it is checked
and who says it passed, because a checklist whose items cannot be verified is a
list of intentions.

**Nothing is posted until every hard gate below is green.** A self-imposed
deadline is not a reason to skip one.

## Hard gates, in order

### 1. Section 10.2 has landed

| | |
|---|---|
| What | The identifier note is sent to Solari and acknowledged |
| Why it gates | It concerns their identifier format and every customer who logs HTTP requests. Publishing a page that explains the mechanism before they have seen it privately is the wrong order, and it cannot be undone |
| Checked by | A reply in hand. Not "sent", not "probably fine". Sent and answered |
| If it fails | **The post waits.** The site can go live, the soak can complete, the recording can be cut. The write-up explaining the identifier mechanism does not go out. There is no version where the schedule wins |

10.3 goes after 10.2 lands, and the post goes after both.

### 2. Soak: report what was measured, not what was planned

| | |
|---|---|
| What | Five apps, every liveness check passing, for as many hours as the laptop was awake |
| Where | **The development laptop behind a Cloudflare Tunnel.** There is no host: `02-architecture.md` section 11 |
| Checked by | `docs/soak/soak.md`, which prints **distinct hours covered** and **longest uninterrupted stretch** as two separate numbers |
| **The 24 continuous hour gate is NOT met, and is not claimed** | A laptop that sleeps cannot produce it. The page says the real number instead. Passing this item means the numbers shown are accurate, not that they reached 24 |
| Not sufficient | A green wall built on status codes. Every check must exercise the app's real interface (V70, V71, V77) |
| If it fails | Fix and re-soak. A failing app is still a failing app regardless of where it runs |

**The one thing that would fail this gate:** any page, post or caption that says
"soaked for 24 hours" when the 24 is accumulated across separate runs.

### 3. No leaked sandboxes at any reconciler tick

| | |
|---|---|
| What | Every reconciler tick reports zero live sandboxes |
| Checked by | `docs/soak/soak.md` checklist row, and `npm run sweep` reporting `Live sandboxes: 0` afterwards |
| Why it is absolute | A leaked sandbox is a credit leak that runs until someone notices. One leak in 24 hours is a failure, not a rounding error |

### 4. Ledger drift under 5%

| | |
|---|---|
| What | Modelled spend against measured spend, across the soak |
| Checked by | The soak report's drift rows, and `BillingLedger.health()` reporting `launchesEnabled: true` |
| Known unmodelled term | **Q19 is open.** An identical 2 vCPU request delivers one core or two unpredictably (V63), and the guard prices every sandbox-second at the **requested** size. If billing follows delivery, modelled spend overstates on any run that got one core. That is the safe direction, but it is a known term inside the 5% and must be stated rather than absorbed |
| If it fails | Do not publish a credit gauge whose own drift check is failing. The gauge is the claim nobody else makes; a wrong one is worse than none |

### 5. All five canaries exercise real interfaces

| App | Must be doing |
|---|---|
| Gitea | Writing an issue through the API and reading it back, comparing the title |
| Jaeger | Returning a seeded trace with a non-zero span count |
| Metabase | Authenticating, then running SQL against the sample database |
| Excalidraw | Fetching the JS bundle and a font, not the shell that references them |
| Uptime Kuma | Completing a socket.io handshake |

Checked by reading the `what is asked` column of the soak report. If any row reads
like a status code, the canary is lying and the catalog card it backs is not
promised by anything.

### 6. Credit gauge labelled

| | |
|---|---|
| What | The gauge says plainly that it is an estimate, and shows the measured-versus-modelled split |
| Why | Solari exposes no balance or usage API (V55), so every figure is our arithmetic and not their bill. Presenting it as authoritative would be the single most misleading thing on the site |
| Checked by | Reading the rendered page, not the code |

### 7. Repo public

| | |
|---|---|
| What | The repository is public and the write-up is in it |
| Before flipping it | `grep -rn "pt_token=\|slr_live_\|ZGVza3RvcC\|postgres://\|supabase" --include='*.md' --include='*.json' .` returns nothing outside the redaction patterns themselves |
| Also | `.env` is ignored and has never been committed. Confirm with `git log --all --full-history -- .env`, not by looking at the working tree |

### 8. Cookbook example in place

| | |
|---|---|
| What | `examples/blink` (D12), runnable, with its own README |
| Checked by | A clean clone, following only the README, reaching a working local run |

## Final sweep, immediately before posting

Run in this order, on the day:

```
npm test                     # 221 tests, zero credits
npm run typecheck
npm run sweep                # must report Live sandboxes: 0
npm run lint:dashes         # must be 0 everywhere: no em dashes
```

Then read the soak report end to end. Not the summary rows. The failures section
exists to be read.

## What is explicitly NOT a gate

Stated so nobody argues about them at 2am on day 7.

- **Five apps.** Four is fine. A card that cannot be honestly checked should be
  cut rather than shipped, and the write-up says which and why.
- **Q19 resolved.** It is documented as open with its consequence stated. An open
  question that is named is not a blocker; an open question that is hidden is.
- **The recording being perfect.** A 6.2 s take published as 6.2 s beats a 5.5 s
  take that was edited to look like one.
