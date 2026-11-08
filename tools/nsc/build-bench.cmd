@echo off
rem NSC-ME phase 1 benchmarks: diskbench (MSVC) and h2dbench (CUDA, sm_86). Arg 1: output dir.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "PATH=%CUDA_PATH%\bin;%PATH%"
if not exist "%~1" mkdir "%~1"
cl /nologo /O2 /W3 "%~dp0diskbench.c" /Fe"%~1\diskbench.exe" /Fo"%~1\\" || exit /b 2
nvcc -O2 -arch=sm_86 "%~dp0h2dbench.cu" -o "%~1\h2dbench.exe" || exit /b 3
rem Phase 2: Memory Consumer (RAM/CPU and VRAM).
cl /nologo /O2 /W3 "%~dp0memconsumer.c" psapi.lib /Fe"%~1\memconsumer.exe" /Fo"%~1\\" || exit /b 4
nvcc -O2 -arch=sm_86 "%~dp0vramconsumer.cu" -o "%~1\vramconsumer.exe" || exit /b 5
echo BUILD OK
