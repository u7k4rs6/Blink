/**
 * Seeded credentials for the catalog apps.
 *
 * These are deliberately fixed and public. Two reasons, and the first is the one
 * that matters: the visitor has to log in. An instance of Gitea or Metabase that
 * nobody can sign into is not a demo of anything, so the credentials appear on
 * the instance toolbar. A random build-time password made the app unusable and
 * made every check that needed authentication impossible to write.
 *
 * The second is that they protect nothing. Each instance is single-visitor,
 * lives about ten minutes, is reachable only through an unguessable `pt_token`
 * URL (V21), and is destroyed afterwards. The password is not the control; the
 * capability URL is.
 *
 * What this does NOT license: reusing these anywhere a real account exists.
 */

export const SEEDED = {
  gitea: { user: "blink", password: "blink-demo-2026", email: "blink@example.invalid", // The repo the recipe actually creates. It is NOT the token name,
  // which is what the first version of this file assumed.
  repo: "welcome" },
  metabase: { user: "blink@example.invalid", password: "blink-demo-2026" },
  uptimekuma: { user: "blink", password: "blink-demo-2026" },
  /** Jaeger and Excalidraw have no accounts at all. */
  jaeger: { service: "frontend" },
  excalidraw: {},
} as const;
