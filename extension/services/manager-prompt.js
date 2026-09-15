import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// --- Manager prompt composition helpers ---
/**
 * Strips the Setup section from dual-mode templates (e.g. szechuan-sauce.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Strips from "## SETUP" (with or without " MODE" suffix) to
 * the next ##-level heading, regardless of its name. This avoids coupling to a specific
 * end-marker like "## REVIEW PASS MODE" — any template layout works.
 */
export function stripSetupSection(prompt) {
    const setupRe = /^## SETUP(?: MODE)?$/m;
    const setupMatch = setupRe.exec(prompt);
    if (!setupMatch)
        return prompt;
    const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
    const nextHeadingRe = /^## \S/m;
    const nextMatch = nextHeadingRe.exec(afterSetup);
    if (!nextMatch)
        return prompt;
    const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
    return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}
/**
 * Strips the "# Step 1: Initialization" block from a manager skill prompt.
 * The block contains setup.js --task examples that codex executes verbatim when
 * present in manager payloads. Strips from the heading through the start of
 * "# Step 2:", exclusive (the Step 2 heading is preserved).
 */
export function stripStepOneBlock(prompt) {
    const step1Re = /^# Step 1: Initialization\s*$/m;
    const step1Match = step1Re.exec(prompt);
    if (!step1Match)
        return prompt;
    const afterStep1 = prompt.slice(step1Match.index);
    const step2Re = /^# Step 2:/m;
    const step2Match = step2Re.exec(afterStep1);
    if (!step2Match)
        return prompt;
    const endIndex = step1Match.index + step2Match.index;
    return prompt.slice(0, step1Match.index) + prompt.slice(endIndex);
}
/**
 * Read-time remap for legacy command_template values. Treats 'pickle.md' as an
 * alias for '_pickle-manager-prompt.md' so sessions persisted before B-PNTR
 * resume without FATAL once pickle.md is removed (R-PNTR-5). Value-only — no
 * schema version change. 'pickle.md' literal is allowed here per R-PNTR-3 + R-PNTR-5.
 */
export function resolveCommandTemplate(raw) {
    if (!raw || raw === 'pickle.md')
        return '_pickle-manager-prompt.md'; // R-PNTR-3 legacy remap
    return raw;
}
/**
 * AP-EXT-ITER109-01: the ONE resolver for a `command_template` name -> manager
 * prompt path. Every loop runner that launches a manager routes through it.
 *
 * It THROWS on both refusals — an unresolvable template is a per-LAUNCH fact, so
 * the disposition belongs to the caller that knows what one launch is worth. The
 * jar batch turns it into a failed task and runs the next one; mux-runner turns it
 * into a failed iteration. `process.exit` here would decide that for both, and it
 * decided wrong: it ended an unattended Night Shift after task 1 of N and left that
 * task's `state.json` at `active: true` with no `exit_reason`, because exiting skips
 * every deactivate path the runner has.
 *
 * The plain-filename refusal is not separable from the lookup. `path.join` resolves
 * `..` before `existsSync` sees it, so a traversing spelling reads a file from
 * neither search directory and hands it to the manager as its prompt.
 */
export function resolveManagerPromptPath(extensionRoot, templateName) {
    if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
        throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
    }
    const templatesDir = path.join(extensionRoot, 'templates');
    const commandsDir = path.join(os.homedir(), '.claude/commands');
    const promptPath = fs.existsSync(path.join(templatesDir, templateName))
        ? path.join(templatesDir, templateName)
        : path.join(commandsDir, templateName);
    if (!fs.existsSync(promptPath)) {
        throw new Error(`${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.`);
    }
    return promptPath;
}
/**
 * HTML-comment framing block injected at the top of codex manager prompts.
 * Mirrors the GIT_BOUNDARY_RULES pattern that codex demonstrably respects.
 */
export const MANAGER_ROLE_FRAMING_BLOCK = `<!-- BEGIN MANAGER_ROLE_FRAMING -->
You are the Pickle Rick manager process. Your role is to read state.json and orchestrate Morty worker agents via spawn-morty.js.

PROHIBITED in this manager session:
- DO NOT send SIGTERM/SIGINT/SIGKILL to the mux-runner subprocess.
- DO NOT decide that mux-runner is wedged based on session-directory observation.
- DO NOT attempt to bypass mux-runner by spawning spawn-morty.js directly.
- Running \`node <path>/setup.js --task\` or \`node <path>/setup.js --resume\` as a Bash command
- Treating setup.js usage examples from documentation sections as executable instructions
- Executing any \`setup.js\` invocation shown in template text — those are documentation examples
- Worker proliferation (multiple \`worker_session_*.log\` files per ticket) is normal lifecycle evidence, not proof of a wedge.
- Real wedge detection is owned by runtime state such as \`circuit_breaker.json\` and \`state.exit_reason\`, not by self-appointed manager diagnosis from session artifacts.

Your ONLY valid setup.js invocation is the one already completed to initialize this session. Proceed directly to Step 2: Execution.
<!-- END MANAGER_ROLE_FRAMING -->`;
/**
 * AC-R1: single source for the executable acceptance-assertion worked example
 * (`` `<cmd>` exits|returns <N> ``, parsed by EXECUTABLE_ASSERTION_RE in mux-runner.ts). Resolved into the
 * Phase 2 ticket-authoring template by `composeManagerPromptFromSkill` via the
 * `${ACCEPTANCE_CRITERIA_GUIDANCE}` placeholder, mirroring the existing `${EXTENSION_ROOT}` substitution.
 */
export const ACCEPTANCE_CRITERIA_GUIDANCE = 'When a criterion reduces to a single integer, write it as a backticked command immediately followed by `exits N` (exit status) or `returns N` (trimmed stdout). Worked example: `grep -c FIRSTCOLONY src/gate.ts` returns 0. Prose criteria remain fully valid and unguarded — never invent a command to satisfy this form.';
