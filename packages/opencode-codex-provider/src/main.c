/*
 * main.c — CLI wrapper for codex-provider
 *
 * Protocol:
 *   stdin:  single JSON request object (one read, then EOF)
 *   stdout: JSONL events, one per line, flushed immediately
 *   stderr: diagnostic logging
 *   exit 0: success (completed or all events delivered)
 *   exit 1: fatal error
 *
 * Request JSON schema (from Bun host):
 * {
 *   "model": "gpt-5.2-codex",
 *   "input": [ ... ResponseItem array ... ],
 *   "instructions": "system prompt",
 *   "tools": [ ... ],
 *   "tool_choice": "auto",
 *   "stream": true,
 *   "access_token": "eyJ...",
 *   "account_id": "acct_xxx",
 *   "conversation_id": "uuid",
 *   "turn_state": "opaque" | null,
 *   "beta_features": "feat1,feat2" | null,
 *   "service_tier": "priority" | null,
 *   "prompt_cache_key": "uuid" | null,
 *   "reasoning_effort": "medium" | null,
 *   "reasoning_summary": "auto" | null
 * }
 *
 * The host is responsible for auth — it passes access_token and account_id.
 * This process handles: body transform, headers, HTTP transport, SSE parsing.
 *
 * Output JSONL event schema:
 * {"type":"created","response_id":"resp_xxx"}
 * {"type":"text_delta","delta":"Hello"}
 * {"type":"reasoning_delta","delta":"...","index":0}
 * {"type":"item_done","item_type":"function_call","item":{...}}
 * {"type":"item_added","item_type":"message","item":{...}}
 * {"type":"completed","response_id":"resp_xxx","usage":{"input":100,"cached":50,"output":200,"reasoning":0,"total":300}}
 * {"type":"failed","error_code":-42,"error_message":"context length exceeded"}
 */

#include "codex_provider.h"
#include <cjson/cJSON.h>
#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --------------------------------------------------------------------------
 * Forward declarations from library modules
 * ----------------------------------------------------------------------- */

extern int  codex_transform_request(cJSON *request);
extern int  codex_resolve_endpoint_url(char *url_buf, size_t buf_len);
extern int  codex_originator_init(const char *version);
extern void codex_originator_cleanup(void);
extern const char *codex_get_originator(void);

/* SSE parser */
typedef struct sse_parser_t sse_parser_t;
extern sse_parser_t *codex_sse_parser_create(codex_event_cb cb, void *ctx);
extern void          codex_sse_parser_destroy(sse_parser_t *p);
extern void          codex_sse_parser_feed(sse_parser_t *p, const char *data, size_t len);
extern void          codex_sse_parser_flush(sse_parser_t *p);

/* --------------------------------------------------------------------------
 * Stubs for symbols referenced by transform.c but not used by CLI
 * (CLI has its own resolve_url; these are only used when linking as library)
 * ----------------------------------------------------------------------- */

codex_auth_mode_t codex_auth_get_mode(void) { return CODEX_AUTH_CHATGPT; }
const char *codex_get_base_url(void) {
    const char *env = getenv("CODEX_BASE_URL");
    return (env && env[0]) ? env : NULL;
}

/* --------------------------------------------------------------------------
 * Read entire stdin into buffer
 * ----------------------------------------------------------------------- */

static char *read_stdin(size_t *out_len)
{
    size_t cap = 65536;
    size_t len = 0;
    char *buf = malloc(cap);
    if (!buf) return NULL;

    while (!feof(stdin)) {
        size_t n = fread(buf + len, 1, cap - len, stdin);
        len += n;
        if (len >= cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
    }
    buf[len] = '\0';
    if (out_len) *out_len = len;
    return buf;
}

/* --------------------------------------------------------------------------
 * Write JSONL event to stdout
 * ----------------------------------------------------------------------- */

static void write_event(const char *json_line)
{
    fputs(json_line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/* --------------------------------------------------------------------------
 * SSE event callback → JSONL on stdout
 * ----------------------------------------------------------------------- */

static void event_to_jsonl(void *ctx, const codex_event_t *ev)
{
    (void)ctx;

    cJSON *obj = cJSON_CreateObject();
    if (!obj) return;

    switch (ev->type) {
    case CODEX_EVENT_CREATED:
        cJSON_AddStringToObject(obj, "type", "created");
        if (ev->response_id)
            cJSON_AddStringToObject(obj, "response_id", ev->response_id);
        break;

    case CODEX_EVENT_TEXT_DELTA:
        cJSON_AddStringToObject(obj, "type", "text_delta");
        if (ev->delta)
            cJSON_AddStringToObject(obj, "delta", ev->delta);
        break;

    case CODEX_EVENT_REASONING_SUMMARY_DELTA:
        cJSON_AddStringToObject(obj, "type", "reasoning_summary_delta");
        if (ev->delta)
            cJSON_AddStringToObject(obj, "delta", ev->delta);
        cJSON_AddNumberToObject(obj, "index", (double)ev->summary_index);
        break;

    case CODEX_EVENT_REASONING_DELTA:
        cJSON_AddStringToObject(obj, "type", "reasoning_delta");
        if (ev->delta)
            cJSON_AddStringToObject(obj, "delta", ev->delta);
        cJSON_AddNumberToObject(obj, "index", (double)ev->content_index);
        break;

    case CODEX_EVENT_REASONING_PART_ADDED:
        cJSON_AddStringToObject(obj, "type", "reasoning_part_added");
        cJSON_AddNumberToObject(obj, "index", (double)ev->summary_index);
        break;

    case CODEX_EVENT_ITEM_DONE:
        cJSON_AddStringToObject(obj, "type", "item_done");
        cJSON_AddNumberToObject(obj, "item_type", (double)ev->item_type);
        if (ev->item_json) {
            cJSON *item = cJSON_Parse(ev->item_json);
            if (item)
                cJSON_AddItemToObject(obj, "item", item);
            else
                cJSON_AddStringToObject(obj, "item_raw", ev->item_json);
        }
        break;

    case CODEX_EVENT_ITEM_ADDED:
        cJSON_AddStringToObject(obj, "type", "item_added");
        cJSON_AddNumberToObject(obj, "item_type", (double)ev->item_type);
        if (ev->item_json) {
            cJSON *item = cJSON_Parse(ev->item_json);
            if (item)
                cJSON_AddItemToObject(obj, "item", item);
            else
                cJSON_AddStringToObject(obj, "item_raw", ev->item_json);
        }
        break;

    case CODEX_EVENT_COMPLETED:
        cJSON_AddStringToObject(obj, "type", "completed");
        if (ev->response_id)
            cJSON_AddStringToObject(obj, "response_id", ev->response_id);
        {
            cJSON *usage = cJSON_CreateObject();
            cJSON_AddNumberToObject(usage, "input", (double)ev->usage.input_tokens);
            cJSON_AddNumberToObject(usage, "cached", (double)ev->usage.cached_input_tokens);
            cJSON_AddNumberToObject(usage, "output", (double)ev->usage.output_tokens);
            cJSON_AddNumberToObject(usage, "reasoning", (double)ev->usage.reasoning_output_tokens);
            cJSON_AddNumberToObject(usage, "total", (double)ev->usage.total_tokens);
            cJSON_AddItemToObject(obj, "usage", usage);
        }
        break;

    case CODEX_EVENT_FAILED:
        cJSON_AddStringToObject(obj, "type", "failed");
        cJSON_AddNumberToObject(obj, "error_code", (double)ev->error_code);
        if (ev->error_message)
            cJSON_AddStringToObject(obj, "error_message", ev->error_message);
        if (ev->error_type)
            cJSON_AddStringToObject(obj, "error_type", ev->error_type);
        if (ev->resets_at)
            cJSON_AddNumberToObject(obj, "resets_at", (double)ev->resets_at);
        break;

    case CODEX_EVENT_INCOMPLETE:
        cJSON_AddStringToObject(obj, "type", "incomplete");
        break;

    case CODEX_EVENT_RATE_LIMITS:
        cJSON_AddStringToObject(obj, "type", "rate_limits");
        break;
    }

    char *line = cJSON_PrintUnformatted(obj);
    cJSON_Delete(obj);
    if (line) {
        write_event(line);
        free(line);
    }
}

/* --------------------------------------------------------------------------
 * libcurl write callback → SSE parser
 * ----------------------------------------------------------------------- */

typedef struct {
    sse_parser_t *parser;
} stream_ctx_t;

static size_t curl_stream_cb(void *ptr, size_t size, size_t nmemb, void *userdata)
{
    stream_ctx_t *ctx = (stream_ctx_t *)userdata;
    size_t total = size * nmemb;
    codex_sse_parser_feed(ctx->parser, (const char *)ptr, total);
    return total;
}

/* --------------------------------------------------------------------------
 * Build curl header list from request JSON fields
 * ----------------------------------------------------------------------- */

static struct curl_slist *build_headers(const cJSON *request)
{
    struct curl_slist *headers = NULL;
    char buf[CODEX_MAX_HEADER_LEN];

    /* Authorization */
    const cJSON *token = cJSON_GetObjectItemCaseSensitive(request, "access_token");
    if (cJSON_IsString(token)) {
        snprintf(buf, sizeof(buf), "Authorization: Bearer %s", token->valuestring);
        headers = curl_slist_append(headers, buf);
    }

    /* Content-Type */
    headers = curl_slist_append(headers, "Content-Type: application/json");

    /* originator + User-Agent */
    const char *orig = codex_get_originator();
    if (orig) {
        snprintf(buf, sizeof(buf), "originator: %s", orig);
        headers = curl_slist_append(headers, buf);
        snprintf(buf, sizeof(buf), "User-Agent: %s", orig);
        headers = curl_slist_append(headers, buf);
    }

    /* chatgpt-account-id */
    const cJSON *acct = cJSON_GetObjectItemCaseSensitive(request, "account_id");
    if (cJSON_IsString(acct) && acct->valuestring[0]) {
        snprintf(buf, sizeof(buf), "chatgpt-account-id: %s", acct->valuestring);
        headers = curl_slist_append(headers, buf);
    }

    /* x-codex-turn-state */
    const cJSON *ts = cJSON_GetObjectItemCaseSensitive(request, "turn_state");
    if (cJSON_IsString(ts) && ts->valuestring[0]) {
        snprintf(buf, sizeof(buf), "x-codex-turn-state: %s", ts->valuestring);
        headers = curl_slist_append(headers, buf);
    }

    /* x-codex-beta-features */
    const cJSON *bf = cJSON_GetObjectItemCaseSensitive(request, "beta_features");
    if (cJSON_IsString(bf) && bf->valuestring[0]) {
        snprintf(buf, sizeof(buf), "x-codex-beta-features: %s", bf->valuestring);
        headers = curl_slist_append(headers, buf);
    }

    /* x-client-request-id */
    const cJSON *cid = cJSON_GetObjectItemCaseSensitive(request, "conversation_id");
    if (cJSON_IsString(cid) && cid->valuestring[0]) {
        snprintf(buf, sizeof(buf), "x-client-request-id: %s", cid->valuestring);
        headers = curl_slist_append(headers, buf);
    }

    /* x-openai-internal-codex-residency */
    const char *res = getenv("CODEX_RESIDENCY");
    if (res && res[0]) {
        snprintf(buf, sizeof(buf), "x-openai-internal-codex-residency: %s", res);
        headers = curl_slist_append(headers, buf);
    }

    return headers;
}

/* --------------------------------------------------------------------------
 * Resolve endpoint URL based on auth mode
 *
 * If access_token is present → ChatGPT subscription → chatgpt.com endpoint
 * If only api_key → OpenAI API → api.openai.com endpoint
 * Env override: CODEX_BASE_URL
 * ----------------------------------------------------------------------- */

static void resolve_url(const cJSON *request, char *url_buf, size_t buf_len)
{
    const char *base = getenv("CODEX_BASE_URL");

    if (base && base[0]) {
        size_t len = strlen(base);
        while (len > 0 && base[len - 1] == '/') len--;
        if ((strncmp(base, "https://chatgpt.com", 19) == 0 ||
             strncmp(base, "https://chat.openai.com", 23) == 0) &&
            !strstr(base, "/backend-api")) {
            snprintf(url_buf, buf_len, "%.*s/backend-api/codex/responses",
                     (int)len, base);
        } else {
            snprintf(url_buf, buf_len, "%.*s/responses", (int)len, base);
        }
        return;
    }

    /* Default: if access_token present → ChatGPT mode */
    const cJSON *token = cJSON_GetObjectItemCaseSensitive(request, "access_token");
    if (cJSON_IsString(token) && token->valuestring[0]) {
        snprintf(url_buf, buf_len,
                 "https://chatgpt.com/backend-api/codex/responses");
    } else {
        snprintf(url_buf, buf_len,
                 "https://api.openai.com/v1/responses");
    }
}

/* --------------------------------------------------------------------------
 * Strip host-only fields from request before sending to API
 * These fields are consumed by this process, not by the API endpoint
 * ----------------------------------------------------------------------- */

static void strip_host_fields(cJSON *request)
{
    cJSON_DeleteItemFromObjectCaseSensitive(request, "access_token");
    cJSON_DeleteItemFromObjectCaseSensitive(request, "account_id");
    cJSON_DeleteItemFromObjectCaseSensitive(request, "conversation_id");
    cJSON_DeleteItemFromObjectCaseSensitive(request, "turn_state");
    cJSON_DeleteItemFromObjectCaseSensitive(request, "beta_features");
}

/* --------------------------------------------------------------------------
 * main
 * ----------------------------------------------------------------------- */

int main(void)
{
    /* Initialize originator string */
    const char *version = getenv("CODEX_PROVIDER_VERSION");
    codex_originator_init(version ? version : CODEX_PROVIDER_VERSION);

    /* Read request from stdin */
    size_t input_len = 0;
    char *input = read_stdin(&input_len);
    if (!input || input_len == 0) {
        fprintf(stderr, "codex-provider: empty stdin\n");
        return 1;
    }

    /* Parse request JSON */
    cJSON *request = cJSON_ParseWithLength(input, input_len);
    free(input);
    if (!request) {
        fprintf(stderr, "codex-provider: invalid JSON on stdin\n");
        return 1;
    }

    /* Build headers BEFORE stripping host fields */
    struct curl_slist *headers = build_headers(request);

    /* Resolve endpoint URL */
    char url[CODEX_MAX_URL_LEN];
    resolve_url(request, url, sizeof(url));

    /* Strip host-only fields */
    strip_host_fields(request);

    /* Apply codex wire format transformations:
     *   - system/developer messages → instructions
     *   - strip max_output_tokens, max_tokens
     *   - strip item id fields */
    codex_transform_request(request);

    /* Ensure stream=true */
    cJSON_DeleteItemFromObjectCaseSensitive(request, "stream");
    cJSON_AddBoolToObject(request, "stream", 1);

    /* Serialize final body */
    char *body = cJSON_PrintUnformatted(request);
    cJSON_Delete(request);
    if (!body) {
        fprintf(stderr, "codex-provider: OOM serializing body\n");
        curl_slist_free_all(headers);
        return 1;
    }

    /* Create SSE parser with stdout callback */
    sse_parser_t *parser = codex_sse_parser_create(event_to_jsonl, NULL);
    if (!parser) {
        fprintf(stderr, "codex-provider: OOM creating parser\n");
        free(body);
        curl_slist_free_all(headers);
        return 1;
    }

    stream_ctx_t sctx = { .parser = parser };

    /* Set up libcurl */
    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL *curl = curl_easy_init();
    if (!curl) {
        fprintf(stderr, "codex-provider: curl_easy_init failed\n");
        codex_sse_parser_destroy(parser);
        free(body);
        curl_slist_free_all(headers);
        return 1;
    }

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_stream_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sctx);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 300L); /* 5 min idle */

    /* Custom CA cert */
    const char *ca = getenv("CODEX_CA_CERTIFICATE");
    if (!ca) ca = getenv("SSL_CERT_FILE");
    if (ca) curl_easy_setopt(curl, CURLOPT_CAINFO, ca);

    /* Disable curl signal handling for clean process termination */
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    /* Execute — this blocks, SSE events flow through callback → stdout */
    CURLcode crc = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    /* Flush any pending SSE event */
    codex_sse_parser_flush(parser);

    /* Report transport-level errors as JSONL events */
    if (crc != CURLE_OK) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "type", "failed");
        cJSON_AddNumberToObject(err, "error_code", (double)CODEX_ERR_CURL);
        cJSON_AddStringToObject(err, "error_message", curl_easy_strerror(crc));
        char *line = cJSON_PrintUnformatted(err);
        cJSON_Delete(err);
        if (line) { write_event(line); free(line); }
    } else if (http_code != 200 && http_code != 0) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "type", "failed");
        cJSON_AddNumberToObject(err, "error_code",
            http_code == 401 ? (double)CODEX_ERR_UNAUTHORIZED :
            http_code == 429 ? (double)CODEX_ERR_RATE_LIMIT :
            http_code == 503 ? (double)CODEX_ERR_SERVER_OVERLOADED :
            (double)CODEX_ERR_HTTP);
        char msg[64];
        snprintf(msg, sizeof(msg), "HTTP %ld", http_code);
        cJSON_AddStringToObject(err, "error_message", msg);
        char *line = cJSON_PrintUnformatted(err);
        cJSON_Delete(err);
        if (line) { write_event(line); free(line); }
    }

    /* Cleanup */
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    codex_sse_parser_destroy(parser);
    curl_slist_free_all(headers);
    free(body);
    codex_originator_cleanup();

    return (crc == CURLE_OK && (http_code == 200 || http_code == 0)) ? 0 : 1;
}
