/**
 * Makes a binary unresolvable on a PATH **without removing any directory from it**.
 *
 * The idiom this replaces filtered the resolving directory out of PATH entirely. On macOS that is
 * free (`rg` and `bun` live alone in /opt/homebrew/bin), but on Linux `rg` is in /usr/bin — and
 * /bin is a symlink to it, so the filter stripped BOTH and took `bash`, `env` and `git` with them.
 * The audit under test could then not even be spawned, so the test measured a missing shell instead
 * of the audit's verdict (beta.22 CI, B-CIGREEN2 A1).
 *
 * Substitute, never delete: each PATH entry that actually resolves `bin` is replaced IN PLACE by a
 * mirror directory holding symlinks to everything the original held EXCEPT `bin`. Position and
 * precedence are preserved, every other tool still resolves, and the target genuinely does not.
 *
 * Note this cannot be done by merely PREPENDING a shim: bash and the product's own resolver both
 * skip a non-executable candidate (a plain file, a directory, a broken symlink) and keep scanning,
 * so a shim can only ever make a binary resolvable, never absent.
 *
 * Membership is read off the filesystem, so there is no list to maintain — no exempt-directory
 * enumeration to go stale one distro layout later.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkFixtureTmpDir } from './fixture-tmpdir.js';

/**
 * Deliberately mirrors resolvesOnPath (src/services/verify-command-safety.ts) so the simulation and
 * the product agree on what "resolvable" means: a regular file carrying an executable bit. Anything
 * else — missing, a directory, non-executable — is not a resolution, and the search continues.
 */
function resolvesIn(dir, bin) {
  if (!dir) return false;
  try {
    const stat = fs.statSync(path.join(dir, bin));
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    // intentional no-op: ENOENT / permission error means the binary is absent from this dir
    return false;
  }
}

/** A throwaway stand-in for `dir` holding everything in it except `bin`. */
function mirrorWithout(dir, bin) {
  const mirror = mkFixtureTmpDir('pickle-path-shadow-');
  for (const entry of fs.readdirSync(dir)) {
    if (entry === bin) continue;
    try {
      fs.symlinkSync(path.join(dir, entry), path.join(mirror, entry));
    } catch {
      // best-effort: an entry that cannot be linked (racing removal, exotic name) is one the
      // original PATH search would also have failed to use
    }
  }
  return mirror;
}

/**
 * Returns `pathEnv` with `bin` made unresolvable and every other binary left resolvable.
 * Throws if the simulation did not take — a simulation that silently failed would let the caller
 * assert against a PATH where the tool is still present, measuring nothing.
 */
export function simulateBinaryAbsent(pathEnv, bin) {
  const shadowed = pathEnv
    .split(path.delimiter)
    .map((dir) => (resolvesIn(dir, bin) ? mirrorWithout(dir, bin) : dir))
    .join(path.delimiter);

  const leaked = shadowed.split(path.delimiter).find((dir) => resolvesIn(dir, bin));
  if (leaked) {
    throw new Error(
      `simulateBinaryAbsent: '${bin}' still resolves in ${leaked} after shadowing — the simulated PATH measures nothing`,
    );
  }
  return shadowed;
}
