/**
 * Redacting writers. Nothing in this codebase writes to disk or to a stream
 * without passing through one of these.
 *
 * The point is that a NEW surface is covered by default. Adding a report, a log
 * line or a data file should not require anyone to remember that secrets exist.
 */

import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { redact } from "./redact.ts";

/** Write a file, redacted. The only file writer the harness uses. */
export function safeWriteFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redact(content));
}

/** Append to a file, redacted. */
export function safeAppendFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, redact(content), { flush: true });
}

/** Serialise and write JSON, redacted after serialisation so nested values are covered. */
export function safeWriteJsonSync(path: string, value: unknown): void {
  safeWriteFileSync(path, JSON.stringify(value, null, 2));
}

export function safeOut(s: string): void {
  process.stdout.write(redact(s));
}

export function safeErr(s: string): void {
  process.stderr.write(redact(s));
}
