/*
 * provider.c — Plugin lifecycle and model catalog
 *
 * Implements: codex_init, codex_shutdown, codex_abi_version,
 *             codex_get_models, codex_strerror
 */

#include "codex_provider.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Forward declarations from other translation units */
extern int   codex_originator_init(const char *version);
extern void  codex_originator_cleanup(void);
extern int   codex_storage_init(const char *codex_home, codex_storage_mode_t mode);
extern void  codex_storage_cleanup(void);
extern int   codex_storage_load_auth(const char *expected_account_id);

/* --------------------------------------------------------------------------
 * Global state
 * ----------------------------------------------------------------------- */

typedef struct {
    int                  initialized;
    codex_config_t       config;

    /* Resolved paths / strings (owned copies) */
    char                *codex_home;
    char                *issuer_url;
    char                *client_id;
    char                *refresh_token_url;
    char                *base_url;
    char                *forced_workspace_id;
    char                *ca_cert_path;
    char                *residency;

    /* Runtime */
    uint16_t             callback_port;
    uint32_t             max_retries;
    uint32_t             stream_idle_timeout_ms;
} codex_global_t;

static codex_global_t g_codex = {0};

/* --------------------------------------------------------------------------
 * Helper: strdup_or_null
 * ----------------------------------------------------------------------- */

static char *strdup_or_null(const char *s)
{
    if (!s) return NULL;
    size_t len = strlen(s);
    char *copy = malloc(len + 1);
    if (copy) memcpy(copy, s, len + 1);
    return copy;
}

/* --------------------------------------------------------------------------
 * codex_init
 * ----------------------------------------------------------------------- */

CODEX_EXPORT int codex_init(const codex_config_t *config)
{
    if (g_codex.initialized)
        return CODEX_ERR_ALREADY_INITIALIZED;

    memset(&g_codex, 0, sizeof(g_codex));

    /* Resolve codex_home */
    const char *home = (config && config->codex_home) ? config->codex_home : NULL;
    if (!home) {
        const char *env_home = getenv("CODEX_HOME");
        if (env_home && env_home[0]) {
            home = env_home;
        } else {
            const char *user_home = getenv("HOME");
            if (!user_home) return CODEX_ERR_INVALID_ARG;
            size_t len = strlen(user_home) + sizeof("/.codex");
            char *buf = malloc(len);
            if (!buf) return CODEX_ERR_OOM;
            snprintf(buf, len, "%s/.codex", user_home);
            g_codex.codex_home = buf;
        }
    }
    if (!g_codex.codex_home)
        g_codex.codex_home = strdup_or_null(home);

    /* Resolve config fields */
    g_codex.issuer_url = strdup_or_null(
        (config && config->issuer_url) ? config->issuer_url
                                       : "https://auth.openai.com");
    g_codex.client_id = strdup_or_null(
        (config && config->client_id) ? config->client_id
                                      : "app_EMoamEEZ73f0CkXaXp7hrann");
    g_codex.refresh_token_url = strdup_or_null(
        (config && config->refresh_token_url) ? config->refresh_token_url : NULL);
    g_codex.base_url = strdup_or_null(
        (config && config->base_url) ? config->base_url : NULL);
    g_codex.forced_workspace_id = strdup_or_null(
        (config && config->forced_workspace_id) ? config->forced_workspace_id : NULL);
    g_codex.ca_cert_path = strdup_or_null(
        (config && config->ca_cert_path) ? config->ca_cert_path : NULL);
    g_codex.residency = strdup_or_null(
        (config && config->residency) ? config->residency : NULL);

    /* CA cert from env fallback */
    if (!g_codex.ca_cert_path) {
        const char *env_ca = getenv("CODEX_CA_CERTIFICATE");
        if (!env_ca) env_ca = getenv("SSL_CERT_FILE");
        g_codex.ca_cert_path = strdup_or_null(env_ca);
    }

    /* Refresh URL from env fallback */
    if (!g_codex.refresh_token_url) {
        const char *env_url = getenv("CODEX_REFRESH_TOKEN_URL_OVERRIDE");
        g_codex.refresh_token_url = strdup_or_null(env_url);
    }

    /* Numeric defaults */
    g_codex.callback_port = (config && config->callback_port)
                            ? config->callback_port : 1455;
    g_codex.max_retries = (config && config->max_retries)
                          ? config->max_retries : 5;
    g_codex.stream_idle_timeout_ms = (config && config->stream_idle_timeout_ms)
                                     ? config->stream_idle_timeout_ms : 300000;

    /* Initialize subsystems */
    const char *version = (config && config->version)
                          ? config->version : CODEX_PROVIDER_VERSION;
    int rc = codex_originator_init(version);
    if (rc != CODEX_OK) return rc;

    rc = codex_storage_init(g_codex.codex_home,
                            (config ? config->storage_mode : CODEX_STORAGE_FILE));
    if (rc != CODEX_OK) return rc;

    /* Try to load existing auth */
    codex_storage_load_auth(NULL);

    g_codex.initialized = 1;
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_shutdown
 * ----------------------------------------------------------------------- */

CODEX_EXPORT void codex_shutdown(void)
{
    if (!g_codex.initialized) return;

    codex_storage_cleanup();
    codex_originator_cleanup();

    free(g_codex.codex_home);
    free(g_codex.issuer_url);
    free(g_codex.client_id);
    free(g_codex.refresh_token_url);
    free(g_codex.base_url);
    free(g_codex.forced_workspace_id);
    free(g_codex.ca_cert_path);
    free(g_codex.residency);

    memset(&g_codex, 0, sizeof(g_codex));
}

/* --------------------------------------------------------------------------
 * codex_abi_version
 * ----------------------------------------------------------------------- */

CODEX_EXPORT int codex_abi_version(void)
{
    return CODEX_PROVIDER_ABI_VERSION;
}

/* --------------------------------------------------------------------------
 * codex_get_models — hardcoded model catalog
 * ----------------------------------------------------------------------- */

static const codex_model_t s_models[] = {
    {
        .id             = "gpt-5.1-codex-max",
        .name           = "GPT-5.1 Codex Max",
        .family         = "openai",
        .reasoning      = 1,
        .toolcall       = 1,
        .image_input    = 1,
        .context_window = 400000,
        .max_output     = 128000,
        .cost_input     = 15.0,
        .cost_output    = 120.0,
        .cost_reasoning = 120.0,
        .status         = "active",
    },
    {
        .id             = "gpt-5.1-codex-mini",
        .name           = "GPT-5.1 Codex Mini",
        .family         = "openai",
        .reasoning      = 0,
        .toolcall       = 1,
        .image_input    = 1,
        .context_window = 400000,
        .max_output     = 128000,
        .cost_input     = 1.5,
        .cost_output    = 6.0,
        .cost_reasoning = 0.0,
        .status         = "active",
    },
    {
        .id             = "gpt-5.2-codex",
        .name           = "GPT-5.2 Codex",
        .family         = "openai",
        .reasoning      = 1,
        .toolcall       = 1,
        .image_input    = 1,
        .context_window = 400000,
        .max_output     = 128000,
        .cost_input     = 1.5,
        .cost_output    = 6.0,
        .cost_reasoning = 6.0,
        .status         = "active",
    },
    {
        .id             = "gpt-5.3-codex",
        .name           = "GPT-5.3 Codex",
        .family         = "openai",
        .reasoning      = 1,
        .toolcall       = 1,
        .image_input    = 1,
        .context_window = 400000,
        .max_output     = 128000,
        .cost_input     = 1.5,
        .cost_output    = 6.0,
        .cost_reasoning = 6.0,
        .status         = "active",
    },
};

#define NUM_MODELS (int)(sizeof(s_models) / sizeof(s_models[0]))

CODEX_EXPORT int codex_get_models(codex_model_t *models, int *count)
{
    if (!models || !count) return CODEX_ERR_INVALID_ARG;
    int n = NUM_MODELS;
    if (n > CODEX_MAX_MODELS) n = CODEX_MAX_MODELS;
    memcpy(models, s_models, (size_t)n * sizeof(codex_model_t));
    *count = n;
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_strerror
 * ----------------------------------------------------------------------- */

CODEX_EXPORT const char *codex_strerror(codex_error_t err)
{
    switch (err) {
    case CODEX_OK:                        return "success";
    case CODEX_ERR_INVALID_ARG:           return "invalid argument";
    case CODEX_ERR_NOT_INITIALIZED:       return "not initialized";
    case CODEX_ERR_ALREADY_INITIALIZED:   return "already initialized";
    case CODEX_ERR_OOM:                   return "out of memory";
    case CODEX_ERR_AUTH_NO_CREDENTIALS:   return "no credentials";
    case CODEX_ERR_AUTH_STATE_MISMATCH:   return "OAuth state mismatch (CSRF)";
    case CODEX_ERR_AUTH_WORKSPACE_MISMATCH: return "workspace ID mismatch";
    case CODEX_ERR_AUTH_TOKEN_EXCHANGE:   return "token exchange failed";
    case CODEX_ERR_AUTH_DEVICE_TIMEOUT:   return "device code authorization timeout";
    case CODEX_ERR_AUTH_DEVICE_EXPIRED:   return "device code expired";
    case CODEX_ERR_AUTH_CORRUPT:          return "corrupt auth state";
    case CODEX_ERR_AUTH_ACCOUNT_MISMATCH: return "account ID mismatch on reload";
    case CODEX_ERR_REFRESH_EXPIRED:       return "refresh token expired";
    case CODEX_ERR_REFRESH_EXHAUSTED:     return "refresh token reused (exhausted)";
    case CODEX_ERR_REFRESH_REVOKED:       return "refresh token revoked";
    case CODEX_ERR_REFRESH_TRANSIENT:     return "transient refresh error";
    case CODEX_ERR_HTTP:                  return "HTTP error";
    case CODEX_ERR_CURL:                  return "libcurl error";
    case CODEX_ERR_SSL:                   return "SSL/TLS error";
    case CODEX_ERR_TIMEOUT:              return "request timeout";
    case CODEX_ERR_CONNECTION:           return "connection failed";
    case CODEX_ERR_UNAUTHORIZED:         return "401 Unauthorized";
    case CODEX_ERR_RATE_LIMIT:           return "rate limit exceeded";
    case CODEX_ERR_CONTEXT_LENGTH:       return "context length exceeded";
    case CODEX_ERR_QUOTA_EXCEEDED:       return "quota exceeded";
    case CODEX_ERR_USAGE_NOT_INCLUDED:   return "usage not included in plan";
    case CODEX_ERR_INVALID_REQUEST:      return "invalid request";
    case CODEX_ERR_SERVER_OVERLOADED:    return "server overloaded";
    case CODEX_ERR_SERVER_ERROR:         return "internal server error";
    case CODEX_ERR_STORAGE_READ:         return "storage read failed";
    case CODEX_ERR_STORAGE_WRITE:        return "storage write failed";
    case CODEX_ERR_KEYRING:              return "keyring error";
    case CODEX_ERR_STREAM_PARSE:         return "stream parse error";
    case CODEX_ERR_STREAM_INCOMPLETE:    return "stream incomplete";
    }
    return "unknown error";
}

/* --------------------------------------------------------------------------
 * Internal accessors (used by other .c files)
 * ----------------------------------------------------------------------- */

int codex_is_initialized(void)        { return g_codex.initialized; }
const char *codex_get_home(void)      { return g_codex.codex_home; }
const char *codex_get_issuer(void)    { return g_codex.issuer_url; }
const char *codex_get_client_id(void) { return g_codex.client_id; }
const char *codex_get_base_url(void)  { return g_codex.base_url; }
const char *codex_get_ca_cert(void)   { return g_codex.ca_cert_path; }
const char *codex_get_residency(void) { return g_codex.residency; }
const char *codex_get_forced_workspace(void) { return g_codex.forced_workspace_id; }
uint16_t    codex_get_callback_port(void)    { return g_codex.callback_port; }
uint32_t    codex_get_max_retries(void)      { return g_codex.max_retries; }
uint32_t    codex_get_stream_timeout(void)   { return g_codex.stream_idle_timeout_ms; }

const char *codex_get_refresh_url(void)
{
    if (g_codex.refresh_token_url)
        return g_codex.refresh_token_url;
    /* Default: {issuer}/oauth/token */
    static char buf[CODEX_MAX_URL_LEN];
    snprintf(buf, sizeof(buf), "%s/oauth/token", g_codex.issuer_url);
    return buf;
}
