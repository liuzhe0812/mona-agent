# Analysis and experiment resource map

- Data availability and FAIR work: read `upstream/nature-data/static/core/stance.md`, `upstream/nature-data/static/core/workflow.md`, and only an applicable complete path named by `upstream/nature-data/manifest.yaml`.
- Statistics: use `upstream/nature-statistics/references/statistical-reporting.md`, `upstream/nature-statistics/references/figure-statistics.md`, `upstream/nature-statistics/references/reviewer-checklist.md`, or `upstream/nature-statistics/references/common-failure-modes.md` as applicable.
- Publication figures: read `upstream/nature-figure/static/core/stance.md` and `upstream/nature-figure/static/core/contract.md`, then choose `upstream/nature-figure/static/fragments/backend/python.md` or `upstream/nature-figure/static/fragments/backend/r.md`. Load `upstream/nature-figure/references/figure-contract.md`, `upstream/nature-figure/references/multipanel-evidence-architecture.md`, `upstream/nature-figure/references/figure-legend-conventions.md`, `upstream/nature-figure/references/qa-contract.md`, or `upstream/nature-figure/references/ai-graphical-abstract-workflow.md` only when applicable.
- Experiment logging: choose `upstream/nature-experiment-log/templates/experiment-index.md`, `upstream/nature-experiment-log/references/example-log.md`, or a domain example named by `upstream/nature-experiment-log/manifest.yaml` only when the user requests a durable lab/experiment log.

Runnable figure helpers are in `scripts/`: backend selection, plot templates, validation, PDF text audit, panel alignment, and collision audit. Run Python helpers with `skill_script_run`; `panel_alignment.R` is a bundled backend resource invoked by the Python workflow when R is available. `generate_openrouter_schematic.py` is optional and must not run without an explicitly configured key and user-authorized external call.

The real-execution, baseline, metric, budget, and isolation rules in `SKILL.md` override any example or upstream suggestion.
