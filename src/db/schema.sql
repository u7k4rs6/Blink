-- Blink schema.
--
-- Tables follow docs/02-architecture.md section 3, with the columns day 2 and
-- day 3 added. Comments record WHY a column exists where the reason is not
-- obvious from its name, because the expensive mistakes on this project have all
-- been things that looked reasonable.

-- ---------------------------------------------------------------------------
-- Catalog and snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL,
  port          integer NOT NULL,
  health_path   text NOT NULL,
  cpu           integer NOT NULL,
  mem_mb        integer NOT NULL,
  try_first     jsonb NOT NULL DEFAULT '[]'::jsonb,
  license       text NOT NULL,
  upstream_url  text NOT NULL,
  screenshot_url text,
  enabled       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS snapshot (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  version       text NOT NULL,
  built_at      timestamptz NOT NULL,
  size_bytes    bigint,
  canary_status text NOT NULL DEFAULT 'unknown',
  is_current    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS snapshot_one_current
  ON snapshot(app_id) WHERE is_current;

-- ---------------------------------------------------------------------------
-- Warm pool
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS warm_fork (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  snapshot_id   text NOT NULL REFERENCES snapshot(id),
  sandbox_id    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('building','ready','claimed','dead')),
  paused_at     timestamptz,
  claimed_at    timestamptz,
  -- Resolved BEFORE pausing and reused on claim. G3 confirmed a URL resolved
  -- before a pause still routes after the resume, which removes a 1,238 ms
  -- previewUrl() call from the visitor's path.
  preview_url   text,
  -- The pt_token inside preview_url lasts one hour. A warm fork can sit paused
  -- longer than that, so the claim path re-resolves past 50 minutes.
  preview_resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS warm_fork_claimable ON warm_fork(app_id, status);

-- ---------------------------------------------------------------------------
-- Instances
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instance (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  sandbox_id    text NOT NULL,
  -- Nulled on destroy. The URL is a bearer capability carrying a decodable JWT
  -- (V60), so it does not outlive the instance it addresses.
  preview_url   text,
  path          text NOT NULL CHECK (path IN ('cold','warm')),
  state         text NOT NULL,
  requested_at  timestamptz NOT NULL,
  started_at    timestamptz,
  ready_at      timestamptz,
  -- Handover, not ready. The visitor's ten minutes start when they can actually
  -- use the thing; time spent billing-but-unusable is Blink's cost.
  handover_at   timestamptz,
  first_byte_at timestamptz,
  expires_at    timestamptz,
  ended_at      timestamptz,
  extensions_used integer NOT NULL DEFAULT 0,
  ip_hash       text,
  timings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  end_reason    text
);
CREATE INDEX IF NOT EXISTS instance_live ON instance(state) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS instance_expiring ON instance(expires_at) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- Billing ledger. The most important table here.
--
-- There is no Solari usage API (V55), so this is the only running account of
-- spend, and D10 puts its output on a public page.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_reservation (
  id            text PRIMARY KEY,
  day           date NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('global','ip','launch')),
  key           text NOT NULL,
  est_sandbox_seconds numeric NOT NULL,
  est_browser_seconds numeric NOT NULL,
  -- NULL means unsettled, and an unsettled row counts at its ESTIMATE against
  -- ceilings. Nullable rather than defaulted to 0 precisely so the two cases
  -- stay distinguishable: 0 means settled at no cost.
  act_sandbox_seconds numeric,
  act_browser_seconds numeric,
  usd           numeric NOT NULL,
  -- False when the seconds came from a model rather than an observed lifetime.
  -- The credit gauge shows the split rather than one confident number.
  measured      boolean NOT NULL DEFAULT false,
  created_at_ms bigint NOT NULL,
  settled_at_ms bigint,
  note          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS billing_scope ON billing_reservation(day, scope, key);
CREATE INDEX IF NOT EXISTS billing_open ON billing_reservation(created_at_ms) WHERE settled_at_ms IS NULL;

-- Human console readings. The only reconciliation available.
CREATE TABLE IF NOT EXISTS billing_reconciliation (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL,
  ledger_usd    numeric NOT NULL,
  observed_spent_usd numeric NOT NULL,
  drift_usd     numeric NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('ledger_under','ledger_over','exact')),
  note          text NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Queue, canary, metrics, plan
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS queue_entry (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  session_token text NOT NULL,
  enqueued_at   timestamptz NOT NULL,
  position      integer,
  est_wait_s    integer,
  state         text NOT NULL CHECK (state IN ('waiting','promoted','abandoned','refused'))
);

CREATE TABLE IF NOT EXISTS canary_run (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  snapshot_id   text REFERENCES snapshot(id),
  started_at    timestamptz NOT NULL,
  fork_ms       integer,
  health_ms     integer,
  ok            boolean NOT NULL,
  error         text,
  screenshot_url text
);

CREATE TABLE IF NOT EXISTS metric_sample (
  id            bigserial PRIMARY KEY,
  app_id        text NOT NULL REFERENCES app(id),
  path          text NOT NULL CHECK (path IN ('cold','warm')),
  -- Phases stay separate. A single total hides which part was the app, and the
  -- whole public argument rests on that split.
  fork_ms       integer,
  health_ms     integer,
  preview_resolve_ms integer,
  preview_first_byte_ms integer,
  total_ms      integer,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_recent ON metric_sample(app_id, at DESC);

-- Every previewUrl resolve slower than the log threshold, bucketed by hour so
-- the soak shows a trend rather than a daily total.
CREATE TABLE IF NOT EXISTS slow_resolve (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  hour_bucket   timestamptz NOT NULL,
  app_id        text REFERENCES app(id),
  path          text,
  ms            integer NOT NULL
);
CREATE INDEX IF NOT EXISTS slow_resolve_hour ON slow_resolve(hour_bucket);

CREATE TABLE IF NOT EXISTS plan_config (
  plan          text PRIMARY KEY,
  sandbox_vcpu_rate numeric NOT NULL,
  sandbox_gb_rate   numeric NOT NULL,
  browser_rate      numeric NOT NULL,
  max_sandboxes     integer NOT NULL,
  max_browsers      integer NOT NULL,
  swarm_max_n       integer NOT NULL,
  warm_pool_enabled boolean NOT NULL,
  ceilings          jsonb NOT NULL
);

-- Single-row operational state. launches_enabled is flipped by the drift trip
-- and by the out-of-credits detector, and read on every launch.
CREATE TABLE IF NOT EXISTS site_state (
  id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  launches_enabled  boolean NOT NULL DEFAULT true,
  gauge_state       text NOT NULL DEFAULT 'ok' CHECK (gauge_state IN ('ok','reconciling')),
  reason            text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
