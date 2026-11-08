# NETRUNNER — архитектура реализации

> **Итог 1.0 (отличия от первоначального плана ниже):** SQLite — встроенный в Electron `node:sqlite` вместо `better-sqlite3`
> (не нужна нативная сборка); эмбеддинги — `qwen3-embedding:0.6b`; основная модель — `qwen3.6:35b`, для агентов —
> `qwen3.6:35b-agent` (32K контекст); бэкенды llama.cpp/LM Studio не подключались (выбран Ollama); телеметрия — `os.cpus()` +
> `nvidia-smi` + `systeminformation`; принуждение сети — проверка эндпоинтов, CSP + фильтр renderer, прокси политики для агента
> и терминала, опциональное правило Windows Firewall. Безопасность: [SECURITY.md](SECURITY.md), приёмка: [ACCEPTANCE.md](ACCEPTANCE.md).
>
> **1.1:** Ollama заменён на llama.cpp (`electron/main/services/llamacpp.ts`, `gguf.ts`, `runtime-install.ts`): каталог GGUF в
> `%USERPROFILE%\NETRUNNER\models`, процессы `llama-server` на loopback со случайным ключом, слоты чата и эмбеддингов, роли
> GENERAL/AGENT/MEMORY. OpenCode получает провайдер `llamacpp` (OpenAI-совместимый). Упоминания Ollama ниже — история 1.0.
> См. [PHASE-7.md](PHASE-7.md).
>
> **1.2:** второй источник моделей — папка LM Studio (`lmstudio.ts`, `ModelCatalog` с несколькими корнями); очередь задач
> работает «заданиями» с N полосами (`tasks.ts`, таблица `agent_jobs`), задания с правками — в git worktree (`git.ts`:
> `addWorktree`/`worktreeChanges`/`mergeWorktree`), OpenCode — сессии по каталогам и `/global/event`, llama-server — `-np N`;
> раскладки рабочего места (`layout-store.ts`, `LayoutMenu.tsx`), терминал переподключается к живой оболочке (`pty:buffer`).
> См. [PHASE-8.md](PHASE-8.md).
>
> **1.3:** `lsp.ts` (LSP-клиент в main, pyright в utility process через `electron/lsp-host/pyright-host.cjs`, Monaco-провайдеры
> в `src/features/editor/lsp-client.ts`), `forge.ts` (`ForgeService` — шаги FORGE из UI), `ripgrep.ts`, файловые операции и
> `fs.watch` в `workspace.ts`, вкладки терминала, i18n (`src/lib/i18n.ts`, `i18n-ru.ts`). См. [PHASE-9.md](PHASE-9.md).

Документ фиксирует результаты обзора репозиториев из спецификации и принятые решения.
Дата обзора: 2026-10-30. Целевая машина разработки: Windows 11, Ryzen 9 5950X, 64 ГБ RAM,
RTX 3060 12 ГБ (драйвер 621.01), Node 24.19, npm 11.17, Python 3.13. Ollama **не установлен**.

## 1. Обзор зависимостей

| Компонент | Пакет / версия (актуальная на дату) | Лицензия | Как используем |
|---|---|---|---|
| Каркас | electron-vite-react (шаблон 2.3.0), vite 8, vite-plugin-electron 1.x | MIT | Скопирована структура `electron/main`, `electron/preload`, `src`, конфиги TS/Vitest. Демо, автообновление (electron-updater → GitHub) и `open-win` с `nodeIntegration` **удалены** |
| Electron | electron 42.x (как в шаблоне; 45.x — последняя) | MIT | Основной процесс, frameless-окно |
| Агент | opencode-ai / @opencode-ai/sdk 1.19.x | MIT | Фаза 3: `createOpencode({hostname:'127.0.0.1', port, config})`, сессии, SSE `event.subscribe()`, `session.abort`, ответы на permissions через `POST /session/:id/permissions/:pid` |
| Инференс | Ollama (сервер, http://127.0.0.1:11434), npm `ollama` 0.6.x | MIT | Фаза 2: `/api/tags`, `/api/ps`, `/api/chat` (stream), `/api/pull` |
| Альт. инференс | llama.cpp `llama-server` (OpenAI-совместимый `/v1`) | MIT | Фаза 2+: настраиваемый бэкенд (путь к бинарю, GGUF, `-c`, `-ngl`) |
| LM Studio | локальный сервер `http://127.0.0.1:1234/v1` | проприетарное приложение | Опционально, только обнаружение и подключение |
| Редактор | monaco-editor 0.57, @monaco-editor/react 4.7 | MIT | Monaco **загружается из бандла** (`loader.config({ monaco })`), а не с CDN — иначе офлайн-режим ломается |
| Терминал | @xterm/xterm 6, @xterm/addon-fit, node-pty 1.1 | MIT | node-pty — нативный модуль, только в main-процессе; требует пересборки под ABI Electron |
| UI | tailwindcss 4.3 (+@tailwindcss/vite), motion 14, lucide-react, zustand 5, react-resizable-panels 4 | MIT/ISC | HUD, анимации, состояние, раскладка |
| БД | better-sqlite3 13 (+ sqlite-vec 0.1.9) | MIT / MIT-or-Apache | Фаза 4: история, сессии, векторный поиск. Нативный модуль → main-процесс |
| Мониторинг | systeminformation 5.33 | MIT | Фаза 5: CPU/RAM/диск. GPU/VRAM — `nvidia-smi --query-gpu` (NVIDIA), при отсутствии — «нет данных», не выдумываем |
| Упаковка | electron-builder 26 (NSIS x64) | MIT | Фаза 6; на каждой фазе проверяем `--dir` сборку |

## 2. Выявленные риски и ограничения Windows

1. **Нативные модули (node-pty, better-sqlite3)** собираются под ABI конкретной версии Electron.
   Нужны prebuild-бинарники либо `@electron/rebuild` + Visual Studio Build Tools (C++). Проверим в Фазе 3/4;
   в Фазе 1 нативных модулей нет намеренно.
2. **Проект лежит в OneDrive** (`Desktop` синхронизируется). Синхронизация `node_modules`/`release`
   может блокировать файлы при сборке. Рекомендуется исключить папки из синхронизации или перенести проект
   (например, `C:\dev\netrunner`).
3. **OpenCode и сеть.** OpenCode обращается к models.dev за каталогом моделей и проверяет обновления.
   Документированные рычаги: `"autoupdate": false`, `"disabled_providers"`/`"enabled_providers"`,
   явные `"model"` и `"small_model"` на `ollama/<tag>` (иначе заголовки сессий генерирует облачная модель!).
   Документированного флага для отключения models.dev не найдено → в режиме STRICT OFFLINE изоляция
   процесса OpenCode должна обеспечиваться снаружи (см. §4), а не доверием к конфигу.
4. **Sandbox-preload** не поддерживает ESM → preload собирается в CommonJS (`index.cjs`).
5. **WMI занижает VRAM** (AdapterRAM = 4 ГБ при реальных 12 ГБ) → для NVIDIA используем `nvidia-smi`.
6. **Тулзы с моделями.** Веса моделей (гигабайты) в инсталлятор не включаем: Model Vault скачивает их
   через Ollama `pull` в режиме ONLINE TOOLS, либо импортирует локальные GGUF. ID моделей не хардкодятся —
   берутся из `/api/tags` и каталога рантайма.

## 3. Процессная модель

```
┌──────────────── Renderer (sandbox, contextIsolation, без Node) ────────────────┐
│ React + Zustand + Monaco + xterm.js. Доступ к системе только через window.netrunner │
└───────────────▲─────────────────────────────────────────────────────────────────┘
                │ typed allowlisted IPC (electron/shared/ipc.ts)
┌───────────────┴──────── Preload (CJS, contextBridge) ──────────────────────────┐
└───────────────▲─────────────────────────────────────────────────────────────────┘
┌───────────────┴──────── Main process ──────────────────────────────────────────┐
│ window · workspace FS (scoped) · settings · [Ф2] runtime adapters (Ollama,      │
│ llama.cpp, LM Studio) · [Ф3] pty manager, OpenCode supervisor, approvals, git    │
│ · [Ф4] SQLite/sqlite-vec, agent orchestrator · [Ф5] telemetry · network policy  │
└───────┬───────────────────────────┬──────────────────────────┬───────────────────┘
        ▼                           ▼                          ▼
  Ollama :11434 / llama-server  opencode serve (127.0.0.1)   PowerShell (node-pty)
```

Правила:
- Каждый IPC-канал объявлен в `electron/shared/ipc.ts`; main регистрирует обработчики только из этого списка
  и проверяет `event.senderFrame` (только наше окно и наш origin).
- Пути от renderer'а всегда проходят `resolveInWorkspace()`: нормализация, запрет выхода за корень
  (включая `..`, абсолютные пути, другие диски, UNC). Покрыто unit-тестами.
- CSP запрещает удалённые скрипты; навигация и `window.open` запрещены.

## 4. Сетевая политика (Фазы 2–5)

Режимы: `STRICT_OFFLINE`, `LOCAL_NETWORK_ONLY`, `ONLINE_TOOLS`. Инференс всегда только на loopback/локальной сети,
облачных провайдеров в коде нет вообще.

Уровни принуждения:
1. **Main-процесс Electron**: `session.webRequest.onBeforeRequest` блокирует запросы renderer'а вне разрешённых хостов;
   все исходящие запросы main идут через единый `netGuard` с журналом (Network Monitor).
2. **Дочерние процессы** (OpenCode, агентские команды): переменные `HTTP(S)_PROXY` на локальный
   журналирующий прокси NETRUNNER, который отклоняет внешние хосты в офлайн-режимах; `NO_PROXY=localhost,127.0.0.1`.
   Это ловит «вежливые» клиенты, но не произвольный сокет.
3. **ОС-уровень (опционально, требует прав администратора)**: правила Windows Defender Firewall
   (`New-NetFirewallRule -Direction Outbound -Program <opencode.exe> -Action Block`), создаются только по явному
   подтверждению пользователя. Без этого UI честно показывает «принуждение на уровне ОС не активно».

## 5. Агентная система (Фазы 3–4)

- OpenCode — движок выполнения (tools: read/edit/bash/grep). NETRUNNER генерирует `opencode.json` на лету:
  только провайдер `ollama`/`llamacpp`/`lmstudio` через `@ai-sdk/openai-compatible`, `autoupdate:false`,
  `permission: { edit:"ask", bash:"ask", webfetch:"deny"|"ask", external_directory:"deny" }`.
- Запросы permissions из SSE отображаются в UI как карточки подтверждения с diff/командой.
- Роли ARCHITECT/CODER/DEBUGGER/REVIEWER/OPERATOR = агенты OpenCode (`agent.<name>` с собственными
  промптом, моделью и permission). Оркестратор выполняет очередь задач **последовательно**.
- Перед каждой задачей — git-checkpoint (`git stash create`/коммит в служебную ветку), откат через UI.

## 6. Хранилище

- `%APPDATA%/NETRUNNER/settings.json` — настройки, последние проекты, раскладка (Фаза 1).
- `%APPDATA%/NETRUNNER/netrunner.db` — SQLite (Фаза 4): projects, sessions, messages, agent_runs,
  task_queue, network_log, chunks + `vec0` таблица эмбеддингов (эмбеддинги локальной моделью через Ollama `/api/embed`).

## 7. Структура репозитория

```
electron/
  main/        index.ts (окно, безопасность), ipc/*.ts, services/*.ts
  preload/     index.ts → index.cjs
  shared/      ipc.ts (контракт каналов и типы)
src/
  app/         App.tsx, store.ts, commands.ts
  components/  hud/ (Panel, TitleBar, NavRail, StatusBar, CommandPalette)
  features/    workspace/, editor/, placeholders
test/          unit (vitest), smoke (запуск собранного Electron + скриншот)
docs/          ARCHITECTURE.md, PHASE-*.md
```
