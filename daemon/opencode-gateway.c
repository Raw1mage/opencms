#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
/*
 * thesmartai-gateway — C root daemon
 *
 * Architecture (post-hardening):
 *   - Binds TCP :1080 (configurable via OPENCODE_GATEWAY_PORT)
 *   - Non-blocking accept + per-connection HTTP buffering (PendingRequest)
 *   - Tagged EpollCtx per fd (LISTEN / PENDING / SPLICE_CLIENT / SPLICE_DAEMON / AUTH_NOTIFY)
 *   - Thread-per-auth PAM (pthread + eventfd notification)
 *   - JWT with file-backed persistent secret
 *   - Per-IP login rate limiting
 *   - Fail2ban-like persistent IP ban (consecutive failures → /etc/opencode/banlist.txt)
 *   - splice() proxy with proper lifecycle (EPOLL_CTL_DEL before close, closed flag)
 *
 * @event_20260319_daemonization Phase α hardening
 *
 * Build:
 *   gcc -O2 -Wall -D_GNU_SOURCE -o opencode-gateway opencode-gateway.c \
 *       -lpam -lpam_misc -lcrypto -lpthread
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
#include <pthread.h>
#include <ctype.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/sendfile.h>
#include <poll.h>
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
#define DAEMON_WAIT_MS        15000         /* max wait for per-user daemon socket */
#define MAX_USERS             64
#define MAX_CONNS             1024
#define MAX_PENDING           512
#define PENDING_BUF_SIZE      8192
#define PENDING_TIMEOUT_SEC   30
#define RATE_LIMIT_MAX        5            /* max failures per window */
#define RATE_LIMIT_WINDOW     60           /* seconds */
#define RATE_LIMIT_TABLE_SIZE 256
#define BAN_FILE_PATH         "/etc/opencode/banlist.txt"
#define GOOGLE_BINDINGS_PATH_DEFAULT "/etc/opencode/google-bindings.json"
#define GOOGLE_BINDINGS_PATH_ENV      "OPENCODE_GOOGLE_BINDINGS_PATH"
#define BAN_TABLE_SIZE        4096         /* open-addressing hash set */
#define BAN_CONSEC_MAX        5            /* consecutive failures before permanent ban */
#define CONSEC_FAIL_TABLE_SIZE 256
#define MAX_AUTH_QUEUE        32
#define MAX_OPENCODE_ARGV     32

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

/* ─── Forward declarations ──────────────────────────────────────── */
typedef struct Connection Connection;
typedef struct PendingRequest PendingRequest;
static void jwt_sign(const char *payload, char *out_token, size_t toklen);
static void http_send(int fd, int status, const char *statusmsg,
                      const char *ctype, const char *headers,
                      const char *body, size_t bodylen);
static void send_login_success_ex(int fd, const char *username,
                                  int is_secure, int is_json_api);
static int submit_auth_job_ex(int client_fd, const char *username,
                              const char *password, int is_secure,
                              uint32_t peer_ip, int is_json_api);

/* ─── EpollCtx: tagged context for every epoll-monitored fd ─────── */
typedef enum {
    ECTX_LISTEN,          /* listen socket */
    ECTX_PENDING,         /* accumulating HTTP request */
    ECTX_SPLICE_CLIENT,   /* splice proxy: client side */
    ECTX_SPLICE_DAEMON,   /* splice proxy: daemon side */
    ECTX_AUTH_NOTIFY       /* eventfd for PAM thread completion */
} EpollCtxType;

typedef struct {
    EpollCtxType type;
    union {
        PendingRequest *pending;
        Connection     *conn;
    };
} EpollCtx;

/* ─── PendingRequest: per-connection HTTP accumulation buffer ───── */
struct PendingRequest {
    int       fd;
    EpollCtx  ectx;            /* embedded, points back to self */
    char      buf[PENDING_BUF_SIZE];
    size_t    buf_len;
    time_t    accept_time;
    uint32_t  peer_ip;          /* for rate limiting */
    int       in_use;
};

static PendingRequest g_pending[MAX_PENDING];

/* ─── Connection: splice proxy state with lifecycle guard ────────── */
typedef struct DaemonInfo DaemonInfo;

struct Connection {
    int       client_fd;
    int       daemon_fd;
    int       pipe_c2d[2];     /* client → daemon splice pipe */
    int       pipe_d2c[2];     /* daemon → client splice pipe */
    int       closed;          /* guard for in-flight epoll events */
    EpollCtx  ectx_client;     /* embedded, for client_fd */
    EpollCtx  ectx_daemon;     /* embedded, for daemon_fd */
    DaemonInfo *daemon;        /* back-pointer for liveness tracking */
};

static Connection g_conns[MAX_CONNS];
static int        g_nconns = 0;

/* ─── Per-user daemon registry ───────────────────────────────────── */
typedef enum { DAEMON_NONE, DAEMON_STARTING, DAEMON_READY, DAEMON_DEAD } DaemonState;

struct DaemonInfo {
    uid_t uid;
    gid_t gid;
    char  username[64];
    char  socket_path[256];
    pid_t pid;
    DaemonState state;
};

static DaemonInfo g_daemons[MAX_USERS];
static int        g_ndaemons = 0;

/* ─── Rate limit table ──────────────────────────────────────────── */
typedef struct {
    uint32_t ip;
    int      failures;
    time_t   window_start;
} RateLimitEntry;

static RateLimitEntry g_rate_limit[RATE_LIMIT_TABLE_SIZE];

/* ─── PAM auth thread queue ─────────────────────────────────────── */
typedef struct {
    int       client_fd;
    char      username[256];
    char      password[256];
    int       is_secure;
    uint32_t  peer_ip;
    int       result;          /* 0=fail, 1=success */
    int       done;
    int       is_json_api;     /* 1=SPA fetch (JSON response), 0=form (HTML redirect) */
} AuthJob;

static AuthJob       g_auth_queue[MAX_AUTH_QUEUE];
static int           g_auth_queue_head = 0;
static int           g_auth_queue_tail = 0;
static pthread_mutex_t g_auth_mutex = PTHREAD_MUTEX_INITIALIZER;

/* ─── Global state ───────────────────────────────────────────────── */
static int       g_listen_fd     = -1;
static int       g_epoll_fd      = -1;
static int       g_auth_eventfd  = -1;
static int       g_running       = 1;
static uint8_t   g_jwt_secret[JWT_SECRET_LEN];
static char      g_login_html[65536];
static size_t    g_login_html_len = 0;
static int       g_force_secure = 0;  /* force Secure flag on cookies (behind HTTPS proxy) */
static char      g_opencode_bin[512] = "/usr/local/bin/opencode";
static char     *g_opencode_argv[MAX_OPENCODE_ARGV]; /* pre-parsed argv */
static int       g_opencode_argc = 0;
static EpollCtx  g_listen_ectx;
static EpollCtx  g_auth_ectx;

/* ─── Signal handling ────────────────────────────────────────────── */
static void on_sigterm(int sig) { (void)sig; g_running = 0; }

static void on_sigchld(int sig) {
    (void)sig;
    int saved = errno;
    pid_t pid;
    int status;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        int found = 0;
        for (int i = 0; i < g_ndaemons; i++) {
            if (g_daemons[i].pid == pid) {
                LOGW("SIGCHLD: daemon for %s (pid %d) exited status=%d (exit=%d sig=%d)",
                     g_daemons[i].username, pid, status,
                     WIFEXITED(status) ? WEXITSTATUS(status) : -1,
                     WIFSIGNALED(status) ? WTERMSIG(status) : -1);
                g_daemons[i].state = DAEMON_DEAD;
                g_daemons[i].pid   = -1;
                found = 1;
            }
        }
        if (!found) {
            LOGW("SIGCHLD: unknown child pid %d exited status=%d", pid, status);
        }
    }
    errno = saved;
}

/* ─── Utility ────────────────────────────────────────────────────── */
static int set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void reset_daemon_state(DaemonInfo *d) {
    d->pid = -1;
    d->state = DAEMON_NONE;
}

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

/* ─── OPENCODE_BIN argv parsing (DD-8: no sh -c after setuid) ──── */
static void parse_opencode_argv(void) {
    char tmp[512];
    strncpy(tmp, g_opencode_bin, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    g_opencode_argc = 0;
    char *saveptr = NULL;
    char *tok = strtok_r(tmp, " \t", &saveptr);
    while (tok && g_opencode_argc < MAX_OPENCODE_ARGV - 4) { /* reserve 3 for "serve --unix-socket <path>" + NULL */
        g_opencode_argv[g_opencode_argc] = strdup(tok);
        if (!g_opencode_argv[g_opencode_argc]) break;
        g_opencode_argc++;
        tok = strtok_r(NULL, " \t", &saveptr);
    }
}

/* ─── Runtime path detection (DD-7: WSL2 environment adaptation) ── */
/*
 * Resolves the runtime directory for a given uid.
 * Priority: /run/user/<uid> → $XDG_RUNTIME_DIR → /tmp/opencode-<uid>
 * Writes the selected path to out (max outlen bytes) and logs the choice.
 */
static void resolve_runtime_dir(uid_t uid, char *out, size_t outlen) {
    struct stat st;
    char candidate[128];

    /* 1. Standard systemd path */
    snprintf(candidate, sizeof(candidate), "/run/user/%u", uid);
    if (stat(candidate, &st) == 0 && S_ISDIR(st.st_mode)) {
        snprintf(out, outlen, "%s", candidate);
        return;
    }

    /* 2. XDG_RUNTIME_DIR if set and valid */
    const char *xdg = getenv("XDG_RUNTIME_DIR");
    if (xdg && xdg[0] && stat(xdg, &st) == 0 && S_ISDIR(st.st_mode)) {
        LOGI("runtime dir: /run/user/%u not available, using XDG_RUNTIME_DIR=%s", uid, xdg);
        snprintf(out, outlen, "%s", xdg);
        return;
    }

    /* 3. Fallback: /tmp/opencode-<uid> (mkdir 700) */
    snprintf(candidate, sizeof(candidate), "/tmp/opencode-%u", uid);
    if (stat(candidate, &st) != 0) {
        if (mkdir(candidate, 0700) == 0) {
            LOGI("runtime dir: created fallback %s", candidate);
        } else {
            LOGW("runtime dir: failed to create %s: %s", candidate, strerror(errno));
        }
    }
    LOGI("runtime dir: /run/user/%u not available, using fallback %s", uid, candidate);
    snprintf(out, outlen, "%s", candidate);
}

/* ─── JWT (HMAC-SHA256) ─────────────────────────────────────────── */
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
    while (pad > 0 && actual > 0) { actual--; pad--; }
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
    if (!start) return 0;
    start += strlen(pattern);
    char *endptr = NULL;
    errno = 0;
    long value = strtol(start, &endptr, 10);
    if (errno != 0 || endptr == start) return 0;
    *out = value;
    return 1;
}

static int form_extract_value(const char *body, const char *field, char *out, size_t outlen) {
    const char *p = body;
    while (*p) {
        char key[64] = {}, val[256] = {};
        int n = 0;
        while (*p && *p != '=' && n < (int)sizeof(key) - 1) key[n++] = *p++;
        key[n] = '\0';
        if (*p == '=') p++;
        n = 0;
        while (*p && *p != '&' && n < (int)sizeof(val) - 1) val[n++] = *p++;
        val[n] = '\0';
        if (*p == '&') p++;
        if (strcmp(key, field) == 0) {
            url_decode(out, val, outlen);
            return 1;
        }
    }
    return 0;
}

/* Binding registry is gateway-owned and separate from shared Google OAuth token storage. */
static int google_binding_lookup(const char *google_email, char *out_username, size_t outlen) {
    const char *path = getenv(GOOGLE_BINDINGS_PATH_ENV);
    if (!path) path = GOOGLE_BINDINGS_PATH_DEFAULT;

    FILE *f = fopen(path, "r");
    if (!f) {
        LOGW("google binding registry unavailable at %s", path);
        return 0;
    }

    char buf[16384];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';

    char keypat[320];
    if (snprintf(keypat, sizeof(keypat), "\"%s\"", google_email) >= (int)sizeof(keypat)) return 0;
    char *p = strstr(buf, keypat);
    if (!p) return 0;

    p += strlen(keypat);
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != ':') return 0;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return 0;
    p++;

    char *end = strchr(p, '"');
    if (!end) return 0;
    size_t len = (size_t)(end - p);
    if (len == 0 || len >= outlen) return 0;
    memcpy(out_username, p, len);
    out_username[len] = '\0';
    return 1;
}

static void send_login_success(int fd, const char *username, int is_secure) {
    send_login_success_ex(fd, username, is_secure, 0);
}

/* is_json_api: when true, return JSON body + Set-Cookie header (for SPA fetch).
 * when false, return HTML with JS cookie-set + redirect (for form submit). */
static void send_login_success_ex(int fd, const char *username,
                                  int is_secure, int is_json_api) {
    char payload[512];
    time_t exp_time = time(NULL) + JWT_EXP_SECONDS;
    snprintf(payload, sizeof(payload),
             "{\"sub\":\"%s\",\"exp\":%ld}", username, (long)exp_time);
    char token[1024];
    jwt_sign(payload, token, sizeof(token));

    char cookie_hdr[1200];
    snprintf(cookie_hdr, sizeof(cookie_hdr),
             "Cache-Control: no-store\r\n"
             "Set-Cookie: oc_jwt=%s; Path=/; Max-Age=%d; SameSite=Lax%s\r\n",
             token, JWT_EXP_SECONDS, is_secure ? "; Secure" : "");

    if (is_json_api) {
        /* SPA fetch mode: JSON response + Set-Cookie header */
        char json_body[256];
        snprintf(json_body, sizeof(json_body),
                 "{\"enabled\":true,\"authenticated\":true,\"username\":\"%s\"}",
                 username);
        http_send(fd, 200, "OK", "application/json", cookie_hdr,
                  json_body, strlen(json_body));
        LOGI("auth 200+json+cookie sent: user='%s' is_secure=%d", username, is_secure);
    } else {
        /* Form submit mode: HTML with JS cookie-set + redirect */
        char js_body[2048];
        snprintf(js_body, sizeof(js_body),
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
            "</head><body><script>"
            "document.cookie='oc_jwt=%s; Path=/; Max-Age=%d';"
            "window.location.replace('/');"
            "</script></body></html>",
            token, JWT_EXP_SECONDS);
        http_send(fd, 200, "OK", "text/html; charset=utf-8",
                  "Cache-Control: no-store\r\n",
                  js_body, strlen(js_body));
        LOGI("auth 200+js-cookie sent: is_secure=%d token_len=%zu",
             is_secure, strlen(token));
    }
}

/* ─── JWT secret persistence (DD-5) ─────────────────────────────── */
static int jwt_load_or_create_secret(void) {
    const char *key_path = getenv("OPENCODE_JWT_KEY_PATH");
    if (!key_path) key_path = "/var/lib/opencode-gateway/jwt.key";

    /* Try to read existing key */
    int fd = open(key_path, O_RDONLY);
    if (fd >= 0) {
        ssize_t n = read(fd, g_jwt_secret, JWT_SECRET_LEN);
        close(fd);
        if (n == JWT_SECRET_LEN) {
            LOGI("loaded JWT secret from %s", key_path);
            return 1;
        }
        LOGW("JWT key file %s has wrong size (%zd), regenerating", key_path, n);
    }

    /* Generate new secret */
    if (RAND_bytes(g_jwt_secret, JWT_SECRET_LEN) != 1) {
        LOGE("RAND_bytes failed");
        return 0;
    }

    /* Ensure parent directory exists */
    char dir[256];
    strncpy(dir, key_path, sizeof(dir) - 1);
    dir[sizeof(dir) - 1] = '\0';
    char *slash = strrchr(dir, '/');
    if (slash && slash != dir) {
        *slash = '\0';
        mkdir(dir, 0700);
    }

    /* Write key file (root-owned, 0600) */
    fd = open(key_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        LOGW("cannot write JWT key to %s: %s (using ephemeral secret)", key_path, strerror(errno));
        return 1; /* proceed with ephemeral secret */
    }
    ssize_t written = write(fd, g_jwt_secret, JWT_SECRET_LEN);
    close(fd);
    if (written == JWT_SECRET_LEN) {
        LOGI("generated and saved JWT secret to %s", key_path);
    } else {
        LOGW("partial write to %s (%zd bytes)", key_path, written);
    }
    return 1;
}

static void jwt_sign(const char *payload, char *out_token, size_t toklen) {
    const char *header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
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
    char buf[1024], msg[1024], payload_json[512];
    uint8_t payload_raw[512], sig[32];
    unsigned int siglen = 32;
    char sig64[64];
    size_t sig64len, payload_len;
    long exp_val;

    strncpy(buf, token, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    char *dot1 = strchr(buf, '.');
    if (!dot1) return 0;
    char *dot2 = strchr(dot1 + 1, '.');
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
    if (!json_extract_long(payload_json, "exp", &exp_val)) return 0;
    if (exp_val <= (long)time(NULL)) return 0;

    struct passwd *pw = getpwnam(out_username);
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

    int ret = pam_start("login", username, &conv, &pamh);
    if (ret != PAM_SUCCESS) { LOGE("pam_start: %s", pam_strerror(pamh, ret)); return 0; }

    ret = pam_authenticate(pamh, PAM_SILENT);
    if (ret != PAM_SUCCESS) {
        LOGW("pam_authenticate failed for %s: %s (code=%d)", username, pam_strerror(pamh, ret), ret);
        pam_end(pamh, ret);
        return 0;
    }
    LOGI("pam_authenticate succeeded for %s", username);

    ret = pam_acct_mgmt(pamh, PAM_SILENT);
    if (ret != PAM_SUCCESS) {
        LOGW("pam_acct_mgmt failed for %s: %s (code=%d)", username, pam_strerror(pamh, ret), ret);
        pam_end(pamh, ret);
        return 0;
    }

    pam_end(pamh, PAM_SUCCESS);
    return 1;
}

/* ─── Rate limiting (DD-6) ──────────────────────────────────────── */
static int rate_limit_check(uint32_t ip) {
    time_t now = time(NULL);
    int idx = (int)(ip % RATE_LIMIT_TABLE_SIZE);

    if (g_rate_limit[idx].ip == ip) {
        if (now - g_rate_limit[idx].window_start > RATE_LIMIT_WINDOW) {
            /* Window expired, reset */
            g_rate_limit[idx].failures = 0;
            g_rate_limit[idx].window_start = now;
            return 1; /* allow */
        }
        return g_rate_limit[idx].failures < RATE_LIMIT_MAX;
    }
    /* New IP in this slot — allow */
    return 1;
}

static void rate_limit_record_failure(uint32_t ip) {
    time_t now = time(NULL);
    int idx = (int)(ip % RATE_LIMIT_TABLE_SIZE);

    if (g_rate_limit[idx].ip != ip || now - g_rate_limit[idx].window_start > RATE_LIMIT_WINDOW) {
        g_rate_limit[idx].ip = ip;
        g_rate_limit[idx].failures = 0;
        g_rate_limit[idx].window_start = now;
    }
    g_rate_limit[idx].failures++;
}

static void rate_limit_clear(uint32_t ip) {
    int idx = (int)(ip % RATE_LIMIT_TABLE_SIZE);
    if (g_rate_limit[idx].ip == ip) {
        g_rate_limit[idx].failures = 0;
    }
}

/* ─── Fail2ban: persistent IP ban list ───────────────────────────── */

/* Whitelist: loopback (127.0.0.0/8) and private LAN (192.168.0.0/16) are never banned */
static int is_whitelisted(uint32_t ip) {
    if ((ip >> 24) == 127) return 1;       /* 127.0.0.0/8  */
    if ((ip >> 16) == 0xC0A8) return 1;    /* 192.168.0.0/16 */
    return 0;
}

/* In-memory hash set of banned IPs (open addressing, linear probing) */
typedef struct { uint32_t ip; int occupied; } BanSlot;
static BanSlot g_ban_table[BAN_TABLE_SIZE];

static int ban_check(uint32_t ip) {
    if (is_whitelisted(ip)) return 0;
    uint32_t idx = ip % BAN_TABLE_SIZE;
    for (int i = 0; i < BAN_TABLE_SIZE; i++) {
        uint32_t slot = (idx + (uint32_t)i) % BAN_TABLE_SIZE;
        if (!g_ban_table[slot].occupied) return 0;
        if (g_ban_table[slot].ip == ip) return 1;
    }
    return 0;
}

static void ban_insert_memory(uint32_t ip) {
    uint32_t idx = ip % BAN_TABLE_SIZE;
    for (int i = 0; i < BAN_TABLE_SIZE; i++) {
        uint32_t slot = (idx + (uint32_t)i) % BAN_TABLE_SIZE;
        if (!g_ban_table[slot].occupied) {
            g_ban_table[slot].ip = ip;
            g_ban_table[slot].occupied = 1;
            return;
        }
        if (g_ban_table[slot].ip == ip) return; /* already present */
    }
    LOGW("ban table full (%d slots), cannot insert", BAN_TABLE_SIZE);
}

static void ban_add(uint32_t ip) {
    if (is_whitelisted(ip)) return;
    if (ban_check(ip)) return; /* already banned */
    ban_insert_memory(ip);

    char ipstr[20];
    snprintf(ipstr, sizeof(ipstr), "%u.%u.%u.%u",
             (ip >> 24) & 0xff, (ip >> 16) & 0xff,
             (ip >> 8) & 0xff, ip & 0xff);

    /* Ensure /etc/opencode/ exists (gateway runs as root) */
    mkdir("/etc/opencode", 0755);

    FILE *f = fopen(BAN_FILE_PATH, "a");
    if (f) {
        fprintf(f, "%s\n", ipstr);
        fclose(f);
        LOGI("BANNED IP %s → %s (consecutive auth failures)", ipstr, BAN_FILE_PATH);
    } else {
        LOGW("cannot write ban file %s: %s (ban active in memory only)", BAN_FILE_PATH, strerror(errno));
    }
}

static void banlist_load(void) {
    memset(g_ban_table, 0, sizeof(g_ban_table));
    FILE *f = fopen(BAN_FILE_PATH, "r");
    if (!f) {
        LOGI("no ban list at %s (will create on first ban)", BAN_FILE_PATH);
        return;
    }
    char line[64];
    int count = 0;
    while (fgets(line, sizeof(line), f)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';
        if (!line[0] || line[0] == '#') continue;
        unsigned a, b, c, d;
        if (sscanf(line, "%u.%u.%u.%u", &a, &b, &c, &d) == 4) {
            uint32_t ip = (a << 24) | (b << 16) | (c << 8) | d;
            if (!is_whitelisted(ip)) {
                ban_insert_memory(ip);
                count++;
            } else {
                LOGW("ignoring whitelisted IP %s in ban list", line);
            }
        }
    }
    fclose(f);
    LOGI("loaded %d banned IPs from %s", count, BAN_FILE_PATH);
}

/* Consecutive failure tracking (no time window — permanent until success or ban) */
typedef struct { uint32_t ip; int failures; } ConsecFailEntry;
static ConsecFailEntry g_consec_fail[CONSEC_FAIL_TABLE_SIZE];

static void consec_fail_record(uint32_t ip) {
    if (is_whitelisted(ip)) return;
    int idx = (int)(ip % CONSEC_FAIL_TABLE_SIZE);
    if (g_consec_fail[idx].ip != ip) {
        g_consec_fail[idx].ip = ip;
        g_consec_fail[idx].failures = 0;
    }
    g_consec_fail[idx].failures++;
    LOGW("consecutive auth failure #%d for %u.%u.%u.%u",
         g_consec_fail[idx].failures,
         (ip >> 24) & 0xff, (ip >> 16) & 0xff,
         (ip >> 8) & 0xff, ip & 0xff);
    if (g_consec_fail[idx].failures >= BAN_CONSEC_MAX) {
        ban_add(ip);
        g_consec_fail[idx].failures = 0;
    }
}

static void consec_fail_clear(uint32_t ip) {
    int idx = (int)(ip % CONSEC_FAIL_TABLE_SIZE);
    if (g_consec_fail[idx].ip == ip) {
        g_consec_fail[idx].failures = 0;
    }
}

/* ─── PAM auth thread (DD-1: thread-per-auth) ──────────────────── */
static void *auth_thread_fn(void *arg) {
    AuthJob *job = (AuthJob *)arg;
    job->result = pam_authenticate_user(job->username, job->password);

    /* Clear password from memory immediately */
    memset(job->password, 0, sizeof(job->password));

    /* Signal completion: push to queue and notify main loop */
    pthread_mutex_lock(&g_auth_mutex);
    job->done = 1;
    pthread_mutex_unlock(&g_auth_mutex);

    uint64_t val = 1;
    ssize_t w = write(g_auth_eventfd, &val, sizeof(val));
    (void)w;

    return NULL;
}

static int submit_auth_job_ex(int client_fd, const char *username, const char *password,
                              int is_secure, uint32_t peer_ip, int is_json_api) {
    pthread_mutex_lock(&g_auth_mutex);
    int next = (g_auth_queue_tail + 1) % MAX_AUTH_QUEUE;
    if (next == g_auth_queue_head) {
        pthread_mutex_unlock(&g_auth_mutex);
        LOGW("auth queue full, rejecting login");
        return 0;
    }
    AuthJob *job = &g_auth_queue[g_auth_queue_tail];
    memset(job, 0, sizeof(*job));
    job->client_fd = client_fd;
    snprintf(job->username, sizeof(job->username), "%s", username);
    snprintf(job->password, sizeof(job->password), "%s", password);
    job->is_secure = is_secure;
    job->peer_ip = peer_ip;
    job->is_json_api = is_json_api;
    job->done = 0;
    g_auth_queue_tail = next;
    pthread_mutex_unlock(&g_auth_mutex);

    pthread_t tid;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&tid, &attr, auth_thread_fn, job) != 0) {
        LOGE("pthread_create for PAM auth: %s", strerror(errno));
        pthread_mutex_lock(&g_auth_mutex);
        g_auth_queue_tail = (g_auth_queue_tail - 1 + MAX_AUTH_QUEUE) % MAX_AUTH_QUEUE;
        pthread_mutex_unlock(&g_auth_mutex);
        pthread_attr_destroy(&attr);
        return 0;
    }
    pthread_attr_destroy(&attr);
    return 1;
}

static int submit_auth_job(int client_fd, const char *username, const char *password,
                           int is_secure, uint32_t peer_ip) {
    return submit_auth_job_ex(client_fd, username, password, is_secure, peer_ip, 0);
}

/* ─── Per-user daemon management ─────────────────────────────────── */
static DaemonInfo *find_or_create_daemon(const char *username) {
    struct passwd *pw = getpwnam(username);
    if (!pw) { LOGE("user not found: %s", username); return NULL; }

    for (int i = 0; i < g_ndaemons; i++) {
        if (g_daemons[i].uid == pw->pw_uid) return &g_daemons[i];
    }

    if (g_ndaemons >= MAX_USERS) { LOGE("too many users"); return NULL; }
    DaemonInfo *d = &g_daemons[g_ndaemons++];
    d->uid = pw->pw_uid;
    d->gid = pw->pw_gid;
    snprintf(d->username, sizeof(d->username), "%s", username);
    {
        char rtdir[128];
        resolve_runtime_dir(pw->pw_uid, rtdir, sizeof(rtdir));
        snprintf(d->socket_path, sizeof(d->socket_path),
                 "%s/opencode/daemon.sock", rtdir);
    }
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
    deadline.tv_sec += timeout_ms / 1000;
    deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
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
        if (waited < 0 && errno == ECHILD) {
            LOGW("waitpid ECHILD for %s pid %d — child may have been reaped, checking socket", d->username, pid);
        } else if (waited < 0) {
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

static int try_adopt_from_discovery(DaemonInfo *d) {
    char discovery_path[256];
    {
        char rtdir[128];
        resolve_runtime_dir(d->uid, rtdir, sizeof(rtdir));
        snprintf(discovery_path, sizeof(discovery_path),
                 "%s/opencode/daemon.json", rtdir);
    }

    FILE *f = fopen(discovery_path, "r");
    if (!f) return 0;

    char buf[1024];
    size_t n = fread(buf, 1, sizeof(buf)-1, f);
    fclose(f);
    buf[n] = '\0';

    char *sp = strstr(buf, "\"socketPath\"");
    char *pp = strstr(buf, "\"pid\"");
    if (!sp || !pp) {
        cleanup_stale_runtime(d, discovery_path, "discovery file missing socketPath/pid");
        return 0;
    }

    char *colon = strchr(sp + 12, '"');
    if (!colon) { cleanup_stale_runtime(d, discovery_path, "invalid socketPath"); return 0; }
    colon++;
    char *end = strchr(colon, '"');
    if (!end) { cleanup_stale_runtime(d, discovery_path, "unterminated socketPath"); return 0; }
    size_t pathlen = (size_t)(end - colon);
    if (pathlen == 0 || pathlen >= sizeof(d->socket_path)) {
        cleanup_stale_runtime(d, discovery_path, "socketPath length invalid");
        return 0;
    }
    memcpy(d->socket_path, colon, pathlen);
    d->socket_path[pathlen] = '\0';

    char *pval = strchr(pp + 5, ':');
    if (!pval) { cleanup_stale_runtime(d, discovery_path, "missing pid value"); return 0; }
    pid_t pid = (pid_t)atoi(pval + 1);
    if (pid <= 0) { cleanup_stale_runtime(d, discovery_path, "pid invalid"); return 0; }

    if (kill(pid, 0) != 0) {
        cleanup_stale_runtime(d, discovery_path, "pid is not alive");
        return 0;
    }

    int probe_fd = connect_unix(d->socket_path);
    if (probe_fd < 0) {
        char reason[256];
        snprintf(reason, sizeof(reason), "socket not connectable: %s", strerror(errno));
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
    LOGI("ensure_daemon_running: user='%s' state=%d pid=%d socket='%s'",
         d->username, d->state, d->pid, d->socket_path);

    if (d->state == DAEMON_READY) {
        if (d->pid > 0 && kill(d->pid, 0) == 0) {
            int probe_fd = connect_unix(d->socket_path);
            if (probe_fd >= 0) { close(probe_fd); LOGI("daemon still alive and connectable"); return 1; }
            LOGW("daemon for %s marked stale: socket connect failed: %s", d->username, strerror(errno));
        } else {
            LOGW("daemon for %s marked stale: pid %d is not alive", d->username, d->pid);
        }
        d->state = DAEMON_DEAD;
    }

    if (d->state == DAEMON_DEAD || d->state == DAEMON_NONE) {
        LOGI("trying adopt from discovery for '%s'...", d->username);
        if (try_adopt_from_discovery(d)) { LOGI("adopted!"); return 1; }
        LOGI("adopt failed, will spawn new daemon");

        unlink(d->socket_path);
        LOGI("spawning daemon for %s (uid %u) socket='%s'", d->username, d->uid, d->socket_path);
        d->state = DAEMON_STARTING;

        pid_t pid = fork();
        if (pid < 0) { LOGE("fork: %s", strerror(errno)); return 0; }

        if (pid == 0) {
            /* Child: new session so it won't get parent's signals */
            setsid();

            /* Close gateway-owned fds so the child (bun daemon) does NOT
             * inherit the listening socket.  Without this, both gateway and
             * bun accept() on the same port, causing random connection
             * routing and WebSocket failures.  g_auth_eventfd already has
             * EFD_CLOEXEC so it auto-closes on exec, but we close it
             * explicitly as defense-in-depth. */
            if (g_listen_fd >= 0) close(g_listen_fd);
            if (g_epoll_fd  >= 0) close(g_epoll_fd);
            if (g_auth_eventfd >= 0) close(g_auth_eventfd);

            /* Child: drop privileges and exec opencode */
            if (initgroups(d->username, d->gid) < 0) { _exit(1); }
            if (setgid(d->gid) < 0) { _exit(1); }
            if (setuid(d->uid) < 0) { _exit(1); }

            /* Set user environment from passwd entry */
            {
                struct passwd *pw = getpwuid(d->uid);
                if (pw) {
                    setenv("HOME", pw->pw_dir, 1);
                    setenv("USER", pw->pw_name, 1);
                    setenv("LOGNAME", pw->pw_name, 1);
                    if (pw->pw_shell[0]) setenv("SHELL", pw->pw_shell, 1);
                    if (chdir(pw->pw_dir) < 0) { /* best effort */ }
                }
            }

            int devnull = open("/dev/null", O_RDWR);
            if (devnull >= 0) { dup2(devnull, 0); close(devnull); }
            {
                char rtdir[128];
                resolve_runtime_dir(d->uid, rtdir, sizeof(rtdir));

                char daemon_log[512];
                snprintf(daemon_log, sizeof(daemon_log), "%s/opencode-per-user-daemon.log", rtdir);
                int logfd = open(daemon_log, O_WRONLY | O_CREAT | O_APPEND, 0644);
                if (logfd >= 0) { dup2(logfd, 1); dup2(logfd, 2); close(logfd); }

                setenv("XDG_RUNTIME_DIR", rtdir, 1);
            }
            setenv("OPENCODE_USER_DAEMON_MODE", "1", 1);

            /* Forward env vars the daemon needs from gateway's env */
            const char *fpath = getenv("OPENCODE_FRONTEND_PATH");
            if (fpath) setenv("OPENCODE_FRONTEND_PATH", fpath, 1);
            const char *repo_root = getenv("OPENCODE_REPO_ROOT");
            if (repo_root) setenv("OPENCODE_REPO_ROOT", repo_root, 1);
            const char *allow_browse = getenv("OPENCODE_ALLOW_GLOBAL_FS_BROWSE");
            if (allow_browse) setenv("OPENCODE_ALLOW_GLOBAL_FS_BROWSE", allow_browse, 1);
            const char *no_open = getenv("OPENCODE_WEB_NO_OPEN");
            if (no_open) setenv("OPENCODE_WEB_NO_OPEN", no_open, 1);

            /* DD-9: dev mode (bun + source) needs project root as cwd
             * so bun can resolve node_modules/package.json/workspace.
             * Detect dev mode by checking if OPENCODE_BIN contains a .ts entry.
             * Derive project root from the entry path (strip packages/... suffix).
             */
            {
                const char *ts_entry = NULL;
                for (int i = 0; i < g_opencode_argc; i++) {
                    size_t len = strlen(g_opencode_argv[i]);
                    if (len > 3 && strcmp(g_opencode_argv[i] + len - 3, ".ts") == 0) {
                        ts_entry = g_opencode_argv[i];
                        break;
                    }
                }
                if (ts_entry) {
                    /* Find "/packages/" in the path and chdir to its parent */
                    const char *pkg = strstr(ts_entry, "/packages/");
                    if (pkg) {
                        char project_root[512];
                        size_t prlen = (size_t)(pkg - ts_entry);
                        if (prlen > 0 && prlen < sizeof(project_root)) {
                            memcpy(project_root, ts_entry, prlen);
                            project_root[prlen] = '\0';
                            if (chdir(project_root) == 0) {
                                dprintf(2, "[gateway-child] dev mode: chdir to project root '%s'\n", project_root);
                            } else {
                                dprintf(2, "[gateway-child] dev mode: chdir('%s') failed: %s\n",
                                        project_root, strerror(errno));
                            }
                        }
                    }
                }
            }

            /* DD-8: use pre-parsed argv, no sh -c */
            if (g_opencode_argc > 0) {
                char *argv[MAX_OPENCODE_ARGV];
                int ac = 0;
                for (int i = 0; i < g_opencode_argc && ac < MAX_OPENCODE_ARGV - 4; i++)
                    argv[ac++] = g_opencode_argv[i];
                argv[ac++] = "serve";
                argv[ac++] = "--unix-socket";
                argv[ac++] = d->socket_path;
                argv[ac] = NULL;

                /* Debug: log exec args to stderr (which is the daemon log) */
                dprintf(2, "[gateway-child] exec: ");
                for (int i = 0; argv[i]; i++) dprintf(2, "'%s' ", argv[i]);
                dprintf(2, "\n");
                dprintf(2, "[gateway-child] uid=%u gid=%u XDG_RUNTIME_DIR=%s\n",
                        getuid(), getgid(), getenv("XDG_RUNTIME_DIR") ?: "(null)");

                execvp(argv[0], argv);
                dprintf(2, "[gateway-child] execvp failed: %s\n", strerror(errno));
            } else {
                dprintf(2, "[gateway-child] execl: '%s' serve --unix-socket '%s'\n",
                        g_opencode_bin, d->socket_path);
                execl(g_opencode_bin, g_opencode_bin, "serve",
                      "--unix-socket", d->socket_path, (char *)NULL);
                dprintf(2, "[gateway-child] execl failed: %s\n", strerror(errno));
            }
            _exit(127);
        }

        d->pid = pid;
        LOGI("forked daemon child for %s: pid=%d", d->username, pid);

        if (!wait_for_daemon_ready(d, pid, DAEMON_WAIT_MS)) {
            kill(pid, SIGTERM);
            return 0;
        }

        d->state = DAEMON_READY;
        LOGI("daemon for %s ready (pid %d)", d->username, pid);
    }

    return d->state == DAEMON_READY;
}

/* ─── Connection lifecycle (DD-4) ────────────────────────────────── */
static Connection *alloc_conn(void) {
    for (int i = 0; i < MAX_CONNS; i++) {
        if (g_conns[i].client_fd < 0 && !g_conns[i].closed) return &g_conns[i];
    }
    return NULL;
}

static void close_conn(Connection *c) {
    if (c->closed) return;
    c->closed = 1;
    /* EPOLL_CTL_DEL before close (DD-4) */
    if (c->client_fd >= 0) {
        epoll_ctl(g_epoll_fd, EPOLL_CTL_DEL, c->client_fd, NULL);
        close(c->client_fd);
        c->client_fd = -1;
    }
    if (c->daemon_fd >= 0) {
        epoll_ctl(g_epoll_fd, EPOLL_CTL_DEL, c->daemon_fd, NULL);
        close(c->daemon_fd);
        c->daemon_fd = -1;
    }
    if (c->pipe_c2d[0] >= 0) { close(c->pipe_c2d[0]); c->pipe_c2d[0] = -1; }
    if (c->pipe_c2d[1] >= 0) { close(c->pipe_c2d[1]); c->pipe_c2d[1] = -1; }
    if (c->pipe_d2c[0] >= 0) { close(c->pipe_d2c[0]); c->pipe_d2c[0] = -1; }
    if (c->pipe_d2c[1] >= 0) { close(c->pipe_d2c[1]); c->pipe_d2c[1] = -1; }

    if (g_nconns > 0) g_nconns--;

    /* Reset closed flag so alloc_conn() can reclaim this slot.
     * Safe: all FDs are closed and removed from epoll above,
     * so no further events can reference this connection. */
    c->closed = 0;
}

/* ─── splice() proxy (DD-3: directional splice) ──────────────────── */
static Connection *start_splice_proxy(int client_fd, DaemonInfo *d) {
    int daemon_fd = connect_unix(d->socket_path);
    if (daemon_fd < 0) { LOGE("connect to daemon socket: %s", strerror(errno)); return NULL; }

    Connection *c = alloc_conn();
    if (!c) { close(daemon_fd); LOGE("connection table full"); return NULL; }

    if (pipe(c->pipe_c2d) < 0 || pipe(c->pipe_d2c) < 0) {
        LOGE("pipe: %s", strerror(errno));
        /* Clean up partially-created pipes from first pipe() call */
        if (c->pipe_c2d[0] >= 0) { close(c->pipe_c2d[0]); c->pipe_c2d[0] = -1; }
        if (c->pipe_c2d[1] >= 0) { close(c->pipe_c2d[1]); c->pipe_c2d[1] = -1; }
        close(daemon_fd);
        /* Release the allocated slot (client_fd not yet assigned, slot is
         * still in alloc'd-but-unused state with closed=0, client_fd=-1,
         * so it's already reclaimable by alloc_conn). */
        return NULL;
    }

    c->client_fd = client_fd;
    c->daemon_fd = daemon_fd;
    c->daemon    = d;
    c->closed = 0;

    set_nonblock(client_fd);
    set_nonblock(daemon_fd);
    set_nonblock(c->pipe_c2d[0]); set_nonblock(c->pipe_c2d[1]);
    set_nonblock(c->pipe_d2c[0]); set_nonblock(c->pipe_d2c[1]);

    /* Register with tagged EpollCtx — one per fd */
    c->ectx_client.type = ECTX_SPLICE_CLIENT;
    c->ectx_client.conn = c;
    c->ectx_daemon.type = ECTX_SPLICE_DAEMON;
    c->ectx_daemon.conn = c;

    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.ptr = &c->ectx_client;
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, client_fd, &ev);
    ev.data.ptr = &c->ectx_daemon;
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, daemon_fd, &ev);

    g_nconns++;
    return c;
}

static void splice_one_direction(Connection *c, int src, int pipe_wr, int pipe_rd, int dst) {
    if (c->closed) return;
    ssize_t n;
    while ((n = splice(src, NULL, pipe_wr, NULL, PIPE_BUF_SIZE,
                       SPLICE_F_NONBLOCK | SPLICE_F_MOVE)) > 0) {
        size_t remaining = (size_t)n;
        while (remaining > 0) {
            ssize_t m = splice(pipe_rd, NULL, dst, NULL, remaining,
                               SPLICE_F_NONBLOCK | SPLICE_F_MOVE);
            if (m > 0) { remaining -= (size_t)m; continue; }
            if (m < 0 && errno == EAGAIN) {
                /* dst buffer full — poll until writable (max 5s) */
                struct pollfd pfd = { .fd = dst, .events = POLLOUT };
                if (poll(&pfd, 1, 5000) <= 0) { close_conn(c); return; }
                continue;
            }
            close_conn(c); return; /* real error or EOF */
        }
    }
    if (n == 0) { close_conn(c); return; } /* EOF */
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

/* ─── Request parsing ────────────────────────────────────────────── */
typedef struct {
    char method[8];
    char path[256];
    char cookie[1024];
    char body[4096];
    int  body_len;
    int  is_secure;
} HttpRequest;

static int parse_request(const char *buf, size_t len, HttpRequest *req) {
    memset(req, 0, sizeof(*req));
    if (sscanf(buf, "%7s %255s", req->method, req->path) < 2) return 0;

    const char *p = strstr(buf, "\r\nCookie:");
    if (!p) p = strstr(buf, "\r\ncookie:");
    if (p) {
        p += 9;
        while (*p == ' ') p++;
        const char *end = strstr(p, "\r\n");
        size_t clen = end ? (size_t)(end - p) : strlen(p);
        if (clen >= sizeof(req->cookie)) clen = sizeof(req->cookie) - 1;
        memcpy(req->cookie, p, clen);
    }

    const char *xfp = strstr(buf, "\r\nX-Forwarded-Proto:");
    if (!xfp) xfp = strstr(buf, "\r\nx-forwarded-proto:");
    if (xfp) {
        xfp += 21;
        while (*xfp == ' ') xfp++;
        req->is_secure = (strncasecmp(xfp, "https", 5) == 0);
    }
    if (g_force_secure) req->is_secure = 1;

    const char *body = strstr(buf, "\r\n\r\n");
    if (body) {
        body += 4;
        size_t blen = len - (size_t)(body - buf);
        if (blen >= sizeof(req->body)) blen = sizeof(req->body) - 1;
        memcpy(req->body, body, blen);
        req->body_len = (int)blen;
    }
    return 1;
}

/* ─── PendingRequest management ──────────────────────────────────── */
static PendingRequest *alloc_pending(void) {
    for (int i = 0; i < MAX_PENDING; i++) {
        if (!g_pending[i].in_use) return &g_pending[i];
    }
    return NULL;
}

static void free_pending(PendingRequest *pr) {
    if (pr->fd >= 0) {
        epoll_ctl(g_epoll_fd, EPOLL_CTL_DEL, pr->fd, NULL);
        close(pr->fd);
    }
    pr->fd = -1;
    pr->in_use = 0;
}

/* ─── Route a complete HTTP request ─────────────────────────────── */
static void route_complete_request(PendingRequest *pr) {
    HttpRequest req;
    if (!parse_request(pr->buf, pr->buf_len, &req)) {
        LOGW("parse_request failed");
        free_pending(pr);
        return;
    }

    int fd = pr->fd;
    uint32_t peer_ip = pr->peer_ip;
    size_t raw_len = pr->buf_len;
    char raw_buf[PENDING_BUF_SIZE];
    memcpy(raw_buf, pr->buf, raw_len);

    /* Detach fd from pending — we'll manage it from here */
    epoll_ctl(g_epoll_fd, EPOLL_CTL_DEL, fd, NULL);
    pr->fd = -1;
    pr->in_use = 0;

    LOGI("req: %s %s cookie_len=%d has_jwt=%d is_secure=%d",
         req.method, req.path, (int)strlen(req.cookie),
         strstr(req.cookie, "oc_jwt=") ? 1 : 0, req.is_secure);

    /* Unauthenticated health endpoint — allows webctl health check */
    if (strcmp(req.method, "GET") == 0 && strcmp(req.path, "/api/v2/global/health") == 0) {
        http_send(fd, 200, "OK", "application/json", NULL,
                  "{\"healthy\":true,\"gateway\":true}", 31);
        close(fd);
        return;
    }

    /* Handle auth routes BEFORE JWT check — these are gateway-owned */
    if (strcmp(req.method, "POST") == 0 && strcmp(req.path, "/auth/login/google") == 0) {
        char google_email[256] = {};
        if (!form_extract_value(req.body, "google_email", google_email, sizeof(google_email)) || !google_email[0]) {
            http_send(fd, 400, "Bad Request", "text/plain", NULL,
                      "Missing google_email", 21);
            close(fd);
            return;
        }

        char bound_username[256] = {};
        if (!google_binding_lookup(google_email, bound_username, sizeof(bound_username))) {
            LOGW("google login rejected: unbound identity '%s'", google_email);
            http_send(fd, 403, "Forbidden", "text/plain", NULL,
                      "Google identity is not bound to a Linux user", 46);
            close(fd);
            return;
        }

        struct passwd *pw = getpwnam(bound_username);
        if (!pw) {
            LOGW("google login rejected: bound Linux user missing for '%s' -> '%s'", google_email, bound_username);
            http_send(fd, 403, "Forbidden", "text/plain", NULL,
                      "Bound Linux user is unavailable", 32);
            close(fd);
            return;
        }

        LOGI("google login accepted: '%s' -> '%s'", google_email, bound_username);
        send_login_success(fd, pw->pw_name, req.is_secure);
        close(fd);
        return;
    }

    if (strcmp(req.method, "POST") == 0 && strcmp(req.path, "/auth/login") == 0) {
        goto handle_login;
    }

    /* Gateway-mode auth session: tell the SPA that auth is NOT SPA-managed.
     * The SPA will not show its own login form.  If a cached SPA tries to
     * make API calls without JWT, authorizedFetch gets 401 and redirects
     * the browser to "/" → gateway's own PAM login page. */
    if (strcmp(req.path, "/global/auth/session") == 0 ||
        strcmp(req.path, "/api/v2/global/auth/session") == 0) {
        const char *body = "{\"enabled\":false,\"authenticated\":true}";
        http_send(fd, 200, "OK", "application/json",
                  "Cache-Control: no-store\r\n", body, strlen(body));
        close(fd);
        return;
    }

    /* Gateway-mode auth login (SPA JSON API): handle via PAM, same as form */
    if ((strcmp(req.path, "/global/auth/login") == 0 ||
         strcmp(req.path, "/api/v2/global/auth/login") == 0) &&
        strcmp(req.method, "POST") == 0) {
        char spa_user[256] = {}, spa_pass[256] = {};
        /* Try JSON body first, then form-encoded */
        int got_creds = 0;
        if (req.body[0] && strstr(req.body, "\"username\"")) {
            got_creds = json_extract_string(req.body, "username", spa_user, sizeof(spa_user)) &&
                        json_extract_string(req.body, "password", spa_pass, sizeof(spa_pass));
        }
        if (!got_creds) {
            got_creds = form_extract_value(req.body, "username", spa_user, sizeof(spa_user)) &&
                        form_extract_value(req.body, "password", spa_pass, sizeof(spa_pass));
        }
        if (!got_creds || !spa_user[0]) {
            const char *err = "{\"error\":\"Missing username or password\"}";
            http_send(fd, 400, "Bad Request", "application/json", NULL, err, strlen(err));
            close(fd);
            return;
        }
        LOGI("SPA JSON login attempt for '%s'", spa_user);
        submit_auth_job_ex(fd, spa_user, spa_pass, req.is_secure, peer_ip, 1);
        return;
    }

    /* Gateway-mode logout: clear JWT cookie and redirect to login page.
     * MUST be intercepted here — if passed through splice proxy, daemon
     * might clear its own session cookie, leaving the browser without JWT. */
    if (strcmp(req.path, "/global/auth/logout") == 0 ||
        strcmp(req.path, "/api/v2/global/auth/logout") == 0) {
        LOGI("logout: clearing JWT cookie");
        const char *body = "{\"ok\":true}";
        http_send(fd, 200, "OK", "application/json",
                  "Cache-Control: no-store\r\nSet-Cookie: oc_jwt=; Path=/; Max-Age=0\r\n",
                  body, strlen(body));
        close(fd);
        return;
    }

    /* Check for valid JWT cookie */
    char *jwt_val = strstr(req.cookie, "oc_jwt=");
    if (jwt_val) {
        jwt_val += 7;
        char *end = strchr(jwt_val, ';');
        if (end) *end = '\0';

        char username[64] = {};
        uid_t uid = 0;
        if (jwt_verify(jwt_val, username, &uid)) {
            LOGI("JWT valid for user='%s' uid=%d", username, (int)uid);
            DaemonInfo *d = find_or_create_daemon(username);
            if (!d) {
                LOGE("find_or_create_daemon returned NULL for '%s'", username);
            } else if (d->uid != uid) {
                LOGE("uid mismatch for '%s': jwt_uid=%u daemon_uid=%u", username, uid, d->uid);
            } else {
                LOGI("daemon entry for '%s': state=%d pid=%d socket='%s'",
                     username, d->state, d->pid, d->socket_path);
                /* Phase 4 (daemonization-v2): retry-once on splice failure.
                 * If start_splice_proxy fails, the daemon may have crashed
                 * between ensure_daemon_running and connect_unix. Mark DEAD
                 * and retry ensure+splice once before giving up. */
                for (int attempt = 0; attempt < 2; attempt++) {
                    if (!ensure_daemon_running(d)) {
                        LOGE("ensure_daemon_running FAILED for '%s' (attempt %d): "
                             "state=%d pid=%d socket='%s'",
                             username, attempt, d->state, d->pid, d->socket_path);
                        break;
                    }
                    LOGI("daemon ready for '%s' (attempt %d), starting splice proxy → socket='%s'",
                         username, attempt, d->socket_path);
                    Connection *conn = start_splice_proxy(fd, d);
                    if (conn) {
                        LOGI("splice proxy started for '%s', forwarding %zu bytes",
                             username, raw_len);
                        send(conn->daemon_fd, raw_buf, raw_len, MSG_NOSIGNAL);
                        return;
                    }
                    /* Splice connect failed — mark daemon dead so retry
                     * will re-adopt or re-spawn (handles adopted non-child
                     * daemons that crashed without SIGCHLD). */
                    LOGW("start_splice_proxy failed for '%s' (attempt %d): "
                         "socket='%s', marking DAEMON_DEAD",
                         username, attempt, d->socket_path);
                    d->state = DAEMON_DEAD;
                }
            }
            /* Daemon failed — clear cookie via HTTP header + JS and redirect to login */
            LOGW("daemon unavailable for '%s', clearing JWT and redirecting to login", username);
            const char *clear_body =
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
                "<script>"
                "document.cookie=\"oc_jwt=; Path=/; Max-Age=0\";"
                "window.location.replace(\"/\");"
                "</script></head><body></body></html>";
            http_send(fd, 401, "Unauthorized", "text/html; charset=utf-8",
                      "Cache-Control: no-store\r\nSet-Cookie: oc_jwt=; Path=/; Max-Age=0\r\n",
                      clear_body, strlen(clear_body));
            close(fd);
            return;
        }

        LOGW("JWT verify failed — clearing cookie via HTTP header + JS");
        const char *clear_body =
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
            "<script>"
            "document.cookie=\"oc_jwt=; Path=/; Max-Age=0\";"
            "window.location.replace(\"/\");"
            "</script></head><body></body></html>";
        http_send(fd, 401, "Unauthorized", "text/html; charset=utf-8",
                  "Cache-Control: no-store\r\nSet-Cookie: oc_jwt=; Path=/; Max-Age=0\r\n",
                  clear_body, strlen(clear_body));
        close(fd);
        return;
    }

    /* No valid session — handle POST /auth/login */
handle_login:
    if (strcmp(req.method, "POST") == 0 && strcmp(req.path, "/auth/login") == 0) {
        /* Parse form body for username/password */
        char raw_user[256] = {}, raw_pass[256] = {};
        form_extract_value(req.body, "username", raw_user, sizeof(raw_user));
        form_extract_value(req.body, "password", raw_pass, sizeof(raw_pass));

        if (!raw_user[0] || !raw_pass[0]) {
            serve_login_page(fd);
            close(fd);
            return;
        }

        /* Rate limit check */
        if (!rate_limit_check(peer_ip)) {
            LOGW("rate limited login from %u.%u.%u.%u",
                 (peer_ip >> 24) & 0xff, (peer_ip >> 16) & 0xff,
                 (peer_ip >> 8) & 0xff, peer_ip & 0xff);
            http_send(fd, 429, "Too Many Requests", "text/plain", NULL,
                      "Too many failed login attempts. Try again later.", 47);
            close(fd);
            return;
        }

        /* Submit PAM auth to thread — fd stays open, main loop continues */
        LOGI("auth_login: submitting PAM for user='%s'", raw_user);
        if (!submit_auth_job(fd, raw_user, raw_pass, req.is_secure, peer_ip)) {
            http_send(fd, 503, "Service Unavailable", "text/plain", NULL,
                      "Auth service busy", 17);
            close(fd);
        }
        /* Clear password from stack */
        memset(raw_pass, 0, sizeof(raw_pass));
        return;
    }

    /* API and WebSocket requests without JWT must get 401 JSON, not HTML.
     * The SPA needs a machine-readable signal to detect auth loss and
     * redirect to the login page.  Serving HTML to XHR/fetch breaks JSON
     * parsing; serving HTML to WebSocket upgrade breaks the handshake. */
    if (strncmp(req.path, "/api/", 5) == 0 ||
        strncmp(req.path, "/pty/", 5) == 0) {
        const char *json_body = "{\"error\":\"unauthorized\",\"message\":\"Authentication required\"}";
        http_send(fd, 401, "Unauthorized", "application/json",
                  "Cache-Control: no-store\r\n",
                  json_body, strlen(json_body));
        close(fd);
        return;
    }

    serve_login_page(fd);
    close(fd);
}

/* ─── Handle completed PAM auth jobs ─────────────────────────────── */
static void drain_auth_completions(void) {
    /* Read eventfd to clear it */
    uint64_t val;
    ssize_t r = read(g_auth_eventfd, &val, sizeof(val));
    (void)r;

    /* Process all completed jobs */
    while (1) {
        pthread_mutex_lock(&g_auth_mutex);
        if (g_auth_queue_head == g_auth_queue_tail) {
            pthread_mutex_unlock(&g_auth_mutex);
            break;
        }
        AuthJob *job = &g_auth_queue[g_auth_queue_head];
        if (!job->done) {
            pthread_mutex_unlock(&g_auth_mutex);
            break;
        }
        /* Copy job data and advance head */
        AuthJob local = *job;
        g_auth_queue_head = (g_auth_queue_head + 1) % MAX_AUTH_QUEUE;
        pthread_mutex_unlock(&g_auth_mutex);

        if (local.result) {
            /* PAM success: sign JWT */
            rate_limit_clear(local.peer_ip);
            consec_fail_clear(local.peer_ip);
            LOGI("auth complete: PAM success for '%s' (json_api=%d), signing JWT",
                 local.username, local.is_json_api);
            send_login_success_ex(local.client_fd, local.username,
                                  local.is_secure, local.is_json_api);
        } else {
            /* PAM failure */
            rate_limit_record_failure(local.peer_ip);
            consec_fail_record(local.peer_ip);
            LOGW("auth complete: PAM failed for '%s' (json_api=%d)",
                 local.username, local.is_json_api);
            if (local.is_json_api) {
                const char *body = "{\"error\":\"Invalid username or password\"}";
                http_send(local.client_fd, 401, "Unauthorized", "application/json",
                          NULL, body, strlen(body));
            } else {
                const char *redir = "HTTP/1.1 303 See Other\r\nLocation: /?error=1\r\nConnection: close\r\n\r\n";
                send(local.client_fd, redir, strlen(redir), MSG_NOSIGNAL);
            }
        }
        close(local.client_fd);
    }
}

/* ─── Timeout sweep for pending requests ─────────────────────────── */
static void sweep_pending_timeouts(void) {
    time_t now = time(NULL);
    for (int i = 0; i < MAX_PENDING; i++) {
        PendingRequest *pr = &g_pending[i];
        if (pr->in_use && now - pr->accept_time > PENDING_TIMEOUT_SEC) {
            LOGW("pending request timeout (fd=%d, age=%lds)", pr->fd, (long)(now - pr->accept_time));
            http_send(pr->fd, 408, "Request Timeout", "text/plain", NULL,
                      "Request timeout", 15);
            free_pending(pr);
        }
    }
}

/* ─── Main event loop ────────────────────────────────────────────── */
int main(int argc, char *argv[]) {
    (void)argc; (void)argv;

    /* Init tables */
    for (int i = 0; i < MAX_CONNS; i++) {
        g_conns[i].client_fd = g_conns[i].daemon_fd = -1;
        g_conns[i].pipe_c2d[0] = g_conns[i].pipe_c2d[1] = -1;
        g_conns[i].pipe_d2c[0] = g_conns[i].pipe_d2c[1] = -1;
        g_conns[i].closed = 0;
    }
    for (int i = 0; i < MAX_PENDING; i++) {
        g_pending[i].fd = -1;
        g_pending[i].in_use = 0;
    }
    memset(g_rate_limit, 0, sizeof(g_rate_limit));
    memset(g_consec_fail, 0, sizeof(g_consec_fail));

    /* Ban list: load persistent bans from file */
    banlist_load();

    /* JWT secret: file-backed persistence (DD-5) */
    if (!jwt_load_or_create_secret()) return 1;

    /* Force Secure cookie flag — auto-detect from OPENCODE_PUBLIC_URL or explicit env */
    {
        const char *fs = getenv("OPENCODE_GATEWAY_FORCE_SECURE");
        const char *pub_url = getenv("OPENCODE_PUBLIC_URL");
        if ((fs && fs[0] == '1') || (pub_url && strncmp(pub_url, "https", 5) == 0)) {
            g_force_secure = 1;
            LOGI("force-secure: cookies will always include Secure flag");
        }
    }

    /* Load login.html */
    const char *html_path = getenv("OPENCODE_LOGIN_HTML");
    if (!html_path) html_path = "/usr/local/share/opencode/login.html";
    FILE *f = fopen(html_path, "r");
    if (f) {
        g_login_html_len = fread(g_login_html, 1, sizeof(g_login_html)-1, f);
        fclose(f);
    } else {
        const char *fallback = "<html><body><h1>TheSmartAI Login</h1>"
            "<form method='POST' action='/auth/login'>"
            "User: <input name='username'><br>"
            "Pass: <input type='password' name='password'><br>"
            "<button>Login</button></form></body></html>";
        strncpy(g_login_html, fallback, sizeof(g_login_html)-1);
        g_login_html_len = strlen(g_login_html);
    }

    /* Parse OPENCODE_BIN into argv (DD-8) */
    const char *bin = getenv("OPENCODE_BIN");
    if (bin) strncpy(g_opencode_bin, bin, sizeof(g_opencode_bin)-1);
    parse_opencode_argv();

    /* Signals */
    struct sigaction sa = { .sa_handler = on_sigterm, .sa_flags = 0 };
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);
    sa.sa_handler = on_sigchld;
    sa.sa_flags   = SA_RESTART | SA_NOCLDSTOP;
    sigaction(SIGCHLD, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    /* PAM availability probe (DD-7 / 4.2) */
    {
        pam_handle_t *probe_pamh = NULL;
        int pam_rc = pam_start("login", "root", &(struct pam_conv){NULL, NULL}, &probe_pamh);
        if (pam_rc != PAM_SUCCESS) {
            LOGE("PAM unavailable (pam_start returned %d: %s). "
                 "Ensure PAM is configured (e.g. /etc/pam.d/login exists).",
                 pam_rc, pam_strerror(probe_pamh, pam_rc));
            if (probe_pamh) pam_end(probe_pamh, pam_rc);
            return 1;
        }
        pam_end(probe_pamh, PAM_SUCCESS);
        LOGI("PAM probe: service 'login' available");
    }

    /* Auth eventfd for PAM thread notifications */
    g_auth_eventfd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (g_auth_eventfd < 0) { LOGE("eventfd: %s", strerror(errno)); return 1; }

    /* Bind TCP socket */
    int port = GATEWAY_PORT_DEFAULT;
    const char *port_env = getenv("OPENCODE_GATEWAY_PORT");
    if (port_env) port = atoi(port_env);

    g_listen_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
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

    /* epoll setup */
    g_epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (g_epoll_fd < 0) { LOGE("epoll_create1: %s", strerror(errno)); return 1; }

    /* Register listen fd */
    g_listen_ectx.type = ECTX_LISTEN;
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.ptr = &g_listen_ectx;
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, g_listen_fd, &ev);

    /* Register auth eventfd */
    g_auth_ectx.type = ECTX_AUTH_NOTIFY;
    ev.data.ptr = &g_auth_ectx;
    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, g_auth_eventfd, &ev);

    LOGI("thesmartai-gateway listening on :%d (non-blocking, thread-per-auth)", port);

    struct epoll_event events[MAX_EVENTS];
    time_t last_sweep = time(NULL);

    while (g_running) {
        int nev = epoll_wait(g_epoll_fd, events, MAX_EVENTS, 1000);
        if (nev < 0) {
            if (errno == EINTR) continue;
            LOGE("epoll_wait: %s", strerror(errno));
            break;
        }

        for (int i = 0; i < nev; i++) {
            EpollCtx *ectx = (EpollCtx *)events[i].data.ptr;

            switch (ectx->type) {

            case ECTX_LISTEN: {
                /* Accept new connections — non-blocking, register as PENDING */
                while (1) {
                    struct sockaddr_in peer;
                    socklen_t peerlen = sizeof(peer);
                    int client = accept4(g_listen_fd, (struct sockaddr *)&peer, &peerlen, SOCK_CLOEXEC);
                    if (client < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        LOGE("accept: %s", strerror(errno));
                        break;
                    }
                    set_nonblock(client);

                    /* Fail2ban: silently drop banned IPs at accept time */
                    {
                        uint32_t pip = ntohl(peer.sin_addr.s_addr);
                        if (ban_check(pip)) {
                            close(client);
                            continue;
                        }
                    }

                    PendingRequest *pr = alloc_pending();
                    if (!pr) {
                        LOGW("pending table full, rejecting connection");
                        const char *busy = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
                        send(client, busy, strlen(busy), MSG_NOSIGNAL);
                        close(client);
                        continue;
                    }

                    pr->fd = client;
                    pr->buf_len = 0;
                    pr->accept_time = time(NULL);
                    pr->peer_ip = ntohl(peer.sin_addr.s_addr);
                    pr->in_use = 1;

                    pr->ectx.type = ECTX_PENDING;
                    pr->ectx.pending = pr;

                    struct epoll_event pev = { .events = EPOLLIN, .data.ptr = &pr->ectx };
                    epoll_ctl(g_epoll_fd, EPOLL_CTL_ADD, client, &pev);
                }
                break;
            }

            case ECTX_PENDING: {
                /* Accumulate HTTP request data */
                PendingRequest *pr = ectx->pending;
                if (!pr->in_use) break;

                ssize_t n = recv(pr->fd, pr->buf + pr->buf_len,
                                 PENDING_BUF_SIZE - pr->buf_len - 1, 0);
                if (n <= 0) {
                    if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
                        free_pending(pr);
                    }
                    break;
                }
                pr->buf_len += (size_t)n;
                pr->buf[pr->buf_len] = '\0';

                /* Check for complete header */
                if (strstr(pr->buf, "\r\n\r\n")) {
                    route_complete_request(pr);
                } else if (pr->buf_len >= PENDING_BUF_SIZE - 1) {
                    /* Buffer full, no complete header — reject */
                    http_send(pr->fd, 400, "Bad Request", "text/plain", NULL,
                              "Request too large", 17);
                    free_pending(pr);
                }
                break;
            }

            case ECTX_AUTH_NOTIFY: {
                drain_auth_completions();
                break;
            }

            case ECTX_SPLICE_CLIENT: {
                Connection *c = ectx->conn;
                if (c->closed) break;
                if (events[i].events & EPOLLIN) {
                    /* Client → daemon direction only */
                    splice_one_direction(c, c->client_fd, c->pipe_c2d[1], c->pipe_c2d[0], c->daemon_fd);
                }
                if (events[i].events & (EPOLLHUP | EPOLLERR)) {
                    close_conn(c);
                }
                break;
            }

            case ECTX_SPLICE_DAEMON: {
                Connection *c = ectx->conn;
                if (c->closed) break;
                if (events[i].events & EPOLLIN) {
                    /* Daemon → client direction only */
                    splice_one_direction(c, c->daemon_fd, c->pipe_d2c[1], c->pipe_d2c[0], c->client_fd);
                }
                if (events[i].events & (EPOLLHUP | EPOLLERR)) {
                    /* Phase 4 (daemonization-v2): mark daemon dead on
                     * daemon-side HUP/ERR so next request re-adopts or
                     * re-spawns immediately (no stale PID check needed). */
                    if (c->daemon && c->daemon->state == DAEMON_READY) {
                        LOGW("daemon-side HUP/ERR for %s (pid %d), marking DAEMON_DEAD",
                             c->daemon->username, c->daemon->pid);
                        c->daemon->state = DAEMON_DEAD;
                    }
                    close_conn(c);
                }
                break;
            }

            } /* switch */
        } /* for events */

        /* Periodic sweep for pending request timeouts */
        time_t now = time(NULL);
        if (now - last_sweep >= 5) {
            sweep_pending_timeouts();
            last_sweep = now;
        }
    }

    /* Graceful shutdown */
    LOGI("shutting down");
    close(g_listen_fd);
    close(g_auth_eventfd);
    for (int i = 0; i < g_ndaemons; i++) {
        if (g_daemons[i].pid > 0) kill(g_daemons[i].pid, SIGTERM);
    }
    for (int i = 0; i < MAX_CONNS; i++) {
        if (g_conns[i].client_fd >= 0) close_conn(&g_conns[i]);
    }
    for (int i = 0; i < MAX_PENDING; i++) {
        if (g_pending[i].in_use) free_pending(&g_pending[i]);
    }
    close(g_epoll_fd);

    /* Free parsed argv */
    for (int i = 0; i < g_opencode_argc; i++) free(g_opencode_argv[i]);

    return 0;
}
