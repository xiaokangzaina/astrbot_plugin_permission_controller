import json
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_permission_controller.main import GroupUserWhitelistPlugin


class DummyEvent:
    def __init__(self, *, private=False, group_id="", sender_id=""):
        self._private = private
        self._group_id = group_id
        self._sender_id = sender_id
        self.unified_msg_origin = sender_id

    def is_private_chat(self):
        return self._private

    def get_group_id(self):
        return self._group_id

    def get_sender_id(self):
        return self._sender_id


class FusionRuntimeAccessTest(unittest.TestCase):
    def make_plugin(self, payload):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "fusion_overrides.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        plugin = object.__new__(GroupUserWhitelistPlugin)
        plugin._fusion_overrides_path = lambda: path
        return plugin

    def test_group_object_can_disable_bundled_plugin(self):
        plugin = self.make_plugin(
            {
                "version": 1,
                "plugins": {
                    "webshot": {
                        "groups": {
                            "10001": {
                                "modules": {
                                    "targets": {
                                        "values": {"fusion_access.enabled": False}
                                    }
                                }
                            }
                        }
                    }
                },
            }
        )

        event = DummyEvent(group_id="10001", sender_id="20002")
        self.assertFalse(plugin._fusion_event_enabled("webshot", event))

    def test_missing_object_override_keeps_plugin_enabled(self):
        plugin = self.make_plugin({"version": 1, "plugins": {}})
        event = DummyEvent(group_id="10001", sender_id="20002")
        self.assertTrue(plugin._fusion_event_enabled("webshot", event))

    def test_private_object_can_disable_bundled_plugin(self):
        plugin = self.make_plugin(
            {
                "version": 1,
                "plugins": {
                    "raw-image": {
                        "privates": {
                            "20002": {
                                "modules": {
                                    "providers": {
                                        "values": {"fusion_access.enabled": False}
                                    }
                                }
                            }
                        }
                    }
                },
            }
        )

        event = DummyEvent(private=True, sender_id="20002")
        self.assertFalse(plugin._fusion_event_enabled("raw-image", event))


if __name__ == "__main__":
    unittest.main()
