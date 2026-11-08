// NSC-ME phase 1: how fast model weights come back from storage. Read-only; never writes the file.
//   diskbench <mode> <file> <blockBytes> <count> <qd> [seed]
// modes:
//   seq-unbuf   sequential reads with FILE_FLAG_NO_BUFFERING (the device itself, file cache bypassed)
//   rand-unbuf  random 4K-aligned blocks, no file cache, <qd> overlapped requests in flight
//   rand-buf    random blocks through the file cache (ReadFile), 2 passes over the same offsets
//   rand-mmap   random blocks through a mapped view (touch every 4K page = page faults), 2 passes
// Pass 1 of the cached modes runs on whatever the cache holds; pass 2 is warm by construction.
// Prints one JSON line per pass.
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double now(void) { LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (double)c.QuadPart / (double)f.QuadPart; }
static unsigned long long rs = 88172645463325252ULL;
static unsigned long long xr(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; }
static int cmpd(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

static void report(const char *mode, int pass, long long block, int count, int qd, double sec, double *lat, int nlat) {
  double gb = (double)block * count / 1e9, p50 = -1, p95 = -1, mx = -1;
  if (nlat > 0) { qsort(lat, nlat, sizeof(double), cmpd); p50 = lat[nlat / 2] * 1e3; p95 = lat[(int)(nlat * 0.95)] * 1e3; mx = lat[nlat - 1] * 1e3; }
  printf("{\"mode\":\"%s\",\"pass\":%d,\"block\":%lld,\"count\":%d,\"qd\":%d,\"seconds\":%.3f,\"GBps\":%.3f,\"p50ms\":%.3f,\"p95ms\":%.3f,\"maxms\":%.3f}\n",
         mode, pass, block, count, qd, sec, gb / sec, p50, p95, mx);
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc < 6) { fprintf(stderr, "usage: diskbench <mode> <file> <blockBytes> <count> <qd> [seed]\n"); return 2; }
  const char *mode = argv[1], *file = argv[2];
  long long block = _atoi64(argv[3]);
  int count = atoi(argv[4]), qd = atoi(argv[5]);
  if (argc > 6) rs = _strtoui64(argv[6], NULL, 10) | 1;
  block = (block + 4095) / 4096 * 4096;
  int unbuf = strstr(mode, "unbuf") != NULL, seq = strncmp(mode, "seq", 3) == 0, mm = strstr(mode, "mmap") != NULL;
  DWORD flags = FILE_ATTRIBUTE_NORMAL | (unbuf ? FILE_FLAG_NO_BUFFERING | FILE_FLAG_OVERLAPPED : FILE_FLAG_RANDOM_ACCESS);
  HANDLE f = CreateFileA(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, flags, NULL);
  if (f == INVALID_HANDLE_VALUE) { fprintf(stderr, "open failed %lu\n", GetLastError()); return 1; }
  LARGE_INTEGER sz; GetFileSizeEx(f, &sz);
  long long span = (sz.QuadPart - block) / 4096;
  if (span <= 0) { fprintf(stderr, "file too small\n"); return 1; }
  long long *off = (long long *)malloc(sizeof(long long) * count);
  for (int i = 0; i < count; i++) off[i] = seq ? (long long)i * block : (long long)(xr() % (unsigned long long)span) * 4096;
  if (seq && off[count - 1] + block > sz.QuadPart) { fprintf(stderr, "file too small for %d blocks\n", count); return 1; }
  double *lat = (double *)malloc(sizeof(double) * count);

  if (unbuf) {
    if (qd < 1) qd = 1;
    char **buf = (char **)malloc(sizeof(char *) * qd);
    OVERLAPPED *ov = (OVERLAPPED *)calloc(qd, sizeof(OVERLAPPED));
    HANDLE *ev = (HANDLE *)malloc(sizeof(HANDLE) * qd);
    double *t0 = (double *)malloc(sizeof(double) * qd);
    for (int i = 0; i < qd; i++) { buf[i] = (char *)VirtualAlloc(NULL, (SIZE_T)block, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE); ev[i] = CreateEventA(NULL, TRUE, FALSE, NULL); }
    int next = 0, done = 0, inflight = 0;
    double start = now();
    for (int s = 0; s < qd && next < count; s++, next++) {
      memset(&ov[s], 0, sizeof(OVERLAPPED)); ov[s].hEvent = ev[s]; ov[s].Offset = (DWORD)off[next]; ov[s].OffsetHigh = (DWORD)(off[next] >> 32);
      t0[s] = now();
      if (!ReadFile(f, buf[s], (DWORD)block, NULL, &ov[s]) && GetLastError() != ERROR_IO_PENDING) { fprintf(stderr, "read failed %lu\n", GetLastError()); return 1; }
      inflight++;
    }
    while (inflight > 0) {
      DWORD w = WaitForMultipleObjects((DWORD)qd, ev, FALSE, INFINITE);
      int s = (int)(w - WAIT_OBJECT_0);
      DWORD got = 0;
      if (!GetOverlappedResult(f, &ov[s], &got, FALSE) || got != (DWORD)block) { fprintf(stderr, "short read %lu\n", GetLastError()); return 1; }
      lat[done++] = now() - t0[s];
      ResetEvent(ev[s]); inflight--;
      if (next < count) {
        memset(&ov[s], 0, sizeof(OVERLAPPED)); ov[s].hEvent = ev[s]; ov[s].Offset = (DWORD)off[next]; ov[s].OffsetHigh = (DWORD)(off[next] >> 32);
        t0[s] = now();
        if (!ReadFile(f, buf[s], (DWORD)block, NULL, &ov[s]) && GetLastError() != ERROR_IO_PENDING) { fprintf(stderr, "read failed %lu\n", GetLastError()); return 1; }
        next++; inflight++;
      } else {
        // Nothing left to issue: park the slot behind a never-signalled event so the wait ignores it.
        CloseHandle(ev[s]); ev[s] = CreateEventA(NULL, TRUE, FALSE, NULL);
      }
    }
    report(mode, 1, block, count, qd, now() - start, lat, done);
    return 0;
  }

  if (mm) {
    HANDLE m = CreateFileMappingA(f, NULL, PAGE_READONLY, 0, 0, NULL);
    const volatile unsigned char *base = (const volatile unsigned char *)MapViewOfFile(m, FILE_MAP_READ, 0, 0, 0);
    if (!base) { fprintf(stderr, "map failed %lu\n", GetLastError()); return 1; }
    unsigned long long sum = 0;
    for (int pass = 1; pass <= 2; pass++) {
      double start = now();
      for (int i = 0; i < count; i++) {
        double t = now();
        for (long long p = 0; p < block; p += 4096) sum += base[off[i] + p];
        lat[i] = now() - t;
      }
      report(mode, pass, block, count, 1, now() - start, lat, count);
    }
    fprintf(stderr, "checksum %llu\n", sum);
    return 0;
  }

  char *buf = (char *)VirtualAlloc(NULL, (SIZE_T)block, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  for (int pass = 1; pass <= 2; pass++) {
    double start = now();
    for (int i = 0; i < count; i++) {
      double t = now();
      LARGE_INTEGER o; o.QuadPart = off[i];
      SetFilePointerEx(f, o, NULL, FILE_BEGIN);
      DWORD got = 0;
      if (!ReadFile(f, buf, (DWORD)block, &got, NULL) || got != (DWORD)block) { fprintf(stderr, "read failed %lu\n", GetLastError()); return 1; }
      lat[i] = now() - t;
    }
    report(mode, pass, block, count, 1, now() - start, lat, count);
  }
  return 0;
}
