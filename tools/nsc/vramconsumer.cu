// NSC-ME phase 2: VRAM Memory Consumer — does another program really get the video memory, at full speed?
//   vramconsumer <GiB> <passes> [--hold-seconds S] [--interval-ms N]
// Allocates <GiB> with cudaMalloc in 256 MiB chunks and repeats a fixed read-modify-write kernel over all of it.
// One JSON line per pass: time and effective bandwidth. On Windows (WDDM) the driver can silently move allocations
// to system memory when VRAM is oversubscribed; that shows up as a bandwidth drop from ~300 GB/s to PCIe speeds.
#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <chrono>
#include <thread>
#include <vector>

static double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

__global__ void rmw(float4 *p, size_t n) {
  for (size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x; i < n; i += (size_t)gridDim.x * blockDim.x) {
    float4 v = p[i]; v.x += 1.f; v.y += 1.f; v.z += 1.f; v.w += 1.f; p[i] = v;
  }
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: vramconsumer <GiB> <passes> [--hold-seconds S]\n"); return 2; }
  double gib = atof(argv[1]), hold = 0;
  int passes = atoi(argv[2]);
  int intervalMs = 0;  // --interval-ms: pause between passes, like a program that holds VRAM and uses it now and then
  for (int i = 3; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--hold-seconds")) hold = atof(argv[++i]);
    else if (!strcmp(argv[i], "--interval-ms")) intervalMs = atoi(argv[++i]);
  }
  const size_t chunk = 256ull << 20;
  size_t nchunks = (size_t)(gib * 1024 / 256 + 0.5);
  size_t fr0, tot; cudaMemGetInfo(&fr0, &tot);
  std::vector<float4 *> c;
  double t0 = now();
  for (size_t i = 0; i < nchunks; i++) {
    float4 *p = nullptr;
    cudaError_t e = cudaMalloc(&p, chunk);
    if (e != cudaSuccess) { printf("{\"mode\":\"vram\",\"error\":\"%s\",\"allocatedGiB\":%.2f}\n", cudaGetErrorString(e), c.size() / 4.0); fflush(stdout); break; }
    cudaMemset(p, 0, chunk);
    c.push_back(p);
  }
  cudaDeviceSynchronize();
  size_t fr1; cudaMemGetInfo(&fr1, &tot);
  printf("{\"mode\":\"vram\",\"phase\":\"alloc\",\"GiB\":%.2f,\"seconds\":%.3f,\"freeBeforeGiB\":%.2f,\"freeAfterGiB\":%.2f,\"totalGiB\":%.2f}\n",
         c.size() / 4.0, now() - t0, fr0 / 1073741824.0, fr1 / 1073741824.0, tot / 1073741824.0);
  fflush(stdout);
  if (c.empty()) return 1;
  cudaEvent_t a, b; cudaEventCreate(&a); cudaEventCreate(&b);
  size_t n = chunk / sizeof(float4);
  double start = now();
  for (int p = 1; p <= passes || (hold > 0 && now() - start < hold); p++) {
    cudaEventRecord(a);
    for (auto *q : c) rmw<<<1024, 256>>>(q, n);
    cudaEventRecord(b);
    cudaEventSynchronize(b);
    float ms = 0; cudaEventElapsedTime(&ms, a, b);
    double bytes = 2.0 * chunk * c.size();
    printf("{\"mode\":\"vram\",\"pass\":%d,\"t\":%.1f,\"seconds\":%.4f,\"GBps\":%.1f}\n", p, now() - start, ms / 1000.0, bytes / (ms / 1000.0) / 1e9);
    fflush(stdout);
    if (intervalMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
  }
  return 0;
}
