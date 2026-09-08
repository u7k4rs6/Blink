# Gate reports

Written by `npm run gates`. Empty until the first live run.

- `g<N>.md` is the report a human reads, with the verdict at the top.
- `data/g<N>.json` is the raw sample data, and is also the capture source for
  replacing the synthesized fixtures in `src/solari/fixtures/` with real traffic.

Both are redacted on write: `pt_token` values and `slr_live_` keys never reach a
durable artifact (`03-security-and-access.md` section 3).
