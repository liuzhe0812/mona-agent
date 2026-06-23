"""联系人同步调度。

协调 CardDAV / Exchange ActiveSync 客户端拉取，返回结构化结果供 Rust 侧写入 SQLite。
本模块不直接操作数据库（遵循 Python 侧只读 SQLite 的架构约定）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from mona.contacts.activesync import EASClient, EASError, generate_device_id
from mona.contacts.carddav import CardDavClient, CardDavError
from mona.contacts.vcard import VCard, to_dict


@dataclass
class SyncedContact:
    """单个同步联系人（Python → Rust 传递用）。"""

    remote_uid: str
    etag: str | None
    data: dict[str, Any]


@dataclass
class AccountSyncResult:
    """账号同步结果。"""

    added: int = 0
    updated: int = 0
    deleted: int = 0
    total: int = 0
    sync_token: str | None = None
    contacts: list[SyncedContact] = field(default_factory=list)
    deleted_uids: list[str] = field(default_factory=list)
    error: str | None = None


async def sync_account_contacts(
    carddav_url: str,
    username: str,
    password: str,
    old_sync_token: str | None = None,
) -> AccountSyncResult:
    """同步单个账号的联系人（仅下载）。

    Args:
        carddav_url: CardDAV 服务地址
        username: 用户名（通常为邮箱）
        password: 密码或应用专用密码
        old_sync_token: 上次同步的 token（增量同步用）

    Returns:
        AccountSyncResult，含联系人列表和新的 sync_token
    """
    result = AccountSyncResult()
    try:
        async with CardDavClient(carddav_url, username, password) as client:
            ab_url = await client.discover_addressbook()

            if old_sync_token:
                # 增量同步
                sync_res = await client.sync_collection(ab_url, old_sync_token)
                for change in sync_res.changes:
                    if change.deleted:
                        # href 通常是 .../UID.vcf，提取 UID
                        uid = _extract_uid_from_href(change.href)
                        if uid:
                            result.deleted_uids.append(uid)
                    elif change.vcard:
                        result.contacts.append(_to_synced(change.href, change.etag, change.vcard))
                result.sync_token = sync_res.new_sync_token or old_sync_token
                result.added = len(result.contacts)
                result.deleted = len(result.deleted_uids)
                result.total = result.added
            else:
                # 全量同步
                all_items = await client.full_sync(ab_url)
                for href, etag, card in all_items:
                    result.contacts.append(_to_synced(href, etag, card))
                result.sync_token = None  # 全量同步后下次仍走全量，直到拿到 token
                result.added = len(result.contacts)
                result.total = result.added

                # 尝试获取初始 sync-token 供下次增量
                try:
                    sync_res = await client.sync_collection(ab_url, None)
                    result.sync_token = sync_res.new_sync_token
                except CardDavError:
                    pass

    except CardDavError as e:
        logger.warning(f"CardDAV 同步失败: {e}")
        result.error = str(e)
    except Exception as e:
        logger.exception("CardDAV 同步异常")
        result.error = f"同步异常: {e}"

    return result


async def test_carddav_connection(
    carddav_url: str,
    username: str,
    password: str,
) -> tuple[bool, int, str | None]:
    """测试 CardDAV 连接，返回 (ok, contacts_count, error)。"""
    try:
        async with CardDavClient(carddav_url, username, password) as client:
            return await client.test_connection()
    except CardDavError as e:
        return False, 0, str(e)
    except Exception as e:
        return False, 0, f"未知错误: {e}"


def _to_synced(href: str, etag: str | None, card: VCard) -> SyncedContact:
    """将 VCard 转为 SyncedContact。"""
    data = to_dict(card)
    # href 作为 remote_uid 的备用（部分服务器 UID 为空）
    if not data.get("remoteUid"):
        data["remoteUid"] = _extract_uid_from_href(href) or href
    return SyncedContact(
        remote_uid=data["remoteUid"] or "",
        etag=etag,
        data=data,
    )


def _extract_uid_from_href(href: str) -> str:
    """从 CardDAV href 提取 UID（如 /carddav/uids/abc-123.vcf → abc-123）。"""
    # 取最后一段路径
    last = href.rstrip("/").rsplit("/", 1)[-1]
    # 去掉 .vcf 后缀
    if last.lower().endswith(".vcf"):
        last = last[:-4]
    return last


# ---------------------------------------------------------------------------
# Exchange ActiveSync 同步
# ---------------------------------------------------------------------------


async def sync_account_contacts_eas(
    eas_url: str,
    username: str,
    password: str,
    account_id: str,
    old_sync_key: str | None = None,
) -> AccountSyncResult:
    """通过 Exchange ActiveSync 同步联系人（仅下载）。

    Args:
        eas_url: EAS 服务地址（如 https://ex.exmail.qq.com/Microsoft-Server-ActiveSync）
        username: 用户名（通常为邮箱）
        password: 密码
        account_id: 账号 ID（用于生成稳定 DeviceID）
        old_sync_key: 上次同步的 SyncKey（增量同步用）

    Returns:
        AccountSyncResult
    """
    result = AccountSyncResult()
    device_id = generate_device_id(account_id)

    try:
        async with EASClient(eas_url, username, password, device_id) as client:
            # Step 1: PROVISION（获取 PolicyKey）
            try:
                await client.provision()
            except EASError as e:
                logger.warning(f"EAS PROVISION 失败（继续尝试）: {e}")

            # Step 2: 查找联系人文件夹
            collection_id = await client.find_contacts_folder()

            # Step 3: SYNC 联系人
            sync_key = old_sync_key or "0"
            is_full_sync = sync_key == "0"

            all_contacts: list[SyncedContact] = []
            all_deleted: list[str] = []
            max_iterations = 50  # 防止无限循环

            for _ in range(max_iterations):
                sync_res = await client.sync_contacts(collection_id, sync_key)

                for c in sync_res.contacts:
                    all_contacts.append(
                        SyncedContact(
                            remote_uid=c.server_id,
                            etag=None,
                            data=c.data,
                        )
                    )
                all_deleted.extend(sync_res.deleted_ids)

                sync_key = sync_res.sync_key
                if not sync_res.more_available:
                    break

            result.contacts = all_contacts
            result.deleted_uids = all_deleted
            result.sync_token = sync_key if sync_key != "0" else None
            result.added = len(all_contacts)
            result.deleted = len(all_deleted)
            result.total = result.added

            if is_full_sync:
                # 全量同步标记（Rust 侧据此清空旧数据）
                logger.info(f"EAS 全量同步完成: {result.total} 个联系人")
            else:
                logger.info(
                    f"EAS 增量同步完成: +{result.added} -{result.deleted}"
                )

    except EASError as e:
        logger.warning(f"EAS 同步失败: {e}")
        result.error = str(e)
    except Exception as e:
        logger.exception("EAS 同步异常")
        result.error = f"同步异常: {e}"

    return result


async def test_eas_connection(
    eas_url: str,
    username: str,
    password: str,
    account_id: str = "",
) -> tuple[bool, int, str | None]:
    """测试 EAS 连接，返回 (ok, contacts_count, error)。

    执行 PROVISION + FOLDERSYNC 验证连接，不执行完整 SYNC。
    """
    device_id = generate_device_id(account_id or username)
    try:
        async with EASClient(eas_url, username, password, device_id) as client:
            try:
                await client.provision()
            except EASError:
                pass  # 部分服务器不需要 provision
            _, folders = await client.folder_sync("0")
            contacts_count = sum(1 for f in folders if f.folder_type == 9)
            return True, contacts_count, None
    except EASError as e:
        return False, 0, str(e)
    except Exception as e:
        return False, 0, f"未知错误: {e}"
