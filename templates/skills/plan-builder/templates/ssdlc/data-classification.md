# Data Classification (SSDLC profile)

GDPR Art. 30-style record of the data this feature touches and how it flows through the system.

## Classification Levels

| Level | Definition | Handling |
|---|---|---|
| Public | non-sensitive | no special controls |
| Internal | business data | encrypted in transit |
| Confidential | PII / credentials | encrypted at rest + in transit, access audited |
| Restricted | regulated (health, financial) | additional compliance controls |

## Data Items

- **user.email** — Confidential / PII
  - **Source**: user registration form
  - **Sinks**: primary database, audit log
  - **Retention**: per policy section in proposal.md
  - **Trace to Sequence**: see `sequence.json` MSG-\<N\>

## Data Flow

For each Sequence diagram message carrying classified data, annotate the level:

- MSG1 (login request) — transports Confidential (password in transit; TLS enforced)
- MSG5 (session token write) — Confidential (token must be hashed before persistence)

## Controls

- Encryption at rest / in transit per classification
- Access control matrix (who can read / write each data item)
- Retention + deletion policy
