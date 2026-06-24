"""LLM 可调用的图像生成工具模块。"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterable
from typing import Any

from pydantic import Field
from pydantic.dataclasses import dataclass as pydantic_dataclass

from astrbot.api import logger
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool, ToolExecResult
from astrbot.core.astr_agent_context import AstrAgentContext

from .constants import SUPPORTED_ASPECT_RATIOS, SUPPORTED_RESOLUTIONS
from .logging_utils import log_prefix, mask_sensitive, safe_log_url
from .types import ImageCapability


ASPECT_RATIO_OPTIONS = list(SUPPORTED_ASPECT_RATIOS)
RESOLUTION_OPTIONS = list(SUPPORTED_RESOLUTIONS)
LOG = log_prefix("LLMTool")


def _extract_event(context: ContextWrapper[AstrAgentContext] | dict[str, Any]) -> Any:
    """Extract AstrBot message event from different tool context wrappers."""
    wrapped_context = getattr(context, "context", None)
    if event := getattr(wrapped_context, "event", None):
        return event
    if event := getattr(context, "event", None):
        return event
    if isinstance(context, dict):
        return context.get("event")
    return None


def _normalize_string_items(raw: Any) -> list[str]:
    """Normalize one or many string-like values from tool arguments."""
    if raw is None:
        return []
    if isinstance(raw, str):
        item = raw.strip()
        return [item] if item else []
    if isinstance(raw, dict):
        for key in ("url", "path", "file", "name"):
            if items := _normalize_string_items(raw.get(key)):
                return items
        return []
    if isinstance(raw, Iterable):
        items: list[str] = []
        for value in raw:
            items.extend(_normalize_string_items(value))
        return items
    item = str(raw).strip()
    return [item] if item else []


def _resolve_avatar_user_id(event: Any, ref: str) -> str | None:
    """Resolve an avatar reference into a platform user id."""
    normalized = ref.strip().lower()
    if not normalized:
        return None
    if normalized == "self" and hasattr(event, "get_self_id"):
        return str(event.get_self_id())
    if normalized == "sender" and hasattr(event, "get_sender_id"):
        return str(event.get_sender_id() or event.unified_msg_origin)

    cleaned = normalized.removeprefix("qq:").removeprefix("@").strip()
    if cleaned.isdigit():
        return cleaned
    return None


async def _download_reference_images(
    plugin: Any,
    references: Any,
    *,
    reference_label: str,
    task_id: str | None = None,
) -> list[tuple[bytes, str]]:
    """Download explicit reference images from URLs or local file paths."""
    images_data: list[tuple[bytes, str]] = []
    task_log = log_prefix("LLMTool", task_id) if task_id else LOG
    for reference in _normalize_string_items(references):
        if image_data := await plugin.image_processor.download_image(reference):
            images_data.append(image_data)
        else:
            logger.warning(
                f"{task_log} {reference_label}参考图获取失败: {safe_log_url(reference)}"
            )
    return images_data


def _deduplicate_reference_images(
    images_data: list[tuple[bytes, str]],
    *,
    task_id: str | None = None,
) -> list[tuple[bytes, str]]:
    """Remove duplicate reference images before submitting a generation task."""
    if len(images_data) < 2:
        return images_data

    unique_images: list[tuple[bytes, str]] = []
    seen_hashes: set[str] = set()
    duplicate_count = 0
    for data, mime in images_data:
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen_hashes:
            duplicate_count += 1
            continue
        seen_hashes.add(digest)
        unique_images.append((data, mime))

    if duplicate_count:
        task_log = log_prefix("LLMTool", task_id) if task_id else LOG
        logger.info(f"{task_log} 已忽略 {duplicate_count} 张重复参考图")
    return unique_images


async def _collect_reference_images(
    plugin: Any,
    event: Any,
    *,
    capabilities: ImageCapability,
    reference_images: Any = None,
    avatar_references: Any = None,
    task_id: str | None = None,
) -> list[tuple[bytes, str]]:
    """Collect explicit URL/path and avatar reference images."""
    task_log = log_prefix("LLMTool", task_id) if task_id else LOG
    if not (capabilities & ImageCapability.IMAGE_TO_IMAGE):
        if reference_images or avatar_references:
            logger.warning(f"{task_log} 当前适配器不支持参考图，已忽略工具参考图参数")
        return []

    images_data: list[tuple[bytes, str]] = []
    avatar_user_ids: set[str] = set()

    images_data.extend(
        await _download_reference_images(
            plugin,
            reference_images,
            reference_label="显式",
            task_id=task_id,
        )
    )

    for ref in _normalize_string_items(avatar_references):
        user_id = _resolve_avatar_user_id(event, ref)
        if not user_id or user_id in avatar_user_ids:
            continue
        avatar_user_ids.add(user_id)
        if avatar_data := await plugin.image_processor.get_avatar(user_id):
            images_data.append((avatar_data, "image/jpeg"))
            logger.info(f"{task_log} 已添加 {mask_sensitive(user_id)} 的头像作为参考图")

    return _deduplicate_reference_images(images_data, task_id=task_id)


async def _start_generation_task(
    plugin: Any,
    event: Any,
    *,
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    reference_images: Any = None,
    avatar_references: Any = None,
) -> ToolExecResult:
    """Validate request, collect references, and schedule image generation."""
    if not plugin.generator or not plugin.generator.adapter:
        return "❌ 生图生成器未初始化"

    is_usage_limit_admin = plugin.is_usage_limit_admin(event)
    check_result = plugin.usage_manager.check_rate_limit(
        event.unified_msg_origin,
        is_admin=is_usage_limit_admin,
    )
    if isinstance(check_result, str):
        if check_result:
            masked_uid = mask_sensitive(event.unified_msg_origin)
            logger.warning(
                f"{LOG} 工具调用触发限制: {check_result} (用户: {masked_uid})"
            )
        return check_result

    if (
        not plugin.config_manager.adapter_config
        or not plugin.config_manager.adapter_config.api_keys
    ):
        masked_uid = mask_sensitive(event.unified_msg_origin)
        logger.warning(f"{LOG} 工具调用失败: 未配置 API Key (用户: {masked_uid})")
        return "❌ 未配置 API Key，无法生成图片"

    task_id = hashlib.md5(
        f"{time.time()}{event.unified_msg_origin}".encode()
    ).hexdigest()[:8]

    try:
        images_data = await _collect_reference_images(
            plugin,
            event,
            capabilities=plugin.generator.adapter.get_capabilities(),
            reference_images=reference_images,
            avatar_references=avatar_references,
            task_id=task_id,
        )
    except Exception as exc:
        logger.error(
            f"{log_prefix('LLMTool', task_id)} 处理参考图失败: {exc}",
            exc_info=True,
        )
        images_data = []

    quote_message_id = str(
        getattr(getattr(event, "message_obj", None), "message_id", "") or ""
    ).strip()
    sender_id = str(getattr(event, "get_sender_id", lambda: "")() or "").strip()

    plugin.create_background_task(
        plugin._generate_and_send_image_async(
            prompt=prompt,
            images_data=images_data or None,
            unified_msg_origin=event.unified_msg_origin,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            task_id=task_id,
            is_usage_limit_admin=is_usage_limit_admin,
            quote_message_id=quote_message_id,
            sender_id=sender_id,
        )
    )

    return plugin.format_start_task_message(
        prompt=prompt,
        reference_image_count=len(images_data),
        aspect_ratio=aspect_ratio,
        resolution=resolution,
        task_id=task_id,
    )


@pydantic_dataclass
class ImageGenerationTool(FunctionTool[AstrAgentContext]):
    """LLM 可调用的统一生图工具。"""

    name: str = "generate_image"
    description: str = "使用生图模型生成或修改图片，支持普通生图、图生图、头像/参考图。"
    parameters: dict = Field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "生图时使用的提示词。",
                },
                "aspect_ratio": {
                    "type": "string",
                    "description": "图片宽高比。如果不确定，请使用'不指定'。",
                    "enum": ASPECT_RATIO_OPTIONS,
                },
                "resolution": {
                    "type": "string",
                    "description": "图片质量/分辨率。使用'不指定'时请求中不携带分辨率字段。",
                    "enum": RESOLUTION_OPTIONS,
                },
                "avatar_references": {
                    "type": "array",
                    "description": "可选。需要使用头像作为参考图时填写，'self' 表示机器人，'sender' 表示发送者，也可填写 QQ 号/用户 ID。",
                    "items": {"type": "string"},
                },
                "reference_images": {
                    "type": "array",
                    "description": "可选。参考图列表，支持 Linux/Windows 绝对路径、file:// 文件 URL 或 http(s) 网络图片 URL。仅支持图生图的模型会使用。",
                    "items": {"type": "string"},
                },
            },

        }
    )

    plugin: Any = None

    async def call(
        self, context: ContextWrapper[AstrAgentContext], **kwargs: Any
    ) -> ToolExecResult:
        """执行通用生图工具调用。"""
        plugin = self.plugin
        if not plugin:
            return "❌ 插件未正确初始化 (Plugin instance missing)"

        prompt = str(kwargs.get("prompt", "") or "").strip()
        if not prompt:
            return "❌ 请提供图片生成的提示词"

        aspect_ratio = kwargs.get("aspect_ratio") or plugin.config_manager.default_aspect_ratio
        resolution = kwargs.get("resolution") or UNSPECIFIED_OPTION

        event = _extract_event(context)
        if not event:
            logger.warning(f"{LOG} 工具调用上下文缺少事件。上下文类型: {type(context)}")
            return "❌ 无法获取当前消息上下文"

        return await _start_generation_task(
            plugin,
            event,
            prompt=prompt,
            aspect_ratio=str(aspect_ratio),
            resolution=str(resolution),
            reference_images=kwargs.get("reference_images"),
            avatar_references=kwargs.get("avatar_references"),
        )


def adjust_tool_parameters(
    tool: FunctionTool[AstrAgentContext], capabilities: ImageCapability
) -> None:
    """根据适配器能力动态调整工具参数。"""
    props = tool.parameters.get("properties", {})

    if not (capabilities & ImageCapability.ASPECT_RATIO):
        if "aspect_ratio" in props:
            del props["aspect_ratio"]
            logger.debug(f"{LOG} 适配器不支持宽高比，已从工具参数中移除")

    if not (capabilities & ImageCapability.RESOLUTION):
        if "resolution" in props:
            del props["resolution"]
            logger.debug(f"{LOG} 适配器不支持分辨率，已从工具参数中移除")

    if not (capabilities & ImageCapability.IMAGE_TO_IMAGE):
        for key in ("avatar_references", "reference_images"):
            if key in props:
                del props[key]
        logger.debug(f"{LOG} 适配器不支持参考图，已从工具参数中移除参考图相关参数")
