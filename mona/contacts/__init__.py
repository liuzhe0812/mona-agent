"""联系人模块：CardDAV / Exchange ActiveSync 同步 + vCard 解析。"""

from mona.contacts.activesync import EASClient, EASError, generate_device_id
from mona.contacts.carddav import CardDavClient, CardDavError
from mona.contacts.sync import (
    sync_account_contacts,
    sync_account_contacts_eas,
    test_carddav_connection,
    test_eas_connection,
)
from mona.contacts.vcard import VCard, parse_vcard, parse_vcards

__all__ = [
    "VCard",
    "parse_vcard",
    "parse_vcards",
    "CardDavClient",
    "CardDavError",
    "EASClient",
    "EASError",
    "generate_device_id",
    "sync_account_contacts",
    "sync_account_contacts_eas",
    "test_carddav_connection",
    "test_eas_connection",
]
