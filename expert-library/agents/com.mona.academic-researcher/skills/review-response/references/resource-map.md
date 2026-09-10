# Review and response resource map

For simulated peer review, load the Nature Reviewer references in this order:

1. `upstream/nature-reviewer/references/reviewer-workflow.md`
2. `upstream/nature-reviewer/references/review-axes.md`, `upstream/nature-reviewer/references/role-boundaries.md`, and `upstream/nature-reviewer/references/source-basis.md`
3. `upstream/nature-reviewer/references/technical-concern-taxonomy.md` or `upstream/nature-reviewer/references/domain-specific-review-gates.md` only when applicable
4. `upstream/nature-reviewer/references/report-structure.md` and `upstream/nature-reviewer/references/qa-checklist.md` before delivery

For reviewer responses, load `upstream/nature-response/static/core/stance.md` and `upstream/nature-response/static/core/workflow.md`, then the complete paths `upstream/nature-response/references/intake-and-routing.md`, `upstream/nature-response/references/comment-taxonomy.md`, `upstream/nature-response/references/action-mapping.md`, `upstream/nature-response/references/response-structure.md`, and `upstream/nature-response/references/qa-checklist.md`. Use the same full prefix for difficult cases, Chinese-author alignment, source basis, LaTeX templates, or package consistency.

Integrated examples cover minor revision, missing evidence, and conflicting reviewers. They are patterns, not facts to copy. `check_package_consistency.py` can be run with `skill_script_run` for a LaTeX response package; never report modifications or experiments as complete unless the corresponding files or outputs were actually checked.
