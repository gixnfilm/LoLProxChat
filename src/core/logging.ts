// Console log toggling — silenced by default, re-enabled when the user
// turns on Debug in the overlay. When enabled, console output is ALSO
// forwarded to a file on disk via the Rust append_log command so that
// release builds (which have no dev-tools access) can still be inspected.
//
// console.error always passes through to the real console; it only
// writes to the file when Debug is on.

import { invoke } from '@tauri-apps/api/core';

const noop = (): void => { /* swallowed */ };

const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function formatArgs(args: any[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function writeToFile(level: string, args: any[]): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${formatArgs(args)}`;
  // Fire-and-forget — the file write is best-effort, never blocks the caller
  invoke('append_log', { line }).catch(() => { /* file may not be open yet */ });
}

function makeWrapper(orig: (...args: any[]) => void, level: string) {
  return (...args: any[]) => {
    orig(...args);
    writeToFile(level, args);
  };
}

// Initial state mirrors what console actually does (un-patched).
// We immediately silence at module-load below so anything imported
// after this module sees a silent console.
let enabled = true;

export function setLoggingEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  if (value) {
    console.log = makeWrapper(originals.log, 'log');
    console.warn = makeWrapper(originals.warn, 'warn');
    console.info = makeWrapper(originals.info, 'info');
    console.error = makeWrapper(originals.error, 'error');
    console.debug = makeWrapper(originals.debug, 'debug');
  } else {
    console.log = noop;
    console.warn = noop;
    console.info = noop;
    // console.error always passes through to the real console, just not to the file
    console.error = originals.error;
    console.debug = noop;
  }
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

// Silence at module load — anything that imports this gets a quiet console.
setLoggingEnabled(false);
