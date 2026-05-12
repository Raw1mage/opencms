# Compliance Map (SSDLC profile)

Bidirectional mapping between spec Requirements and external compliance controls (SOC 2, ISO 27001, GDPR, HIPAA, etc.).

## Framework in Scope

- [ ] SOC 2 Trust Services Criteria (CC1-CC9)
- [ ] ISO 27001 Annex A controls
- [ ] GDPR Articles
- [ ] HIPAA Privacy / Security Rule
- [ ] PCI-DSS
- [ ] Other: _____

## Requirement → Control

For each `### Requirement:` in spec.md, list which external controls it implements or supports.

- **Requirement: Session expiry** → SOC 2 CC6.1 (logical access), GDPR Art. 32 (security of processing)
- **Requirement: Audit logging** → SOC 2 CC7.2, ISO 27001 A.12.4, HIPAA §164.312(b)

## Control → Requirement

Reverse index. Used by auditors to see which controls have code-level implementation anchors.

- **SOC 2 CC6.1**: implemented via Requirement "Session expiry", Requirement "MFA enforcement"
- **GDPR Art. 30 (Records of processing)**: implemented via `data-classification.md` + `.state.json.history` (change management record)

## Evidence Pointers

Where an auditor can fetch the evidence automatically.

- `.state.json.history` — Change Management evidence (SOC 2 CC8.1)
- `data-classification.md` — Data processing record (GDPR Art. 30)
- `threat-model.md` — Secure design review evidence (SOC 2 CC3.1, ISO 27001 A.14.2.1)
- `tasks.md` + git log — Implementation tracking
- `observability.md` alerts — Operational monitoring (SOC 2 CC7.1)
