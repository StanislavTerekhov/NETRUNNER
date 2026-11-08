"""Step 1: build a memory-grounded fine-tuning dataset from a local codebase.

A local teacher model (GGUF served by llama.cpp) reads each code chunk and writes question/answer pairs grounded in
that chunk. Each training sample then looks exactly like a NETRUNNER chat with the MEMORY toggle on: the question
comes after "Relevant code from the project memory" with the source chunk among similar chunks of other files
(found with a word index, so they are plausible distractors). The model learns to answer from the retrieved code,
cite the file, and say so when the fragments do not contain the answer. Nothing leaves the machine.

Evaluation is honest: a fraction of the FILES is held out. No chunk of a held-out file appears in training, not even as
a distractor, so the eval measures reading unseen code, not recall of trained answers.

Usage:
  python build_dataset.py --workspace C:\\path\\to\\project --run netrunner-v3 [--teacher Qwen3-Coder-Next]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import LlamaServer, find_model, run_dir, write_jsonl

SOURCE_EXT = {".ts", ".tsx", ".js", ".mjs", ".py", ".md", ".css", ".json", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h"}
SKIP_DIRS = {"node_modules", ".git", "dist", "dist-electron", "release", "build", "out", "__pycache__", ".venv", "venv", "test-results",
             "output", "unsloth_compiled_cache", "evidence"}
SKIP_FILES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock"}
MAX_FILE_BYTES = 200_000
# The same windows and prompt prefix as the app's project memory (electron/main/services/memory.ts, src/app/chat-store.ts).
CHUNK_LINES, OVERLAP = 60, 10
MEMORY_HEADER = "Relevant code from the project memory (local semantic search):\n"
MEMORY_MAX_CHARS = 10000
NOT_FOUND_FRACTION = 0.08

SYSTEM_PROMPT = (
    "You are NETRUNNER, a senior software engineer assistant running fully locally on the user's Windows workstation. "
    "Answer precisely, prefer working code, and say when you are unsure."
)

TEACHER_INSTRUCTIONS = """You create training data for a coding assistant that answers questions about this project from code
fragments retrieved by its project memory.
Below are lines {start}-{end} of the file `{path}` from the project "{project}".

Write {n} question/answer pairs that THIS fragment answers.
Rules:
- Questions are what a developer would type into the chat: some name the function, file or component, some describe the behaviour in plain words.
- Answers must use only facts visible in the fragment; do not invent behaviour that is not shown.
- Answers name the file `{path}` and the relevant functions, variables or parameters. 2-6 sentences; a short code snippet only if it helps.
- Mix question types: what does X do, how does X handle Y, where is X implemented, why is X done this way.
- Write the LAST pair in Russian (question and answer in Russian; keep code identifiers and paths unchanged).
Return JSON: {{"pairs": [{{"question": "...", "answer": "..."}}]}}

```{lang}
{code}
```"""

PAIR_SCHEMA = {
    "type": "object",
    "properties": {
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"question": {"type": "string"}, "answer": {"type": "string"}},
                "required": ["question", "answer"],
            },
        }
    },
    "required": ["pairs"],
}

# Hand-written behaviour samples: identity and the local-only policy.
IDENTITY = [
    ("Who are you?", "I am NETRUNNER, a local AI coding assistant. I run entirely on this workstation through a local runtime (llama.cpp); your code and conversations are not sent to any cloud AI service."),
    ("Are you running in the cloud?", "No. All inference runs locally on this machine through llama.cpp. NETRUNNER prohibits remote inference endpoints in every network mode."),
    ("Can you send my code to GPT-4 for a second opinion?", "No. NETRUNNER never sends source code or conversations to hosted AI services. I can review the code myself locally, or you can load another local model in the Model Vault and ask it."),
    ("What network modes does NETRUNNER have?", "Three: STRICT OFFLINE (only the loopback runtime, downloads refused), LOCAL NETWORK (runtimes on private LAN addresses allowed) and ONLINE TOOLS (explicit internet tools such as model downloads). Inference stays local in all three."),
    ("Did the tests pass?", "I cannot know that unless the tests were actually run and their output is shown to me. I will not claim results I have not seen; run the test command and share the output."),
    ("Which model are you?", "I am a Qwen-based model fine-tuned locally with LoRA for the NETRUNNER workstation and served by llama.cpp on this machine."),
    ("Ты работаешь в облаке?", "Нет. Я работаю только локально на этом компьютере через llama.cpp; код и переписка никуда не отправляются."),
    ("Тесты прошли?", "Я не могу этого знать, пока тесты не запущены и их вывод мне не показан. Запустите команду тестов и пришлите вывод — тогда разберём результат."),
]

STOP = set("a an and are as at be by does do for from how i in into is it of on or the this that to what when where which who why with "
           "file function code project netrunner".split())


def collect_files(root: Path) -> list[Path]:
    files = []
    for p in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts[:-1]):
            continue
        if p.is_file() and p.suffix.lower() in SOURCE_EXT and p.name not in SKIP_FILES and p.stat().st_size <= MAX_FILE_BYTES:
            files.append(p)
    return files


def memory_chunks(text: str) -> list[tuple[int, int, str]]:
    """(startLine, endLine, content) windows exactly like memory.ts chunkText."""
    lines = re.split(r"\r?\n", text)
    out, start = [], 0
    while start < len(lines):
        end = min(len(lines), start + CHUNK_LINES)
        content = "\n".join(lines[start:end])
        if content.strip():
            out.append((start + 1, end, content))
        if end == len(lines):
            break
        start += CHUNK_LINES - OVERLAP
    return out


def words(text: str) -> list[str]:
    """Lower-case words with identifiers split (resolveInWorkspace -> resolve in workspace), like the memory word index."""
    out = []
    for raw in re.findall(r"[^\W_]+(?:_[^\W_]+)*", text):
        parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw).replace("_", " ").split()
        for w in {raw, *parts}:
            w = w.lower()
            if len(w) >= 3 and w not in STOP:
                out.append(w)
    return out


class Bm25:
    """Okapi BM25 over the chunks: the plausible neighbours a retriever would return for a question."""

    def __init__(self, docs: list[list[str]], k1: float = 1.2, b: float = 0.75):
        self.tf = [Counter(d) for d in docs]
        self.len = [len(d) or 1 for d in docs]
        self.avg = sum(self.len) / max(1, len(self.len))
        df = Counter(w for d in self.tf for w in d)
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}
        self.k1, self.b = k1, b

    def rank(self, query: list[str]) -> list[int]:
        q = set(query)
        scores = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for w in q:
                f = tf.get(w)
                if f:
                    s += self.idf[w] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
            if s > 0:
                scores.append((s, i))
        return [i for _, i in sorted(scores, reverse=True)]


def memory_prompt(hits: list[dict]) -> str:
    """The prefix NETRUNNER's chat puts before the question when MEMORY is on (chat-store.ts memoryContext)."""
    out = MEMORY_HEADER
    for h in hits:
        block = f"\n--- {h['path']} (lines {h['start']}-{h['end']})\n{h['content']}\n"
        if len(out) + len(block) > MEMORY_MAX_CHARS:
            break
        out += block
    return f"{out}\n---\n\n"


def sample(user: str, answer: str, meta: dict | None = None) -> dict:
    row = {"messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
        {"role": "assistant", "content": answer},
    ]}
    if meta:
        row["meta"] = meta
    return row


def is_russian(s: str) -> bool:
    return bool(re.search(r"[а-яА-ЯёЁ]", s))


def not_found_answer(question: str, hits: list[dict]) -> str:
    files = ", ".join(sorted({f"`{h['path']}`" for h in hits})[:4])
    if is_russian(question):
        return (f"В найденных фрагментах памяти проекта ({files}) ответа на этот вопрос нет, поэтому надёжно ответить я не могу. "
                "Откройте нужный файл или переформулируйте вопрос, чтобы поиск нашёл подходящий код.")
    return (f"The retrieved project-memory fragments ({files}) do not cover this, so I can't answer it reliably from them. "
            "Open the relevant file or rephrase the question so the search finds the right code.")


def grounded_context(gold: dict, question: str, corpus: list[dict], bm25: Bm25, allowed, rng: random.Random) -> list[dict]:
    """Gold chunk plus 2-5 word-similar chunks from the allowed set, in a random order the way a retriever ranks them."""
    want = rng.choice([3, 4, 5, 6])
    others = [corpus[i] for i in bm25.rank(words(question)) if allowed(corpus[i]) and corpus[i] is not gold][: want - 1]
    hits = others[:]
    hits.insert(rng.randint(0, min(2, len(hits))), gold)
    if f"--- {gold['path']} (lines {gold['start']}-{gold['end']})" not in memory_prompt(hits):
        hits.remove(gold)
        hits.insert(0, gold)  # never train an answer whose source was cut by the length budget
    return hits


def unrelated_context(gold: dict, question: str, corpus: list[dict], bm25: Bm25, allowed, rng: random.Random) -> list[dict]:
    """Chunks of other files that do not match the question's words (a retrieval miss)."""
    related = set(bm25.rank(words(question))[:30])
    pool = [c for i, c in enumerate(corpus) if i not in related and allowed(c) and c["path"] != gold["path"]]
    return rng.sample(pool, min(len(pool), rng.choice([3, 4, 5])))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--teacher", default="Qwen3-Coder-Next", help="GGUF in the models folder (path or name fragment)")
    ap.add_argument("--pairs", type=int, default=4, help="pairs per chunk")
    ap.add_argument("--heldout-fraction", type=float, default=0.15, help="share of FILES kept out of training for eval")
    ap.add_argument("--parallel", type=int, default=2, help="teacher requests at once")
    ap.add_argument("--max-chunks", type=int, default=0, help="0 = all")
    args = ap.parse_args()

    root = Path(args.workspace).resolve()
    out = run_dir(args.run)
    cache_path = out / "teacher_cache.jsonl"
    cache: dict[str, list[dict]] = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            cache[row["key"]] = row["pairs"]

    corpus: list[dict] = []
    for f in collect_files(root):
        rel = f.relative_to(root).as_posix()
        for start, end, content in memory_chunks(f.read_text(encoding="utf-8", errors="replace")):
            corpus.append({"path": rel, "start": start, "end": end, "content": content})
    paths = sorted({c["path"] for c in corpus})
    heldout = {p for p in paths if int(hashlib.sha256(p.encode()).hexdigest()[:8], 16) % 1000 < args.heldout_fraction * 1000}
    if not heldout and len(paths) > 1:
        heldout = {paths[-1]}
    bm25 = Bm25([words(f"{c['path']}\n{c['content']}") for c in corpus])

    work = [c for c in corpus if len(c["content"].strip()) > 200]
    if args.max_chunks:
        work = work[: args.max_chunks]
    print(f"[forge] {len(corpus)} memory chunks, {len(work)} for the teacher, {len(heldout)}/{len(paths)} files held out", flush=True)

    teacher_path = find_model(args.teacher)
    stats = {"chunks": len(work), "teacher_calls": 0, "teacher_seconds": 0.0, "teacher_tokens": 0, "failed": 0}
    pairs_by_chunk: dict[int, list[dict]] = {}
    lock = threading.Lock()
    done = [0]

    with cache_path.open("a", encoding="utf-8") as cache_file, LlamaServer(teacher_path, ctx=16384, parallel=args.parallel) as teacher:
        def generate(n: int, chunk: dict) -> None:
            rel, code = chunk["path"], chunk["content"]
            key = hashlib.sha256(f"v3|{teacher_path.name}|{args.pairs}|{rel}|{chunk['start']}|{code}".encode()).hexdigest()
            pairs = cache.get(key)
            if pairs is None:
                prompt = TEACHER_INSTRUCTIONS.format(path=rel, project=root.name, n=args.pairs, start=chunk["start"], end=chunk["end"],
                                                     lang=Path(rel).suffix.lstrip("."), code=code)
                t0 = time.time()
                try:
                    res = teacher.chat([{"role": "user", "content": prompt}], think=None, fmt=PAIR_SCHEMA, temperature=0.4)
                    pairs = json.loads(res["content"])["pairs"]
                except SystemExit:
                    raise
                except json.JSONDecodeError as e:  # the teacher looped to the token limit; it does so again, so remember it
                    with lock:
                        stats["failed"] += 1
                        cache_file.write(json.dumps({"key": key, "pairs": []}) + "\n")
                        cache_file.flush()
                    print(f"[forge] {rel}:{chunk['start']} FAILED: {e}", file=sys.stderr, flush=True)
                    return
                except Exception as e:  # noqa: BLE001 - one bad chunk must not stop the run
                    with lock:
                        stats["failed"] += 1
                    print(f"[forge] {rel}:{chunk['start']} FAILED: {e}", file=sys.stderr, flush=True)
                    return
                with lock:
                    stats["teacher_calls"] += 1
                    stats["teacher_seconds"] += time.time() - t0
                    stats["teacher_tokens"] += res["timings"].get("predicted_n", 0)
                    cache_file.write(json.dumps({"key": key, "pairs": pairs}, ensure_ascii=False) + "\n")
                    cache_file.flush()
            good = [{"question": p["question"].strip(), "answer": p["answer"].strip()} for p in pairs
                    if len(p.get("question", "")) > 10 and len(p.get("answer", "")) > 20]
            if len(good) > args.pairs:  # the teacher sometimes writes dozens; keep the chunk's weight, and the last (Russian) pair
                good = good[: args.pairs - 1] + good[-1:]
            with lock:
                pairs_by_chunk[n] = good
                done[0] += 1
                print(f"[forge] {done[0]}/{len(work)} {rel}:{chunk['start']}-{chunk['end']}: {len(good)} pairs", flush=True)

        with ThreadPoolExecutor(max_workers=args.parallel) as pool:
            for f in [pool.submit(generate, n, c) for n, c in enumerate(work)]:
                f.result()

    rng = random.Random(1337)
    train_ok = lambda c: c["path"] not in heldout  # noqa: E731 - held-out files never reach training, even as distractors
    any_ok = lambda c: True  # noqa: E731
    train, evals = [], []
    for n, chunk in enumerate(work):
        pairs = pairs_by_chunk.get(n, [])
        if chunk["path"] in heldout:
            # One question per held-out chunk keeps the eval spread over the code instead of over a few long chunks.
            if pairs:
                p = rng.choice(pairs)
                kind = "not_found" if rng.random() < 0.12 else "grounded"
                ctx = (unrelated_context if kind == "not_found" else grounded_context)(chunk, p["question"], corpus, bm25, any_ok, rng)
                answer = not_found_answer(p["question"], ctx) if kind == "not_found" else p["answer"]
                evals.append(sample(memory_prompt(ctx) + p["question"], answer,
                                    {"path": chunk["path"], "kind": kind, "lang": "ru" if is_russian(p["question"]) else "en"}))
            continue
        for p in pairs:
            if rng.random() < NOT_FOUND_FRACTION:
                ctx = unrelated_context(chunk, p["question"], corpus, bm25, train_ok, rng)
                train.append(sample(memory_prompt(ctx) + p["question"], not_found_answer(p["question"], ctx)))
            else:
                ctx = grounded_context(chunk, p["question"], corpus, bm25, train_ok, rng)
                train.append(sample(memory_prompt(ctx) + p["question"], p["answer"]))
    identity = [sample(q, a) for q, a in IDENTITY]
    train.extend(identity * 3)  # repeated: tiny but important behaviour set
    rng.shuffle(train)
    if not evals:
        raise SystemExit("[forge] no eval questions: the held-out files produced no pairs (use a larger workspace or --heldout-fraction)")

    write_jsonl(out / "train.jsonl", train)
    write_jsonl(out / "eval.jsonl", evals)
    stats.update({
        "train_samples": len(train),
        "eval_samples": len(evals),
        "eval_not_found": sum(r["meta"]["kind"] == "not_found" for r in evals),
        "eval_russian": sum(r["meta"]["lang"] == "ru" for r in evals),
        "heldout_files": sorted(heldout),
        "workspace": str(root),
        "teacher": teacher_path.name,
    })
    (out / "dataset_stats.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in stats.items() if k != "heldout_files"}, indent=2))


if __name__ == "__main__":
    main()
