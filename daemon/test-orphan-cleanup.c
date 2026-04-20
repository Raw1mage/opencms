/*
 * test-orphan-cleanup.c — Unit test for detect_lock_holder_pid +
 * cleanup_orphan_daemon.
 *
 * Covers spec safe-daemon-restart TV-5 (orphan cleanup path). End-to-end
 * acceptance (TV-2, A2 manual) is exercised separately against the real
 * gateway; this harness validates the helper contract in isolation.
 *
 * Build:  cc -O2 -Wall -Wextra -D_GNU_SOURCE -o test-orphan-cleanup test-orphan-cleanup.c
 * Run:    ./test-orphan-cleanup  (exit 0 = pass)
 *
 * Functions under test are re-declared here identically to opencode-gateway.c
 * (intentional duplication to keep the production binary free of test hooks).
 * If signatures drift, update both or extract to a shared header.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <limits.h>
#include <time.h>
#include <pwd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>

#define LOGI(fmt, ...) fprintf(stderr, "[INFO ] " fmt "\n", ##__VA_ARGS__)
#define LOGW(fmt, ...) fprintf(stderr, "[WARN ] " fmt "\n", ##__VA_ARGS__)
#define LOGE(fmt, ...) fprintf(stderr, "[ERROR] " fmt "\n", ##__VA_ARGS__)

/* ─── Functions under test (mirror of opencode-gateway.c) ────── */

static pid_t detect_lock_holder_pid(const char *username, uid_t target_uid) {
    struct passwd *pw = getpwnam(username);
    if (!pw) return -1;

    char lock_path[512];
    snprintf(lock_path, sizeof(lock_path), "%s/.config/opencode/daemon.lock", pw->pw_dir);

    int fd = open(lock_path, O_RDONLY);
    if (fd < 0) return -1;
    char buf[512];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return -1;
    buf[n] = '\0';

    const char *p = strstr(buf, "\"pid\"");
    if (!p) return -1;
    p = strchr(p, ':');
    if (!p) return -1;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n') p++;
    long pid_l = strtol(p, NULL, 10);
    if (pid_l <= 1 || pid_l > INT_MAX) return -1;
    pid_t pid = (pid_t)pid_l;

    if (kill(pid, 0) != 0) return -1;

    char proc_path[64];
    snprintf(proc_path, sizeof(proc_path), "/proc/%d", (int)pid);
    struct stat pst;
    if (stat(proc_path, &pst) != 0) return -1;
    if (pst.st_uid != target_uid) {
        LOGW("lock-holder pid=%d has uid=%u, expected uid=%u (ignoring)",
             (int)pid, pst.st_uid, target_uid);
        return -1;
    }
    return pid;
}

static int cleanup_orphan_daemon(pid_t pid, const char *username, uid_t target_uid) {
    (void)username;
    char proc_path[64];
    snprintf(proc_path, sizeof(proc_path), "/proc/%d", (int)pid);
    struct stat pst;
    if (stat(proc_path, &pst) != 0) {
        LOGI("orphan-cleanup uid=%u holderPid=%d result=already-gone", target_uid, (int)pid);
        return 0;
    }
    if (pst.st_uid != target_uid) {
        LOGE("orphan-cleanup refused: pid=%d uid=%u != target_uid=%u",
             (int)pid, pst.st_uid, target_uid);
        return -1;
    }

    if (kill(pid, SIGTERM) != 0) {
        if (errno == ESRCH) return 0;
        LOGE("orphan-cleanup SIGTERM pid=%d failed: %s", (int)pid, strerror(errno));
        return -1;
    }

    for (int waited = 0; waited < 1000; waited += 50) {
        struct timespec ts = { .tv_sec = 0, .tv_nsec = 50 * 1000000L };
        nanosleep(&ts, NULL);
        (void)waitpid(pid, NULL, WNOHANG);
        if (kill(pid, 0) != 0) return 0;
    }
    LOGW("orphan-cleanup pid=%d escalating to SIGKILL", (int)pid);
    if (kill(pid, SIGKILL) != 0 && errno != ESRCH) return -1;
    for (int waited = 0; waited < 500; waited += 50) {
        struct timespec ts = { .tv_sec = 0, .tv_nsec = 50 * 1000000L };
        nanosleep(&ts, NULL);
        (void)waitpid(pid, NULL, WNOHANG);
        if (kill(pid, 0) != 0) return 0;
    }
    return -1;
}

/* ─── Test fixture helpers ─────────────────────────────────────── */

static int write_fake_lock(const char *username, pid_t pid) {
    struct passwd *pw = getpwnam(username);
    if (!pw) { LOGE("getpwnam(%s) failed", username); return -1; }
    char dir[512], file[512];
    snprintf(dir, sizeof(dir), "%s/.config/opencode", pw->pw_dir);
    snprintf(file, sizeof(file), "%s/daemon.lock", dir);
    mkdir(pw->pw_dir, 0755);
    char cfgdir[512];
    snprintf(cfgdir, sizeof(cfgdir), "%s/.config", pw->pw_dir);
    mkdir(cfgdir, 0755);
    mkdir(dir, 0755);
    int fd = open(file, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { LOGE("open %s: %s", file, strerror(errno)); return -1; }
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"pid\":%d,\"acquiredAtMs\":0}\n", (int)pid);
    if (write(fd, buf, n) != n) { close(fd); return -1; }
    close(fd);
    return 0;
}

static int remove_fake_lock(const char *username) {
    struct passwd *pw = getpwnam(username);
    if (!pw) return -1;
    char file[512];
    snprintf(file, sizeof(file), "%s/.config/opencode/daemon.lock", pw->pw_dir);
    unlink(file);
    return 0;
}

/* Backup + restore any pre-existing daemon.lock so the test never
 * corrupts a real daemon state. */
static int backup_real_lock(const char *username, char *backup_path, size_t n) {
    struct passwd *pw = getpwnam(username);
    if (!pw) return -1;
    char src[512];
    snprintf(src, sizeof(src), "%s/.config/opencode/daemon.lock", pw->pw_dir);
    snprintf(backup_path, n, "%s/.config/opencode/daemon.lock.test-backup", pw->pw_dir);
    if (rename(src, backup_path) == 0) return 1;
    if (errno == ENOENT) return 0;
    return -1;
}
static void restore_real_lock(const char *username, const char *backup_path) {
    struct passwd *pw = getpwnam(username);
    if (!pw) return;
    char dst[512];
    snprintf(dst, sizeof(dst), "%s/.config/opencode/daemon.lock", pw->pw_dir);
    if (access(backup_path, F_OK) == 0) {
        rename(backup_path, dst);
    }
}

/* ─── Tests ────────────────────────────────────────────────────── */

static int g_failed = 0;
#define ASSERT(cond, msg) do { \
    if (!(cond)) { fprintf(stderr, "  FAIL: %s\n", msg); g_failed++; } \
    else         { fprintf(stderr, "  ok:   %s\n", msg); } \
} while (0)

static pid_t spawn_sleeper(void) {
    pid_t p = fork();
    if (p == 0) {
        /* child: sleep long enough for tests to signal */
        execlp("sleep", "sleep", "60", (char *)NULL);
        _exit(127);
    }
    return p;
}

static void test_detect_returns_pid_when_alive(const char *user, uid_t uid) {
    fprintf(stderr, "\n== test_detect_returns_pid_when_alive ==\n");
    pid_t sleeper = spawn_sleeper();
    ASSERT(sleeper > 0, "spawn sleeper");
    write_fake_lock(user, sleeper);

    pid_t got = detect_lock_holder_pid(user, uid);
    ASSERT(got == sleeper, "detect returns sleeper pid");

    kill(sleeper, SIGKILL);
    int st; waitpid(sleeper, &st, 0);
    remove_fake_lock(user);
}

static void test_detect_returns_neg1_when_stale(const char *user, uid_t uid) {
    fprintf(stderr, "\n== test_detect_returns_neg1_when_stale ==\n");
    pid_t sleeper = spawn_sleeper();
    kill(sleeper, SIGKILL);
    int st; waitpid(sleeper, &st, 0);
    write_fake_lock(user, sleeper);

    pid_t got = detect_lock_holder_pid(user, uid);
    ASSERT(got == -1, "detect returns -1 for dead pid");

    remove_fake_lock(user);
}

static void test_detect_returns_neg1_when_no_file(const char *user, uid_t uid) {
    fprintf(stderr, "\n== test_detect_returns_neg1_when_no_file ==\n");
    remove_fake_lock(user);
    pid_t got = detect_lock_holder_pid(user, uid);
    ASSERT(got == -1, "detect returns -1 when no lock file");
}

static void test_cleanup_terminates_on_sigterm(const char *user, uid_t uid) {
    fprintf(stderr, "\n== test_cleanup_terminates_on_sigterm ==\n");
    pid_t sleeper = spawn_sleeper();
    ASSERT(sleeper > 0, "spawn sleeper");
    int rc = cleanup_orphan_daemon(sleeper, user, uid);
    ASSERT(rc == 0, "cleanup returns 0");
    ASSERT(kill(sleeper, 0) != 0, "sleeper is gone");
    int st; waitpid(sleeper, &st, 0);
}

static void test_cleanup_escalates_to_sigkill(const char *user, uid_t uid) {
    fprintf(stderr, "\n== test_cleanup_escalates_to_sigkill ==\n");
    /* fork a child that ignores SIGTERM and only dies on SIGKILL */
    pid_t p = fork();
    if (p == 0) {
        signal(SIGTERM, SIG_IGN);
        /* loop so SIGKILL is needed */
        for (;;) pause();
    }
    ASSERT(p > 0, "spawn SIGTERM-ignoring child");
    /* give child a moment to install the signal handler */
    struct timespec ts = { .tv_sec = 0, .tv_nsec = 100 * 1000000L };
    nanosleep(&ts, NULL);
    int rc = cleanup_orphan_daemon(p, user, uid);
    ASSERT(rc == 0, "cleanup returns 0 after SIGKILL");
    ASSERT(kill(p, 0) != 0, "child is gone");
    int st; waitpid(p, &st, 0);
}

int main(void) {
    struct passwd *pw = getpwuid(getuid());
    if (!pw) { fprintf(stderr, "getpwuid failed\n"); return 2; }
    const char *user = pw->pw_name;
    uid_t uid = pw->pw_uid;
    fprintf(stderr, "running as user=%s uid=%u\n", user, uid);

    char backup_path[512];
    int had_real_lock = backup_real_lock(user, backup_path, sizeof(backup_path));
    if (had_real_lock < 0) { fprintf(stderr, "backup failed; aborting\n"); return 2; }

    test_detect_returns_neg1_when_no_file(user, uid);
    test_detect_returns_pid_when_alive(user, uid);
    test_detect_returns_neg1_when_stale(user, uid);
    test_cleanup_terminates_on_sigterm(user, uid);
    test_cleanup_escalates_to_sigkill(user, uid);

    if (had_real_lock == 1) restore_real_lock(user, backup_path);

    if (g_failed) {
        fprintf(stderr, "\n%d test(s) FAILED\n", g_failed);
        return 1;
    }
    fprintf(stderr, "\nAll tests passed.\n");
    return 0;
}
