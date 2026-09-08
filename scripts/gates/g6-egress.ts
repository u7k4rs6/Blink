/**
 * G6: can outbound network from the sandbox be restricted?
 *
 * Phase 0 found NO documented platform egress control anywhere: not on
 * /sandboxes, /regions, /volumes, /organizations, /templates or /api-reference
 * (00-verification.md V32). So this gate does not go looking for a feature that
 * the docs say nothing about. It tests what can actually be built:
 *
 *   1. BASELINE. Confirm outbound works at all before restricting it, or every
 *      later result is meaningless.
 *   2. GUEST-SIDE FIREWALL. Can the boot script install nftables rules denying
 *      all outbound except loopback? This is the primary candidate, not the
 *      fallback. Visitors have no shell in v1, so a guest-side firewall is a
 *      real control rather than a courtesy.
 *   3. CAN A NON-ROOT USER REMOVE THEM? The v1.5 pty terminal gives a visitor a
 *      shell, and 03-security-and-access.md now requires that the terminal run
 *      as a non-root user that cannot undo the rules, or else that terminal
 *      instances get a 5-minute lifetime and no network. This step decides which.
 *   4. LOOPBACK STILL WORKS. A firewall that also kills loopback breaks every
 *      app, since they all serve on a local port behind previewUrl.
 *   5. PREVIEWURL STILL WORKS. Inbound through the preview domain must survive
 *      an outbound denial, or the control is unusable.
 *
 * If the firewall cannot be installed or a non-root user can remove it, the
 * fallback is CPU and memory caps plus short lifetimes plus the metrics() CPU
 * sampler (V13), and the security doc says so publicly.
 */

import { estimate } from "./lib/cost.ts";
import { table } from "./lib/report.ts";
import { previewHealthUrl, waitHealthy } from "./lib/health.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { deriveG6Verdict, type SizeDelta, type Step } from "./lib/g6-verdict.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";

const SECONDS = 260; // longer: now also snapshots twice and downloads a binary
/**
 * The outbound probe target. Deliberately NOT api.getsolari.com: traffic from a
 * Solari sandbox to Solari's own gateway may be internally routed or allowlisted,
 * which would report "outbound works" when general egress is already restricted,
 * and "outbound blocked" would then be measuring the wrong thing entirely.
 * example.com is IANA-reserved for exactly this use and is not a third party we
 * are driving.
 */
const PROBE_HOST = process.env.BLINK_G6_PROBE ?? "https://example.com";

async function run(ctx: GateContext): Promise<GateResult> {
  const steps: Step[] = [];
  let sandboxId: string | null = null;
  let sizeDelta: SizeDelta = null;
  let capDiag: string | null = null;
  let mountInfo: string | null = null;

  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, "g6",
      { template: "base", cpu: 1, memMb: 2048, timeoutMs: 300_000,
        lifecycle: { onTimeout: "kill" }, metadata: ctx.metadata },
      0.005,
    );
    sandboxId = sb.value.sandboxId;
    const sandbox = sb.value;

    const sh = async (cmd: string) => (await ctx.adapter.exec(ctx.apiKey, sandbox, "g6", cmd)).value;

    // 0. Is the probe tool even present? The base template is bare (V38), and a
    // missing curl looks identical to blocked egress if you do not check.
    // The first live run reported a false negative on egress for exactly this
    // reason, compounded by commands.run not being a shell.
    const haveCurl = await sh("command -v curl >/dev/null 2>&1 && echo YES || echo NO");
    const curlPresent = haveCurl.stdout.includes("YES");
    if (!curlPresent) {
      const inst = await sh("(apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1 && echo INSTALLED) || echo UNAVAILABLE");
      steps.push({
        name: "probe tool (curl) available",
        ok: inst.stdout.includes("INSTALLED"),
        detail: inst.stdout.includes("INSTALLED")
          ? "curl was absent from the base template and was installed for the probe"
          : `curl absent and could not be installed: ${inst.stdout.trim().slice(0, 160)}`,
      });
      if (!inst.stdout.includes("INSTALLED")) {
        steps.push({ name: "everything below", ok: null, detail: "INCONCLUSIVE: no probe tool, so egress could not be tested either way" });
        return deriveG6Verdict(ctx, steps, null, sizeDelta, capDiag, mountInfo);
      }
    } else {
      steps.push({ name: "probe tool (curl) available", ok: true, detail: "present in the base template" });
    }

    // 0.5. Representative install size delta (Q18).
    //
    // G4 measured a snapshot of a BARE base template at about 3.84 GB, which is
    // the most consequential number of the first pass and was unmeasured for
    // anything we actually ship. Snapshot before and after installing a real app
    // payload, so the delta is a genuine per-install figure rather than noise.
    // The first attempt at this measured a file that was never written, because
    // commands.run is not a shell; adapter.exec now wraps in `sh -c`.
    try {
      const snapA = await ctx.adapter.snapshot(ctx.apiKey, sandbox, "g6", "blink-g6-size-before");
      // NOT /tmp. The first attempt wrote 126 MB to /tmp and the reported snapshot
      // size moved by 677 bytes versus writing nothing, which is noise. /tmp is
      // very likely a tmpfs, so the bytes never reached the disk image. Write to
      // /opt and prove the mount is real before trusting any delta.
      const install = await sh(
        "( mkdir -p /opt/blink && cd /opt/blink " +
          "&& curl -fsSL -o gitea https://dl.gitea.com/gitea/1.27.3/gitea-1.27.3-linux-amd64 " +
          "&& chmod +x gitea && ./gitea --version | head -1 " +
          "&& stat -c %s /opt/blink/gitea " +
          "&& df -PT /opt/blink | tail -1 " +
          "&& df -PT /tmp | tail -1 ) 2>&1",
      );
      const snapB = await ctx.adapter.snapshot(ctx.apiKey, sandbox, "g6", "blink-g6-size-after");
      const all = await ctx.adapter.listSnapshots(ctx.apiKey, "g6");
      const a = all.value.find((x) => x.id === snapA.value)?.sizeBytes ?? 0;
      const b = all.value.find((x) => x.id === snapB.value)?.sizeBytes ?? 0;
      mountInfo = install.stdout.trim();
      sizeDelta = { beforeBytes: a, afterBytes: b, deltaBytes: b - a, payload: install.stdout.trim().slice(0, 400) };
      steps.push({
        name: "snapshot size delta for a real install",
        ok: b > 0 && a > 0,
        detail: `before ${a} B, after ${b} B, delta ${b - a} B. Payload: ${install.stdout.trim().slice(0, 120)}`,
      });
      for (const id of [snapA.value, snapB.value]) {
        try { await ctx.adapter.deleteSnapshot(ctx.apiKey, "g6", id); } catch { /* swept later */ }
      }
    } catch (err) {
      steps.push({ name: "snapshot size delta for a real install", ok: null, detail: `not measured: ${(err as Error).message}` });
    }

    // 1. Baseline.
    const base = await sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${PROBE_HOST} || echo FAILED`);
    const baselineOk = /^[23]\d\d$/.test(base.stdout.trim());
    steps.push({ name: "baseline outbound works", ok: baselineOk, detail: `curl returned "${base.stdout.trim() || "(empty)"}"` });
    if (!baselineOk) {
      steps.push({
        name: "everything below",
        ok: null,
        detail: "INCONCLUSIVE: outbound did not work before restricting it, so nothing below would mean anything. This is NOT evidence that egress denial fails.",
      });
      return deriveG6Verdict(ctx, steps, null, sizeDelta, capDiag, mountInfo);
    }

    // 2. Install nftables. Try the package first; the base template is bare
    // (V38) so it very likely is not present.
    const install = await sh("(command -v nft && echo PRESENT) || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq nftables >/dev/null 2>&1 && command -v nft && echo INSTALLED) || echo UNAVAILABLE");
    const haveNft = /PRESENT|INSTALLED/.test(install.stdout);
    steps.push({ name: "nftables available in guest", ok: haveNft, detail: install.stdout.trim().slice(0, 200) || install.stderr.trim().slice(0, 200) });

    let rulesInstalled = false;
    if (haveNft) {
      // The whole chain inside a subshell with 2>&1, not just the last command.
      // The previous run reported a bare "APPLY_FAILED" with no reason, because
      // `a && b && c 2>&1` redirects only c's stderr.
      const apply = await sh(
        "( nft add table inet blink " +
          "&& nft 'add chain inet blink output { type filter hook output priority 0 ; policy drop ; }' " +
          "&& nft add rule inet blink output oifname lo accept " +
          "&& nft add rule inet blink output ct state established,related accept " +
          "&& echo APPLIED ) 2>&1 || echo APPLY_FAILED",
      );
      rulesInstalled = apply.stdout.includes("APPLIED");
      steps.push({ name: "deny-all-except-loopback installed", ok: rulesInstalled, detail: apply.stdout.trim().slice(0, 400) });

      if (!rulesInstalled) {
        // Why did it fail? Almost certainly a missing capability in the guest,
        // which would answer Q5 negatively for the guest-side approach. Gather
        // the evidence rather than inferring it.
        const diag = await sh(
          "( echo uid=$(id -u) " +
            "; echo -n 'CapEff: '; grep -i '^CapEff' /proc/self/status " +
            "; echo -n 'nf_tables module: '; (lsmod 2>/dev/null | grep -c nf_tables || echo 0) " +
            "; echo -n 'modprobe: '; (modprobe nf_tables 2>&1 && echo ok || true) " +
            "; echo -n 'nft list: '; (nft list ruleset 2>&1 | head -3) " +
            "; echo -n 'iptables fallback: '; (iptables -L OUTPUT -n 2>&1 | head -2 || echo absent) ) 2>&1",
        );
        capDiag = diag.stdout.trim();
        steps.push({
          name: "why the firewall could not be installed",
          ok: null,
          detail: capDiag.replace(/\n/g, " | ").slice(0, 500),
        });
      }
    }

    if (rulesInstalled) {
      // 3. Is outbound actually denied now?
      const after = await sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 8 ${PROBE_HOST} || echo BLOCKED`);
      const denied = after.stdout.includes("BLOCKED") || after.stdout.trim() === "000";
      steps.push({ name: "outbound denied after rules", ok: denied, detail: `curl returned "${after.stdout.trim()}"` });

      // 4. Loopback still works, or every app breaks.
      const lo = await sh("(python3 -m http.server 18080 >/dev/null 2>&1 & sleep 2; curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18080/ || echo LO_FAILED)");
      const loOk = /^[23]\d\d$/.test(lo.stdout.trim());
      steps.push({ name: "loopback still works", ok: loOk, detail: `curl to 127.0.0.1 returned "${lo.stdout.trim()}"` });

      // 5. Can a non-root user remove the rules? This decides the v1.5 terminal
      // constraint in 03-security-and-access.md.
      const escalate = await sh([
        "id -u blinkapp >/dev/null 2>&1 || useradd -m blinkapp",
        "su blinkapp -c 'nft flush table inet blink' 2>&1 | head -2",
        "su blinkapp -c \"curl -s -o /dev/null -w '%{http_code}' --max-time 8 " + PROBE_HOST + "\" || echo STILL_BLOCKED",
      ].join("; "));
      const escaped = /^[23]\d\d$/.test(escalate.stdout.trim().split("\n").pop() ?? "");
      steps.push({
        name: "non-root user CANNOT remove the rules",
        ok: !escaped,
        detail: escaped
          ? `non-root user restored outbound, so a pty terminal defeats this control: ${escalate.stdout.trim().slice(0, 200)}`
          : `non-root user could not restore outbound: ${escalate.stdout.trim().slice(0, 200)}`,
      });

      // 6. previewUrl still reachable with outbound denied.
      const preview = await ctx.adapter.previewUrl(ctx.apiKey, sandbox, "g6", 18080);
      const health = await waitHealthy(previewHealthUrl(preview.value.url, "/"), { timeoutMs: 20_000 });
      steps.push({ name: "previewUrl still reachable", ok: health.ok, detail: `status ${health.status ?? health.error}` });
    }

    return deriveG6Verdict(ctx, steps, sandboxId, sizeDelta, capDiag, mountInfo);
  } catch (err) {
    steps.push({ name: "gate failed", ok: false, detail: (err as Error).message });
    return deriveG6Verdict(ctx, steps, sandboxId, sizeDelta, capDiag, mountInfo);
  } finally {
    if (sandboxId) {
      ctx.guard.addSandboxSeconds(SECONDS, SIZE_SMALL, false, "egress probe sandbox, flat model");
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g6");
    }
  }
}

const def: GateDefinition = {
  id: "g6",
  title: "outbound egress restriction",
  question: "Can outbound network from the sandbox be restricted, by a guest-side nftables firewall or otherwise (Q5)?",
  ceilingUsd: 0.03,
  // Probe tool, baseline outbound, nft availability, ruleset apply, and the
  // denial check. Fewer than five decided steps and Q5 is not answered either
  // way, which is exactly what the first two runs got wrong.
  minObservations: 5,
  observationUnit: "decided step",
  estimate: (plan) => estimate(plan, [{ sandboxSeconds: SECONDS, size: SIZE_SMALL }]),
  run,
};

await main(def);
