import asyncio
import functools
import unittest

from astrbot_plugin_permission_controller.main import GroupUserWhitelistPlugin


class DummyBundledPlugin:
    async def on_platform_loaded(self):
        return "loaded"

    async def on_message(self, event):
        return event


def make_plugin():
    plugin = object.__new__(GroupUserWhitelistPlugin)
    plugin._fusion_event_enabled = lambda plugin_id, event: True
    return plugin


class FusionHandlerBindingTest(unittest.TestCase):
    def test_no_arg_hook_is_not_bound_twice(self):
        plugin = make_plugin()
        instance = DummyBundledPlugin()

        first = plugin._wrap_bundled_callable(
            "qqadmin",
            plugin._bind_bundled_instance_once(
                DummyBundledPlugin.on_platform_loaded,
                instance,
            ),
        )
        second = plugin._wrap_bundled_callable(
            "qqadmin",
            plugin._bind_bundled_instance_once(first, instance),
        )

        self.assertIs(second, first)
        self.assertEqual(asyncio.run(second()), "loaded")

    def test_message_handler_is_not_bound_twice(self):
        plugin = make_plugin()
        instance = DummyBundledPlugin()

        first = plugin._wrap_bundled_callable(
            "review",
            plugin._bind_bundled_instance_once(DummyBundledPlugin.on_message, instance),
        )
        second = plugin._wrap_bundled_callable(
            "review",
            plugin._bind_bundled_instance_once(first, instance),
        )

        self.assertIs(second, first)
        self.assertEqual(asyncio.run(second("event")), "event")

    def test_partial_of_wrapped_callable_is_healed(self):
        plugin = make_plugin()
        instance = DummyBundledPlugin()
        wrapped = plugin._wrap_bundled_callable(
            "qqadmin",
            plugin._bind_bundled_instance_once(
                DummyBundledPlugin.on_platform_loaded,
                instance,
            ),
        )

        broken_nested_partial = functools.partial(wrapped, instance)
        healed = plugin._wrap_bundled_callable("qqadmin", broken_nested_partial)

        self.assertIs(healed, wrapped)
        self.assertEqual(asyncio.run(healed()), "loaded")


if __name__ == "__main__":
    unittest.main()
