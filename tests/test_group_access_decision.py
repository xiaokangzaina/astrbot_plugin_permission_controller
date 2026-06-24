import asyncio
import unittest
from types import SimpleNamespace

from astrbot_plugin_permission_controller.main import GroupUserWhitelistPlugin


class FakeEvent:
    def __init__(self, group_id="885430326", sender_id="211928243", wake=True):
        self._group_id = group_id
        self._sender_id = sender_id
        self.is_at_or_wake_command = wake
        self.message_obj = SimpleNamespace(raw_message={})
        self.platform_meta = SimpleNamespace(name="aiocqhttp")
        self.unified_msg_origin = ""
        self.stopped = False
        self.reasoning_applied = False

    def get_group_id(self):
        return self._group_id

    def get_sender_id(self):
        return self._sender_id

    def stop_event(self):
        self.stopped = True


def make_plugin():
    plugin = object.__new__(GroupUserWhitelistPlugin)
    plugin.enable_group_blacklist = True
    plugin.group_blacklist = set()
    plugin.admin_bypass = True
    plugin.admin_ids = set()
    plugin.enable_group_rules = True
    plugin.deny_rules = {}
    plugin.allowed_groups = set()
    plugin.rules = {}
    plugin._apply_reasoning_effort_for_event = (
        lambda event: setattr(event, "reasoning_applied", True)
    )
    return plugin


class GroupAccessDecisionTest(unittest.TestCase):
    def test_precise_allow_user_in_group(self):
        plugin = make_plugin()
        plugin.rules = {"885430326": {"211928243"}}

        allowed, reason = plugin._decide_group_access("885430326", "211928243")

        self.assertTrue(allowed)
        self.assertEqual(reason, "group_user_allowed")

    def test_precise_deny_overrides_allowed_group(self):
        plugin = make_plugin()
        plugin.allowed_groups = {"885430326"}
        plugin.deny_rules = {"885430326": {"211928243"}}

        allowed, reason = plugin._decide_group_access("885430326", "211928243")

        self.assertFalse(allowed)
        self.assertEqual(reason, "group_user_denied")

    def test_unmatched_user_is_denied_when_group_rules_enabled(self):
        plugin = make_plugin()
        plugin.rules = {"885430326": {"123456"}}

        allowed, reason = plugin._decide_group_access("885430326", "211928243")

        self.assertFalse(allowed)
        self.assertEqual(reason, "no_matching_group_rule")

    def test_admin_bypass_is_preserved(self):
        plugin = make_plugin()
        plugin.admin_ids = {"211928243"}
        plugin.group_blacklist = {"211928243"}
        plugin.deny_rules = {"885430326": {"211928243"}}

        allowed, reason = plugin._decide_group_access("885430326", "211928243")

        self.assertTrue(allowed)
        self.assertEqual(reason, "admin_bypass_group_blacklist")

    def test_non_wake_group_message_is_not_intercepted(self):
        plugin = make_plugin()
        plugin.deny_rules = {"885430326": {"211928243"}}
        event = FakeEvent(wake=False)

        asyncio.run(plugin.check_group_user_whitelist(event))

        self.assertFalse(event.stopped)
        self.assertFalse(event.reasoning_applied)

    def test_allowed_wake_message_applies_reasoning_without_stop(self):
        plugin = make_plugin()
        plugin.rules = {"885430326": {"211928243"}}
        event = FakeEvent(wake=True)

        asyncio.run(plugin.check_group_user_whitelist(event))

        self.assertFalse(event.stopped)
        self.assertTrue(event.reasoning_applied)

    def test_denied_wake_message_is_stopped(self):
        plugin = make_plugin()
        plugin.allowed_groups = {"885430326"}
        plugin.deny_rules = {"885430326": {"211928243"}}
        event = FakeEvent(wake=True)

        asyncio.run(plugin.check_group_user_whitelist(event))

        self.assertTrue(event.stopped)
        self.assertFalse(event.reasoning_applied)


if __name__ == "__main__":
    unittest.main()
