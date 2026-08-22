"""Mona services process: business services decoupled from the Agent runtime.

Hosts email (IMAP/SMTP/IDLE), contacts, video projects, materials, profile,
schedule and hoard HTTP routes. See docs/architecture/services-split-design.md.
"""

__all__ = ["create_services_app"]


def __getattr__(name: str):
    if name != "create_services_app":
        raise AttributeError(name)
    from mona.services.server import create_services_app

    return create_services_app
