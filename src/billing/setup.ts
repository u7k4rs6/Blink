/**
 * Choose a ledger store at boot, and say which one out loud.
 *
 * Postgres when DATABASE_URL is set, memory otherwise. The difference is not
 * cosmetic: an in-memory ledger forgets every reservation when the process
 * restarts, so the daily ceiling silently resets and the drift check has nothing
 * to compare against. That is acceptable for a laptop and wrong for the host.
 *
 * So the choice is logged, and `isDurable` is exposed for the health wall to
 * show. A budget guard that quietly forgot the day's spending would be the most
 * expensive kind of silence in this project.
 */

import { BillingLedger, MemoryLedgerStore, type LedgerStore } from "./ledger.ts";
import { PostgresLedgerStore, connectPostgres } from "./postgres-store.ts";
import { PLANS, type Plan } from "../guard/rates.ts";
import { assertUtcDayBoundary } from "../day.ts";
import { safeErr, safeOut } from "../safe-io.ts";

export type LedgerSetup = {
  ledger: BillingLedger;
  store: LedgerStore;
  isDurable: boolean;
  describe: string;
  /**
   * False when the ledger could not be set up safely. Launches are refused
   * rather than admitted against ceilings we cannot account for.
   */
  usable: boolean;
  refusedReason?: string;
};

const DEFAULT_CEILINGS = {
  global: {
    sandboxSeconds: Number(process.env.BLINK_CEIL_GLOBAL_SANDBOX_S ?? 6 * 3600),
    browserSeconds: Number(process.env.BLINK_CEIL_GLOBAL_BROWSER_S ?? 3600),
  },
  ip: {
    sandboxSeconds: Number(process.env.BLINK_CEIL_IP_SANDBOX_S ?? 40 * 60),
    browserSeconds: Number(process.env.BLINK_CEIL_IP_BROWSER_S ?? 10 * 60),
  },
  launch: {
    sandboxSeconds: Number(process.env.BLINK_CEIL_LAUNCH_SANDBOX_S ?? 20 * 60),
    browserSeconds: Number(process.env.BLINK_CEIL_LAUNCH_BROWSER_S ?? 5 * 60),
  },
};

export async function setUpLedger(opts: { plan?: Plan } = {}): Promise<LedgerSetup> {
  // Asserted before anything reads or writes a day key. node-pg parses `date`
  // at LOCAL midnight, so a non-UTC process silently files rows under the wrong
  // day and every ceiling becomes meaningless.
  //
  // A failure here REFUSES launches rather than throwing out of boot. The first
  // version let it escape: the server kept serving, billing stayed null, and the
  // only sign was a stack trace in the log. A guard that disables itself by
  // crashing its own setup is worse than one that says it is off.
  try {
    assertUtcDayBoundary();
  } catch (err) {
    safeErr(`[ledger] ${(err as Error).message}\n[ledger] LAUNCHES ARE REFUSED until this is fixed.\n`);
    const store = new MemoryLedgerStore();
    return {
      ledger: new BillingLedger({ store, plan: opts.plan ?? PLANS.starter, ceilings: DEFAULT_CEILINGS }),
      store, isDurable: false, usable: false,
      describe: "unusable: process is not running in UTC",
      refusedReason: "the server is not running in UTC, so per-day ceilings cannot be trusted",
    };
  }

  const plan = opts.plan ?? PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const url = process.env.DATABASE_URL;

  if (url) {
    try {
      const sql = await connectPostgres(url);
      const store = new PostgresLedgerStore(sql, process.env.BLINK_PG_SCHEMA ?? "blink");
      safeOut(`[ledger] durable: Postgres. Reservations survive a restart.\n`);
      return {
        ledger: new BillingLedger({ store, plan, ceilings: DEFAULT_CEILINGS }),
        store, isDurable: true, usable: true, describe: "Postgres",
      };
    } catch (err) {
      // Falling back is a decision worth shouting about. A ceiling that resets
      // on every restart is not a ceiling.
      safeErr(
        `[ledger] DATABASE_URL is set but Postgres did not connect: ${(err as Error).message}\n` +
        `[ledger] FALLING BACK TO MEMORY. The daily ceiling will reset on restart and drift cannot be checked.\n`,
      );
    }
  } else {
    safeOut(`[ledger] no DATABASE_URL: using memory. Fine for a laptop, wrong for the host.\n`);
  }

  const store = new MemoryLedgerStore();
  return {
    ledger: new BillingLedger({ store, plan, ceilings: DEFAULT_CEILINGS }),
    store, isDurable: false, usable: true, describe: "memory (resets on restart)",
  };
}
