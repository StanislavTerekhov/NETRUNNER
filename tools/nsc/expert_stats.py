"""NSC stage 0: how concentrated is the expert routing of a MoE model on our work?

Reads the per-expert token counts that llama-imatrix stores for MoE tensors (<name>.counts) and the expert tensor sizes
from the model, then reports per layer: experts, top-k routing, how many experts cover 50 / 80 % of the routed tokens,
and what share of all expert work a VRAM budget would cover if it held the most used experts.

  python expert_stats.py <imatrix.gguf> <model-00001.gguf> <out.json>
"""
import glob
import json
import re
import sys

import numpy as np
from gguf import GGUFReader


def expert_counts(imatrix_path):
    counts = {}
    for t in GGUFReader(imatrix_path).tensors:
        m = re.match(r"blk\.(\d+)\.ffn_(gate|up|down)_exps\.weight\.counts$", t.name)
        if m and m.group(2) == "down":  # gate/up/down see the same routing; one is enough
            counts[int(m.group(1))] = np.asarray(t.data, dtype=np.float64).reshape(-1)
    return counts


def expert_bytes(model_first_shard):
    """Bytes of one expert (gate + up + down) per layer, over every shard of the model."""
    per_layer = {}
    n_expert = None
    for f in sorted(glob.glob(model_first_shard.replace("00001-of", "*-of"))):
        r = GGUFReader(f)
        for k, v in r.fields.items():
            if k.endswith(".expert_count"):
                n_expert = int(v.parts[v.data[0]][0])
        for t in r.tensors:
            m = re.match(r"blk\.(\d+)\.ffn_(gate|up|down)_exps\.weight$", t.name)
            if m:
                per_layer[int(m.group(1))] = per_layer.get(int(m.group(1)), 0) + int(t.n_bytes)
    return {layer: b / n_expert for layer, b in per_layer.items()}, n_expert


def cross(pick_path, eval_path, model):
    """Hot experts chosen on one corpus, coverage measured on another: does a hot set chosen ahead of time hold?"""
    pick, ev = expert_counts(pick_path), expert_counts(eval_path)
    sizes, n_expert = expert_bytes(model)
    ranked = sorted(((pick[l][e], l, e) for l in pick for e in range(len(pick[l]))), key=lambda x: -x[0])
    work = sum(float(ev[l].sum()) for l in ev)
    out = {}
    for gib in (0.5, 1, 2, 4, 6):
        used = covered = 0.0
        for _, l, e in ranked:
            if used + sizes[l] > gib * 2**30:
                break
            used += sizes[l]
            covered += float(ev[l][e])
        out[f"{gib}GiB"] = round(covered / work, 3)
    return out


def main():
    if sys.argv[1] == "--cross":
        a, b, model = sys.argv[2:5]
        print(json.dumps({"pick_on_A_cover_B": cross(a, b, model), "pick_on_B_cover_A": cross(b, a, model), "pick_on_B_cover_B": cross(b, b, model), "pick_on_A_cover_A": cross(a, a, model)}, indent=1))
        return
    imatrix, model, out = sys.argv[1:4]
    counts = expert_counts(imatrix)
    sizes, n_expert = expert_bytes(model)
    layers = sorted(counts)
    report = {"n_expert": n_expert, "layers": {}}
    all_items = []  # (tokens routed to this expert, bytes) over the whole model
    for layer in layers:
        c = counts[layer]
        total = c.sum()
        order = np.sort(c)[::-1]
        cum = np.cumsum(order) / total
        p = c / total
        entropy = float(-(p[p > 0] * np.log2(p[p > 0])).sum())
        report["layers"][layer] = {
            "tokens_routed": float(total),
            "experts_for_50pct": int(np.searchsorted(cum, 0.5) + 1),
            "experts_for_80pct": int(np.searchsorted(cum, 0.8) + 1),
            "never_used": int((c == 0).sum()),
            # 1.0 = perfectly even routing over all experts.
            "evenness": round(entropy / np.log2(len(c)), 3),
        }
        all_items += [(float(x), sizes[layer]) for x in c]
    # Most-used experts first: what share of expert work fits a VRAM budget.
    all_items.sort(key=lambda x: -x[0])
    work = sum(x for x, _ in all_items)
    budget = {}
    for gib in (0.5, 1, 2, 4, 6):
        used = covered = 0.0
        for x, b in all_items:
            if used + b > gib * 2**30:
                break
            used += b
            covered += x
        budget[f"{gib}GiB"] = round(covered / work, 3)
    expert_mb = np.mean(list(sizes.values())) / 2**20
    report["summary"] = {
        "layers": len(layers),
        "expert_size_mib": round(float(expert_mb), 2),
        "all_experts_gib": round(sum(sizes.values()) * n_expert / 2**30, 2),
        "mean_experts_for_50pct": round(float(np.mean([v["experts_for_50pct"] for v in report["layers"].values()])), 1),
        "mean_experts_for_80pct": round(float(np.mean([v["experts_for_80pct"] for v in report["layers"].values()])), 1),
        "mean_evenness": round(float(np.mean([v["evenness"] for v in report["layers"].values()])), 3),
        # Share of expert work served from VRAM if the hottest experts of the whole model were pinned there.
        "work_covered_by_vram_budget": budget,
        # For comparison: the same budget filled with experts at random.
        "work_covered_if_random": {k: round(gib * 2**30 / (sum(sizes.values()) * n_expert), 3) for k, gib in zip(budget, (0.5, 1, 2, 4, 6))},
    }
    json.dump(report, open(out, "w"), indent=1)
    print(json.dumps(report["summary"], indent=1))


if __name__ == "__main__":
    main()
