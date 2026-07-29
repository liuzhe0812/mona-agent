"""Mona services process: business services decoupled from the Agent runtime.

Hosts email (IMAP/SMTP/IDLE), contacts, video projects, materials, profile,
schedule and hoard HTTP routes. See docs/architecture/services-split-design.md.
"""

from mona.services.server import create_services_app

__all__ = ["create_services_app"]
