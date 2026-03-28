/*
 * originator.c — Client identity string construction
 *
 * Format: codex_cli_rs/{version} ({os_type} {os_version}; {architecture})
 *
 * Environment override: CODEX_INTERNAL_ORIGINATOR_OVERRIDE
 */

#include "codex_provider.h"

/* _GNU_SOURCE defined at build level */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
  #include <windows.h>
#else
  #include <sys/utsname.h>
#endif

/* --------------------------------------------------------------------------
 * Global originator string
 * ----------------------------------------------------------------------- */

static char *g_originator = NULL;

/* --------------------------------------------------------------------------
 * codex_originator_init
 * ----------------------------------------------------------------------- */

int codex_originator_init(const char *version)
{
    if (g_originator) return CODEX_OK; /* already initialized */

    /* Check env override first */
    const char *env_override = getenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
    if (env_override && env_override[0]) {
        g_originator = strdup(env_override);
        return g_originator ? CODEX_OK : CODEX_ERR_OOM;
    }

    const char *ver = version ? version : CODEX_PROVIDER_VERSION;

#ifdef _WIN32
    OSVERSIONINFOW osvi;
    memset(&osvi, 0, sizeof(osvi));
    osvi.dwOSVersionInfoSize = sizeof(osvi);

    const char *os_type = "Windows";
    char os_version[64] = "unknown";
    char arch[32] = "x86_64";

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    if (si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM64)
        snprintf(arch, sizeof(arch), "aarch64");

    char buf[512];
    snprintf(buf, sizeof(buf), "codex_cli_rs/%s (%s %s; %s)",
             ver, os_type, os_version, arch);
    g_originator = strdup(buf);
#else
    struct utsname uts;
    if (uname(&uts) != 0) {
        /* Fallback if uname fails */
        char buf[512];
        snprintf(buf, sizeof(buf), "codex_cli_rs/%s (Unknown; Unknown)", ver);
        g_originator = strdup(buf);
        return g_originator ? CODEX_OK : CODEX_ERR_OOM;
    }

    /* Map machine to codex-rs format */
    const char *arch = uts.machine;
    if (strcmp(uts.machine, "x86_64") == 0)
        arch = "x86_64";
    else if (strcmp(uts.machine, "aarch64") == 0 ||
             strcmp(uts.machine, "arm64") == 0)
        arch = "aarch64";

    char buf[512];
    snprintf(buf, sizeof(buf), "codex_cli_rs/%s (%s %s; %s)",
             ver, uts.sysname, uts.release, arch);
    g_originator = strdup(buf);
#endif

    return g_originator ? CODEX_OK : CODEX_ERR_OOM;
}

/* --------------------------------------------------------------------------
 * codex_originator_cleanup
 * ----------------------------------------------------------------------- */

void codex_originator_cleanup(void)
{
    free(g_originator);
    g_originator = NULL;
}

/* --------------------------------------------------------------------------
 * codex_get_originator
 * ----------------------------------------------------------------------- */

CODEX_EXPORT const char *codex_get_originator(void)
{
    return g_originator;
}
