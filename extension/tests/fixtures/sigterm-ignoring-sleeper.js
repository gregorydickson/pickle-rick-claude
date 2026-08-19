// R-CXHANG test fixture: simulates a network-blocked codex worker that ignores
// SIGTERM. Only SIGKILL, or its own bounded lifetime below, can collect it.
// Signals readiness (handler installed) by writing CXHANG_READY_FILE, so tests
// never race their SIGTERM against node bootstrap's default handler.
import * as fs from 'node:fs';

process.on('SIGTERM', () => { /* ignore — simulate blocked network I/O */ });
setInterval(() => { /* keep-alive */ }, 1000);

if (process.env.CXHANG_READY_FILE) {
  try { fs.writeFileSync(process.env.CXHANG_READY_FILE, String(process.pid)); } catch { /* best-effort */ }
}

if (process.env.PICKLE_FIXTURE_PID_REGISTRY) {
  try { fs.appendFileSync(process.env.PICKLE_FIXTURE_PID_REGISTRY, `${process.pid}\n`); } catch { /* best-effort */ }
}

// Self-exit independent of SIGTERM: bounds an abandoned instance's lifetime
// even though the SIGTERM handler above is a permanent no-op.
const DEFAULT_MAX_LIFETIME_MS = 120_000;
const parsedLifetimeMs = Number(process.env.PICKLE_FIXTURE_MAX_LIFETIME_MS);
const maxLifetimeMs = Number.isFinite(parsedLifetimeMs) && parsedLifetimeMs > 0
  ? parsedLifetimeMs
  : DEFAULT_MAX_LIFETIME_MS;
setTimeout(() => process.exit(0), maxLifetimeMs);
