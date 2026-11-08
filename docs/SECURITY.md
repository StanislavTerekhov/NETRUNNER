# NETRUNNER — security review

First review: 2026-10-30 (1.0), updated with every release since. A manual audit of the main, preload and renderer
code and the build configuration, plus automated checks.

## Threat model

1. **Model output and repository content are untrusted.** A model can be wrong or be "talked into" something by file
   contents (prompt injection); a repository can contain a malicious config.
2. **The agent runs commands** on the user's system.
3. **Code or conversations leaking** to the cloud (forbidden by the specification).
4. **Other local processes** may try to control NETRUNNER or OpenCode.

## Measures in place

| Area | Measure | Where |
|---|---|---|
| Renderer | `contextIsolation`, `sandbox`, no `nodeIntegration`; the CJS preload exposes only `window.netrunner` | `electron/main/index.ts`, `electron/preload/index.ts` |
| IPC | Channel allowlist; the sender is checked on every call (our window, main frame, our URL); arguments are validated | `electron/main/ipc.ts`, `electron/shared/ipc.ts` |
| Destructive actions | Deleting a model, rolling back to a checkpoint, changing the firewall go through a native dialog of the main process that the renderer cannot "click" | `ipc.ts` |
| Files | Access only inside the folder the user chose: lexical check plus `realpath` (symlinks and junctions pointing outside are blocked); reopening by path only for folders picked in the dialog; atomic writes with an mtime check and a 5 MB limit | `workspace.ts`, `workspace-path.ts` |
| Navigation | Navigation, `window.open`, `<webview>` and all permission requests are denied | `index.ts` |
| CSP | `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` | `vite.config.ts` |
| Model output | Markdown is rendered into React elements; `innerHTML` is not used anywhere | `src/components/Markdown.tsx` |
| Inference | NETRUNNER starts `llama-server` itself on 127.0.0.1 with a random API key; there are no cloud providers in the code; the agent engine accepts only a loopback backend; model and runtime downloads only in ONLINE TOOLS mode and are logged | `llamacpp.ts`, `runtime-install.ts`, `opencode.ts`, `forge/common.py` |
| Agent | Every `edit`/`bash` = ask; `external_directory` = deny; web only in ONLINE TOOLS and with approval; project config disabled (`OPENCODE_DISABLE_PROJECT_CONFIG`); cloud keys stripped from the environment; isolated XDG folders; password-protected server on a random port; the whole process tree is killed on stop | `opencode.ts` |
| Agent and terminal network | A policy proxy that does not even resolve blocked names; log in SQLite; optional Windows Firewall rule for `opencode.exe` | `net-proxy.ts`, `firewall.ts` |
| Git | Checkpoints through a temporary index — the user's HEAD, branches and index are untouched; checkpoint ids are checked against the list | `git.ts` |
| Parallel agents (1.2) | Tasks write only to their own worktree (outside the project, `external_directory: deny` relative to it); changes reach the project only through MERGE, confirmed in a main-process dialog, with a checkpoint before the merge; DISCARD is confirmed too; task ids are checked against a pattern; the `node_modules` junction is detached before a worktree is deleted | `tasks.ts`, `git.ts`, `ipc.ts` |
| Explorer actions (1.3) | Create and rename only inside the project (lexical and realpath checks), names are validated; delete goes to the Windows Recycle Bin after a main-process confirmation | `workspace.ts`, `ipc.ts` |
| Language servers (1.3) | pyright is bundled and runs in an Electron utility process, connected through a message port (no loopback socket); servers from PATH use stdio. Paths over IPC are only relative paths inside the project; the renderer can call just 4 methods (completion, hover, definition, signatureHelp) | `lsp.ts`, `pyright-host.cjs`, `ipc.ts` |
| Images in chat (1.3) | Only data-URL PNG/JPEG/WebP/GIF, up to 4 images and 6 MB; remote images in Markdown are not loaded; links are https only and open in the system browser on click | `ipc.ts`, `Markdown.tsx` |
| FORGE from the UI (1.3) | Steps are fixed commands (run name matched against a pattern, numbers within bounds); offline (`HF_HUB_OFFLINE=1`) and through the policy proxy; SETUP only in ONLINE TOOLS, versions pinned by lock files | `forge.ts` |
| Web tools (1.6) | Only in ONLINE TOOLS; the approval mode (ASK / LIMITED / FULL) is enforced in the main process, approval dialogs are native. Requests to loopback, private and link-local addresses are refused, also after DNS resolution and on every redirect (a page cannot steer a request to the local llama-server). Page responses up to 3 MB, binary files are not read. git/npm/pip go through the policy proxy; cloning is https only, without credentials. Tools are offered to agents by an MCP server on 127.0.0.1 with a random key; OpenCode's cloud websearch is disabled. Brave/Google keys are kept in secrets.json encrypted with DPAPI and never sent to the renderer | `web-tools.ts`, `mcp-server.ts`, `secrets.ts` |
| File writes from chat (1.5) | The mode (ASK / LIMITED / FULL) is stored in settings and enforced in the main process; the renderer cannot write more than the chosen mode allows; approvals are native main-process dialogs. Paths only inside the project (lexical and realpath checks, every name validated, `.git` forbidden), up to 20 files of 5 MB. Fragments containing "... existing code" are never written automatically. Undo works only while the file is unchanged since the write; a created file goes to the Recycle Bin | `chat-files.ts`, `workspace.ts`, `ipc.ts` |
| FORGE benchmarks (1.4) | MMLU/GSM8K/HumanEval data is downloaded only by SETUP (ONLINE TOOLS) from pinned Hugging Face commits, with SHA-256 recorded in `bench\manifest.json`. Code written by the model for HumanEval runs in a separate `python -I` process in a temporary folder with a stripped environment (SYSTEMROOT, TEMP, TMP, PATH) and a 15 s timeout | `setup_env.py`, `bench.py` |
| Memory reranker (1.4) | The optional Qwen3-Reranker-0.6B model runs in the same loopback llama-server with a random key; downloaded only with the SETUP button in ONLINE TOOLS | `memory.ts`, `llamacpp.ts` |
| LM Studio (1.2) | The folder is chosen only through the system dialog (the renderer cannot pass a path); LM Studio files are read-only, deleting them is refused; they run in the same loopback llama-server with a random key | `lmstudio.ts`, `llamacpp.ts`, `ipc.ts` |
| Installer (1.9.3) | The one-click installer downloads models only from pinned Hugging Face revisions and from this repository's `models-v1` release, over https with Windows' own `curl.exe`; every file is checked against a SHA-256 built into the installer (the Hugging Face hashes were cross-checked against the ones Hugging Face publishes) and a file that does not match is deleted and downloaded again. Git for Windows comes from its official release, pinned to one version and its published SHA-256. No administrator rights; everything goes to the user's profile | `tools/installer/netrunner-setup.iss`, `models.json` |
| Build | Electron Fuses: `RunAsNode` off, `NODE_OPTIONS` off, `--inspect` off, asar integrity check on, load only from asar on, cookie encryption on | `electron-builder.json` |

## Found and fixed in phase 6

| # | Problem | Risk | Fix |
|---|---|---|---|
| 1 | `RunAsNode` was enabled in the build: `NETRUNNER.exe` with `ELECTRON_RUN_AS_NODE=1` behaved as plain Node.js (a ready-made way to run arbitrary code under a trusted exe) | medium | Electron Fuses; verified with `@electron/fuses read` |
| 2 | node-pty closed the terminal through `fork` (Electron-as-Node), incompatible with #1 | functional | The terminal is ended as a tree with `taskkill /T`, which also stops commands started in it |
| 3 | `fs:write` had no size limit (reads had 5 MB) | low (disk DoS) | 5 MB limit |
| 4 | `conversations:save` had no limit | low | 20 MB JSON limit, fields normalized |
| 5 | `network:csp-violation` could be called in a loop to bloat the log | low | At most 20 records per second |
| 6 | OpenCode with `--port=0` listened on a fixed 4096 — a conflict with the user's own OpenCode and a predictable port | low | Free port from the OS |

## Residual risks (accepted knowingly)

1. **Approval is the last line of defence.** If the user approves a harmful command, the agent runs it. The approval
   card shows the exact command or diff; ARCHITECT and REVIEWER cannot edit files. Since 1.7, ALWAYS allows only
   exactly that command or that file (not an OpenCode pattern such as `npm *`), until the engine stops; the list is
   visible and can be revoked.
2. **A proxy is not a sandbox.** The agent's commands (`node`, `npm`, `git`) are separate programs; a program that
   ignores `HTTP(S)_PROXY` can reach the network around the proxy. Since 1.7 the FIREWALL section blocks internet
   access for NETRUNNER's own programs (OpenCode, llama-server, ripgrep) and for any program the operator adds; NETRUNNER
   does not block the shared `node`/`git`/`python` itself because the user needs them outside NETRUNNER too. The
   operator applies the rules (UAC).
3. **The agent acts with the user's rights** within the project folder (`external_directory: deny`), but `bash` can
   technically reach any of the user's files — which is why every command waits for approval.
4. **Smoke mode** has been stripped from the release build since 1.7 (`vite build --mode release`); it exists only
   in the test build `npm run dist:test` and in development mode.
5. **Model servers** (llama.cpp since 1.1, instead of Ollama) listen only on 127.0.0.1 and require a random API key
   that is new on every start; other local processes cannot use them. When installed from inside the app, the
   runtime comes from ggml-org's official GitHub releases; since 1.7 every archive is checked against the SHA-256 that
   GitHub publishes (no hash — not installed), and updates are checked with a button. The llama.cpp binaries
   themselves are not signed (signing is up to ggml-org).
6. **The installer is not code-signed** (no code-signing certificate), so SmartScreen warns on first run.
7. **ripgrep** ships with the one-click installer (1.9.3). With the plain NSIS installer it is installed with the
   SETUP button (official release) or taken from PATH; without it the agents' `grep`/`glob` do not work offline.
8. **Language servers analyse the project's code** (pyright reads files and runs `python` to locate packages) — this
   is reading on the local machine; they do not use the network.
9. **HumanEval runs model-written code on this machine.** A separate process, a temporary folder, a stripped
   environment and a timeout are not a sandbox: the code runs with the user's rights and could in theory read the
   user's files or reach the network. HumanEval tasks are harmless and the model is your own local one; the BENCH
   step can be left unselected.
10. **Installing and running other people's repositories** (`repo_install`, `repo_run`) executes their scripts with
    the user's rights — this is not a sandbox. In ASK and LIMITED modes every such action is confirmed with the exact
    command; in FULL it is not. Text from the internet can contain instructions for the model (prompt injection): in
    LIMITED mode dangerous actions still wait for approval.
11. **The one-click installer needs the internet** for about 85 GB of models. The files are verified by SHA-256, so a
    tampered download is rejected, but the availability of Hugging Face and GitHub is outside NETRUNNER's control.

## Automated checks

- `npm audit --omit=dev`: **0 vulnerabilities** in shipped dependencies. Moderate findings remain in `minimatch`
  inside electron-builder (build time only).
- `dompurify` (transitively through Monaco) is pinned to the fixed 3.4.17+ through `overrides`.
- Security unit tests: escaping the project folder (`..`, absolute paths, UNC, drive letters, NUL, junctions),
  endpoint policy, cloud models, the proxy (HTTP and CONNECT are blocked without contacting the host), an agent
  environment without keys, Markdown parsing without HTML, firewall command escaping, write limits.
- Accessibility (axe-core, WCAG 2.1 A + AA) over all sections: 0 violations, in development and in the packaged
  test build.
