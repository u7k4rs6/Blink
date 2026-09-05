/**
 * Share-snapshot expiry sweeper.
 *
 * A leaked snapshot is GB-scale, not a stray row: G4 measured a bare `base`
 * snapshot at about 3.84 GB, and a seeded app is larger. Snapshot storage
 * appears on no billable line item (V56), so the budget guard's ceilings, which
 * are denominated in sandbox-seconds and browser-seconds, would not catch a leak
 * either way. That makes this sweeper the only thing standing between a bug and
 * unbounded storage.
 *
 * Which is exactly why it is tested by being made to fire rather than by
 * existing. 02-architecture.md section 13 also puts it in the 24-hour soak as a
 * live check, because a passing unit test against a fake store proves the logic
 * and not the API.
 */

export type ShareSnapshot = {
  token: string;
  snapshotId: string;
  appId: string;
  expiresAt: string; // ISO 8601, UTC
  deletedAt?: string;
};

export interface ShareStore {
  /** Rows past `now` that have not yet been confirmed deleted. */
  expired(now: Date): Promise<ShareSnapshot[]>;
  /** Called only after the platform has confirmed the bytes are gone. */
  markDeleted(token: string, at: string): Promise<void>;
  liveCount(): Promise<number>;
}

export type SnapshotDeleter = (snapshotId: string) => Promise<void>;

export const SHARE_TTL_DAYS = 7;
export const MAX_LIVE_SHARE_SNAPSHOTS = 12;

export type SweepResult = {
  examined: number;
  deleted: string[];
  failed: Array<{ token: string; error: string }>;
};

/**
 * Delete every expired share snapshot, and record only the ones the platform
 * confirmed.
 *
 * A failure leaves the row undeleted so the next tick tries again. That is not a
 * retry loop: this process makes exactly one attempt per row per tick and then
 * returns. The alternative, marking a row deleted on a failed call, would retire
 * bytes that are still on disk and are now unreachable from any record, which is
 * the one outcome with no path back.
 */
export async function sweepExpiredShares(
  store: ShareStore,
  deleteSnapshot: SnapshotDeleter,
  now = new Date(),
): Promise<SweepResult> {
  const rows = await store.expired(now);
  const result: SweepResult = { examined: rows.length, deleted: [], failed: [] };

  for (const row of rows) {
    try {
      await deleteSnapshot(row.snapshotId);
      await store.markDeleted(row.token, now.toISOString());
      result.deleted.push(row.token);
    } catch (err) {
      result.failed.push({ token: row.token, error: (err as Error).message });
    }
  }
  return result;
}

/** Whether a new share link may be minted. Reaching the cap refuses, never evicts. */
export async function shareMayBeCreated(store: ShareStore): Promise<{ ok: boolean; reason?: string }> {
  const live = await store.liveCount();
  if (live >= MAX_LIVE_SHARE_SNAPSHOTS) {
    // Refusing beats evicting: the snapshot at the front of the queue belongs to
    // somebody who is still using their link.
    return { ok: false, reason: `share snapshot cap reached (${live}/${MAX_LIVE_SHARE_SNAPSHOTS})` };
  }
  return { ok: true };
}

export function shareExpiryFor(createdAt: Date): string {
  return new Date(createdAt.getTime() + SHARE_TTL_DAYS * 86_400_000).toISOString();
}
