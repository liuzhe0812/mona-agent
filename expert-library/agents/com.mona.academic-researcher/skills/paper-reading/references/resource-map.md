# Paper reading resource map

For a full reader, first load these integrated Nature Reader files:

- `upstream/nature-reader/static/core/principles.md`
- `upstream/nature-reader/static/core/workflow.md`
- `upstream/nature-reader/static/core/output-contract.md`
- `upstream/nature-shared/core/terminology-ledger.md`

Then load exactly one complete source path: `upstream/nature-reader/static/fragments/source/pdf-text.md`, `upstream/nature-reader/static/fragments/source/scanned-pdf.md`, `upstream/nature-reader/static/fragments/source/html.md`, `upstream/nature-reader/static/fragments/source/doi-arxiv.md`, or `upstream/nature-reader/static/fragments/source/pasted-text.md`. Optional deep references are `upstream/nature-reader/references/figure-extraction.md`, `upstream/nature-reader/references/equation-handling.md`, `upstream/nature-reader/references/grounding-rules.md`, `upstream/nature-reader/references/article-anatomy.md`, and `upstream/nature-reader/references/output-spec.md`.

For an explicit deep-analysis/Paper Card request, load `upstream/nature-paper-card/static/core/principles.md`, `upstream/nature-paper-card/static/core/workflow.md`, and `upstream/nature-paper-card/static/core/output-contract.md`, plus no more than two exact paper-type fragments named by `upstream/nature-paper-card/manifest.yaml`. Then read `upstream/nature-paper-card/references/evidence-and-provenance.md`, `upstream/nature-paper-card/references/card-schema.md`, and `upstream/nature-paper-card/references/research-idea-gates.md` as required.

Runnable helpers:

- `validate_reader_math.py`: validate rendered equation blocks.
- `prepare_paper.py`: build a source bundle from a PDF/source map before a Paper Card.
- `audit_paper_card.py`: block ungrounded or structurally invalid Paper Cards.

Use `skill_script_run`; do not replace these repeatable checks with one-off extraction code.
