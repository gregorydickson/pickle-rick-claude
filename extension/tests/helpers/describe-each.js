import { describe } from 'node:test';
import { format } from 'node:util';

/**
 * Shared describe.each shim — node:test has no native describe.each. Every row
 * groups with describe(), never test(): a row callback that registers its own
 * test()/it() calls becomes a subtest of a synchronous parent when grouped with
 * test(), and Node 22 cancels subtests that outlive their parent's synchronous
 * return (R-TSPF / B-MEGADRAIN A1).
 */
export function describeEach(rows) {
  return function eachRunner(name, suite) {
    for (const row of rows) {
      const values = Array.isArray(row) ? row : [row];
      describe(format(name, ...values), () => suite(...values));
    }
  };
}
