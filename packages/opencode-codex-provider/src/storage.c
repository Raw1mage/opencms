/*
 * storage.c — Credential persistence (file backend)
 *
 * auth.json format (codex-rs compatible):
 * {
 *   "auth_mode": "chatgpt" | "api_key",
 *   "openai_api_key": "sk-...",       // if api_key mode
 *   "id_token": "jwt...",             // if chatgpt mode
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "account_id": "...",
 *   "plan_type": "pro",
 *   "updated_at": "2026-03-28T12:00:00Z"
 * }
 */

/* _GNU_SOURCE must be defined at build level (CMakeLists.txt) for strptime/timegm */
#include "codex_provider.h"
#include <cjson/cJSON.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef _WIN32
  #include <fcntl.h>
  #include <sys/stat.h>
  #include <sys/types.h>
  #include <unistd.h>
#endif

/* Forward declarations */
extern int codex_jwt_extract_claims(const char *id_token, codex_jwt_claims_t *out);
extern void codex_jwt_claims_free(codex_jwt_claims_t *claims);

/* --------------------------------------------------------------------------
 * In-memory auth state (single global)
 * ----------------------------------------------------------------------- */

typedef struct {
    codex_auth_mode_t  mode;
    char              *api_key;       /* owned, for APIKEY mode */
    char              *id_token;      /* owned JWT string */
    char              *access_token;  /* owned */
    char              *refresh_token; /* owned */
    char              *account_id;    /* owned */
    char              *email;         /* owned */
    char              *user_id;       /* owned */
    codex_plan_type_t  plan_type;
    int64_t            last_refresh;  /* epoch seconds */
    int                loaded;
} codex_auth_state_t;

static codex_auth_state_t g_auth = {0};
static char              *g_storage_path = NULL;
static codex_storage_mode_t g_storage_mode = CODEX_STORAGE_FILE;

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

static void free_str(char **p)
{
    if (*p) {
        /* Zero sensitive data before free */
        memset(*p, 0, strlen(*p));
        free(*p);
        *p = NULL;
    }
}

static void auth_state_clear(void)
{
    free_str(&g_auth.api_key);
    free_str(&g_auth.id_token);
    free_str(&g_auth.access_token);
    free_str(&g_auth.refresh_token);
    free_str(&g_auth.account_id);
    free_str(&g_auth.email);
    free_str(&g_auth.user_id);
    memset(&g_auth, 0, sizeof(g_auth));
}

static char *safe_strdup(const char *s)
{
    return s ? strdup(s) : NULL;
}

/* --------------------------------------------------------------------------
 * codex_storage_init / cleanup
 * ----------------------------------------------------------------------- */

int codex_storage_init(const char *codex_home, codex_storage_mode_t mode)
{
    g_storage_mode = mode;

    if (codex_home) {
        /* Ensure directory exists */
#ifndef _WIN32
        mkdir(codex_home, 0700);
#endif
        size_t len = strlen(codex_home) + sizeof("/auth.json");
        g_storage_path = malloc(len);
        if (!g_storage_path) return CODEX_ERR_OOM;
        snprintf(g_storage_path, len, "%s/auth.json", codex_home);
    }

    return CODEX_OK;
}

void codex_storage_cleanup(void)
{
    auth_state_clear();
    free(g_storage_path);
    g_storage_path = NULL;
}

/* --------------------------------------------------------------------------
 * codex_storage_save — serialize auth state to auth.json
 * ----------------------------------------------------------------------- */

int codex_storage_save(void)
{
    if (!g_storage_path) return CODEX_ERR_STORAGE_WRITE;

    cJSON *root = cJSON_CreateObject();
    if (!root) return CODEX_ERR_OOM;

    /* auth_mode */
    const char *mode_str = "chatgpt";
    if (g_auth.mode == CODEX_AUTH_API_KEY) mode_str = "api_key";
    else if (g_auth.mode == CODEX_AUTH_EXTERNAL) mode_str = "chatgpt_auth_tokens";
    cJSON_AddStringToObject(root, "auth_mode", mode_str);

    /* Fields */
    if (g_auth.api_key)
        cJSON_AddStringToObject(root, "openai_api_key", g_auth.api_key);
    if (g_auth.id_token)
        cJSON_AddStringToObject(root, "id_token", g_auth.id_token);
    if (g_auth.access_token)
        cJSON_AddStringToObject(root, "access_token", g_auth.access_token);
    if (g_auth.refresh_token)
        cJSON_AddStringToObject(root, "refresh_token", g_auth.refresh_token);
    if (g_auth.account_id)
        cJSON_AddStringToObject(root, "account_id", g_auth.account_id);
    if (g_auth.email)
        cJSON_AddStringToObject(root, "plan_type",
            g_auth.plan_type == CODEX_PLAN_PRO  ? "pro" :
            g_auth.plan_type == CODEX_PLAN_PLUS ? "plus" :
            g_auth.plan_type == CODEX_PLAN_FREE ? "free" :
            g_auth.plan_type == CODEX_PLAN_TEAM ? "team" :
            g_auth.plan_type == CODEX_PLAN_BUSINESS ? "business" :
            g_auth.plan_type == CODEX_PLAN_ENTERPRISE ? "enterprise" :
            g_auth.plan_type == CODEX_PLAN_EDU ? "edu" : "unknown");

    /* updated_at as ISO 8601 */
    time_t now = time(NULL);
    struct tm *utc = gmtime(&now);
    char ts[64];
    strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", utc);
    cJSON_AddStringToObject(root, "updated_at", ts);

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json_str) return CODEX_ERR_OOM;

    /* Atomic write: temp file → fchmod 0600 → rename */
#ifndef _WIN32
    char tmp_path[4096];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp.XXXXXX", g_storage_path);

    int fd = mkstemp(tmp_path);
    if (fd < 0) {
        free(json_str);
        return CODEX_ERR_STORAGE_WRITE;
    }

    size_t json_len = strlen(json_str);
    ssize_t written = write(fd, json_str, json_len);
    free(json_str);

    if (written < 0 || (size_t)written != json_len) {
        close(fd);
        unlink(tmp_path);
        return CODEX_ERR_STORAGE_WRITE;
    }

    if (fsync(fd) != 0) {
        close(fd);
        unlink(tmp_path);
        return CODEX_ERR_STORAGE_WRITE;
    }

    if (fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
        close(fd);
        unlink(tmp_path);
        return CODEX_ERR_STORAGE_WRITE;
    }

    close(fd);

    if (rename(tmp_path, g_storage_path) != 0) {
        unlink(tmp_path);
        return CODEX_ERR_STORAGE_WRITE;
    }
#else
    /* Windows: simple write (no atomic rename guarantee) */
    FILE *fp = fopen(g_storage_path, "wb");
    if (!fp) { free(json_str); return CODEX_ERR_STORAGE_WRITE; }
    fputs(json_str, fp);
    fclose(fp);
    free(json_str);
#endif

    g_auth.last_refresh = (int64_t)now;
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_storage_load_auth — read auth.json into memory
 * ----------------------------------------------------------------------- */

int codex_storage_load_auth(const char *expected_account_id)
{
    if (!g_storage_path) return CODEX_ERR_STORAGE_READ;

    FILE *fp = fopen(g_storage_path, "rb");
    if (!fp) return CODEX_ERR_AUTH_NO_CREDENTIALS;

    fseek(fp, 0, SEEK_END);
    long fsize = ftell(fp);
    fseek(fp, 0, SEEK_SET);

    if (fsize <= 0 || fsize > 1024 * 1024) {
        fclose(fp);
        return CODEX_ERR_AUTH_CORRUPT;
    }

    char *buf = malloc((size_t)fsize + 1);
    if (!buf) { fclose(fp); return CODEX_ERR_OOM; }

    size_t nread = fread(buf, 1, (size_t)fsize, fp);
    fclose(fp);
    buf[nread] = '\0';

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (!root) return CODEX_ERR_AUTH_CORRUPT;

    /* Parse auth_mode */
    const cJSON *mode_item = cJSON_GetObjectItemCaseSensitive(root, "auth_mode");
    codex_auth_mode_t mode = CODEX_AUTH_NONE;
    if (cJSON_IsString(mode_item)) {
        if (strcmp(mode_item->valuestring, "chatgpt") == 0)
            mode = CODEX_AUTH_CHATGPT;
        else if (strcmp(mode_item->valuestring, "api_key") == 0 ||
                 strcmp(mode_item->valuestring, "apikey") == 0)
            mode = CODEX_AUTH_API_KEY;
        else if (strcmp(mode_item->valuestring, "chatgpt_auth_tokens") == 0)
            mode = CODEX_AUTH_EXTERNAL;
    }

    /* Account ID guard */
    const cJSON *acct = cJSON_GetObjectItemCaseSensitive(root, "account_id");
    if (expected_account_id && cJSON_IsString(acct)) {
        if (strcmp(acct->valuestring, expected_account_id) != 0) {
            cJSON_Delete(root);
            return CODEX_ERR_AUTH_ACCOUNT_MISMATCH;
        }
    }

    /* Clear and repopulate */
    auth_state_clear();
    g_auth.mode = mode;
    g_auth.loaded = 1;

    const cJSON *item;

    item = cJSON_GetObjectItemCaseSensitive(root, "openai_api_key");
    if (cJSON_IsString(item)) g_auth.api_key = strdup(item->valuestring);

    item = cJSON_GetObjectItemCaseSensitive(root, "id_token");
    if (cJSON_IsString(item)) g_auth.id_token = strdup(item->valuestring);

    item = cJSON_GetObjectItemCaseSensitive(root, "access_token");
    if (cJSON_IsString(item)) g_auth.access_token = strdup(item->valuestring);

    item = cJSON_GetObjectItemCaseSensitive(root, "refresh_token");
    if (cJSON_IsString(item)) g_auth.refresh_token = strdup(item->valuestring);

    item = cJSON_GetObjectItemCaseSensitive(root, "account_id");
    if (cJSON_IsString(item)) g_auth.account_id = strdup(item->valuestring);

    /* Extract claims from id_token if available */
    if (g_auth.id_token) {
        codex_jwt_claims_t claims;
        if (codex_jwt_extract_claims(g_auth.id_token, &claims) == CODEX_OK) {
            g_auth.email    = safe_strdup(claims.email);
            g_auth.user_id  = safe_strdup(claims.user_id);
            g_auth.plan_type = claims.plan_type;
            if (!g_auth.account_id)
                g_auth.account_id = safe_strdup(claims.account_id);
            codex_jwt_claims_free(&claims);
        }
    }

    /* Parse plan_type from JSON as fallback */
    item = cJSON_GetObjectItemCaseSensitive(root, "plan_type");
    if (cJSON_IsString(item) && g_auth.plan_type == CODEX_PLAN_UNKNOWN) {
        if (strcmp(item->valuestring, "pro") == 0) g_auth.plan_type = CODEX_PLAN_PRO;
        else if (strcmp(item->valuestring, "plus") == 0) g_auth.plan_type = CODEX_PLAN_PLUS;
        else if (strcmp(item->valuestring, "free") == 0) g_auth.plan_type = CODEX_PLAN_FREE;
    }

    /* Parse updated_at → epoch */
    item = cJSON_GetObjectItemCaseSensitive(root, "updated_at");
    if (cJSON_IsString(item)) {
        struct tm tm = {0};
        if (strptime(item->valuestring, "%Y-%m-%dT%H:%M:%S", &tm)) {
            g_auth.last_refresh = (int64_t)timegm(&tm);
        }
    }

    cJSON_Delete(root);
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_storage_delete — remove auth.json
 * ----------------------------------------------------------------------- */

int codex_storage_delete(void)
{
    auth_state_clear();
    if (g_storage_path) {
        unlink(g_storage_path);
    }
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * Auth state accessors (used by auth.c, transport.c)
 * ----------------------------------------------------------------------- */

codex_auth_mode_t codex_auth_get_mode(void)     { return g_auth.mode; }
const char *codex_auth_get_access_token(void)    { return g_auth.access_token; }
const char *codex_auth_get_refresh_token(void)   { return g_auth.refresh_token; }
const char *codex_auth_get_account_id(void)      { return g_auth.account_id; }
const char *codex_auth_get_api_key(void)         { return g_auth.api_key; }
const char *codex_auth_get_id_token(void)        { return g_auth.id_token; }
int64_t     codex_auth_get_last_refresh(void)    { return g_auth.last_refresh; }

int codex_auth_is_stale(void)
{
    if (g_auth.mode != CODEX_AUTH_CHATGPT) return 0;
    if (g_auth.last_refresh == 0) return 1;
    int64_t now = (int64_t)time(NULL);
    int64_t eight_days = 8 * 24 * 60 * 60;
    return (now - g_auth.last_refresh) > eight_days;
}

/* --------------------------------------------------------------------------
 * Auth state mutators (used by auth.c)
 * ----------------------------------------------------------------------- */

void codex_auth_set_chatgpt(const char *id_token, const char *access_token,
                            const char *refresh_token, const char *account_id,
                            const char *email, codex_plan_type_t plan_type)
{
    auth_state_clear();
    g_auth.mode          = CODEX_AUTH_CHATGPT;
    g_auth.id_token      = safe_strdup(id_token);
    g_auth.access_token  = safe_strdup(access_token);
    g_auth.refresh_token = safe_strdup(refresh_token);
    g_auth.account_id    = safe_strdup(account_id);
    g_auth.email         = safe_strdup(email);
    g_auth.plan_type     = plan_type;
    g_auth.last_refresh  = (int64_t)time(NULL);
    g_auth.loaded        = 1;
}

void codex_auth_set_apikey(const char *key)
{
    auth_state_clear();
    g_auth.mode    = CODEX_AUTH_API_KEY;
    g_auth.api_key = safe_strdup(key);
    g_auth.loaded  = 1;
}

void codex_auth_update_tokens(const char *id_token, const char *access_token,
                              const char *refresh_token)
{
    if (id_token) {
        free_str(&g_auth.id_token);
        g_auth.id_token = strdup(id_token);
    }
    if (access_token) {
        free_str(&g_auth.access_token);
        g_auth.access_token = strdup(access_token);
    }
    if (refresh_token) {
        free_str(&g_auth.refresh_token);
        g_auth.refresh_token = strdup(refresh_token);
    }
    g_auth.last_refresh = (int64_t)time(NULL);
}

/* --------------------------------------------------------------------------
 * codex_get_auth_status (exported API)
 * ----------------------------------------------------------------------- */

CODEX_EXPORT int codex_get_auth_status(codex_auth_status_t *out)
{
    if (!out) return CODEX_ERR_INVALID_ARG;

    memset(out, 0, sizeof(*out));
    out->mode          = g_auth.mode;
    out->plan_type     = g_auth.plan_type;
    out->authenticated = (g_auth.access_token || g_auth.api_key) ? 1 : 0;
    out->stale         = codex_auth_is_stale();
    out->email         = g_auth.email;
    out->user_id       = g_auth.user_id;
    out->account_id    = g_auth.account_id;
    out->access_token  = g_auth.access_token;
    out->last_refresh_epoch = g_auth.last_refresh;

    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_logout (exported API)
 * ----------------------------------------------------------------------- */

CODEX_EXPORT int codex_logout(void)
{
    return codex_storage_delete();
}
