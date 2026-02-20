# 🥒 Pickle Rick for Claude Code

```
    ____  _____ __ __ __    ______   ____  ____  ____  __ __
   |    \|     |  |  |  |  |      | |    ||    ||    ||  |  |
   |  o  )     |  |  |  |  |      |  |  |  |  |  |  | |  |  |
   |   _/|   __|  |  |  |__|_|  |__|  |  |  |  |  |  | |  |  |
   |  |  |  |  |  :  |  |  | |  |   |  |  |  |  |  | |  :  |
   |  |  |  |_ |     |  |  | |  |   |  |  |  |  |  |  \   /
   |__|  |_____|_,__|__|__| |__|  |____||____||____|  \_/

         ██████╗ ██╗ ██████╗██╗  ██╗██╗
         ██╔══██╗██║██╔════╝██║ ██╔╝██║
         ██████╔╝██║██║     █████╔╝ ██║
         ██╔═══╝ ██║██║     ██╔═██╗ ██║
         ██║     ██║╚██████╗██║  ██╗███████╗
         ╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝

         ██████╗ ██╗ ██████╗██╗  ██╗   🥒
         ██╔══██╗██║██╔════╝██║ ██╔╝
         ██████╔╝██║██║     █████╔╝
         ██╔══██╗██║██║     ██╔═██╗
         ██║  ██║██║╚██████╗██║  ██╗
         ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝

    "I turned myself into a compiler, Morty!"
```

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm a**n autonomous engineering machine** trapped in a pickle jar!"*

A port of the [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) for **Claude Code** — bringing the same autonomous, iterative coding loop to `claude` users.

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

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. No half-measures. No early exits. Rick doesn't quit.

---

## 🚀 Commands

| Command | Description |
|---|---|
| `/pickle "task"` | 🥒 Start the full autonomous loop |
| `/pickle-prd "task"` | 📋 Interactively draft a PRD first |
| `/eat-pickle` | 🛑 Cancel the active loop |
| `/help-pickle` | ❓ Show all commands and flags |

### Flags

```
--max-iterations <N>    Stop after N iterations (default: unlimited)
--max-time <M>          Stop after M minutes (default: unlimited)
--resume                Resume from an existing session
--paused                Start in paused mode (PRD only)
```

---

## ⚡ Quick Start

### 1. Install

```bash
git clone <this-repo>
cd pickle-rick-claude
bash install.sh
```

### 2. Copy CLAUDE.md to your project

```bash
cp ~/.claude/pickle-rick/CLAUDE.md /path/to/your/project/.claude/CLAUDE.md
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
│   │   ├── pickle.md       # Main loop command (PRD + Breakdown inlined)
│   │   ├── pickle-prd.md   # Interactive PRD drafter
│   │   ├── eat-pickle.md   # Loop canceller
│   │   ├── help-pickle.md  # Help text
│   │   └── send-to-morty.md # Worker prompt (all 7 skills inlined)
│   └── settings.json       # Stop hook registration
├── extension/
│   ├── bin/
│   │   ├── setup.js        # Session initializer
│   │   ├── cancel.js       # Loop canceller
│   │   ├── spawn-morty.js  # Worker subprocess spawner
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
│   │   └── pr-factory.js   # PR creation
│   └── package.json        # "type": "module" — CRITICAL
├── CLAUDE.md               # Pickle Rick persona (copy per project)
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

> ⚠️ **Jar commands** (`/add-to-pickle-jar`, `/pickle-jar-open`) are not available in this port — follow-up milestone.

---

## 📋 Requirements

- **Node.js** 18+
- **Claude Code** CLI (`claude`) — v2.1.49+
- **jq** (for `install.sh`)
- macOS or Linux (Windows not supported)

---

## 🥒 License

MIT — same as the original Pickle Rick extension.

---

*"I'm not a tool, Morty. I'm a **methodology**."* 🥒
