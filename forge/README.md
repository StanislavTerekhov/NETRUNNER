# FORGE — локальное обучение весов

Дообучение (LoRA) небольшой модели Qwen на знаниях конкретного проекта. Всё выполняется на этой машине, инференс —
llama.cpp (`llama-server`), обучение — Unsloth на одной GPU.

| Роль | Модель | Почему |
|---|---|---|
| Учитель (генерирует датасет) | Qwen3-Coder-Next (GGUF, llama.cpp) | Кодовая модель; MoE 80B/3B активных — быстро на CPU+GPU |
| Ученик (дообучается) | **Qwen3.5-4B**, bf16 LoRA | Самое новое семейство Qwen с размером, который можно обучать на 12 ГБ: Unsloth указывает ~10 ГБ для 4B bf16 LoRA и не рекомендует 4-битную QLoRA для Qwen3.5 |
| Судья (оценка) | Qwen3.8-27B (GGUF) | Другая модель, чем учитель, — меньше «самооценки» |

Почему не дообучаются сами большие модели: по документации Unsloth QLoRA Qwen3.8-27B требует 24 ГБ VRAM, LoRA
Qwen3-Coder-Next — GPU уровня B200. На RTX 3060 (12 ГБ) это невозможно; облако нарушило бы локальную политику.

## Расположение

`%USERPROFILE%\NETRUNNER\` (переопределяется `NETRUNNER_HOME`):
- `models\` — GGUF-модели NETRUNNER (их видит приложение); экспорт FORGE кладётся в `models\netrunner\`
- `runtime\llama.cpp\b<NNNN>\` — официальная CUDA-сборка llama.cpp
- `forge\venv\` — Python 3.13, PyTorch CUDA 13, Unsloth
- `forge\convert-venv\` — отдельное окружение конвертера llama.cpp (он пинит свою версию transformers)
- `forge\llama.cpp\` — Python-конвертер `convert_hf_to_gguf.py`; `forge\llama-bin\` — `llama-quantize`
- `forge\hf\` — кэш весов Hugging Face; `forge\runs\<run>\` — датасет, отчёты, адаптер, слитые веса, GGUF

## Из интерфейса (1.3)

Раздел **FORGE** в NETRUNNER: проверка окружения, выбор шагов, живой лог, отмена, список прогонов. **SETUP** ставит
окружение (~15 ГБ, нужен режим ONLINE TOOLS) скриптом `setup_env.py` по зафиксированным версиям
`requirements-train.lock.txt` / `requirements-convert.lock.txt` (сняты с рабочего окружения) плюс конвертер и
`llama-quantize` тега b12018. Вручную: `py -3.13 setup_env.py`.

## Шаги из консоли

```bash
set PY=%USERPROFILE%\NETRUNNER\forge\venv\Scripts\python.exe
cd forge
%PY% download_models.py                                        # GGUF-модели для приложения (один раз, онлайн)
%PY% build_dataset.py --workspace .. --run netrunner-v3        # учитель: Qwen3-Coder-Next
%PY% train_qlora.py   --run netrunner-v3                       # Qwen3.5-4B, bf16 LoRA
%PY% merge_lora.py    --run netrunner-v3                       # + голова MTP и файлы процессора изображений базы
%PY% export_gguf.py   --run netrunner-v3 --name netrunner-netrunner-v3            # GGUF + mmproj
%PY% export_gguf.py   --run netrunner-v3 --name qwen3.5-4b-base --source base
%PY% evaluate.py      --run netrunner-v3 --base qwen3.5-4b-base --tuned netrunner-netrunner-v3
%PY% bench.py         --run netrunner-v3 --models qwen3.5-4b-base netrunner-netrunner-v3
```

Скрипты сами запускают `llama-server` на свободном loopback-порту со случайным ключом и останавливают его.

## Датасет v3 (1.4): ответы по памяти проекта

- Код режется на фрагменты так же, как индекс памяти приложения (60 строк, перекрытие 10).
- Учитель пишет по 4 пары вопрос/ответ на фрагмент (последняя — на русском); больше 4 не берётся.
- Каждый вопрос в датасете приходит с фрагментами памяти **в том же виде, в каком их подставляет чат** (MEMORY):
  нужный фрагмент и 1–2 похожих по BM25 «отвлекающих», в случайном порядке. ~8% примеров — фрагменты без ответа
  и честный отказ («в найденных фрагментах этого нет»).
- ~15% файлов (по хэшу пути) отложены: они не попадают в обучение даже как отвлекающие; оценка идёт только по ним.
- Ответы учителя кэшируются (`teacher_cache.jsonl`); фрагмент, на котором учитель зациклился (ответ не разбирается
  как JSON), запоминается как пустой и не повторяется.

## Оценка и бенчмарки

- `evaluate.py` — база против дообученной на вопросах по отложенным файлам: судья Qwen3.8-27B (0–10), F1 по
  токенам, доля ответов, называющих файл-источник; отдельно — вопросы без ответа и вопросы на русском.
- `bench.py` — общие способности, чтобы видеть деградацию: MMLU (285, по 5 на предмет), GSM8K (150), HumanEval
  (164, все). Ответы проверяются без модели: буква (грамматика `[ABCD]`), последнее число, тесты задачи.
  Код HumanEval выполняется в отдельном процессе `python -I` во временной папке, с урезанным окружением и тайм-аутом
  15 с. Данные качает `setup_env.py` с зафиксированных коммитов Hugging Face (SHA-256 в `bench\manifest.json`).

## Сеть

Интернет нужен один раз — для пакетов Python, моделей и весов базы. Обучение, слияние, экспорт и оценка работают
офлайн (`HF_HUB_OFFLINE=1`). Статистика Unsloth отключена (`UNSLOTH_DISABLE_STATISTICS=1`).
