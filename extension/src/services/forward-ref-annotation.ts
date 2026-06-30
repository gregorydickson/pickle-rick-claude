import * as fs from 'node:fs';
import * as path from 'node:path';
import { logActivity } from './activity-logger.js';

// WS3 (#120 R-ATPR) gate-parity: the SINGLE extension-relative directory resolver shared by
// both `check-readiness.ts:resolvePathRef` and `audit-ticket-bundle.ts:loadDispositions`.
// Walks UP from `startDir` (≤6 hops) to the `extension/` package root: returns `dir` when it
// IS the extension package (basename `extension` + a `package.json`), else the `extension/`
// child of `dir` when that child holds a `package.json`, else ascends to the parent; stops at
// the filesystem root. Returns null when no `extension/` package root is found. This is the
// lone home for the `fs.existsSync(path.join(dir, 'extension', 'package.json'))`-style walk —
// neither consumer may re-inline it (enforced by gate-parity-shared-resolver.test.js).
export function resolveExtensionDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'extension' && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'extension', 'package.json'))) {
      return path.join(dir, 'extension');
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return null;
}

// WS3 (#120 R-ATPR) gate-parity: the SINGLE resolution outcome both gates consume for an
// extension-relative path reference. True iff `ref` is an existing absolute path, OR resolves
// against `repoRoot`, OR resolves against the shared `extension/` package dir under `repoRoot`.
// A genuine phantom (no such file under any base) returns false so the teeth are preserved.
export function resolveExtensionRelativePath(ref: string, repoRoot: string): boolean {
  if (path.isAbsolute(ref) && fs.existsSync(ref)) { return true; }
  if (fs.existsSync(path.resolve(repoRoot, ref))) { return true; }
  const sharedDir = resolveExtensionDir(repoRoot);
  const legacyDir = path.join(repoRoot, 'extension');
  const extDir = sharedDir ?? legacyDir;
  const result = fs.existsSync(path.resolve(extDir, ref));
  // WS4 (b7cc6081): the shared resolver and the legacy per-gate fallback would
  // resolve `ref` against DIFFERENT extension dirs — i.e. the two gates
  // (check-readiness, audit-ticket-bundle) WOULD have disagreed before WS3
  // collapsed them onto `resolveExtensionDir`. Surface that as
  // `gate_parity_divergence` (refused-and-recovered, informational). Emit only
  // when the dirs actually differ AND that difference flips the resolution
  // outcome — the genuine "would have disagreed" condition. Best-effort: the
  // resolver runs inside CLI gates that may have no activity dir, so never throw.
  if (sharedDir !== null && path.resolve(sharedDir) !== path.resolve(legacyDir)) {
    const legacyResult = fs.existsSync(path.resolve(legacyDir, ref));
    if (legacyResult !== result) {
      try {
        logActivity({
          event: 'gate_parity_divergence',
          source: 'pickle',
          ts: new Date().toISOString(),
          gate_payload: { gate_a: sharedDir, gate_b: legacyDir, ref },
        });
      } catch {
        // best-effort observability — never block path resolution
      }
    }
  }
  return result;
}
