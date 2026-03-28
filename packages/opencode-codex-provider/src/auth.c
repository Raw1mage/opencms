/*
 * auth.c — Authentication flows
 *
 * Implements:
 *   - Browser OAuth PKCE (codex_login_browser)
 *   - Device Code (codex_login_device)
 *   - API Key (codex_login_apikey)
 *   - Token Refresh (codex_refresh_token)
 *
 * Wire protocol reference: codex_a4_protocol_ref.json
 */

#include "codex_provider.h"

#include <cjson/cJSON.h>
#include <curl/curl.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef _WIN32
  #include <arpa/inet.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
#endif

/* --------------------------------------------------------------------------
 * External accessors
 * ----------------------------------------------------------------------- */

extern int          codex_is_initialized(void);
extern const char  *codex_get_issuer(void);
extern const char  *codex_get_client_id(void);
extern const char  *codex_get_ca_cert(void);
extern const char  *codex_get_forced_workspace(void);
extern const char  *codex_get_originator(void);
extern const char  *codex_get_refresh_url(void);
extern uint16_t     codex_get_callback_port(void);

extern int          codex_jwt_extract_claims(const char *id_token,
                                             codex_jwt_claims_t *out);
extern void         codex_jwt_claims_free(codex_jwt_claims_t *claims);

extern codex_auth_mode_t codex_auth_get_mode(void);
extern const char       *codex_auth_get_refresh_token(void);
extern const char       *codex_auth_get_account_id(void);
extern int               codex_auth_is_stale(void);
extern void              codex_auth_set_chatgpt(const char *id_token,
                                                const char *access_token,
                                                const char *refresh_token,
                                                const char *account_id,
                                                const char *email,
                                                codex_plan_type_t plan_type);
extern void              codex_auth_set_apikey(const char *key);
extern void              codex_auth_update_tokens(const char *id_token,
                                                  const char *access_token,
                                                  const char *refresh_token);
extern int               codex_storage_save(void);
extern int               codex_storage_load_auth(const char *expected_account_id);

/* --------------------------------------------------------------------------
 * Helper: libcurl write callback (accumulate to buffer)
 * ----------------------------------------------------------------------- */

typedef struct {
    char  *data;
    size_t len;
    size_t cap;
} curl_buf_t;

static size_t curl_write_cb(void *ptr, size_t size, size_t nmemb, void *userdata)
{
    curl_buf_t *buf = (curl_buf_t *)userdata;
    size_t total = size * nmemb;
    if (buf->len + total >= buf->cap) {
        size_t newcap = (buf->cap + total) * 2 + 256;
        char *newdata = realloc(buf->data, newcap);
        if (!newdata) return 0;
        buf->data = newdata;
        buf->cap = newcap;
    }
    memcpy(buf->data + buf->len, ptr, total);
    buf->len += total;
    buf->data[buf->len] = '\0';
    return total;
}

static void curl_buf_init(curl_buf_t *b)
{
    b->data = malloc(4096);
    b->len = 0;
    b->cap = b->data ? 4096 : 0;
    if (b->data) b->data[0] = '\0';
}

static void curl_buf_free(curl_buf_t *b)
{
    free(b->data);
    memset(b, 0, sizeof(*b));
}

/* --------------------------------------------------------------------------
 * Helper: base64url encode (no padding)
 * ----------------------------------------------------------------------- */

static char *base64url_encode(const unsigned char *data, size_t len)
{
    /* Standard base64 encode */
    size_t b64_len = 4 * ((len + 2) / 3) + 1;
    char *b64 = malloc(b64_len);
    if (!b64) return NULL;

    int out_len = EVP_EncodeBlock((unsigned char *)b64, data, (int)len);
    if (out_len < 0) { free(b64); return NULL; }

    /* Convert to base64url: '+' → '-', '/' → '_', strip '=' */
    for (int i = 0; i < out_len; i++) {
        if (b64[i] == '+') b64[i] = '-';
        else if (b64[i] == '/') b64[i] = '_';
    }
    /* Strip trailing '=' */
    while (out_len > 0 && b64[out_len - 1] == '=') out_len--;
    b64[out_len] = '\0';

    return b64;
}

/* --------------------------------------------------------------------------
 * Helper: generate PKCE pair
 * ----------------------------------------------------------------------- */

typedef struct {
    char *code_verifier;   /* 64 random bytes → base64url */
    char *code_challenge;  /* SHA256(verifier) → base64url */
} pkce_t;

static int generate_pkce(pkce_t *pkce)
{
    unsigned char random_bytes[64];
    if (RAND_bytes(random_bytes, sizeof(random_bytes)) != 1)
        return CODEX_ERR_SSL;

    pkce->code_verifier = base64url_encode(random_bytes, sizeof(random_bytes));
    if (!pkce->code_verifier) return CODEX_ERR_OOM;

    /* SHA256 of verifier string */
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256((unsigned char *)pkce->code_verifier,
           strlen(pkce->code_verifier), hash);

    pkce->code_challenge = base64url_encode(hash, SHA256_DIGEST_LENGTH);
    if (!pkce->code_challenge) {
        free(pkce->code_verifier);
        return CODEX_ERR_OOM;
    }

    return CODEX_OK;
}

static void pkce_free(pkce_t *pkce)
{
    free(pkce->code_verifier);
    free(pkce->code_challenge);
    memset(pkce, 0, sizeof(*pkce));
}

/* --------------------------------------------------------------------------
 * Helper: generate random state token
 * ----------------------------------------------------------------------- */

static char *generate_state(void)
{
    unsigned char random_bytes[32];
    if (RAND_bytes(random_bytes, sizeof(random_bytes)) != 1)
        return NULL;
    return base64url_encode(random_bytes, sizeof(random_bytes));
}

/* --------------------------------------------------------------------------
 * Helper: curl POST with form body
 * ----------------------------------------------------------------------- */

static int curl_post_form(const char *url, const char *body,
                          const char *ca_cert, curl_buf_t *response)
{
    CURL *curl = curl_easy_init();
    if (!curl) return CODEX_ERR_CURL;

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers,
        "Content-Type: application/x-www-form-urlencoded");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    if (ca_cert)
        curl_easy_setopt(curl, CURLOPT_CAINFO, ca_cert);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) return CODEX_ERR_CURL;
    if (http_code == 401) return CODEX_ERR_UNAUTHORIZED;
    if (http_code >= 400) return CODEX_ERR_HTTP;

    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * Helper: curl POST with JSON body
 * ----------------------------------------------------------------------- */

static int curl_post_json(const char *url, const char *json_body,
                          const char *ca_cert, curl_buf_t *response)
{
    CURL *curl = curl_easy_init();
    if (!curl) return CODEX_ERR_CURL;

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_body);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    if (ca_cert)
        curl_easy_setopt(curl, CURLOPT_CAINFO, ca_cert);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) return CODEX_ERR_CURL;
    if (http_code == 401) return CODEX_ERR_UNAUTHORIZED;
    if (http_code == 403) return CODEX_ERR_AUTH_DEVICE_TIMEOUT; /* reused for poll pending */
    if (http_code == 404) return CODEX_ERR_AUTH_DEVICE_EXPIRED;
    if (http_code >= 400) return CODEX_ERR_HTTP;

    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * Helper: persist tokens after successful login
 * ----------------------------------------------------------------------- */

static int persist_login(const char *id_token, const char *access_token,
                         const char *refresh_token)
{
    codex_jwt_claims_t claims;
    int rc = codex_jwt_extract_claims(id_token, &claims);
    if (rc != CODEX_OK) return rc;

    /* Workspace enforcement */
    const char *forced = codex_get_forced_workspace();
    if (forced && forced[0]) {
        if (!claims.account_id || strcmp(claims.account_id, forced) != 0) {
            codex_jwt_claims_free(&claims);
            return CODEX_ERR_AUTH_WORKSPACE_MISMATCH;
        }
    }

    codex_auth_set_chatgpt(id_token, access_token, refresh_token,
                           claims.account_id, claims.email, claims.plan_type);
    codex_jwt_claims_free(&claims);

    return codex_storage_save();
}

/* --------------------------------------------------------------------------
 * Helper: exchange authorization code for tokens
 * ----------------------------------------------------------------------- */

static int exchange_code(const char *code, const char *redirect_uri,
                         const char *code_verifier, codex_auth_cb cb, void *ctx)
{
    const char *issuer = codex_get_issuer();
    const char *client_id = codex_get_client_id();

    /* Build token URL */
    char url[CODEX_MAX_URL_LEN];
    snprintf(url, sizeof(url), "%s/oauth/token", issuer);

    /* Build POST body */
    char *esc_code = curl_easy_escape(NULL, code, 0);
    char *esc_uri  = curl_easy_escape(NULL, redirect_uri, 0);
    char *esc_ver  = curl_easy_escape(NULL, code_verifier, 0);

    char body[8192];
    snprintf(body, sizeof(body),
             "grant_type=authorization_code"
             "&code=%s"
             "&redirect_uri=%s"
             "&client_id=%s"
             "&code_verifier=%s",
             esc_code, esc_uri, client_id, esc_ver);

    curl_free(esc_code);
    curl_free(esc_uri);
    curl_free(esc_ver);

    curl_buf_t resp;
    curl_buf_init(&resp);
    int rc = curl_post_form(url, body, codex_get_ca_cert(), &resp);

    if (rc != CODEX_OK) {
        curl_buf_free(&resp);
        if (cb) {
            codex_auth_result_t result = {.error = CODEX_ERR_AUTH_TOKEN_EXCHANGE,
                                          .error_message = "Token exchange failed"};
            cb(ctx, &result);
        }
        return rc;
    }

    /* Parse response */
    cJSON *json = cJSON_Parse(resp.data);
    curl_buf_free(&resp);
    if (!json) return CODEX_ERR_AUTH_TOKEN_EXCHANGE;

    const cJSON *id_tok  = cJSON_GetObjectItemCaseSensitive(json, "id_token");
    const cJSON *acc_tok = cJSON_GetObjectItemCaseSensitive(json, "access_token");
    const cJSON *ref_tok = cJSON_GetObjectItemCaseSensitive(json, "refresh_token");

    if (!cJSON_IsString(acc_tok)) {
        cJSON_Delete(json);
        return CODEX_ERR_AUTH_TOKEN_EXCHANGE;
    }

    rc = persist_login(
        cJSON_IsString(id_tok) ? id_tok->valuestring : NULL,
        acc_tok->valuestring,
        cJSON_IsString(ref_tok) ? ref_tok->valuestring : NULL);

    if (rc == CODEX_OK && cb) {
        codex_auth_status_t status;
        codex_get_auth_status(&status);
        codex_auth_result_t result = {
            .error      = CODEX_OK,
            .mode       = status.mode,
            .email      = status.email,
            .account_id = status.account_id,
            .plan_type  = status.plan_type,
        };
        cb(ctx, &result);
    } else if (rc != CODEX_OK && cb) {
        codex_auth_result_t result = {.error = rc,
                                      .error_message = codex_strerror(rc)};
        cb(ctx, &result);
    }

    cJSON_Delete(json);
    return rc;
}

/* ==========================================================================
 * codex_login_browser — Browser OAuth PKCE flow
 * ======================================================================== */

CODEX_EXPORT int codex_login_browser(codex_auth_cb cb, void *ctx)
{
    if (!codex_is_initialized()) return CODEX_ERR_NOT_INITIALIZED;

    const char *issuer    = codex_get_issuer();
    const char *client_id = codex_get_client_id();
    uint16_t    port      = codex_get_callback_port();

    /* Generate PKCE and state */
    pkce_t pkce;
    int rc = generate_pkce(&pkce);
    if (rc != CODEX_OK) return rc;

    char *state = generate_state();
    if (!state) { pkce_free(&pkce); return CODEX_ERR_OOM; }

    /* Build redirect URI */
    char redirect_uri[256];
    snprintf(redirect_uri, sizeof(redirect_uri),
             "http://localhost:%u/auth/callback", port);

    /* Start callback server */
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        pkce_free(&pkce);
        free(state);
        return CODEX_ERR_CONNECTION;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
        .sin_port = htons(port),
    };

    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 ||
        listen(server_fd, 1) < 0) {
        close(server_fd);
        pkce_free(&pkce);
        free(state);
        return CODEX_ERR_CONNECTION;
    }

    /* Build authorize URL */
    char *esc_redirect = curl_easy_escape(NULL, redirect_uri, 0);
    char *esc_state    = curl_easy_escape(NULL, state, 0);
    char *esc_challenge= curl_easy_escape(NULL, pkce.code_challenge, 0);

    char auth_url[CODEX_MAX_URL_LEN];
    const char *forced_ws = codex_get_forced_workspace();
    int n = snprintf(auth_url, sizeof(auth_url),
        "%s/oauth/authorize?"
        "response_type=code"
        "&client_id=%s"
        "&redirect_uri=%s"
        "&scope=openid%%20profile%%20email%%20offline_access%%20api.connectors.read%%20api.connectors.invoke"
        "&code_challenge=%s"
        "&code_challenge_method=S256"
        "&id_token_add_organizations=true"
        "&codex_cli_simplified_flow=true"
        "&state=%s"
        "&originator=%s",
        issuer, client_id, esc_redirect, esc_challenge, esc_state,
        codex_get_originator() ? codex_get_originator() : "codex_cli_rs");

    if (forced_ws && forced_ws[0]) {
        char *esc_ws = curl_easy_escape(NULL, forced_ws, 0);
        snprintf(auth_url + n, sizeof(auth_url) - (size_t)n,
                 "&allowed_workspace_id=%s", esc_ws);
        curl_free(esc_ws);
    }

    curl_free(esc_redirect);
    curl_free(esc_state);
    curl_free(esc_challenge);

    /* Open browser */
#ifdef __APPLE__
    char cmd[CODEX_MAX_URL_LEN + 16];
    snprintf(cmd, sizeof(cmd), "open '%s'", auth_url);
    system(cmd);
#elif !defined(_WIN32)
    char cmd[CODEX_MAX_URL_LEN + 32];
    snprintf(cmd, sizeof(cmd), "xdg-open '%s' >/dev/null 2>&1 &", auth_url);
    system(cmd);
#endif

    /* Accept callback connection */
    struct sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);
    int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
    close(server_fd);

    if (client_fd < 0) {
        pkce_free(&pkce);
        free(state);
        return CODEX_ERR_CONNECTION;
    }

    /* Read HTTP request */
    char req_buf[8192];
    ssize_t nread = read(client_fd, req_buf, sizeof(req_buf) - 1);
    if (nread <= 0) {
        close(client_fd);
        pkce_free(&pkce);
        free(state);
        return CODEX_ERR_CONNECTION;
    }
    req_buf[nread] = '\0';

    /* Send success response immediately */
    const char *http_resp =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html\r\n"
        "Connection: close\r\n\r\n"
        "<html><body><h1>Authentication successful</h1>"
        "<p>You may close this tab.</p></body></html>\r\n";
    write(client_fd, http_resp, strlen(http_resp));
    close(client_fd);

    /* Parse query string from GET /auth/callback?code=...&state=... */
    char *query = strstr(req_buf, "/auth/callback?");
    if (!query) {
        pkce_free(&pkce);
        free(state);
        return CODEX_ERR_AUTH_STATE_MISMATCH;
    }
    query += strlen("/auth/callback?");
    char *query_end = strchr(query, ' ');
    if (query_end) *query_end = '\0';

    /* Extract code and state from query */
    char *recv_code = NULL;
    char *recv_state = NULL;

    char *saveptr = NULL;
    char *token = strtok_r(query, "&", &saveptr);
    while (token) {
        if (strncmp(token, "code=", 5) == 0)
            recv_code = token + 5;
        else if (strncmp(token, "state=", 6) == 0)
            recv_state = token + 6;
        token = strtok_r(NULL, "&", &saveptr);
    }

    /* Validate state (CSRF) */
    if (!recv_state || !recv_code || strcmp(recv_state, state) != 0) {
        pkce_free(&pkce);
        free(state);
        if (cb) {
            codex_auth_result_t result = {.error = CODEX_ERR_AUTH_STATE_MISMATCH,
                                          .error_message = "State mismatch"};
            cb(ctx, &result);
        }
        return CODEX_ERR_AUTH_STATE_MISMATCH;
    }

    /* URL-decode the code (in case of percent-encoding) */
    int code_out_len = 0;
    char *decoded_code = curl_easy_unescape(NULL, recv_code, 0, &code_out_len);

    rc = exchange_code(decoded_code, redirect_uri, pkce.code_verifier, cb, ctx);

    curl_free(decoded_code);
    pkce_free(&pkce);
    free(state);
    return rc;
}

/* ==========================================================================
 * codex_login_device — Device code flow
 * ======================================================================== */

CODEX_EXPORT int codex_login_device(codex_device_code_cb device_cb,
                                    codex_auth_cb auth_cb, void *ctx)
{
    if (!codex_is_initialized()) return CODEX_ERR_NOT_INITIALIZED;

    const char *issuer    = codex_get_issuer();
    const char *client_id = codex_get_client_id();

    /* Step 1: Request device code */
    char url[CODEX_MAX_URL_LEN];
    snprintf(url, sizeof(url), "%s/api/accounts/deviceauth/usercode", issuer);

    char body[256];
    snprintf(body, sizeof(body), "{\"client_id\":\"%s\"}", client_id);

    curl_buf_t resp;
    curl_buf_init(&resp);
    int rc = curl_post_json(url, body, codex_get_ca_cert(), &resp);
    if (rc != CODEX_OK) {
        curl_buf_free(&resp);
        return rc;
    }

    cJSON *json = cJSON_Parse(resp.data);
    curl_buf_free(&resp);
    if (!json) return CODEX_ERR_HTTP;

    const cJSON *device_id_item = cJSON_GetObjectItemCaseSensitive(json, "device_auth_id");
    const cJSON *user_code_item = cJSON_GetObjectItemCaseSensitive(json, "user_code");
    const cJSON *interval_item  = cJSON_GetObjectItemCaseSensitive(json, "interval");

    if (!cJSON_IsString(device_id_item) || !cJSON_IsString(user_code_item)) {
        cJSON_Delete(json);
        return CODEX_ERR_HTTP;
    }

    char *device_auth_id = strdup(device_id_item->valuestring);
    char *user_code      = strdup(user_code_item->valuestring);
    int   interval       = cJSON_IsNumber(interval_item)
                           ? interval_item->valueint : 5;

    cJSON_Delete(json);

    /* Step 2: Notify caller with device code */
    if (device_cb) {
        char verification_url[CODEX_MAX_URL_LEN];
        snprintf(verification_url, sizeof(verification_url),
                 "%s/codex/device", issuer);
        codex_device_code_t code_info = {
            .verification_url = verification_url,
            .user_code        = user_code,
            .expires_in_sec   = 900,
        };
        device_cb(ctx, &code_info);
    }

    /* Step 3: Poll for authorization (max 15 minutes) */
    snprintf(url, sizeof(url), "%s/api/accounts/deviceauth/token", issuer);

    char poll_body[512];
    snprintf(poll_body, sizeof(poll_body),
             "{\"device_auth_id\":\"%s\",\"user_code\":\"%s\"}",
             device_auth_id, user_code);

    time_t deadline = time(NULL) + 900; /* 15 minutes */
    rc = CODEX_ERR_AUTH_DEVICE_TIMEOUT;

    while (time(NULL) < deadline) {
        curl_buf_t poll_resp;
        curl_buf_init(&poll_resp);
        int poll_rc = curl_post_json(url, poll_body, codex_get_ca_cert(), &poll_resp);

        if (poll_rc == CODEX_OK) {
            /* 200 — authorized! */
            cJSON *poll_json = cJSON_Parse(poll_resp.data);
            curl_buf_free(&poll_resp);

            if (poll_json) {
                const cJSON *auth_code = cJSON_GetObjectItemCaseSensitive(
                    poll_json, "authorization_code");
                const cJSON *cv = cJSON_GetObjectItemCaseSensitive(
                    poll_json, "code_verifier");

                if (cJSON_IsString(auth_code) && cJSON_IsString(cv)) {
                    char device_redirect[CODEX_MAX_URL_LEN];
                    snprintf(device_redirect, sizeof(device_redirect),
                             "%s/deviceauth/callback", issuer);
                    rc = exchange_code(auth_code->valuestring,
                                       device_redirect,
                                       cv->valuestring,
                                       auth_cb, ctx);
                }
                cJSON_Delete(poll_json);
            }
            break;
        } else if (poll_rc == CODEX_ERR_AUTH_DEVICE_TIMEOUT) {
            /* 403 — not yet authorized, keep polling */
            curl_buf_free(&poll_resp);
#ifdef _WIN32
            Sleep(interval * 1000);
#else
            sleep((unsigned)interval);
#endif
            continue;
        } else if (poll_rc == CODEX_ERR_AUTH_DEVICE_EXPIRED) {
            /* 404 — expired */
            curl_buf_free(&poll_resp);
            rc = CODEX_ERR_AUTH_DEVICE_EXPIRED;
            break;
        } else {
            curl_buf_free(&poll_resp);
            rc = poll_rc;
            break;
        }
    }

    free(device_auth_id);
    free(user_code);

    if (rc != CODEX_OK && auth_cb) {
        codex_auth_result_t result = {.error = rc,
                                      .error_message = codex_strerror(rc)};
        auth_cb(ctx, &result);
    }

    return rc;
}

/* ==========================================================================
 * codex_login_apikey
 * ======================================================================== */

CODEX_EXPORT int codex_login_apikey(const char *api_key)
{
    if (!codex_is_initialized()) return CODEX_ERR_NOT_INITIALIZED;
    if (!api_key || !api_key[0]) return CODEX_ERR_INVALID_ARG;

    codex_auth_set_apikey(api_key);
    return codex_storage_save();
}

/* ==========================================================================
 * codex_refresh_token — check staleness and refresh if needed
 * ======================================================================== */

CODEX_EXPORT int codex_refresh_token(void)
{
    if (!codex_is_initialized()) return CODEX_ERR_NOT_INITIALIZED;
    if (codex_auth_get_mode() != CODEX_AUTH_CHATGPT) return CODEX_OK;
    if (!codex_auth_is_stale()) return CODEX_OK;

    /* Try reloading from disk first (another process may have refreshed) */
    const char *expected_id = codex_auth_get_account_id();
    int rc = codex_storage_load_auth(expected_id);
    if (rc == CODEX_OK && !codex_auth_is_stale())
        return CODEX_OK; /* Someone else refreshed */

    /* Need to refresh ourselves */
    const char *refresh_tok = codex_auth_get_refresh_token();
    if (!refresh_tok) return CODEX_ERR_AUTH_NO_CREDENTIALS;

    const char *refresh_url = codex_get_refresh_url();
    const char *client_id   = codex_get_client_id();

    char *esc_tok = curl_easy_escape(NULL, refresh_tok, 0);
    char body[4096];
    snprintf(body, sizeof(body),
             "grant_type=refresh_token&refresh_token=%s&client_id=%s",
             esc_tok, client_id);
    curl_free(esc_tok);

    curl_buf_t resp;
    curl_buf_init(&resp);
    rc = curl_post_form(refresh_url, body, codex_get_ca_cert(), &resp);

    if (rc == CODEX_ERR_UNAUTHORIZED) {
        /* Classify 401 error */
        cJSON *err_json = cJSON_Parse(resp.data);
        curl_buf_free(&resp);
        if (err_json) {
            const cJSON *code = cJSON_GetObjectItemCaseSensitive(err_json, "error");
            if (cJSON_IsString(code)) {
                if (strcmp(code->valuestring, "refresh_token_expired") == 0)
                    rc = CODEX_ERR_REFRESH_EXPIRED;
                else if (strcmp(code->valuestring, "refresh_token_reused") == 0)
                    rc = CODEX_ERR_REFRESH_EXHAUSTED;
                else if (strcmp(code->valuestring, "refresh_token_invalidated") == 0)
                    rc = CODEX_ERR_REFRESH_REVOKED;
            }
            cJSON_Delete(err_json);
        }
        return rc;
    }

    if (rc != CODEX_OK) {
        curl_buf_free(&resp);
        return CODEX_ERR_REFRESH_TRANSIENT;
    }

    /* Merge new tokens */
    cJSON *json = cJSON_Parse(resp.data);
    curl_buf_free(&resp);
    if (!json) return CODEX_ERR_REFRESH_TRANSIENT;

    const cJSON *new_id  = cJSON_GetObjectItemCaseSensitive(json, "id_token");
    const cJSON *new_acc = cJSON_GetObjectItemCaseSensitive(json, "access_token");
    const cJSON *new_ref = cJSON_GetObjectItemCaseSensitive(json, "refresh_token");

    codex_auth_update_tokens(
        cJSON_IsString(new_id)  ? new_id->valuestring  : NULL,
        cJSON_IsString(new_acc) ? new_acc->valuestring  : NULL,
        cJSON_IsString(new_ref) ? new_ref->valuestring  : NULL);

    cJSON_Delete(json);
    return codex_storage_save();
}
