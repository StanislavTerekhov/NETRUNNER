// NSC-ME phase 2: Memory Consumer — the "other program" whose experience decides whether freed memory is real.
//   memconsumer ram <GiB> <passes> [--trim-after N] [--hold-seconds S]
//     Commits and writes <GiB> of private memory, then repeats a fixed pass over all of it: read every 8-byte word
//     (sum) and write one word per 4 KiB page. Prints one JSON line per pass: time, GB/s, page faults during the
//     pass, working set, private bytes. A pass that gets slower or faults means the memory was not really ours.
//     --trim-after N   after pass N, empty our own working set (self-test: the next pass must show faults)
//     --hold-seconds S keep doing passes until S seconds have passed (to run next to a model)
//   memconsumer cpu <threads> <passes>
//     A fixed integer workload on <threads> threads; one JSON line per pass with its time (CPU contention).
#include <windows.h>
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double now(void) { LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (double)c.QuadPart / (double)f.QuadPart; }
static PROCESS_MEMORY_COUNTERS_EX pmc(void) { PROCESS_MEMORY_COUNTERS_EX p; p.cb = sizeof p; GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&p, sizeof p); return p; }

typedef struct { unsigned long long iters, out; } Job;
static DWORD WINAPI cpuJob(LPVOID a) {
  Job *j = (Job *)a; unsigned long long x = 88172645463325252ULL ^ (unsigned long long)(size_t)a, s = 0;
  for (unsigned long long i = 0; i < j->iters; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; s += x & 0xff; }
  j->out = s; return 0;
}

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: memconsumer ram <GiB> <passes> [--trim-after N] [--hold-seconds S] | cpu <threads> <passes>\n"); return 2; }
  if (strcmp(argv[1], "cpu") == 0) {
    int threads = atoi(argv[2]), passes = atoi(argv[3]);
    Job *jobs = (Job *)calloc(threads, sizeof(Job)); HANDLE *h = (HANDLE *)malloc(sizeof(HANDLE) * threads);
    for (int p = 1; p <= passes; p++) {
      double t = now();
      for (int i = 0; i < threads; i++) { jobs[i].iters = 400000000ULL; h[i] = CreateThread(NULL, 0, cpuJob, &jobs[i], 0, NULL); }
      WaitForMultipleObjects(threads, h, TRUE, INFINITE);
      for (int i = 0; i < threads; i++) CloseHandle(h[i]);
      printf("{\"mode\":\"cpu\",\"pass\":%d,\"threads\":%d,\"seconds\":%.3f}\n", p, threads, now() - t); fflush(stdout);
    }
    return 0;
  }
  double gib = atof(argv[2]);
  int passes = atoi(argv[3]), trimAfter = -1;
  double hold = 0;
  for (int i = 4; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--trim-after")) trimAfter = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--hold-seconds")) hold = atof(argv[++i]);
  }
  size_t bytes = (size_t)(gib * 1073741824.0) / 4096 * 4096, words = bytes / 8;
  double t0 = now();
  unsigned long long *m = (unsigned long long *)VirtualAlloc(NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!m) { printf("{\"mode\":\"ram\",\"error\":\"commit failed\",\"code\":%lu,\"GiB\":%.2f}\n", GetLastError(), gib); return 1; }
  PROCESS_MEMORY_COUNTERS_EX a = pmc();
  for (size_t i = 0; i < words; i += 512) m[i] = i;  // first touch: every page becomes ours
  PROCESS_MEMORY_COUNTERS_EX b = pmc();
  printf("{\"mode\":\"ram\",\"phase\":\"touch\",\"GiB\":%.2f,\"seconds\":%.3f,\"GBps\":%.3f,\"faults\":%lu,\"wsGiB\":%.2f,\"privateGiB\":%.2f}\n",
         gib, now() - t0, bytes / (now() - t0) / 1e9, b.PageFaultCount - a.PageFaultCount, b.WorkingSetSize / 1073741824.0, b.PrivateUsage / 1073741824.0);
  fflush(stdout);
  double start = now();
  unsigned long long sum = 0;
  for (int p = 1; p <= passes || (hold > 0 && now() - start < hold); p++) {
    PROCESS_MEMORY_COUNTERS_EX x = pmc();
    double t = now();
    for (size_t i = 0; i < words; i++) sum += m[i];
    for (size_t i = 0; i < words; i += 512) m[i] += 1;
    double s = now() - t;
    PROCESS_MEMORY_COUNTERS_EX y = pmc();
    printf("{\"mode\":\"ram\",\"pass\":%d,\"t\":%.1f,\"seconds\":%.3f,\"GBps\":%.3f,\"faults\":%lu,\"wsGiB\":%.2f,\"privateGiB\":%.2f}\n",
           p, now() - start, s, bytes / s / 1e9, y.PageFaultCount - x.PageFaultCount, y.WorkingSetSize / 1073741824.0, y.PrivateUsage / 1073741824.0);
    fflush(stdout);
    if (p == trimAfter) EmptyWorkingSet(GetCurrentProcess());
  }
  fprintf(stderr, "checksum %llu\n", sum);
  return 0;
}
