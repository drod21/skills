// limen: append one complaint line to a log the caller cannot read.
//
// The log path is compiled in (-DLIMEN_FILE) by install.sh and never printed.
// Installed root-owned and execute-only (0111), so agents can run it but not
// read it. The log itself is root-owned, mode 0622 and flagged sappnd: agents
// may append, never read, truncate, rewrite or delete it.
//
// Usage: limen complain [--session ID] [--project NAME] "<one sentence>"

#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef LIMEN_FILE
#error "build with -DLIMEN_FILE=\"/absolute/path\""
#endif

#define MAX_SENTENCE 1000
#define MAX_TAG 128

static int usage(void) {
  fputs("usage: limen complain [--session ID] [--project NAME] \"<one sentence>\"\n", stderr);
  return 64;
}

// Collapse whitespace runs (newlines included) to one space and trim, in place.
static void flatten(char *s, size_t cap) {
  char *w = s;
  int space = 1;
  for (char *r = s; *r && (size_t)(w - s) < cap; r++) {
    unsigned char c = (unsigned char)*r;
    if (c == '\n' || c == '\r' || c == '\t' || c == ' ') {
      if (!space) *w++ = ' ';
      space = 1;
    } else if (c >= 0x20 && c != 0x7f) {
      *w++ = (char)c;
      space = 0;
    }
  }
  while (w > s && w[-1] == ' ') w--;
  *w = '\0';
}

// Project tag: the main checkout's directory name, so every worktree of one
// repository shares a tag. Falls back to the current directory's name.
static void project_tag(char *out, size_t cap) {
  FILE *p = popen("git rev-parse --path-format=absolute --git-common-dir 2>/dev/null", "r");
  char buf[PATH_MAX] = {0};
  if (p) {
    if (!fgets(buf, sizeof buf, p)) buf[0] = '\0';
    pclose(p);
  }
  buf[strcspn(buf, "\n")] = '\0';
  if (buf[0]) {
    size_t n = strlen(buf);
    if (n > 5 && strcmp(buf + n - 5, "/.git") == 0) buf[n - 5] = '\0';
    snprintf(out, cap, "%s", basename(buf));
    return;
  }
  char cwd[PATH_MAX];
  snprintf(out, cap, "%s", getcwd(cwd, sizeof cwd) ? basename(cwd) : "unknown");
}

int main(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "complain") != 0) return usage();

  const char *session = getenv("LIMEN_SESSION_ID");
  const char *project = NULL;
  const char *sentence = NULL;
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--session") == 0 && i + 1 < argc) session = argv[++i];
    else if (strcmp(argv[i], "--project") == 0 && i + 1 < argc) project = argv[++i];
    else if (!sentence) sentence = argv[i];
    else return usage();
  }
  if (!sentence) return usage();

  char text[MAX_SENTENCE + 1];
  snprintf(text, sizeof text, "%s", sentence);
  flatten(text, MAX_SENTENCE);
  if (!text[0]) return usage();

  char sid[MAX_TAG + 1];
  snprintf(sid, sizeof sid, "%s", session && *session ? session : "unknown");
  flatten(sid, MAX_TAG);

  char tag[MAX_TAG + 1];
  if (project && *project) snprintf(tag, sizeof tag, "%s", project);
  else project_tag(tag, sizeof tag);
  flatten(tag, MAX_TAG);

  char stamp[40];
  time_t now = time(NULL);
  struct tm local;
  localtime_r(&now, &local);
  strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S%z", &local);

  char line[MAX_SENTENCE + 3 * MAX_TAG + 64];
  int len = snprintf(line, sizeof line, "- %s | session %s | %s | %s\n", stamp, sid, tag, text);
  if (len < 0 || (size_t)len >= sizeof line) return 70;

  // No O_CREAT: install.sh creates the log; a missing log is an install fault.
  int fd = open(LIMEN_FILE, O_WRONLY | O_APPEND);
  if (fd < 0) {
    fputs("limen: log unavailable (run limen/install.sh)\n", stderr);
    return 74;
  }
  ssize_t wrote = write(fd, line, (size_t)len);
  close(fd);
  if (wrote != len) {
    fputs("limen: write failed\n", stderr);
    return 74;
  }
  puts("noted");
  return 0;
}
