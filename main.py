"""AstrBot 权限控制器插件。

本插件负责在 AstrBot 消息事件进入模型或其他插件前，按私聊白名单、
群聊整体放行列表、用户-群号组合规则和群聊黑名单进行权限拦截。
代码中的注释重点说明拦截顺序、兼容逻辑和对 AstrBot 运行时配置的最小改动。
"""

import json
import functools
import importlib
import inspect
import logging
from pathlib import Path
from sys import maxsize

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.handoff import FunctionTool, HandoffTool
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.platform.message_type import MessageType
from astrbot.core.provider.register import llm_tools
from astrbot.core.star.star import star_map, star_registry
from astrbot.core.star.star_handler import star_handlers_registry

try:
    from .web import PermissionWebController
except Exception:  # pragma: no cover - web 模块缺失时不影响核心功能
    PermissionWebController = None

REASONING_EVENT_EXTRA_KEY = "_permission_controller_reasoning_extra_body"
REASONING_EVENT_LEVEL_KEY = "_permission_controller_reasoning_level"
REASONING_PROVIDER_META_KEY = "_permission_controller_reasoning_runtime_meta"
REASONING_LOGGED_EVENT_KEY = "_permission_controller_reasoning_logged"
REASONING_PAYLOAD_PATCH_VERSION = "20260622_custom_extra_body_v12_no_ultra"
FUSION_RUNTIME_ACCESS_PATH = "fusion_access.enabled"
FUSION_RUNTIME_ACCESS_LEGACY_PATHS = {
    "groups": "fusion_access.enable_groups",
    "privates": "fusion_access.enable_privates",
}
FUSION_RUNTIME_ACCESS_MODULES = {
    "raw-image": "providers",
    "aip-review": "global-policy",
    "webshot": "targets",
    "qqadmin": "actions",
}
FUSION_RUNTIME_ACCESS_EXTRA_PATHS = {
    "qqadmin": {"groups": "default.group_admin_enabled"},
}

BUNDLED_PLUGIN_SPECS = (
    {
        "id": "raw-image",
        "directory": "astrbot_plugin_general_raw_image_2026",
        "module": "main",
        "class_name": "ImageGenerationPlugin",
        "title": "通用生图",
        "display_name": "通用生图 General Raw Image 2026",
        "author": "xiaokangzaina",
        "version": "v1.2.8",
    },
    {
        "id": "aip-review",
        "directory": "astrbot_plugin_group_aip_review",
        "module": "main",
        "class_name": "GroupAipReviewPlugin",
        "title": "安全审核",
        "display_name": "群消息内容安全审核插件",
        "author": "xiaokangzaina",
        "version": "v1.5.1",
    },
    {
        "id": "qqadmin",
        "directory": "astrbot_plugin_qqadmin",
        "module": "main",
        "class_name": "QQAdminPlugin",
        "title": "QQ群管",
        "display_name": "QQ群管",
        "author": "xiaokangzaina",
        "version": "v3.3.8",
    },
    {
        "id": "webshot",
        "directory": "astrbot_plugin_webpage_screenshot",
        "module": "main",
        "class_name": "WebpageScreenshot",
        "title": "网页截图",
        "display_name": "网页实时获取截图",
        "author": "xiaokangzaina",
        "version": "v1.3.1",
    },
)

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


class _AstrBotAfterMessageSentLogFilter(logging.Filter):
    """屏蔽权限控制器场景下的 after_message_sent 终止传播冗余日志。"""

    TARGET_TEXTS = (
        "astrbot - after_message_sent 终止了事件传播。",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            if any(text in message for text in self.TARGET_TEXTS):
                return False
            return True
        except Exception:
            return True



@register(
    "astrbot_plugin_permission_controller",
    "local",
    "权限控制台：统一管理权限控制、融合模块、背景音乐和按钮音效",
    "3.0.4",
)
class GroupUserWhitelistPlugin(Star):
    """AstrBot 权限控制器主类。

    拦截策略：
    1. 群聊先检查黑名单，再检查管理员、群整体放行和用户-群号组合。
    2. 私聊只允许配置在 private_chat_users 中的普通用户；管理员可按配置绕过。
    3. allowed_groups 会同步到 AstrBot 平台白名单，避免核心层提前拦截群消息。
    """

    _after_message_sent_log_filter_installed = False
    _after_message_sent_log_filter = _AstrBotAfterMessageSentLogFilter()
    _admin_wake_bypass_patch_installed = False
    _whitelist_stage_patch_installed = False
    _reasoning_payload_patch_installed = False

    def __init__(self, context: Context, config=None):
        """初始化插件配置、规则缓存和运行时兼容补丁。"""
        super().__init__(context)
        self.context = context
        self.config = config or {}
        self.rules = self._load_rules("simple_rules")
        self.deny_rules = self._load_rules("group_deny_rules")
        self.admin_bypass = self._get_bool_config("admin_bypass", True)
        self.admin_wake_bypass = self._get_bool_config("admin_wake_bypass", False)
        self.enable_group_rules = self._get_bool_config("enable_group_rules", True)
        self.enable_group_blacklist = self._get_bool_config(
            "enable_group_blacklist", True
        )
        self.admin_ids = self._load_admin_ids()
        self.group_blacklist = self._normalize_ids(self._cfg_get("group_blacklist", []))
        self.private_chat_users = self._normalize_ids(
            self._cfg_get("private_chat_users", [])
        )
        self.allowed_groups = self._normalize_ids(self._cfg_get("allowed_groups", []))
        self.reasoning_default_effort = self._normalize_reasoning_effort(
            self._cfg_get("reasoning_default_effort", "")
        )
        self.reasoning_group_defaults = self._load_reasoning_rules(
            "reasoning_group_defaults"
        )
        self.reasoning_group_user_rules = self._load_reasoning_rules(
            "reasoning_group_user_rules"
        )
        self.reasoning_private_users = self._load_reasoning_rules(
            "reasoning_private_users"
        )
        self._sync_plugin_allowlist_to_platform_whitelist()
        self._install_after_message_sent_log_filter()
        self._install_admin_wake_bypass_patch()
        self._install_private_whitelist_stage_patch()
        self._install_reasoning_payload_patch()
        logger.info(
            "[PermissionController] 已加载：群聊规则=%s，群整体放行=%s，用户群号规则=%s，私聊白名单=%s，群聊黑名单=%s，管理员绕过=%s",
            self.enable_group_rules,
            sorted(self.allowed_groups),
            self.rules,
            sorted(self.private_chat_users),
            sorted(self.group_blacklist),
            self.admin_bypass,
        )

        self._register_web_page()
        self._bundled_plugin_instances = []
        self._bundled_plugin_errors = {}
        self._bundled_plugins_initialized = False
        self._load_bundled_plugins()


    def _register_web_page(self):
        """注册可视化配置页（Web 前端）。失败不影响核心拦截功能。"""
        if PermissionWebController is None:
            return
        try:
            self.web = PermissionWebController(self.context, self)
            self.web.register_routes()
            logger.info("[PermissionController] 配置页 Web API 已注册")
        except Exception as exc:
            logger.warning("[PermissionController] 配置页注册失败: %s", exc)

    @classmethod
    def _bundled_base_package(cls) -> str:
        return f"{__package__}.bundled_plugins"

    @classmethod
    def _bundled_module_name(cls, spec: dict) -> str:
        return (
            f"{cls._bundled_base_package()}.{spec['directory']}.{spec['module']}"
        )

    @classmethod
    def _is_bundled_module_path(cls, module_path: str | None) -> bool:
        if not module_path:
            return False
        base = cls._bundled_base_package()
        return module_path == base or module_path.startswith(f"{base}.")

    @staticmethod
    def _callable_module_path(value) -> str:
        handler = getattr(value, "func", value)
        return str(getattr(handler, "__module__", "") or "")

    def _plugin_data_dir(self) -> Path:
        return Path(__file__).resolve().parents[2]

    def _bundled_plugin_dir(self, directory: str) -> Path:
        return Path(__file__).resolve().parent / "bundled_plugins" / directory

    def _bundled_config_path(self, directory: str) -> Path:
        return self._plugin_data_dir() / "config" / f"{directory}_config.json"

    def _load_bundled_config(self, directory: str):
        plugin_dir = self._bundled_plugin_dir(directory)
        schema_path = plugin_dir / "_conf_schema.json"
        if not schema_path.exists():
            return {}
        schema = json.loads(schema_path.read_text(encoding="utf-8-sig") or "{}")
        return AstrBotConfig(
            config_path=str(self._bundled_config_path(directory)),
            schema=schema,
        )

    def _remove_bundled_runtime_state(self) -> None:
        for handler in list(star_handlers_registry):
            if self._is_bundled_module_path(handler.handler_module_path):
                star_handlers_registry.remove(handler)

        for key in list(star_handlers_registry.star_handlers_map):
            if self._is_bundled_module_path(key):
                star_handlers_registry.star_handlers_map.pop(key, None)

        for module_path, metadata in list(star_map.items()):
            if self._is_bundled_module_path(module_path):
                star_map.pop(module_path, None)
                if metadata in star_registry:
                    star_registry.remove(metadata)

        for metadata in list(star_registry):
            if self._is_bundled_module_path(metadata.module_path):
                star_registry.remove(metadata)

        for func_tool in list(llm_tools.func_list):
            handler_module_path = str(getattr(func_tool, "handler_module_path", "") or "")
            handler_path = self._callable_module_path(getattr(func_tool, "handler", None))
            if self._is_bundled_module_path(handler_module_path) or self._is_bundled_module_path(handler_path):
                llm_tools.func_list.remove(func_tool)

    def _apply_bundled_metadata(self, spec: dict, module, plugin_cls, plugin_config) -> None:
        module_name = module.__name__
        metadata = star_map.get(module_name)
        if metadata is None:
            return

        directory = str(spec["directory"])
        metadata.name = directory
        metadata.display_name = str(spec["display_name"])
        metadata.author = str(spec["author"])
        metadata.desc = f"已融合进 astrbot_plugin_permission_controller 的 {spec['title']} 模块"
        metadata.version = str(spec["version"])
        metadata.module_path = module_name
        metadata.star_cls_type = plugin_cls
        metadata.config = plugin_config
        metadata.module = module
        metadata.root_dir_name = "astrbot_plugin_permission_controller"
        metadata.activated = True
        metadata.reserved = False

        setattr(plugin_cls, "name", directory)
        setattr(plugin_cls, "author", str(spec["author"]))
        setattr(plugin_cls, "plugin_id", f"{spec['author']}/{directory}")

    def _hide_bundled_metadata_from_plugin_list(self, module_name: str) -> None:
        metadata = star_map.get(module_name)
        if metadata in star_registry:
            star_registry.remove(metadata)

    def _fusion_overrides_path(self) -> Path:
        return Path(__file__).resolve().parent / "data" / "fusion_overrides.json"

    def _read_fusion_runtime_overrides(self) -> dict:
        try:
            payload = json.loads(self._fusion_overrides_path().read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _bundled_plugin_id_from_module(self, module_name: str) -> str:
        for spec in BUNDLED_PLUGIN_SPECS:
            current = self._bundled_module_name(spec)
            if module_name == current or module_name.startswith(f"{current}."):
                return str(spec["id"])
        return ""

    @staticmethod
    def _module_in_bundled_package(module_path: str, module_name: str) -> bool:
        package_name = module_name.rsplit(".", 1)[0]
        return module_path == module_name or module_path.startswith(f"{package_name}.")

    @staticmethod
    def _event_from_call_args(*args, **kwargs):
        for value in list(args) + list(kwargs.values()):
            if value is None:
                continue
            if hasattr(value, "get_group_id") or hasattr(value, "is_private_chat"):
                return value
            wrapped = getattr(value, "context", None)
            event = getattr(wrapped, "event", None) or getattr(value, "event", None)
            if event is not None:
                return event
            if isinstance(value, dict) and value.get("event") is not None:
                return value.get("event")
        return None

    @classmethod
    def _fusion_event_target(cls, event) -> tuple[str, str] | None:
        if event is None:
            return None
        try:
            if event.is_private_chat():
                candidates = sorted(cls._private_sender_candidates_from_event(event))
                return ("privates", candidates[0]) if candidates else None
        except Exception:
            pass

        try:
            group_id = str(event.get_group_id() or "").strip()
            if group_id:
                return "groups", group_id
        except Exception:
            pass
        return None

    @staticmethod
    def _fusion_module_values(state: dict, plugin_id: str, target_type: str, target_id: str, module_id: str) -> dict:
        try:
            values = (
                state.get("plugins", {})
                .get(plugin_id, {})
                .get(target_type, {})
                .get(target_id, {})
                .get("modules", {})
                .get(module_id, {})
                .get("values", {})
            )
            return values if isinstance(values, dict) else {}
        except Exception:
            return {}

    def _fusion_access_value(self, state: dict, plugin_id: str, target_type: str, target_id: str) -> bool:
        module_id = FUSION_RUNTIME_ACCESS_MODULES.get(plugin_id)
        if not module_id:
            return True

        candidate_paths = [
            FUSION_RUNTIME_ACCESS_PATH,
            FUSION_RUNTIME_ACCESS_LEGACY_PATHS.get(target_type, ""),
            FUSION_RUNTIME_ACCESS_EXTRA_PATHS.get(plugin_id, {}).get(target_type, ""),
        ]
        for scope_type, scope_id in ((target_type, target_id), ("global", "default")):
            values = self._fusion_module_values(state, plugin_id, scope_type, scope_id, module_id)
            for path in candidate_paths:
                if path and path in values:
                    return bool(values[path])
        return True

    def _fusion_event_enabled(self, plugin_id: str, event) -> bool:
        target = self._fusion_event_target(event)
        if not plugin_id or target is None:
            return True
        target_type, target_id = target
        enabled = self._fusion_access_value(
            self._read_fusion_runtime_overrides(),
            plugin_id,
            target_type,
            target_id,
        )
        if not enabled:
            logger.debug(
                "[PermissionController] 融合模块已按对象关闭：plugin=%s target=%s:%s",
                plugin_id,
                target_type,
                target_id,
            )
        return enabled

    def _wrap_bundled_callable(self, plugin_id: str, callback, disabled_result=None):
        if getattr(callback, "_permission_controller_fusion_wrapped", False):
            return callback

        wrapped_target = getattr(callback, "func", callback)
        is_async_callback = inspect.iscoroutinefunction(callback) or inspect.iscoroutinefunction(wrapped_target)

        if is_async_callback:
            @functools.wraps(wrapped_target)
            async def wrapped(*args, **kwargs):
                event = self._event_from_call_args(*args, **kwargs)
                if not self._fusion_event_enabled(plugin_id, event):
                    return disabled_result
                result = callback(*args, **kwargs)
                if inspect.isawaitable(result):
                    return await result
                return result
        else:
            @functools.wraps(wrapped_target)
            def wrapped(*args, **kwargs):
                event = self._event_from_call_args(*args, **kwargs)
                if not self._fusion_event_enabled(plugin_id, event):
                    return disabled_result
                return callback(*args, **kwargs)

        setattr(wrapped, "_permission_controller_fusion_wrapped", True)
        return wrapped

    def _bind_bundled_handlers(self, module_name: str, instance) -> list[str]:
        plugin_id = self._bundled_plugin_id_from_module(module_name)
        full_names = []
        for handler in star_handlers_registry.get_handlers_by_module_name(module_name):
            bound_handler = functools.partial(handler.handler, instance)
            handler.handler = self._wrap_bundled_callable(plugin_id, bound_handler)
            full_names.append(handler.handler_full_name)

        for func_tool in list(llm_tools.func_list):
            need_apply = []
            if isinstance(func_tool, HandoffTool):
                sub_tools = getattr(getattr(func_tool, "agent", None), "tools", None)
                if sub_tools:
                    need_apply.extend(
                        sub_tool
                        for sub_tool in sub_tools
                        if isinstance(sub_tool, FunctionTool)
                    )
            else:
                need_apply.append(func_tool)

            for tool in need_apply:
                handler = getattr(tool, "handler", None)
                if handler and getattr(handler, "__module__", None) == module_name:
                    tool.handler_module_path = module_name
                    bound_tool_handler = functools.partial(handler, instance)
                    tool.handler = self._wrap_bundled_callable(
                        plugin_id,
                        bound_tool_handler,
                        "当前对象已关闭该插件，未执行工具调用。",
                    )
                    continue

                call_method = getattr(tool, "call", None)
                tool_module = str(getattr(type(tool), "__module__", "") or "")
                if callable(call_method) and self._module_in_bundled_package(tool_module, module_name):
                    try:
                        tool.call = self._wrap_bundled_callable(
                            plugin_id,
                            call_method,
                            "当前对象已关闭该插件，未执行工具调用。",
                        )
                    except Exception as exc:
                        logger.debug("[PermissionController] 包装融合工具失败: %s", exc)
        return full_names

    def _load_bundled_plugins(self) -> None:
        self._remove_bundled_runtime_state()
        for spec in BUNDLED_PLUGIN_SPECS:
            directory = str(spec["directory"])
            module_name = self._bundled_module_name(spec)
            try:
                module = importlib.import_module(module_name)
                module = importlib.reload(module)
                plugin_cls = getattr(module, str(spec["class_name"]))
                plugin_config = self._load_bundled_config(directory)
                self._apply_bundled_metadata(spec, module, plugin_cls, plugin_config)
                try:
                    instance = plugin_cls(context=self.context, config=plugin_config)
                except TypeError:
                    instance = plugin_cls(context=self.context)
                metadata = star_map.get(module_name)
                if metadata is not None:
                    metadata.star_cls = instance
                    metadata.star_handler_full_names = self._bind_bundled_handlers(
                        module_name,
                        instance,
                    )
                self._hide_bundled_metadata_from_plugin_list(module_name)
                self._bundled_plugin_instances.append(
                    {"spec": spec, "module": module, "instance": instance}
                )
                logger.info("[PermissionController] 已融合子插件：%s", directory)
            except Exception as exc:
                self._bundled_plugin_errors[directory] = str(exc)
                logger.exception("[PermissionController] 融合子插件失败：%s", directory)

    def get_bundled_plugin_status(self) -> list[dict[str, object]]:
        loaded = {
            str(entry["spec"]["directory"]): entry
            for entry in self._bundled_plugin_instances
        }
        result = []
        for spec in BUNDLED_PLUGIN_SPECS:
            directory = str(spec["directory"])
            entry = loaded.get(directory)
            result.append(
                {
                    "id": spec["id"],
                    "directory": directory,
                    "title": spec["title"],
                    "display_name": spec["display_name"],
                    "version": spec["version"],
                    "loaded": entry is not None,
                    "initialized": bool(
                        entry and getattr(entry.get("instance"), "_fusion_initialized", False)
                    ),
                    "error": self._bundled_plugin_errors.get(directory, ""),
                    "api_base": f"/{directory}",
                    "bundled_page": (
                        f"../../bundled_plugins/{directory}/pages/settings/index.html"
                    ),
                    "config_path": str(self._bundled_config_path(directory)),
                }
            )
        return result

    async def initialize(self):
        if self._bundled_plugins_initialized:
            return
        self._bundled_plugins_initialized = True
        for entry in self._bundled_plugin_instances:
            spec = entry["spec"]
            instance = entry["instance"]
            initialize = getattr(instance, "initialize", None)
            if not callable(initialize):
                continue
            try:
                result = initialize()
                if inspect.isawaitable(result):
                    await result
                module_name = self._bundled_module_name(spec)
                metadata = star_map.get(module_name)
                rebound_handlers = self._bind_bundled_handlers(module_name, instance)
                if metadata is not None and rebound_handlers:
                    metadata.star_handler_full_names = rebound_handlers
                setattr(instance, "_fusion_initialized", True)
                logger.info("[PermissionController] 子插件已初始化：%s", spec["directory"])
            except Exception as exc:
                self._bundled_plugin_errors[str(spec["directory"])] = str(exc)
                logger.exception(
                    "[PermissionController] 子插件初始化失败：%s",
                    spec["directory"],
                )

    async def terminate(self):
        for entry in reversed(self._bundled_plugin_instances):
            spec = entry["spec"]
            instance = entry["instance"]
            terminate = getattr(instance, "terminate", None)
            if not callable(terminate):
                continue
            try:
                result = terminate()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.exception(
                    "[PermissionController] 子插件卸载失败：%s",
                    spec["directory"],
                )
        self._remove_bundled_runtime_state()

    def reload_runtime_config(self):
        """供配置页保存后调用：重新读取配置并刷新运行时缓存。"""
        self.rules = self._load_rules("simple_rules")
        self.deny_rules = self._load_rules("group_deny_rules")
        self.admin_bypass = self._get_bool_config("admin_bypass", True)
        self.admin_wake_bypass = self._get_bool_config("admin_wake_bypass", False)
        self.enable_group_rules = self._get_bool_config("enable_group_rules", True)
        self.enable_group_blacklist = self._get_bool_config(
            "enable_group_blacklist", True
        )
        self.group_blacklist = self._normalize_ids(self._cfg_get("group_blacklist", []))
        self.private_chat_users = self._normalize_ids(
            self._cfg_get("private_chat_users", [])
        )
        self.allowed_groups = self._normalize_ids(self._cfg_get("allowed_groups", []))
        self.reasoning_default_effort = self._normalize_reasoning_effort(
            self._cfg_get("reasoning_default_effort", "")
        )
        self.reasoning_group_defaults = self._load_reasoning_rules(
            "reasoning_group_defaults"
        )
        self.reasoning_group_user_rules = self._load_reasoning_rules(
            "reasoning_group_user_rules"
        )
        self.reasoning_private_users = self._load_reasoning_rules(
            "reasoning_private_users"
        )
        try:
            self._sync_plugin_allowlist_to_platform_whitelist()
        except Exception as exc:
            logger.warning("[PermissionController] 同步平台白名单失败: %s", exc)
        logger.info("[PermissionController] 运行时配置已重载")

    @classmethod
    def _install_after_message_sent_log_filter(cls):
        """安装精确日志过滤器，只屏蔽 after_message_sent 终止传播日志。"""
        if cls._after_message_sent_log_filter_installed:
            return
        target_loggers = [
            logging.getLogger(),
            logging.getLogger("astrbot"),
            logging.getLogger("Core"),
            logging.getLogger("core"),
            logging.getLogger("astrbot.core"),
            logging.getLogger("astrbot.core.event_bus"),
            logging.getLogger("core.event_bus"),
            logging.getLogger("event_bus"),
            logging.getLogger("astrbot.core.pipeline.respond.stage"),
            logging.getLogger("astrbot.core.pipeline.context_utils"),
        ]
        for lg in target_loggers:
            try:
                lg.addFilter(cls._after_message_sent_log_filter)
                for handler in getattr(lg, "handlers", []) or []:
                    handler.addFilter(cls._after_message_sent_log_filter)
            except Exception:
                pass
        cls._after_message_sent_log_filter_installed = True

    _PRIVATE_CONFIG_KEYS = {"private_chat_users", "admin_bypass", "admin_wake_bypass"}
    _GROUP_CONFIG_KEYS = {
        "enable_group_rules",
        "simple_rules",
        "group_deny_rules",
        "allowed_groups",
        "enable_group_blacklist",
        "group_blacklist",
    }
    _REASONING_CONFIG_KEYS = {
        "reasoning_default_effort",
        "reasoning_group_defaults",
        "reasoning_group_user_rules",
        "reasoning_private_users",
    }

    @classmethod
    def _config_group_for_key(cls, key: str) -> str | None:
        if key in cls._PRIVATE_CONFIG_KEYS:
            return "private_chat_settings"
        if key in cls._GROUP_CONFIG_KEYS:
            return "group_chat_settings"
        if key in cls._REASONING_CONFIG_KEYS:
            return "reasoning_settings"
        return None

    @classmethod
    def _dict_cfg_get(cls, data: dict, key: str, default=None):
        if not isinstance(data, dict):
            return default
        if key in data:
            return data.get(key, default)
        group_name = cls._config_group_for_key(key)
        group = data.get(group_name, {}) if group_name else {}
        if isinstance(group, dict) and key in group:
            return group.get(key, default)
        return default

    def _cfg_get(self, key, default=None):
        """安全读取配置，兼容旧版平铺配置和新版分组配置。"""
        try:
            if hasattr(self.config, "get"):
                value = self.config.get(key, None)
                if value is not None:
                    return value
                group_name = self._config_group_for_key(key)
                if group_name:
                    group = self.config.get(group_name, {})
                    if isinstance(group, dict) and key in group:
                        return group.get(key, default)
        except Exception:
            pass
        if isinstance(self.config, dict):
            return self._dict_cfg_get(self.config, key, default)
        return default

    def _get_bool_config(self, key, default=False):
        """兼容布尔值和中文/英文字符串形式的开关配置。"""
        value = self._cfg_get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in (
                "1",
                "true",
                "yes",
                "on",
                "开启",
                "开",
                "启用",
            )
        return bool(value)

    @classmethod
    def _load_runtime_private_chat_users(cls) -> set[str]:
        """运行时读取私聊白名单，供核心白名单阶段补丁使用。"""
        try:
            cfg_path = (
                Path(__file__).resolve().parents[2]
                / "config"
                / "astrbot_plugin_permission_controller_config.json"
            )
            if not cfg_path.exists():
                return set()
            data = json.loads(cfg_path.read_text(encoding="utf-8-sig") or "{}")
            users = cls._dict_cfg_get(data, "private_chat_users", [])
            if isinstance(users, (str, int)):
                users = [users]
            if not isinstance(users, list):
                return set()
            return {str(item).strip() for item in users if str(item).strip()}
        except Exception as exc:
            logger.debug(f"读取私聊白名单运行时配置失败: {exc}")
            return set()

    @classmethod
    def _install_private_whitelist_stage_patch(cls):
        """让核心 WhitelistCheckStage 识别本插件私聊白名单。

        AstrBot 的 WhitelistCheckStage 早于插件 handler 执行，并且只检查
        unified_msg_origin/群号；当平台白名单启用时，仅填写 QQ 号或在
        本插件 private_chat_users 中填写用户，都可能被核心阶段提前拦截。
        这里在私聊消息下收集 sender/session/UMO 分段候选 ID，命中本插件
        private_chat_users 时直接放行核心白名单阶段。
        """
        try:
            from astrbot.core.pipeline.whitelist_check.stage import WhitelistCheckStage
        except Exception as exc:
            logger.debug(f"安装私聊白名单核心阶段补丁失败: {exc}")
            return

        if getattr(
            WhitelistCheckStage, "_permission_controller_patch_installed", False
        ):
            return

        original_process = WhitelistCheckStage.process
        WhitelistCheckStage._permission_controller_original_process = original_process

        async def patched_process(stage_self, event):
            try:
                if event.get_message_type() == MessageType.FRIEND_MESSAGE:
                    users = cls._load_runtime_private_chat_users()
                    if (
                        users
                        and cls._private_sender_candidates_from_event(event) & users
                    ):
                        return
            except Exception as exc:
                logger.debug(f"私聊白名单核心阶段补丁判断失败: {exc}")
            result = original_process(stage_self, event)
            return await result

        WhitelistCheckStage.process = patched_process
        WhitelistCheckStage._permission_controller_patch_installed = True

    @staticmethod
    def _private_sender_candidates_from_event(event: AstrMessageEvent) -> set[str]:
        """从事件对象提取私聊用户候选 ID，供插件逻辑和核心阶段补丁复用。"""
        candidates = set()
        for getter_name in ("get_sender_id", "get_session_id"):
            try:
                getter = getattr(event, getter_name, None)
                if callable(getter):
                    value = getter()
                    if value is not None and str(value).strip():
                        candidates.add(str(value).strip())
            except Exception:
                pass

        for attr_path in (
            ("message_obj", "sender", "user_id"),
            ("message_obj", "session_id"),
            ("session", "session_id"),
        ):
            try:
                obj = event
                for attr in attr_path:
                    obj = getattr(obj, attr)
                if obj is not None and str(obj).strip():
                    candidates.add(str(obj).strip())
            except Exception:
                pass

        try:
            umo = str(event.unified_msg_origin or "").strip()
            if umo:
                candidates.add(umo)
                for sep in (":", "!"):
                    if sep in umo:
                        for part in umo.split(sep):
                            part = part.strip()
                            if part:
                                candidates.add(part)
        except Exception:
            pass
        return {x for x in candidates if x}

    @classmethod
    def _install_admin_wake_bypass_patch(cls):
        """按配置让 AstrBot 管理员绕过唤醒词。

        AstrBot 的唤醒词检查发生在普通插件 handler 之前，因此这里对
        WakingCheckStage.process 做最小猴补丁。补丁会在每条消息到来时实时读取
        插件配置；只有 admin_wake_bypass=true 时才给管理员临时追加内部唤醒前缀。
        关闭配置后，新消息不会再绕过唤醒词。
        """
        try:
            from astrbot.core.pipeline.waking_check.stage import WakingCheckStage
        except Exception as exc:
            logger.debug(f"安装管理员绕过唤醒词补丁失败: {exc}")
            return

        internal_prefix = "__admin_wake_bypass__ "

        def _runtime_enabled() -> bool:
            """运行时读取开关，确保后台改配置后无需重启即可生效。"""
            try:
                cfg_path = (
                    Path(__file__).resolve().parents[2]
                    / "config"
                    / "astrbot_plugin_permission_controller_config.json"
                )
                if cfg_path.exists():
                    raw = cfg_path.read_text(encoding="utf-8-sig")
                    data = json.loads(raw) if raw.strip() else {}
                    value = cls._dict_cfg_get(data, "admin_wake_bypass", False)
                    if isinstance(value, bool):
                        return value
                    if isinstance(value, str):
                        return value.strip().lower() in (
                            "1",
                            "true",
                            "yes",
                            "on",
                            "开启",
                            "开",
                            "启用",
                        )
                    return bool(value)
            except Exception as exc:
                logger.debug(f"读取管理员绕过唤醒词配置失败: {exc}")
            return False

        if getattr(WakingCheckStage, "_permission_controller_patch_installed", False):
            WakingCheckStage._permission_controller_runtime_enabled = staticmethod(
                _runtime_enabled
            )
            return

        original_process = WakingCheckStage.process
        WakingCheckStage._permission_controller_original_process = original_process
        WakingCheckStage._permission_controller_runtime_enabled = staticmethod(
            _runtime_enabled
        )

        async def patched_process(self, event):
            """在管理员消息前临时插入内部唤醒词，再交回原始唤醒流程。"""
            added_prefix = False
            original_message_str = None
            try:
                wake_prefixes = self.ctx.astrbot_config.setdefault("wake_prefix", [])
                if internal_prefix in wake_prefixes:
                    # 防止内部前缀残留在全局唤醒词里，导致用户手动输入该前缀也能触发。
                    wake_prefixes[:] = [
                        x for x in wake_prefixes if x != internal_prefix
                    ]

                enabled = WakingCheckStage._permission_controller_runtime_enabled()
                if enabled:
                    admins = {
                        str(x).strip()
                        for x in self.ctx.astrbot_config.get("admins_id", [])
                        if str(x).strip()
                    }
                    sender_id = str(event.get_sender_id() or "").strip()
                    if sender_id and sender_id in admins:
                        event.role = "admin"
                        wake_prefixes.append(internal_prefix)
                        if not str(event.message_str or "").startswith(internal_prefix):
                            original_message_str = event.message_str
                            event.message_str = internal_prefix + str(
                                event.message_str or ""
                            )
                            added_prefix = True
            except Exception as exc:
                logger.debug(f"管理员绕过唤醒词处理失败，回退默认唤醒检查: {exc}")

            await WakingCheckStage._permission_controller_original_process(self, event)

            if added_prefix:
                try:
                    event.message_str = original_message_str or event.message_str
                    if hasattr(event, "message_obj"):
                        event.message_obj.message_str = event.message_str
                except Exception:
                    pass

        WakingCheckStage.process = patched_process
        WakingCheckStage._permission_controller_patch_installed = True
        cls._admin_wake_bypass_patch_installed = True

    @staticmethod
    def _normalize_ids(value):
        """把配置中的 ID 列表统一转换为去空白字符串集合。"""
        if value is None:
            return set()
        if isinstance(value, (str, int)):
            value = [value]
        if not isinstance(value, list):
            return set()
        return {str(item).strip() for item in value if str(item).strip()}

    @classmethod
    def _normalize_reasoning_effort(cls, value) -> str:
        """把中英文思考强度归一化为内部枚举。空字符串表示保持默认。"""
        text = str(value or "").strip()
        return REASONING_LEVEL_ALIASES.get(
            text.lower(),
            REASONING_LEVEL_ALIASES.get(text, ""),
        )

    @classmethod
    def _split_reasoning_rule(cls, value) -> tuple[str, str] | None:
        """解析 `目标=强度` 规则。"""
        text = str(value or "").strip()
        if not text:
            return None
        for sep in ("=", "：", ":"):
            if sep in text:
                target, effort = text.split(sep, 1)
                target = target.strip()
                effort = cls._normalize_reasoning_effort(effort)
                if target:
                    return target, effort
                return None
        return None

    def _load_reasoning_rules(self, config_key: str) -> dict[str, str]:
        """读取 `目标=强度` 规则表。"""
        rules: dict[str, str] = {}
        raw_rules = self._cfg_get(config_key, [])
        if isinstance(raw_rules, (str, int)):
            raw_rules = [raw_rules]
        if not isinstance(raw_rules, list):
            return rules
        for item in raw_rules:
            parsed = self._split_reasoning_rule(item)
            if not parsed:
                continue
            target, effort = parsed
            if effort:
                rules[target] = effort
        return rules

    @staticmethod
    def _reasoning_extra_body_for_level(level: str) -> dict:
        """构造一次 LLM 请求要注入的 OpenAI-compatible extra_body。"""
        if level == "low":
            return {"reasoning_effort": "low"}
        if level == "medium":
            return {"reasoning_effort": "medium"}
        if level == "high":
            return {"reasoning_effort": "high"}
        return {}

    def _resolve_reasoning_effort(self, event: AstrMessageEvent) -> str:
        """按 私聊用户 > 群成员 > 群默认 > 全局默认 解析思考强度。"""
        try:
            if event.is_private_chat():
                for candidate in self._private_sender_candidates(event):
                    effort = self.reasoning_private_users.get(candidate)
                    if effort:
                        return effort
                return self.reasoning_default_effort
        except Exception:
            pass

        group_id = str(event.get_group_id() or "").strip()
        sender_id = str(event.get_sender_id() or "").strip()

        if group_id and sender_id:
            effort = self.reasoning_group_user_rules.get(f"{sender_id}-{group_id}")
            if effort:
                return effort
        if group_id:
            effort = self.reasoning_group_defaults.get(group_id)
            if effort:
                return effort
        return self.reasoning_default_effort

    def _reasoning_event_scope(self, event: AstrMessageEvent) -> str:
        """生成简短事件来源，方便在 INFO 日志中核对规则是否命中。"""
        return self._reasoning_event_scope_from_event(event)

    @classmethod
    def _event_from_runner(cls, runner) -> AstrMessageEvent | None:
        """从不同 AstrBot runner 结构里取当前消息事件。"""
        candidate_paths = (
            ("run_context", "context", "event"),
            ("context", "event"),
            ("event",),
            ("req", "event"),
        )
        for path in candidate_paths:
            obj = runner
            for attr in path:
                obj = getattr(obj, attr, None)
                if obj is None:
                    break
            if obj is not None:
                return obj
        return None

    @classmethod
    def _reasoning_event_scope_from_event(cls, event: AstrMessageEvent) -> str:
        """生成简短事件来源，方便在 INFO 日志中核对规则是否命中。"""
        try:
            if event.is_private_chat():
                candidates = sorted(cls._private_sender_candidates_from_event(event))
                return f"私聊用户={candidates[0] if candidates else '未知'}"
        except Exception:
            pass

        group_id = ""
        sender_id = ""
        try:
            group_id = str(event.get_group_id() or "").strip()
        except Exception:
            pass
        try:
            sender_id = str(event.get_sender_id() or "").strip()
        except Exception:
            pass
        if group_id or sender_id:
            return f"群={group_id or '未知'}, 用户={sender_id or '未知'}"
        return "来源=未知"

    @classmethod
    def _load_runtime_reasoning_rules(cls, data: dict, config_key: str) -> dict[str, str]:
        """从配置文件数据读取 `目标=强度` 规则，供 LLM runner 兜底解析。"""
        rules: dict[str, str] = {}
        raw_rules = cls._dict_cfg_get(data, config_key, [])
        if isinstance(raw_rules, (str, int)):
            raw_rules = [raw_rules]
        if not isinstance(raw_rules, list):
            return rules
        for item in raw_rules:
            parsed = cls._split_reasoning_rule(item)
            if not parsed:
                continue
            target, effort = parsed
            if effort:
                rules[target] = effort
        return rules

    @classmethod
    def _load_runtime_reasoning_config(cls) -> dict:
        """运行时直接读取插件配置，避免依赖权限 handler 已经给事件打标。"""
        try:
            cfg_path = (
                Path(__file__).resolve().parents[2]
                / "config"
                / "astrbot_plugin_permission_controller_config.json"
            )
            if not cfg_path.exists():
                return {}
            data = json.loads(cfg_path.read_text(encoding="utf-8-sig") or "{}")
            return data if isinstance(data, dict) else {}
        except Exception as exc:
            logger.debug(f"读取思考强度运行时配置失败: {exc}")
            return {}

    @classmethod
    def _resolve_runtime_reasoning_effort(cls, event: AstrMessageEvent) -> tuple[str, str]:
        """在 LLM runner 中按当前事件实时解析思考强度。"""
        data = cls._load_runtime_reasoning_config()
        if not data:
            return "", cls._reasoning_event_scope_from_event(event)

        default_effort = cls._normalize_reasoning_effort(
            cls._dict_cfg_get(data, "reasoning_default_effort", "")
        )
        group_defaults = cls._load_runtime_reasoning_rules(
            data, "reasoning_group_defaults"
        )
        group_user_rules = cls._load_runtime_reasoning_rules(
            data, "reasoning_group_user_rules"
        )
        private_users = cls._load_runtime_reasoning_rules(
            data, "reasoning_private_users"
        )

        scope = cls._reasoning_event_scope_from_event(event)
        candidates = cls._private_sender_candidates_from_event(event)
        try:
            is_private = bool(event.is_private_chat())
        except Exception:
            is_private = False

        if is_private:
            preferred_candidates = sorted(
                candidates,
                key=lambda item: (not str(item).isdigit(), len(str(item)), str(item)),
            )
            for candidate in preferred_candidates:
                effort = private_users.get(candidate)
                if effort:
                    return effort, scope
            return default_effort, scope

        group_id = ""
        sender_id = ""
        try:
            group_id = str(event.get_group_id() or "").strip()
        except Exception:
            pass
        try:
            sender_id = str(event.get_sender_id() or "").strip()
        except Exception:
            pass

        if group_id and sender_id:
            effort = group_user_rules.get(f"{sender_id}-{group_id}")
            if effort:
                return effort, scope
        if group_id:
            effort = group_defaults.get(group_id)
            if effort:
                return effort, scope
        return default_effort, scope

    def _apply_reasoning_effort_for_event(self, event: AstrMessageEvent) -> None:
        """给本次事件打上 LLM 请求 extra_body，后续 AgentRunner 补丁会读取。"""
        level = self._resolve_reasoning_effort(event)
        extra_body = self._reasoning_extra_body_for_level(level)
        if not extra_body:
            return
        event.set_extra(REASONING_EVENT_EXTRA_KEY, extra_body)
        event.set_extra(REASONING_EVENT_LEVEL_KEY, level)

    @classmethod
    def _install_reasoning_payload_patch(cls):
        """让权限控制器能按事件为 provider.text_chat 注入 extra_body 字段。"""
        try:
            from astrbot.core.agent.runners.tool_loop_agent_runner import (
                ToolLoopAgentRunner,
            )
            from astrbot.core.provider.sources.openai_source import (
                ProviderOpenAIOfficial,
            )
        except Exception as exc:
            logger.debug(f"安装思考强度 payload 补丁失败: {exc}")
            return

        if getattr(
            ToolLoopAgentRunner,
            "_permission_controller_reasoning_patch_version",
            "",
        ) == REASONING_PAYLOAD_PATCH_VERSION and getattr(
            ProviderOpenAIOfficial,
            "_permission_controller_reasoning_patch_version",
            "",
        ) == REASONING_PAYLOAD_PATCH_VERSION:
            cls._reasoning_payload_patch_installed = True
            logger.debug(
                "[PermissionController] 思考强度 custom_extra_body 补丁已存在: %s",
                REASONING_PAYLOAD_PATCH_VERSION,
            )
            return

        original_reset = getattr(
            ToolLoopAgentRunner,
            "_permission_controller_original_reset",
            ToolLoopAgentRunner.reset,
        )
        original_iter = getattr(
            ToolLoopAgentRunner,
            "_permission_controller_original_iter_llm_responses",
            ToolLoopAgentRunner._iter_llm_responses,
        )
        original_query = getattr(
            ProviderOpenAIOfficial,
            "_permission_controller_original_query",
            ProviderOpenAIOfficial._query,
        )
        original_query_stream = getattr(
            ProviderOpenAIOfficial,
            "_permission_controller_original_query_stream",
            ProviderOpenAIOfficial._query_stream,
        )
        ToolLoopAgentRunner._permission_controller_original_reset = original_reset
        ToolLoopAgentRunner._permission_controller_original_iter_llm_responses = original_iter
        ProviderOpenAIOfficial._permission_controller_original_query = original_query
        ProviderOpenAIOfficial._permission_controller_original_query_stream = (
            original_query_stream
        )

        def clear_runner_reasoning_state(runner_self) -> None:
            for attr in (REASONING_EVENT_EXTRA_KEY, REASONING_EVENT_LEVEL_KEY):
                try:
                    if hasattr(runner_self, attr):
                        delattr(runner_self, attr)
                except Exception:
                    pass

        async def patched_reset(runner_self, *args, **kwargs):
            clear_runner_reasoning_state(runner_self)
            result = await original_reset(runner_self, *args, **kwargs)
            try:
                event = cls._event_from_runner(runner_self)
                if event is None:
                    logger.debug(
                        "[PermissionController] reasoning patch 已进入 runner.reset，"
                        "但未能取得当前事件；runner=%s",
                        type(runner_self).__name__,
                    )
                    return result
                level, scope = cls._resolve_runtime_reasoning_effort(event)
                extra_body = cls._reasoning_extra_body_for_level(level)
                if not extra_body:
                    logger.debug(
                        "[PermissionController] reasoning patch 已进入 runner.reset，"
                        "但当前会话未配置思考强度: %s",
                        scope,
                    )
                    return result
                try:
                    event.set_extra(REASONING_EVENT_EXTRA_KEY, extra_body)
                    event.set_extra(REASONING_EVENT_LEVEL_KEY, level)
                except Exception:
                    pass
                setattr(runner_self, REASONING_EVENT_EXTRA_KEY, extra_body)
                setattr(runner_self, REASONING_EVENT_LEVEL_KEY, level)
                logger.debug(
                    "[PermissionController] runner.reset 已命中思考强度: %s (%s), custom_extra_body=%s",
                    level,
                    scope,
                    extra_body,
                )
            except Exception as exc:
                logger.debug(
                    "[PermissionController] runner.reset 思考强度诊断失败: %s",
                    exc,
                )
            return result

        async def patched_openai_query(provider_self, payloads, tools, *args, **kwargs):
            provider_config = getattr(provider_self, "provider_config", {})
            meta = (
                provider_config.get(REASONING_PROVIDER_META_KEY, {})
                if isinstance(provider_config, dict)
                else {}
            )
            if isinstance(meta, dict) and meta.get("extra_body"):
                logger.debug(
                    "[PermissionController] OpenAI-compatible custom_extra_body 已实际注入思考强度: %s (%s), custom_extra_body=%s",
                    meta.get("level") or "未知",
                    meta.get("scope") or "来源=未知",
                    meta.get("extra_body"),
                )
            return await original_query(provider_self, payloads, tools, *args, **kwargs)

        async def patched_openai_query_stream(
            provider_self,
            payloads,
            tools,
            *args,
            **kwargs,
        ):
            provider_config = getattr(provider_self, "provider_config", {})
            meta = (
                provider_config.get(REASONING_PROVIDER_META_KEY, {})
                if isinstance(provider_config, dict)
                else {}
            )
            if isinstance(meta, dict) and meta.get("extra_body"):
                logger.debug(
                    "[PermissionController] OpenAI-compatible stream custom_extra_body 已实际注入思考强度: %s (%s), custom_extra_body=%s",
                    meta.get("level") or "未知",
                    meta.get("scope") or "来源=未知",
                    meta.get("extra_body"),
                )
            async for resp in original_query_stream(
                provider_self,
                payloads,
                tools,
                *args,
                **kwargs,
            ):
                yield resp

        async def patched_iter_llm_responses(runner_self, *args, **kwargs):
            provider = getattr(runner_self, "provider", None)
            provider_config = getattr(provider, "provider_config", None)
            original_custom_extra_body = None
            had_custom_extra_body = False
            had_meta = False
            original_meta = None
            modified_provider_config = False
            try:
                event = cls._event_from_runner(runner_self)
                if event is None:
                    logger.debug(
                        "[PermissionController] 已进入 LLM runner，但未能取得当前事件；runner=%s",
                        type(runner_self).__name__,
                    )
                    event_extra_body = None
                    event_level = ""
                    scope = "来源=未知"
                else:
                    event_extra_body = event.get_extra(REASONING_EVENT_EXTRA_KEY, None)
                    event_level = event.get_extra(REASONING_EVENT_LEVEL_KEY, "")
                    scope = cls._reasoning_event_scope_from_event(event)
                extra_body = event_extra_body
                level = event_level
                if not isinstance(extra_body, dict) or not extra_body:
                    if event is not None:
                        level, scope = cls._resolve_runtime_reasoning_effort(event)
                        extra_body = cls._reasoning_extra_body_for_level(level)
                        if isinstance(extra_body, dict) and extra_body:
                            try:
                                event.set_extra(REASONING_EVENT_EXTRA_KEY, extra_body)
                                event.set_extra(REASONING_EVENT_LEVEL_KEY, level)
                            except Exception:
                                pass
                    else:
                        extra_body = getattr(
                            runner_self, REASONING_EVENT_EXTRA_KEY, None
                        )
                        level = getattr(runner_self, REASONING_EVENT_LEVEL_KEY, level)
                if not isinstance(extra_body, dict) or not extra_body:
                    extra_body = {}
                if (
                    event is not None
                    and isinstance(extra_body, dict)
                    and extra_body
                    and not event.get_extra(REASONING_LOGGED_EVENT_KEY, False)
                ):
                    logger.info(
                        "[PermissionController] 思考强度: %s (%s)",
                        REASONING_LEVEL_LABELS.get(level, level or "默认"),
                        scope,
                    )
                    event.set_extra(REASONING_LOGGED_EVENT_KEY, True)
                if (
                    isinstance(provider_config, dict)
                    and isinstance(extra_body, dict)
                    and extra_body
                ):
                    had_custom_extra_body = "custom_extra_body" in provider_config
                    original_custom_extra_body = provider_config.get(
                        "custom_extra_body"
                    )
                    merged_extra_body = {}
                    if isinstance(original_custom_extra_body, dict):
                        merged_extra_body.update(original_custom_extra_body)
                    merged_extra_body.update(extra_body)
                    modified_provider_config = True
                    provider_config["custom_extra_body"] = merged_extra_body

                    had_meta = REASONING_PROVIDER_META_KEY in provider_config
                    original_meta = provider_config.get(REASONING_PROVIDER_META_KEY)
                    provider_config[REASONING_PROVIDER_META_KEY] = {
                        "level": str(level or ""),
                        "scope": str(scope or ""),
                        "extra_body": extra_body,
                    }
                elif event is not None:
                    logger.debug(
                        "[PermissionController] 已进入 LLM runner，但未为当前会话注入思考强度: %s",
                        scope,
                    )
            except Exception as exc:
                logger.debug(f"[PermissionController] 注入思考强度 payload 失败: {exc}")

            try:
                async for resp in original_iter(runner_self, *args, **kwargs):
                    yield resp
            finally:
                if modified_provider_config and isinstance(provider_config, dict):
                    if had_custom_extra_body:
                        provider_config["custom_extra_body"] = (
                            original_custom_extra_body
                        )
                    else:
                        provider_config.pop("custom_extra_body", None)
                    if had_meta:
                        provider_config[REASONING_PROVIDER_META_KEY] = original_meta
                    else:
                        provider_config.pop(REASONING_PROVIDER_META_KEY, None)

        ToolLoopAgentRunner.reset = patched_reset
        ToolLoopAgentRunner._iter_llm_responses = patched_iter_llm_responses
        ProviderOpenAIOfficial._query = patched_openai_query
        ProviderOpenAIOfficial._query_stream = patched_openai_query_stream
        ToolLoopAgentRunner._permission_controller_reasoning_patch_installed = True
        ToolLoopAgentRunner._permission_controller_reasoning_patch_version = (
            REASONING_PAYLOAD_PATCH_VERSION
        )
        ProviderOpenAIOfficial._permission_controller_reasoning_patch_installed = True
        ProviderOpenAIOfficial._permission_controller_reasoning_patch_version = (
            REASONING_PAYLOAD_PATCH_VERSION
        )
        cls._reasoning_payload_patch_installed = True
        logger.debug(
            "[PermissionController] 思考强度 custom_extra_body 补丁已安装: %s",
            REASONING_PAYLOAD_PATCH_VERSION,
        )

    def _load_admin_ids(self):
        """从 AstrBot 全局配置读取管理员 ID，用于绕过权限限制。"""
        admin_ids = set()
        try:
            global_config = self.context.get_config()
            if hasattr(global_config, "get"):
                admin_ids.update(
                    self._normalize_ids(global_config.get("admins_id", []))
                )
        except Exception:
            pass
        return admin_ids

    def _plugin_synced_ids_path(self) -> Path:
        """记录本插件已同步到平台白名单的 ID，避免误删手动平台白名单。"""
        return (
            Path(__file__).resolve().parents[2]
            / "config"
            / "astrbot_plugin_permission_controller_synced_ids.json"
        )

    def _load_plugin_synced_ids(self) -> set[str]:
        """读取历史同步记录。"""
        try:
            path = self._plugin_synced_ids_path()
            if not path.exists():
                return set()
            data = json.loads(path.read_text(encoding="utf-8-sig") or "{}")
            ids = data.get("synced_ids", [])
            if isinstance(ids, (str, int)):
                ids = [ids]
            if not isinstance(ids, list):
                return set()
            return self._normalize_ids(ids)
        except Exception as exc:
            logger.debug(f"读取插件同步白名单记录失败: {exc}")
            return set()

    def _save_plugin_synced_ids(self, synced_ids: set[str]) -> None:
        """保存本插件当前负责同步的 ID。"""
        try:
            path = self._plugin_synced_ids_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(
                    {
                        "synced_ids": sorted(synced_ids),
                        "note": "IDs managed by astrbot_plugin_permission_controller. Manual platform whitelist entries are not recorded here.",
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.debug(f"保存插件同步白名单记录失败: {exc}")

    def _merge_platform_whitelist(
        self, current: set[str], plugin_allowlist: set[str]
    ) -> list[str]:
        """合并平台白名单。

        规则：
        - 插件当前配置中的 ID 必须存在于平台白名单；
        - 插件历史同步过但现在已从插件配置删除的 ID，从平台白名单移除；
        - 不在历史同步记录中的平台 ID 视为用户手动维护，保留不动。
        """
        previous_synced = self._load_plugin_synced_ids()
        manual_or_external = current - previous_synced
        return sorted(manual_or_external | plugin_allowlist)

    def _sync_plugin_allowlist_to_platform_whitelist(self) -> None:
        """把插件放行对象双向同步到 AstrBot 平台 ID 白名单。

        AstrBot 核心平台白名单检查早于普通插件 handler。这里同步
        private_chat_users、allowed_groups，以及 simple_rules 中涉及的群号
        到平台 id_whitelist，确保 用户QQ-群号 精确放行规则能进入插件判断。
        删除插件配置中的 ID 时，也会从平台白名单移除；但只移除本插件
        历史同步过的 ID，避免误删用户手动添加的平台白名单。
        """
        rule_group_ids = {group_id for group_id in self.rules if group_id}
        plugin_allowlist = (
            self.allowed_groups | self.private_chat_users | rule_group_ids
        )

        try:
            global_config = self.context.get_config()
        except Exception:
            global_config = None

        # 1. 尝试修改运行时配置对象。
        try:
            if hasattr(global_config, "get"):
                current = self._normalize_ids(global_config.get("id_whitelist", []))
                merged = self._merge_platform_whitelist(current, plugin_allowlist)
                if hasattr(global_config, "set"):
                    global_config.set("id_whitelist", merged)
                elif isinstance(global_config, dict):
                    global_config["id_whitelist"] = merged
        except Exception as exc:
            logger.debug(f"同步插件放行列表到运行时平台白名单失败: {exc}")

        # 2. 同步写入 data/cmd_config.json，便于重启后继续生效。
        try:
            data_dir = Path(__file__).resolve().parents[2]
            cmd_config_path = data_dir / "cmd_config.json"
            if cmd_config_path.exists():
                raw = cmd_config_path.read_text(encoding="utf-8-sig")
                data = json.loads(raw) if raw.strip() else {}
                platform_settings = data.setdefault("platform_settings", data)
                current = self._normalize_ids(platform_settings.get("id_whitelist", []))
                merged = self._merge_platform_whitelist(current, plugin_allowlist)
                if merged != list(platform_settings.get("id_whitelist", [])):
                    platform_settings["id_whitelist"] = merged
                    cmd_config_path.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
        except Exception as exc:
            logger.debug(f"同步插件放行列表到 cmd_config.json 失败: {exc}")

        # 3. 最后更新同步记录。即使插件列表为空，也要记录为空，
        #    这样下一次能确认旧同步项已被插件释放。
        self._save_plugin_synced_ids(plugin_allowlist)

    def _load_rules(self, config_key: str = "simple_rules"):
        """解析 用户QQ-群号 规则，生成 group_id -> user_ids 映射。"""
        raw_rules = self._cfg_get(config_key, [])
        if not isinstance(raw_rules, list):
            raw_rules = []
        if not raw_rules:
            return {}
        rules = {}
        for item in raw_rules:
            item = str(item).strip()
            if not item or "-" not in item:
                continue
            user_id, group_id = item.split("-", 1)
            user_id = user_id.strip()
            group_id = group_id.strip()
            if not user_id or not group_id:
                continue
            if not user_id.isdigit() or not group_id.isdigit():
                continue
            rules.setdefault(group_id, set()).add(user_id)
        return rules

    def _decide_group_access(self, group_id: str, sender_id: str) -> tuple[bool, str]:
        """判定一次群聊 AI 调用是否允许。

        规则只表达两个核心目标：
        - 指定人可以在指定群调用；
        - 指定人不能在指定群调用。

        整群放行和全局群聊黑名单保留为兼容能力。返回值第二项用于调试日志，
        不参与业务判断。
        """
        group_id = str(group_id or "").strip()
        sender_id = str(sender_id or "").strip()
        is_admin = self._is_admin(sender_id)

        if self.enable_group_blacklist and sender_id in self.group_blacklist:
            if self.admin_bypass and is_admin:
                return True, "admin_bypass_group_blacklist"
            return False, "group_blacklist"

        if not self.enable_group_rules:
            return True, "group_rules_disabled"

        if self.admin_bypass and is_admin:
            return True, "admin_bypass"

        if sender_id and sender_id in self.deny_rules.get(group_id, set()):
            return False, "group_user_denied"

        if group_id in self.allowed_groups:
            return True, "group_allowed"

        if sender_id and sender_id in self.rules.get(group_id, set()):
            return True, "group_user_allowed"

        return False, "no_matching_group_rule"

    def _is_admin(self, sender_id: str) -> bool:
        """判断发送者是否是 AstrBot 全局管理员。"""
        sender_id = str(sender_id).strip()
        return bool(sender_id and sender_id in self.admin_ids)

    @staticmethod
    def _extract_tail_ids_from_unified_origin(umo: str) -> set[str]:
        """从 unified_msg_origin 中尽量提取可能的私聊用户 ID。"""
        result = set()
        text = str(umo or "").strip()
        if not text:
            return result
        result.add(text)
        # 常见：platform:FriendMessage:session 或 webchat:FriendMessage:webchat!user!cid
        for sep in (":", "!"):
            if sep in text:
                for part in text.split(sep):
                    part = part.strip()
                    if part:
                        result.add(part)
        return result

    def _private_sender_candidates(self, event: AstrMessageEvent) -> set[str]:
        """私聊 ID 兼容：QQ号、sender.user_id、session_id、unified_msg_origin 分段都参与匹配。"""
        return self._private_sender_candidates_from_event(event)

    @staticmethod
    def _raw_post_type(event: AstrMessageEvent) -> str:
        """读取 aiocqhttp 原始 post_type。request/notice 不是普通聊天消息。"""
        try:
            raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
            if isinstance(raw, dict):
                return str(raw.get("post_type", "")).strip().lower()
        except Exception:
            pass
        return ""

    @classmethod
    def _is_non_chat_raw_event(cls, event: AstrMessageEvent) -> bool:
        """放行加群申请、进退群通知等非聊天事件，避免影响群管类插件。"""
        return cls._raw_post_type(event) in {"request", "notice", "meta_event"}

    @staticmethod
    def _is_dashboard_chat_event(event: AstrMessageEvent) -> bool:
        """放行 AstrBot Dashboard 自带 Chat/WebChat 测试会话。"""
        try:
            platform_name = str(getattr(getattr(event, "platform_meta", None), "name", "")).lower()
            if platform_name in {"webchat", "dashboard"}:
                return True
        except Exception:
            pass

        try:
            umo = str(getattr(event, "unified_msg_origin", "") or "").lower()
            if umo.startswith("webchat:") or ":webchat" in umo or "dashboard" in umo:
                return True
        except Exception:
            pass

        return False

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=maxsize)
    async def check_group_user_whitelist(self, event: AstrMessageEvent):
        """群聊权限入口：只拦截 AI 唤醒/艾特调用，不影响普通群消息插件。"""
        if self._is_non_chat_raw_event(event) or self._is_dashboard_chat_event(event):
            return

        group_id = str(event.get_group_id() or "").strip()
        sender_id = str(event.get_sender_id() or "").strip()

        # 只控制“调用机器人/模型”的消息；普通群聊图片、文本等被动插件应继续收到。
        if not bool(getattr(event, "is_at_or_wake_command", False)):
            return

        allowed, reason = self._decide_group_access(group_id, sender_id)
        logger.debug(
            "[PermissionController] group access decision: allowed=%s reason=%s group=%s sender=%s",
            allowed,
            reason,
            group_id,
            sender_id,
        )
        if allowed:
            self._apply_reasoning_effort_for_event(event)
            return

        event.stop_event()

    @filter.event_message_type(filter.EventMessageType.ALL, priority=maxsize)
    async def check_private_chat_whitelist(self, event: AstrMessageEvent):
        """私聊白名单。

        使用 ALL + event.is_private_chat() 兜底，避免部分适配器/版本下
        PRIVATE_MESSAGE 过滤器未命中导致私聊白名单不生效。
        """
        if self._is_non_chat_raw_event(event) or self._is_dashboard_chat_event(event):
            return

        try:
            if not event.is_private_chat():
                return
        except Exception:
            # 兜底：如果无法判断为私聊，不拦截，避免误伤群聊。
            return

        # 不同适配器暴露的私聊 ID 字段不同，因此收集多个候选值做交集匹配。
        candidates = self._private_sender_candidates(event)
        if not candidates:
            event.stop_event()
            return

        if self.admin_bypass and any(self._is_admin(item) for item in candidates):
            self._apply_reasoning_effort_for_event(event)
            return

        # 私聊白名单为空时，表示不放行任何普通私聊用户。
        if self.private_chat_users and candidates & self.private_chat_users:
            self._apply_reasoning_effort_for_event(event)
            return

        event.stop_event()


try:
    GroupUserWhitelistPlugin._install_reasoning_payload_patch()
except Exception as exc:  # pragma: no cover - 兜底日志，不影响插件注册
    logger.info("[PermissionController] 模块导入阶段安装思考强度补丁失败: %s", exc)
