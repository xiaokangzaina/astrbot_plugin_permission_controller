import asyncio
import unittest

from astrbot.core.provider.register import llm_tools
from astrbot.core.star.star_handler import (
    EventType,
    StarHandlerMetadata,
    star_handlers_registry,
)

from astrbot_plugin_permission_controller.main import GroupUserWhitelistPlugin


def make_handler(module_path: str, name: str = "command") -> StarHandlerMetadata:
    def handler():
        return None

    return StarHandlerMetadata(
        event_type=EventType.AdapterMessageEvent,
        handler_full_name=f"{module_path}_{name}",
        handler_name=name,
        handler_module_path=module_path,
        handler=handler,
        event_filters=[],
    )


class DummyTool:
    def __init__(self, module_path: str, handler=None):
        self.handler_module_path = module_path
        self.handler = handler


class FusionDuplicateCleanupTest(unittest.TestCase):
    def setUp(self):
        self._handlers = list(star_handlers_registry)
        self._handler_map = dict(star_handlers_registry.star_handlers_map)
        self._tools = list(llm_tools.func_list)
        star_handlers_registry.clear()
        llm_tools.func_list.clear()

    def tearDown(self):
        star_handlers_registry.clear()
        for handler in self._handlers:
            star_handlers_registry.append(handler)
        star_handlers_registry.star_handlers_map.clear()
        star_handlers_registry.star_handlers_map.update(self._handler_map)
        llm_tools.func_list[:] = self._tools

    def test_removes_standalone_fusion_handlers_and_tools_only(self):
        plugin = object.__new__(GroupUserWhitelistPlugin)
        standalone = make_handler("data.plugins.astrbot_plugin_qqadmin.main", "ban")
        unrelated = make_handler("data.plugins.other_plugin.main", "ban")
        bundled = make_handler(
            "astrbot_plugin_permission_controller.bundled_plugins.astrbot_plugin_qqadmin.main",
            "ban",
        )
        stale = make_handler("data.plugins.astrbot_plugin_general_raw_image_2026.main", "draw")

        star_handlers_registry.append(standalone)
        star_handlers_registry.append(unrelated)
        star_handlers_registry.append(bundled)
        star_handlers_registry.star_handlers_map[stale.handler_full_name] = stale

        def standalone_tool_handler():
            return None

        standalone_tool_handler.__module__ = "data.plugins.astrbot_plugin_qqadmin.main"
        duplicate_tool = DummyTool("data.plugins.astrbot_plugin_group_aip_review.main")
        duplicate_callable_tool = DummyTool("", standalone_tool_handler)
        keep_tool = DummyTool("data.plugins.other_plugin.main")
        llm_tools.func_list.extend([duplicate_tool, duplicate_callable_tool, keep_tool])

        plugin._remove_standalone_fusion_runtime_state()

        self.assertNotIn(standalone, list(star_handlers_registry))
        self.assertIn(unrelated, list(star_handlers_registry))
        self.assertIn(bundled, list(star_handlers_registry))
        self.assertNotIn(stale.handler_full_name, star_handlers_registry.star_handlers_map)
        self.assertNotIn(duplicate_tool, llm_tools.func_list)
        self.assertNotIn(duplicate_callable_tool, llm_tools.func_list)
        self.assertIn(keep_tool, llm_tools.func_list)

    def test_late_cleanup_hooks_remove_and_schedule_followup(self):
        plugin = object.__new__(GroupUserWhitelistPlugin)
        calls = []
        plugin._remove_standalone_fusion_runtime_state = lambda: calls.append("remove")
        plugin._schedule_standalone_fusion_cleanup = lambda: calls.append("schedule")

        asyncio.run(plugin.cleanup_standalone_fusion_runtime_after_plugin_loaded(object()))
        asyncio.run(plugin.cleanup_standalone_fusion_runtime_after_astrbot_loaded())

        self.assertEqual(calls, ["remove", "schedule", "remove", "schedule"])


if __name__ == "__main__":
    unittest.main()
