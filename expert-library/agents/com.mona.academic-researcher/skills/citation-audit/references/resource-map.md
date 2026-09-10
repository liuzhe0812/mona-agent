# Citation audit resource map

- Batch bibliographic verification: read `upstream/nature-ref-verifier/references/common-patterns.md`.
- Extracting citations from a document: read `upstream/nature-academic-search/references/citation-parser.md` and `upstream/nature-academic-search/references/workflows/wf2-citation-verification.md`.
- Deduplication and metadata/file repair: read `upstream/nature-academic-search/references/dedup-engine.md`, `upstream/nature-academic-search/references/workflows/wf4-citation-file-mgmt.md`, `upstream/nature-academic-search/references/workflows/wf5-reference-mgmt.md`, and `upstream/nature-academic-search/references/ris-bibtex-format.md` as applicable.
- Finding support for manuscript claims: load `upstream/nature-citation/static/core/principles.md`, `upstream/nature-citation/static/core/workflow.md`, and `upstream/nature-citation/static/core/chinese-mode.md`, then read `upstream/nature-citation/references/search-strategy.md`. Load `upstream/nature-citation/references/journal-scope.md` only for Nature/CNS-family limits, `upstream/nature-citation/references/ris-endnote.md` only for export, and `upstream/nature-citation/references/script-usage.md` before running the helper.

`nature_citation.py` is the integrated deterministic helper for segmentation, Crossref lookup, and reference-manager exports. Run it with `skill_script_run` and pass every output path explicitly inside the active workspace. Metadata relevance alone never proves claim support; the audit status in `SKILL.md` remains authoritative.
