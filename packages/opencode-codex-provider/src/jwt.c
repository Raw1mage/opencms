/*
 * jwt.c — JWT decode and claim extraction
 *
 * Decodes JWT payload (no signature verification — server already validated).
 * Extracts claims from https://api.openai.com/auth namespace.
 */

#include "codex_provider.h"
#include <cjson/cJSON.h>

#include <stdlib.h>
#include <string.h>

/* OpenSSL for base64 */
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/buffer.h>

/* --------------------------------------------------------------------------
 * base64url decode
 *
 * JWT uses base64url (RFC 4648 §5): '-' instead of '+', '_' instead of '/',
 * no padding. We convert to standard base64, pad, then decode.
 * ----------------------------------------------------------------------- */

static int base64url_decode(const char *input, size_t input_len,
                            unsigned char **out, size_t *out_len)
{
    if (!input || !out || !out_len) return -1;

    /* Convert base64url → base64 */
    size_t padded_len = input_len;
    size_t mod = input_len % 4;
    if (mod) padded_len += (4 - mod);

    char *b64 = malloc(padded_len + 1);
    if (!b64) return -1;

    for (size_t i = 0; i < input_len; i++) {
        char c = input[i];
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
        b64[i] = c;
    }
    /* Pad with '=' */
    for (size_t i = input_len; i < padded_len; i++)
        b64[i] = '=';
    b64[padded_len] = '\0';

    /* Decode via OpenSSL BIO */
    BIO *b64bio = BIO_new(BIO_f_base64());
    BIO *membio = BIO_new_mem_buf(b64, (int)padded_len);
    membio = BIO_push(b64bio, membio);
    BIO_set_flags(membio, BIO_FLAGS_BASE64_NO_NL);

    unsigned char *decoded = malloc(padded_len); /* output ≤ input */
    if (!decoded) {
        BIO_free_all(membio);
        free(b64);
        return -1;
    }

    int decoded_len = BIO_read(membio, decoded, (int)padded_len);
    BIO_free_all(membio);
    free(b64);

    if (decoded_len < 0) {
        free(decoded);
        return -1;
    }

    *out = decoded;
    *out_len = (size_t)decoded_len;
    return 0;
}

/* --------------------------------------------------------------------------
 * codex_jwt_decode — parse JWT payload into cJSON
 * ----------------------------------------------------------------------- */

cJSON *codex_jwt_decode_payload(const char *token)
{
    if (!token) return NULL;

    /* Find the two dots */
    const char *dot1 = strchr(token, '.');
    if (!dot1) return NULL;
    const char *payload_start = dot1 + 1;

    const char *dot2 = strchr(payload_start, '.');
    if (!dot2) return NULL;

    size_t payload_b64_len = (size_t)(dot2 - payload_start);

    unsigned char *decoded = NULL;
    size_t decoded_len = 0;
    if (base64url_decode(payload_start, payload_b64_len,
                         &decoded, &decoded_len) != 0)
        return NULL;

    cJSON *json = cJSON_ParseWithLength((const char *)decoded, decoded_len);
    free(decoded);
    return json;
}

/* --------------------------------------------------------------------------
 * codex_jwt_extract_claims
 *
 * Parse id_token and fill codex_jwt_claims_t.
 * Caller must call codex_jwt_claims_free() when done.
 * ----------------------------------------------------------------------- */

static char *get_string(const cJSON *obj, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsString(item) && item->valuestring)
        return strdup(item->valuestring);
    return NULL;
}

static codex_plan_type_t parse_plan_type(const char *s)
{
    if (!s) return CODEX_PLAN_UNKNOWN;
    if (strcmp(s, "free") == 0)       return CODEX_PLAN_FREE;
    if (strcmp(s, "plus") == 0)       return CODEX_PLAN_PLUS;
    if (strcmp(s, "pro") == 0)        return CODEX_PLAN_PRO;
    if (strcmp(s, "team") == 0)       return CODEX_PLAN_TEAM;
    if (strcmp(s, "business") == 0)   return CODEX_PLAN_BUSINESS;
    if (strcmp(s, "enterprise") == 0) return CODEX_PLAN_ENTERPRISE;
    if (strcmp(s, "edu") == 0)        return CODEX_PLAN_EDU;
    return CODEX_PLAN_UNKNOWN;
}

int codex_jwt_extract_claims(const char *id_token, codex_jwt_claims_t *out)
{
    if (!id_token || !out) return CODEX_ERR_INVALID_ARG;

    memset(out, 0, sizeof(*out));
    out->raw_id_token = strdup(id_token);

    cJSON *payload = codex_jwt_decode_payload(id_token);
    if (!payload) return CODEX_ERR_AUTH_CORRUPT;

    /* Try email at top level, then profile.email */
    out->email = get_string(payload, "email");
    if (!out->email) {
        const cJSON *profile = cJSON_GetObjectItemCaseSensitive(payload, "profile");
        if (profile)
            out->email = get_string(profile, "email");
    }

    /* OpenAI auth namespace: https://api.openai.com/auth */
    const cJSON *auth_ns = cJSON_GetObjectItemCaseSensitive(
        payload, "https://api.openai.com/auth");

    if (auth_ns) {
        out->account_id = get_string(auth_ns, "chatgpt_account_id");
        out->user_id    = get_string(auth_ns, "chatgpt_user_id");

        char *plan_str  = get_string(auth_ns, "chatgpt_plan_type");
        out->plan_type  = parse_plan_type(plan_str);
        free(plan_str);
    }

    /* Fallback: top-level claims */
    if (!out->account_id)
        out->account_id = get_string(payload, "chatgpt_account_id");
    if (!out->user_id)
        out->user_id = get_string(payload, "user_id");

    cJSON_Delete(payload);
    return CODEX_OK;
}

/* --------------------------------------------------------------------------
 * codex_jwt_claims_free
 * ----------------------------------------------------------------------- */

void codex_jwt_claims_free(codex_jwt_claims_t *claims)
{
    if (!claims) return;
    free((void *)claims->email);
    free((void *)claims->user_id);
    free((void *)claims->account_id);
    free((void *)claims->raw_id_token);
    memset(claims, 0, sizeof(*claims));
}

/* --------------------------------------------------------------------------
 * Convenience: extract just account_id
 * ----------------------------------------------------------------------- */

char *codex_jwt_extract_account_id(const char *token)
{
    codex_jwt_claims_t claims;
    if (codex_jwt_extract_claims(token, &claims) != CODEX_OK)
        return NULL;
    char *result = claims.account_id ? strdup(claims.account_id) : NULL;
    codex_jwt_claims_free(&claims);
    return result;
}
