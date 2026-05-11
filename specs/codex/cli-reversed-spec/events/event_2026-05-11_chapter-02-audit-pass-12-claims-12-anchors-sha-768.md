---
date: 2026-05-11
summary: "Chapter 02 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions"
---

# Chapter 02 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged from Ch01).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **6 TYPE + 2 TEST** — far exceeds ≥1 floor.
  - TYPE: AuthMode (C1), AuthDotJson (C2), TokenData (C4), IdTokenInfo (C5), AuthStorageBackend (C6), AuthProvider (C11).
  - TEST: `file_storage_delete_removes_auth_file` (C7), `is_first_party_originator_matches_known_values` (C10).
- **Open questions**: 0.

## Datasheets delivered

- **D2-1 `$CODEX_HOME/auth.json`** — AuthDotJson + TokenData + IdTokenInfo sub-shapes; columns Field / Type / Required / Source / Stability / Notes; sanitized example payload.
- **D2-2 `$CODEX_HOME/installation_id`** — single-line UUID v4 file; mode 0o644; FILENAME constant; example payload `42dbf4ca-fda0-44f9-ba52-2e4618b727c5`.

## Cross-diagram traceability check (per miatdiagram §4.7)

Walked the cross-links:

- Module architecture box `login::auth/storage.rs` → IDEF0 A2.2 → datasheet D2-1 ✓
- Module architecture box `core::installation_id.rs` → IDEF0 A2.3 → datasheet D2-2 ✓
- Module architecture box `login::auth/default_client.rs` → IDEF0 A2.4 (via C8/C9/C10) ✓
- Module architecture box `backend-client::client.rs::headers` → IDEF0 A2.5 (via C11/C12) ✓
- Every IDEF0 Mechanism cell in `idef0.02.json` resolves to an architecture box on the chapter diagram ✓
- Every datasheet field row has a non-empty `Source (file:line)` link ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | `app-server-protocol/src/protocol/common.rs:21` | enum | ✓ 4 variants confirmed |
| C2 | `login/src/auth/storage.rs:33` | struct | ✓ 5 fields confirmed |
| C3 | `login/src/auth/storage.rs:84` | fn | ✓ `codex_home.join("auth.json")` exact |
| C4 | `login/src/token_data.rs:11` | struct | ✓ 4 fields incl custom serde on id_token |
| C5 | `login/src/token_data.rs:29` | struct | ✓ 6 fields incl chatgpt_account_is_fedramp bool |
| C6 | `login/src/auth/storage.rs:97` | trait | ✓ 3 methods (load/save/delete) |
| C7 | `login/src/auth/storage_tests.rs:116` | TEST | ✓ round-trip + delete asserts |
| C8 | `login/src/auth/default_client.rs:36` | const | ✓ DEFAULT_ORIGINATOR string + env override name |
| C9 | `login/src/auth/default_client.rs:133` | fn | ✓ UA format string confirmed (line 133-141) |
| C10 | `login/src/auth/default_client_tests.rs:15` | TEST | ✓ originator whitelist pinned |
| C11 | `codex-api/src/auth.rs:30` | trait | ✓ AuthProvider methods confirmed |
| C12 | `backend-client/src/client.rs:205` | fn | ✓ headers() assembly site confirmed; lines 205-225 cover UA + auth + account + fedramp |

## OpenCode drift findings

- **`X-OpenAI-Fedramp` header NOT emitted by OpenCode** (A2.5 delta). Documented in chapter, not a cache-related issue but a routing-correctness issue for workspace accounts with fedramp flag. Out of scope for this reference (which is descriptive, not prescriptive); flagged for future ticket.
- **`accounts.json` (OpenCode) is a superset of upstream `auth.json` schema** with multi-account semantics. By design; no drift target.

## Next

Chapter 03 (Session & Turn Lifecycle) on user signal. That chapter will fully unpack the A1.4 / A1.5 deltas flagged in Chapter 01 (OpenCode lacks session-stable ModelClientState equivalent).
