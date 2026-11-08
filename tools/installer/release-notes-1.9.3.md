## NETRUNNER 1.9.3 — first public release

A local AI workstation for developers on Windows: code editor, chat, agents, terminal and resource monitors.
Every model runs on your own computer.

### Installation

1. Download **`NETRUNNER_Setup_1.9.3.exe`** below.
2. Run it. If Windows SmartScreen shows a warning (the installer is not code-signed), click
   **More info → Run anyway**.
3. Click "Next" until it finishes. No administrator rights are needed.

The installer sets up the program, the llama.cpp engine with the Visual C++ runtime and ripgrep, **downloads every
model (~85 GB)** — Qwen from Hugging Face, NETRUNNER's own models from the `models-v1` release — checks each file's
SHA-256, and installs Git for Windows if it is missing. An internet connection is needed during installation; after
that the program works offline. A dropped download resumes where it stopped.

### System requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 (1809) x64 | Windows 11 x64 |
| CPU | x64, 4 cores | 8+ cores |
| RAM | 16 GB (chat) | 64 GB (agents on Qwen3-Coder-Next) |
| GPU | optional (slow without it) | NVIDIA 12 GB, driver R580+ |
| Disk | 100 GB | 100 GB on an SSD |

The NVIDIA driver is installed separately from nvidia.com. More in the
[README](https://github.com/StanislavTerekhov/NETRUNNER#readme) and the
[CHANGELOG](https://github.com/StanislavTerekhov/NETRUNNER/blob/main/CHANGELOG.md).
