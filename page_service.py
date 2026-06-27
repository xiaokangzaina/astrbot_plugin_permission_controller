from __future__ import annotations

import json
import platform
import re
import inspect
import sys
import time
from pathlib import Path
from typing import Any

from astrbot.api import logger

PLUGIN_DIR = Path(__file__).resolve().parent
GROUP_TOUCH_FILE = PLUGIN_DIR / "data" / "group_config_touch_times.json"
PRIVATE_TOUCH_FILE = PLUGIN_DIR / "data" / "private_config_touch_times.json"

# schema 顶层分组键 -> 其 items
# 配置在 _conf_schema.json 中是两层结构：
#   private_chat_settings.items.{...}
#   group_chat_settings.items.{...}
# 前端按分组渲染，后端按 key 写回到对应分组。


def _parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "on", "开启", "开", "启用"):
            return True
        if text in ("0", "false", "no", "off", "关闭", "关", "禁用"):
            return False
    return None


def _normalize_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[\n,，]+", value)
    elif isinstance(value, list):
        parts = value
    else:
        return []
    return [str(item).strip() for item in parts if str(item).strip()]


REASONING_LEVEL_LABELS = {
    "": "默认",
    "low": "低",
    "medium": "中",
    "high": "高",
}

REASONING_LEVEL_ALIASES = {
    "": "",
    "default": "",
    "默认": "",
    "不设置": "",
    "关闭": "",
    "低": "low",
    "low": "low",
    "l": "low",
    "中": "medium",
    "medium": "medium",
    "mid": "medium",
    "m": "medium",
    "高": "high",
    "high": "high",
    "h": "high",
    "超高": "high",
    "最高": "high",
    "ultra": "high",
    "max": "high",
    "maximum": "high",
}


def _normalize_reasoning_effort(value: Any) -> str:
    text = str(value or "").strip()
    return REASONING_LEVEL_ALIASES.get(
        text.lower(),
        REASONING_LEVEL_ALIASES.get(text, ""),
    )


def _reasoning_label(value: Any) -> str:
    return REASONING_LEVEL_LABELS.get(_normalize_reasoning_effort(value), "默认")


def _split_reasoning_rule(rule: Any) -> tuple[str, str] | None:
    text = str(rule or "").strip()
    if not text:
        return None
    for sep in ("=", "：", ":"):
        if sep in text:
            target, effort = text.split(sep, 1)
            target = target.strip()
            effort = _normalize_reasoning_effort(effort)
            if target:
                return target, effort
            return None
    return None


def _reasoning_map(value: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in _normalize_list(value):
        parsed = _split_reasoning_rule(item)
        if not parsed:
            continue
        target, effort = parsed
        if effort:
            result[target] = effort
    return result


def _get_astrbot_version() -> str:
    try:
        from astrbot.core.config.default import VERSION

        value = str(VERSION or "").strip()
        if value:
            return value if value.startswith("v") else f"v{value}"
    except Exception:
        pass
    return "未知"


class PermissionPageService:
    """权限控制器配置页服务。"""

    def __init__(self, plugin: Any):
        # plugin 为 GroupUserWhitelistPlugin 实例，持有 self.config (AstrBotConfig)
        self.plugin = plugin
        self.schema = self._load_schema(PLUGIN_DIR / "_conf_schema.json")

    # ---------- 对外接口 ----------

    def get_bootstrap_payload(self) -> dict[str, Any]:
        """返回 schema 分组结构 + 当前配置值。"""
        config = self._read_current_config()
        return {
            "schema": self.schema,
            "config": config,
            "groups": self._build_configured_groups(config),
            "system": self._build_system_info(),
        }

    async def list_groups(self) -> list[dict[str, Any]]:
        """返回机器人已加入的 QQ 群列表；实时列表不可用时才回退到配置群号。"""
        groups: dict[str, dict[str, Any]] = {}
        live_loaded = False
        for client in self._iter_qq_clients():
            try:
                result = await self._call_client_action(client, "get_group_list")
                live_loaded = True
                for item in self._extract_group_list(result):
                    group_id = self._raw_group_id(item)
                    if not group_id or group_id in groups:
                        continue
                    groups[group_id] = self._normalize_group_item(item)
            except Exception as exc:
                logger.debug("[PermissionController] 获取群列表失败: %s", exc)
        if not live_loaded:
            for item in self._build_configured_groups(self._read_current_config()):
                groups.setdefault(item["group_id"], item)
        return self._sort_groups_by_recent_config(groups.values())

    async def list_private_contacts(self) -> list[dict[str, Any]]:
        """返回机器人已添加的 QQ 好友列表；实时列表不可用时才回退到配置好友。"""
        contacts: dict[str, dict[str, Any]] = {}
        live_loaded = False
        for client in self._iter_qq_clients():
            try:
                result = await self._call_client_action(client, "get_friend_list")
                live_loaded = True
                for item in self._extract_friend_list(result):
                    user_id = self._raw_friend_id(item)
                    if not user_id or user_id in contacts:
                        continue
                    contacts[user_id] = self._normalize_friend_item(item)
            except Exception as exc:
                logger.debug("[PermissionController] 获取好友列表失败: %s", exc)
        if not live_loaded:
            config = self._read_current_config()
            for user_id in _normalize_list(config.get("private_chat_users")):
                contacts.setdefault(user_id, self._build_friend_info(user_id, source="configured"))
            for user_id in _reasoning_map(config.get("reasoning_private_users")):
                contacts.setdefault(user_id, self._build_friend_info(user_id, source="configured"))
        return self._sort_private_contacts_by_recent_config(contacts.values())

    def get_group_config(self, group_id: str) -> dict[str, Any]:
        """把全局配置映射成单群配置页需要的数据。"""
        group_id = str(group_id or "").strip()
        if not group_id:
            raise ValueError("group_id must not be empty")
        config = self._read_current_config()
        users = []
        denied_users = []
        for rule in _normalize_list(config.get("simple_rules")):
            if "-" not in rule:
                continue
            user_id, target_group_id = rule.split("-", 1)
            if target_group_id.strip() == group_id and user_id.strip():
                users.append(user_id.strip())
        for rule in _normalize_list(config.get("group_deny_rules")):
            if "-" not in rule:
                continue
            user_id, target_group_id = rule.split("-", 1)
            if target_group_id.strip() == group_id and user_id.strip():
                denied_users.append(user_id.strip())
        group_reasoning = _reasoning_map(config.get("reasoning_group_defaults"))
        member_reasoning = []
        for target, effort in _reasoning_map(config.get("reasoning_group_user_rules")).items():
            if "-" not in target:
                continue
            user_id, target_group_id = target.split("-", 1)
            if target_group_id.strip() == group_id and user_id.strip():
                member_reasoning.append(f"{user_id.strip()}={effort}")
        return {
            "group_info": self._build_group_info(group_id),
            "config": {
                "group_enabled": group_id in set(_normalize_list(config.get("allowed_groups"))),
                "allowed_users": sorted(set(users)),
                "denied_users": sorted(set(denied_users)),
                "reasoning_effort": group_reasoning.get(group_id, ""),
                "reasoning_user_rules": sorted(set(member_reasoning)),
            },
        }

    def update_group_config(self, group_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """保存单群配置到 allowed_groups/simple_rules。"""
        group_id = str(group_id or "").strip()
        if not group_id:
            raise ValueError("group_id must not be empty")
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")

        config = self._read_current_config()
        allowed_groups = set(_normalize_list(config.get("allowed_groups")))
        group_reasoning = _reasoning_map(config.get("reasoning_group_defaults"))
        simple_rules = []
        deny_rules = []
        reasoning_user_rules = []
        for rule in _normalize_list(config.get("simple_rules")):
            if "-" not in rule:
                simple_rules.append(rule)
                continue
            user_id, target_group_id = rule.split("-", 1)
            if target_group_id.strip() != group_id:
                simple_rules.append(f"{user_id.strip()}-{target_group_id.strip()}")
        for rule in _normalize_list(config.get("group_deny_rules")):
            if "-" not in rule:
                deny_rules.append(rule)
                continue
            user_id, target_group_id = rule.split("-", 1)
            if target_group_id.strip() != group_id:
                deny_rules.append(f"{user_id.strip()}-{target_group_id.strip()}")
        for target, effort in _reasoning_map(config.get("reasoning_group_user_rules")).items():
            if "-" not in target:
                continue
            user_id, target_group_id = target.split("-", 1)
            if target_group_id.strip() != group_id:
                reasoning_user_rules.append(
                    f"{user_id.strip()}-{target_group_id.strip()}={effort}"
                )

        if _parse_bool(payload.get("group_enabled")):
            allowed_groups.add(group_id)
        else:
            allowed_groups.discard(group_id)

        for user_id in _normalize_list(payload.get("allowed_users")):
            if user_id.isdigit():
                simple_rules.append(f"{user_id}-{group_id}")
        for user_id in _normalize_list(payload.get("denied_users")):
            if user_id.isdigit():
                deny_rules.append(f"{user_id}-{group_id}")
        group_effort = _normalize_reasoning_effort(payload.get("reasoning_effort"))
        if group_effort:
            group_reasoning[group_id] = group_effort
        else:
            group_reasoning.pop(group_id, None)

        for item in _normalize_list(payload.get("reasoning_user_rules")):
            parsed = _split_reasoning_rule(item)
            if not parsed:
                continue
            user_id, effort = parsed
            if user_id.isdigit() and effort:
                reasoning_user_rules.append(f"{user_id}-{group_id}={effort}")

        self._write_config({
            "allowed_groups": sorted(allowed_groups),
            "simple_rules": sorted(set(simple_rules)),
            "group_deny_rules": sorted(set(deny_rules)),
            "reasoning_group_defaults": [
                f"{target}={effort}"
                for target, effort in sorted(group_reasoning.items())
            ],
            "reasoning_group_user_rules": sorted(set(reasoning_user_rules)),
        })
        self._touch_group_config(group_id)
        return self.get_group_config(group_id)

    def reset_group_config(self, group_id: str) -> dict[str, Any]:
        """清空单群放行和该群用户规则。"""
        return self.update_group_config(
            group_id,
            {
                "group_enabled": False,
                "allowed_users": [],
                "denied_users": [],
                "reasoning_effort": "",
                "reasoning_user_rules": [],
            },
        )

    def get_private_contact_config(self, user_id: str) -> dict[str, Any]:
        """返回单个私聊好友的权限配置。"""
        user_id = str(user_id or "").strip()
        if not user_id:
            raise ValueError("user_id must not be empty")
        config = self._read_current_config()
        enabled_users = set(_normalize_list(config.get("private_chat_users")))
        private_reasoning = _reasoning_map(config.get("reasoning_private_users"))
        return {
            "contact_info": self._build_friend_info(user_id),
            "config": {
                "private_enabled": user_id in enabled_users,
                "reasoning_effort": private_reasoning.get(user_id, ""),
            },
        }

    def update_private_contact_config(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """保存单个好友私聊权限到 private_chat_users。"""
        user_id = str(user_id or "").strip()
        if not user_id:
            raise ValueError("user_id must not be empty")
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        config = self._read_current_config()
        enabled_users = set(_normalize_list(config.get("private_chat_users")))
        private_reasoning = _reasoning_map(config.get("reasoning_private_users"))
        if _parse_bool(payload.get("private_enabled")):
            enabled_users.add(user_id)
        else:
            enabled_users.discard(user_id)
        effort = _normalize_reasoning_effort(payload.get("reasoning_effort"))
        if effort:
            private_reasoning[user_id] = effort
        else:
            private_reasoning.pop(user_id, None)
        self._write_config(
            {
                "private_chat_users": sorted(enabled_users),
                "reasoning_private_users": [
                    f"{target}={effort}"
                    for target, effort in sorted(private_reasoning.items())
                ],
            }
        )
        self._touch_private_config(user_id)
        return self.get_private_contact_config(user_id)

    def reset_private_contact_config(self, user_id: str) -> dict[str, Any]:
        """关闭单个好友私聊权限。"""
        return self.update_private_contact_config(
            user_id,
            {"private_enabled": False, "reasoning_effort": ""},
        )

    # ---------- 群列表辅助 ----------

    def _iter_platform_instances(self) -> list[Any]:
        try:
            manager = self.plugin.context.platform_manager
        except Exception:
            return []

        instances: list[Any] = []
        seen: set[int] = set()

        def append_many(value: Any) -> None:
            if value is None:
                return
            if isinstance(value, dict):
                iterable = value.values()
            elif isinstance(value, (list, tuple, set)):
                iterable = value
            else:
                iterable = (value,)
            for item in iterable:
                if item is None:
                    continue
                marker = id(item)
                if marker in seen:
                    continue
                seen.add(marker)
                instances.append(item)

        for attr in ("platform_insts", "platforms", "platform_instances", "instances"):
            try:
                append_many(getattr(manager, attr, None))
            except Exception:
                continue
        try:
            getter = getattr(manager, "get_insts", None)
            if callable(getter):
                append_many(getter())
        except Exception:
            pass
        return instances

    def _iter_qq_clients(self) -> list[Any]:
        clients: list[Any] = []
        seen: set[int] = set()

        def append(candidate: Any) -> None:
            if candidate is None or not self._can_call_action(candidate):
                return
            marker = id(candidate)
            if marker in seen:
                return
            seen.add(marker)
            clients.append(candidate)

        for inst in self._iter_platform_instances():
            try:
                getter = getattr(inst, "get_client", None)
                client = getter() if callable(getter) else None
            except Exception:
                client = None
            append(client)
            for attr in ("bot", "client", "api"):
                try:
                    append(getattr(inst, attr, None))
                except Exception:
                    continue
            append(inst)
        return clients

    @staticmethod
    def _can_call_action(candidate: Any) -> bool:
        if callable(getattr(candidate, "call_action", None)):
            return True
        api = getattr(candidate, "api", None)
        return callable(getattr(api, "call_action", None))

    @staticmethod
    async def _call_client_action(client: Any, action: str, **params: Any) -> Any:
        for target in (client, getattr(client, "api", None)):
            call_action = getattr(target, "call_action", None)
            if not callable(call_action):
                continue
            result = call_action(action, **params)
            if inspect.isawaitable(result):
                return await result
            return result
        raise RuntimeError("client does not support call_action")

    @staticmethod
    def _extract_group_list(result: Any) -> list[dict[str, Any]]:
        return PermissionPageService._extract_list_payload(
            result,
            ("data", "groups", "group_list", "groupList", "items", "list", "result"),
        )

    @staticmethod
    def _extract_friend_list(result: Any) -> list[dict[str, Any]]:
        return PermissionPageService._extract_list_payload(
            result,
            ("data", "friends", "friend_list", "friendList", "items", "list", "result"),
        )

    @staticmethod
    def _extract_list_payload(result: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
        if isinstance(result, list):
            return [item for item in result if isinstance(item, dict)]
        if isinstance(result, dict):
            for key in keys:
                value = result.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
                if isinstance(value, dict):
                    nested = PermissionPageService._extract_list_payload(value, keys)
                    if nested:
                        return nested
        return []

    @staticmethod
    def _first_present(item: dict[str, Any], *keys: str) -> Any:
        for key in keys:
            value = item.get(key)
            if value is not None and str(value).strip():
                return value
        return ""

    @staticmethod
    def _raw_group_id(item: dict[str, Any]) -> str:
        return str(
            PermissionPageService._first_present(
                item,
                "group_id",
                "groupId",
                "group_code",
                "groupCode",
                "id",
            )
        ).strip()

    @staticmethod
    def _raw_friend_id(item: dict[str, Any]) -> str:
        return str(
            PermissionPageService._first_present(item, "user_id", "userId", "uin", "id")
        ).strip()

    def _build_friend_info(self, user_id: str, source: str = "fallback") -> dict[str, Any]:
        user_id = str(user_id).strip()
        config = self._read_current_config()
        enabled_users = set(_normalize_list(config.get("private_chat_users")))
        private_reasoning = _reasoning_map(config.get("reasoning_private_users")).get(user_id, "")
        is_configured = user_id in enabled_users or bool(private_reasoning)
        return {
            "user_id": user_id,
            "nickname": f"好友 {user_id}",
            "remark": "",
            "avatar": f"https://q1.qlogo.cn/g?b=qq&nk={user_id}&s=640",
            "source": source,
            "config_updated_at": self._private_config_touch_times().get(user_id, 0),
            "private_enabled": user_id in enabled_users,
            "reasoning_effort": private_reasoning,
            "reasoning_label": _reasoning_label(private_reasoning),
            "is_configured": is_configured,
        }

    def _normalize_friend_item(self, item: dict[str, Any]) -> dict[str, Any]:
        user_id = self._raw_friend_id(item)
        normalized = self._build_friend_info(user_id, source="live")
        nickname = str(self._first_present(item, "nickname", "nick", "name")).strip()
        remark = str(item.get("remark", "")).strip()
        normalized.update({"nickname": remark or nickname or f"好友 {user_id}", "remark": remark})
        return normalized

    def _build_system_info(self) -> dict[str, str]:
        return {
            "platform": platform.system() or "Unknown",
            "platform_release": platform.release() or "",
            "python": platform.python_version() or sys.version.split()[0],
            "astrbot": _get_astrbot_version(),
        }

    def _build_configured_groups(self, config: dict[str, Any]) -> list[dict[str, Any]]:
        group_ids = set(_normalize_list(config.get("allowed_groups")))
        for key in ("simple_rules", "group_deny_rules"):
            for rule in _normalize_list(config.get(key)):
                if "-" not in rule:
                    continue
                _, group_id = rule.split("-", 1)
                group_id = group_id.strip()
                if group_id:
                    group_ids.add(group_id)
        group_ids.update(_reasoning_map(config.get("reasoning_group_defaults")).keys())
        for target in _reasoning_map(config.get("reasoning_group_user_rules")):
            if "-" not in target:
                continue
            _, group_id = target.split("-", 1)
            group_id = group_id.strip()
            if group_id:
                group_ids.add(group_id)
        return [self._build_group_info(group_id, source="configured") for group_id in sorted(group_ids)]

    def _build_group_info(self, group_id: str, source: str = "fallback") -> dict[str, Any]:
        group_id = str(group_id).strip()
        config = self._read_current_config()
        touched_at = self._group_config_touch_times().get(group_id, 0)
        group_reasoning = _reasoning_map(config.get("reasoning_group_defaults")).get(group_id, "")
        allowed_groups = set(_normalize_list(config.get("allowed_groups")))
        has_user_rule = any(
            rule.endswith(f"-{group_id}")
            for rule in _normalize_list(config.get("simple_rules"))
        )
        has_deny_rule = any(
            rule.endswith(f"-{group_id}")
            for rule in _normalize_list(config.get("group_deny_rules"))
        )
        has_member_reasoning = any(
            target.endswith(f"-{group_id}")
            for target in _reasoning_map(config.get("reasoning_group_user_rules"))
        )
        is_configured = (
            group_id in allowed_groups
            or has_user_rule
            or has_deny_rule
            or bool(group_reasoning)
            or has_member_reasoning
        )
        return {
            "group_id": group_id,
            "group_name": f"群 {group_id}",
            "avatar": f"https://p.qlogo.cn/gh/{group_id}/{group_id}/640",
            "member_count": 0,
            "max_member_count": 0,
            "source": source,
            "config_updated_at": touched_at,
            "group_enabled": group_id in allowed_groups,
            "reasoning_effort": group_reasoning,
            "reasoning_label": _reasoning_label(group_reasoning),
            "is_configured": is_configured,
        }

    def _normalize_group_item(self, item: dict[str, Any]) -> dict[str, Any]:
        group_id = self._raw_group_id(item)
        group_name = str(
            self._first_present(
                item,
                "group_name",
                "groupName",
                "group_remark",
                "name",
            )
        ).strip() or f"群 {group_id}"
        normalized = self._build_group_info(group_id, source="live")
        normalized.update(
            {
                "group_name": group_name,
                "member_count": self._safe_int(
                    self._first_present(
                        item,
                        "member_count",
                        "memberCount",
                        "member_num",
                        "memberNum",
                    ),
                    0,
                ),
                "max_member_count": self._safe_int(
                    self._first_present(
                        item,
                        "max_member_count",
                        "maxMemberCount",
                        "max_member_num",
                        "maxMemberNum",
                    ),
                    0,
                ),
                "config_updated_at": self._group_config_touch_times().get(group_id, 0),
            }
        )
        return normalized

    def _sort_groups_by_recent_config(self, group_list: Any) -> list[dict[str, Any]]:
        touch_times = self._group_config_touch_times()
        enriched = []
        for item in group_list:
            group = dict(item)
            group_id = str(group.get("group_id", "")).strip()
            group["config_updated_at"] = self._safe_int(
                touch_times.get(group_id),
                self._safe_int(group.get("config_updated_at"), 0),
            )
            enriched.append(group)
        return sorted(
            enriched,
            key=lambda item: (
                -self._safe_int(item.get("config_updated_at"), 0),
                -int(bool(item.get("is_configured"))),
                str(item.get("group_name") or item.get("group_id") or ""),
            ),
        )

    def _sort_private_contacts_by_recent_config(self, contact_list: Any) -> list[dict[str, Any]]:
        touch_times = self._private_config_touch_times()
        enriched = []
        for item in contact_list:
            contact = dict(item)
            user_id = str(contact.get("user_id", "")).strip()
            contact["config_updated_at"] = self._safe_int(
                touch_times.get(user_id),
                self._safe_int(contact.get("config_updated_at"), 0),
            )
            enriched.append(contact)
        return sorted(
            enriched,
            key=lambda item: (
                -self._safe_int(item.get("config_updated_at"), 0),
                -int(bool(item.get("is_configured"))),
                str(item.get("nickname") or item.get("remark") or item.get("user_id") or ""),
            ),
        )

    def _group_config_touch_times(self) -> dict[str, int]:
        try:
            data = json.loads(GROUP_TOUCH_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            str(group_id): self._safe_int(timestamp, 0)
            for group_id, timestamp in data.items()
            if str(group_id).strip()
        }

    def _touch_group_config(self, group_id: str) -> None:
        group_id = str(group_id or "").strip()
        if not group_id:
            return
        touch_times = self._group_config_touch_times()
        touch_times[group_id] = int(time.time() * 1000)
        try:
            GROUP_TOUCH_FILE.parent.mkdir(parents=True, exist_ok=True)
            GROUP_TOUCH_FILE.write_text(
                json.dumps(touch_times, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("[PermissionController] 记录群配置更新时间失败: %s", exc)

    def _private_config_touch_times(self) -> dict[str, int]:
        try:
            data = json.loads(PRIVATE_TOUCH_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            str(user_id): self._safe_int(timestamp, 0)
            for user_id, timestamp in data.items()
            if str(user_id).strip()
        }

    def _touch_private_config(self, user_id: str) -> None:
        user_id = str(user_id or "").strip()
        if not user_id:
            return
        touch_times = self._private_config_touch_times()
        touch_times[user_id] = int(time.time() * 1000)
        try:
            PRIVATE_TOUCH_FILE.parent.mkdir(parents=True, exist_ok=True)
            PRIVATE_TOUCH_FILE.write_text(
                json.dumps(touch_times, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("[PermissionController] 记录私聊配置更新时间失败: %s", exc)

    @staticmethod
    def _safe_int(value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    # ---------- 配置读写 ----------

    def _read_current_config(self) -> dict[str, Any]:
        """读取当前全部字段的值（扁平 key->value）。"""
        result: dict[str, Any] = {}
        for key, field in self._flatten_schema_items().items():
            value = self._cfg_get(key, field.get("default"))
            if field.get("type") == "list":
                value = _normalize_list(value)
            elif field.get("type") == "bool":
                parsed = _parse_bool(value)
                value = field.get("default", False) if parsed is None else parsed
            elif field.get("type") == "select":
                value = _normalize_reasoning_effort(value)
            elif key == "reasoning_default_effort":
                value = _normalize_reasoning_effort(value)
            result[key] = value
        return result

    def _cfg_get(self, key: str, default: Any = None) -> Any:
        """复用插件的兼容读取逻辑（支持分组嵌套）。"""
        getter = getattr(self.plugin, "_cfg_get", None)
        if callable(getter):
            try:
                return getter(key, default)
            except Exception:
                pass
        config = getattr(self.plugin, "config", {})
        try:
            if hasattr(config, "get"):
                value = config.get(key, None)
                if value is not None:
                    return value
                group = self._group_for_key(key)
                if group:
                    sub = config.get(group, None)
                    if isinstance(sub, dict) and key in sub:
                        return sub.get(key, default)
        except Exception:
            pass
        return default

    def _write_config(self, sanitized: dict[str, Any]) -> None:
        """把清洗后的值写回 AstrBotConfig，并持久化 + 刷新运行时缓存。"""
        config = getattr(self.plugin, "config", None)
        if config is None:
            raise RuntimeError("plugin config is unavailable")

        for key, value in sanitized.items():
            group = self._group_for_key(key)
            self._set_in_config(config, group, key, value)

        # 持久化
        save = getattr(config, "save_config", None)
        if callable(save):
            save()
        else:
            logger.warning("[PermissionController] config 不支持 save_config，跳过持久化")

        # 通知插件重载运行时缓存
        reload_fn = getattr(self.plugin, "reload_runtime_config", None)
        if callable(reload_fn):
            try:
                reload_fn()
            except Exception as exc:
                logger.warning("[PermissionController] 运行时配置重载失败: %s", exc)

    @staticmethod
    def _set_in_config(config: Any, group: str | None, key: str, value: Any) -> None:
        """优先写入分组（新版结构），否则写入顶层（兼容旧版平铺）。"""
        try:
            if group is not None and hasattr(config, "get"):
                sub = config.get(group, None)
                if sub is None:
                    sub = {}
                if isinstance(sub, dict):
                    sub[key] = value
                    config[group] = sub
                    return
        except Exception:
            pass
        try:
            config[key] = value
        except Exception:
            if hasattr(config, "__setitem__"):
                config[key] = value

    # ---------- schema 处理 ----------

    @staticmethod
    def _load_schema(schema_path: Path) -> dict[str, Any]:
        try:
            return json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("[PermissionController] 加载 schema 失败: %s", exc)
            return {}

    def _flatten_schema_items(self) -> dict[str, Any]:
        """把两层 schema 摊平成 key->field_schema。"""
        flat: dict[str, Any] = {}
        for group_def in self.schema.values():
            items = (group_def or {}).get("items", {})
            if isinstance(items, dict):
                for key, field in items.items():
                    flat[key] = field
        return flat

    def _group_for_key(self, key: str) -> str | None:
        """找出某字段属于哪个顶层分组。"""
        for group_name, group_def in self.schema.items():
            items = (group_def or {}).get("items", {})
            if isinstance(items, dict) and key in items:
                return group_name
        return None

