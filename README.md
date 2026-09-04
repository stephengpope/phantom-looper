# phantom-looper

A coding agent that plans, builds and ships from a kanban board, with a voice assistant that runs it.

For developers who want to hand work to coding agents and get merged code back, without babysitting a terminal or a git repo.

[**Install ↓** · macOS · Linux](https://bit.ly/4qR8smm)

[Why](#why-phantom-looper) · [Install](#install) · [Command line](#command-line) · [Develop](#develop)

---

Want to learn to build apps like this, or optimize this one? Join the **[AI Architects](https://skool.com/ai-architects)**.

---

## Why phantom-looper

### 🔁 Built-in looper — Drop a card on the board. It gets planned, built and reviewed.

Put a card in the **plan** column and the loop takes it from there: a coding agent writes the plan, a supervisor agent reviews it, the coding agent builds it, and the supervisor checks the work against the real repo and ticks off each requirement it verified. The card lands in **done** for you to look at. Nothing fails silently: if a round breaks, the card moves to **blocked** with the reason written on it.

### 🎙 Voice assistant — Run the whole app by talking to it.

Open sessions, add cards, move them, tick requirements, switch auto plan and auto build on and off, and create a new repo and workspace, all by voice. The assistant works the same board and sessions you do, so you can manage a day's work without touching the keyboard.

### 🛰 Any device — Start on one machine, continue on another.

Every session lives on your server, conversation and all. Open the app anywhere, pick the session up, and carry on where it left off. Close the laptop and the looper keeps building.

### 🔒 Docker sandbox — Every tool call runs in its own container.

Each session gets its own container on its own clone of the repo. The agent can't reach your machine, and your GitHub token never enters the container: credential-bearing git runs on the server side, behind a guard set. Every session boots from the same image, so the agent's environment is the same one every time.

### 🔀 Git handled for you — Branching, conflicts and pushing, done.

Every session works on its own branch. When you archive a finished card the work is committed with a written message, merged with the latest main, pushed, and fast-forwarded onto main. If the merge conflicts, an AI fixer resolves it inside the container and verifies the result before anything is pushed. No rebase, no force push, no git commands from you.

### ⚖️ A shared value system — Every agent builds and reviews by the same six rules.

The coding agent, the supervisor and the assistant all carry one value system: understand before you act, it has been built before, simplicity is the wall, proof over belief, exactly what was asked, respect the customer experience. The agent that writes the code and the agent that judges it agree on what good looks like, so the loop holds a line a single agent never would: no hacks, no scope creep, no invented solution where a proven one exists, and no added complexity without its cost named first.

---

## Install

### 1. Install the app

macOS or Linux:

```bash
curl -fsSL https://bit.ly/4qR8smm | sh
```

### 2. Connect a server

`phantom-cli` is the app; `phantom-backend` is its server. Every session, board and setting lives on the server, so the app does nothing until it has one. Pick the path that fits you:

**No server yet — create one**

```bash
phantom-cli setup-backend   # install a server over SSH and connect this machine to it
phantom-cli                 # then open the app
```

The wizard asks two questions: a fresh Ubuntu/Debian box you can SSH into (`root@203.0.113.7` — any cheap VPS) and one model key. It installs Docker and the server, saves the address and key on this machine, stores the model key on the server, and ends with `run phantom-cli`.

**Already have one — reconnect**

```bash
phantom-cli                 # open the app, then type /server
```

On `/server`, paste the URL and API key. Both come from the box: `phantom-backend key` prints the key; the URL is `https://` plus the address the installer printed. Scripting it? The two environment variables under [Command line](#command-line) do the same.

### 3. First run

Either way you are now in the app. It asks for a GitHub repo — that is your first workspace, and every session runs on a clone of it. Credentials live on `/keys`, everything else on `/settings`.

### 4. Configure

#### Bare bones

The two credentials that turn a card into merged code, both on `/keys`:

| key | why |
|---|---|
| one model key — `anthropic key`, `openai key`, `google key` or `openai-compatible key` | the agents think with it. `anthropic key` also takes a Claude subscription token. The wizard already saved one if you gave it one. |
| `github token` | clones, pushes and lands work on the base branch. A classic token with `repo` scope is the simplest. Skip it and the app can read public repos but never push. |

Everything else has a working default.

#### Ideal setup

The full product: voice, web, and the looper on autopilot. Row names are the ones on screen.

| add | where | you get |
|---|---|---|
| `deepgram key` | `/keys` | the Assistant's ears and mouth |
| `assistant` on | `/voice` | the voice pane opens with the app; run the board and your sessions by talking |
| `assistant model` | `/voice` | a small fast model, so spoken replies come back quick |
| `firecrawl key` | `/keys` | the agents can search and read the web |
| `auto plan` + `auto build` on | `/settings` | cards in plan and in progress drive themselves |
| `auto-push on archive` on | `/settings` | archiving a done card merges and pushes it |
| `loop token budget` | `/settings` | a spend cap per card run |
| `boot into last workspace` on | `/settings` | skip the picker, start where you left off |

---

## Command line

| Command | What it does |
|---|---|
| `phantom-cli` | open the app |
| `phantom-cli --resume <id>` | open straight into a session (`-r` for short) |
| `phantom-cli setup-backend` | install a new server over SSH and pair this machine |
| `phantom-cli update` | update the app |
| `phantom-cli update --server` | update the server |
| `phantom-cli --version` | print the version (`-v` for short) |

Environment variables, if you need them:

| Variable | Overrides |
|---|---|
| `PHANTOM_BACKEND_URL` | the server URL |
| `PHANTOM_BACKEND_KEY` | the server API key |

---

## Develop

```bash
./scripts/setup.sh     # first boot: .env + secrets, local workspace image, compose up
npm run phantom-cli    # the app from source; `-- --resume <id>` to reopen a session
```

```bash
npm test                    # pure + real-git units, ~1s, no Docker
npm run test:all            # everything incl. containers + Postgres + the looper
npm run test:phantom-cli    # the Ink app, headless
npm run typecheck
```
