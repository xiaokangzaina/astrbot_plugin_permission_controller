"""
AstrBot 图像生成插件主模块

"""

from __future__ import annotations

import asyncio
import hashlib
import random
import time
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.star.star_tools import StarTools
from astrbot.core.utils.astrbot_path import get_astrbot_temp_path

from .core.config_manager import (
    LLM_TOOL_IMAGE_GENERATION,
    ConfigManager,
)
from .core.constants import UNSPECIFIED_OPTION
from .core.generator import ImageGenerator
from .core.image_processor import ImageProcessor
from .core.llm_tool import (
    ImageGenerationTool,
    adjust_tool_parameters,
)
from .core.logging_utils import log_prefix, mask_sensitive, safe_log_text
from .core.task_manager import TaskManager
from .core.types import GenerationRequest, ImageCapability, ImageData
from .core.usage_manager import UsageManager
from .core.utils import validate_aspect_ratio, validate_resolution

try:
    from .web import RawImageWebController
except Exception:  # pragma: no cover
    RawImageWebController = None


LOG = log_prefix("Plugin")


class _SafeFormatDict(dict[str, str]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


class ImageGenerationPlugin(Star):
    """图像生成插件主类"""

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.context = context
        self.config = config

        # 数据目录配置：持久数据放插件数据目录，图片临时文件放 AstrBot 官方临时目录
        self.data_dir = StarTools.get_data_dir()
        self.image_temp_dir = (
            Path(get_astrbot_temp_path()) / "astrbot_plugin_general_raw_image_2026"
        )
        self.image_temp_dir.mkdir(parents=True, exist_ok=True)
        self._start_task_image_round_robin_index = 0
        self.web = None

        # 初始化配置管理器
        self.config_manager = ConfigManager(config)
        self._register_web_page()

        # 初始化使用数据管理器
        self.usage_manager = UsageManager(
            str(self.data_dir), self.config_manager.usage_settings
        )

        # 初始化图片处理器
        self.image_processor = ImageProcessor(
            str(self.image_temp_dir),
            self.config_manager.usage_settings.max_image_size_mb,
            str(self.data_dir),
        )

        # 初始化任务管理器
        self.task_manager = TaskManager()

        # 初始化生成器
        self.generator: ImageGenerator | None = None
        self.semaphore: asyncio.Semaphore | None = None

    # ---------------------- 生命周期 ----------------------

    def _register_web_page(self) -> None:
        if RawImageWebController is None:
            return
        try:
            self.web = RawImageWebController(self.context, self)
            self.web.register_routes()
            logger.info(f"{LOG} 独立配置页 Web API 已注册")
        except Exception as exc:
            logger.warning(f"{LOG} 独立配置页注册失败: {exc}")

    async def initialize(self):
        """插件加载时调用"""
        if self.config_manager.adapter_config:
            self.generator = ImageGenerator(self.config_manager.adapter_config)
            self.semaphore = asyncio.Semaphore(self.config_manager.max_concurrent_tasks)
        else:
            logger.error(f"{LOG} 适配器配置加载失败，插件未初始化")

        # 注册 LLM 工具
        self._register_llm_tools()

        # 配置定时任务
        self._setup_tasks()

        # 执行启动任务（在后台异步执行）
        self.task_manager.create_task(self.task_manager.run_startup_tasks())

        logger.info(
            f"{LOG} 插件加载完成，模型: {safe_log_text(self.config_manager.adapter_config.model if self.config_manager.adapter_config else '未知')}"
        )

    async def terminate(self):
        """插件卸载时调用"""
        try:
            if self.generator:
                await self.generator.close()
            await self.task_manager.cancel_all()
            logger.info(f"{LOG} 插件已卸载")
        except Exception as exc:
            logger.error(f"{LOG} 卸载清理出错: {exc}", exc_info=True)

    # ---------------------- 内部工具 ----------------------

    def _setup_tasks(self) -> None:
        """配置并启动定时任务。"""
        # Jimeng2API 自动领积分任务
        self._setup_jimeng_token_task()

    def _register_llm_tools(self) -> None:
        """Register enabled LLM tools."""
        tools = []
        if self.config_manager.is_llm_tool_enabled(LLM_TOOL_IMAGE_GENERATION):
            if self.generator:
                image_tool = ImageGenerationTool(plugin=self)
                self._adjust_tool_parameters(image_tool)
                tools.append(image_tool)
            else:
                logger.warning(f"{LOG} 生图工具已启用，但生成器未初始化")


        if tools:
            self.context.add_llm_tools(*tools)
            logger.info(
                f"{LOG} 已注册 LLM 工具: " + ", ".join(tool.name for tool in tools)
            )

    def _setup_jimeng_token_task(self) -> None:
        """配置即梦自动领积分任务。

        该任务会：
        1. 在插件启动时执行一次（通过启动任务）
        2. 每天日期变更时自动执行（通过每日任务）

        注意：只要配置中包含即梦渠道，就会启用该任务，
        无论当前使用的是哪个渠道。
        """
        from .adapter.jimeng2api_adapter import Jimeng2APIAdapter
        from .core.types import AdapterType

        # 检查配置中是否包含即梦渠道（而非检查当前适配器）
        jimeng_config = self.config_manager.get_provider_config(AdapterType.JIMENG2API)
        if not jimeng_config:
            return

        # 创建专门用于任务的即梦适配器实例
        jimeng_adapter = Jimeng2APIAdapter(jimeng_config)

        # 1. 注册为启动任务，插件启动时执行一次
        self.task_manager.register_startup_task(
            name="jimeng_token_receive",
            coro_func=jimeng_adapter.receive_token,
        )

        # 2. 注册为每日任务，日期变更时执行
        self.task_manager.start_daily_task(
            name="jimeng_token_receive",
            coro_func=jimeng_adapter.receive_token,
            check_interval_seconds=300,  # 每5分钟检查一次日期变更
            run_immediately=False,  # 启动任务已处理，无需重复执行
        )
        logger.info(f"{LOG} 已配置即梦2API自动领积分任务（启动时+每日）")

    def _adjust_tool_parameters(self, tool: ImageGenerationTool) -> None:
        """根据适配器能力动态调整工具参数。"""
        if not self.generator or not self.generator.adapter:
            return
        capabilities = self.generator.adapter.get_capabilities()
        adjust_tool_parameters(tool, capabilities)

    def create_background_task(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        """创建后台任务并添加到管理器中。"""
        return self.task_manager.create_task(coro)

    def is_usage_limit_admin(self, event: AstrMessageEvent) -> bool:
        """Return whether an event sender is an AstrBot admin for usage limits."""
        try:
            return bool(event.is_admin())
        except Exception as exc:
            logger.debug(f"{LOG} 获取管理员状态失败: {exc}")
            return False

    def _find_named_entry(self, entries: dict[str, Any], token: str) -> str | None:
        """Find an entry by exact or case-insensitive name."""
        if token in entries:
            return token
        lowered_token = token.lower()
        for name in entries:
            if name.lower() == lowered_token:
                return name
        return None

    def _select_start_task_image_path(self) -> str:
        """选择开始绘图回复图片路径，支持旧单路径、顺序轮询和随机。"""
        image_paths = []
        if self.config_manager.enable_start_task_image_paths:
            image_paths = [
                item.strip()
                for item in self.config_manager.start_task_image_paths
                if str(item).strip()
            ]

        # 兼容旧配置：列表总开关关闭或列表为空时使用单路径。
        if not image_paths:
            return self.config_manager.start_task_image_path.strip()

        mode = self.config_manager.start_task_image_select_mode.strip()
        if mode == "随机":
            return random.choice(image_paths)

        # 默认：顺序轮询。
        image_path = image_paths[self._start_task_image_round_robin_index % len(image_paths)]
        self._start_task_image_round_robin_index += 1
        return image_path

    def _resolve_start_task_image_path(self, image_path: str) -> str:
        """Resolve selected image path from config page file picker or legacy path."""
        value = str(image_path or "").strip()
        if not value or value.startswith(("http://", "https://")):
            return value
        path = Path(value)
        if path.exists():
            return str(path)
        normalized = value.replace("\\", "/")
        if normalized.startswith("files/"):
            candidate = Path(self.data_dir) / normalized
            if candidate.exists():
                return str(candidate)
        return value

    def build_start_task_chain(self, message: str) -> MessageChain | None:
        """构建开始绘图回复，可同时包含文字和图片。"""
        chain = MessageChain()
        has_content = False

        if message:
            chain.message(message)
            has_content = True

        image_path = self._resolve_start_task_image_path(self._select_start_task_image_path())
        if self.config_manager.enable_start_task_image and image_path:
            if image_path.startswith(("http://", "https://")):
                chain.url_image(image_path)
                has_content = True
            elif Path(image_path).exists():
                chain.file_image(image_path)
                has_content = True
            else:
                logger.warning(
                    f"{LOG} 开始任务固定图片不存在: {safe_log_text(image_path, 200)}"
                )

        return chain if has_content else None

    def format_start_task_message(
        self,
        *,
        prompt: str,
        reference_image_count: int,
        aspect_ratio: str,
        resolution: str,
        task_id: str,
    ) -> str:
        """Render start-task message from configured template."""
        template = self.config_manager.start_task_message_template
        if not template.strip():
            return ""

        model = ""
        if self.config_manager.adapter_config:
            model = (
                f"{self.config_manager.adapter_config.name}/"
                f"{self.config_manager.adapter_config.model}"
            )

        values = _SafeFormatDict(
            reference_image_count=str(reference_image_count),
            prompt=prompt,
            preset="",
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            task_id=task_id,
            model=model,
            mode="图生图" if reference_image_count else "文生图",
            reference_images_block=(
                f"[{reference_image_count}张参考图]" if reference_image_count else ""
            ),
            preset_block="",
        )

        try:
            return template.format_map(values)
        except Exception as exc:
            logger.warning(f"{LOG} 开始任务提示模板格式化失败: {exc}")
            return "已开始生图任务{reference_images_block}{preset_block}".format_map(
                values
            )

    # ---------------------- 核心生图逻辑 ----------------------

    async def _generate_and_send_image_async(
        self,
        prompt: str,
        unified_msg_origin: str,
        images_data: list[tuple[bytes, str]] | None = None,
        aspect_ratio: str = "1:1",
        resolution: str = "1K",
        task_id: str | None = None,
        is_usage_limit_admin: bool = False,
        quote_message_id: str = "",
        sender_id: str = "",
    ) -> None:
        """异步生成图片并发送。"""
        if not self.generator or not self.generator.adapter:
            return

        if not task_id:
            task_id = hashlib.md5(
                f"{time.time()}{unified_msg_origin}".encode()
            ).hexdigest()[:8]

        capabilities = self.generator.adapter.get_capabilities()

        # 检查并清理不支持的参数
        task_log = log_prefix("Task", task_id)
        if not (capabilities & ImageCapability.IMAGE_TO_IMAGE) and images_data:
            logger.warning(
                f"{task_log} 当前适配器不支持参考图，已忽略 {len(images_data)} 张图片"
            )
            images_data = None

        if (
            not (capabilities & ImageCapability.ASPECT_RATIO)
            and aspect_ratio != UNSPECIFIED_OPTION
        ):
            logger.info(
                f"{task_log} 当前适配器不支持指定比例，已忽略参数: {safe_log_text(aspect_ratio)}"
            )
            aspect_ratio = UNSPECIFIED_OPTION

        if (
            not (capabilities & ImageCapability.RESOLUTION)
            and resolution != UNSPECIFIED_OPTION
        ):
            logger.info(
                f"{task_log} 当前适配器不支持指定分辨率，已忽略参数: {safe_log_text(resolution)}"
            )
            resolution = UNSPECIFIED_OPTION

        final_ar = validate_aspect_ratio(aspect_ratio) or None
        if final_ar == UNSPECIFIED_OPTION:
            final_ar = None
        final_res = validate_resolution(resolution)
        if final_res == UNSPECIFIED_OPTION:
            final_res = None

        images: list[ImageData] = []
        if images_data:
            for data, mime in images_data:
                images.append(ImageData(data=data, mime_type=mime))

        # 使用信号量控制并发
        if self.semaphore is None:
            await self._do_generate_and_send(
                prompt,
                unified_msg_origin,
                images,
                final_ar,
                final_res,
                task_id,
                is_usage_limit_admin,
                quote_message_id,
                sender_id,
            )
            return

        async with self.semaphore:
            await self._do_generate_and_send(
                prompt,
                unified_msg_origin,
                images,
                final_ar,
                final_res,
                task_id,
                is_usage_limit_admin,
                quote_message_id,
                sender_id,
            )

    async def _do_generate_and_send(
        self,
        prompt: str,
        unified_msg_origin: str,
        images: list[ImageData],
        aspect_ratio: str | None,
        resolution: str | None,
        task_id: str,
        is_usage_limit_admin: bool,
        quote_message_id: str = "",
        sender_id: str = "",
    ) -> None:
        """执行生成逻辑并发送结果。"""
        start_time = time.time()
        task_log = log_prefix("Task", task_id)
        if not self.generator:
            logger.warning(f"{task_log} 生成器未初始化，跳过生成请求")
            return
        result = await self.generator.generate(
            GenerationRequest(
                prompt=prompt,
                images=images,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
                task_id=task_id,
            )
        )
        end_time = time.time()
        duration = end_time - start_time

        if result.error:
            logger.error(
                f"{task_log} 生成失败，耗时: {duration:.2f}s, 错误: {safe_log_text(result.error, 200)}"
            )
            failure_message = self.config_manager.generation_failure_message_template.strip()
            if failure_message:
                values = _SafeFormatDict(
                    error=str(result.error or ""),
                    task_id=task_id,
                    duration=f"{duration:.2f}",
                    prompt=prompt,
                )
                try:
                    failure_message = failure_message.format_map(values)
                except Exception as exc:
                    logger.warning(f"{LOG} 生图失败提示模板格式化失败: {exc}")
                    failure_message = "❌ 生成失败"
                chain = MessageChain()
                if self.config_manager.failure_reply_to_source_message and quote_message_id:
                    chain.chain.append(Comp.Reply(id=quote_message_id))
                if self.config_manager.failure_mention_sender and sender_id:
                    chain.chain.append(Comp.At(qq=sender_id))
                    chain.message(" ")
                chain.message(failure_message)
                await self.context.send_message(unified_msg_origin, chain)
            return

        logger.info(
            f"{task_log} 生成成功，耗时: {duration:.2f}s, 图片数量: {len(result.images) if result.images else 0}"
        )

        if not result.images:
            return

        generated_file_paths: list[str] = []
        for img_bytes in result.images:
            file_path = self.image_processor.save_generated_image(task_id, img_bytes)
            if file_path:
                generated_file_paths.append(file_path)

        if not generated_file_paths:
            logger.warning(f"{task_log} 未能保存任何生成图片")
            return


        # 记录使用次数
        self.usage_manager.record_usage(
            unified_msg_origin,
            is_admin=is_usage_limit_admin,
        )

        chain = MessageChain()
        if self.config_manager.reply_to_source_message and quote_message_id:
            chain.chain.append(Comp.Reply(id=quote_message_id))

        completion_reply_text = self.config_manager.completion_reply_text.strip()
        if completion_reply_text:
            chain.message(completion_reply_text)

        for file_path in generated_file_paths:
            chain.file_image(file_path)

        info_parts = []
        if self.config_manager.show_generation_info:
            info_parts.append(
                f"✨ 生成成功！\n📊 耗时: {duration:.2f}s\n🖼️ 数量: {len(generated_file_paths)}张"
            )

        if self.config_manager.show_model_info and self.config_manager.adapter_config:
            info_parts.append(
                f"🤖 模型: {self.config_manager.adapter_config.name}/{self.config_manager.adapter_config.model}"
            )

        if self.usage_manager.is_daily_limit_enabled():
            count = self.usage_manager.get_usage_count(unified_msg_origin)
            daily_limit = (
                "∞"
                if self.usage_manager.is_limit_exempt(
                    unified_msg_origin,
                    is_admin=is_usage_limit_admin,
                )
                else str(self.usage_manager.get_daily_limit())
            )
            info_parts.append(f"📅 今日用量: {count}/{daily_limit}")

        if info_parts:
            chain.message("\n" + "\n".join(info_parts))

        await self.context.send_message(unified_msg_origin, chain)

    # ---------------------- 指令处理 ----------------------

    @filter.command("生图")
    async def generate_image_command(self, event: AstrMessageEvent):
        """处理生图指令。"""
        user_id = event.unified_msg_origin
        is_usage_limit_admin = self.is_usage_limit_admin(event)

        # 检查频率限制和每日限制
        check_result = self.usage_manager.check_rate_limit(
            user_id,
            is_admin=is_usage_limit_admin,
        )
        if isinstance(check_result, str):
            if check_result:
                yield event.plain_result(check_result)
            return

        masked_uid = mask_sensitive(user_id)

        user_input = (event.message_str or "").strip()
        logger.info(
            f"{LOG} 收到生图指令 - 用户: {masked_uid}, 输入摘要: {safe_log_text(user_input)}"
        )

        cmd_parts = user_input.split(maxsplit=1)
        if not cmd_parts:
            return

        prompt = cmd_parts[1].strip() if len(cmd_parts) > 1 else ""
        aspect_ratio = self.config_manager.default_aspect_ratio
        resolution = self.config_manager.default_resolution

        if not prompt:
            yield event.plain_result("❌ 请提供图片生成的提示词！")
            return

        task_id = hashlib.md5(f"{time.time()}{user_id}".encode()).hexdigest()[:8]

        # 获取参考图
        images_data = None
        if (
            self.generator
            and self.generator.adapter
            and (
                self.generator.adapter.get_capabilities()
                & ImageCapability.IMAGE_TO_IMAGE
            )
        ):
            images_data = []
            images_data.extend(
                await self.image_processor.fetch_images_from_event(event)
            )

        msg = self.format_start_task_message(
            prompt=prompt,
            reference_image_count=len(images_data or []),
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            task_id=task_id,
        )
        start_chain = self.build_start_task_chain(msg)
        if start_chain:
            yield event.chain_result(start_chain.chain)

        quote_message_id = str(
            getattr(getattr(event, "message_obj", None), "message_id", "") or ""
        ).strip()
        sender_id = str(getattr(event, "get_sender_id", lambda: "")() or "").strip()

        self.create_background_task(
            self._generate_and_send_image_async(
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

    @filter.command("生图模型")
    async def model_command(self, event: AstrMessageEvent, model_index: str = ""):
        """切换生图模型。"""
        if not self.config_manager.adapter_config:
            yield event.plain_result("❌ 适配器未初始化")
            return

        models = self.config_manager.adapter_config.available_models or []

        if not model_index:
            lines = ["📋 可用模型列表:"]
            current_model_full = f"{self.config_manager.adapter_config.name}/{self.config_manager.adapter_config.model}"
            for idx, model in enumerate(models, 1):
                marker = " ✓" if model == current_model_full else ""
                lines.append(f"{idx}. {model}{marker}")
            lines.append(f"\n当前使用: {current_model_full}")
            yield event.plain_result("\n".join(lines))
            return

        try:
            index = int(model_index) - 1
            if 0 <= index < len(models):
                raw_model = models[index]  # "供应商名称/模型名称"

                # 更新配置并重新加载
                self.config_manager.save_model_setting(raw_model)
                self.config_manager.reload()

                if self.generator:
                    await self.generator.update_adapter(
                        self.config_manager.adapter_config
                    )

                yield event.plain_result(f"✅ 模型已切换: {raw_model}")
            else:
                yield event.plain_result("❌ 无效的序号")
        except ValueError:
            yield event.plain_result("❌ 请输入有效的数字序号")

