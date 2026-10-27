/* Adapted from 41ac9ce: macOS metadata and generation-bound signals. No command or environment capture. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <dlfcn.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <poll.h>
#include <time.h>

typedef int (*signal_token_fn)(audit_token_t *, int);
static int info(pid_t pid, struct proc_bsdinfo *value) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, value, sizeof(*value)) == sizeof(*value);
}
static int token_for(pid_t pid, audit_token_t *token) {
  mach_port_name_t task = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &task) != KERN_SUCCESS) return 0;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t result = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)token, &count);
  mach_port_deallocate(mach_task_self(), task);
  return result == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT && token->val[5] == (uint32_t)pid;
}
static void birth_string(const struct proc_bsdinfo *value, char *birth, size_t size) {
  snprintf(birth, size, "%llu:%llu", (unsigned long long)value->pbi_start_tvsec,
    (unsigned long long)value->pbi_start_tvusec);
}
static int capability(signal_token_fn signal_token) {
  audit_token_t token;
  if (!signal_token || !token_for(getpid(), &token) || signal_token(&token, SIGCONT) != 0) return 0;
  /* A kernel generation mismatch must refuse the signal, even for a live numeric PID. */
  token.val[7] ^= 1;
  return signal_token(&token, SIGCONT) == ESRCH;
}
static int inventory(void) {
  pid_t *pids = NULL;
  int actual = 0, bytes = 0;
  for (int attempt = 0; attempt < 3; attempt++) {
    int required = proc_listpids(PROC_UID_ONLY, geteuid(), NULL, 0);
    if (required <= 0 || required > 16 * 1024 * 1024) return 2;
    bytes = required + 4096 * (int)sizeof(pid_t);
    free(pids); pids = calloc(1, (size_t)bytes);
    if (!pids) return 2;
    actual = proc_listpids(PROC_UID_ONLY, geteuid(), pids, bytes);
    if (actual > 0 && actual < bytes && actual % sizeof(pid_t) == 0) break;
    actual = 0;
  }
  if (!actual) { free(pids); return 2; }
  printf("{\"complete\":true,\"processes\":["); int separator = 0;
  for (int i = 0; i < actual / (int)sizeof(pid_t); i++) {
    struct proc_bsdinfo value, checked;
    if (pids[i] <= 1) continue;
    if (!info(pids[i], &value)) {
      /* ESRCH is a vanished process, never authority to signal it. */
      if (errno == ESRCH) continue;
      printf("%s{\"pid\":%d,\"unavailable\":true}", separator++ ? "," : "", pids[i]);
      continue;
    }
    if (value.pbi_uid != geteuid()) continue;
    pid_t session = getsid(pids[i]);
    if (session < 0 || !info(pids[i], &checked) || checked.pbi_start_tvsec != value.pbi_start_tvsec ||
        checked.pbi_start_tvusec != value.pbi_start_tvusec || checked.pbi_ppid != value.pbi_ppid) {
      if (errno == ESRCH) continue;
      printf("%s{\"pid\":%d,\"unavailable\":true}", separator++ ? "," : "", pids[i]);
      continue;
    }
    printf("%s{\"pid\":%u,\"parent\":%u,\"session\":%d,\"birth\":\"%llu:%llu\",\"zombie\":%s,\"stopped\":%s}",
      separator++ ? "," : "", value.pbi_pid, value.pbi_ppid, session,
      (unsigned long long)value.pbi_start_tvsec, (unsigned long long)value.pbi_start_tvusec,
      value.pbi_status == 5 ? "true" : "false", value.pbi_status == 4 ? "true" : "false");
  }
  puts("]}"); free(pids); return 0;
}
int main(int argc, char **argv) {
  signal_token_fn signal_token = (signal_token_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  if (argc == 2 && !strcmp(argv[1], "probe")) {
    if (!capability(signal_token)) return 5;
    puts("audit-token-v1"); return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "list")) return inventory();
  if (argc >= 4 && !strcmp(argv[1], "bootstrap")) {
    if (!signal_token || strlen(argv[2]) != 36) return 2;
    for (int i = 0; i < 36; i++) if (!((argv[2][i] >= '0' && argv[2][i] <= '9') || (argv[2][i] >= 'a' && argv[2][i] <= 'f') || argv[2][i] == '-')) return 2;
    struct proc_bsdinfo value;
    audit_token_t token;
    if (!info(getpid(), &value) || !token_for(getpid(), &token) || getsid(0) != getpid()) return 3;
    struct termios saved, raw;
    if (tcgetattr(STDIN_FILENO, &saved) != 0) return 3;
    raw = saved; cfmakeraw(&raw);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0) return 3;
    printf("\036%s:{\"pid\":%d,\"session\":%d,\"birth\":\"%llu:%llu\"}\037", argv[2], getpid(), getsid(0),
      (unsigned long long)value.pbi_start_tvsec, (unsigned long long)value.pbi_start_tvusec);
    if (fflush(stdout) != 0) return 3;
    /* No parent acknowledgement means no stop and no exec. A lost handshake self-expires. */
    char acknowledgement[65] = {0}; size_t length = strlen(argv[2]), received = 0;
    struct timespec began, now; clock_gettime(CLOCK_MONOTONIC, &began);
    while (received < length) {
      clock_gettime(CLOCK_MONOTONIC, &now);
      long elapsed = (now.tv_sec - began.tv_sec) * 1000 + (now.tv_nsec - began.tv_nsec) / 1000000;
      if (elapsed >= 2000) return 3;
      struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
      if (poll(&input, 1, (int)(2000 - elapsed)) <= 0 || !(input.revents & POLLIN)) return 3;
      ssize_t count = read(STDIN_FILENO, acknowledgement + received, length - received);
      if (count <= 0) return 3;
      received += (size_t)count;
    }
    if (memcmp(acknowledgement, argv[2], length) || tcsetattr(STDIN_FILENO, TCSANOW, &saved) != 0 || signal_token(&token, SIGSTOP) != 0) return 3;
    execv(argv[3], &argv[3]);
    return 127;
  }
  if (argc == 4 && !strcmp(argv[1], "status")) {
    char *end = NULL; long pid = strtol(argv[2], &end, 10);
    if (!end || *end || pid <= 1 || pid > INT32_MAX) return 2;
    struct proc_bsdinfo value; errno = 0;
    if (!info((pid_t)pid, &value)) {
      puts(errno == ESRCH ? "{\"state\":\"exited\"}" : "{\"state\":\"unavailable\"}"); return 0;
    }
    char birth[64]; birth_string(&value, birth, sizeof(birth));
    if (strcmp(birth, argv[3])) { puts("{\"state\":\"replaced\"}"); return 0; }
    pid_t session = getsid((pid_t)pid);
    if (session <= 0) { puts("{\"state\":\"unavailable\"}"); return 0; }
    printf("{\"state\":\"alive\",\"process\":{\"pid\":%u,\"parent\":%u,\"session\":%d,\"birth\":\"%s\",\"zombie\":%s,\"stopped\":%s}}\n",
      value.pbi_pid, value.pbi_ppid, session, birth, value.pbi_status == 5 ? "true" : "false", value.pbi_status == 4 ? "true" : "false");
    return 0;
  }
  if (argc == 5 && (!strcmp(argv[1], "kill") || !strcmp(argv[1], "resume"))) {
    if (!signal_token) return 5;
    char *end = NULL; long pid = strtol(argv[2], &end, 10);
    if (!end || *end || pid <= 1 || pid > INT32_MAX) return 2;
    long session = strtol(argv[4], &end, 10);
    if (!end || *end || session <= 0 || session > INT32_MAX) return 2;
    struct proc_bsdinfo value;
    if (!info((pid_t)pid, &value)) return errno == ESRCH ? 0 : 3;
    char birth[64]; birth_string(&value, birth, sizeof(birth));
    if (strcmp(birth, argv[3]) || getsid((pid_t)pid) != session) return 4;
    audit_token_t token;
    if (!token_for((pid_t)pid, &token)) return 3;
    /* Bind the retained birth/session after acquiring the generation-bearing task identity. */
    if (!info((pid_t)pid, &value)) return errno == ESRCH ? 0 : 3;
    birth_string(&value, birth, sizeof(birth));
    if (strcmp(birth, argv[3]) || getsid((pid_t)pid) != session) return 4;
    int result = signal_token(&token, !strcmp(argv[1], "resume") ? SIGCONT : SIGKILL);
    if (result != 0 && result != ESRCH) return 3;
    return 0;
  }
  return 2;
}
