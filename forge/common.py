"""Shared helpers for the FORGE weight-training pipeline. Standard library only.

Inference (teacher, judge, evaluation) runs on llama.cpp's llama-server, started and stopped by these
helpers on a free loopback port with a random API key.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

NETRUNNER_HOME = Path(os.environ.get("NETRUNNER_HOME", Path.home() / "NETRUNNER"))
# Not under AppData (packaged apps get it virtualized) and not under OneDrive (multi-GB weights).
FORGE_HOME = Path(os.environ.get("NETRUNNER_FORGE_HOME", NETRUNNER_HOME / "forge"))
MODELS_DIR = NETRUNNER_HOME / "models"
RUNTIME_ROOT = NETRUNNER_HOME / "runtime" / "llama.cpp"


def runtime_dir() -> Path:
    """Newest llama.cpp build folder (b<number>) that contains llama-server."""
    builds = sorted((p for p in RUNTIME_ROOT.glob("b*") if p.name[1:].isdigit() and (p / "llama-server.exe").exists()),
                    key=lambda p: int(p.name[1:]), reverse=True)
    if not builds:
        raise SystemExit(f"llama.cpp runtime not found under {RUNTIME_ROOT} (install it from NETRUNNER → MODEL VAULT → SETUP)")
    return builds[0]


def find_model(query: str) -> Path:
    """A GGUF in the models folder by exact relative path or by case-insensitive name fragment (first split part)."""
    exact = MODELS_DIR / query
    if exact.is_file():
        return exact
    q = query.lower()
    hits = sorted(p for p in MODELS_DIR.rglob("*.gguf")
                  if q in p.name.lower() and not p.name.lower().startswith("mmproj")
                  and not re.search(r"-0000[2-9]-of-\d{5}\.gguf$", p.name))
    if not hits:
        raise SystemExit(f"No GGUF matching '{query}' in {MODELS_DIR}")
    return hits[0]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaServer:
    """`with LlamaServer(model) as srv: srv.chat(...)` — a private llama-server for one model."""

    def __init__(self, model: Path, ctx: int = 16384, extra: list[str] | None = None, parallel: int = 1):
        """`ctx` is per request; `parallel` slots serve that many requests at once (llama.cpp splits -c between them)."""
        self.model, self.ctx, self.extra, self.parallel = Path(model), ctx, extra or [], max(1, parallel)
        self.key = secrets.token_hex(16)
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc: subprocess.Popen | None = None
        self.load_seconds = 0.0

    def __enter__(self) -> "LlamaServer":
        exe = runtime_dir() / "llama-server.exe"
        args = [str(exe), "-m", str(self.model), "--host", "127.0.0.1", "--port", str(self.port), "--api-key", self.key,
                "--no-webui", "-c", str(self.ctx * self.parallel), "-np", str(self.parallel), "--fit", "on", "-fa", "auto", "--jinja",
                "--reasoning-format", "deepseek", "-b", "4096", "-ub", "4096", *self.extra]
        t0 = time.time()
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        while True:
            if self.proc.poll() is not None:
                raise SystemExit(f"llama-server exited while loading {self.model.name}")
            try:
                with urllib.request.urlopen(f"{self.url}/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(0.5)
        self.load_seconds = time.time() - t0
        print(f"[llama] {self.model.name} ready in {self.load_seconds:.0f} s on {self.url}", flush=True)
        return self

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            subprocess.run(["taskkill", "/pid", str(self.proc.pid), "/T", "/F"], capture_output=True)

    def chat(self, messages: list[dict], *, think: bool | None = False, fmt: dict | None = None, grammar: str | None = None,
             temperature: float | None = None, max_tokens: int | None = None, timeout: float = 1800) -> dict:
        if self.proc is None or self.proc.poll() is not None:
            # A dead server must stop the pipeline, not turn every remaining item into a "failed" sample.
            raise SystemExit(f"llama-server for {self.model.name} is not running (exit code {self.proc and self.proc.poll()})")
        body: dict = {"messages": messages, "stream": False}
        if think is not None:
            body["chat_template_kwargs"] = {"enable_thinking": think}
        if fmt is not None:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": fmt, "strict": True}}
        if grammar is not None:
            body["grammar"] = grammar  # GBNF; tighter than a JSON schema when the answer is a single token
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        req = urllib.request.Request(f"{self.url}/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "Authorization": f"Bearer {self.key}"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read())
        msg = data["choices"][0]["message"]
        return {"content": msg.get("content") or "", "timings": data.get("timings", {})}


def run_dir(name: str) -> Path:
    d = FORGE_HOME / "runs" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
