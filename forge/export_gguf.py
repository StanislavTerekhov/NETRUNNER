"""Step 3: convert a Hugging Face model folder to a quantised GGUF and place it in the NETRUNNER models folder.

`--source merged` exports the fine-tuned model of a run; `--source base --base <repo>` exports the untouched base
model through the *same* converter and quantiser, so the before/after comparison differs only in the weights.
Vision checkpoints (Qwen3.5) also get their projector (mmproj, f16): the model and its mmproj go into their own
folder models/netrunner/<name>/, where NETRUNNER pairs them, so the exported model can see images.

Usage:
  python export_gguf.py --run netrunner-v2 --name netrunner-qwen3.5-4b                 # fine-tuned
  python export_gguf.py --run netrunner-v2 --name qwen3.5-4b-base --source base --base unsloth/Qwen3.5-4B
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

from common import FORGE_HOME, MODELS_DIR, run_dir

os.environ.setdefault("HF_HOME", str(FORGE_HOME / "hf"))
os.environ["HF_HUB_OFFLINE"] = "1"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--name", required=True, help="folder and file name stem in models/netrunner/")
    ap.add_argument("--source", choices=["merged", "base"], default="merged")
    ap.add_argument("--base", default="unsloth/Qwen3.5-4B")
    ap.add_argument("--quantize", default="Q4_K_M")
    args = ap.parse_args()

    out = run_dir(args.run)
    if args.source == "merged":
        src = out / "merged_16bit"
    else:
        from huggingface_hub import snapshot_download
        src = Path(snapshot_download(args.base, local_files_only=True))
    if not (src / "config.json").exists():
        raise SystemExit(f"No Hugging Face model at {src}")

    converter = FORGE_HOME / "llama.cpp" / "convert_hf_to_gguf.py"
    convert_py = FORGE_HOME / "convert-venv" / "Scripts" / "python.exe"
    quantize = FORGE_HOME / "llama-bin" / "llama-quantize.exe"
    for p in (converter, convert_py, quantize):
        if not p.exists():
            raise SystemExit(f"Missing {p}; see forge/README.md")

    f16 = out / f"{args.name}-f16.gguf"
    if not f16.exists():
        print(f"[forge] converting {src} -> {f16.name}", flush=True)
        subprocess.run([str(convert_py), str(converter), str(src), "--outfile", str(f16), "--outtype", "f16"], check=True)
    quantized = out / f"{args.name}-{args.quantize}.gguf"
    if not quantized.exists():
        print(f"[forge] quantizing to {args.quantize}", flush=True)
        subprocess.run([str(quantize), str(f16), str(quantized), args.quantize, str(os.cpu_count() or 4)], check=True)

    mmproj = None
    if "vision_config" in json.loads((src / "config.json").read_text(encoding="utf-8")):
        mmproj = out / f"mmproj-{args.name}-f16.gguf"
        if not mmproj.exists():
            print(f"[forge] converting the vision projector -> {mmproj.name}", flush=True)
            subprocess.run([str(convert_py), str(converter), str(src), "--mmproj", "--outfile", str(mmproj), "--outtype", "f16"], check=True)

    folder = MODELS_DIR / "netrunner" / args.name
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / quantized.name
    shutil.copy2(quantized, target)
    if mmproj:
        shutil.copy2(mmproj, folder / mmproj.name)
    legacy = MODELS_DIR / "netrunner" / quantized.name  # FORGE before 1.4 exported without a folder
    if legacy.is_file():
        legacy.unlink()
        print(f"[forge] removed the earlier export {legacy.name} (replaced by {args.name}/)", flush=True)
    rel = target.relative_to(MODELS_DIR).as_posix()
    if args.source == "merged":
        (out / "exported_model.txt").write_text(rel, encoding="utf-8")
    vision = f" + {mmproj.name}" if mmproj else ""
    print(f"[forge] {rel}{vision} ({target.stat().st_size / 1e9:.2f} GB) is now in the NETRUNNER models folder", flush=True)


if __name__ == "__main__":
    main()
