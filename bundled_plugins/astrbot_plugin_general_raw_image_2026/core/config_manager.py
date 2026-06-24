from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from astrbot.api import logger
from astrbot.core.config.astrbot_config import AstrBotConfig

from .constants import (
    DEFAULT_ASPECT_RATIO,
    DEFAULT_DAILY_LIMIT_COUNT,
    DEFAULT_MAX_CONCURRENT_TASKS,
    DEFAULT_MAX_IMAGE_SIZE_MB,
    DEFAULT_MAX_RETRY_ATTEMPTS,
    DEFAULT_RATE_LIMIT_SECONDS,
    DEFAULT_RESOLUTION,
    DEFAULT_TIMEOUT,
    LEGACY_AUTO_OPTION,
    UNSPECIFIED_OPTION,
)
from .logging_utils import log_prefix, safe_log_text
from .types import AdapterConfig, AdapterType

PROVIDER_COMMON_FIELDS = frozenset(
    {
        "__template_key",
        "name",
        "base_url",
        "proxy",
        "api_keys",
        "available_models",
        "capability_options",
        "timeout",
        "max_retry_attempts",
        "enable_stream",
    }
)

SCHEMA_DEFAULT_FACTORIES: dict[str, Any] = {
    "int": int,
    "float": float,
    "bool": bool,
    "string": str,
    "text": str,
    "list": list,
    "file": list,
    "template_list": list,
}

ADAPTER_EXTRA_DEFAULTS: dict[AdapterType, dict[str, Any]] = {
    AdapterType.OPENAI: {"model_family": "auto"},
}
LOG = log_prefix("Config")


class ConfigMigrator:
    """Migrate legacy config, then normalize it using schema metadata."""

    TEMPLATE_KEY_FIELD = "__template_key"
    LEGACY_TEMPLATE_KEY_FIELD = "template"
    TEMPLATE_KEY_ALIASES: dict[str, str] = {"z_image_gitee": "gitee_ai"}
    VALUE_ALIASES: dict[str, dict[Any, Any]] = {
        "generation.default_aspect_ratio": {LEGACY_AUTO_OPTION: UNSPECIFIED_OPTION},
        "generation.default_resolution": {LEGACY_AUTO_OPTION: UNSPECIFIED_OPTION},
    }
    LIST_ADDITIONS_ON_TEMPLATE_MIGRATION: dict[str, dict[str, list[Any]]] = {
        "z_image_gitee": {"capability_options": ["图生图"]},
    }
    _SENTINEL = object()

    def __init__(self, schema: Mapping[str, Any] | None):
        self._schema = schema if isinstance(schema, Mapping) else {}

    @classmethod
    def normalize_template_key(cls, value: Any) -> str:
        template_key = str(value or "").strip()
        return cls.TEMPLATE_KEY_ALIASES.get(template_key, template_key)

    def migrate(self, config: dict[str, Any]) -> tuple[bool, list[str]]:
        changed = False
        messages: list[str] = []

        changed |= self._migrate_enable_llm_tool(config, messages)
        changed |= self._remove_legacy_prompt_templates(config, messages)

        if not self._schema:
            return changed, messages

        normalized, normalize_changed, normalize_messages = self._normalize_object(
            config,
            self._schema,
            path="",
        )
        changed |= normalize_changed
        messages.extend(normalize_messages)
        if normalize_changed:
            config.clear()
            config.update(normalized)
        return changed, messages

    def _migrate_enable_llm_tool(
        self, config: dict[str, Any], messages: list[str]
    ) -> bool:
        value = config.get("enable_llm_tool")
        if not isinstance(value, bool):
            return False

        config["enable_llm_tool"] = list(ALL_LLM_TOOLS) if value else []
        messages.append("enable_llm_tool: bool -> list")
        return True

    def _remove_legacy_prompt_templates(
        self, config: dict[str, Any], messages: list[str]
    ) -> bool:
        """Remove legacy prompt template configuration because this feature is disabled."""
        changed = False
        for key in ("presets", "personas", "prompt_templates", "safety_audit"):
            if key in config:
                config.pop(key, None)
                messages.append(f"removed {key}")
                changed = True
        return changed

    def _normalize_object(
        self,
        raw: Any,
        schema: Mapping[str, Any],
        *,
        path: str,
    ) -> tuple[dict[str, Any], bool, list[str]]:
        messages: list[str] = []
        changed = False

        if isinstance(raw, Mapping):
            raw_mapping, alias_changed, alias_messages = self._apply_field_aliases(
                raw, path=path
            )
            changed |= alias_changed
            messages.extend(alias_messages)
        else:
            raw_mapping = {}
            changed = True
            messages.append(f"{path or '<root>'}: reset to object")

        normalized: dict[str, Any] = {}
        for key, meta in schema.items():
            key_path = self._join_path(path, key)
            if key in raw_mapping and raw_mapping[key] is not None:
                value, value_changed, value_messages = self._normalize_value(
                    raw_mapping[key],
                    meta,
                    path=key_path,
                )
                normalized[key] = value
                changed |= value_changed
                messages.extend(value_messages)
            else:
                normalized[key] = self._schema_default(meta)
                changed = True
                messages.append(f"{key_path}: add default")

        for key in raw_mapping:
            if key not in schema:
                changed = True
                messages.append(
                    f"{self._join_path(path, str(key))}: removed obsolete key"
                )

        if list(raw_mapping.keys()) != list(normalized.keys()):
            changed = True
            if set(raw_mapping.keys()) == set(normalized.keys()):
                messages.append(f"{path or '<root>'}: fixed key order")

        return normalized, changed, messages

    def _normalize_value(
        self,
        raw: Any,
        meta: Any,
        *,
        path: str,
    ) -> tuple[Any, bool, list[str]]:
        if not isinstance(meta, Mapping):
            return copy.deepcopy(raw), False, []

        meta_type = meta.get("type")
        if meta_type == "object":
            items = meta.get("items")
            if not isinstance(items, Mapping):
                return (
                    self._schema_default(meta),
                    raw is not None,
                    [f"{path}: reset to object"],
                )
            return self._normalize_object(raw, items, path=path)

        if meta_type == "template_list":
            return self._normalize_template_list(raw, meta, path=path)

        return self._normalize_leaf_value(raw, meta, path=path)

    def _normalize_template_list(
        self,
        raw: Any,
        meta: Mapping[str, Any],
        *,
        path: str,
    ) -> tuple[list[Any], bool, list[str]]:
        if not isinstance(raw, list):
            return self._schema_default(meta), True, [f"{path}: reset to list"]

        templates = meta.get("templates")
        if not isinstance(templates, Mapping):
            templates = {}

        normalized_items: list[Any] = []
        changed = False
        messages: list[str] = []

        for index, item in enumerate(raw):
            item_path = f"{path}[{index}]"
            if not isinstance(item, Mapping):
                changed = True
                messages.append(f"{item_path}: removed non-object item")
                continue

            template_key, old_template_key, key_changed, key_messages = (
                self._normalize_template_key(
                    item,
                    templates,
                    item_path=item_path,
                )
            )
            changed |= key_changed
            messages.extend(key_messages)
            if not template_key:
                changed = True
                messages.append(f"{item_path}: removed item without template")
                continue

            template_meta = templates.get(template_key)
            if not isinstance(template_meta, Mapping):
                changed = True
                messages.append(
                    f"{item_path}: removed unknown template {template_key!r}"
                )
                continue

            item_schema = template_meta.get("items")
            if not isinstance(item_schema, Mapping):
                item_schema = {}

            child_raw = {
                key: value
                for key, value in item.items()
                if key
                not in {
                    self.TEMPLATE_KEY_FIELD,
                    self.LEGACY_TEMPLATE_KEY_FIELD,
                }
            }
            changed |= self._ensure_list_values(
                child_raw,
                self.LIST_ADDITIONS_ON_TEMPLATE_MIGRATION.get(old_template_key, {}),
                messages,
                label=item_path,
            )
            child_normalized, child_changed, child_messages = self._normalize_object(
                child_raw,
                item_schema,
                path=item_path,
            )
            normalized_item = {self.TEMPLATE_KEY_FIELD: template_key}
            normalized_item.update(child_normalized)

            if dict(item) != normalized_item:
                changed = True
            changed |= child_changed
            messages.extend(child_messages)
            normalized_items.append(normalized_item)

        if len(normalized_items) != len(raw):
            changed = True

        return normalized_items, changed, messages

    def _normalize_template_key(
        self,
        item: Mapping[str, Any],
        templates: Mapping[str, Any],
        *,
        item_path: str,
    ) -> tuple[str, str, bool, list[str]]:
        messages: list[str] = []
        changed = False

        raw_key = item.get(self.TEMPLATE_KEY_FIELD)
        legacy_key = item.get(self.LEGACY_TEMPLATE_KEY_FIELD)
        if legacy_key not in (None, ""):
            changed = True
            messages.append(
                f"{item_path}.{self.LEGACY_TEMPLATE_KEY_FIELD}: removed legacy key"
            )
            if raw_key in (None, ""):
                raw_key = legacy_key
                messages.append(
                    f"{item_path}.{self.LEGACY_TEMPLATE_KEY_FIELD} -> {self.TEMPLATE_KEY_FIELD}"
                )

        old_template_key = str(raw_key).strip() if raw_key not in (None, "") else ""
        template_key = self.normalize_template_key(old_template_key)
        if template_key != old_template_key:
            messages.append(
                f"{item_path}.{self.TEMPLATE_KEY_FIELD}: {old_template_key!r} -> {template_key!r}"
            )
            changed = True

        if not template_key and len(templates) == 1:
            template_key = next(iter(templates))
            messages.append(
                f"{item_path}.{self.TEMPLATE_KEY_FIELD}: add default {template_key!r}"
            )
            changed = True

        if item.get(self.TEMPLATE_KEY_FIELD) != template_key:
            changed = True

        return template_key, old_template_key, changed, messages

    def _apply_field_aliases(
        self,
        raw: Mapping[str, Any],
        *,
        path: str,
    ) -> tuple[dict[str, Any], bool, list[str]]:
        aliases = self._field_aliases_for_path(path)
        if not aliases:
            return dict(raw), False, []

        changed = False
        messages: list[str] = []
        normalized = dict(raw)
        for legacy_key, current_key in aliases.items():
            if legacy_key not in normalized:
                continue
            if current_key not in normalized:
                normalized[current_key] = normalized[legacy_key]
                messages.append(f"{path}.{legacy_key} -> {current_key}")
            normalized.pop(legacy_key, None)
            changed = True
        return normalized, changed, messages

    def _field_aliases_for_path(self, path: str) -> dict[str, str]:
        return {}

    def _ensure_list_values(
        self,
        target: dict[str, Any],
        additions: dict[str, list[Any]],
        messages: list[str],
        *,
        label: str,
    ) -> bool:
        changed = False
        for key, values in additions.items():
            current = target.get(key)
            if not isinstance(current, list):
                continue
            for value in values:
                if value not in current:
                    current.append(value)
                    changed = True
                    messages.append(f"{label}.{key}: add {value!r}")
        return changed

    def _normalize_leaf_value(
        self,
        raw: Any,
        meta: Mapping[str, Any],
        *,
        path: str,
    ) -> tuple[Any, bool, list[str]]:
        meta_type = str(meta.get("type") or "")
        default = self._schema_default(meta)
        value = self._coerce_schema_value(raw, meta_type, default)
        changed = value != raw

        value, alias_changed = self._apply_value_aliases(value, path=path)
        changed |= alias_changed

        value, options_changed = self._normalize_options(value, meta)
        changed |= options_changed
        return value, changed, [f"{path}: normalized by schema"] if changed else []

    def _apply_value_aliases(self, value: Any, *, path: str) -> tuple[Any, bool]:
        aliases = self._value_aliases_for_path(path)
        if not aliases:
            return value, False

        if isinstance(value, list):
            normalized = [aliases.get(item, item) for item in value]
            return normalized, normalized != value

        normalized = aliases.get(value, value)
        return normalized, normalized != value

    def _value_aliases_for_path(self, path: str) -> dict[Any, Any]:
        return self.VALUE_ALIASES.get(path, {})

    def _coerce_schema_value(self, raw: Any, meta_type: str, default: Any) -> Any:
        """Coerce a scalar schema value without applying option filters."""
        if meta_type == "int":
            return self._coerce_number(raw, default, int)
        if meta_type == "float":
            return self._coerce_number(raw, default, float)
        if meta_type == "bool":
            return self._coerce_bool(raw, default)
        if meta_type in {"string", "text"}:
            return raw if isinstance(raw, str) else default if raw is None else str(raw)
        if meta_type == "file":
            return self._coerce_file_value(raw, default)
        if meta_type == "list":
            return copy.deepcopy(raw) if isinstance(raw, list) else default
        return copy.deepcopy(raw)

    def _coerce_number(self, raw: Any, default: Any, parser: Any) -> Any:
        """Coerce int or float config values."""
        if isinstance(raw, bool):
            return default
        try:
            return parser(raw)
        except (TypeError, ValueError):
            return default

    def _coerce_bool(self, raw: Any, default: bool) -> bool:
        """Coerce bool config values with explicit string support."""
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            normalized = raw.strip().lower()
            if normalized in {"true", "1", "yes", "on"}:
                return True
            if normalized in {"false", "0", "no", "off", ""}:
                return False
        return default

    def _coerce_file_value(self, raw: Any, default: Any) -> list[Any]:
        """Coerce file config values to AstrBot file-list shape."""
        if isinstance(raw, list):
            return copy.deepcopy(raw)
        if isinstance(raw, str) and raw.strip():
            return [raw.strip()]
        return default

    def _normalize_options(
        self,
        value: Any,
        meta: Mapping[str, Any],
    ) -> tuple[Any, bool]:
        options = meta.get("options")
        if not isinstance(options, list):
            return value, False

        option_set = set(options)
        if isinstance(value, list):
            normalized = [item for item in value if item in option_set]
            return normalized, normalized != value

        if value in option_set:
            return value, False

        return self._schema_default(meta), True

    def _schema_default(self, meta: Any) -> Any:
        if not isinstance(meta, Mapping):
            return None

        meta_type = str(meta.get("type") or "")
        if meta_type == "object":
            items = meta.get("items")
            if not isinstance(items, Mapping):
                return {}
            return {key: self._schema_default(value) for key, value in items.items()}

        if "default" in meta:
            return copy.deepcopy(meta["default"])

        default_factory = SCHEMA_DEFAULT_FACTORIES.get(meta_type)
        return default_factory() if default_factory else None

    def _join_path(self, base: str, key: str) -> str:
        return f"{base}.{key}" if base else key

    def _pop_if_present(self, target: dict[str, Any], key: str) -> Any:
        if key not in target:
            return self._SENTINEL
        return target.pop(key)


LLM_TOOL_IMAGE_GENERATION = "生图工具"
ALL_LLM_TOOLS = (
    LLM_TOOL_IMAGE_GENERATION,
)


@dataclass
class UsageSettings:
    """用户使用限制设置。"""

    enable_usage_limits: bool = True
    rate_limit_seconds: int = DEFAULT_RATE_LIMIT_SECONDS
    enable_daily_limit: bool = False
    daily_limit_count: int = DEFAULT_DAILY_LIMIT_COUNT
    max_image_size_mb: int = DEFAULT_MAX_IMAGE_SIZE_MB
    umo_blacklist: list[str] = field(default_factory=list)
    admin_bypass_limits: bool = True
    umo_whitelist: list[str] = field(default_factory=list)
    blacklist_block_message: str = "❌ 当前会话已被加入黑名单，无法使用生图功能"


@dataclass
class GenerationSettings:
    """生成设置。"""

    default_aspect_ratio: str = DEFAULT_ASPECT_RATIO
    default_resolution: str = DEFAULT_RESOLUTION
    max_concurrent_tasks: int = DEFAULT_MAX_CONCURRENT_TASKS
    show_generation_info: bool = False
    show_model_info: bool = False
    reply_to_source_message: bool = True
    completion_reply_text: str = ""
    generation_failure_message_template: str = "❌ 生成失败"
    failure_reply_to_source_message: bool = True
    failure_mention_sender: bool = True
    enable_start_task_image: bool = True
    start_task_image_path: str = ""
    enable_start_task_image_paths: bool = False
    start_task_image_paths: list[str] = field(default_factory=list)
    start_task_image_select_mode: str = "顺序轮询"
    start_task_message_template: str = (
        "已开始生图任务{reference_images_block}{preset_block}"
    )



@dataclass
class PluginConfig:
    """完整的插件配置。"""

    adapter_config: AdapterConfig | None = None
    usage_settings: UsageSettings = field(default_factory=UsageSettings)
    generation_settings: GenerationSettings = field(default_factory=GenerationSettings)
    enabled_llm_tools: set[str] = field(default_factory=lambda: set(ALL_LLM_TOOLS))


class ConfigManager:
    """插件配置管理器。"""

    MIGRATION_LOG_LIMIT = 20

    def __init__(self, config: AstrBotConfig):
        self._config = config
        self._config_migrator = ConfigMigrator(getattr(config, "schema", None))
        self._plugin_config: PluginConfig = PluginConfig()
        self._all_provider_configs: list[AdapterConfig] = []  # 保存所有供应商配置
        self.load()

    def load(self) -> PluginConfig:
        """加载并解析插件配置。"""
        self._migrate_legacy_config()

        gen_cfg = self._get_config_section("generation")
        user_limits_cfg = self._get_config_section("user_limits")
        api_providers_raw = self._config.get("api_providers", [])

        all_provider_configs = self._load_provider_configs(api_providers_raw, gen_cfg)
        self._all_provider_configs = all_provider_configs

        self._plugin_config = PluginConfig(
            adapter_config=self._select_adapter_config(
                all_provider_configs,
                self._get_str(gen_cfg, "model", ""),
            ),
            usage_settings=self._parse_usage_settings(user_limits_cfg),
            generation_settings=self._parse_generation_settings(gen_cfg),
            enabled_llm_tools=set(
                self._parse_enabled_llm_tools(
                    self._config.get("enable_llm_tool", list(ALL_LLM_TOOLS))
                )
            ),
        )

        return self._plugin_config

    def _parse_usage_settings(self, cfg: dict[str, Any]) -> UsageSettings:
        """Parse user limit settings from normalized config."""
        return UsageSettings(
            enable_usage_limits=self._get_bool(
                cfg, "enable_usage_limits", True
            ),
            rate_limit_seconds=self._get_int(
                cfg,
                "rate_limit_seconds",
                DEFAULT_RATE_LIMIT_SECONDS,
                min_value=0,
            ),
            enable_daily_limit=self._get_bool(cfg, "enable_daily_limit", False),
            daily_limit_count=self._get_int(
                cfg,
                "daily_limit_count",
                DEFAULT_DAILY_LIMIT_COUNT,
                min_value=1,
            ),
            max_image_size_mb=self._get_int(
                cfg,
                "max_image_size_mb",
                DEFAULT_MAX_IMAGE_SIZE_MB,
                min_value=1,
            ),
            umo_blacklist=self._parse_string_list(cfg.get("umo_blacklist", [])),
            admin_bypass_limits=self._get_bool(cfg, "admin_bypass_limits", True),
            umo_whitelist=self._parse_string_list(cfg.get("umo_whitelist", [])),
            blacklist_block_message=self._get_str(
                cfg,
                "blacklist_block_message",
                UsageSettings.blacklist_block_message,
            ),
        )

    def _parse_generation_settings(self, cfg: dict[str, Any]) -> GenerationSettings:
        """Parse image generation behavior settings."""
        return GenerationSettings(
            default_aspect_ratio=self._get_str(
                cfg,
                "default_aspect_ratio",
                DEFAULT_ASPECT_RATIO,
            ),
            default_resolution=self._get_str(
                cfg,
                "default_resolution",
                DEFAULT_RESOLUTION,
            ),
            max_concurrent_tasks=self._get_int(
                cfg,
                "max_concurrent_tasks",
                DEFAULT_MAX_CONCURRENT_TASKS,
                min_value=1,
            ),
            show_generation_info=self._get_bool(cfg, "show_generation_info", False),
            show_model_info=self._get_bool(cfg, "show_model_info", False),
            reply_to_source_message=self._get_bool(
                cfg, "reply_to_source_message", True
            ),
            completion_reply_text=self._get_str(
                cfg, "completion_reply_text", ""
            ),
            generation_failure_message_template=self._get_str(
                cfg,
                "generation_failure_message_template",
                GenerationSettings.generation_failure_message_template,
            ),
            failure_reply_to_source_message=self._get_bool(
                cfg, "failure_reply_to_source_message", True
            ),
            failure_mention_sender=self._get_bool(
                cfg, "failure_mention_sender", True
            ),
            enable_start_task_image=self._get_bool(
                cfg, "enable_start_task_image", True
            ),
            start_task_image_path=self._first_string(
                cfg.get("start_task_image_path"),
                GenerationSettings.start_task_image_path,
            ),
            enable_start_task_image_paths=self._get_bool(
                cfg, "enable_start_task_image_paths", False
            ),
            start_task_image_paths=self._parse_string_list(
                cfg.get("start_task_image_paths", [])
            ),
            start_task_image_select_mode=self._get_str(
                cfg, "start_task_image_select_mode", "顺序轮询"
            ),
            start_task_message_template=self._get_str(
                cfg,
                "start_task_message_template",
                GenerationSettings.start_task_message_template,
            ),
        )

    def reload(self) -> PluginConfig:
        """重新加载配置。"""
        return self.load()

    def _migrate_legacy_config(self) -> None:
        """Migrate legacy config and persist schema-normalized config."""
        changed, messages = self._config_migrator.migrate(self._config)
        if not changed:
            return

        logger.info(
            f"{LOG} 已自动迁移并规范化配置: "
            + self._format_migration_messages(messages)
        )
        self._config.save_config()

    def _format_migration_messages(self, messages: list[str]) -> str:
        """Format migration messages without flooding logs."""
        if len(messages) <= self.MIGRATION_LOG_LIMIT:
            return "; ".join(messages)
        visible_messages = messages[: self.MIGRATION_LOG_LIMIT]
        hidden_count = len(messages) - self.MIGRATION_LOG_LIMIT
        return "; ".join(visible_messages) + f"; ... and {hidden_count} more"

    def _get_config_section(self, name: str) -> dict[str, Any]:
        """Return a dictionary config section, falling back to an empty dict."""
        value = self._config.get(name, {})
        if isinstance(value, dict):
            return value
        logger.warning(f"{LOG} 配置项 {safe_log_text(name)} 格式错误，已按空对象处理")
        return {}

    def _get_nested_section(self, cfg: dict[str, Any], key: str) -> dict[str, Any]:
        """Return a nested dictionary section, falling back to an empty dict."""
        value = cfg.get(key, {})
        if isinstance(value, dict):
            return value
        logger.warning(f"{LOG} 配置项 {key} 格式错误，已按空对象处理")
        return {}

    def _get_str(
        self,
        cfg: dict[str, Any],
        key: str,
        default: str,
        *,
        strip: bool = True,
    ) -> str:
        """Read a config value as string."""
        value = cfg.get(key, default)
        if value is None:
            value = default
        parsed = str(value)
        return parsed.strip() if strip else parsed

    def _first_string(self, raw: Any, default: str = "") -> str:
        """Read a string from old scalar config or new file-picker list config."""
        if isinstance(raw, list):
            for item in raw:
                value = str(item or "").strip()
                if value:
                    return value
            return default
        if raw is None:
            return default
        value = str(raw).strip()
        return value or default

    def _get_bool(self, cfg: dict[str, Any], key: str, default: bool) -> bool:
        """Read a config value as bool without treating arbitrary strings as true."""
        value = cfg.get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "1", "yes", "on"}:
                return True
            if normalized in {"false", "0", "no", "off", ""}:
                return False
        return default

    def _get_int(
        self,
        cfg: dict[str, Any],
        key: str,
        default: int,
        *,
        min_value: int,
    ) -> int:
        """Read a config value as int and clamp it."""
        return self._coerce_int(cfg.get(key, default), default, min_value=min_value)

    def _parse_enabled_llm_tools(self, raw: Any) -> list[str]:
        """Parse enabled LLM tool names from list config."""
        if isinstance(raw, bool):
            return list(ALL_LLM_TOOLS) if raw else []

        if not isinstance(raw, list):
            logger.warning(f"{LOG} enable_llm_tool 配置格式错误，已按空列表处理")
            return []

        selected: list[str] = []
        for item in raw:
            tool_name = str(item).strip()
            if tool_name in ALL_LLM_TOOLS and tool_name not in selected:
                selected.append(tool_name)
        return selected

    def _load_provider_configs(
        self, raw_providers: Any, gen_cfg: dict[str, Any]
    ) -> list[AdapterConfig]:
        """Parse all provider templates into normalized adapter configs."""
        if not isinstance(raw_providers, list):
            logger.warning(f"{LOG} api_providers 配置格式错误，已按空列表处理")
            return []

        provider_configs: list[AdapterConfig] = []
        for provider_item in raw_providers:
            if not isinstance(provider_item, dict):
                continue
            if parsed := self._parse_provider_config(provider_item, gen_cfg):
                provider_configs.append(parsed)
        return provider_configs

    def _parse_provider_config(
        self,
        provider_item: dict[str, Any],
        gen_cfg: dict[str, Any],
    ) -> AdapterConfig | None:
        """Parse one provider item with global fallback and provider overrides."""
        adapter_type = self._parse_adapter_type(provider_item)
        if not adapter_type:
            return None

        base_url = str(provider_item.get("base_url") or "").strip()
        proxy = str(provider_item.get("proxy") or "").strip() or None

        return AdapterConfig(
            type=adapter_type,
            name=str(provider_item.get("name", "")).strip(),
            base_url=self._clean_base_url(base_url),
            api_keys=self._parse_string_list(provider_item.get("api_keys", [])),
            available_models=self._parse_string_list(
                provider_item.get("available_models", [])
            ),
            proxy=proxy,
            timeout=self._get_provider_int_override(
                provider_item,
                gen_cfg,
                "timeout",
                DEFAULT_TIMEOUT,
                min_value=1,
            ),
            max_retry_attempts=self._get_provider_int_override(
                provider_item,
                gen_cfg,
                "max_retry_attempts",
                DEFAULT_MAX_RETRY_ATTEMPTS,
                min_value=0,
            ),
            capability_options=self._parse_capability_options(provider_item),
            extra=self._parse_provider_extra(adapter_type, provider_item),
        )

    def _parse_adapter_type(self, provider_item: dict[str, Any]) -> AdapterType | None:
        """Parse and validate the provider template key."""
        raw_key = provider_item.get("__template_key") or ""
        adapter_type_str = ConfigMigrator.normalize_template_key(raw_key)
        if adapter_type_str != str(raw_key).strip():
            logger.info(
                f"{LOG} 兼容旧配置: api_providers.*.__template_key {raw_key!r} -> {adapter_type_str!r}"
            )
        if not adapter_type_str:
            return None

        try:
            return AdapterType(adapter_type_str)
        except ValueError:
            logger.warning(
                f"{LOG} 忽略未知适配器类型: {safe_log_text(adapter_type_str)}"
            )
            return None

    def _get_provider_int_override(
        self,
        provider_item: dict[str, Any],
        gen_cfg: dict[str, Any],
        key: str,
        default: int,
        *,
        min_value: int,
    ) -> int:
        """Resolve an integer provider override, using global config by default."""
        global_value = self._coerce_int(
            gen_cfg.get(key, default), default, min_value=min_value
        )
        if key not in provider_item:
            return global_value

        raw_value = provider_item.get(key)
        if raw_value in (None, ""):
            return global_value

        provider_value = self._coerce_int(raw_value, global_value, min_value=0)
        if provider_value <= 0:
            return global_value
        return max(min_value, provider_value)

    def _coerce_int(self, value: Any, default: int, *, min_value: int) -> int:
        """Safely coerce a value to int and clamp it."""
        if isinstance(value, bool):
            return default
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default
        return max(min_value, parsed)

    def _parse_provider_extra(
        self,
        adapter_type: AdapterType,
        provider_item: dict[str, Any],
    ) -> dict[str, Any]:
        """Collect adapter-specific settings without changing parser code later."""
        extra = dict(ADAPTER_EXTRA_DEFAULTS.get(adapter_type, {}))

        for key in extra:
            if key in provider_item:
                extra[key] = self._normalize_extra_value(provider_item[key])

        for key, value in provider_item.items():
            if key in PROVIDER_COMMON_FIELDS or key.startswith("__"):
                continue
            extra.setdefault(key, self._normalize_extra_value(value))

        return extra

    def _normalize_extra_value(self, value: Any) -> Any:
        """Normalize adapter-specific values before storing them in extra."""
        if isinstance(value, str):
            return value.strip()
        return value

    def _parse_string_list(self, raw: Any) -> list[str]:
        """Parse a list-like config value into non-empty strings."""
        if not isinstance(raw, list):
            return []
        return [item for item in (str(v).strip() for v in raw) if item]

    def _select_adapter_config(
        self, provider_configs: list[AdapterConfig], model_setting: str
    ) -> AdapterConfig | None:
        """Select active provider config and attach full model choices."""
        matched_config: AdapterConfig | None = None
        current_model = ""

        if "/" in model_setting:
            target_provider_name, target_model = model_setting.split("/", 1)
            for cfg in provider_configs:
                if cfg.name == target_provider_name:
                    matched_config = cfg
                    current_model = target_model
                    break

        if not matched_config and provider_configs:
            matched_config = provider_configs[0]
            current_model = (
                matched_config.available_models[0]
                if matched_config.available_models
                else ""
            )
            logger.info(
                f"{LOG} 未匹配到当前模型配置，默认使用: {safe_log_text(matched_config.name)}/{safe_log_text(current_model)}"
            )

        if not matched_config:
            logger.error(f"{LOG} 未找到任何有效的生图模型配置")
            return None

        return replace(
            matched_config,
            model=current_model,
            available_models=self._build_model_choices(provider_configs),
        )

    def _build_model_choices(self, provider_configs: list[AdapterConfig]) -> list[str]:
        """Build display model choices in provider/model format."""
        choices: list[str] = []
        for cfg in provider_configs:
            choices.extend(f"{cfg.name}/{model}" for model in cfg.available_models)
        return choices

    def _parse_capability_options(
        self, provider_item: dict[str, Any]
    ) -> dict[str, bool]:
        """解析供应商能力配置（完全由配置驱动）。"""
        raw = provider_item.get("capability_options", [])

        supported_keys = (
            "text_to_image",
            "image_to_image",
            "aspect_ratio",
            "resolution",
        )

        if not isinstance(raw, list):
            logger.warning(f"{LOG} capability_options 配置格式错误，已按空列表处理")
            raw = []

        capability_alias_map = {
            "文生图": "text_to_image",
            "图生图": "image_to_image",
            "宽高比": "aspect_ratio",
            "分辨率": "resolution",
            # 允许英文值，便于手动配置文件时兼容
            "text_to_image": "text_to_image",
            "image_to_image": "image_to_image",
            "aspect_ratio": "aspect_ratio",
            "resolution": "resolution",
        }

        selected: set[str] = set()
        for item in raw:
            if not isinstance(item, str):
                continue
            key = capability_alias_map.get(item.strip())
            if key:
                selected.add(key)

        return {key: key in selected for key in supported_keys}

    def _clean_base_url(self, url: str) -> str:
        """清理 Base URL，移除末尾的 /v1*"""
        if not url:
            return ""
        url = url.rstrip("/")
        if "/v1" in url:
            url = url.split("/v1", 1)[0]
        return url.rstrip("/")

    def save_model_setting(self, model: str) -> None:
        """保存模型设置。"""
        self._config.setdefault("generation", {})["model"] = model
        self._config.save_config()

    # ---------------------- 便捷属性访问 ----------------------
    @property
    def adapter_config(self) -> AdapterConfig | None:
        """获取适配器配置。"""
        return self._plugin_config.adapter_config

    def is_llm_tool_enabled(self, tool_name: str) -> bool:
        """检查指定 LLM 工具是否启用。"""
        return tool_name in self._plugin_config.enabled_llm_tools

    @property
    def default_aspect_ratio(self) -> str:
        """默认宽高比。"""
        return self._plugin_config.generation_settings.default_aspect_ratio

    @property
    def default_resolution(self) -> str:
        """默认分辨率。"""
        return self._plugin_config.generation_settings.default_resolution

    @property
    def max_concurrent_tasks(self) -> int:
        """最大并发任务数。"""
        return self._plugin_config.generation_settings.max_concurrent_tasks

    @property
    def show_generation_info(self) -> bool:
        """是否显示生成信息。"""
        return self._plugin_config.generation_settings.show_generation_info

    @property
    def show_model_info(self) -> bool:
        """是否显示模型信息。"""
        return self._plugin_config.generation_settings.show_model_info

    @property
    def reply_to_source_message(self) -> bool:
        """生图完成后是否引用触发消息。"""
        return self._plugin_config.generation_settings.reply_to_source_message

    @property
    def completion_reply_text(self) -> str:
        """生图完成后附加的回复文本。"""
        return self._plugin_config.generation_settings.completion_reply_text

    @property
    def generation_failure_message_template(self) -> str:
        """生图失败时发送的自定义文本。"""
        return self._plugin_config.generation_settings.generation_failure_message_template

    @property
    def failure_reply_to_source_message(self) -> bool:
        """生图失败后是否引用触发消息。"""
        return self._plugin_config.generation_settings.failure_reply_to_source_message

    @property
    def failure_mention_sender(self) -> bool:
        """生图失败后是否艾特触发用户。"""
        return self._plugin_config.generation_settings.failure_mention_sender

    @property
    def enable_start_task_image(self) -> bool:
        """开始生图任务时是否发送固定图片。"""
        return self._plugin_config.generation_settings.enable_start_task_image

    @property
    def start_task_image_path(self) -> str:
        """开始绘图回复图片路径或 URL。"""
        return self._plugin_config.generation_settings.start_task_image_path

    @property
    def enable_start_task_image_paths(self) -> bool:
        """是否启用开始绘图回复图片路径列表。"""
        return self._plugin_config.generation_settings.enable_start_task_image_paths

    @property
    def start_task_image_paths(self) -> list[str]:
        """开始绘图回复图片路径或 URL 列表。"""
        return self._plugin_config.generation_settings.start_task_image_paths

    @property
    def start_task_image_select_mode(self) -> str:
        """开始绘图回复图片选择模式。"""
        return self._plugin_config.generation_settings.start_task_image_select_mode

    @property
    def start_task_message_template(self) -> str:
        """开始生图任务提示模板。"""
        return self._plugin_config.generation_settings.start_task_message_template

    @property
    def usage_settings(self) -> UsageSettings:
        """用户使用限制设置。"""
        return self._plugin_config.usage_settings

    # ---------------------- 供应商查询方法 ----------------------
    def get_provider_config(self, adapter_type: AdapterType) -> AdapterConfig | None:
        """获取指定类型的供应商配置。

        Args:
            adapter_type: 要获取的适配器类型。

        Returns:
            匹配的供应商配置，如果没有则返回 None。
        """
        for cfg in self._all_provider_configs:
            if cfg.type == adapter_type:
                return cfg
        return None
