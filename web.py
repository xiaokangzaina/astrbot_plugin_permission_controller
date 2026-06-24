from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlencode
from urllib.request import Request, urlopen

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
TONE_STATE_FILE = PLUGIN_DIR / "data" / "settings_tone.json"
BACKGROUND_STATE_FILE = PLUGIN_DIR / "data" / "settings_background.json"
BACKGROUND_MEDIA_DIR = PLUGIN_DIR / "data" / "backgrounds"
FUSION_OVERRIDES_FILE = PLUGIN_DIR / "data" / "fusion_overrides.json"
VALID_THEME_MODES = {"auto", "light", "dark"}
VALID_FUSION_TARGET_TYPES = {"global", "groups", "privates"}
FUSION_ACCESS_STATUS_FIELDS = {
    "raw-image": {
        "providers": [
            "fusion_access.enabled",
            "fusion_access.enable_groups",
            "fusion_access.enable_privates",
        ],
    },
    "aip-review": {
        "global-policy": [
            "fusion_access.enabled",
            "fusion_access.enable_groups",
            "fusion_access.enable_privates",
        ],
    },
    "webshot": {
        "targets": [
            "fusion_access.enabled",
            "fusion_access.enable_groups",
            "fusion_access.enable_privates",
        ],
    },
    "qqadmin": {
        "actions": ["default.group_admin_enabled"],
    },
}
VALID_BACKGROUND_MIME_TYPES = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
MAX_BACKGROUND_BYTES = 12 * 1024 * 1024

DEFAULT_BACKGROUND_STATE = {
    "enabled": False,
    "file_name": "",
    "media_file": "",
    "media_type": "",
    "crop_x": 50,
    "crop_y": 50,
    "overlay": 0.42,
    "blur": 0,
    "updated_at": 0,
}

DEFAULT_TONE_STATE = {
    "primary": "#25d8ff",
    "secondary": "#8b74ff",
    "glow": "#ff6fa9",
    "backdropCard": "#5c78c8",
    "panelOpacity": 0.22,
    "updated_at": 0,
}


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


def _normalize_hex_color(value: Any, default: str) -> str:
    text = str(value or "").strip().lower()
    if len(text) == 7 and text.startswith("#"):
        digits = text[1:]
        if all(char in "0123456789abcdef" for char in digits):
            return text
    return default


def _normalize_tone_state(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    source = {**DEFAULT_TONE_STATE, **(payload or {})}
    return {
        "primary": _normalize_hex_color(source.get("primary"), DEFAULT_TONE_STATE["primary"]),
        "secondary": _normalize_hex_color(source.get("secondary"), DEFAULT_TONE_STATE["secondary"]),
        "glow": _normalize_hex_color(source.get("glow"), DEFAULT_TONE_STATE["glow"]),
        "backdropCard": _normalize_hex_color(source.get("backdropCard"), DEFAULT_TONE_STATE["backdropCard"]),
        "panelOpacity": round(_clamp_number(source.get("panelOpacity"), DEFAULT_TONE_STATE["panelOpacity"], 0.04, 0.38), 3),
        "updated_at": int(source.get("updated_at") or 0),
    }


def _read_tone_state() -> dict[str, Any]:
    try:
        payload = json.loads(TONE_STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return _normalize_tone_state(payload)
    except Exception:
        pass
    return _normalize_tone_state()


def _write_tone_state(payload: dict[str, Any]) -> dict[str, Any]:
    tone_payload = payload.get("tone") if isinstance(payload.get("tone"), dict) else payload
    state = _normalize_tone_state(cast(dict[str, Any], tone_payload or {}))
    state["updated_at"] = int(time.time())
    TONE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    TONE_STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return state


def _clamp_number(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _read_background_state(include_data_url: bool = False) -> dict[str, Any]:
    state = dict(DEFAULT_BACKGROUND_STATE)
    try:
        payload = json.loads(BACKGROUND_STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            state.update(payload)
    except Exception:
        pass

    state["enabled"] = bool(state.get("enabled"))
    state["crop_x"] = round(_clamp_number(state.get("crop_x"), 50, 0, 100), 2)
    state["crop_y"] = round(_clamp_number(state.get("crop_y"), 50, 0, 100), 2)
    state["overlay"] = round(_clamp_number(state.get("overlay"), 0.42, 0.18, 0.72), 2)
    state["blur"] = round(_clamp_number(state.get("blur"), 0, 0, 36), 2)
    media_file = str(state.get("media_file") or "")
    media_path = BACKGROUND_MEDIA_DIR / media_file if media_file else None
    has_media = bool(media_path and media_path.exists() and media_path.is_file())
    if not has_media:
        state["enabled"] = False
        state["media_file"] = ""
        state["media_type"] = ""
    if include_data_url and has_media:
        media_type = str(state.get("media_type") or "image/png")
        data = base64.b64encode(media_path.read_bytes()).decode("ascii")
        state["data_url"] = f"data:{media_type};base64,{data}"
    return state


def _write_background_state(state: dict[str, Any]) -> dict[str, Any]:
    BACKGROUND_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    persisted = {
        key: value
        for key, value in state.items()
        if key in DEFAULT_BACKGROUND_STATE and key != "data_url"
    }
    BACKGROUND_STATE_FILE.write_text(
        json.dumps(persisted, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return _read_background_state(include_data_url=True)


def _remove_background_media() -> None:
    if not BACKGROUND_MEDIA_DIR.exists():
        return
    for item in BACKGROUND_MEDIA_DIR.iterdir():
        if item.is_file() and item.name.startswith("custom_background"):
            try:
                item.unlink()
            except OSError:
                pass


def _decode_background_data_url(data_url: Any) -> tuple[str, bytes]:
    text = str(data_url or "")
    header, separator, encoded = text.partition(",")
    if separator != "," or not header.startswith("data:") or ";base64" not in header:
        raise ValueError("background must be a base64 data URL")
    media_type = header[5:].split(";", 1)[0].strip().lower()
    if media_type not in VALID_BACKGROUND_MIME_TYPES:
        raise ValueError("background must be GIF, PNG, JPG, or WebP")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("background file is not valid base64") from exc
    if not content:
        raise ValueError("background file is empty")
    if len(content) > MAX_BACKGROUND_BYTES:
        raise ValueError("background file must be 12 MB or smaller")
    return media_type, content


def _write_background_preference(payload: dict[str, Any]) -> dict[str, Any]:
    state = _read_background_state(include_data_url=False)
    state["enabled"] = bool(payload.get("enabled", state.get("enabled")))
    state["crop_x"] = round(_clamp_number(payload.get("crop_x"), state["crop_x"], 0, 100), 2)
    state["crop_y"] = round(_clamp_number(payload.get("crop_y"), state["crop_y"], 0, 100), 2)
    state["overlay"] = round(_clamp_number(payload.get("overlay"), state["overlay"], 0.18, 0.72), 2)
    state["blur"] = round(_clamp_number(payload.get("blur"), state["blur"], 0, 36), 2)

    data_url = payload.get("data_url")
    if data_url:
        media_type, content = _decode_background_data_url(data_url)
        BACKGROUND_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        _remove_background_media()
        media_file = f"custom_background{VALID_BACKGROUND_MIME_TYPES[media_type]}"
        (BACKGROUND_MEDIA_DIR / media_file).write_bytes(content)
        state.update(
            {
                "enabled": True,
                "file_name": str(payload.get("file_name") or media_file)[:180],
                "media_file": media_file,
                "media_type": media_type,
            }
        )
    if not state.get("media_file"):
        state["enabled"] = False
    state["updated_at"] = int(time.time())
    return _write_background_state(state)


def _reset_background_preference() -> dict[str, Any]:
    _remove_background_media()
    return _write_background_state(dict(DEFAULT_BACKGROUND_STATE))


def _read_fusion_overrides() -> dict[str, Any]:
    try:
        payload = json.loads(FUSION_OVERRIDES_FILE.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            payload.setdefault("version", 1)
            payload.setdefault("plugins", {})
            return payload
    except Exception:
        pass
    return {"version": 1, "plugins": {}}


def _write_fusion_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    FUSION_OVERRIDES_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload["version"] = 1
    payload.setdefault("plugins", {})
    FUSION_OVERRIDES_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def _fusion_access_index(state: dict[str, Any]) -> dict[str, Any]:
    plugins = state.get("plugins", {})
    if not isinstance(plugins, dict):
        return {}

    result: dict[str, Any] = {}
    for plugin_id, module_paths in FUSION_ACCESS_STATUS_FIELDS.items():
        plugin_bucket = plugins.get(plugin_id, {})
        if not isinstance(plugin_bucket, dict):
            continue
        for target_type in VALID_FUSION_TARGET_TYPES:
            type_bucket = plugin_bucket.get(target_type, {})
            if not isinstance(type_bucket, dict):
                continue
            for target_id, target_bucket in type_bucket.items():
                if not isinstance(target_bucket, dict):
                    continue
                modules = target_bucket.get("modules", {})
                if not isinstance(modules, dict):
                    continue
                for module_id, watched_paths in module_paths.items():
                    module = modules.get(module_id, {})
                    values = module.get("values", {}) if isinstance(module, dict) else {}
                    if not isinstance(values, dict):
                        continue
                    indexed_values = {
                        path: values[path]
                        for path in watched_paths
                        if path in values
                    }
                    if not indexed_values:
                        continue
                    result.setdefault(plugin_id, {}).setdefault(target_type, {}).setdefault(
                        str(target_id),
                        {},
                    )[module_id] = indexed_values
    return result


def _normalize_fusion_target(target_type: Any, target_id: Any) -> tuple[str, str]:
    normalized_type = str(target_type or "global").strip().lower()
    if normalized_type not in VALID_FUSION_TARGET_TYPES:
        raise ValueError("invalid fusion target type")
    normalized_id = str(target_id or "").strip()
    if normalized_type == "global":
        normalized_id = normalized_id or "default"
    if not normalized_id:
        raise ValueError("target_id must not be empty")
    return normalized_type, normalized_id


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
                "/settings/weather/ip",
                self.page_weather_by_ip,
                ["GET"],
                "Proxy current weather by backend IP location",
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
                "/settings/tone",
                self.page_get_tone,
                ["GET"],
                "Load settings page tone preference",
            ),
            (
                "/settings/tone",
                self.page_save_tone,
                ["POST"],
                "Save settings page tone preference",
            ),
            (
                "/settings/background",
                self.page_get_background,
                ["GET"],
                "Load settings page custom background",
            ),
            (
                "/settings/background",
                self.page_save_background,
                ["POST"],
                "Save settings page custom background",
            ),
            (
                "/settings/background/reset",
                self.page_reset_background,
                ["POST"],
                "Reset settings page custom background",
            ),
            (
                "/settings/fusion",
                self.page_fusion_status,
                ["GET"],
                "Load merged plugin status",
            ),
            (
                "/settings/fusion/config",
                self.page_get_fusion_config,
                ["GET"],
                "Load merged plugin inline config",
            ),
            (
                "/settings/fusion/config",
                self.page_save_fusion_config,
                ["POST"],
                "Save merged plugin inline config",
            ),
            (
                "/settings/fusion/config/reset",
                self.page_reset_fusion_config,
                ["POST"],
                "Reset merged plugin inline config",
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

    async def page_fusion_status(self):
        status_loader = getattr(self.service.plugin, "get_bundled_plugin_status", None)
        if not callable(status_loader):
            raise RuntimeError("fusion status is unavailable")
        state = _read_fusion_overrides()
        return self._jsonify(
            {
                "ok": True,
                "data": {
                    "plugins": status_loader(),
                    "access_index": _fusion_access_index(state),
                },
            }
        )

    def _fusion_plugin_status(self, plugin_id: Any) -> dict[str, Any]:
        status_loader = getattr(self.service.plugin, "get_bundled_plugin_status", None)
        if not callable(status_loader):
            raise RuntimeError("fusion status is unavailable")
        wanted = str(plugin_id or "").strip()
        if not wanted:
            raise ValueError("plugin_id must not be empty")
        for item in status_loader():
            item_id = str(item.get("id", ""))
            directory = str(item.get("directory", ""))
            if wanted in {item_id, directory}:
                return dict(item)
        raise ValueError("unknown fusion plugin")

    @staticmethod
    def _read_fusion_schema(directory: str) -> dict[str, Any]:
        schema_path = PLUGIN_DIR / "bundled_plugins" / directory / "_conf_schema.json"
        if not schema_path.exists():
            return {}
        payload = json.loads(schema_path.read_text(encoding="utf-8-sig") or "{}")
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _fusion_target_modules(
        state: dict[str, Any],
        plugin_id: str,
        target_type: str,
        target_id: str,
        create: bool = False,
    ) -> dict[str, Any]:
        plugins = state.setdefault("plugins", {}) if create else state.get("plugins", {})
        if not isinstance(plugins, dict):
            return {}
        plugin_bucket = (
            plugins.setdefault(plugin_id, {}) if create else plugins.get(plugin_id, {})
        )
        if not isinstance(plugin_bucket, dict):
            return {}
        type_bucket = (
            plugin_bucket.setdefault(target_type, {}) if create else plugin_bucket.get(target_type, {})
        )
        if not isinstance(type_bucket, dict):
            return {}
        target_bucket = (
            type_bucket.setdefault(target_id, {}) if create else type_bucket.get(target_id, {})
        )
        if not isinstance(target_bucket, dict):
            return {}
        modules = target_bucket.setdefault("modules", {}) if create else target_bucket.get("modules", {})
        return modules if isinstance(modules, dict) else {}

    async def page_get_fusion_config(self):
        args = self._request().args
        plugin_status = self._fusion_plugin_status(args.get("plugin_id", ""))
        plugin_id = str(plugin_status.get("id") or "")
        directory = str(plugin_status.get("directory") or "")
        target_type, target_id = _normalize_fusion_target(
            args.get("target_type", "global"),
            args.get("target_id", "default"),
        )
        state = _read_fusion_overrides()
        modules = self._fusion_target_modules(state, plugin_id, target_type, target_id)
        return self._jsonify(
            {
                "ok": True,
                "data": {
                    "plugin": plugin_status,
                    "schema": self._read_fusion_schema(directory),
                    "target": {"type": target_type, "id": target_id},
                    "modules": modules,
                    "updated_at": int(
                        max(
                            (
                                float(item.get("updated_at", 0))
                                for item in modules.values()
                                if isinstance(item, dict)
                            ),
                            default=0,
                        )
                    ),
                },
            }
        )

    async def page_save_fusion_config(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        plugin_status = self._fusion_plugin_status(payload.get("plugin_id", ""))
        plugin_id = str(plugin_status.get("id") or "")
        module_id = str(payload.get("module_id") or "").strip()
        if not module_id:
            raise ValueError("module_id must not be empty")
        values = payload.get("values", {})
        if not isinstance(values, dict):
            raise ValueError("values must be object")
        target_type, target_id = _normalize_fusion_target(
            payload.get("target_type", "global"),
            payload.get("target_id", "default"),
        )
        state = _read_fusion_overrides()
        modules = self._fusion_target_modules(
            state,
            plugin_id,
            target_type,
            target_id,
            create=True,
        )
        modules[module_id] = {
            "values": values,
            "updated_at": int(time.time()),
        }
        _write_fusion_overrides(state)
        return self._jsonify(
            {
                "ok": True,
                "message": "融合覆盖配置已保存",
                "data": {
                    "plugin": plugin_status,
                    "target": {"type": target_type, "id": target_id},
                    "module_id": module_id,
                    "module": modules[module_id],
                },
            }
        )

    async def page_reset_fusion_config(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        plugin_status = self._fusion_plugin_status(payload.get("plugin_id", ""))
        plugin_id = str(plugin_status.get("id") or "")
        module_id = str(payload.get("module_id") or "").strip()
        if not module_id:
            raise ValueError("module_id must not be empty")
        target_type, target_id = _normalize_fusion_target(
            payload.get("target_type", "global"),
            payload.get("target_id", "default"),
        )
        state = _read_fusion_overrides()
        modules = self._fusion_target_modules(
            state,
            plugin_id,
            target_type,
            target_id,
            create=True,
        )
        modules.pop(module_id, None)
        _write_fusion_overrides(state)
        return self._jsonify(
            {
                "ok": True,
                "message": "融合覆盖配置已重置",
                "data": {
                    "plugin": plugin_status,
                    "target": {"type": target_type, "id": target_id},
                    "module_id": module_id,
                    "module": {"values": {}, "updated_at": 0},
                },
            }
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
        return self._jsonify(
            {
                "ok": True,
                "data": await self._get_weather_data(latitude, longitude),
            }
        )

    async def page_weather_by_ip(self):
        location = await asyncio.to_thread(self._fetch_ip_location)
        data = await self._get_weather_data(
            float(location["latitude"]),
            float(location["longitude"]),
        )
        data.update(
            {
                "location_source": "ip",
                "place": location.get("place", ""),
            }
        )
        return self._jsonify({"ok": True, "data": data})

    async def _get_weather_data(self, latitude: float, longitude: float) -> dict[str, Any]:
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
        return {
            "temperature": current.get("temperature_2m"),
            "weather_code": current.get("weather_code"),
            "time": current.get("time"),
        }

    @staticmethod
    def _fetch_weather_payload(url: str) -> dict[str, Any]:
        return PermissionWebController._fetch_json_payload(url, timeout=8)

    @staticmethod
    def _fetch_json_payload(url: str, timeout: int = 8) -> dict[str, Any]:
        request = Request(
            url,
            headers={
                "User-Agent": "astrbot-plugin-permission-controller/1.0",
                "Accept": "application/json",
            },
        )
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _fetch_ip_location() -> dict[str, Any]:
        endpoints = (
            ("https://ipwho.is/", "ipwho"),
            ("https://ipapi.co/json/", "ipapi"),
        )
        last_error: Exception | None = None
        for url, provider in endpoints:
            try:
                payload = PermissionWebController._fetch_json_payload(url, timeout=6)
                if provider == "ipwho":
                    ok = payload.get("success") is not False
                    latitude = payload.get("latitude")
                    longitude = payload.get("longitude")
                    place = " ".join(
                        str(item)
                        for item in (payload.get("city"), payload.get("country"))
                        if item
                    )
                    error = payload.get("message")
                else:
                    ok = not payload.get("error")
                    latitude = payload.get("latitude")
                    longitude = payload.get("longitude")
                    place = " ".join(
                        str(item)
                        for item in (payload.get("city"), payload.get("country_name"))
                        if item
                    )
                    error = payload.get("reason") or payload.get("message")
                latitude = float(latitude)
                longitude = float(longitude)
                if ok and -90 <= latitude <= 90 and -180 <= longitude <= 180:
                    return {
                        "latitude": latitude,
                        "longitude": longitude,
                        "place": place,
                    }
                raise ValueError(str(error or "empty coarse location"))
            except Exception as exc:
                last_error = exc
        raise ValueError(f"粗定位不可用：{last_error}")

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

    async def page_get_tone(self):
        return self._jsonify({"ok": True, "data": _read_tone_state()})

    async def page_save_tone(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        return self._jsonify({"ok": True, "data": _write_tone_state(payload)})

    async def page_get_background(self):
        return self._jsonify(
            {"ok": True, "data": _read_background_state(include_data_url=True)}
        )

    async def page_save_background(self):
        payload = await self._request().get_json(force=True, silent=True) or {}
        return self._jsonify(
            {"ok": True, "data": _write_background_preference(payload)}
        )

    async def page_reset_background(self):
        return self._jsonify(
            {"ok": True, "data": _reset_background_preference()}
        )

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
