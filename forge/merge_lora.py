"""Step 2b: merge the LoRA adapter into the full-precision base weights, fully offline.

Uses plain transformers + peft on CPU (needs ~20 GB RAM for an 8B model). The base is resolved from the
local Hugging Face cache only; no network request is made.

transformers does not load Qwen3.5's multi-token-prediction head (`mtp.*`), so a plain save drops it and the GGUF
loses MTP speculative decoding. The head is copied unchanged from the base checkpoint into the merged folder.

Usage:
  python merge_lora.py --run netrunner-v2 [--base unsloth/Qwen3.5-4B]
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from common import FORGE_HOME, run_dir

os.environ.setdefault("HF_HOME", str(FORGE_HOME / "hf"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import torch  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
from peft import PeftModel  # noqa: E402
from transformers import AutoConfig, AutoModelForCausalLM, AutoModelForImageTextToText, AutoTokenizer  # noqa: E402


def copy_mtp_head(base: Path, merged: Path) -> int:
    """Base `mtp.*` tensors → merged/mtp.safetensors, registered in the merged index. Returns the tensor count."""
    from safetensors import safe_open
    from safetensors.torch import save_file

    base_map = json.loads((base / "model.safetensors.index.json").read_text(encoding="utf-8"))["weight_map"]
    keys = [k for k in base_map if k.startswith("mtp.")]
    if not keys:
        return 0
    tensors = {}
    for shard in sorted({base_map[k] for k in keys}):
        with safe_open(str(base / shard), framework="pt") as f:
            for k in keys:
                if base_map[k] == shard:
                    tensors[k] = f.get_tensor(k)
    save_file(tensors, str(merged / "mtp.safetensors"), metadata={"format": "pt"})
    index_path = merged / "model.safetensors.index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index["weight_map"].update({k: "mtp.safetensors" for k in keys})
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    return len(keys)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--base", default="unsloth/Qwen3.5-4B", help="16-bit base the adapter was trained on (or its full-precision twin)")
    args = ap.parse_args()

    out = run_dir(args.run)
    adapter = out / "lora_adapter"
    merged = out / "merged_16bit"
    base_path = snapshot_download(args.base, local_files_only=True)
    print(f"[forge] base weights: {base_path}", flush=True)

    t0 = time.time()
    # Qwen3.5 is a vision-language checkpoint: the adapter was trained on the full model (keys under
    # model.language_model.*), so load the same class, or peft silently matches nothing.
    cls = AutoModelForImageTextToText if hasattr(AutoConfig.from_pretrained(base_path), "vision_config") else AutoModelForCausalLM
    model = cls.from_pretrained(base_path, dtype=torch.bfloat16, device_map="cpu", low_cpu_mem_usage=True)
    probe_name = next(n for n, _ in model.named_parameters() if n.endswith("mlp.down_proj.weight"))
    before = model.get_parameter(probe_name).detach().clone()
    model = PeftModel.from_pretrained(model, str(adapter))
    model = model.merge_and_unload()
    if torch.equal(before, model.get_parameter(probe_name)):
        raise SystemExit(f"[forge] adapter did not change {probe_name}: key mismatch between adapter and {cls.__name__}")
    model.save_pretrained(str(merged), safe_serialization=True, max_shard_size="4GB")
    AutoTokenizer.from_pretrained(str(adapter)).save_pretrained(str(merged))
    # Vision preprocessing files, so the converter can also write the mmproj from this folder.
    for name in ("preprocessor_config.json", "video_preprocessor_config.json", "processor_config.json", "chat_template.jinja"):
        if (Path(base_path) / name).exists() and not (merged / name).exists():
            (merged / name).write_bytes((Path(base_path) / name).read_bytes())
    n = copy_mtp_head(Path(base_path), merged)
    print(f"[forge] MTP head: {n} tensors copied from the base" if n else "[forge] base has no MTP head", flush=True)
    print(f"[forge] merged model written to {merged} in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
