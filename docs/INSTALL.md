# NETRUNNER 1.1 — установка

NETRUNNER — локальная среда разработки с ИИ. Модели работают на вашем компьютере через llama.cpp; код и переписка
никуда не отправляются. Ollama не нужен (с версии 1.1).

## 1. Требования

| | Минимум | Проверено на |
|---|---|---|
| ОС | Windows 10/11 x64 | Windows 11 Home 26100 |
| RAM | 16 ГБ для малых моделей; **64 ГБ** для Qwen3-Coder-Next (48 ГБ) | 64 ГБ |
| GPU | желательно NVIDIA ≥ 8 ГБ VRAM (без GPU — CPU-сборка llama.cpp, медленно) | RTX 3060 12 ГБ |
| Диск | ~1 ГБ NETRUNNER + ~0,7 ГБ llama.cpp + модели (0,6–48 ГБ каждая) | |
| Git for Windows | для чекпоинтов агентов и diff-ревью | 2.45 |

## 2. Установка

1. Запустите `NETRUNNER_Setup_1.1.0.exe` — установка для текущего пользователя, без прав администратора.
   Установщик не подписан: SmartScreen → «Подробнее → Выполнить в любом случае».
2. Откройте NETRUNNER → **MODEL VAULT** → NETWORK MODE → **ONLINE TOOLS** (интернет нужен один раз).
3. В панели **SETUP** нажмите:
   - **INSTALL llama.cpp** — официальная сборка с GitHub (CUDA, если есть NVIDIA; иначе CPU), ~0,7 ГБ;
   - **DOWNLOAD** для недостающих моделей (с Hugging Face, с докачкой):

     | Роль | Модель | Размер |
     |---|---|---|
     | GENERAL (чат) | `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M` (или `:UD-IQ3_XXS` — вдвое быстрее) | 16,5 / 10,9 ГБ |
     | AGENT (агенты) | `Qwen/Qwen3-Coder-Next-GGUF:Q4_K_M` | 48,4 ГБ |
     | MEMORY (поиск по коду) | `Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` | 0,6 ГБ |

   Любую другую GGUF-модель можно скачать в поле DOWNLOAD MODEL (`owner/repo:QUANT`) или просто положить файл
   в `%USERPROFILE%\NETRUNNER\models\`.
4. Верните режим **STRICT OFFLINE**. Дальше интернет не нужен. SETUP показывает зелёные галочки, когда всё готово.

Роли назначаются в карточке модели: ★ — GENERAL, робот — AGENT, база данных — MEMORY.

## 3. Чего ожидать по скорости (RTX 3060 12 ГБ, 64 ГБ RAM)

| Модель | Загрузка | Ответ |
|---|---|---|
| Qwen3-Coder-Next | 30–100 с | ~16–20 ток/с (первый ответ после загрузки медленнее — модель подкачивается с диска) |
| Qwen3.8-27B IQ3_XXS / Q4_K_M | 10–30 с | ~6 / ~3 ток/с — плотная модель не помещается в 12 ГБ VRAM |

Обе большие модели в 64 ГБ одновременно не помещаются: NETRUNNER держит одну и переключает. Пока работает движок агентов,
его модель закреплена — для смены модели в чате остановите движок.

## 4. Первые шаги

| Задача | Где |
|---|---|
| Открыть проект | WORKSPACE → OPEN FOLDER (Ctrl+O) |
| Чат | NEURAL CORE (MEMORY — подмешать код проекта, ACTIVE FILE — открытый файл, THINK — рассуждения) |
| Задача агенту | AGENT CONTROL → START ENGINE → роль → RUN; каждая правка/команда ждёт APPROVE |
| Конвейер | AGENT CONTROL → цель → PIPELINE (ARCHITECT → CODER → DEBUGGER → REVIEWER) |
| Ревью и откат | REVIEW CHANGES SINCE CHECKPOINT → GIT → REVERT ALL |
| Поиск по смыслу | MEMORY → BUILD INDEX |
| Команды | Ctrl+Shift+P |

## 5. Где хранятся данные

| Что | Где |
|---|---|
| Настройки, история, очередь задач, индекс памяти, журнал сети | `%APPDATA%\NETRUNNER\` |
| Модели (GGUF) | `%USERPROFILE%\NETRUNNER\models\` |
| Рантайм llama.cpp | `%USERPROFILE%\NETRUNNER\runtime\llama.cpp\b<номер>\` |
| FORGE (обучение) | `%USERPROFILE%\NETRUNNER\forge\` |
| Чекпоинты агентов | git вашего проекта: `refs/netrunner/checkpoints/*` |

Удаление: «Параметры → Приложения → NETRUNNER». Папки `%USERPROFILE%\NETRUNNER` и `%APPDATA%\NETRUNNER` остаются —
удалите вручную, если модели больше не нужны.

## 6. Если что-то не работает

| Симптом | Решение |
|---|---|
| `AI RUNTIME: NOT INSTALLED` | MODEL VAULT → SETUP → INSTALL llama.cpp (в ONLINE TOOLS) |
| Модель не загружается | Мало RAM/VRAM — закройте тяжёлые программы или выберите меньшую квантизацию |
| «The agent engine is using …» в чате | Остановите движок агентов, чтобы переключить модель |
| `glob`/`grep` агента с ошибкой | ripgrep не поставляется в этой версии; агент читает файлы напрямую |
| Нет данных GPU | Не найден `nvidia-smi` (не-NVIDIA GPU или нет драйвера) |

## 7. Сборка из исходников (разработчику)

1. Node.js ≥ 22.12 (npm 11), Git, Python 3.13 — только для FORGE.
2. `npm ci` в папке проекта. Установочные скрипты зависимостей разрешены явно и с версией в `package.json` →
   `allowScripts`: `electron-winstaller` (выбор 7-Zip), `node-pty` (готовая сборка терминала), `opencode-ai` (выбор
   бинарника под процессор). Скрипты проверены: работают локально, в сеть не ходят. npm 11 пока только предупреждает
   о непроверенных скриптах, следующие версии будут их блокировать — поэтому список ведётся заранее. После обновления
   этих пакетов: `npm approve-scripts --allow-scripts-pending` (что ждёт решения), затем `npm approve-scripts <пакет>`.
3. Electron 42 скачивает свой бинарник при первом запуске (`npm run dev`); если это не удалось (нет сети, прокси),
   один раз: `npx install-electron --no`.
4. `npm run dev` — разработка; `npm test` — юнит-тесты; `npm run test:smoke` — приёмка интерфейса.
5. `npm run dist` — релизный установщик (без тестового режима); `npm run dist:test` — тестовая сборка
   (`release\<версия>-test`), на ней прогоняется приёмка собранного exe: `NETRUNNER_SMOKE_EXE=…\NETRUNNER.exe`.
