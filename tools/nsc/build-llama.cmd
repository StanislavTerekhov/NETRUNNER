@echo off
rem Build llama.cpp (NETRUNNER fork) with CUDA for the RTX 3060 (sm_86). Arg 1: source dir, arg 2: build dir.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "PATH=%CUDA_PATH%\bin;%PATH%"
cmake -S "%~1" -B "%~2" -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=86 -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF || exit /b 2
cmake --build "%~2" --config Release -j 24 --target llama-server llama-bench || exit /b 3
echo BUILD OK
