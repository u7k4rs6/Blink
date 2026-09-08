/**
 * The CPU sampler, implemented so it can be made to fire.
 *
 * Specified in 03-security-and-access.md section 3.2. It existed as a
 * specification and nothing else, which is exactly the condition the pkill bug
 * came from: a control whose only evidence is that someone wrote it down.
 *
 * With no network restriction available (Q5) this is one of the few things that
 * bounds abuse at all, and it only catches mining. It does not catch proxying,
 * scanning or spam relay, none of which are CPU-bound. That limit is stated
 * rather than implied.
 */

export type Sample = { cpuPct: number; atMs: number };

export type SamplerAction = {
  kill: (sandboxId: string, reason: string) => Promise<void>;
  banIpHash: (ipHash: string, hours: number) => Promise<void>;
  logPublic: (line: string) => Promise<void>;
  recordEnd: (instanceId: string, reason: string, samples: Sample[]) => Promise<void>;
};

export const CPU_TRIP_PCT = Number(process.env.BLINK_CPU_TRIP_PCT ?? 90);
export const CPU_TRIP_CONSECUTIVE = Number(process.env.BLINK_CPU_TRIP_N ?? 3);
export const CPU_SAMPLE_INTERVAL_MS = Number(process.env.BLINK_CPU_SAMPLE_MS ?? 20_000);
export const IP_BAN_HOURS = Number(process.env.BLINK_CPU_BAN_HOURS ?? 24);

/**
 * Tracks one instance. Three consecutive samples at or above the threshold trip
 * it, which is roughly 60 seconds of sustained near-full CPU.
 *
 * Three rather than one because a legitimate first load saturates 1 vCPU
 * briefly: Metabase's own boot ran hot for half a minute. One sample would kill
 * real visitors.
 */
export class CpuSampler {
  private consecutive = 0;
  private readonly samples: Sample[] = [];
  private tripped = false;

  // Written out rather than using parameter properties: erasableSyntaxOnly
  // forbids them, since Node's type stripping only erases, it never emits.
  readonly instanceId: string;
  readonly sandboxId: string;
  readonly ipHash: string;
  private readonly actions: SamplerAction;

  constructor(instanceId: string, sandboxId: string, ipHash: string, actions: SamplerAction) {
    this.instanceId = instanceId;
    this.sandboxId = sandboxId;
    this.ipHash = ipHash;
    this.actions = actions;
  }

  get hasTripped(): boolean { return this.tripped; }
  get consecutiveHigh(): number { return this.consecutive; }

  /** Feed one observation. Returns true if this sample tripped the control. */
  async observe(cpuPct: number, atMs = Date.now()): Promise<boolean> {
    if (this.tripped) return false;
    this.samples.push({ cpuPct, atMs });
    this.consecutive = cpuPct >= CPU_TRIP_PCT ? this.consecutive + 1 : 0;
    if (this.consecutive < CPU_TRIP_CONSECUTIVE) return false;

    this.tripped = true;
    const recent = this.samples.slice(-CPU_TRIP_CONSECUTIVE);
    // Order matters. Kill first: every later step is bookkeeping, and a failure
    // in bookkeeping must not leave the instance running.
    await this.actions.kill(this.sandboxId, "cpu_abuse");
    await this.actions.recordEnd(this.instanceId, "cpu_abuse", recent);
    await this.actions.banIpHash(this.ipHash, IP_BAN_HOURS);
    // The public log carries no IP hash: section 4 keeps it out of anything published.
    await this.actions.logPublic(
      `instance stopped for sustained full CPU use: ${recent.map((s) => `${Math.round(s.cpuPct)}%`).join(", ")}`,
    );
    return true;
  }
}
