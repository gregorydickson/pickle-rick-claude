import * as path from 'node:path';
import { runCitadelStandalone } from '../services/citadel/audit-runner.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let workingDir = process.cwd();
  let diffRange = 'HEAD~1..HEAD';
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--working-dir' && args[i + 1] !== undefined) {
      workingDir = args[++i];
    } else if (args[i] === '--diff-range' && args[i + 1] !== undefined) {
      diffRange = args[++i];
    } else if (args[i] === '--output-dir' && args[i + 1] !== undefined) {
      outputDir = args[++i];
    }
  }

  const result = await runCitadelStandalone({ workingDir, diffRange }, outputDir);
  process.exitCode = result.exit_code;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'citadel-standalone.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`citadel-standalone: ${msg}\n`);
    process.exit(1);
  });
}
