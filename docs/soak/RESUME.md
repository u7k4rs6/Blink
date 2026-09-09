# Resuming the soak

> **The real soak runs on the Hetzner host, not here** (`01-prd.md` section 9).
> The gate is 24 **continuous** hours, and this laptop cannot provide them. What
> follows is for accumulating evidence in the meantime, and for the fallback if
> the host is not deployed in time. Chunks run here are real measurements and
> they are not the gate.

The soak does not need to run in one sitting, and this file exists so that
picking it up later needs no memory of how it was set up.

## To add more hours

```
cd ~/Desktop/Blink
set -a; . ~/Desktop/thrice/.env; . ./.env; set +a
npm run soak
```

That is the whole thing. It appends to `docs/soak/soak.jsonl` and regenerates
`docs/soak/soak.md` after every tick.

For a shorter chunk, set the interval and duration in milliseconds:

```
BLINK_SOAK_INTERVAL_MS=600000 BLINK_SOAK_DURATION_MS=1800000 npm run soak
```

To run it detached so a closed terminal does not kill it:

```
nohup npm run soak > /tmp/soak.log 2>&1 &
```

## Why this works across a shutdown

`docs/soak/soak.jsonl` is append-only and every tick carries its own UTC hour, so
runs on different days accumulate toward 24 distinct hours. Nothing is held in
the process, which is also what makes the restart rehearsal meaningful.

**The report distinguishes two numbers and they must not be conflated:**

- **distinct hours covered**, which accumulates across runs
- **longest uninterrupted stretch**, which does not

A chunked soak cannot catch a leak that only appears after many continuous hours,
or drift in a long-lived process, because no process lived that long. The report
prints both so the weaker claim cannot be quoted as the stronger one. The
pre-post checklist gate is written against the continuous number.

## Before starting a chunk

```
npm run sweep     # must print: Live sandboxes: 0
```

If a previous run was killed mid-tick, the sweeper reaps whatever it left. A
sandbox outliving its run is a credit leak, so this is not optional.

## What is already banked

Read `docs/soak/soak.md`. The deliberate kill and the restart rehearsal only need
to happen once each, and once they show PASS they do not need repeating: set
`BLINK_SOAK_KILL_TICK=99 BLINK_SOAK_RESTART_TICK=99` on later chunks to skip them
and spend only on the health wall.

## Cost

About $0.0024 per tick for five apps. A 24-tick run is roughly $0.06. The guard
refuses before exceeding `BLINK_SOAK_CEILING_USD`, default $0.35.
