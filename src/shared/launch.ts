import type { LaunchOptions } from "playwright";

/**
 * Browser launch options shared by discovery, capture, probe and login. Headless by
 * default; `--headed` shows the windows, for watching a login recipe or a state
 * probe go wrong. Process-wide on purpose: it is a way of looking at a run, not
 * part of what the run produces, so it doesn't belong in the config.
 */
let headed = false;

export function setHeaded(on: boolean): void {
  headed = on;
}

export function launchOptions(): LaunchOptions {
  return headed ? { headless: false } : {};
}
