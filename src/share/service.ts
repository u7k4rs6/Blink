/**
 * Fork-my-state share links (D9).
 *
 * The visitor uses their instance, presses Share, and gets a link. Whoever opens
 * it gets a fresh instance forked from THEIR state, not from the catalog
 * snapshot. Confirmed workable by V6: `sandbox.snapshot()` checkpoints a running
 * session without killing it, and returns a snapshot id.
 *
 * Three things bound this feature, and all three exist because snapshot storage
 * is invisible to the budget guard. Ceilings are denominated in sandbox-seconds
 * and browser-seconds; a snapshot costs neither, and V56 established that
 * storage appears on no billable line item at all, so it is either free or
 * unlisted. A cap, a TTL and a proven sweeper are what stand in for a ceiling
 * that cannot see it:
 *
 *   - at most 12 live share snapshots, refusing rather than evicting
 *   - 7 day expiry
 *   - a sweeper that is tested by making it delete, not by existing
 *
 * At roughly 3.84 GB each (G4), 12 is about 46 GB. That is a bounded exposure
 * whatever the rate turns out to be, which is the point of picking a number.
 */

import { randomBytes } from "node:crypto";

import type { SolariAdapter } from "../solari/adapter.ts";
import { shareExpiryFor, shareMayBeCreated, type ShareSnapshot, type ShareStore } from "./expiry.ts";

/** 16 random bytes, base64url. The token IS the authorisation to fork. */
export function newShareToken(): string {
  return randomBytes(16).toString("base64url");
}

export class ShareRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ShareRefused";
    this.reason = reason;
  }
}

/** An in-memory store. Postgres implements the same interface for production. */
export class MemoryShareStore implements ShareStore {
  private readonly rows = new Map<string, ShareSnapshot & { forkCount: number; reported: boolean }>();

  async expired(now: Date): Promise<ShareSnapshot[]> {
    return [...this.rows.values()].filter((r) => !r.deletedAt && new Date(r.expiresAt) <= now);
  }
  async markDeleted(token: string, at: string): Promise<void> {
    const r = this.rows.get(token);
    if (r) r.deletedAt = at;
  }
  async liveCount(): Promise<number> {
    return [...this.rows.values()].filter((r) => !r.deletedAt && !r.reported).length;
  }
  async put(row: ShareSnapshot): Promise<void> {
    this.rows.set(row.token, { ...row, forkCount: 0, reported: false });
  }
  async get(token: string): Promise<(ShareSnapshot & { forkCount: number; reported: boolean }) | null> {
    return this.rows.get(token) ?? null;
  }
  async countFork(token: string): Promise<void> {
    const r = this.rows.get(token);
    if (r) r.forkCount += 1;
  }
  /** Report-abuse path. A reported share stops resolving immediately. */
  async report(token: string): Promise<boolean> {
    const r = this.rows.get(token);
    if (!r) return false;
    r.reported = true;
    return true;
  }
  async all(): Promise<ShareSnapshot[]> { return [...this.rows.values()]; }
}

export type ShareableStore = MemoryShareStore;

/**
 * Snapshot a LIVE instance and mint a share token.
 *
 * The cap is checked before the snapshot call, not after: a snapshot that then
 * gets refused has already consumed whatever storage costs, and refusing after
 * paying is the worst of both.
 */
export async function createShare(deps: {
  adapter: SolariAdapter;
  apiKey: string;
  store: ShareableStore;
  sandbox: unknown;
  appId: string;
  now?: () => Date;
}): Promise<{ token: string; expiresAt: string; snapshotId: string }> {
  const now = (deps.now ?? (() => new Date()))();

  const allowed = await shareMayBeCreated(deps.store);
  if (!allowed.ok) {
    // Refusing beats evicting: the snapshot at the front of the queue belongs to
    // somebody who is still using their link.
    throw new ShareRefused("cap_reached", allowed.reason ?? "share cap reached");
  }

  const snap = await deps.adapter.snapshot(
    deps.apiKey, deps.sandbox as never, `share:${deps.appId}`,
    `blink-share-${deps.appId}-${now.toISOString().slice(0, 10)}`,
  );

  const token = newShareToken();
  const expiresAt = shareExpiryFor(now);
  await deps.store.put({ token, snapshotId: snap.value, appId: deps.appId, expiresAt });
  return { token, expiresAt, snapshotId: snap.value };
}

export type ShareLookup =
  | { ok: true; snapshotId: string; appId: string; forkCount: number }
  | { ok: false; reason: "unknown" | "expired" | "deleted" | "reported" };

/**
 * Resolve a share token to something forkable.
 *
 * Every refusal reason is distinct, because "this link does not work" is the
 * least useful thing a share page can say. Expired, reported and never-existed
 * are three different situations for the person holding the link.
 */
export async function resolveShare(
  store: ShareableStore, token: string, now = new Date(),
): Promise<ShareLookup> {
  const row = await store.get(token);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.reported) return { ok: false, reason: "reported" };
  if (row.deletedAt) return { ok: false, reason: "deleted" };
  if (new Date(row.expiresAt) <= now) return { ok: false, reason: "expired" };
  return { ok: true, snapshotId: row.snapshotId, appId: row.appId, forkCount: row.forkCount };
}
