/*
 * opencode-gateway — C root daemon
 *
 * Architecture:
 *   - Binds TCP :1080 (configurable via OPENCODE_GATEWAY_PORT)
 *   - Serves login.html on GET /
 *   - Accepts POST /auth/login → PAM auth → signs JWT cookie
 *   - JWT valid → finds/spawns per-user daemon → splice() proxy
 *
 * @event_20260319_daemonization Phase α
 *
 * Build:
 *   gcc -O2 -Wall -D_GNU_SOURCE -o opencode-gateway opencode-gateway.c \
 *       -lpam -lpam_misc -lcrypto
 *
 * Requires: libpam-dev, libssl-dev
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/sendfile.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <pwd.h>
#include <grp.h>
#include <security/pam_appl.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

/* ─── Configuration ─────────────────────────────────────────────── */
#define GATEWAY_PORT_DEFAULT  1080
#define BACKLOG               128
#define MAX_EVENTS            256
#define PIPE_BUF_SIZE         65536
#define JWT_SECRET_LEN        32
#define JWT_EXP_SECONDS       (8 * 3600)   /* 8 hours */
#define DAEMON_WAIT_MS        5000          /* max wait for per-user daemon socket */
#define MAX_USERS             64

/* ─── Logging ────────────────────────────────────────────────────── */
#define LOG(level, fmt, ...) \
    do { \
        time_t _t = time(NULL); \
        struct tm _tm; localtime_r(&_t, &_tm); \
        char _ts[20]; strftime(_ts, sizeof(_ts), "%H:%M:%S", &_tm); \
        fprintf(stderr, "[%s] [" level "] " fmt "\n", _ts, ##__VA_ARGS__); \
    } while (0)
#define LOGI(fmt, ...) LOG("INFO ", fmt, ##__VA_ARGS__)
#define LOGW(fmt, ...) LOG("WARN ", fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) LOG("ERROR", fmt, ##__VA_ARGS__)

/* ─── Per-user daemon registry ───────────────────────────────────── */
typedef enum { DAEMON_NONE, DAEMON_STARTING, DAEMON_READY, DAEMON_DEAD } DaemonState;

typedef struct {
    uid_t uid;
    gid_t gid;
    char  username[64];
    char  socket_path[256];
    pid_t pid;
    DaemonState state;
} DaemonInfo;

static DaemonInfo g_daemons[MAX_USERS];
static int        g_ndaemons = 0;

/* ─── Connection tracking ────────────────────────────────────────── */
typedef struct {
    int  client_fd;
    int  daemon_fd;
    int  pipe_c2d[2];  /* client → daemon splice pipe */
    int  pipe_d2c[2];  /* daemon → client splice pipe */
} Connection;

#define MAX_CONNS 1024
static Connection g_conns[MAX_CONNS];
static int        g_nconns = 0;

/* ─── Global state ───────────────────────────────────────────────── */
static int    g_listen_fd   = -1;
static int    g_epoll_fd    = -1;
static int    g_running     = 1;
static uint8_t g_jwt_secret[JWT_SECRET_LEN];
static char   g_login_html[65536];
static size_t g_login_html_len = 0;
static char   g_opencode_bin[512] = "/usr/local/bin/opencode";

/* ─── Signal handling ────────────────────────────────────────────── */
static void on_sigterm(int sig) { (void)sig; g_running = 0; }

static void on_sigchld(int sig) {
    (void)sig;
    int saved = errno;
    pid_t pid;
    int status;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        for (int i = 0; i < g_ndaemons; i++) {
            if (g_daemons[i].pid == pid) {
                LOGW("per-user daemon for %s (pid %d) exited", g_daemons[i].username, pid);
                g_daemons[i].state = DAEMON_DEAD;
                g_daemons[i].pid   = -1;
            }
        }
    }
    errno = saved;
}

/* ─── Utility: set fd non-blocking ──────────────────────────────── */
static int set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void reset_daemon_state(DaemonInfo *d) {
    d->pid = -1;
    d->state = DAEMON_NONE;
}

/* ─── Utility: simple URL-decode (in-place) ─────────────────────── */
static void url_decode(char *dst, const char *src, size_t dstlen) {
    size_t i = 0;
    while (*src && i + 1 < dstlen) {
        if (*src == '%' && src[1] && src[2]) {
            char hex[3] = { src[1], src[2], 0 };
            dst[i++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else if (*src == '+') {
            dst[i++] = ' ';
            src++;
        } else {
            dst[i++] = *src++;
        }
    }
    dst[i] = '\0';
}

/* ─── JWT (HMAC-SHA256, minimal subset) ─────────────────────────── */
/* Base64url encoding (no padding) */
static void b64url_encode(const uint8_t *in, size_t inlen, char *out, size_t *outlen) {
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < inlen; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i+1 < inlen) v |= (uint32_t)in[i+1] << 8;
        if (i+2 < inlen) v |= in[i+2];
        out[o++] = tbl[(v >> 18) & 0x3f];
        out[o++] = tbl[(v >> 12) & 0x3f];
        out[o++] = (i+1 < inlen) ? tbl[(v >> 6) & 0x3f] : '=';
        out[o++] = (i+2 < inlen) ? tbl[v & 0x3f] : '=';
    }
    out[o] = '\0';
    /* convert to base64url */
    for (size_t k = 0; k < o; k++) {
        if (out[k] == '+') out[k] = '-';
        else if (out[k] == '/') out[k] = '_';
        else if (out[k] == '=') { out[k] = '\0'; o = k; break; }
    }
    if (outlen) *outlen = o;
}

static int b64url_decode(const char *in, uint8_t *out, size_t outcap, size_t *outlen) {
    char tmp[1024];
    size_t len = strlen(in);
    if (len >= sizeof(tmp) - 4) return 0;
    memcpy(tmp, in, len + 1);
    for (size_t i = 0; i < len; i++) {
        if (tmp[i] == '-') tmp[i] = '+';
        else if (tmp[i] == '_') tmp[i] = '/';
    }
    size_t pad = (4 - (len % 4)) % 4;
    for (size_t i = 0; i < pad; i++) tmp[len + i] = '=';
    tmp[len + pad] = '\0';

    int decoded = EVP_DecodeBlock(out, (const unsigned char *)tmp, (int)(len + pad));
    if (decoded < 0) return 0;
    size_t actual = (size_t)decoded;
    while (pad > 0 && actual > 0) {
        actual--;
        pad--;
    }
    if (actual >= outcap) return 0;
    out[actual] = '\0';
    if (outlen) *outlen = actual;
    return 1;
}

static int json_extract_string(const char *json, const char *key, char *out, size_t outlen) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    char *start = strstr(json, pattern);
    if (!start) return 0;
    start += strlen(pattern);
    char *end = strchr(start, '"');
    if (!end) return 0;
    size_t len = (size_t)(end - start);
    if (len == 0 || len >= outlen) return 0;
    memcpy(out, start, len);
    out[len] = '\0';
    return 1;
}

static int json_extract_long(const char *json, const char *key, long *out) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    char *start = strstr(json, pattern);
    char *endptr = NULL;
    long value;
    if (!start) return 0;
    start += strlen(pattern);
    errno = 0;
    value = strtol(start, &endptr, 10);
    if (errno != 0 || endptr == start) return 0;
    *out = value;
    return 1;
}

static void jwt_sign(const char *payload, char *out_token, size_t toklen) {
    /* header.payload */
    const char *header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; /* {"alg":"HS256","typ":"JWT"} */
    char pay64[512];
    size_t pay64len;
    b64url_encode((const uint8_t *)payload, strlen(payload), pay64, &pay64len);

    char msg[1024];
    snprintf(msg, sizeof(msg), "%s.%s", header, pay64);

    uint8_t sig[32];
    unsigned int siglen = 32;
    HMAC(EVP_sha256(), g_jwt_secret, JWT_SECRET_LEN,
         (const uint8_t *)msg, strlen(msg), sig, &siglen);

    char sig64[64];
    size_t sig64len;
    b64url_encode(sig, siglen, sig64, &sig64len);

    snprintf(out_token, toklen, "%s.%s", msg, sig64);
}

static int jwt_verify(const char *token, char *out_username, uid_t *out_uid) {
    char buf[1024];
    char msg[1024];
    char payload_json[512];
    uint8_t payload_raw[512];
    uint8_t sig[32];
    unsigned int siglen = 32;
    char sig64[64];
    size_t sig64len;
    size_t payload_len;
    long exp;
    char *dot1;
    char *dot2;
    struct passwd *pw;

    strncpy(buf, token, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    dot1 = strchr(buf, '.');
    if (!dot1) return 0;
    dot2 = strchr(dot1 + 1, '.');
    if (!dot2) return 0;

    *dot1 = '\0';
    *dot2 = '\0';
    size_t header_len = strlen(buf);
    size_t payload_b64_len = strlen(dot1 + 1);
    if (header_len + 1 + payload_b64_len >= sizeof(msg)) return 0;
    memcpy(msg, buf, header_len);
    msg[header_len] = '.';
    memcpy(msg + header_len + 1, dot1 + 1, payload_b64_len + 1);

    HMAC(EVP_sha256(), g_jwt_secret, JWT_SECRET_LEN,
         (const uint8_t *)msg, strlen(msg), sig, &siglen);
    b64url_encode(sig, siglen, sig64, &sig64len);
    if (strcmp(sig64, dot2 + 1) != 0) return 0;

    if (!b64url_decode(dot1 + 1, payload_raw, sizeof(payload_raw), &payload_len)) return 0;
    memcpy(payload_json, payload_raw, payload_len + 1);

    if (!json_extract_string(payload_json, "sub", out_username, 64)) return 0;
    if (!json_extract_long(payload_json, "exp", &exp)) return 0;
    if (exp <= (long)time(NULL)) return 0;

    pw = getpwnam(out_username);
    if (!pw) return 0;
    *out_uid = pw->pw_uid;
    return 1;
}

/* ─── PAM conversation ───────────────────────────────────────────── */
typedef struct { const char *password; } PamData;

static int pam_conversation(int num_msg, const struct pam_message **msg,
                             struct pam_response **resp, void *appdata) {
    PamData *pd = (PamData *)appdata;
    *resp = calloc((size_t)num_msg, sizeof(struct pam_response));
    if (!*resp) return PAM_BUF_ERR;
    for (int i = 0; i < num_msg; i++) {
        if (msg[i]->msg_style == PAM_PROMPT_ECHO_OFF ||
            msg[i]->msg_style == PAM_PROMPT_ECHO_ON) {
            (*resp)[i].resp = strdup(pd->password);
        }
    }
    return PAM_SUCCESS;
}

static int pam_authenticate_user(const char *username, const char *password) {
    PamData pd = { .password = password };
    struct pam_conv conv = { pam_conversation, &pd };
    pam_handle_t *pamh = NULL;
    int ret;

    ret = pam_start("login", username, &conv, &pamh);
    if (ret != PAM_SUCCESS) { LOGE("pam_start: %s", pam_strerror(pamh, ret)); return 0; }

    ret = pam_authenticate(pamh, PAM_SILENT);
    if (ret != PAM_SUCCESS) { LOGW("pam_authenticate failed for %s", username); pam_end(pamh, ret); return 0; }

    ret = pam_acct_mgmt(pamh, PAM_SILENT);
    if (ret != PAM_SUCCESS) { LOGW("pam_acct_mgmt failed for %s", username); pam_end(pamh, ret); return 0; }

    pam_end(pamh, PAM_SUCCESS);
    return 1;
}

/* ─── Per-user daemon management ─────────────────────────────────── */
static DaemonInfo *find_or_create_daemon(const char *username) {
    struct passwd *pw = getpwnam(username);
    if (!pw) { LOGE("user not found: %s", username); return NULL; }

    /* Find existing */
    for (int i = 0; i < g_ndaemons; i++) {
        if (g_daemons[i].uid == pw->pw_uid) return &g_daemons[i];
    }

    /* Create new entry */
    if (g_ndaemons >= MAX_USERS) { LOGE("too many users"); return NULL; }
    DaemonInfo *d = &g_daemons[g_ndaemons++];
    d->uid = pw->pw_uid;
    d->gid = pw->pw_gid;
    snprintf(d->username, sizeof(d->username), "%s", username);
    snprintf(d->socket_path, sizeof(d->socket_path),
             "/run/user/%u/opencode/daemon.sock", pw->pw_uid);
    d->pid   = -1;
    d->state = DAEMON_NONE;
    return d;
}

static int connect_unix(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    strncpy(addr.sun_path, path, sizeof(addr.sun_path)-1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(fd); return -1; }
    return fd;
}

static void cleanup_stale_runtime(DaemonInfo *d, const char *discovery_path, const char *reason) {
    LOGW("clearing stale daemon state for %s: %s", d->username, reason);
    if (discovery_path && discovery_path[0]) unlink(discovery_path);
    if (d->socket_path[0]) unlink(d->socket_path);
    reset_daemon_state(d);
}

static int wait_for_daemon_ready(DaemonInfo *d, pid_t pid, int timeout_ms) {
    struct timespec deadline, now;
    int last_connect_errno = 0;

    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_nsec += (long)timeout_ms * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000L; }

    while (1) {
        int status;
        pid_t waited = waitpid(pid, &status, WNOHANG);
        if (waited == pid) {
            LOGE("daemon for %s exited before readiness (pid %d, status %d)",
                 d->username, pid, status);
            reset_daemon_state(d);
            return 0;
        }
        if (waited < 0 && errno != ECHILD) {
            LOGE("waitpid readiness check failed for %s: %s", d->username, strerror(errno));
            reset_daemon_state(d);
            return 0;
        }

        struct stat st;
        if (stat(d->socket_path, &st) == 0 && S_ISSOCK(st.st_mode)) {
            int probe_fd = connect_unix(d->socket_path);
            if (probe_fd >= 0) {
                close(probe_fd);
                return 1;
            }
            last_connect_errno = errno;
        }

        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) {
            LOGE("daemon for %s did not become ready within %dms (last connect error: %s)",
                 d->username, timeout_ms,
                 last_connect_errno ? strerror(last_connect_errno) : "socket not present");
            reset_daemon_state(d);
            return 0;
        }
        usleep(100000);
    }
}

/**
 * Try to adopt an already-running daemon by reading its discovery file.
 * This covers daemons spawned by TUI --attach or other mechanisms.
 * Returns 1 if a live daemon was adopted into d, 0 otherwise.
 */
static int try_adopt_from_discovery(DaemonInfo *d) {
    char discovery_path[256];
    snprintf(discovery_path, sizeof(discovery_path),
             "/run/user/%u/opencode/daemon.json", d->uid);

    FILE *f = fopen(discovery_path, "r");
    if (!f) return 0;

    char buf[1024];
    size_t n = fread(buf, 1, sizeof(buf)-1, f);
    fclose(f);
    buf[n] = '\0';

    /* Minimal JSON parse: extract "socketPath" and "pid" */
    char *sp = strstr(buf, "\"socketPath\"");
    char *pp = strstr(buf, "\"pid\"");
    if (!sp || !pp) {
        cleanup_stale_runtime(d, discovery_path, "discovery file missing socketPath/pid");
        return 0;
    }

    /* socketPath value */
    char *colon = strchr(sp + 12, '"');
    if (!colon) {
        cleanup_stale_runtime(d, discovery_path, "discovery file has invalid socketPath");
        return 0;
    }
    colon++; /* skip opening quote */
    char *end = strchr(colon, '"');
    if (!end) {
        cleanup_stale_runtime(d, discovery_path, "discovery file has unterminated socketPath");
        return 0;
    }
    size_t pathlen = (size_t)(end - colon);
    if (pathlen == 0 || pathlen >= sizeof(d->socket_path)) {
        cleanup_stale_runtime(d, discovery_path, "discovery socketPath length invalid");
        return 0;
    }
    memcpy(d->socket_path, colon, pathlen);
    d->socket_path[pathlen] = '\0';

    /* pid value */
    char *pval = strchr(pp + 5, ':');
    if (!pval) {
        cleanup_stale_runtime(d, discovery_path, "discovery file missing pid value");
        return 0;
    }
    pid_t pid = (pid_t)atoi(pval + 1);
    if (pid <= 0) {
        cleanup_stale_runtime(d, discovery_path, "discovery pid invalid");
        return 0;
    }

    /* Verify PID is alive */
    if (kill(pid, 0) != 0) {
        cleanup_stale_runtime(d, discovery_path, "discovery pid is not alive");
        return 0;
    }

    int probe_fd = connect_unix(d->socket_path);
    if (probe_fd < 0) {
        char reason[256];
        snprintf(reason, sizeof(reason), "discovery socket is not connectable: %s", strerror(errno));
        cleanup_stale_runtime(d, discovery_path, reason);
        return 0;
    }
    close(probe_fd);

    d->pid   = pid;
    d->state = DAEMON_READY;
    LOGI("adopted existing daemon for %s (pid %d, socket %s)",
         d->username, pid, d->socket_path);
    return 1;
}

static int ensure_daemon_running(DaemonInfo *d) {
    if (d->state == DAEMON_READY) {
        /* Verify still alive */
        if (d->pid > 0 && kill(d->pid, 0) == 0) {
            int probe_fd = connect_unix(d->socket_path);
            if (probe_fd >= 0) {
                close(probe_fd);
                return 1;
            }
            LOGW("daemon for %s marked stale: socket connect failed: %s",
                 d->username, strerror(errno));
        } else {
            LOGW("daemon for %s marked stale: pid %d is not alive", d->username, d->pid);
        }
        d->state = DAEMON_DEAD;
    }

    if (d->state == DAEMON_DEAD || d->state == DAEMON_NONE) {
        /* Before spawning, check if a daemon was started externally (e.g. TUI --attach) */
        if (try_adopt_from_discovery(d)) return 1;

        /* Remove stale socket if any */
        unlink(d->socket_path);

        LOGI("spawning daemon for %s (uid %u)", d->username, d->uid);
        d->state = DAEMON_STARTING;

        pid_t pid = fork();
        if (pid < 0) { LOGE("fork: %s", strerror(errno)); return 0; }

        if (pid == 0) {
            /* Child: drop privileges and exec opencode */
            if (initgroups(d->username, d->gid) < 0) { _exit(1); }
            if (setgid(d->gid) < 0) { _exit(1); }
            if (setuid(d->uid) < 0) { _exit(1); }

            /* Redirect stdin/stdout/stderr to /dev/null */
            int devnull = open("/dev/null", O_RDWR);
            if (devnull >= 0) { dup2(devnull, 0); dup2(devnull, 1); dup2(devnull, 2); close(devnull); }

            char xdg_runtime[256];
            snprintf(xdg_runtime, sizeof(xdg_runtime), "XDG_RUNTIME_DIR=/run/user/%u", d->uid);
            char *env[] = { xdg_runtime, NULL };

            execle(g_opencode_bin, g_opencode_bin, "serve",
                   "--unix-socket", d->socket_path, NULL, env);
            _exit(127);
        }

        d->pid = pid;

        /* Wait for socket to appear */
        if (!wait_for_daemon_ready(d, pid, DAEMON_WAIT_MS)) {
            kill(pid, SIGTERM);
            return 0;
        }

        d->state = DAEMON_READY;
        LOGI("daemon for %s ready (pid %d)", d->username, pid);
    }

    return d->state == DAEMON_READY;
}

/* ─── splice() proxy ─────────────────────────────────────────────── */
static Connection *alloc_conn(void) {
    for (int i = 0; i < MAX_CONNS; i++) {
        if (g_conns[i].client_fd < 0) return &g_conns[i];
    }
    return NULL;
}

static void close_conn(Connection *c) {
    if (c->client_fd >= 0) { close(c->client_fd); c->client_fd = -1; }
    if (c->daemon_fd >= 0) { close(c->daemon_fd); c->daemon_fd = -1; }
    if (c->pipe_c2d[0] >= 0) { close(c->pipe_c2d[0]); c->pipe_c2d[0] = -1; }
    if (c->pipe_c2d[1] >= 0) { close(c->pipe_c2d[1]); c->pipe_c2d[1] = -1; }
    if (c->pipe_d2c[0] >= 0) { close(c->pipe_d2c[0]); c->pipe_d2c[0] = -1; }
    if (c->pipe_d2c[1] >= 0) { close(c->pipe_d2c[1]); c->pipe_d2c[1] = -1; }
}

/* Returns the Connection* on success so caller can re-send buffered data, NULL on error. */
static Connection *start_splice_proxy(int client_fd, DaemonInfo *d) {
    int daemon_fd = connect_unix(d->socket_path);
    if (daemon_fd < 0) { LOGE("connect to daemon socket: %s", strerror(errno)); return NULL; }

    Connection *c = alloc_conn();
    if (!c) { close(daemon_fd); LOGE("connection table full"); return NULL; }

    if (pipe(c->pipe_c2d) < 0 || pipe(c->pipe_d2c) < 0) {
        LOGE("pipe: %s", strerror(errno));
        close(daemon_fd);
        return NULL;
    }

    c->client_fd = client_fd;
    c->daemon_fd = daemon_fd;

    set_nonblock(client_fd);
    set_nonblock(daemon_fd);
    set_nonblock(c->pipe_c2d[0]); set_nonblock(c->pipe_c2d[1]);
    set_nonblock(c->pipe_d2c[0]); set_nonblock(c->pipe_d2c[1]);

    /* Register both fds with epoll for bidirectional splice */
    struct epoll_event ev = { .events = EPOLLIN | EPOLLET };
    ev.data.ptr = c;
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, client_fd, &ev);
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, daemon_fd, &ev);

    g_nconns++;
    return c;
}

/* Drain available data between two fds using splice() */
static void splice_between(Connection *c, int src, int *pipe_in, int *pipe_out, int dst) {
    ssize_t n;
    while ((n = splice(src, NULL, *pipe_in, NULL, PIPE_BUF_SIZE,
                       SPLICE_F_NONBLOCK | SPLICE_F_MOVE)) > 0) {
        ssize_t m = splice(*pipe_out, NULL, dst, NULL, (size_t)n,
                           SPLICE_F_NONBLOCK | SPLICE_F_MOVE);
        if (m < 0 && errno != EAGAIN) { close_conn(c); return; }
    }
    if (n < 0 && errno != EAGAIN) close_conn(c);
}

/* ─── HTTP helpers ───────────────────────────────────────────────── */
static void http_send(int fd, int status, const char *statusmsg,
                      const char *ctype, const char *headers,
                      const char *body, size_t bodylen) {
    char hdr[2048];
    int hdrlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "%s"
        "Connection: close\r\n\r\n",
        status, statusmsg, ctype, bodylen, headers ? headers : "");
    send(fd, hdr, (size_t)hdrlen, MSG_NOSIGNAL);
    if (body && bodylen > 0) send(fd, body, bodylen, MSG_NOSIGNAL);
}

static void serve_login_page(int fd) {
    http_send(fd, 200, "OK", "text/html; charset=utf-8", NULL,
              g_login_html, g_login_html_len);
}

static void serve_401(int fd) {
    const char *body = "{\"error\":\"Unauthorized\"}";
    http_send(fd, 401, "Unauthorized", "application/json", NULL, body, strlen(body));
}

/* ─── Request handler ────────────────────────────────────────────── */
typedef struct {
    char method[8];
    char path[256];
    char cookie[1024];
    char body[4096];
    int  body_len;
} HttpRequest;

static int parse_request(const char *buf, size_t len, HttpRequest *req) {
    memset(req, 0, sizeof(*req));
    /* First line: METHOD PATH HTTP/1.x */
    if (sscanf(buf, "%7s %255s", req->method, req->path) < 2) return 0;

    /* Find Cookie header */
    const char *p = strstr(buf, "\r\nCookie:");
    if (p) {
        p += 9; /* skip "\r\nCookie:" */
        while (*p == ' ') p++;
        const char *end = strstr(p, "\r\n");
        size_t clen = end ? (size_t)(end - p) : strlen(p);
        if (clen >= sizeof(req->cookie)) clen = sizeof(req->cookie) - 1;
        memcpy(req->cookie, p, clen);
    }

    /* Find body (after \r\n\r\n) */
    const char *body = strstr(buf, "\r\n\r\n");
    if (body) {
        body += 4;
        size_t blen = len - (size_t)(body - buf);
        if (blen >= sizeof(req->body)) blen = sizeof(req->body) - 1;
        memcpy(req->body, body, blen);
        req->body_len = (int)blen;
    }
    (void)len;
    return 1;
}

static void handle_auth_login(int client_fd, const char *body) {
    /* Parse application/x-www-form-urlencoded: username=...&password=... */
    char raw_user[256] = {}, raw_pass[256] = {};
    const char *p = body;
    while (*p) {
        char key[64] = {}, val[256] = {};
        int n = 0;
        /* key */
        while (*p && *p != '=' && n < 63) key[n++] = *p++;
        if (*p == '=') p++;
        /* val */
        n = 0;
        while (*p && *p != '&' && n < 255) val[n++] = *p++;
        if (*p == '&') p++;

        if (strcmp(key, "username") == 0) url_decode(raw_user, val, sizeof(raw_user));
        else if (strcmp(key, "password") == 0) url_decode(raw_pass, val, sizeof(raw_pass));
    }

    if (!raw_user[0] || !raw_pass[0]) { serve_login_page(client_fd); return; }

    if (!pam_authenticate_user(raw_user, raw_pass)) {
        /* Return login page with error indication */
        const char *redir = "HTTP/1.1 303 See Other\r\nLocation: /?error=1\r\nConnection: close\r\n\r\n";
        send(client_fd, redir, strlen(redir), MSG_NOSIGNAL);
        return;
    }

    /* Auth success: sign JWT */
    char payload[512];
    time_t exp = time(NULL) + JWT_EXP_SECONDS;
    snprintf(payload, sizeof(payload),
             "{\"sub\":\"%s\",\"exp\":%ld}", raw_user, (long)exp);
    char token[1024];
    jwt_sign(payload, token, sizeof(token));

    /* Issue cookie + redirect to / */
    char hdrs[1200];
    snprintf(hdrs, sizeof(hdrs),
             "Set-Cookie: oc_jwt=%s; HttpOnly; Path=/; Max-Age=%d\r\n"
             "Location: /\r\n",
             token, JWT_EXP_SECONDS);
    http_send(client_fd, 303, "See Other", "text/plain", hdrs, "", 0);
}

static void handle_new_connection(int client_fd) {
    /* Read request (blocking with timeout — this is called from epoll accept path) */
    char buf[8192];
    ssize_t n = recv(client_fd, buf, sizeof(buf)-1, 0);
    if (n <= 0) { close(client_fd); return; }
    buf[n] = '\0';

    HttpRequest req;
    if (!parse_request(buf, (size_t)n, &req)) { close(client_fd); return; }

    /* Check for valid JWT cookie */
    char *jwt_val = strstr(req.cookie, "oc_jwt=");
    if (jwt_val) {
        jwt_val += 7;
        char *end = strchr(jwt_val, ';');
        if (end) *end = '\0';

        char username[64] = {};
        uid_t uid = 0;
        if (jwt_verify(jwt_val, username, &uid)) {
            DaemonInfo *d = find_or_create_daemon(username);
            if (d && d->uid == uid && ensure_daemon_running(d)) {
                Connection *conn = start_splice_proxy(client_fd, d);
                if (conn) {
                    send(conn->daemon_fd, buf, (size_t)n, MSG_NOSIGNAL);
                    return;
                }
            }
            serve_401(client_fd);
            close(client_fd);
            return;
        }

        serve_401(client_fd);
        close(client_fd);
        return;
    }

    /* No valid session: route based on path */
    if (strcmp(req.method, "POST") == 0 && strcmp(req.path, "/auth/login") == 0) {
        handle_auth_login(client_fd, req.body);
        close(client_fd);
    } else {
        serve_login_page(client_fd);
        close(client_fd);
    }
}

/* ─── Main event loop ────────────────────────────────────────────── */
int main(int argc, char *argv[]) {
    (void)argc; (void)argv;

    /* Init connection table */
    for (int i = 0; i < MAX_CONNS; i++) {
        g_conns[i].client_fd = g_conns[i].daemon_fd = -1;
        g_conns[i].pipe_c2d[0] = g_conns[i].pipe_c2d[1] = -1;
        g_conns[i].pipe_d2c[0] = g_conns[i].pipe_d2c[1] = -1;
    }

    /* Generate JWT secret */
    if (RAND_bytes(g_jwt_secret, JWT_SECRET_LEN) != 1) {
        LOGE("RAND_bytes failed"); return 1;
    }

    /* Load login.html */
    const char *html_path = getenv("OPENCODE_LOGIN_HTML");
    if (!html_path) html_path = "/usr/local/share/opencode/login.html";
    FILE *f = fopen(html_path, "r");
    if (f) {
        g_login_html_len = fread(g_login_html, 1, sizeof(g_login_html)-1, f);
        fclose(f);
    } else {
        /* Embed minimal fallback */
        const char *fallback = "<html><body><h1>OpenCode Login</h1>"
            "<form method='POST' action='/auth/login'>"
            "User: <input name='username'><br>"
            "Pass: <input type='password' name='password'><br>"
            "<button>Login</button></form></body></html>";
        strncpy(g_login_html, fallback, sizeof(g_login_html)-1);
        g_login_html_len = strlen(g_login_html);
    }

    /* opencode binary path */
    const char *bin = getenv("OPENCODE_BIN");
    if (bin) strncpy(g_opencode_bin, bin, sizeof(g_opencode_bin)-1);

    /* Signals */
    struct sigaction sa = { .sa_handler = on_sigterm, .sa_flags = 0 };
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);
    sa.sa_handler = on_sigchld;
    sa.sa_flags   = SA_RESTART | SA_NOCLDSTOP;
    sigaction(SIGCHLD, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    /* Bind TCP socket */
    int port = GATEWAY_PORT_DEFAULT;
    const char *port_env = getenv("OPENCODE_GATEWAY_PORT");
    if (port_env) port = atoi(port_env);

    g_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen_fd < 0) { LOGE("socket: %s", strerror(errno)); return 1; }
    int opt = 1;
    setsockopt(g_listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons((uint16_t)port),
        .sin_addr   = { .s_addr = INADDR_ANY },
    };
    if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        LOGE("bind :%d: %s", port, strerror(errno)); return 1;
    }
    if (listen(g_listen_fd, BACKLOG) < 0) {
        LOGE("listen: %s", strerror(errno)); return 1;
    }
    set_nonblock(g_listen_fd);

    /* epoll */
    g_epoll_fd = epoll_create1(0);
    if (g_epoll_fd < 0) { LOGE("epoll_create1: %s", strerror(errno)); return 1; }
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = g_listen_fd };
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, g_listen_fd, &ev);

    LOGI("opencode-gateway listening on :%d", port);

    struct epoll_event events[MAX_EVENTS];
    while (g_running) {
        int n = epoll_wait(g_epoll_fd, events, MAX_EVENTS, 1000);
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGE("epoll_wait: %s", strerror(errno));
            break;
        }

        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;

            if (fd == g_listen_fd) {
                /* Accept new connections */
                while (1) {
                    int client = accept4(g_listen_fd, NULL, NULL, SOCK_CLOEXEC);
                    if (client < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        LOGE("accept: %s", strerror(errno));
                        break;
                    }
                    handle_new_connection(client);
                }
            } else {
                /* Splice proxy event */
                Connection *c = (Connection *)events[i].data.ptr;
                if (!c) continue;
                if (events[i].events & EPOLLIN) {
                    if (fd == c->client_fd) {
                        splice_between(c, c->client_fd, &c->pipe_c2d[1], &c->pipe_c2d[0], c->daemon_fd);
                    } else if (fd == c->daemon_fd) {
                        splice_between(c, c->daemon_fd, &c->pipe_d2c[1], &c->pipe_d2c[0], c->client_fd);
                    }
                }
                if (events[i].events & (EPOLLHUP | EPOLLERR)) {
                    close_conn(c);
                }
            }
        }
    }

    /* Graceful shutdown */
    LOGI("shutting down");
    close(g_listen_fd);
    for (int i = 0; i < g_ndaemons; i++) {
        if (g_daemons[i].pid > 0) kill(g_daemons[i].pid, SIGTERM);
    }
    for (int i = 0; i < MAX_CONNS; i++) {
        if (g_conns[i].client_fd >= 0) close_conn(&g_conns[i]);
    }
    close(g_epoll_fd);
    return 0;
}
