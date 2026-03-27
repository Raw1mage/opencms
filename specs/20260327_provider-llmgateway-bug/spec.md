# Spec

## Purpose

- 定義 provider list 的產品真相來源，確保只有 cms 正式支援的 canonical providers 會出現在 `/provider` 與 UI。

## Requirements

### Requirement: Canonical Supported Provider Registry
The system SHALL maintain a repo-owned canonical provider registry that explicitly enumerates the cms-supported provider universe.

#### Scenario: Build provider universe from registry
- **GIVEN** the backend needs to produce the provider list
- **WHEN** `/provider` assembles canonical provider rows
- **THEN** the provider universe MUST start from the repo-owned supported-provider registry instead of raw observed provider IDs

### Requirement: Unsupported External Providers Stay Hidden
The system SHALL prevent unsupported external provider keys from entering the product-visible provider list.

#### Scenario: Unknown provider appears in config or models data
- **GIVEN** an unsupported provider key such as `llmgateway` exists in config, runtime provider state, accounts, or models.dev payload
- **WHEN** the backend builds `/provider` and the UI renders provider lists
- **THEN** that provider key MUST NOT appear in the canonical provider list unless it is explicitly added to the supported-provider registry

### Requirement: models.dev Enriches But Does Not Define Universe
The system SHALL use models.dev as an enrichment source for supported providers only.

#### Scenario: Supported provider receives models.dev updates
- **GIVEN** a provider already exists in the supported-provider registry
- **WHEN** models.dev contains newer model or metadata values for that provider
- **THEN** the system MAY merge those values into the provider row without changing the registry-defined provider universe

### Requirement: Stable Product Labels
The system SHALL derive provider labels and visibility from the canonical registry.

#### Scenario: UI shows provider labels
- **GIVEN** a supported provider appears in app or TUI provider-related UI
- **WHEN** the UI renders provider badges, lists, or selectors
- **THEN** it MUST use the registry-defined canonical provider identity and label semantics

## Acceptance Checks

- `/provider` no longer includes unsupported external keys such as `llmgateway` when they are absent from the registry.
- Supported canonical providers continue to appear with stable labels and projected configured/enabled state.
- `models.dev` updates models/metadata for supported providers without introducing new visible providers by itself.
- UI consuming paths no longer rely on ad-hoc provider label hardcodes as the primary authority.
