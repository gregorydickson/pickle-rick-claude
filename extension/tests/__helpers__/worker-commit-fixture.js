// a4e48c26 deleted subject-line ticket-id inference from the completion-evidence scanner — a
// worker commit is now attributable ONLY via a `Pickle-Ticket` git trailer, so any fixture that
// hand-authors a subject-only commit models a shape production no longer emits. This helper
// stamps the trailer the way production does (git-trailer-hooks.ts's `prepare-commit-msg` hook /
// spawn-morty.ts's `reconcileWorkerCommitAttribution`), so fixtures stay representative.
import { execFileSync } from 'node:child_process';

export function commitWorkerFixture({ cwd, ticketId, message }) {
  execFileSync(
    'git',
    ['commit', '-q', '-m', message, '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
    { cwd, stdio: 'ignore' },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}
