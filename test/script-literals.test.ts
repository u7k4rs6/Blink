/**
 * The inline browser scripts, checked as TEXT and nothing else.
 *
 * This file imports nothing from `src/web` on purpose, and that is the whole
 * reason it exists separately.
 *
 * `PIXELS_SCRIPT` and `MOTION_SCRIPT` are template literals. A backtick inside
 * one ends it early and the module stops being parseable TypeScript. When that
 * happens, every test file that imports `render.ts` (which imports both) fails
 * at collection, so `web.test.ts` reports as a single failed FILE, 96 tests do
 * not run, and nothing anywhere names the character responsible. Node points at
 * whatever line follows the stray backtick, which is usually English prose, and
 * says "Expected a semicolon".
 *
 * A guard living in `web.test.ts` cannot help, because it is in the file that
 * cannot load. That was the first version of this test and it was silent for
 * exactly the fault it was written for. Reading the source as a string, from a
 * file with no such import, is what makes it able to speak.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BACKTICK = String.fromCharCode(96);

const SCRIPTS = [
  { name: "pixels", decl: "PIXELS_SCRIPT" },
  { name: "motion", decl: "MOTION_SCRIPT" },
] as const;

test("no backtick appears inside a script template, because it would close it", () => {
  for (const { name, decl } of SCRIPTS) {
    const src = readFileSync(new URL(`../src/web/${name}.ts`, import.meta.url), "utf8");
    // Anchor on the declaration rather than the first backtick in the file:
    // both modules carry backticks in the JSDoc ABOVE the template, which is
    // where they are harmless and where a naive scan trips over them.
    const marker = `export const ${decl} = ${BACKTICK}`;
    const at = src.indexOf(marker);
    assert.ok(at > 0, `${name}.ts: could not find ${decl}`);
    const open = at + marker.length - 1;
    const close = src.lastIndexOf(BACKTICK);
    assert.ok(close > open, `${name}.ts: the template literal is not closed`);

    const inner = src.slice(open + 1, close);
    const stray = inner.indexOf(BACKTICK);
    if (stray !== -1) {
      const line = src.slice(0, open + 1 + stray).split("\n").length;
      assert.fail(
        `${name}.ts line ${line}: a backtick inside the ${decl} template ends it early. ` +
        `Use plain words in these comments.`,
      );
    }
  }
});

test("the script templates substitute every placeholder they contain", () => {
  // A ${...} that survives into the browser is a syntax error in an inline
  // script, which kills every line after it with no console anyone reads.
  for (const { name, decl } of SCRIPTS) {
    const src = readFileSync(new URL(`../src/web/${name}.ts`, import.meta.url), "utf8");
    const marker = `export const ${decl} = ${BACKTICK}`;
    const open = src.indexOf(marker) + marker.length - 1;
    const inner = src.slice(open + 1, src.lastIndexOf(BACKTICK));
    // Anything of the form ${"..."} is an escape hatch that renders literally.
    const literal = /\$\{\s*"/.exec(inner);
    assert.equal(literal, null,
      `${name}.ts has a quoted placeholder that renders as text rather than substituting`);
  }
});

// ---------------------------------------------------------------------------
// Configuration that has to agree with itself
// ---------------------------------------------------------------------------

test("a half configured Turnstile refuses launches instead of blaming the visitor", () => {
  /*
   * The deployment carried TURNSTILE_SECRET and not TURNSTILE_SITE_KEY, because
   * blink.env.example listed only the secret. The consequences all pointed the
   * wrong way:
   *
   *   no site key  -> no widget on the page
   *   no widget    -> the client decides verification is not required, gates no
   *                   button, and sends every launch with no token
   *   secret set   -> the server verifies, and refuses every one of them
   *
   * So the page said "Bot verification is disabled" while enforcing it, and the
   * refusal read "Could not verify you are a person", which blames a visitor for
   * a variable nobody set. Two sources for one fact is the defect: the server
   * answered from the secret, the browser answered from the rendered DOM.
   */
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");

  assert.match(src, /TURNSTILE_HALF_CONFIGURED/,
    "the disagreement has to be a named state, not something each side infers");
  assert.match(src, /\(TURNSTILE_SECRET === ""\) !== \(TURNSTILE_SITE_KEY === ""\)/,
    "exactly one of the pair being set is the condition");
  assert.match(src, /TURNSTILE_OFF_REASON/,
    "and it has to reach the catalog, so the buttons go off rather than failing");

  // The example file is where this started: it is what a deployment is copied
  // from, so a variable missing there is a variable missing in production.
  const example = readFileSync(new URL("../deploy/blink.env.example", import.meta.url), "utf8");
  for (const v of ["SOLARI_API_KEY", "DATABASE_URL", "TURNSTILE_SECRET", "TURNSTILE_SITE_KEY"]) {
    assert.match(example, new RegExp(`^${v}=`, "m"), `${v} is missing from blink.env.example`);
  }
});
