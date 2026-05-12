# Threat Model (SSDLC profile)

STRIDE analysis anchored on C4 components. Each identified threat points to a mitigation plus enforcement point.

## Assets

- List data / capabilities this feature must protect (credentials, PII, tokens, financial data, etc.)

## Trust Boundaries

- Describe where trust transitions happen — e.g. browser ↔ API, API ↔ DB, service ↔ third-party.

## STRIDE per Component

### C1 (example component)

- **Spoofing**: threat description → mitigation → enforcement point
- **Tampering**: threat → mitigation → enforcement
- **Repudiation**: threat → mitigation → enforcement
- **Information Disclosure**: threat → mitigation → enforcement
- **Denial of Service**: threat → mitigation → enforcement
- **Elevation of Privilege**: threat → mitigation → enforcement

## Residual Risks

- Threats accepted with explicit rationale (e.g. out of scope, compensating control elsewhere).
