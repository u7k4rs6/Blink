# Soak

Generated 2026-09-07T07:31:47.517Z. 307 app checks across 29 hour(s).

Every check below exercises the app's real interface, not a status code. A soak
built on `GET / -> 200` would have stayed green through the entire Uptime Kuma
setup-wizard failure, which is why V70 and V71 exist.

## Health wall

| app | checks | green | failed | errored | what is asked |
|---|---|---|---|---|---|
| excalidraw | 61 | 56 | 5 | 0 | fetched the JS bundle and a font, not just the page shell |
| gitea | 62 | 61 | 1 | 0 | created an issue through the API and read it back |
| jaeger | 62 | 38 | 24 | 0 | queried a trace for the seeded service "frontend" |
| metabase | 61 | 58 | 0 | 3 | ran a SQL query against the sample database |
| uptimekuma | 61 | 61 | 0 | 0 | completed a socket.io handshake, since its UI is websockets end to end |

**Health wall green throughout: NO.**

Failures, in full, because a soak that hides its failures is a soak that proves nothing:

- `2026-09-04T07:01:44.445Z` **metabase**: GatewayError: exec failed
- `2026-09-04T09:50:27.050Z` **excalidraw**: TimeoutError: The operation was aborted due to timeout
- `2026-09-04T10:40:44.767Z` **excalidraw**: TimeoutError: The operation was aborted due to timeout
- `2026-09-04T10:50:36.002Z` **excalidraw**: TimeoutError: The operation was aborted due to timeout
- `2026-09-04T10:52:43.680Z` **metabase**: GatewayError: exec failed
- `2026-09-05T10:16:14.722Z` **gitea**: TypeError: fetch failed
- `2026-09-05T11:46:47.129Z` **excalidraw**: TimeoutError: The operation was aborted due to timeout
- `2026-09-05T17:38:07.690Z` **jaeger**: the UI is up but has no traces, which is an empty screen
- `2026-09-05T18:08:07.133Z` **jaeger**: the UI is up but has no traces, which is an empty screen
- `2026-09-05T18:38:08.398Z` **jaeger**: the UI is up but has no traces, which is an empty screen
- `2026-09-05T19:08:06.978Z` **jaeger**: the UI is up but has no traces, which is an empty screen
- `2026-09-05T19:38:07.735Z` **jaeger**: the UI is up but has no traces, which is an empty screen

## previewUrl resolve time, by hour

Counted per hour rather than totalled for the day. A daily figure hides an hour
that was entirely broken, and the hour is the unit an operator can act on.

| hour (UTC) | resolves | p50 ms | p95 ms | over 2000 ms |
|---|---|---|---|---|
| 2026-09-04T07 | 19 | 257 | 1071 | 0 |
| 2026-09-04T09 | 26 | 332 | 1207 | 0 |
| 2026-09-04T10 | 29 | 353 | 1405 | 0 |
| 2026-09-04T11 | 4 | 294 | 423 | 0 |
| 2026-09-04T12 | 20 | 277 | 321 | 0 |
| 2026-09-04T13 | 20 | 279 | 309 | 0 |
| 2026-09-04T16 | 5 | 458 | 1872 | 0 |
| 2026-09-04T17 | 5 | 324 | 793 | 0 |
| 2026-09-04T18 | 5 | 265 | 361 | 0 |
| 2026-09-04T19 | 5 | 254 | 259 | 0 |
| 2026-09-04T20 | 5 | 260 | 452 | 0 |
| 2026-09-04T21 | 10 | 267 | 327 | 0 |
| 2026-09-04T22 | 2 | 245 | 259 | 0 |
| 2026-09-05T10 | 10 | 283 | 1429 | 0 |
| 2026-09-05T11 | 10 | 357 | 1194 | 0 |
| 2026-09-05T12 | 10 | 292 | 10824 | 2 ** |
| 2026-09-05T17 | 5 | 281 | 305 | 0 |
| 2026-09-05T18 | 10 | 276 | 321 | 0 |
| 2026-09-05T19 | 10 | 257 | 1072 | 0 |
| 2026-09-05T20 | 10 | 254 | 289 | 0 |
| 2026-09-05T21 | 10 | 260 | 268 | 0 |
| 2026-09-05T22 | 10 | 260 | 276 | 0 |
| 2026-09-05T23 | 5 | 254 | 262 | 0 |
| 2026-09-06T22 | 5 | 255 | 263 | 0 |
| 2026-09-06T23 | 9 | 262 | 274 | 0 |
| 2026-09-07T00 | 10 | 250 | 260 | 0 |
| 2026-09-07T01 | 10 | 257 | 266 | 0 |
| 2026-09-07T06 | 15 | 286 | 988 | 0 |
| 2026-09-07T07 | 10 | 301 | 1156 | 0 |

Across the whole run: 304 resolves, p50 **277 ms**, p95 **1129 ms**, 2 over 2000 ms.

## Checklist

| item | result |
|---|---|
| five apps, health wall green throughout | **FAIL** |
| 24 distinct hours covered | PASS (29) |
| longest UNINTERRUPTED stretch | 7 h, across 10 run(s) |
| no leaked sandboxes at any reconciler tick | **FAIL** (1 of 60 ticks leaked) |
| one deliberate restart, live instance surviving | PASS |
| one deliberate kill showing the lost-instance state | PASS |
| resolve-time distribution as an hourly count | above |

Spend across the run: **$0.15480**.

### Continuous versus accumulated

This log is append-only and keyed by UTC hour, so short runs accumulate toward
24 distinct hours. **That is not the same claim as 24 hours of uninterrupted
operation.** 29 distinct hour(s) are covered here and the longest unbroken
stretch is 7 hour(s), across 10 run(s). A chunked soak cannot catch a
leak that only appears after many continuous hours, or a slow drift in a
long-lived process, because no process lived that long. Both numbers are
printed so the weaker one cannot be quoted as the stronger.

### What a killed sandbox looks like from outside

The point is not that a sandbox never dies. It is that when one does, the system
can tell, and says so. Observed after a deliberate kill:

```
ConnectionError: Not connected — call connect() first
```
