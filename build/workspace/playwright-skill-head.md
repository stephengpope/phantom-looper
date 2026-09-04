---
name: playwright-cli
description: Drive this machine's pre-installed headless browser (playwright-cli + Chromium) from bash — open pages, click, fill, screenshot, read console output. Use it to verify any web UI you build or change. Never install playwright or download a browser; both are already here.
---

# Browser automation — pre-installed on this machine

`playwright-cli` and its Chromium are baked into this machine: every command
below works as-is from bash — no setup, no package.json, no npx, no download.
The `playwright` library CLI (e.g. `playwright screenshot <url> <file>`) is
installed too. Two rules:

- Every file the CLI writes (screenshots, `--filename=`, traces) lands in
  your scratch pad, `/workspace/scratch/` — outside the repo, so commits
  never pick them up; read results back from `/workspace/scratch/<name>`
  (its own working files go to `/workspace/scratch/.playwright-cli/`). The
  flip side: a file you pass IN (`upload`, `drop --path=`, `run-code
  --filename=`, `state-load`) must be an ABSOLUTE path (e.g.
  `/workspace/repo/...`), because relative paths resolve there too.
- The browser stays open between commands and turns; run `playwright-cli
  close` when you are done with it.
