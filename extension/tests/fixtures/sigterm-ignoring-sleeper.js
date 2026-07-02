// R-CXHANG test fixture: simulates a network-blocked codex worker that ignores
// SIGTERM and never self-exits. Only SIGKILL can collect it.
// Signals readiness (handler installed) by writing CXHANG_READY_FILE, so tests
// never race their SIGTERM against node bootstrap's default handler.
import * as fs from 'node:fs';

process.on('SIGTERM', () => { /* ignore — simulate blocked network I/O */ });
setInterval(() => { /* keep-alive */ }, 1000);

if (process.env.CXHANG_READY_FILE) {
  try { fs.writeFileSync(process.env.CXHANG_READY_FILE, String(process.pid)); } catch { /* best-effort */ }
}
