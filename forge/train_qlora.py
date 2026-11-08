"""Step 2: LoRA fine-tune of a small Qwen model on the FORGE dataset (Unsloth, single consumer GPU).

Default base is Qwen3.5-4B in bf16 LoRA: Unsloth advises against 4-bit QLoRA for the Qwen3.5 family and
documents ~10 GB VRAM for 4B bf16 LoRA (fits a 12 GB card with batch 1). `--load-in-4bit` restores QLoRA for
older bases such as Qwen3-8B. Measures eval loss on the held-out set BEFORE and AFTER training with the same
code path and writes the LoRA adapter. Merging is a separate step (merge_lora.py).

Usage:
  python train_qlora.py --run netrunner-v2 [--base unsloth/Qwen3.5-4B] [--epochs 3]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time

from common import FORGE_HOME, run_dir

os.environ.setdefault("UNSLOTH_DISABLE_STATISTICS", "1")  # no usage pings
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HOME", str(FORGE_HOME / "hf"))  # weights cache next to the rest of FORGE
# Unsloth writes `unsloth_compiled_cache/` into the working directory; keep it out of the source tree.
os.chdir(FORGE_HOME)

from unsloth import FastLanguageModel  # noqa: E402  (must be imported before transformers/trl)
import torch  # noqa: E402
from datasets import DatasetDict, load_dataset  # noqa: E402
from trl import SFTConfig, SFTTrainer  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--base", default="unsloth/Qwen3.5-4B")
    ap.add_argument("--load-in-4bit", action="store_true", help="QLoRA (not recommended for Qwen3.5)")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=4096, help="memory-grounded samples reach ~3.5K tokens")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    args = ap.parse_args()

    out = run_dir(args.run)
    assert torch.cuda.is_available(), "CUDA GPU required"
    print(f"[forge] GPU: {torch.cuda.get_device_name(0)}", flush=True)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base, max_seq_length=args.max_seq, load_in_4bit=args.load_in_4bit, dtype=None,
    )
    # Vision-language bases return a processor; text-only training needs its tokenizer.
    tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.rank,
        lora_alpha=args.rank,
        lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=1337,
    )

    def to_text(batch):
        return {"text": [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False, enable_thinking=False)
                         for m in batch["messages"]]}

    # Loaded one by one: eval rows carry a "meta" column (source file, kind) that train rows do not have.
    ds = DatasetDict({split: load_dataset("json", data_files=str(out / f"{split}.jsonl"), split="train").select_columns(["messages"])
                      for split in ("train", "eval")})
    ds = ds.map(to_text, batched=True, remove_columns=["messages"])
    print(f"[forge] train={len(ds['train'])} eval={len(ds['eval'])}", flush=True)
    print("[forge] sample:\n" + ds["train"][0]["text"][:600], flush=True)

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=ds["train"],
        eval_dataset=ds["eval"],
        args=SFTConfig(
            dataset_text_field="text",
            max_length=args.max_seq,
            per_device_train_batch_size=args.batch,
            per_device_eval_batch_size=args.batch,
            gradient_accumulation_steps=args.grad_accum,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.05,
            weight_decay=0.01,
            optim="adamw_8bit",
            logging_steps=5,
            eval_strategy="no",
            save_strategy="no",
            seed=1337,
            output_dir=str(out / "trainer"),
            report_to="none",
            dataset_num_proc=1,  # Windows: multiprocessing in datasets is unreliable
        ),
    )

    # Loss only on assistant tokens; the prompt is context, not a target.
    try:
        from unsloth.chat_templates import train_on_responses_only
        trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
        masked = True
    except Exception as e:  # noqa: BLE001
        print(f"[forge] WARNING: response-only masking unavailable ({e}); training on full sequences", flush=True)
        masked = False

    before = trainer.evaluate()["eval_loss"]
    print(f"[forge] eval loss BEFORE: {before:.4f} (ppl {math.exp(before):.2f})", flush=True)

    t0 = time.time()
    train_result = trainer.train()
    train_seconds = time.time() - t0

    after = trainer.evaluate()["eval_loss"]
    print(f"[forge] eval loss AFTER:  {after:.4f} (ppl {math.exp(after):.2f})", flush=True)

    adapter_dir = out / "lora_adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    report = {
        "base": args.base,
        "train_samples": len(ds["train"]),
        "eval_samples": len(ds["eval"]),
        "epochs": args.epochs,
        "lora_rank": args.rank,
        "learning_rate": args.lr,
        "response_only_loss": masked,
        "eval_loss_before": before,
        "eval_loss_after": after,
        "eval_ppl_before": math.exp(before),
        "eval_ppl_after": math.exp(after),
        "train_loss_final": train_result.training_loss,
        "train_seconds": train_seconds,
        "peak_vram_gb": torch.cuda.max_memory_reserved() / 1024**3,
        "log_history": trainer.state.log_history,
    }
    (out / "train_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "log_history"}, indent=2), flush=True)

    print("[forge] adapter saved; next: merge_lora.py (offline merge into 16-bit weights)", flush=True)


if __name__ == "__main__":
    main()
