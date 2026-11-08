"""Step 4: compare the base and the fine-tuned model on the held-out questions (llama.cpp).

The questions are about files that were held out of training; each comes with project-memory fragments exactly as
the chat sends them (some deliberately without the answer). Each model answers in turn (one llama-server at a time),
then a local judge model scores every answer 0-10 for factual agreement with the reference. Two objective numbers
need no model: token-overlap F1 and how often a grounded answer names the source file.

Usage:
  python evaluate.py --run netrunner-v2 --base qwen3.5-4b-base --tuned netrunner-qwen3.5-4b --judge Qwen3.8-27B
"""
from __future__ import annotations

import argparse
import json
import re
import statistics

from common import LlamaServer, find_model, read_jsonl, run_dir

JUDGE_PROMPT = """You grade answers about a software project against a reference answer.
Question: {q}
Reference answer: {ref}
Candidate answer: {cand}
Score 0-10 how well the candidate agrees with the reference on the facts (names, behaviour). 0 = wrong or
unrelated, 10 = same facts. Ignore style and length.
If the reference says the retrieved fragments do not contain the answer: 10 when the candidate also says it cannot
answer from them, 0 when it answers with specifics that the reference does not support.
Return JSON {{"score": <int>, "reason": "<short>"}}"""

SCORE_SCHEMA = {"type": "object", "properties": {"score": {"type": "integer"}, "reason": {"type": "string"}}, "required": ["score", "reason"]}


def tokens(s: str) -> list[str]:
    return re.findall(r"[a-zA-Z_][a-zA-Z0-9_]+|\d+", s.lower())


def f1(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    common = sum(min(ta.count(t), tb.count(t)) for t in set(ta))
    if common == 0:
        return 0.0
    p, r = common / len(ta), common / len(tb)
    return 2 * p * r / (p + r)


def question_of(user: str) -> str:
    """The question without the project-memory prefix."""
    return user.rsplit("\n---\n\n", 1)[-1]


def summarize(results: list[dict], label: str) -> dict:
    if not results:
        return {}
    grounded = [r for r in results if r["kind"] == "grounded"]
    return {
        "questions": len(results),
        f"{label}_judge_mean": statistics.mean(r[label]["judge"] for r in results),
        f"{label}_f1_mean": statistics.mean(r[label]["f1"] for r in results),
        f"{label}_cites_file": (sum(r[label]["cites_file"] for r in grounded) / len(grounded)) if grounded else None,
    }


def answer_all(model_query: str, rows: list[dict]) -> tuple[str, list[str]]:
    path = find_model(model_query)
    answers = []
    with LlamaServer(path, ctx=8192) as srv:
        for i, row in enumerate(rows, 1):
            system, user, _ = (m["content"] for m in row["messages"])
            res = srv.chat([{"role": "system", "content": system}, {"role": "user", "content": user}], think=False, temperature=0, max_tokens=600)
            answers.append(res["content"].strip())
            print(f"[forge] {path.name} {i}/{len(rows)}", flush=True)
    return path.name, answers


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--base", required=True, help="GGUF name fragment of the untouched base")
    ap.add_argument("--tuned", required=True, help="GGUF name fragment of the fine-tuned model")
    ap.add_argument("--judge", default="Qwen3.8-27B")
    args = ap.parse_args()

    out = run_dir(args.run)
    rows = read_jsonl(out / "eval.jsonl")
    base_name, base_answers = answer_all(args.base, rows)
    tuned_name, tuned_answers = answer_all(args.tuned, rows)

    judge_path = find_model(args.judge)
    results = []
    with LlamaServer(judge_path, ctx=8192) as judge:
        for i, row in enumerate(rows):
            _, user, ref = (m["content"] for m in row["messages"])
            meta = row.get("meta", {})
            q = question_of(user)
            source = meta.get("path", "").rsplit("/", 1)[-1]
            entry = {"question": q, "reference": ref, "kind": meta.get("kind", "grounded"), "lang": meta.get("lang", "en"), "path": meta.get("path")}
            for label, ans in (("base", base_answers[i]), ("tuned", tuned_answers[i])):
                verdict = json.loads(judge.chat([{"role": "user", "content": JUDGE_PROMPT.format(q=q, ref=ref, cand=ans)}],
                                                think=False, fmt=SCORE_SCHEMA, temperature=0, max_tokens=200)["content"])
                entry[label] = {"answer": ans, "judge": max(0, min(10, int(verdict["score"]))), "reason": verdict["reason"], "f1": f1(ans, ref),
                                "cites_file": bool(source) and source in ans}
            results.append(entry)
            print(f"[forge] {i + 1}/{len(rows)} base={entry['base']['judge']} tuned={entry['tuned']['judge']} :: {q[:70]}", flush=True)

    summary = {
        "base_model": base_name,
        "tuned_model": tuned_name,
        "judge_model": judge_path.name,
        "questions": len(results),
        "base_judge_mean": statistics.mean(r["base"]["judge"] for r in results),
        "tuned_judge_mean": statistics.mean(r["tuned"]["judge"] for r in results),
        "base_f1_mean": statistics.mean(r["base"]["f1"] for r in results),
        "tuned_f1_mean": statistics.mean(r["tuned"]["f1"] for r in results),
        "tuned_wins": sum(r["tuned"]["judge"] > r["base"]["judge"] for r in results),
        "ties": sum(r["tuned"]["judge"] == r["base"]["judge"] for r in results),
        "base_wins": sum(r["tuned"]["judge"] < r["base"]["judge"] for r in results),
        "heldout_files": len({r["path"] for r in results if r["path"]}),
    }
    for name, subset in (("grounded", [r for r in results if r["kind"] == "grounded"]), ("not_found", [r for r in results if r["kind"] == "not_found"]),
                         ("russian", [r for r in results if r["lang"] == "ru"])):
        if subset:
            summary[name] = {**summarize(subset, "base"), **summarize(subset, "tuned")}
    (out / "eval_report.json").write_text(json.dumps({"summary": summary, "results": results}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
