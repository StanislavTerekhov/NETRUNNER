"""Download the GGUF models NETRUNNER runs with llama.cpp into %USERPROFILE%\\NETRUNNER\\models.

Needs internet once. Files land in models/<owner>/<repo>/..., keeping the repo layout (split GGUFs stay together).
Usage: python download_models.py [--only embedding|general|coder]
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from huggingface_hub import snapshot_download  # noqa: E402

MODELS_DIR = Path(os.environ.get("NETRUNNER_MODELS_DIR", Path.home() / "NETRUNNER" / "models"))

CATALOG = {
    "embedding": ("Qwen/Qwen3-Embedding-0.6B-GGUF", ["*Q8_0*.gguf"]),
    "general": ("unsloth/Qwen3.8-27B-GGUF", ["*UD-Q4_K_M*.gguf", "mmproj-F16.gguf"]),
    "coder": ("Qwen/Qwen3-Coder-Next-GGUF", ["*-Q4_K_M-*.gguf"]),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=list(CATALOG))
    args = ap.parse_args()
    for key, (repo, patterns) in CATALOG.items():
        if args.only and key != args.only:
            continue
        target = MODELS_DIR / repo
        t0 = time.time()
        print(f"[download] {key}: {repo} {patterns} -> {target}", flush=True)
        snapshot_download(repo_id=repo, allow_patterns=patterns, local_dir=str(target))
        files = sorted(p for p in target.rglob("*.gguf"))
        total = sum(p.stat().st_size for p in files)
        print(f"[download] {key}: {len(files)} file(s), {total / 1e9:.1f} GB in {time.time() - t0:.0f} s", flush=True)
        for p in files:
            print(f"    {p.relative_to(MODELS_DIR)}  {p.stat().st_size / 1e9:.2f} GB", flush=True)


if __name__ == "__main__":
    main()
