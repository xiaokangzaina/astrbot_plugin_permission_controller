from __future__ import annotations

import base64
import copy
import json
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast

from astrbot.api import logger
from astrbot.api.star import Context
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

try:
    from quart import jsonify as quart_jsonify
    from quart import request as quart_request_obj
except ImportError:
    quart_jsonify = None
    quart_request_obj = None

PLUGIN_NAME = "astrbot_plugin_general_raw_image_2026"
PLUGIN_DIR = Path(__file__).resolve().parent
PLUGIN_DATA_DIR = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
START_TASK_IMAGE_REL_DIR = Path("files/generation/start_task_image_path")
UPLOAD_DIR = PLUGIN_DATA_DIR / START_TASK_IMAGE_REL_DIR
UI_STATE_FILE = PLUGIN_DIR / "data" / "settings_ui_state.json"
BACKGROUND_DIR = PLUGIN_DIR / "pages" / "settings" / "backgrounds"
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}


class RawImageWebController:
    """通用生图插件独立配置页 API。"""

    def __init__(self, context: Context, plugin: Any) -> None:
        self.context = context
        self.plugin = plugin

    def register_routes(self) -> None:
        if quart_jsonify is None or quart_request_obj is None:
            logger.info("[GeneralRawImage] Quart 不可用，跳过独立前端 API 注册")
            return
        routes = [
            ("/settings-v2/bootstrap", self.page_bootstrap, ["GET"], "Load raw image settings v2"),
            ("/settings-v2/config", self.page_save_config, ["POST"], "Save raw image full config v2"),
            ("/settings-v2/start-image", self.page_save_start_image_path, ["POST"], "Save start task image path v2"),
            ("/settings-v2/start-image/upload", self.page_upload_start_image, ["POST"], "Upload start task image v2"),
            ("/settings-v2/image/upload", self.page_upload_image_only, ["POST"], "Upload image and return local path"),
            ("/settings-v2/ui-state", self.page_get_ui_state, ["GET"], "Get settings page UI state"),
            ("/settings-v2/ui-state", self.page_save_ui_state, ["POST"], "Save settings page UI state"),
            ("/settings-v2/background/upload", self.page_upload_background, ["POST"], "Upload settings page background"),
        ]
        for path, handler, methods, desc in routes:
            self.context.register_web_api(
                f"/{PLUGIN_NAME}{path}",
                self._wrap_handler(handler),
                methods,
                desc,
            )

    @staticmethod
    def _jsonify(payload: dict[str, Any]):
        return cast(Callable[[dict[str, Any]], Any], quart_jsonify)(payload)

    @staticmethod
    def _request():
        return cast(Any, quart_request_obj)

    def _wrap_handler(self, handler: Callable[[], Awaitable]) -> Callable[[], Awaitable]:
        async def wrapped():
            try:
                return await handler()
            except ValueError as exc:
                return self._jsonify({"ok": False, "message": str(exc)}), 400
            except Exception as exc:
                logger.exception("[GeneralRawImage] page request failed")
                return self._jsonify({"ok": False, "message": str(exc)}), 500

        wrapped.__name__ = handler.__name__
        return wrapped

    def _config(self) -> Any:
        config = getattr(self.plugin, "config", None)
        if config is not None:
            return config
        manager = getattr(self.plugin, "config_manager", None)
        config = getattr(manager, "_config", None)
        if config is None:
            raise RuntimeError("plugin config is unavailable")
        return config

    def _generation_config(self) -> dict[str, Any]:
        config = self._config()
        generation = config.setdefault("generation", {})
        if not isinstance(generation, dict):
            config["generation"] = {}
            generation = config["generation"]
        return generation

    def _schema(self) -> dict[str, Any]:
        try:
            return json.loads((PLUGIN_DIR / "_conf_schema.json").read_text(encoding="utf-8-sig"))
        except Exception:
            logger.exception("[GeneralRawImage] failed to read schema")
            return {}

    def _config_snapshot(self) -> dict[str, Any]:
        config = self._config()
        return copy.deepcopy({key: config.get(key) for key in config.keys()})

    def _persist_and_reload(self) -> None:
        config = self._config()
        save = getattr(config, "save_config", None)
        if callable(save):
            save(replace_config=self._config_snapshot())
        reload_config = getattr(self.plugin.config_manager, "reload", None)
        if callable(reload_config):
            reload_config()

    def _current_path(self) -> str:
        value = self._generation_config().get("start_task_image_path")
        if isinstance(value, list):
            for item in value:
                image_path = str(item or "").strip()
                if image_path:
                    return image_path
            return ""
        return str(value or "").strip()

    def _save_path(self, image_path: str) -> dict[str, Any]:
        image_path = str(image_path or "").strip()
        generation = self._generation_config()
        generation["start_task_image_path"] = [image_path] if image_path else []
        self._persist_and_reload()
        return {"start_task_image_path": image_path}

    async def page_bootstrap(self):
        return self._jsonify({
            "ok": True,
            "data": {
                "schema": self._schema(),
                "config": self._config_snapshot(),
                "start_task_image_path": self._current_path(),
                "upload_dir": str(UPLOAD_DIR),
            },
        })

    async def page_save_config(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        config = payload.get("config")
        if not isinstance(config, dict):
            raise ValueError("config must be object")
        current_config = self._config()
        current_config.clear()
        current_config.update(copy.deepcopy(config))
        self._persist_and_reload()
        return self._jsonify({
            "ok": True,
            "message": "配置已保存",
            "data": {"config": self._config_snapshot(), "start_task_image_path": self._current_path()},
        })

    async def page_save_start_image_path(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        result = self._save_path(payload.get("path", ""))
        return self._jsonify({"ok": True, "message": "开始绘图回复图片路径已保存", "data": result})

    def _decode_upload_image(self, payload: dict[str, Any]) -> tuple[str, bytes]:
        filename = str(payload.get("filename") or "start_task_image").strip()
        content_type = str(payload.get("content_type") or "").strip().lower()
        data_url = str(payload.get("data") or "")
        if not data_url:
            raise ValueError("missing image data")
        if "," in data_url:
            header, data_part = data_url.split(",", 1)
            match = re.search(r"data:([^;]+);base64", header, re.I)
            if match:
                content_type = match.group(1).lower()
        else:
            data_part = data_url
        extension = IMAGE_EXTENSIONS.get(content_type)
        if not extension:
            suffix = Path(filename).suffix.lower()
            extension = suffix if suffix in IMAGE_EXTENSIONS.values() else ".png"
        image_bytes = base64.b64decode(data_part)
        if not image_bytes:
            raise ValueError("empty image data")
        if len(image_bytes) > 20 * 1024 * 1024:
            raise ValueError("图片过大，请选择 20MB 以内的图片")
        safe_name = re.sub(r"[^0-9A-Za-z_.-]+", "_", Path(filename).stem or "start_task_image")[:60]
        return f"{safe_name}_{int(time.time())}{extension}", image_bytes

    def _save_uploaded_image(self, payload: dict[str, Any]) -> tuple[Path, str]:
        filename, image_bytes = self._decode_upload_image(payload)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        save_path = UPLOAD_DIR / filename
        save_path.write_bytes(image_bytes)
        rel_path = (START_TASK_IMAGE_REL_DIR / filename).as_posix()
        return save_path, rel_path

    def _background_file_to_data_uri(self, value: str) -> str:
        if not value or value.startswith("data:"):
            return value
        if not value.startswith("./backgrounds/"):
            return value
        path = PLUGIN_DIR / "pages" / "settings" / value.removeprefix("./")
        if not path.exists():
            return value
        ext = path.suffix.lower()
        mime = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
        }.get(ext, "image/png")
        return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")

    def _ui_state(self) -> dict[str, Any]:
        default = {
            "palette_mode": "luxury",
            "appearance_mode": "auto",
            "background_mode": "preset",
            "custom_background_url": "",
        }
        try:
            data = json.loads(UI_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                default.update({key: data.get(key, default[key]) for key in default})
        except Exception:
            pass
        default["custom_background_url"] = self._background_file_to_data_uri(
            str(default.get("custom_background_url") or "")
        )
        return default

    def _save_ui_state(self, patch: dict[str, Any]) -> dict[str, Any]:
        state = self._ui_state()
        for key in ("palette_mode", "appearance_mode", "background_mode", "custom_background_url"):
            if key in patch:
                state[key] = str(patch.get(key) or "")
        if state["background_mode"] not in {"preset", "custom"}:
            state["background_mode"] = "preset"
        if state["appearance_mode"] not in {"auto", "dark", "light"}:
            state["appearance_mode"] = "auto"
        if state["palette_mode"] not in {"luxury", "bluewhite", "vivid", "void"}:
            state["palette_mode"] = "luxury"
        UI_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        UI_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        return state

    async def page_get_ui_state(self):
        return self._jsonify({"ok": True, "data": {"state": self._ui_state()}})

    async def page_save_ui_state(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        return self._jsonify({"ok": True, "data": {"state": self._save_ui_state(payload)}})

    async def page_upload_background(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        data_url = str(payload.get("data") or "")
        if not data_url:
            raise ValueError("missing image data")
        filename, image_bytes = self._decode_upload_image(payload)
        BACKGROUND_DIR.mkdir(parents=True, exist_ok=True)
        save_path = BACKGROUND_DIR / filename
        save_path.write_bytes(image_bytes)
        # AstrBot 插件页不一定会暴露运行时新建静态目录；使用 data URI 持久化，确保刷新后立即可显示。
        state = self._save_ui_state({"custom_background_url": data_url, "background_mode": "custom"})
        return self._jsonify({
            "ok": True,
            "message": "背景已上传",
            "data": {"url": data_url, "filename": save_path.name, "state": state},
        })

    async def page_upload_start_image(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        save_path, rel_path = self._save_uploaded_image(payload)
        result = self._save_path(rel_path)
        result["filename"] = save_path.name
        return self._jsonify({"ok": True, "message": "图片已选择并写入路径", "data": result})

    async def page_upload_image_only(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        save_path, rel_path = self._save_uploaded_image(payload)
        return self._jsonify({
            "ok": True,
            "message": "图片已上传",
            "data": {"path": rel_path, "filename": save_path.name},
        })
