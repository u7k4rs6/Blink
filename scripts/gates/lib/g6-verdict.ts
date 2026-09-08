/**
 * G6's verdict logic, extracted so it can be re-derived against stored data.
 *
 * THE PROCESS RULE THIS EXISTS FOR:
 *
 *   When a gate's verdict disagrees with your reading of its own data, fix the
 *   logic and RE-DERIVE. Never publish a reading under the old logic's run.
 *
 * On 2026-09-03 G6 printed "INCONCLUSIVE" while its stored JSON contained a
 * decisive negative answer to Q5. The override was right on the merits, but a
 * conclusion asserted in prose over a report that says something else is not a
 * record anyone can audit later. Re-running the corrected logic against the same
 * bytes costs nothing and keeps provenance clean: the verdict then comes from
 * code over data, not from a person over a disagreement.
 *
 * `npm run rederive -- g6` does exactly that, with no Solari calls.
 */

import type { GateContext, GateResult } from "./harness.ts";
import { table } from "./report.ts";

export type Step = { name: string; ok: boolean | null; detail: string };

export type SizeDelta = { beforeBytes: number; afterBytes: number; deltaBytes: number; payload: string } | null;

export function deriveG6Verdict(ctx: GateContext, steps: Step[], _sandboxId: string | null, sizeDelta: SizeDelta, capDiag: string | null, mountInfo: string | null): GateResult {
  const get = (n: string) => steps.find((s) => s.name === n)?.ok ?? null;
  const denied = get("outbound denied after rules");
  const loOk = get("loopback still works");
  const nonRootHeld = get("non-root user CANNOT remove the rules");
  const previewOk = get("previewUrl still reachable");

  const works = denied === true && loOk === true && previewOk === true;
  // An inconclusive run must never read as a negative result. The first live run
  // printed "egress denial DID NOT work" when the gate had not reached the test.
  const reachedTheTest = denied !== null;

  /**
   * A guest-side firewall being IMPOSSIBLE is a real answer, and a negative one.
   *
   * There are two distinct ways for it to be impossible, and the live run found
   * the one I did not predict:
   *
   *   PERMISSION   the guest lacks CAP_NET_ADMIN and the kernel refuses.
   *   NO KERNEL    the guest has every capability but the kernel ships no
   *                netfilter subsystem at all, so there is nothing to configure.
   *
   * The 2026-09-03 run was the second: `uid=0`, `CapEff: 000001ffffffffff`
   * (every capability set, CAP_NET_ADMIN included), and yet `nft add table`
   * returned "Operation not supported" and `nft list ruleset` returned
   * "cache initialization failed: Invalid argument", with no nf_tables module,
   * no modprobe and no iptables binary.
   *
   * The second is the stronger negative. A permission gap could in principle be
   * granted; a missing kernel subsystem cannot be granted, worked around, or
   * asked for. Either way Q5 resolves negative for the guest-side approach and
   * no workaround is attempted: a control the kernel cannot enforce is not a
   * control, and shipping the appearance of one would be worse than the gap.
   */
  const permissionRefused =
    capDiag !== null && /Operation not permitted|Permission denied|CAP_NET_ADMIN.*(missing|absent)/i.test(capDiag);
  const kernelLacksNetfilter =
    capDiag !== null &&
    /Operation not supported|cache initialization failed|nf_tables.*not|not found/i.test(capDiag) &&
    !/nft: command not found/i.test(capDiag);
  const guestFirewallImpossible = permissionRefused || kernelLacksNetfilter;

  const verdict = works
    ? `Guest-side egress denial WORKS: outbound blocked, loopback and previewUrl intact. ` +
      `Non-root containment ${nonRootHeld === true ? "HOLDS, so the v1.5 pty terminal can run as a non-root user" : nonRootHeld === false ? "FAILS, so terminal instances must get a 5-minute lifetime and no network (03-security-and-access.md)" : "not determined"}.`
    : guestFirewallImpossible
      ? `**Q5 RESOLVES NEGATIVE for the guest-side approach, on evidence.** ${permissionRefused ? "The guest lacks the capability to configure packet filters." : "The guest runs as root with every capability set (`CapEff: 000001ffffffffff`), yet the kernel has no netfilter subsystem: `nft add table` returns \"Operation not supported\", `nft list ruleset` fails cache initialization, no nf_tables module is loaded, and neither modprobe nor iptables exists. This is not a permission gap that could be granted; it is a missing kernel subsystem, which cannot be granted, loaded or worked around."} No guest-side firewall is possible, so this is an answer rather than an open question, and no workaround will be attempted. **Blink ships with NO network restriction**, and 03-security-and-access.md records that as a known accepted gap.`
      : reachedTheTest
      ? `Guest-side egress denial DID NOT work as specified: the rules applied but outbound was still reachable, or loopback or previewUrl broke. Q5 resolves negative and the fallback becomes the control: CPU and memory caps, short lifetimes, and the metrics() CPU sampler. 03-security-and-access.md must say so publicly rather than implying an egress control exists.`
      : `INCONCLUSIVE. The gate did not reach the egress test and the failure was not decisive, so this run is evidence of NOTHING about Q5, in either direction. Fix the blocking step and re-run before drawing any conclusion.`;

  const md = [
    `## Steps`,
    ``,
    table(
      ["step", "result", "detail"],
      steps.map((s) => [s.name, s.ok === null ? "n/a" : s.ok ? "pass" : "FAIL", s.detail.replace(/\|/g, "\\|").slice(0, 160)]),
    ),
    ``,
    `## Snapshot size for a real install (Q18)`,
    ``,
    sizeDelta
      ? table(
          ["", "bytes", "GiB"],
          [
            ["bare base template", sizeDelta.beforeBytes, (sizeDelta.beforeBytes / 1073741824).toFixed(2)],
            ["after installing the Gitea binary", sizeDelta.afterBytes, (sizeDelta.afterBytes / 1073741824).toFixed(2)],
            ["delta", sizeDelta.deltaBytes, (sizeDelta.deltaBytes / 1073741824).toFixed(3)],
          ],
        )
      : "Not measured on this run.",
    ``,
    sizeDelta
      ? (Math.abs(sizeDelta.deltaBytes) < 10_000_000
          ? "**Anomaly, and it is not resolved, but one explanation is now ruled out.** "
            + `A 126 MB binary was written to \`/opt\` and the reported snapshot size moved only ${sizeDelta.deltaBytes} bytes. `
            + "The tmpfs theory is dead: `df -PT` shows `/opt` and `/tmp` are both `/dev/root ext4`, a real disk, so the bytes did land on the filesystem. "
            + "So **`SnapshotView.sizeBytes` is not a content measure you can plan against**: it is either an incremental figure against the parent, or it is computed lazily and was read too soon after `snapshot()` returned. "
            + "The lazy-computation theory is the one to test next, by re-reading `listSnapshots()` after a delay. "
            + "The ~3.84 GB floor for a bare template is real and repeatable; what one app *adds* is still unmeasured. "
            + "Until that is settled, D9's cap of 12 live share snapshots is justified by count rather than by bytes, and the \"roughly 46 GB\" figure in `02-architecture.md` section 2.8 is an upper-bound guess, not a measurement. Q18 needs the written answer either way."
          : `A snapshot carries a full disk **and memory** image, so the floor is GB-scale before anything is installed. The delta above is what one real app binary adds on top. D9 mints one snapshot per share link, which is why share links are capped at 12 live (\`02-architecture.md\` section 2.8). Whether these bytes are billed at all is **Q18**, and Solari's pricing lists no storage line of any kind (V56).`)
      : "",
    ``,
    `## Filesystem layout (settles the /tmp tmpfs question)`,
    ``,
    mountInfo
      ? ["```", mountInfo.split("\n").slice(-3).join("\n"), "```", "",
         "The last two lines are `df -PT` for `/opt` and `/tmp`. If `/tmp` shows type `tmpfs` it is RAM-backed, which is why the earlier 126 MB write to `/tmp` moved the reported snapshot size by 677 bytes: those bytes never reached the disk image. This run wrote to `/opt` instead, so the delta above is measured against a real filesystem."].join("\n")
      : "Not captured on this run.",
    ``,
    capDiag
      ? ["`## Why the firewall could not be installed`", "", "```", capDiag.slice(0, 900), "```", "",
         guestFirewallImpossible
           ? (permissionRefused
               ? "**This is a capability refusal, not a configuration mistake.** Q5 is answered negative for the guest-side approach and no workaround is appropriate."
               : "**This is a missing kernel subsystem, not a permission problem, and that is the stronger negative.** The guest is root with every capability set. There is simply no netfilter in this kernel to configure. A permission gap could in principle be granted; this cannot be. Q5 is answered negative for the guest-side approach and no workaround is appropriate.")
           : "The failure is not obviously decisive. Q5 stays open pending a reading of the output above."].join("\n")
      : "",
    ``,
    `## What this decides`,
    ``,
    `**T1 (mining), T2 (outbound proxying) and T3 (malware hosting)** in \`03-security-and-access.md\` all name egress denial as their primary control. No platform feature for it is documented anywhere (00-verification.md V32), so a guest-side firewall is the only candidate, and this gate is the only evidence either way.`,
    ``,
    works
      ? `It works, so the boot script installs these rules before the app starts, and the deny list covers everything except loopback at run time. Package mirrors are needed at snapshot build time only.`
      : guestFirewallImpossible
        ? `**Blink ships with no network restriction, and that is a known accepted gap.** The guest cannot hold CAP_NET_ADMIN, so no guest-side firewall exists to install, and Solari documents no platform-level egress control (V32). The whole control for T1 and T2 is therefore: 1 vCPU being a poor miner, memory caps, short lifetimes, the metrics() CPU sampler, and layer 2 of the three-layer expiry, which is the only layer indifferent to visitor activity. \`03-security-and-access.md\` states this plainly rather than implying a restriction exists.`
        : reachedTheTest
        ? `It does not work, so the honest position is that Blink has **no egress control**, and the security doc says exactly that rather than implying otherwise. The remaining controls are the three-layer expiry (of which layer 2, the guest-side self-destruct, is the only one indifferent to visitor activity), 1 vCPU being a poor miner, and the CPU sampler.`
        : `**This run decides nothing.** The gate stopped before testing egress, so it is not evidence that the control fails, and it must not be cited as such. Q5 remains exactly as open as it was before the run.`,
    ``,
    `**The v1.5 pty terminal.** ${nonRootHeld === true ? "A non-root user could not remove the rules, so the terminal ships running as that user." : nonRootHeld === false ? "A non-root user removed the rules and restored outbound. The terminal therefore cannot rely on the firewall, and terminal instances get a 5-minute lifetime and no network at all." : "Undetermined, so the terminal ships under the stricter of the two options."}`,
  ].join("\n");

  // Only steps that actually produced a result count. A step recorded as `null`
  // is one the gate never reached, and reaching nothing is not an observation.
  const observations = steps.filter((x) => x.ok !== null).length;
  return { observations, verdict, markdown: md, data: { steps, sizeDelta, observations, capDiag, mountInfo, guestFirewallImpossible, permissionRefused, kernelLacksNetfilter } };
}

