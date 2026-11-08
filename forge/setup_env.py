"""Install the FORGE environment (about 15 GB) under %USERPROFILE%\\NETRUNNER\\forge. Needs internet once.

Run with any Python 3.13 (standard library only); NETRUNNER starts it from FORGE → SETUP in ONLINE TOOLS mode.
Steps, each skipped when already done:
  1. venv          — training environment from requirements-train.lock.txt (PyTorch CUDA 13 wheels)
  2. convert-venv  — converter environment from requirements-convert.lock.txt (CPU PyTorch)
  3. llama.cpp     — source of the pinned llama.cpp tag (convert_hf_to_gguf.py, gguf-py)
  4. llama-bin     — llama-quantize from the official CPU release of the same tag
  5. bench         — test splits of MMLU, GSM8K and HumanEval (about 4 MB, pinned commits) for bench.py

Usage:
  python setup_env.py [--tag b12018]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORGE_HOME = Path(os.environ.get("NETRUNNER_FORGE_HOME") or Path.home() / "NETRUNNER" / "forge")


def log(msg: str) -> None:
    print(f"[setup] {msg}", flush=True)


def run(cmd: list[str]) -> None:
    log(" ".join(cmd))
    subprocess.run(cmd, check=True)


def venv(name: str, lock: str, index: str) -> None:
    target = FORGE_HOME / name
    py = target / "Scripts" / "python.exe"
    if py.exists():
        log(f"{name}: present, skipped")
        return
    run([sys.executable, "-m", "venv", str(target)])
    run([str(py), "-m", "pip", "install", "--upgrade", "pip"])
    run([str(py), "-m", "pip", "install", "-r", str(HERE / lock), "--extra-index-url", index])


def download(url: str) -> bytes:
    log(f"download {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "NETRUNNER-FORGE"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def converter(tag: str) -> None:
    target = FORGE_HOME / "llama.cpp"
    if (target / "convert_hf_to_gguf.py").exists():
        log("llama.cpp converter: present, skipped")
        return
    data = download(f"https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/{tag}")
    staging = FORGE_HOME / "llama.cpp.partial"
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(staging)
    inner = next(staging.iterdir())  # llama.cpp-<tag>/
    shutil.move(str(inner), str(target))
    shutil.rmtree(staging, ignore_errors=True)


def quantizer(tag: str) -> None:
    target = FORGE_HOME / "llama-bin"
    if (target / "llama-quantize.exe").exists():
        log("llama-quantize: present, skipped")
        return
    data = download(f"https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-win-cpu-x64.zip")
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(target)


# Hugging Face dataset files at fixed commits, so every benchmark run scores the same questions.
BENCH_FILES = {
    "mmlu.parquet": "https://huggingface.co/datasets/cais/mmlu/resolve/c30699e8356da336a370243923dbaf21066bb9fe/all/test-00000-of-00001.parquet",
    "gsm8k.parquet": "https://huggingface.co/datasets/openai/gsm8k/resolve/740312add88f781978c0658806c59bc2815b9866/main/test-00000-of-00001.parquet",
    "humaneval.parquet": "https://huggingface.co/datasets/openai/openai_humaneval/resolve/7dce6050a7d6d172f3cc5c32aa97f52fa1a2e544/openai_humaneval/test-00000-of-00001.parquet",
}


def bench_data() -> None:
    target = FORGE_HOME / "bench"
    target.mkdir(parents=True, exist_ok=True)
    manifest = target / "manifest.json"
    known = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
    for name, url in BENCH_FILES.items():
        f = target / name
        if f.exists() and known.get(name, {}).get("url") == url:
            log(f"bench {name}: present, skipped")
            continue
        data = download(url)
        f.write_bytes(data)
        known[name] = {"url": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    manifest.write_text(json.dumps(known, indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="b12018", help="llama.cpp tag for the converter and llama-quantize")
    args = ap.parse_args()
    if sys.version_info[:2] != (3, 13):
        sys.exit(f"[setup] Python 3.13 is required (this is {sys.version.split()[0]})")
    FORGE_HOME.mkdir(parents=True, exist_ok=True)
    venv("venv", "requirements-train.lock.txt", "https://download.pytorch.org/whl/cu130")
    venv("convert-venv", "requirements-convert.lock.txt", "https://download.pytorch.org/whl/cpu")
    converter(args.tag)
    quantizer(args.tag)
    bench_data()
    log(f"FORGE environment ready in {FORGE_HOME}")


if __name__ == "__main__":
    main()
