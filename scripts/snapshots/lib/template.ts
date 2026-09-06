/**
 * The shared recipe template.
 *
 * Two steps every recipe gets, both written because a build discovered the need
 * the expensive way.
 *
 * PREREQUISITES UP FRONT. The `base` template is barer than the docs describe
 * (V38, corrected): no JRE, no Node, no procps, no X11, no javac. Metabase found
 * four of those one failed build at a time, at roughly four minutes each. A
 * recipe now states what it needs and fails in seconds if the image cannot
 * provide it.
 *
 * PROVE THE MECHANISM. The guest-side self-destruct was armed with `pkill`,
 * which does not exist on this image, so it would have failed silently on every
 * instance of every app. The step that installed it passed every time, because
 * its postcondition asserted the script was written and executable, which was
 * true and irrelevant.
 *
 *   A control is tested by making it fire. Never by confirming it was installed.
 */

export type Step = { name: string; cmd: string; expect: string };

/** Commands the base image is confirmed to have. Anything else must be installed. */
export const BASE_IMAGE_HAS = ["curl", "tar", "sha256sum", "awk", "sed", "python3", "kill"] as const;

/** Commands the base image is confirmed NOT to have. */
export const BASE_IMAGE_LACKS = ["java", "node", "npm", "pkill", "pgrep", "free", "javac", "nft", "iptables"] as const;

/**
 * Assert every binary and file the recipe needs, before doing any work.
 *
 * Deliberately the first step. A missing prerequisite costs a second here and
 * four minutes if discovered at the health poll.
 */
export class BadPrerequisite extends Error {}

export function prerequisiteStep(needs: readonly string[], files: readonly string[] = []): Step {
  // This step runs FIRST, so it can only assert what the IMAGE supplies. Naming
  // something the recipe installs later fails a build that would have worked.
  // The first version of this function did exactly that: it asserted `git` for
  // Gitea, which the recipe apt-installs six lines further down.
  for (const n of needs) {
    if ((BASE_IMAGE_LACKS as readonly string[]).includes(n)) {
      throw new BadPrerequisite(
        `prerequisiteStep cannot assert "${n}": the base image is known not to have it (V38). ` +
          `Install it first, then assert it after the install step.`,
      );
    }
  }
  const checks = needs
    .map((n) => `command -v ${n} >/dev/null || { echo "MISSING_BINARY:${n}"; exit 1; }`)
    .concat(files.map((f) => `test -s ${f} || { echo "MISSING_FILE:${f}"; exit 1; }`))
    .join("; ");
  return {
    name: `assert prerequisites: ${[...needs, ...files].join(", ")}`,
    cmd: `${checks}; echo PREREQS_OK`,
    expect: "PREREQS_OK",
  };
}

/**
 * Prove the self-destruct can actually kill this process.
 *
 * Signals the real PID rather than checking that a file exists. `kill -0` sends
 * no signal but performs every permission and existence check the real kill
 * will, so a failure here means the real one would have failed too.
 */
export const BOOT_SCRIPT_PATH = "/usr/local/bin/blink-boot";

/**
 * Install the boot script that arms the guest-side self-destruct.
 *
 * Layer 2 of the three-layer expiry, and the only layer indifferent to visitor
 * activity: layer 3 is defeated by preview traffic (Q17) and there is no network
 * control at all (Q5), so this is what bounds a runaway instance.
 *
 * `kill` is a shell builtin and always present. `pkill` is not on this image, and
 * assuming it was is what silently disabled this control on every app (V61). The
 * app writes its own PID before `exec`ing so nothing here needs to search for it.
 */
export function bootScriptStep(pidFile: string, logFile: string): Step {
  return {
    name: "install the boot script that arms the self-destruct",
    cmd:
      `cat > ${BOOT_SCRIPT_PATH} <<'BLINK_BOOT_EOF'\n` +
      `#!/bin/sh\n` +
      `LIFETIME="\${2:-600}"\n` +
      `setsid sh -c "sleep \${LIFETIME}; kill -9 \\$(cat ${pidFile} 2>/dev/null) 2>/dev/null; ` +
      `echo blink-selfdestruct-fired >> ${logFile}" >/dev/null 2>&1 &\n` +
      `echo BOOT_OK\n` +
      `BLINK_BOOT_EOF\n` +
      `chmod +x ${BOOT_SCRIPT_PATH} && test -x ${BOOT_SCRIPT_PATH} && echo BOOTSCRIPT_OK`,
    expect: "BOOTSCRIPT_OK",
  };
}

/**
 * Prove the self-destruct is BOTH installed and capable of firing.
 *
 * The first version of this step checked only that a kill would work, and it
 * passed on two recipes that had no self-destruct at all. That is precisely the
 * bug this whole step exists to prevent, reproduced inside the fix for it: a
 * control reporting "armed" when nothing was armed.
 *
 * So it now asks three separate questions, because any one of them alone can be
 * true while the control does nothing:
 *
 *   1. Does the arming script exist and is it executable?
 *   2. Does it reference THIS app's pidfile, rather than one copied from another
 *      recipe? A boot script pointing at another app's pidfile installs cleanly
 *      and kills nothing.
 *   3. Can the real process actually be signalled, right now, by this user?
 */
export function proveSelfDestructStep(pidFile: string): Step {
  return {
    name: "prove the self-destruct is installed AND can kill this process",
    cmd:
      `test -x ${BOOT_SCRIPT_PATH} || { echo NO_BOOT_SCRIPT; exit 1; }; ` +
      `grep -q "${pidFile}" ${BOOT_SCRIPT_PATH} || { echo BOOT_SCRIPT_WRONG_PIDFILE; exit 1; }; ` +
      `grep -q "pkill" ${BOOT_SCRIPT_PATH} && { echo BOOT_SCRIPT_USES_PKILL; exit 1; }; ` +
      `PID=$(cat ${pidFile} 2>/dev/null); ` +
      `test -n "$PID" || { echo NO_PIDFILE; exit 1; }; ` +
      `test -d /proc/$PID || { echo PID_NOT_RUNNING; exit 1; }; ` +
      `kill -0 "$PID" 2>/dev/null || { echo CANNOT_SIGNAL; exit 1; }; ` +
      `command -v kill >/dev/null || { echo NO_KILL; exit 1; }; ` +
      `echo SELFDESTRUCT_ARMED_OK`,
    expect: "SELFDESTRUCT_ARMED_OK",
  };
}

/**
 * Run a command that outlives the gateway's exec duration limit.
 *
 * The Gitea build hit this: a 90-second health poll inside one `exec` was cut
 * off by the gateway, not by the command. The fix there was to move the loop
 * Node-side and issue short execs. A long build needs the same shape, but the
 * work itself cannot be chopped up, so it is detached instead.
 *
 * The command runs under `setsid` writing to a log, and touches a marker file
 * carrying its exit status when it finishes. Polling then reads the marker with
 * execs that take milliseconds.
 *
 * This is not a retry loop. The command runs exactly once; only the observation
 * repeats.
 */
/**
 * Pull the CAUSE out of a build log, not the end of it.
 *
 * Learned twice now. Metabase's JVM puts "Unsupported class file major version"
 * on the first line and two hundred stack frames after it, so tailing showed
 * only frames. Yarn does the reverse: it prints the real error early and then
 * pages of unmet-peer-dependency warnings, so tailing showed only warnings.
 *
 * Neither end is reliably right, so ask for the error lines first and fall back
 * to the tail only when there are none.
 */
/**
 * Render a build log readable.
 *
 * Yarn draws progress with carriage returns and ANSI cursor escapes. A log full
 * of those satisfies `test -s` (so the poll loop correctly reported RUNNING) and
 * is simultaneously invisible when printed, which is how two forty minute runs
 * reported "build failed" with a blank diagnostic underneath it. The file had
 * content the whole time; nothing that read it stripped the control bytes.
 */
function readable(log: string): string {
  return `tr '\\r' '\\n' < ${log} 2>/dev/null | sed 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g' | tr -cd '[:print:]\\n' | grep -v '^[[:space:]]*$'`;
}

function diagnose(log: string): string {
  // Show CONTEXT around the first error, not just lines matching /error/.
  //
  // Yarn ends with "error Command failed with exit code 1", which matches every
  // error pattern and explains nothing: the actual cause is twenty lines above
  // it, in whatever sub-command died. Grepping for error lines found only the
  // summary and reported that as the diagnosis.
  //
  // So: locate the first error, print the window around it, and print the tail
  // as well. Between them one of the three is the cause, and printing all three
  // is cheaper than another build.
  const r = readable(log);
  return (
    `N=$(${r} | grep -nEi 'error|ERR!|failed|cannot|not found|no space' | head -1 | cut -d: -f1); ` +
    `if [ -n "$N" ]; then S=$((N>25?N-25:1)); ` +
    `echo "--- context around first error (line $N) ---"; ` +
    `${r} | sed -n "$S,$((N+12))p"; fi; ` +
    `echo "--- log ${log} ---"; ` +
    `if [ ! -e ${log} ]; then echo "LOG_MISSING"; ` +
    `elif [ ! -s ${log} ]; then echo "LOG_EMPTY"; ` +
    `else echo "bytes=$(wc -c < ${log})"; echo "--- last 20 readable lines ---"; ${r} | tail -20; fi 2>&1`
  );
}


export async function runLongInGuest(
  sh: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ value: { stdout: string; stderr: string } }>,
  cmd: string,
  opts: {
    marker: string; log: string; timeoutMs: number; intervalMs?: number; label?: string;
    /** Called every `progressEvery` polls with elapsed seconds and the log's last line. */
    onProgress?: (elapsedSec: number, lastLine: string) => void;
    progressEvery?: number;
  },
): Promise<{ ok: boolean; ms: number; status: number | null; polls: number; tail: string }> {
  const interval = opts.intervalMs ?? 5000;
  const t0 = Date.now();

  // The command goes into a FILE first, and only the file's path is ever
  // interpolated into a quoted shell string.
  //
  // The first version inlined `cmd` inside `sh -c '...'`. That works right up
  // until a command contains a single quote of its own, at which point the outer
  // quote closes early and the whole line means something else. Adding an
  // `awk 'NR==2{...}'` to a build command did exactly that: the detached job
  // never started, no marker was ever written, and the poll loop reported
  // RUNNING for seventeen minutes against a sandbox that was doing nothing.
  //
  // A quoting bug that manifests as a hang is worse than one that manifests as
  // an error, so the fix removes the possibility rather than escaping better.
  const script = `${opts.marker}.sh`;
  await sh(
    `mkdir -p $(dirname ${opts.log}); rm -f ${opts.marker}; ` +
      `cat > ${script} <<'BLINK_LONG_EOF'\n${cmd}\nBLINK_LONG_EOF\n` +
      // Proves the file is there before anything is detached. A detached job
      // that fails to start is invisible; this check is not.
      `test -s ${script} || { echo NO_SCRIPT; exit 1; }; ` +
      `setsid sh -c 'sh ${script} >>${opts.log} 2>&1; echo $? >${opts.marker}' >/dev/null 2>&1 & ` +
      `echo STARTED`,
    { timeoutMs: 30_000 },
  );

  let polls = 0;
  let consecutiveErrors = 0;
  while (Date.now() - t0 < opts.timeoutMs) {
    await new Promise((r) => setTimeout(r, interval));
    polls += 1;
    // Ask for the marker AND for proof the job is still alive. Without the
    // second question, a job that never started is indistinguishable from one
    // that is still working, and the loop waits out its whole timeout to say so.
    let out: string;
    try {
      const r = await sh(
        `if [ -f ${opts.marker} ]; then cat ${opts.marker}; ` +
          `elif [ -s ${opts.log} ]; then echo RUNNING; ` +
          `else echo NO_OUTPUT_YET; fi`,
        { timeoutMs: 30_000 },
      );
      out = r.value.stdout.trim();
      consecutiveErrors = 0;
    } catch (err) {
      // A FAILED OBSERVATION IS NOT A FAILED BUILD, AND OBSERVING AGAIN IS NOT A RETRY.
      //
      // This needs stating because the codebase has an absolute rule against
      // retry loops. The rule exists for two reasons: a retry multiplies spend,
      // and a retried 429 hides a bug in the slot guard. Neither applies here.
      // The build is detached inside the guest and is unaffected by whether we
      // managed to look at it; the next tick asks a new question about current
      // state rather than re-issuing a call that failed.
      //
      // The line that must not be crossed: anything carrying an HTTP status,
      // and a GuardBug above all, aborts immediately. Only a transport failure
      // with no response at all is treated as a missed observation, and two in
      // a row still end the run.
      const e = err as Error;
      const isTransport = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|terminated|retry cap exceeded/i.test(
        `${e.name}: ${e.message}`,
      );
      if (e.name === "GuardBug" || !isTransport) throw err;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 2) {
        return { ok: false, ms: Date.now() - t0, status: null, polls,
          tail: `two consecutive observations failed at the transport level, so the build's state is unknown: ${e.message}` };
      }
      continue;
    }
    if (out === "NO_OUTPUT_YET" && polls >= 3) {
      const tail = await sh(`ls -l ${script} 2>&1; head -5 ${opts.log} 2>&1 || echo no-log`, { timeoutMs: 30_000 });
      return { ok: false, ms: Date.now() - t0, status: null, polls,
        tail: `the detached job produced no output at all after ${polls} polls, so it probably never started:\n${tail.value.stdout}` };
    }
    if (out === "NO_OUTPUT_YET") continue;

    // Report progress while the job runs, not only when it ends.
    //
    // A 25 minute build that fails at the end tells you nothing about where the
    // time went. These polls are already happening, so reading the log's last
    // line costs nothing extra and turns a silent wait into a trace.
    if (opts.onProgress && polls % (opts.progressEvery ?? 6) === 0) {
      try {
        // Translate carriage returns before taking the last line. Progress bars
        // rewrite one line with \r, so a plain `tail -1` on a yarn or npm log
        // returns whatever came after the final \r, which is usually nothing.
        const p = await sh(
          `echo "disk=$(df -Pm / | awk 'NR==2{print $4}')MB $(${readable(opts.log)} | tail -1 | cut -c1-140)"`,
          { timeoutMs: 30_000 },
        );
        opts.onProgress(Math.round((Date.now() - t0) / 1000), p.value.stdout.trim());
      } catch { /* progress is never worth failing a build over */ }
    }
    if (out !== "RUNNING" && out !== "") {
      const status = Number(out.split("\n").pop());
      const tail = await sh(diagnose(opts.log), { timeoutMs: 30_000 });
      return { ok: status === 0, ms: Date.now() - t0, status, polls, tail: tail.value.stdout };
    }
  }
  const tail = await sh(diagnose(opts.log), { timeoutMs: 30_000 });
  return { ok: false, ms: Date.now() - t0, status: null, polls, tail: tail.value.stdout };
}
