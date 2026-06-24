import asyncio
import unittest

from astrbot_plugin_permission_controller.page_service import PermissionPageService


class FakeClient:
    def __init__(self, responses=None, fail=False):
        self.responses = responses or {}
        self.fail = fail

    async def call_action(self, action):
        if self.fail:
            raise RuntimeError("platform unavailable")
        return self.responses.get(action, [])


class FakePlugin:
    def __init__(self, config):
        self.config = config


def make_service(config, clients):
    service = PermissionPageService(FakePlugin(config))
    service._iter_qq_clients = lambda: clients
    return service


class PageServiceLiveListsTest(unittest.TestCase):
    def test_live_group_list_does_not_include_stale_configured_group(self):
        service = make_service(
            {
                "group_chat_settings": {
                    "allowed_groups": ["old_group", "live_group"],
                    "simple_rules": ["123-old_group"],
                    "group_deny_rules": [],
                },
                "reasoning_settings": {
                    "reasoning_group_defaults": ["old_group=ultra"],
                    "reasoning_group_user_rules": [],
                },
            },
            [
                FakeClient(
                    {
                        "get_group_list": [
                            {
                                "group_id": "live_group",
                                "group_name": "仍在的群",
                                "member_count": 10,
                                "max_member_count": 500,
                            }
                        ]
                    }
                )
            ],
        )

        groups = asyncio.run(service.list_groups())

        self.assertEqual([item["group_id"] for item in groups], ["live_group"])

    def test_group_list_falls_back_to_config_when_live_fetch_fails(self):
        service = make_service(
            {
                "group_chat_settings": {
                    "allowed_groups": ["configured_group"],
                    "simple_rules": [],
                    "group_deny_rules": [],
                }
            },
            [FakeClient(fail=True)],
        )

        groups = asyncio.run(service.list_groups())

        self.assertEqual([item["group_id"] for item in groups], ["configured_group"])
        self.assertEqual(groups[0]["source"], "configured")

    def test_live_friend_list_does_not_include_stale_configured_friend(self):
        service = make_service(
            {
                "private_chat_settings": {
                    "private_chat_users": ["old_user", "live_user"],
                },
                "reasoning_settings": {
                    "reasoning_private_users": ["old_user=ultra"],
                },
            },
            [
                FakeClient(
                    {
                        "get_friend_list": [
                            {
                                "user_id": "live_user",
                                "nickname": "仍在的好友",
                                "remark": "",
                            }
                        ]
                    }
                )
            ],
        )

        contacts = asyncio.run(service.list_private_contacts())

        self.assertEqual([item["user_id"] for item in contacts], ["live_user"])

    def test_friend_list_falls_back_to_config_when_live_fetch_fails(self):
        service = make_service(
            {
                "private_chat_settings": {
                    "private_chat_users": ["configured_user"],
                }
            },
            [FakeClient(fail=True)],
        )

        contacts = asyncio.run(service.list_private_contacts())

        self.assertEqual([item["user_id"] for item in contacts], ["configured_user"])
        self.assertEqual(contacts[0]["source"], "configured")


if __name__ == "__main__":
    unittest.main()
