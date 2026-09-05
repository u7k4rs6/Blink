# Recorded fixtures

These are the responses the unit tests run against, so CI spends zero credits
(`02-architecture.md` section 13).

**Provenance, stated plainly.** As of 2026-09-03 these are *synthesized from the
published `.d.ts` type definitions and the documented error shapes* in
`docs/00-verification.md`, not captured from live traffic, because Phase 0 spent
no credits. Every field name and every error code below was read from
`@solarisdk/core@0.1.2` or from `docs.getsolari.com`, so the shapes are right,
but the values are representative rather than observed.

**After the first live gate run, replace them with captured traffic.** The gates
write raw JSON into `docs/gates/data/`, which is the capture source. A fixture
that has been replaced with real traffic should say so in its `_source` field.
