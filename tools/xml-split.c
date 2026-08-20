// xml-split: fan a MediaWiki XML dump out to N worker pipelines, splitting
// at <page> boundaries so each worker sees a well-formed document.
//
//   lbzip2 -dc dump.xml.bz2 | xml-split N 'remove-markup | make-index part%d'
//
// Each worker gets "<mediawiki>" + every Nth page + "</mediawiki>" on stdin;
// %d in the command becomes the worker number. The dump header before the
// first <page> is discarded (remove-markup only cares about <title>/<text>
// inside pages). Exit status is non-zero if any worker fails.
//
// The scan is memchr-based and processes hundreds of MB/s; the workers are
// the bottleneck by design.

#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>

#define BUF_SIZE (1 << 20)
#define PIPE_SIZE (1 << 20)

static const char PAGE_OPEN[] = "<page>";
static const char PAGE_CLOSE[] = "</page>";

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s N 'worker command with %%d'\n", argv[0]);
    return 2;
  }
  int n = atoi(argv[1]);
  if (n < 1 || n > 256) {
    fprintf(stderr, "bad worker count\n");
    return 2;
  }

  FILE **workers = calloc(n, sizeof(FILE *));
  for (int i = 0; i < n; ++i) {
    char cmd[4096];
    const char *p = strstr(argv[2], "%d");
    if (p) {
      snprintf(cmd, sizeof cmd, "%.*s%d%s", (int)(p - argv[2]), argv[2], i, p + 2);
    } else {
      snprintf(cmd, sizeof cmd, "%s", argv[2]);
    }
    workers[i] = popen(cmd, "w");
    if (!workers[i]) {
      perror("popen");
      return 1;
    }
    // A large kernel pipe absorbs bursts so one slow worker doesn't stall
    // the round-robin for everyone (head-of-line blocking).
#ifdef F_SETPIPE_SZ
    if (fcntl(fileno(workers[i]), F_SETPIPE_SZ, PIPE_SIZE) < 0) {
      // Not fatal; the default 64KB just parallelizes worse.
    }
#endif
    fputs("<mediawiki>\n", workers[i]);
  }

  // Carry buffer holds a partial page (or partial tag) across reads. Pages
  // are well under 16MB; cap the carry to catch runaway input.
  size_t cap = BUF_SIZE * 2;
  char *data = malloc(cap);
  size_t len = 0;      // bytes buffered
  size_t start = 0;    // offset of first unconsumed byte
  int in_page = 0;     // currently inside <page>...</page>
  int worker = 0;      // round-robin target for the current page
  long long pages = 0;

  for (;;) {
    if (len + BUF_SIZE > cap) {
      cap *= 2;
      if (cap > (1u << 30)) {
        fprintf(stderr, "xml-split: page larger than 1GB?\n");
        return 1;
      }
      char *new_data = realloc(data, cap);
      if (!new_data) {
        free(data);
        fprintf(stderr, "xml-split: out of memory\n");
        return 1;
      }
      data = new_data;
    }

    size_t got = fread(data + len, 1, BUF_SIZE, stdin);
    if (got == 0) break;
    len += got;

    // Consume as many complete tokens as possible.
    for (;;) {
      if (!in_page) {
        char *open = memmem(data + start, len - start, PAGE_OPEN,
                            sizeof PAGE_OPEN - 1);
        if (!open) {
          // Keep a tail in case "<page>" straddles the read boundary.
          size_t keep = sizeof PAGE_OPEN - 1;
          if (len - start > keep) start = len - keep;
          break;
        }
        start = open - data; // discard everything before the tag
        in_page = 1;
      } else {
        char *close = memmem(data + start, len - start, PAGE_CLOSE,
                             sizeof PAGE_CLOSE - 1);
        if (!close) break; // need more input
        size_t end = (close - data) + sizeof PAGE_CLOSE - 1;
        FILE *w = workers[worker];
        if (fwrite(data + start, 1, end - start, w) != end - start ||
            putc('\n', w) == EOF) {
          fprintf(stderr, "xml-split: write to worker %d failed\n", worker);
          return 1;
        }
        ++pages;
        worker = (worker + 1) % n;
        start = end;
        in_page = 0;
      }
    }

    // Compact the buffer.
    memmove(data, data + start, len - start);
    len -= start;
    start = 0;
  }

  if (in_page) {
    fprintf(stderr, "xml-split: warning: truncated final page dropped\n");
  }

  int status = 0;
  for (int i = 0; i < n; ++i) {
    fputs("</mediawiki>\n", workers[i]);
    int rc = pclose(workers[i]);
    if (rc != 0) {
      fprintf(stderr, "xml-split: worker %d exited with %d\n", i, rc);
      status = 1;
    }
  }
  fprintf(stderr, "xml-split: %lld pages to %d workers\n", pages, n);
  return status;
}
