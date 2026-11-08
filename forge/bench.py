"""Step 5: standard benchmarks for the base and the fine-tuned model, so project training cannot hide a general loss.

Fixed subsets of three public test sets (downloaded once by setup_env.py at pinned commits), scored objectively:
  MMLU      — multiple choice, the answer letter is constrained by a JSON schema; accuracy.
  GSM8K     — grade-school math word problems; the final number must equal the reference; accuracy.
  HumanEval — Python functions; the generated code runs against the official tests; pass@1.
HumanEval executes model-written code: each program runs in its own `python -I` process in an empty temporary
folder with a minimal environment and a timeout, and the folder is deleted afterwards.

Usage:
  python bench.py --run netrunner-v3 --models qwen3.5-4b-base netrunner-netrunner-v3 [--mmlu 285 --gsm8k 150 --humaneval 164]
  python bench.py --run topk-8 --models Coder-Next-Q4_K_M-00001 --extra="--override-kv qwen3next.expert_used_count=int:8"
    (--extra: llama-server options for every model, e.g. NSC stage 6's approximate modes)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import FORGE_HOME, LlamaServer, find_model, run_dir

BENCH_DIR = FORGE_HOME / "bench"
PARALLEL = 4
LETTERS = ["A", "B", "C", "D"]
# One bare letter. A JSON schema let small models pad with whitespace until max_tokens cut the object, which then
# scored as a wrong answer: the benchmark measured formatting instead of knowledge.
LETTER_GRAMMAR = 'root ::= [ABCD]'


def load(name: str) -> list[dict]:
    import pyarrow.parquet as pq  # in the training venv (a dependency of datasets)

    f = BENCH_DIR / f"{name}.parquet"
    if not f.exists():
        raise SystemExit(f"{f} missing: run FORGE → SETUP (setup_env.py downloads the benchmark data)")
    return pq.read_table(f).to_pylist()


def pick(rows: list[dict], n: int, seed: int = 1337) -> list[dict]:
    if n <= 0 or n >= len(rows):
        return rows
    return random.Random(seed).sample(rows, n)


def mmlu_items(n: int) -> list[dict]:
    rows = load("mmlu")
    by_subject: dict[str, list[dict]] = {}
    for r in rows:
        by_subject.setdefault(r["subject"], []).append(r)
    # The same number of questions from every subject, so no field dominates the score.
    per = max(1, n // len(by_subject))
    return [r for s in sorted(by_subject) for r in pick(by_subject[s], per)]


def mmlu_run(srv: LlamaServer, r: dict) -> dict:
    subject = r["subject"].replace("_", " ")
    options = "\n".join(f"{L}. {c}" for L, c in zip(LETTERS, r["choices"]))
    prompt = f"The following is a multiple choice question about {subject}.\n\n{r['question']}\n{options}\n\nAnswer with the letter of the correct option."
    got = srv.chat([{"role": "user", "content": prompt}], think=False, grammar=LETTER_GRAMMAR, temperature=0, max_tokens=4)["content"].strip()
    return {"subject": r["subject"], "expected": LETTERS[r["answer"]], "got": got, "ok": got == LETTERS[r["answer"]]}


def number(s: str) -> str | None:
    s = s.replace(",", "").replace("$", "")
    m = re.findall(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    v = float(m[-1])
    return str(int(v)) if v == int(v) else str(v)


def gsm8k_run(srv: LlamaServer, r: dict) -> dict:
    prompt = f"{r['question']}\n\nSolve it step by step, then write the final result on the last line as: Answer: <number>"
    text = srv.chat([{"role": "user", "content": prompt}], think=False, temperature=0, max_tokens=1024)["content"]
    tail = text.rsplit("Answer:", 1)[-1] if "Answer:" in text else text[-200:]
    expected = number(r["answer"].split("####")[-1])
    got = number(tail)
    return {"expected": expected, "got": got, "ok": got is not None and got == expected, "output": text[-400:]}


def extract_code(text: str) -> str:
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return max(blocks, key=len) if blocks else text


def run_program(program: str, timeout: float = 15) -> tuple[bool, str]:
    """One program, its own process and empty folder; nothing inherited but what Python needs to start."""
    env = {k: os.environ[k] for k in ("SYSTEMROOT", "TEMP", "TMP", "PATH") if k in os.environ}
    with tempfile.TemporaryDirectory(prefix="forge-humaneval-") as d:
        f = Path(d) / "prog.py"
        f.write_text(program, encoding="utf-8")
        try:
            p = subprocess.run([sys.executable, "-I", str(f)], cwd=d, env=env, capture_output=True, text=True, timeout=timeout,
                               stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            return False, "timeout"
        return p.returncode == 0, (p.stderr or p.stdout)[-300:]


def humaneval_run(srv: LlamaServer, r: dict) -> dict:
    prompt = (f"Complete this Python function. Reply with the complete function (signature included) in one ```python block.\n\n"
              f"```python\n{r['prompt']}```")
    text = srv.chat([{"role": "user", "content": prompt}], think=False, temperature=0, max_tokens=1024)["content"]
    code = extract_code(text)
    if f"def {r['entry_point']}" not in code:
        code = r["prompt"] + code  # a body without the signature
    header = "\n".join(line for line in r["prompt"].splitlines() if re.match(r"(from|import)\s", line))
    ok, err = run_program(f"{header}\n{code}\n\n{r['test']}\n\ncheck({r['entry_point']})\n")
    return {"task": r["task_id"], "ok": ok, "output": "" if ok else err}  # a failing test is a wrong answer, not an unreadable one


def bench_model(query: str, suites: dict[str, tuple[list[dict], callable]], extra: list[str] | None = None) -> dict:
    path = find_model(query)
    result: dict = {"model": path.name, "extra": extra or []}
    with LlamaServer(path, ctx=4096, parallel=PARALLEL, extra=extra) as srv:
        for name, (items, fn) in suites.items():
            t0 = time.time()

            def one(r: dict) -> dict:
                try:
                    return fn(srv, r)
                except SystemExit:
                    raise
                except Exception as e:  # noqa: BLE001 - an unparseable answer scores 0, it does not stop the run
                    return {"ok": False, "error": f"{type(e).__name__}: {e}"}

            with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
                rows = list(pool.map(one, items))
            score = sum(r["ok"] for r in rows) / len(rows)
            errors = sum("error" in r for r in rows)
            result[name] = {"score": score, "n": len(rows), "errors": errors, "seconds": time.time() - t0, "items": rows}
            print(f"[bench] {path.name} {name}: {score * 100:.1f}% of {len(rows)} in {time.time() - t0:.0f} s", flush=True)
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--models", nargs="+", required=True, help="GGUF name fragments: base first, then the fine-tuned model")
    ap.add_argument("--mmlu", type=int, default=285, help="questions (spread evenly over the 57 subjects)")
    ap.add_argument("--gsm8k", type=int, default=150)
    ap.add_argument("--humaneval", type=int, default=164, help="164 = all")
    ap.add_argument("--extra", default="", help="llama-server options for every model (space-separated)")
    args = ap.parse_args()

    suites = {}
    if args.mmlu:
        suites["mmlu"] = (mmlu_items(args.mmlu), mmlu_run)
    if args.gsm8k:
        suites["gsm8k"] = (pick(load("gsm8k"), args.gsm8k), gsm8k_run)
    if args.humaneval:
        suites["humaneval"] = (pick(load("humaneval"), args.humaneval), humaneval_run)
    models = [bench_model(m, suites, args.extra.split()) for m in args.models]

    summary = {"models": [m["model"] for m in models]}
    for name in suites:
        summary[name] = {m["model"]: round(m[name]["score"] * 100, 1) for m in models}
        summary[f"{name}_n"] = models[0][name]["n"]
        summary[f"{name}_errors"] = {m["model"]: m[name]["errors"] for m in models}  # answers that could not be read, scored 0
    out = run_dir(args.run)
    (out / "bench_report.json").write_text(json.dumps({"summary": summary, "models": models}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
