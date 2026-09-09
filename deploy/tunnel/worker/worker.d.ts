/**
 * Types for the Worker's testable exports.
 *
 * worker.js is plain JavaScript because it is deployed by wrangler and never
 * compiled here, but the test suite imports classifyOrigin from it and tsc has
 * to be told what that is. Kept to exactly the surface the tests use.
 */
export function classifyOrigin(input: {
  threw: boolean;
  status: number | null;
  elapsedMs: number;
  timeoutMs: number;
}): string | null;
