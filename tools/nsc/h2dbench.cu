// NSC-ME phase 1: RAM → GPU copy of expert-sized blocks, the ways llama.cpp could do it.
//   h2dbench [blockBytes=1720320] [totalMiB=1024] [slots=4]
//   pageable-sync    cudaMemcpy from ordinary memory (what the expert cache does with mmap weights)
//   pinned-async     cudaMemcpyAsync from page-locked memory, one sync at the end (what -lm none gives)
//   staging-K        H5: CPU memcpy ordinary → small pinned ring of K slots → cudaMemcpyAsync; the weights stay pageable
//   cpu-memcpy       ordinary → ordinary, the CPU copy cost staging adds
// Prints one JSON line per method; each method runs 3 times (first is a warm-up).
#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <chrono>

static double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
#define CK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { fprintf(stderr, "%s: %s\n", #x, cudaGetErrorString(e)); exit(1); } } while (0)

int main(int argc, char **argv) {
  size_t block = argc > 1 ? strtoull(argv[1], 0, 10) : 1720320;
  size_t total = (argc > 2 ? strtoull(argv[2], 0, 10) : 1024) << 20;
  int slots = argc > 3 ? atoi(argv[3]) : 4;
  size_t n = total / block;
  total = n * block;
  char *pageable = (char *)malloc(total);
  memset(pageable, 1, total);
  char *pinned; CK(cudaMallocHost(&pinned, total)); memset(pinned, 1, total);
  char *ring; CK(cudaMallocHost(&ring, block * slots));
  char *other = (char *)malloc(block * 4);
  const int devSlots = 64;
  char *dev; CK(cudaMalloc(&dev, block * devSlots));
  cudaStream_t st; CK(cudaStreamCreate(&st));
  cudaEvent_t *ev = (cudaEvent_t *)malloc(sizeof(cudaEvent_t) * slots);
  for (int i = 0; i < slots; i++) { CK(cudaEventCreateWithFlags(&ev[i], cudaEventDisableTiming)); CK(cudaEventRecord(ev[i], st)); }
  CK(cudaStreamSynchronize(st));
  auto out = [&](const char *m, int run, double s) {
    printf("{\"method\":\"%s\",\"run\":%d,\"block\":%zu,\"blocks\":%zu,\"slots\":%d,\"seconds\":%.4f,\"GBps\":%.3f,\"usPerBlock\":%.1f}\n", m, run, block, n, slots, s, total / s / 1e9, s / n * 1e6);
    fflush(stdout);
  };
  for (int run = 0; run < 3; run++) {
    double t = now();
    for (size_t i = 0; i < n; i++) CK(cudaMemcpy(dev + (i % devSlots) * block, pageable + i * block, block, cudaMemcpyHostToDevice));
    out("pageable-sync", run, now() - t);

    t = now();
    for (size_t i = 0; i < n; i++) CK(cudaMemcpyAsync(dev + (i % devSlots) * block, pinned + i * block, block, cudaMemcpyHostToDevice, st));
    CK(cudaStreamSynchronize(st));
    out("pinned-async", run, now() - t);

    t = now();
    for (size_t i = 0; i < n; i++) {
      int s = (int)(i % slots);
      CK(cudaEventSynchronize(ev[s]));  // the slot's previous copy has finished
      memcpy(ring + s * block, pageable + i * block, block);
      CK(cudaMemcpyAsync(dev + (i % devSlots) * block, ring + s * block, block, cudaMemcpyHostToDevice, st));
      CK(cudaEventRecord(ev[s], st));
    }
    CK(cudaStreamSynchronize(st));
    char name[32]; snprintf(name, sizeof name, "staging-%d", slots);
    out(name, run, now() - t);

    t = now();
    for (size_t i = 0; i < n; i++) memcpy(other + (i % 4) * block, pageable + i * block, block);
    out("cpu-memcpy", run, now() - t);
  }
  return 0;
}
