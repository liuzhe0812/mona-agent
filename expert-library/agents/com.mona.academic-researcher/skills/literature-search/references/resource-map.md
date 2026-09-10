# Literature search resource map

The rules in `SKILL.md` remain authoritative for mainland routing and failure semantics. Load the integrated Nature resources only when their condition applies.

- Multi-source search or ranking: read `upstream/nature-academic-search/references/workflows/wf1-multi-source-search.md`, then `upstream/nature-academic-search/references/search-strategy.md` and `upstream/nature-academic-search/references/dedup-engine.md`.
- PubMed/MeSH strategy: read `upstream/nature-academic-search/references/workflows/wf3-mesh-strategy.md`.
- Citation file export or ID conversion: read `upstream/nature-academic-search/references/workflows/wf4-citation-file-mgmt.md` or `upstream/nature-academic-search/references/workflows/wf5-reference-mgmt.md`, plus `upstream/nature-academic-search/references/ris-bibtex-format.md`.
- Source reliability comparison: read `upstream/nature-academic-search/references/source-tiers.md`, but override its China-specific and provider-availability assumptions with this Skill's current rules and actual tool status.
- Institution-authorized or CNKI full-text access: read `upstream/nature-downloader/references/institutional-browser-workflow.md`.
- Download verification or typed access failure: read `upstream/nature-downloader/references/delivery-verification-and-failures.md`; use `upstream/nature-downloader/data/publishers.json` for publisher configuration and `upstream/nature-downloader/data/school.schema.json` for school presets.

Runnable helpers:

- `preflight.py`: endpoint health before a batch operation.
- `academic_search.py`: OpenAlex fallback only when Mona's `academic_search` is unavailable; prefer a configured OpenAlex key.
- `format-converter.py`: deterministic NBIB/RIS/BibTeX/ENW conversion; keep `converters.py` beside it. Always pass `--output` with an absolute path inside the active workspace; never accept its package-relative default.
- `batch_download.mjs`: lawful OA/publisher batch retrieval with a typed manifest; require exactly one of `--si` or `--no-si`, pass `--out` with an absolute active-workspace path, and allow a longer script timeout. Its upstream authenticated-browser proxy is not Mona's browser transport: for CNKI, CARSI, WebVPN or an existing login session, use Mona's `browser_*` tools instead of claiming the script reused that session.
- `configure_school.py`: local school-resource configuration. On Windows, publisher secrets must come from Mona's secure credential settings or provider environment variables; `configure_credentials.py` deliberately refuses plaintext secret files.
- `extract_pdf_text.py`: local extraction after a verified download.

Run helpers with `skill_script_run`; Node helpers use the bundled `scripts/lib/`, `src/`, and `data/` resources. A helper failure is a source failure, not proof of no literature.
