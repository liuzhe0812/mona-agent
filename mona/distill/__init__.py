"""User distillation system.

Distills user behavior patterns and profile from accumulated data
(notes, emails, agent conversations, tool call history) into:
- USER.md (concise, for AI on-demand reading)
- profile.rich.json (rich, for frontend visualization)

See docs/architecture/user-profile-distillation.md for the design.
"""

from mona.distill.service import DistillService, register_distill_jobs

__all__ = ["DistillService", "register_distill_jobs"]
