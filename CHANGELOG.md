# Changelog

## 1.9.3 — 2026-11-07 (first public release on GitHub)
- One-click installer `NETRUNNER_Setup_<version>.exe` (Inno Setup, `tools/installer/netrunner-setup.iss`): the app,
  llama.cpp b12020 with the Visual C++ runtime, and ripgrep inside; during installation it downloads all 13 model
  files (~85 GB) — Qwen from Hugging Face at pinned revisions, FORGE models from this repository's `models-v1`
  release in parts under 2 GiB — checks each by SHA-256, and installs Git for Windows 2.56 for the current user when
  Git is missing. Downloads go through Windows' own curl.exe straight into `models\.download`: a connection slower
  than 1 MB/s for 30 s is dropped and resumed (`-C -`) on a new one — Inno Setup's built-in downloader stalled at
  1.5 MB/s on one CDN route in testing while the same file came at 37 MB/s on a fresh connection. Each model is put in
  place as soon as its SHA-256 checks out, so a cancelled or failed run loses nothing: the next run skips finished
  models and resumes the partial file. Uninstall removes the models.
- `tools/installer/models-manifest.mjs` hashes the models and checks that Hugging Face publishes the same SHA-256 and
  size for every file (13/13 match).
- The regular NSIS installer bundles the Visual C++ runtime DLLs (msvcp140, vcruntime140, vcruntime140_1); SETUP →
  INSTALL llama.cpp copies them next to llama-server, so the official llama.cpp build runs on a clean Windows.
- NETRUNNER finds Git installed in `%LOCALAPPDATA%\Programs\Git` or `Program Files\Git` even when it is not yet on
  the PATH it inherited (Git installed by the installer a moment before).
- README for GitHub: description, minimum and recommended system requirements, installation; MIT LICENSE.
- An offline variant (`tools/installer/netrunner-offline.iss`): everything including the models in one folder,
  setup .exe plus ~2 GB data parts.
- The accessibility check (`NETRUNNER_SMOKE_A11Y=1`) now also runs on a packaged test build (`npm run dist:test`):
  axe-core is bundled into the smoke code as its own chunk instead of being read from `node_modules`. Release
  builds contain neither the smoke code nor axe-core.

## 1.9.2 — 2026-11-07
- Qwen models are shown under their real name again (the "Gato" display name from 1.3.1 is gone: model labels,
  setup checklist, FORGE, memory, architecture field, VRAM actions). `electron/shared/brand.ts` removed.
- Navigation rail: a one-word caption under every icon (PROJECT, CODE, AGENTS, CHAT, MODELS, TERMINAL, MEMORY, GIT,
  SYSTEM, FORGE, NETWORK; Russian in the Russian interface); the rail is 68 px wide and scrolls in a short window.
  The full section name stays in the tooltip.

## 1.9.1 — 2026-11-06
- New icon: a ring with three ribbons woven into a sphere, turquoise → mint on the dark tile (theme colours
  #00e5ff / #19f5a5 / #07090b). 16–48 px use the mark alone, edge to edge; 64 px and up the mark on its tile.
  The mark also replaces the terminal glyph in the title bar. Built by `node tools/icon/build-icons.mjs`
  (`tools/icon/mark.mjs` draws it, `render.cjs` renders it with Electron).

## 1.9.0 — 2026-11-06 (NSC-ME: memory elasticity, docs/NSC-ME.md)
- MODEL VAULT → VRAM SAVER (MoE models, opt-in): all experts stay in RAM (`--cpu-moe`). Coder-Next then holds
  4.8 GB of VRAM instead of 10.2 GB at −8.9% decode / −6.5% prefill, and keeps full speed next to a program using
  3–6 GB of VRAM (without it Coder-Next drops to half speed). Applies on the next load.
- MODEL VAULT → IDLE MODELS: small models (≤ 6 GB) unload after 10 idle minutes; large ones never by default
  (5/10/30/60/120 min to choose); when free RAM is low, any model idle for 2 minutes. The agent model is kept while
  agents run; agent traffic counts as use. A loading large model shows the expected time from disk.
- Conversations survive an idle unload: slots with ≥ 1024 tokens are saved (`--slot-save-path`) and restored on the
  next load; the server finds them by itself. Measured on Coder-Next: 19 tokens read instead of 7564 after the return.
  Files are deleted after restore, kept at most 24 h and 16 GB.
- SYSTEM MONITOR: the VRAM warning names the measured cost (Coder-Next 2× slower) and offers VRAM SAVER for a MoE
  model or UNLOAD for a dense one.
- The MoE expert cache no longer pins weights (`-lm none` removed): with it Windows grew the pagefile to 13.4 GB and
  a return to the model took 101 s.

## 1.8.0 — 2026-11-02 (low-priority items 17–22)
- Component tests (happy-dom + Testing Library, fake IPC bridge): chat file blocks and SAVE/UNDO, tool steps, safe
  Markdown, NETWORK panels (rules, firewall, web tools; keys never shown back), agent approvals and ALWAYS grants.
- CI: `npm run test:ci` and a GitHub Actions workflow (Windows): typecheck, unit + component tests and the UI acceptance
  in CI mode (`NETRUNNER_SMOKE_CI=1`: no models, runtime or GPU — the app must say what is missing).
- NETWORK → NETRUNNER TRAFFIC: bytes NETRUNNER itself sent and received since start, by source (agent, terminal, web
  tools and their git/npm/pip, model and runtime downloads). CPU temperature: not shown (decided: no kernel driver).
- Accessibility: axe-core (WCAG 2.1 A + AA) over all 11 sections went from 180 violations to 0 — text contrast
  (dim #4d5862 → #7a8590, muted #7d8a94 → #98a3ad, editor line numbers and comments), labels for selects and
  checkboxes, editor tabs as buttons without nested controls. `NETRUNNER_SMOKE_A11Y=1` makes the acceptance fail on
  any new violation (on in CI).
- Install scripts of dependencies are approved explicitly and pinned (`allowScripts`: electron-winstaller, node-pty,
  opencode-ai — reviewed, local only), ready for npm versions that block unreviewed scripts; INSTALL.md describes
  building from source (Electron 42 fetches its binary on first run or with `npx install-electron --no`).
- `tools/move-project.ps1` moves the project out of OneDrive (copy, shortcut, Claude Code notes, NETRUNNER settings;
  the old folder is left for the operator to delete).
- minimatch advisory (GHSA-g3hv-75wg-m249): no fixed release in the 3.x/5.x/9.x/10.x lines electron-builder uses;
  build-time only (patterns come from our own config). Accepted until electron-builder moves to minimatch ≥ 11.0.1.

## 1.7.1 — 2026-11-02
- Web tools without internet: when a host does not resolve and neither do github.com, cloudflare.com and
  wikipedia.org, the tool answers NO_INTERNET ("do not retry") and remembers it for a minute; the chat then offers the
  model no more tools. Offline, an answer took 9–12 tool calls and 80–105 s; now one call and 12 s (4B) / 32 s (27B).

## 1.7.0 — 2026-11-02 (medium-priority items 8–16)
- NETWORK → FIREWALL: Windows Firewall rules per program. NETRUNNER's own programs (OpenCode, llama-server,
  ripgrep) are listed; the operator adds any other .exe and ticks what may not reach the internet (loopback and the
  LAN stay open). APPLY writes exactly those rules (confirmed, then UAC); only rules named "NETRUNNER - …" are ever
  touched; REMOVE ALL RULES undoes it. Nothing is applied by NETRUNNER on its own.
- NETWORK → RULES: host rules for everything NETRUNNER starts (agents, terminal, git/npm/pip of the web tools,
  web search and pages): an always-block list, and an allow-only list for ONLINE TOOLS. Loopback is never affected.
- Agents: ALWAYS now covers exactly the approved command or file (NETRUNNER keeps the grant and answers OpenCode
  "once"), not OpenCode's wildcard pattern ("npm *"); standing grants are listed with their use count and can be
  revoked; requests answered by a grant show in the feed.
- llama.cpp: CHECK FOR UPDATES in MODEL VAULT; installs take the newest b<NNNN> build with Windows binaries
  (GitHub's "latest" is now a stable v0.x release without them, which broke the SETUP install) and refuse any
  archive whose SHA-256 differs from the one GitHub publishes. ripgrep downloads are checked the same way.
- The release installer is built without the UI self-test (smoke) mode; `npm run dist:test` builds the test variant.
- MEMORY: search mode setting, embeddings by default. On 26 questions about this project embeddings alone ranked the
  right file first 23/26 (0.6B), 24/26 (4B), 23/26 (8B); hybrid 20–22/26; the 0.6B model stays (indexing 31 s vs
  106 s / 188 s).
- OpenCode stays on 1.19.5: it is still the newest stable release on npm.

## 1.6.0 — 2026-11-02
- WEB tools for NEURAL CORE (toggle WEB) and the agents (MCP server on loopback, replaces OpenCode's cloud
  websearch): `web_search`, `fetch_url` (page as text with links, long pages in parts), `repo_clone` (git clone into
  `%USERPROFILE%\NETRUNNER\repos`), `repo_list`, `repo_read`, `repo_install` (npm/pnpm/yarn, Python venv + pip,
  cargo, go) and `repo_run`. The model calls them through llama.cpp tool calling; each call shows in the answer.
- Search: DuckDuckGo by default (no key; refusals are reported, never worked around), optionally SearXNG, Brave
  Search API or Google Custom Search (keys stored encrypted with Windows DPAPI); DuckDuckGo is the fallback.
- NETWORK → WEB TOOLS: ASK / LIMITED (default: search and reading at once, clone/install/run confirmed) / FULL.
  Only in ONLINE TOOLS; every request is in the network log; local and private addresses are refused, also after
  DNS and on redirects; git/npm/pip go through the policy proxy.
- With WEB on, the first step of an answer must be a tool call (`tool_choice: required`): left free, Qwen 27B
  answered 2 of 6 live questions from memory and claimed sources it never opened. Tool results are shortened oldest
  first to stay inside the context window (a live run overflowed 16K with six GitHub API answers).

## 1.5.0 — 2026-11-02
- NEURAL CORE writes code to files: while a project is open the model marks whole-file code blocks with their path
  (` ```ts path=src/app.ts `), and the block shows the path, whether it was written, SAVE and UNDO.
- FILES mode in the chat toolbar (stored in settings, enforced in the main process): ASK — only on SAVE, confirmed
  each time; LIMITED (default) — new files are created when the answer ends, overwriting is confirmed; FULL —
  everything is written when the answer ends. Missing folders are created; paths stay inside the project, `.git` is
  off limits. Excerpts ("// ... existing code") are never written automatically and replacing a file with one is
  always confirmed. UNDO restores the previous content (a created file goes to the recycle bin), only while the
  file still holds what that answer wrote.

## 1.4.0 — 2026-11-02 (Phase 10: speed and quality of the local AI)
- Qwen3.8-27B: IQ3_XXS by default with 16K context, q8 KV cache and the vision projector on the CPU: 9.1 → 13.1 tok/s
  in the app. The MTP head is used only when the model is larger than the GPU (Q4_K_M: 3.5 → 8.7 tok/s).
- Coder-Next is prewarmed when the agent engine starts (45 GiB read in 6 s), so the first answer does not wait for
  the disk. While the agent model is loaded, chat is answered by it instead of swapping models (first token 0.5 s);
  the reply says which model answered.
- Agent pipelines pass verified facts between steps: the real git diff, the files each step touched and the command
  output, instead of the previous step's own summary.
- Memory: hybrid search (SQLite FTS5 words + vectors, reciprocal rank fusion), identifiers split into words, tests
  ranked below implementation unless asked for. Optional Qwen3-Reranker-0.6B behind a toggle.
- MODEL VAULT: placement plan from `llama-fit-params` (layers on the GPU, MoE experts in RAM) instead of a size guess.
- FORGE v3: training samples answer from project-memory fragments exactly as the chat sends them (with distractors
  and "not in the fragments" refusals, a Russian pair per fragment); evaluation on files held out of training; new
  BENCH step (MMLU, GSM8K, HumanEval subsets) against degradation; the merged model keeps the MTP head and the vision
  projector. Run netrunner-v3: eval loss 1.11 → 0.62, no benchmark regression beyond noise; shorter answers with
  fewer inventions than the base, but over-cautious (refused a Russian question the fragments could answer).
- Fix: the app could hang on quit (or crash when forced): terminal process trees are now killed synchronously
  before node-pty closes its pseudo consoles.

## 1.3.1 — 2026-10-31
- The interface shows the Qwen model family as **Gato** (labels, setup checklist, FORGE, memory, architecture field).
  Display only: GGUF files, model ids, role matching and Hugging Face download specs keep the upstream names.

## 1.3.0 — 2026-10-31 (Phase 9: functional gaps)
- Explorer: new file/folder, rename, delete to the Recycle Bin; disk watcher refreshes the tree and open tabs.
- The agent engine follows a workspace switch; terminal tabs.
- Language servers in the editor: bundled pyright for Python (utility process), rust-analyzer/gopls/clangd from PATH.
- FORGE section: run pipeline steps from the UI with live output; SETUP installs the pinned environment.
- Images in NEURAL CORE (vision models with mmproj); Markdown links and inline images.
- Agent speed in tok/s from llama-server counters; chat history search and export.
- Russian interface (RU/EN toggle, system language by default); answers follow the question's language.
- ripgrep: found on PATH or in NETRUNNER's runtime folder, installable from SETUP.

## 1.2.0 — 2026-10-31 (Phase 8: LM Studio, parallel agents, layouts)
- LM Studio's models folder is detected (or chosen) and listed in MODEL VAULT; its GGUF files run on NETRUNNER's
  llama.cpp in place. NETRUNNER never deletes them.
- PARALLEL 1–4 in AGENT CONTROL: jobs run side by side, each editing job in its own git worktree; one llama-server
  with a slot per job; WORKTREE JOBS with MERGE (checkpoint + three-way merge) and DISCARD.
- Workspace layouts: CLASSIC, CODE, AI PAIR, SIDE TERMINAL, FOCUS and saved custom layouts; the terminal docks below
  or beside the editor without restarting the shell.

## 1.1.0 — 2026-10-31 (Phase 7: llama.cpp)
- Ollama removed: NETRUNNER runs GGUF models with its own llama.cpp `llama-server` processes (loopback, random API key,
  `--fit` placement, larger batches for MoE prompt processing).
- Models: Qwen3-Coder-Next (agents), Qwen3.8-27B (chat, IQ3_XXS default / Q4_K_M), Qwen3-Embedding-0.6B (memory).
- MODEL VAULT: model roles, Hugging Face downloads (`owner/repo:QUANT`, resumable), runtime install from official releases.
- FORGE: llama.cpp teacher/judge, Qwen3.5-4B bf16 LoRA student, GGUF export straight into the models folder.
  Run netrunner-v2: eval loss 1.97 → 1.56, judge score 1.36 → 2.20, model `netrunner-qwen3.5-4b-Q4_K_M.gguf`.
- Fix: `merge_lora.py` loads the vision-language class for Qwen3.5 and fails if the adapter changed no weights.

## 1.0.0 — 2026-10-30 (Phase 6: release)
- Electron Fuses (RunAsNode / NODE_OPTIONS / inspect off, asar integrity on); terminal closes its whole process tree.
- Idle CPU 6.25% → ~0.5% of one core; no helper processes while idle.
- SETUP checklist with PULL and local CREATE `<model>-agent`.
- THIRD_PARTY_NOTICES.txt generated at build; installer shortcuts and uninstall entry.
- Input limits (file write, chat size, CSP log rate); OpenCode on a free port.
- Docs: INSTALL, SECURITY, ACCEPTANCE.

## 0.5.0 — Phase 5: advanced HUD
- SYSTEM MONITOR with customizable widgets, NETWORK MONITOR with persistent log, optional Windows Firewall rule.
- Inference and agent performance metrics, pipeline graph, safe Markdown rendering.

## 0.4.0 — Phase 4: multi-agent system
- SQLite (node:sqlite) history, persistent task queue, ARCHITECT → CODER → DEBUGGER → REVIEWER pipeline.
- Project memory: qwen3-embedding + sqlite-vec semantic search.

## 0.3.0 — Phase 3: agentic coding
- OpenCode agents on local Ollama with approvals, PowerShell terminal (node-pty), git checkpoints, diff review, policy proxy.

## 0.2.0 — Phase 2: local intelligence
- Ollama runtime, MODEL VAULT, NEURAL CORE chat, network modes; FORGE local QLoRA fine-tuning (netrunner-qwen3:8b).

## 0.1.0 — Phase 1: foundation
- Frameless Electron shell, cyberpunk HUD, workspace explorer, Monaco editor, command palette.
