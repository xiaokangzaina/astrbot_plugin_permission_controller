import asyncio
import unittest

from astrbot_plugin_group_aip_review.main import GroupAipReviewPlugin


class FakeContext:
    def __init__(self, config):
        self._config = config

    def get_config(self):
        return self._config


class FakeEvent:
    def __init__(self, sender_id, is_admin=False):
        self._sender_id = sender_id
        self._is_admin = is_admin

    def get_sender_id(self):
        return self._sender_id

    def is_admin(self):
        return self._is_admin


class FakeMessageObj:
    raw_message = {
        "group_name": "测试群",
        "sender": {
            "nickname": "测试用户",
            "user_id": "211928243",
            "role": "member",
        },
        "message": [],
    }


class FakeGroupEvent(FakeEvent):
    message_str = "需要审核的文本"
    message_obj = FakeMessageObj()

    def get_group_id(self):
        return "885430326"

    def get_platform_name(self):
        return "aiocqhttp"

    def get_messages(self):
        return []


def make_plugin(admins_id):
    plugin = object.__new__(GroupAipReviewPlugin)
    plugin.context = FakeContext({"admins_id": admins_id})
    plugin.config = {"disposal": {"group_custom": []}}
    return plugin


class PlatformAdminSkipTest(unittest.TestCase):
    def test_runtime_admin_id_is_platform_admin(self):
        plugin = make_plugin(["astrbot", "211928243"])

        self.assertTrue(plugin._is_platform_admin(FakeEvent("211928243")))

    def test_event_admin_role_is_platform_admin(self):
        plugin = make_plugin([])

        self.assertTrue(plugin._is_platform_admin(FakeEvent("123456", is_admin=True)))

    def test_non_admin_is_not_platform_admin(self):
        plugin = make_plugin(["211928243"])

        self.assertFalse(plugin._is_platform_admin(FakeEvent("999999")))

    def test_admin_message_does_not_reach_text_audit(self):
        plugin = make_plugin(["211928243"])
        calls = []

        async def fake_audit_text(*args):
            calls.append(args)

        plugin.audit_api = object()
        plugin._is_group_enabled = lambda group_id: True
        plugin.get_group_config = lambda group_id: {
            "debug_trace": False,
            "enable_text_censor": True,
            "enable_image_censor": True,
            "skip_admin_messages": False,
        }
        plugin._audit_text = fake_audit_text

        asyncio.run(plugin._handle_incoming_group_message(FakeGroupEvent("211928243")))

        self.assertEqual(calls, [])

    def test_non_admin_message_still_reaches_text_audit(self):
        plugin = make_plugin(["211928243"])
        calls = []

        async def fake_audit_text(*args):
            calls.append(args)

        plugin.audit_api = object()
        plugin._is_group_enabled = lambda group_id: True
        plugin.get_group_config = lambda group_id: {
            "debug_trace": False,
            "enable_text_censor": True,
            "enable_image_censor": True,
            "skip_admin_messages": False,
        }
        plugin._audit_text = fake_audit_text

        asyncio.run(plugin._handle_incoming_group_message(FakeGroupEvent("999999")))

        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
