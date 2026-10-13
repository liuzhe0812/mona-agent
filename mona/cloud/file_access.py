"""On-demand file hydration after the caller's ordinary path/owner checks."""
from pathlib import Path

from mona.cloud.work_files import HEX64, ID32


def is_cloud_file_path(path: Path) -> bool:
    parts = path.parts
    return (len(parts) >= 4 and parts[-4] == "cloud"
            and ID32.fullmatch(parts[-3]) is not None
            and HEX64.fullmatch(parts[-2]) is not None)


async def ensure_session_file(manager, session_key: str | None, path: Path) -> bool:
    # An ordinary missing local file must not contact the account/cloud service.
    if not is_cloud_file_path(path):
        return False
    resolver = getattr(manager, "cloud_file_resolver", None)
    if resolver is None:
        return False
    return await resolver(session_key, path)
