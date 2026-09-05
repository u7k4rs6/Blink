/**
 * The single redaction point. Every writer routes through here.
 *
 * WHY THIS IS ONE MODULE AND NOT A HELPER EACH SURFACE REMEMBERS TO CALL:
 *
 * An earlier version lived in the report writer and covered two of the four
 * forms the preview capability travels in. The `__pt_preview` cookie form went
 * through untouched, and every gate report written before 2026-09-03 carried it
 * to disk. Discipline did not work; the writer has to be safe by default.
 *
 * There are two kinds of secret here and they need different machinery:
 *
 *   PATTERNED   `?pt_token=`, `__pt_preview=`, `AWSALB=`, `slr_live_...`
 *               Recognisable by shape, so a regex finds them anywhere.
 *
 *   OPAQUE      Solari browser session ids are 113-character strings that embed
 *               the org id, and the org id itself is a bare identifier. No regex
 *               can recognise those, because they look like any other token. The
 *               sweep on 2026-09-03 found twelve of them in a stored gate report
 *               precisely because pattern matching cannot see them.
 *
 * So opaque values are REGISTERED at the moment they are first observed, and
 * every subsequent write scrubs them. A gate that touches a session id registers
 * it; nothing downstream has to know it exists.
 */

/** Opaque values registered at runtime. Never persisted, never printed. */
const secrets = new Set<string>();

/**
 * Register a value that must never reach disk or a log line.
 *
 * Short strings are ignored: registering something like "ok" or a 4-character id
 * would redact half of every report and hide real content.
 */
export function registerSecret(value: string | null | undefined): void {
  if (!value) return;
  const v = String(value);
  if (v.length < 12) return;
  secrets.add(v);
}

/** For tests and diagnostics. Returns the count, never the values. */
export function registeredSecretCount(): number {
  return secrets.size;
}

export function clearSecrets(): void {
  secrets.clear();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub every known secret form from a string.
 *
 * Patterned forms first, then registered opaque values, longest first so a
 * session id containing an org id is redacted whole rather than leaving a
 * mangled remainder.
 */
export function redact(s: string): string {
  let out = s
    .replace(/([?&]pt_token=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/(slr_live_)[A-Za-z0-9_\-]+/g, "$1REDACTED")
    .replace(/(x-pinetree-preview-token["':\s]+)[^\s"',}]+/gi, "$1REDACTED")
    .replace(/(__pt_preview=)[^;,\s"']+/gi, "$1REDACTED")
    .replace(/\b(AWSALBCORS|AWSALB)=[^;,\s"']+/gi, "$1=REDACTED")
    // Any bare JWT-shaped token, wherever it appears. The preview cookie is one,
    // but so is anything else three-segment and base64url.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "REDACTED_JWT")
    // Solari sandbox ids are long base64.signature tokens that DECODE to
    // `desktop-pool-i-<cloud instance id>:vm_<n>:<orgId>:<ts>`, and they appear
    // in the path of every single request. The 2026-09-03 sweep found the host
    // pool identifier in all four gate data files for exactly this reason. This
    // catches them in URLs and paths; registerSecret catches them everywhere else.
    .replace(/(\/(?:sandboxes|desktops|sessions)\/)[A-Za-z0-9_-]{24,}(\.[A-Za-z0-9_-]+)?/g, "$1REDACTED_ID")
    // Any bare base64 blob that decodes to a pool identifier, wherever it sits.
    // Deliberately loose on length: a bare 16-character prefix of a sandbox id is
    // exactly base64("desktop-pool"), so an earlier {16,} bound let truncated
    // ids through. Anything starting this way is redacted whole.
    .replace(/\bZGVza3RvcC[A-Za-z0-9_-]*/g, "REDACTED_ID")
    // Database connection strings. The password sits between the second colon
    // and the @, and a pooler URL also carries the project ref in the username,
    // so the whole credential section goes rather than just the password.
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s"'`,)]+/gi, "$1REDACTED_CONNECTION_STRING")
    // Bare Supabase hosts, which identify the project even without credentials.
    .replace(/\b[A-Za-z0-9_.-]*\.(?:pooler\.)?supabase\.(?:co|com)\b/gi, "REDACTED_HOST")
    // Any other URL carrying userinfo, since that is a password by definition.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+:[^\s/@"']+@/gi, "$1REDACTED_CREDENTIALS@");

  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("REDACTED_ID");
  }
  return out;
}

/**
 * A non-reversible short handle for an opaque id, safe to put in a report.
 *
 * Use this instead of storing the id itself when a report needs to distinguish
 * twelve tiles from one another but does not need to address them.
 */
export function handleFor(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return `id_${(h >>> 0).toString(36)}`;
}
