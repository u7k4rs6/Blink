/**
 * Snapshot recipe: Gitea 1.27.3.
 *
 * Produces a snapshot of a running, seeded Gitea that a fork can resume into a
 * working instance. Nothing here runs a gate; building and gating are separate
 * steps on purpose (`npm run snapshot -- gitea`, then `npm run gate:g1`).
 *
 * FOUR RULES THIS RECIPE FOLLOWS, ALL PAID FOR IN BLOOD EARLIER:
 *
 *  1. Every command goes through `adapter.exec`, which wraps in `sh -c`. The
 *     SDK's `commands.run` is NOT a shell, so `&&`, `||`, heredocs and redirects
 *     are otherwise passed as literal arguments and silently do nothing
 *     (00-verification.md V17b).
 *  2. Assert on POSTCONDITIONS, never exit codes. A recipe that appears to
 *     succeed while doing nothing is the failure mode here: the first live pass
 *     produced three different wrong answers that way. Every step below checks
 *     that a file exists, a version prints, or a port answers.
 *  3. Health checks run over LOOPBACK inside the guest, not through previewUrl.
 *     The preview domain costs about 265 ms per request (V59) and a poll loop is
 *     up to 60 requests, so polling through it would add roughly 16 s of pure
 *     routing to every fork-to-healthy measurement.
 *  4. ROOT_URL is NOT baked into the snapshot. Gitea writes absolute URLs from
 *     it, and the correct value is only known after the fork, so the boot script
 *     patches app.ini per instance and restarts before the health check
 *     (02-architecture.md section 6).
 */


import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_SMALL, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { REGISTRY_PATH, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { prerequisiteStep, proveSelfDestructStep } from "./lib/template.ts";
import { safeErr, safeOut, safeWriteJsonSync } from "../../src/safe-io.ts";
import { SEEDED } from "../../src/catalog/credentials.ts";

export const GITEA_VERSION = "1.27.3";
export const GITEA_PORT = 3000;
export const GITEA_HEALTH = "/api/healthz";
const GITEA_URL = `https://dl.gitea.com/gitea/${GITEA_VERSION}/gitea-${GITEA_VERSION}-linux-amd64`;
/** Published alongside the binary. Verified after download, before first run. */
const GITEA_SHA_URL = `${GITEA_URL}.sha256`;

const ADMIN_USER = "blink";
const ADMIN_EMAIL = "blink@example.invalid";

/** One step: a shell command plus the postcondition that proves it worked. */
type Step = {
  name: string;
  /** Runs through sh -c. */
  cmd: string;
  /** Must appear in stdout for the step to count as done. */
  expect: string;
  /** Seconds to allow before treating a missing postcondition as failure. */
  slowOk?: boolean;
};

/**
 * The recipe, as data. Written this way so it can be read start to finish, and
 * so `--dry-run` can print it without a sandbox.
 */
export function giteaSteps(adminPassword: string): Step[] {
  return [
    prerequisiteStep(['curl', 'sha256sum'].map(String)),
    {
      name: "install prerequisites",
      // base ships curl (G6 confirmed) but not sqlite3 or git.
      cmd:
        "( command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl) ) " +
        "&& ( command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git) ) " +
        "&& curl --version | head -1 && git --version && echo PREREQS_OK",
      expect: "PREREQS_OK",
    },
    {
      name: "create the gitea user and directory layout",
      // Gitea runs as a non-root user. This is not a network control (there is
      // none, V57) but it does keep the app off root and out of /root.
      cmd:
        "id -u git >/dev/null 2>&1 || useradd --system --shell /bin/bash --home /home/git -m git; " +
        "mkdir -p /var/lib/gitea/custom /var/lib/gitea/data /var/lib/gitea/log /etc/gitea " +
        "&& chown -R git:git /var/lib/gitea && chmod 750 /var/lib/gitea " +
        "&& chown root:git /etc/gitea && chmod 770 /etc/gitea " +
        "&& test -d /var/lib/gitea/data && echo LAYOUT_OK",
      expect: "LAYOUT_OK",
    },
    {
      name: "download the binary and verify its published checksum",
      // Verify BEFORE the first execution, not after. The .sha256 for the raw
      // binary checksums the binary itself, unlike Jaeger's tarball where the
      // published sums cover the extracted files (V46).
      cmd:
        `curl -fsSL -o /usr/local/bin/gitea ${GITEA_URL} ` +
        `&& curl -fsSL -o /tmp/gitea.sha256 ${GITEA_SHA_URL} ` +
        "&& cd /usr/local/bin " +
        "&& echo \"$(cut -d' ' -f1 /tmp/gitea.sha256)  gitea\" | sha256sum -c - " +
        "&& chmod +x /usr/local/bin/gitea " +
        "&& echo CHECKSUM_OK",
      expect: "CHECKSUM_OK",
    },
    {
      name: "confirm the binary runs and is the expected version",
      cmd: `/usr/local/bin/gitea --version | head -1 | grep -q "${GITEA_VERSION}" && /usr/local/bin/gitea --version | head -1 && echo VERSION_OK`,
      expect: "VERSION_OK",
    },
    {
      name: "generate gitea secrets at build time",
      // Gitea mints JWT_SECRET, SECRET_KEY, INTERNAL_TOKEN and LFS_JWT_SECRET on
      // first run and WRITES THEM BACK into app.ini. The first build attempt died
      // on exactly that: app.ini was 640 root:git, so the write was refused and
      // Gitea treated it as fatal:
      //
      //   [F] save oauth2.JWT_SECRET failed: ... permission denied
      //
      // Generating them here means the running app never needs to write its own
      // config. Every fork shares these values, which is the same shared-secret
      // property already recorded as T8: instances are single-tenant, disposable
      // and dead in ten minutes, and the card says credentials are shared.
      cmd:
        "JWT=$(/usr/local/bin/gitea generate secret JWT_SECRET) " +
        "&& SEC=$(/usr/local/bin/gitea generate secret SECRET_KEY) " +
        "&& INT=$(/usr/local/bin/gitea generate secret INTERNAL_TOKEN) " +
        "&& LFS=$(/usr/local/bin/gitea generate secret LFS_JWT_SECRET) " +
        "&& mkdir -p /var/lib/gitea/secrets " +
        "&& printf '%s\\n%s\\n%s\\n%s\\n' \"$JWT\" \"$SEC\" \"$INT\" \"$LFS\" > /var/lib/gitea/secrets/v " +
        "&& chmod 600 /var/lib/gitea/secrets/v " +
        "&& test -s /var/lib/gitea/secrets/v " +
        "&& test $(wc -l < /var/lib/gitea/secrets/v) -eq 4 " +
        "&& echo SECRETS_OK",
      expect: "SECRETS_OK",
    },
    {
      name: "write app.ini with generated secrets and a placeholder ROOT_URL",
      // ROOT_URL stays a placeholder: it is rewritten per instance by blink-boot
      // after the fork, because the preview host is not knowable now and Gitea
      // bakes it into every absolute URL it emits.
      //
      // Mode is 660 root:git, not 640. The secrets above mean Gitea should never
      // need to write this file, but if a future version wants to persist
      // something else, a refused write is a FATAL error rather than a warning.
      // Group-writable is the difference between a degraded instance and no
      // instance, and costs nothing on a single-tenant disposable box.
      cmd:
        "JWT=$(sed -n 1p /var/lib/gitea/secrets/v); " +
        "SEC=$(sed -n 2p /var/lib/gitea/secrets/v); " +
        "INT=$(sed -n 3p /var/lib/gitea/secrets/v); " +
        "LFS=$(sed -n 4p /var/lib/gitea/secrets/v); " +
        "cat > /etc/gitea/app.ini <<INI\n" +
        "APP_NAME = Blink Gitea\n" +
        "RUN_USER = git\n" +
        "RUN_MODE = prod\n" +
        "WORK_PATH = /var/lib/gitea\n" +
        "\n[server]\n" +
        `HTTP_PORT = ${GITEA_PORT}\n` +
        "HTTP_ADDR = 0.0.0.0\n" +
        "ROOT_URL = http://localhost:3000/\n" +
        "DISABLE_SSH = true\n" +
        "OFFLINE_MODE = true\n" +
        "LFS_START_SERVER = false\n" +
        "\n[database]\n" +
        "DB_TYPE = sqlite3\n" +
        "PATH = /var/lib/gitea/data/gitea.db\n" +
        "\n[security]\n" +
        "INSTALL_LOCK = true\n" +
        "SECRET_KEY = $SEC\n" +
        "INTERNAL_TOKEN = $INT\n" +
        "\n[oauth2]\n" +
        "JWT_SECRET = $JWT\n" +
        "\n[lfs]\n" +
        "JWT_SECRET = $LFS\n" +
        "\n[service]\n" +
        "DISABLE_REGISTRATION = true\n" +
        "\n[repository]\n" +
        "ROOT = /var/lib/gitea/data/repositories\n" +
        "\n[log]\n" +
        "ROOT_PATH = /var/lib/gitea/log\n" +
        "LEVEL = info\n" +
        "INI\n" +
        "chown root:git /etc/gitea/app.ini && chmod 660 /etc/gitea/app.ini " +
        "&& grep -q 'DB_TYPE = sqlite3' /etc/gitea/app.ini " +
        "&& grep -q '^JWT_SECRET = .\\{10,\\}' /etc/gitea/app.ini " +
        "&& grep -q '^INTERNAL_TOKEN = .\\{10,\\}' /etc/gitea/app.ini " +
        "&& echo INI_OK",
      expect: "INI_OK",
    },
    {
      name: "start gitea",
      // The command goes in a FILE. It used to be inlined as
      // `sh -c 'echo $$ > pid; exec env ... su git -c '/usr/local/bin/gitea web --config ...''`
      // where the inner single quote CLOSES the outer one, so `--config` was
      // word-split off and never reached gitea. It then fell back to its default
      // config path, found nothing, and served its INSTALL PAGE.
      //
      // Which answered /api/healthz with 200 the whole time. The health check
      // passed, `STARTED` was printed because the pidfile existed, and every
      // /api/v1 route returned 404 because the API is not mounted during install.
      // A postcondition that was true and irrelevant, again, and a quoting bug
      // that reappeared here after being fixed in runLongInGuest.
      cmd:
        "cat > /usr/local/bin/blink-start-gitea <<'SH'\n" +
        "#!/bin/sh\n" +
        "echo $$ > /var/lib/gitea/app.pid\n" +
        "exec env GITEA_WORK_DIR=/var/lib/gitea HOME=/var/lib/gitea " +
        "/usr/local/bin/gitea web --config /etc/gitea/app.ini\n" +
        "SH\n" +
        "chmod +x /usr/local/bin/blink-start-gitea; " +
        "( setsid su git -c /usr/local/bin/blink-start-gitea >/var/lib/gitea/log/boot.log 2>&1 & ); " +
        "sleep 2; " +
        "test -s /var/lib/gitea/app.pid || { echo NO_PIDFILE; exit 1; }; " +
        // Assert the config we wrote is the config it LOADED. This is the check
        // whose absence let an install page pass as a running Gitea.
        "grep -q 'ConfigFile: /etc/gitea/app.ini' /var/lib/gitea/log/boot.log || " +
        "{ echo WRONG_CONFIG_LOADED; tail -6 /var/lib/gitea/log/boot.log; exit 1; }; " +
        "grep -q 'Prepare to run install page' /var/lib/gitea/log/boot.log && " +
        "{ echo STILL_IN_INSTALL_MODE; exit 1; }; " +
        "echo STARTED",
      expect: "STARTED",
    },
    {
      name: "wait for gitea to answer on loopback",
      // A MARKER step. The polling itself is done by waitHealthyInGuest from a
      // Node-side loop of short execs, not by a long loop inside one exec: that
      // is exactly what failed on the first build attempt with a bare
      // `GatewayError: exec failed`. See scripts/gates/lib/health.ts.
      cmd: "__HEALTH_POLL__",
      expect: "HEALTHY",
      slowOk: true,
    },
    {
      name: "wait for the schema, not just the port",
      // Gitea answers HTTP before its migrations have finished, so a health
      // check that passes says nothing about whether the database has tables.
      // `admin user create` then fails with "no such table: user".
      //
      // This raced and won on the first build and lost on the next one, which is
      // the worst kind of build step: one that works until it does not, for
      // reasons unrelated to anything that changed. `gitea migrate` is
      // idempotent and blocks until the schema is there, and `admin user list`
      // is the cheapest thing that actually touches the `user` table, so it
      // proves the schema rather than assuming the migration meant something.
      //
      // The user is `git` and GITEA_WORK_DIR has to be set, matching every other
      // gitea invocation in this recipe. The first version of this step used a
      // `gitea` user that does not exist and sent stderr to /dev/null, so it
      // failed with completely empty output and said nothing about why.
      cmd:
        `env GITEA_WORK_DIR=/var/lib/gitea su git -c ` +
        `'/usr/local/bin/gitea migrate --config /etc/gitea/app.ini' 2>&1 | tail -3; ` +
        `env GITEA_WORK_DIR=/var/lib/gitea su git -c ` +
        `'/usr/local/bin/gitea admin user list --config /etc/gitea/app.ini' 2>&1 | tail -3; ` +
        `env GITEA_WORK_DIR=/var/lib/gitea su git -c ` +
        `'/usr/local/bin/gitea admin user list --config /etc/gitea/app.ini' >/dev/null 2>&1 ` +
        `|| { echo SCHEMA_NOT_READY; exit 1; }; ` +
        `echo SCHEMA_OK`,
      expect: "SCHEMA_OK",
      slowOk: true,
    },
    {
      name: "create the admin user",
      // Documented CLI path (V51). Password is per-snapshot, not per-fork; the
      // card states plainly that credentials are shared and the instance is
      // disposable (03-security-and-access.md, T8).
      cmd:
        "env GITEA_WORK_DIR=/var/lib/gitea su git -c " +
        `'/usr/local/bin/gitea admin user create --admin --username ${ADMIN_USER} ` +
        `--password "${adminPassword}" --email ${ADMIN_EMAIL} --must-change-password=false ` +
        `--config /etc/gitea/app.ini' 2>&1 | tail -2; ` +
        `env GITEA_WORK_DIR=/var/lib/gitea su git -c ` +
        `'/usr/local/bin/gitea admin user list --config /etc/gitea/app.ini' | grep -q ${ADMIN_USER} && echo ADMIN_OK`,
      expect: "ADMIN_OK",
    },
    {
      name: "seed a repository with content",
      cmd:
        `echo "--- boot.log ---"; tail -12 /var/lib/gitea/log/boot.log 2>&1 | tr -cd '[:print:]\\n'; ` +
        `echo "--- gitea.log ---"; tail -8 /var/lib/gitea/log/gitea.log 2>&1 | tr -cd '[:print:]\\n'; ` +
        `for P in /api/healthz /api/v1/version /api/swagger /api/v1/settings/api /explore; do ` +
        `echo "probe $P=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${GITEA_PORT}$P)"; done; ` +
        // Probe the API surface before using it. A 404 on a token endpoint can
        // mean the route moved, the API is disabled, or basic auth is off, and
        // an HTML "Not Found" body distinguishes none of them.
        `echo "api_version=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${GITEA_PORT}/api/v1/version)"; ` +
        `echo "api_body=$(curl -s http://127.0.0.1:${GITEA_PORT}/api/v1/version | head -c 120)"; ` +
        `echo "authed_user=$(curl -s -o /dev/null -w '%{http_code}' -u ${ADMIN_USER}:'${adminPassword}' http://127.0.0.1:${GITEA_PORT}/api/v1/user)"; ` +
        // -s not -sf, and the body is captured, so a rejection can be READ.
        // The first version used -sf and discarded the response, so a failure
        // arrived as the single word NO_TOKEN with no indication of whether the
        // credentials were wrong, the endpoint had moved, or the server was
        // still starting. A token name has to be unique per user, so it also
        // carries a timestamp: a rebuild against an existing snapshot state
        // would otherwise be rejected for reusing "blink-seed".
        `TOKRESP=$(curl -s -w '\\n%{http_code}' -u ${ADMIN_USER}:'${adminPassword}' -X POST ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"name":"blink-seed-'"$(date +%s)"'","scopes":["write:repository","write:issue","write:user"]}' ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/users/${ADMIN_USER}/tokens); ` +
        `echo "token_http=$(echo "$TOKRESP" | tail -1)"; ` +
        `TOKEN=$(echo "$TOKRESP" | sed -n 's/.*"sha1":"\\([^"]*\\)".*/\\1/p'); ` +
        `test -n "$TOKEN" || { echo "NO_TOKEN, server said: $(echo "$TOKRESP" | head -c 300)"; exit 1; }; ` +
        // Assert the token actually authenticates, rather than that a string
        // came back. A malformed token is non-empty and useless.
        `curl -sf -H "Authorization: token $TOKEN" http://127.0.0.1:${GITEA_PORT}/api/v1/user | grep -q '"login"' || { echo TOKEN_UNUSABLE; exit 1; }; ` +
        `echo "$TOKEN" > /var/lib/gitea/seed-token && chmod 600 /var/lib/gitea/seed-token; ` +
        `curl -sf -X POST -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' ` +
        `-d '{"name":"welcome","description":"A seeded repo to poke at","auto_init":true,"private":false}' ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/user/repos >/dev/null ` +
        `&& curl -sf -H "Authorization: token $TOKEN" ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome | grep -q '"name":"welcome"' ` +
        `&& echo REPO_OK`,
      expect: "REPO_OK",
    },
    {
      name: "seed three issues",
      // Postcondition asserts the issues by count AND that the API returns them,
      // not a neighbouring signal.
      cmd:
        `TOKEN=$(cat /var/lib/gitea/seed-token); ` +
        `for t in "Typo in the README" "Add a contributing guide" "Support dark mode"; do ` +
        `curl -sf -X POST -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' ` +
        `-d "{\\"title\\":\\"$t\\",\\"body\\":\\"Seeded by Blink so this instance has something to look at.\\"}" ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/issues >/dev/null || exit 1; done; ` +
        `N=$(curl -sf -H "Authorization: token $TOKEN" ` +
        `"http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/issues?state=all&type=issues" ` +
        `| grep -o '"number"' | wc -l); ` +
        `echo "issues=$N"; test "$N" -ge 3 && echo ISSUES_OK`,
      expect: "ISSUES_OK",
    },
    {
      name: "create a branch with a real commit",
      // Split out from the PR step. A branch that does not differ from main
      // produces no pull request, and the previous version hid that: it sent
      // both -X POST and -X PUT on one curl (the last wins, so POST was
      // discarded) and swallowed the result with `|| true`.
      //
      // Gitea's contents API needs the existing file's sha to update it, so
      // fetch that first. Content is base64: "# Welcome\n\nEdited on a branch.\n"
      cmd:
        `TOKEN=$(cat /var/lib/gitea/seed-token); ` +
        `SHA=$(curl -sf -H "Authorization: token $TOKEN" ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/contents/README.md ` +
        `| sed -n 's/.*"sha":"\\([^"]*\\)".*/\\1/p' | head -1); ` +
        `test -n "$SHA" || { echo NO_README_SHA; exit 1; }; ` +
        `curl -sf -X PUT -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' ` +
        `-d "{\\"content\\":\\"IyBXZWxjb21lCgpFZGl0ZWQgb24gYSBicmFuY2guCg==\\",` +
        `\\"message\\":\\"Edit README on a branch\\",\\"sha\\":\\"$SHA\\",\\"new_branch\\":\\"tweak-readme\\"}" ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/contents/README.md >/dev/null || exit 1; ` +
        `curl -sf -H "Authorization: token $TOKEN" ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/branches/tweak-readme ` +
        `| grep -q '"name":"tweak-readme"' && echo BRANCH_OK`,
      expect: "BRANCH_OK",
    },
    {
      name: "open the pull request",
      // THE central beat of the recording and step one of the try-first card, so
      // the postcondition asserts the PR itself: that it exists, that it is open,
      // and that it has the expected title. An issue count cannot see any of that.
      cmd:
        `TOKEN=$(cat /var/lib/gitea/seed-token); ` +
        `curl -sf -X POST -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' ` +
        `-d '{"title":"Tweak the README","head":"tweak-readme","base":"main",` +
        `"body":"Open me, leave a comment, watch it appear."}' ` +
        `http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/pulls >/dev/null || exit 1; ` +
        `PR=$(curl -sf -H "Authorization: token $TOKEN" ` +
        `"http://127.0.0.1:${GITEA_PORT}/api/v1/repos/${ADMIN_USER}/welcome/pulls?state=open"); ` +
        `echo "$PR" | grep -q '"title":"Tweak the README"' || { echo PR_TITLE_MISSING; exit 1; }; ` +
        `echo "$PR" | grep -q '"state":"open"' || { echo PR_NOT_OPEN; exit 1; }; ` +
        `NUM=$(echo "$PR" | sed -n 's/.*"number":\\([0-9]*\\).*/\\1/p' | head -1); ` +
        `test -n "$NUM" || { echo PR_NO_NUMBER; exit 1; }; ` +
        `echo "pr_number=$NUM"; echo PRS_OK`,
      expect: "PRS_OK",
    },
    {
      name: "install the per-instance boot script",
      // Runs on every fork, before the health check. Two jobs: point ROOT_URL at
      // the real preview host, and arm layer 2 of the expiry design, the
      // guest-side self-destruct, which is the only layer indifferent to visitor
      // activity (02-architecture.md section 8.2).
      cmd:
        "cat > /usr/local/bin/blink-boot <<'SH'\n" +
        "#!/bin/sh\n" +
        "# Usage: blink-boot <root_url> <lifetime_seconds>\n" +
        "set -e\n" +
        "ROOT_URL=\"$1\"\n" +
        "LIFETIME=\"${2:-600}\"\n" +
        "sed -i \"s#^ROOT_URL = .*#ROOT_URL = ${ROOT_URL}#\" /etc/gitea/app.ini\n" +
        "# `|| true` is correct here: kill exits non-zero when the pidfile is\n" +
        "# absent or the process is already gone, which is the normal case on the\n" +
        "# very first boot. Any other failure still surfaces, because the health\n" +
        "# check that follows is the real postcondition.\n" +
        "kill -9 $(cat /var/lib/gitea/app.pid 2>/dev/null) 2>/dev/null || true\n" +
        "sleep 1\n" +
        "setsid env GITEA_WORK_DIR=/var/lib/gitea su git -c \\\n" +
        "  '/usr/local/bin/gitea web --config /etc/gitea/app.ini' >/var/lib/gitea/log/boot.log 2>&1 &\n" +
        "# Layer 2: hard wall-clock self-destruct, indifferent to visitor activity.\n" +
        "setsid sh -c \"sleep ${LIFETIME}; kill -9 \\$(cat /var/lib/gitea/app.pid 2>/dev/null) 2>/dev/null; echo blink-selfdestruct-fired >> /var/lib/gitea/log/boot.log\" >/dev/null 2>&1 &\n" +
        "echo BOOT_OK\n" +
        "SH\n" +
        "chmod +x /usr/local/bin/blink-boot && test -x /usr/local/bin/blink-boot && echo BOOTSCRIPT_OK",
      expect: "BOOTSCRIPT_OK",
    },
    proveSelfDestructStep("/var/lib/gitea/app.pid"),
    {
      name: "verify the seeded state one last time before snapshotting",
      cmd:
        `curl -sf -o /dev/null http://127.0.0.1:${GITEA_PORT}${GITEA_HEALTH} ` +
        `&& curl -sf http://127.0.0.1:${GITEA_PORT}/api/v1/version | grep -q version ` +
        `&& test -f /var/lib/gitea/data/gitea.db ` +
        `&& du -sh /var/lib/gitea/data/gitea.db | cut -f1 ` +
        `&& echo FINAL_OK`,
      expect: "FINAL_OK",
    },
  ];
}

// ---------------------------------------------------------------------------

function randomPassword(): string {
  return "blink-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

async function build(dryRun: boolean): Promise<number> {
  // Deterministic, not random. A random build-time password makes the instance
  // unusable (the visitor has to log in) and makes every check that needs
  // authentication impossible to write. See src/catalog/credentials.ts for why
  // publishing it costs nothing: the capability URL is the control, not this.
  const adminPassword = process.env.BLINK_GITEA_PASSWORD ?? SEEDED.gitea.password;
  const steps = giteaSteps(adminPassword);

  if (dryRun) {
    safeOut(`\nGitea ${GITEA_VERSION} snapshot recipe, ${steps.length} steps.\n`);
    safeOut(`Nothing below has run. No sandbox was created and no credits were spent.\n\n`);
    steps.forEach((st, i) => {
      safeOut(`${String(i + 1).padStart(2)}. ${st.name}\n`);
      safeOut(`    postcondition: stdout contains ${JSON.stringify(st.expect)}\n`);
      safeOut(`    ${st.cmd.replace(/\n/g, "\n    ")}\n\n`);
    });
    return 0;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey || apiKey.includes("replace_me")) {
    safeErr("SOLARI_API_KEY is not set.\n");
    return 2;
  }
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const guard = new BudgetGuard(plan, 0.05);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const counting = createCountingFetch({ caps: CAPS_GATES });
  const adapter = new SolariAdapter({ counting, guard, ledger });

  safeOut(`\nBuilding Gitea ${GITEA_VERSION} snapshot. ${steps.length} steps.\n`);
  const bornAt = performance.now();
  let sandboxId: string | null = null;
  let snapshotId: string | null = null;

  try {
    const sb = await adapter.createSandbox(
      apiKey, "snapshot:gitea",
      {
        template: "base", cpu: SIZE_SMALL.cpu, memMb: SIZE_SMALL.memMb,
        timeoutMs: 900_000, lifecycle: { onTimeout: "kill" },
        metadata: { blink_build: "gitea", blink_version: GITEA_VERSION },
      },
      0.02,
    );
    sandboxId = sb.value.sandboxId;
    safeOut(`  sandbox ${sandboxId.slice(0, 16)} up\n`);

    const sh = (cmd: string, o?: { timeoutMs?: number }) =>
      adapter.exec(apiKey, sb.value, "snapshot:gitea", cmd, o);

    for (const [i, st] of steps.entries()) {
      const t0 = performance.now();
      let out: string;
      if (st.cmd === "__HEALTH_POLL__") {
        const h = await waitHealthyInGuest(sh, GITEA_PORT, GITEA_HEALTH, { timeoutMs: 120_000 });
        out = h.ok ? "HEALTHY" : `not healthy: ${h.error ?? "unknown"}`;
        safeOut(`      polled ${h.execCalls} times over ${h.ms} ms\n`);
        if (!h.ok) {
          const log = await sh("tail -20 /var/lib/gitea/log/boot.log 2>&1 || echo no-log");
          safeErr(`      boot.log:\n${log.value.stdout.trim().slice(0, 800)}\n`);
        }
      } else {
        const r = await sh(st.cmd, { timeoutMs: 60_000 });
        out = `${r.value.stdout}\n${r.value.stderr}`;
      }
      const ms = Math.round(performance.now() - t0);
      const ok = out.includes(st.expect);
      safeOut(`  ${String(i + 1).padStart(2)}. ${ok ? "ok  " : "FAIL"} ${st.name} (${ms} ms)\n`);
      if (!ok) {
        // Postcondition, not exit code. A step can exit 0 and have done nothing.
        safeErr(`\n     expected ${JSON.stringify(st.expect)} in output, got:\n`);
        safeErr(`     ${out.trim().slice(0, 900)}\n`);
        throw new Error(`step ${i + 1} (${st.name}) postcondition not met`);
      }
      const interesting = out.trim().split("\n").filter((l) => l && !l.includes(st.expect) && l !== "WAITING");
      if (interesting.length > 0) safeOut(`      ${interesting.slice(-2).join(" | ").slice(0, 150)}\n`);
    }

    const snap = await adapter.snapshot(
      apiKey, sb.value, "snapshot:gitea",
      `gitea-${GITEA_VERSION}-${new Date().toISOString().slice(0, 10)}`,
    );
    snapshotId = snap.value;
    safeOut(`\n  snapshot ${snapshotId} created in ${snap.ms} ms\n`);

    const reg = loadRegistry();
    reg.gitea = snapshotId;
    safeWriteJsonSync(REGISTRY_PATH, reg);
    safeOut(`  recorded in ${REGISTRY_PATH}\n`);
    safeOut(`\n  admin credentials (shared across every fork, by design): ${ADMIN_USER} / ${adminPassword}\n`);
  } finally {
    if (sandboxId) {
      await adapter.killQuiet(apiKey, sandboxId, "snapshot:gitea");
      const lived = (performance.now() - bornAt) / 1000;
      guard.addSandboxSeconds(lived, SIZE_SMALL, true, "gitea snapshot build, observed lifetime");
    }
    const s = guard.summary();
    safeOut(`\n  cost: ${s.sandboxSeconds} sandbox-seconds, $${s.usd.toFixed(5)} at ${plan.name} rates (100% measured)\n`);
  }
  return snapshotId ? 0 : 1;
}

/**
 * Only build when this file IS the program.
 *
 * It used to run on import, which meant a unit test that imported a recipe to
 * check one exported constant would try to create a sandbox. A module that
 * spends money as a side effect of being read is a module that cannot be tested.
 */
const isMainModule = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  process.exit(await build(process.argv.includes("--dry-run")));
}
