/* SPDX-License-Identifier: Apache-2.0
 * One PTY session's child subreaper. Only unreaped direct children are signaled.
 */
#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_PIDS 4096
#define CHILD_BYTES 65536
static volatile sig_atomic_t interrupted;
static pid_t primary;
static int primary_exit = -1;
static int control = -1;
static int start_gate = -1;
static pid_t verified[MAX_PIDS];
static size_t verified_count;

static void stop_signal(int sig) { (void)sig; interrupted = 1; }
static int64_t now_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int send_text(const char *text) {
  size_t left = strlen(text);
  while (left) {
    ssize_t written = send(control, text, left, MSG_NOSIGNAL);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    text += written; left -= (size_t)written;
  }
  return 0;
}
static void send_error(const char *code) {
  char line[160];
  snprintf(line, sizeof(line), "{\"type\":\"error\",\"code\":\"%s\"}\n", code);
  (void)send_text(line);
}
static int remember(pid_t pid) {
  for (size_t i = 0; i < verified_count; i++) if (verified[i] == pid) return 0;
  if (verified_count == MAX_PIDS) return -1;
  verified[verified_count++] = pid;
  return 0;
}
static int pidfd(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }
static int signal_fd(int fd, int sig) { return (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0); }

/* No waitpid runs between this snapshot and pidfd_open. Even an exited child
 * retains its PID as a zombie until this supervisor reaps it. */
static int kill_direct_children(void) {
  char file[96], text[CHILD_BYTES + 1];
  snprintf(file, sizeof(file), "/proc/self/task/%ld/children", (long)getpid());
  int descriptor = open(file, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return -1;
  size_t used = 0;
  while (used < CHILD_BYTES) {
    ssize_t count = read(descriptor, text + used, CHILD_BYTES - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { close(descriptor); return -1; }
    if (!count) break;
    used += (size_t)count;
  }
  char extra;
  ssize_t tail = read(descriptor, &extra, 1);
  close(descriptor);
  if (tail != 0) return -1;
  text[used] = '\0';
  char *next = text;
  while (*next) {
    while (*next == ' ' || *next == '\n') next++;
    if (!*next) break;
    char *end;
    errno = 0;
    long value = strtol(next, &end, 10);
    if (errno || end == next || value <= 1 || value > INT32_MAX || (*end && *end != ' ' && *end != '\n')) return -1;
    pid_t child = (pid_t)value;
    int descriptor_pid = pidfd(child);
    if (descriptor_pid < 0) return -1;
    if (remember(child)) { close(descriptor_pid); return -1; }
    int result = signal_fd(descriptor_pid, SIGKILL);
    int error = errno;
    close(descriptor_pid);
    if (result && error != ESRCH) return -1;
    next = end;
  }
  return 0;
}

/* ECHILD is the completion proof: a living descendant always has a living
 * direct ancestor, or is adopted here before its last intermediate parent exits. */
static int reap_children(void) {
  for (;;) {
    int status;
    pid_t child = waitpid(-1, &status, WNOHANG);
    if (child > 0) {
      if (child == primary) primary_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      continue;
    }
    if (!child) return 1;
    if (errno == EINTR) continue;
    return errno == ECHILD ? 0 : -1;
  }
}
static int finish(void) {
  char line[65536];
  int length = snprintf(line, sizeof(line), "{\"type\":\"done\",\"exitCode\":%d,\"verifiedPids\":[", primary_exit < 0 ? 1 : primary_exit);
  if (length < 0) return -1;
  size_t used = (size_t)length;
  for (size_t i = 0; i < verified_count; i++) {
    length = snprintf(line + used, sizeof(line) - used, "%s%ld", i ? "," : "", (long)verified[i]);
    if (length < 0 || (size_t)length >= sizeof(line) - used) return -1;
    used += (size_t)length;
  }
  if (used + 4 >= sizeof(line)) return -1;
  memcpy(line + used, "]}\n", 4);
  return send_text(line);
}
static int connect_control(const char *file) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (!*file || strlen(file) >= sizeof(address.sun_path)) return -1;
  memcpy(address.sun_path, file, strlen(file) + 1);
  int descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor < 0) return -1;
  const struct timeval timeout = { .tv_sec = 2, .tv_usec = 0 };
  if (setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) { close(descriptor); return -1; }
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address))) { close(descriptor); return -1; }
  return descriptor;
}
static void reset_child_signals(void) {
  const int signals[] = { SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGTSTP, SIGTTIN, SIGTTOU, SIGCHLD, SIGPIPE };
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) signal(signals[i], SIG_DFL);
}
static int launch(char **arguments) {
  int gate[2];
  if (pipe2(gate, O_CLOEXEC)) return -1;
  primary = fork();
  if (primary < 0) { close(gate[0]); close(gate[1]); return -1; }
  if (!primary) {
    close(control); close(gate[1]);
    char released;
    ssize_t received;
    do { received = read(gate[0], &released, 1); } while (received < 0 && errno == EINTR);
    close(gate[0]);
    if (received != 1 || released != 'x') _exit(125);
    reset_child_signals();
    if (setpgid(0, 0)) _exit(126);
    (void)tcsetpgrp(STDIN_FILENO, getpid());
    execv(arguments[0], arguments);
    _exit(127);
  }
  close(gate[0]); start_gate = gate[1];
  if (setpgid(primary, primary) && errno != EACCES && errno != ESRCH) return -1;
  (void)tcsetpgrp(STDIN_FILENO, primary);
  return remember(primary);
}

int main(int argc, char **argv) {
  if (argc < 4 || strlen(argv[2]) != 64 || strspn(argv[2], "0123456789abcdef") != 64) return 64;
  signal(SIGPIPE, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGQUIT, SIG_IGN);
  signal(SIGCHLD, SIG_DFL);
  signal(SIGTSTP, SIG_IGN); signal(SIGTTIN, SIG_IGN); signal(SIGTTOU, SIG_IGN);
  signal(SIGHUP, stop_signal); signal(SIGTERM, stop_signal);
  control = connect_control(argv[1]);
  if (control < 0) return 70;
  int descriptor = pidfd(getpid());
  if (descriptor < 0 || signal_fd(descriptor, 0) || prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) {
    if (descriptor >= 0) close(descriptor);
    send_error("LINUX_SUPERVISION_UNAVAILABLE"); return 70;
  }
  close(descriptor);
  if (remember(getpid())) return 70;
  char hello[256];
  snprintf(hello, sizeof(hello), "{\"type\":\"hello\",\"token\":\"%s\",\"pid\":%ld}\n", argv[2], (long)getpid());
  if (send_text(hello)) return 70;
  char command[64]; size_t used = 0;
  int launched = 0, stopping = 0, exit_sent = 0, disconnected = 0;
  int64_t deadline = now_ms() + 7000;
  for (;;) {
    if (interrupted && !stopping) { stopping = 1; deadline = now_ms() + 10000; }
    if (launched && stopping && kill_direct_children()) {
      send_error("STOP_METADATA_OR_SIGNAL_FAILED"); stopping = disconnected ? 1 : 0;
    }
    int remaining = launched ? reap_children() : 0;
    if (remaining < 0) { send_error("STOP_WAIT_FAILED"); stopping = disconnected ? 1 : 0; }
    if (primary_exit >= 0 && !exit_sent) {
      char line[128];
      snprintf(line, sizeof(line), "{\"type\":\"exit\",\"exitCode\":%d,\"cleanupRequired\":%s}\n", primary_exit, remaining ? "true" : "false");
      (void)send_text(line); exit_sent = 1;
    }
    if (launched && remaining == 0 && primary_exit >= 0) { (void)finish(); close(control); return primary_exit; }
    if (!launched && stopping) { close(control); return 0; }
    if (now_ms() >= deadline && (!launched || stopping)) {
      send_error(launched ? "STOP_TREE_TIMEOUT" : "PTY_START_TIMEOUT");
      if (!launched) { close(control); return 70; }
      stopping = disconnected ? 1 : 0; deadline = now_ms() + 10000;
    }
    struct pollfd event = { .fd = disconnected ? -1 : control, .events = POLLIN };
    int status = poll(&event, 1, 20);
    if (status < 0 && errno != EINTR) { disconnected = 1; stopping = 1; deadline = now_ms() + 10000; }
    if (status <= 0 || disconnected) continue;
    if (event.revents & (POLLIN | POLLHUP | POLLERR)) {
      char bytes[64]; ssize_t count = recv(control, bytes, sizeof(bytes), MSG_DONTWAIT);
      if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      if (count <= 0) { disconnected = 1; stopping = 1; deadline = now_ms() + 10000; continue; }
      for (ssize_t i = 0; i < count; i++) {
        if (bytes[i] != '\n') {
          if (used + 1 == sizeof(command)) { disconnected = 1; stopping = 1; deadline = now_ms() + 10000; break; }
          command[used++] = bytes[i]; continue;
        }
        command[used] = '\0'; used = 0;
        if (!strcmp(command, "start") && !launched) {
          if (launch(&argv[3])) { send_error("PTY_LAUNCH_FAILED"); stopping = 1; deadline = now_ms() + 10000; }
          launched = primary > 0;
          if (launched) {
            char line[96]; snprintf(line, sizeof(line), "{\"type\":\"started\",\"primaryPid\":%ld}\n", (long)primary);
            (void)send_text(line);
          }
        } else if (!strcmp(command, "run") && launched && start_gate >= 0 && !stopping) {
          if (write(start_gate, "x", 1) != 1) { send_error("PTY_LAUNCH_FAILED"); stopping = 1; deadline = now_ms() + 10000; }
          close(start_gate); start_gate = -1;
        } else if (!strcmp(command, "stop")) { stopping = 1; deadline = now_ms() + 10000; }
        else { send_error("CONTROL_COMMAND_INVALID"); disconnected = 1; stopping = 1; deadline = now_ms() + 10000; }
      }
    }
  }
}
