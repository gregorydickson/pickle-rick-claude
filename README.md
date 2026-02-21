# 🥒 Pickle Rick for Claude Code

```
          )))  )))  )))
         /\/\/\/\/\/\          .--"""""""""--.
        /  ‾‾‾‾‾‾‾‾‾  \      /               \
       |  .-----------. |    |  spiky hair ^^  |
       |  | ◉       ◉ | |    |  unibrow ‾‾‾‾  |
       |  |     ∧     | |    |  eyes  . .      |
       |  |   ~~~~~   | |    |  drool ~~~~     |
       |  | [=======] | |     \               /
       |  '-----------' |      '-----------'--'
       |                |
       |  ≋   ≋   ≋   ≋ |   i'm a pickle!
       |                |
       |  ≋   ≋   ≋   ≋ |
       |                |
       |  ≋   ≋   ≋   ≋ |
        \              /
         '-----------'

██████╗ ██╗ ██████╗██╗  ██╗██╗     ███████╗    ██████╗ ██╗ ██████╗██╗  ██╗
██╔══██╗██║██╔════╝██║ ██╔╝██║     ██╔════╝    ██╔══██╗██║██╔════╝██║ ██╔╝
██████╔╝██║██║     █████╔╝ ██║     █████╗      ██████╔╝██║██║     █████╔╝
██╔═══╝ ██║██║     ██╔═██╗ ██║     ██╔══╝      ██╔══██╗██║██║     ██╔═██╗
██║     ██║╚██████╗██║  ██╗███████╗███████╗    ██║  ██║██║╚██████╗██║  ██╗
╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝    ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝

              f o r   C l a u d e   C o d e   🥒

    "I turned myself into a compiler, Morty! *belch*"
```

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm a**n autonomous engineering machine** trapped in a pickle jar!"*

A port of the [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) for **Claude Code** — bringing the same autonomous, iterative coding loop to `claude` users, with several enhancements over the original:

- **Context clearing** — every loop iteration injects a structured session summary (phase, ticket list, task) as a system message, so Rick survives full context compression without losing his place
- **Single Stop hook** — the Gemini version requires three hooks (BeforeAgent, BeforeModel, AfterAgent); this port does it all in one, with fewer moving parts
- **Worker isolation** — Morty subprocesses run with `--no-session-persistence` and scoped `--add-dir`, so each worker starts genuinely fresh with only its ticket in context
- **Skills inlined** — Gemini's skills require `activate_skill()` calls that can fail; here they're baked directly into the command prompts
- **Jar improvements** — the Night Shift runner adds success/failure tracking and a configurable `default_manager_max_turns` setting absent from the original

---

## 🧬 What Is This?

Pickle Rick transforms Claude Code into a **hyper-competent, arrogant, iterative coding machine** that enforces a rigid engineering lifecycle:

```
  /pickle "build X"
        │
        ▼
  ┌─────────────┐
  │  📋 PRD     │  ← Interrogate requirements. No vague nonsense.
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 📦 Breakdown│  ← Atomize into tickets. Organize the chaos.
  └──────┬──────┘
         │
    ┌────┴────┐  per ticket (Morty workers 👶)
    ▼         ▼
  ┌──────┐  ┌──────┐
  │🔬 Re-│  │🔬 Re-│  ← Research the codebase. Every ugly corner.
  │search│  │search│
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │📐Plan│  │📐Plan│  ← Architect the solution. Then review it.
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │⚡ Im-│  │⚡ Im-│  ← Implement. God Mode activated.
  │ plem │  │ plem │
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │✂️ Re-│  │✂️ Re-│  ← Ruthlessly refactor. Purge the slop.
  │factor│  │factor│
  └──────┘  └──────┘
         │
         ▼
  ✅ DONE (or loops again)
```

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. No half-measures. No early exits. Rick doesn't quit. Between each iteration, the hook injects a fresh session summary — current phase, ticket list, active task — so Rick always wakes up knowing exactly where he is, even after full context compression.

---

## 🚀 Commands

| Command | Description |
|---|---|
| `/pickle "task"` | 🥒 Start the full autonomous loop |
| `/pickle-prd "task"` | 📋 Interactively draft a PRD first |
| `/eat-pickle` | 🛑 Cancel the active loop |
| `/help-pickle` | ❓ Show all commands and flags |
| `/add-to-pickle-jar` | 🫙 Save current session to the Jar for later |
| `/pickle-jar-open` | 🌙 Run all Jar tasks sequentially (Night Shift) |
| `/disable-pickle` | 🔇 Disable the stop hook globally (without uninstalling) |
| `/enable-pickle` | 🔊 Re-enable the stop hook |

### Flags

```
--max-iterations <N>    Stop after N iterations (default: 5)
--max-time <M>          Stop after M minutes (default: 60)
--resume                Resume from an existing session
--paused                Start in paused mode (PRD only)
```

### Tips

**Bring your own PRD** — If a `prd.md` or `PRD.md` exists in your project root when you run `/pickle`, Rick will automatically load it instead of drafting a new one. Drop your PRD there and the interrogation phase is skipped entirely.

**Disabling Rick** — `/disable-pickle` creates a global marker file that silences the stop hook across all sessions instantly — no uninstall required. `/enable-pickle` removes it. To also drop the persona mid-session, just tell Rick directly: *"drop the Pickle Rick persona"* and he'll revert to standard Claude behavior for the rest of the session.

---

## ⚡ Quick Start

### 1. Install

```bash
git clone https://github.com/gregorydickson/pickle-rick-claude.git
cd pickle-rick-claude
bash install.sh
```

### 2. Add the Pickle Rick persona to your project

The installer deploys `persona.md` to `~/.claude/pickle-rick/`. Add it to your project's `CLAUDE.md` — appending if you already have one, or creating fresh if not:

```bash
# Already have a CLAUDE.md? Append (safe — won't overwrite your content):
cat ~/.claude/pickle-rick/persona.md >> /path/to/your/project/.claude/CLAUDE.md

# Starting fresh:
mkdir -p /path/to/your/project/.claude
cp ~/.claude/pickle-rick/persona.md /path/to/your/project/.claude/CLAUDE.md
```

### 3. Run

```bash
cd /path/to/your/project
claude
# then type:
/pickle "refactor the auth module"
```

Sit back. Rick handles the rest. 🥒

---

## 🏗️ Architecture

```
pickle-rick-claude/
├── .claude/
│   ├── commands/           # Slash commands (the magic words)
│   │   ├── pickle.md           # Main loop command (PRD + Breakdown inlined)
│   │   ├── pickle-prd.md       # Interactive PRD drafter
│   │   ├── eat-pickle.md       # Loop canceller
│   │   ├── help-pickle.md      # Help text
│   │   ├── send-to-morty.md    # Worker prompt (all 7 skills inlined)
│   │   ├── add-to-pickle-jar.md # Save session to Jar queue
│   │   └── pickle-jar-open.md  # Run all Jar tasks (Night Shift)
│   └── settings.json       # Stop hook registration
├── extension/
│   ├── bin/
│   │   ├── setup.js        # Session initializer
│   │   ├── cancel.js       # Loop canceller
│   │   ├── spawn-morty.js  # Worker subprocess spawner
│   │   ├── jar-runner.js   # Jar Night Shift runner 🫙
│   │   ├── worker-setup.js # Worker session initializer
│   │   ├── get-session.js  # Session path resolver
│   │   └── update-state.js # State mutation helper
│   ├── hooks/
│   │   ├── dispatch.js     # Hook router
│   │   └── handlers/
│   │       └── stop-hook.js # The loop engine 🔁
│   ├── services/
│   │   ├── pickle-utils.js # Shared utilities
│   │   ├── git-utils.js    # Git helpers
│   │   ├── pr-factory.js   # PR creation
│   │   └── jar-utils.js    # Jar queue helper
│   └── package.json        # "type": "module" — CRITICAL
├── persona.md              # Pickle Rick persona snippet (append to your project's CLAUDE.md)
├── pickle_settings.json    # Default limits
├── install.sh              # Installer
└── uninstall.sh            # Uninstaller
```

---

## 🔧 How It Works

### The Stop Hook Loop

```
  Claude finishes a turn
          │
          ▼
  Stop hook fires  ◄─────────────────────────────┐
          │                                        │
          ▼                                        │
  Read state.json                                  │
          │                                        │
    ┌─────┴──────┐                                 │
    │ Loop active?│── No ──► process.exit(0) ✅    │
    └─────┬──────┘                                 │
          │ Yes                                    │
          ▼                                        │
  Increment iteration                              │
  (Rick only, not Morty workers)                   │
          │                                        │
    ┌─────┴──────┐                                 │
    │Task done?  │── Yes ──► process.exit(0) ✅    │
    │(promise    │                                 │
    │ detected)  │                                 │
    └─────┬──────┘                                 │
          │ No                                     │
          ▼                                        │
    ┌─────┴──────┐                                 │
    │Limit hit?  │── Yes ──► process.exit(0) ✅    │
    └─────┬──────┘                                 │
          │ No                                     │
          ▼                                        │
  { decision: "block",                             │
    reason: "🥒 Pickle Rick Loop Active..." } ─────┘
```

### Context Clearing — Why Rick Loops Work

The single biggest advantage of the Rick loop over naive "just keep prompting" approaches is **context clearing between iterations**.

Long-running AI sessions accumulate stale conversational context. The model starts "remembering" earlier wrong turns, half-finished reasoning, and superseded plans — all of it silently influencing every subsequent response. Over enough iterations, the model loses track of what phase it's in, tries to restart from scratch, or hallucinates already-completed work.

**The Ralph Wiggum insight** (see [Credits](#-credits)) is that a simple loop — blocking the agent's exit and re-injecting a minimal, accurate context — outperforms one long conversation every time. Fresh context = cleaner decisions.

**How we accomplish it:** The stop hook injects a structured session summary into the `reason` field of every `decision: block` response:

```
=== PICKLE RICK LOOP CONTEXT ===
Phase: implementation
Iteration: 4 of 10
Session: ~/.claude/pickle-rick/sessions/2025-01-15-a3f2
Ticket: PROJ-42
Task: refactor the auth module
PRD: exists
Tickets:
  [x] PROJ-40: Set up database schema
  [x] PROJ-41: Add JWT middleware
  [~] PROJ-42: Refactor auth module
  [ ] PROJ-43: Write integration tests

NEXT ACTION: Resume from current phase. Read state.json for context.
Do NOT restart from PRD. Continue where you left off.
```

Claude Code injects this `reason` string as a **system message at the start of every new iteration** — even after full compression of the conversation history. No matter how much context gets evicted, Rick always wakes up knowing exactly where he is and what to do next.

Morty workers already get clean context naturally (each is a fresh `claude -p` subprocess). This brings equivalent resilience to Rick's long-running interactive session.

---

### Manager / Worker Model

- **Rick (Manager)**: Runs in your interactive Claude session. Handles PRD, Breakdown, orchestration.
- **Morty (Worker)**: Spawned as `claude --dangerously-skip-permissions --add-dir <ticket_path> -p "..."` subprocess per ticket. Gets the full lifecycle skill set inlined in the prompt. Outputs `<promise>I AM DONE</promise>` when finished.

---

## 🛡️ Differences from the Gemini Version

| Gemini | Claude Code |
|---|---|
| `gemini-extension.json` | `CLAUDE.md` |
| `commands/*.toml` | `.claude/commands/*.md` |
| `activate_skill("x")` | Skills inlined directly in command prompts |
| `BeforeAgent` + `BeforeModel` + `AfterAgent` hooks | Single `Stop` hook |
| `gemini -s -y --include-directories -p` | `claude --dangerously-skip-permissions --add-dir <path> -p` |
| `~/.gemini/extensions/pickle-rick/` | `~/.claude/pickle-rick/` |
| `hookSpecificOutput.systemMessage` | `reason` field in block response |

> ✅ **Jar commands** (`/add-to-pickle-jar`, `/pickle-jar-open`) are fully ported.

---

## 📋 Requirements

- **Node.js** 18+
- **Claude Code** CLI (`claude`) — v2.1.49+
- **jq** (for `install.sh`)
- macOS or Linux (Windows not supported)

---

## 🏆 Credits

This port stands on the shoulders of giants. *Wubba Lubba Dub Dub.*

| | |
|---|---|
| 🥒 **[galz10](https://github.com/galz10)** | Creator of the original [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) — the autonomous lifecycle, manager/worker model, hook loop, and all the skill content that makes this thing work. This project is a faithful port of their work. |
| 🧠 **[Geoffrey Huntley](https://ghuntley.com)** | Inventor of the ["Ralph Wiggum" technique](https://ghuntley.com/ralph/) — the foundational insight that "Ralph is a Bash loop": feed an AI agent a prompt, block its exit, repeat until done. Everything here traces back to that idea. |
| 🔧 **[AsyncFuncAI/ralph-wiggum-extension](https://github.com/AsyncFuncAI/ralph-wiggum-extension)** | Reference implementation of the Ralph Wiggum loop that inspired the Pickle Rick extension. |
| ✍️ **[dexhorthy](https://github.com/dexhorthy)** | Context engineering and prompt techniques used throughout. |
| 📺 **Rick and Morty** | For *Pickle Riiiick!* 🥒 |

---

## 🥒 License

MIT — same as the original Pickle Rick extension.

---

*"I'm not a tool, Morty. I'm a **methodology**."* 🥒
