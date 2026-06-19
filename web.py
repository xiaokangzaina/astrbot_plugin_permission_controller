from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlencode
from urllib.request import urlopen

from astrbot.api import logger
from astrbot.api.star import Context

try:
    from quart import jsonify as quart_jsonify
    from quart import request as quart_request_obj
except ImportError:
    quart_jsonify = None
    quart_request_obj = None

from .page_service import PermissionPageService

PLUGIN_NAME = "astrbot_plugin_permission_controller"
PLUGIN_DIR = Path(__file__).resolve().parent
THEME_STATE_FILE = PLUGIN_DIR / "data" / "settings_theme.json"
VALID_THEME_MODES = {"auto", "light", "dark"}


def _read_theme_preference() -> str:
    try:
        payload = json.loads(THEME_STATE_FILE.read_text(encoding="utf-8"))
        value = str(payload.get("theme", "auto")).strip().lower()
        if value in VALID_THEME_MODES:
            return value
    except Exception:
        pass
    return "auto"


def _write_theme_preference(value: str) -> str:
    theme = str(value or "auto").strip().lower()
    if theme not in VALID_THEME_MODES:
        raise ValueError("invalid theme mode")
    THEME_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    THEME_STATE_FILE.write_text(
        json.dumps({"theme": theme}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return theme


class PermissionWebController:
    """权限控制器配置页的 Web API 控制器。"""

    def __init__(self, context: Context, plugin: Any):
        self.context = context
        self.service = PermissionPageService(plugin)

    def register_routes(self) -> None:
        routes = [
            ("/ping", self.page_ping, ["GET"], "Page ping"),
            (
                "/settings/bootstrap",
                self.page_bootstrap,
                ["GET"],
                "Load permission settings bootstrap data",
            ),
            (
                "/settings/weather",
                self.page_weather,
                ["GET"],
                "Proxy current weather by browser location",
            ),
            (
                "/settings/theme",
                self.page_get_theme,
                ["GET"],
                "Load settings page theme preference",
            ),
            (
                "/settings/theme",
                self.page_save_theme,
                ["POST"],
                "Save settings page theme preference",
            ),
            (
                "/settings/groups/refresh",
                self.page_refresh_groups,
                ["POST"],
                "Refresh QQ group list",
            ),
            (
                "/settings/private/refresh",
                self.page_refresh_private_contacts,
                ["POST"],
                "Refresh QQ friend list",
            ),
            ("/settings/private", self.page_get_private_contact, ["GET"], "Load one private contact config"),
            (
                "/settings/private",
                self.page_update_private_contact,
                ["POST"],
                "Update one private contact config",
            ),
            (
                "/settings/private/reset",
                self.page_reset_private_contact,
                ["POST"],
                "Reset one private contact config",
            ),
            ("/settings/group", self.page_get_group, ["GET"], "Load one group config"),
            (
                "/settings/group",
                self.page_update_group,
                ["POST"],
                "Update one group config",
            ),
            (
                "/settings/group/reset",
                self.page_reset_group,
                ["POST"],
                "Reset one group config",
            ),
            (
                "/settings/save",
                self.page_save,
                ["POST"],
                "Save permission settings",
            ),
            (
                "/settings/reset",
                self.page_reset,
                ["POST"],
                "Reset permission settings to default",
            ),
        ]
        for path, handler, methods, desc in routes:
            self.context.register_web_api(
                f"/{PLUGIN_NAME}{path}",
                self._wrap_handler(handler),
                methods,
                desc,
            )

    @staticmethod
    def _check_quart_available() -> None:
        if quart_jsonify is None or quart_request_obj is None:
            raise RuntimeError("Web framework is unavailable")

    @staticmethod
    def _jsonify(payload: dict[str, Any]):
        PermissionWebController._check_quart_available()
        return cast(Callable[[dict[str, Any]], Any], quart_jsonify)(payload)

    @staticmethod
    def _request():
        PermissionWebController._check_quart_available()
        return cast(Any, quart_request_obj)

    def _wrap_handler(
        self, handler: Callable[[], Awaitable]
    ) -> Callable[[], Awaitable]:
        async def wrapped():
            self._check_quart_available()
            try:
                return await handler()
            except ValueError as exc:
                return self._jsonify({"ok": False, "message": str(exc)}), 400
            except Exception as exc:
                logger.exception("[PermissionController] page request failed")
                return self._jsonify({"ok": False, "message": str(exc)}), 500

        wrapped.__name__ = handler.__name__
        return wrapped

    async def page_ping(self):
        return self._jsonify({"ok": True, "message": "pong"})

    async def page_bootstrap(self):
        return self._jsonify(
            {"ok": True, "data": self.service.get_bootstrap_payload()}
        )

    async def page_weather(self):
        args = self._request().args
        try:
            latitude = float(args.get("latitude", ""))
            longitude = float(args.get("longitude", ""))
        except (TypeError, ValueError):
            raise ValueError("invalid location")
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise ValueError("invalid location")
        query = urlencode(
            {
                "latitude": latitude,
                "longitude": longitude,
                "current": "temperature_2m,weather_code",
                "timezone": "auto",
            }
        )
        url = f"https://api.open-meteo.com/v1/forecast?{query}"
        payload = await asyncio.to_thread(self._fetch_weather_payload, url)
        current = payload.get("current") or {}
        return self._jsonify(
            {
                "ok": True,
                "data": {
                    "temperature": current.get("temperature_2m"),
                    "weather_code": current.get("weather_code"),
                    "time": current.get("time"),
                },
            }
        )

    @staticmethod
    def _fetch_weather_payload(url: str) -> dict[str, Any]:
        with urlopen(url, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    async def page_get_theme(self):
        return self._jsonify(
            {
                "ok": True,
                "data": {
                    "theme": _read_theme_preference(),
                    "persisted": THEME_STATE_FILE.exists(),
                },
            }
        )

    async def page_save_theme(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        theme = _write_theme_preference(payload.get("theme", "auto"))
        return self._jsonify({"ok": True, "data": {"theme": theme}})

    async def page_refresh_groups(self):
        groups = await self.service.list_groups(force=True)
        return self._jsonify({"ok": True, "data": groups})

    async def page_refresh_private_contacts(self):
        contacts = await self.service.list_private_contacts(force=True)
        return self._jsonify({"ok": True, "data": contacts})

    async def page_get_private_contact(self):
        user_id = self._request().args.get("user_id", "")
        return self._jsonify(
            {"ok": True, "data": self.service.get_private_contact_config(user_id)}
        )

    async def page_update_private_contact(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        user_id = payload.get("user_id", "")
        config = payload.get("config", {})
        result = self.service.update_private_contact_config(user_id, config)
        return self._jsonify({"ok": True, "message": "私聊配置已保存", "data": result})

    async def page_reset_private_contact(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        result = self.service.reset_private_contact_config(payload.get("user_id", ""))
        return self._jsonify({"ok": True, "message": "私聊配置已重置", "data": result})

    async def page_get_group(self):
        group_id = self._request().args.get("group_id", "")
        return self._jsonify(
            {"ok": True, "data": self.service.get_group_config(group_id)}
        )

    async def page_update_group(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        group_id = payload.get("group_id", "")
        config = payload.get("config", {})
        result = self.service.update_group_config(group_id, config)
        return self._jsonify({"ok": True, "message": "群配置已保存", "data": result})

    async def page_reset_group(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        result = self.service.reset_group_config(payload.get("group_id", ""))
        return self._jsonify({"ok": True, "message": "群配置已重置", "data": result})

    async def page_save(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        config = payload.get("config", payload)
        result = self.service.update_config(config)
        return self._jsonify(
            {"ok": True, "message": "配置已保存", "data": result}
        )

    async def page_reset(self):
        result = self.service.reset_config()
        return self._jsonify(
            {"ok": True, "message": "已恢复默认配置", "data": result}
        )
