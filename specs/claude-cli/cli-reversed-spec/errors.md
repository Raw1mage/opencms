# Errors

## Error Catalogue

This is a documentation-only spec (reversed engineering datasheet). No runtime code is produced, so errors are limited to the analysis process itself.

| Code | Category | Description | Mitigation |
|------|----------|-------------|------------|
| E-01 | Extraction | Minified variable name prevents tracing a constant's origin | Cross-reference string literals and numeric values from multiple call sites; flag uncertainty in datasheet |
| E-02 | Extraction | Dead code path documented as active behavior | Note conditional guards in datasheet; mark with "static analysis only" caveat where runtime confirmation is absent |
| E-03 | Versioning | Upstream release invalidates documented constants | Apply DD-3 (delta tracking strategy): re-extract on new release, append delta section |
| E-04 | Completeness | A header or constant is present in live capture but missing from datasheet | Compare datasheet against network capture; add missing items and bump spec version |
