# Manuscript editing resource map

For drafting, load Nature Writing progressively:

1. `upstream/nature-writing/static/core/stance.md`, `upstream/nature-writing/static/core/workflow.md`, and `upstream/nature-writing/static/core/output-format.md`.
2. Select exact fragment paths from `upstream/nature-writing/manifest.yaml`; common choices include `upstream/nature-writing/static/fragments/paper_type/research.md`, `upstream/nature-writing/static/fragments/language/en.md`, `upstream/nature-writing/static/fragments/journal/nature.md`, and `upstream/nature-writing/static/fragments/section/discussion.md`.
3. A detailed reference or example only when the section fragment is insufficient.

For polishing, load Nature Polishing progressively:

1. `upstream/nature-polishing/static/core/stance.md`, `upstream/nature-polishing/static/core/failure-modes.md`, and `upstream/nature-polishing/static/core/output-format.md`.
2. Select exact polishing fragment paths from `upstream/nature-polishing/manifest.yaml`.
3. Load complete paths `upstream/nature-polishing/references/style-guardrails.md`, `upstream/nature-polishing/references/section-moves.md`, `upstream/nature-polishing/references/writing-strategy.md`, or `upstream/nature-polishing/references/phrasebank-playbook.md` only when needed.

Shared Nature resources are indexed by `upstream/nature-shared/manifest.yaml` and govern terminology, compliance, ethics, consistency, main-text discipline, abstract/introduction/results/discussion logic, and target-journal formats. Submission `.tex` templates are indexed by the integrated `upstream/nature-writing/manifest.yaml` and should be read only for an explicitly requested submission package.

For Chinese proposals or staged writing, the integrated proposal anti-slop, Chinese review style, and partial-scope references may be loaded. The evidence and experiment boundaries in `SKILL.md` always take precedence over style guidance.
