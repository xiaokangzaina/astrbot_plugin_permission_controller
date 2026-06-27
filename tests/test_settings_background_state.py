import base64
import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_permission_controller import web


class SettingsBackgroundStateTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.original_file = web.BACKGROUND_STATE_FILE
        self.original_media_dir = web.BACKGROUND_MEDIA_DIR
        web.BACKGROUND_STATE_FILE = Path(self.temp_dir.name) / "settings_background.json"
        web.BACKGROUND_MEDIA_DIR = Path(self.temp_dir.name) / "backgrounds"
        self.addCleanup(lambda: setattr(web, "BACKGROUND_STATE_FILE", self.original_file))
        self.addCleanup(lambda: setattr(web, "BACKGROUND_MEDIA_DIR", self.original_media_dir))

    def test_video_background_round_trips_and_resets(self):
        video_bytes = b"\x00\x00\x00\x18ftypmp42" + b"\0" * 2048
        data_url = "data:video/mp4;base64," + base64.b64encode(video_bytes).decode("ascii")

        saved = web._write_background_preference(
            {
                "data_url": data_url,
                "file_name": "motion.mp4",
                "overlay": 0.5,
                "blur": 8,
            }
        )

        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["file_name"], "motion.mp4")
        self.assertEqual(saved["media_type"], "video/mp4")
        self.assertEqual(saved["media_file"], "custom_background.mp4")
        self.assertEqual(saved["overlay"], 0.5)
        self.assertEqual(saved["blur"], 8)
        self.assertEqual(saved["data_url"], data_url)

        loaded = web._read_background_state(include_data_url=True)
        self.assertEqual(loaded["data_url"], data_url)

        reset = web._reset_background_preference()
        self.assertFalse(reset["enabled"])
        self.assertFalse(web._read_background_state(include_data_url=True)["enabled"])
        self.assertFalse(any(web.BACKGROUND_MEDIA_DIR.glob("custom_background*")))

    def test_background_mime_can_fall_back_to_file_extension(self):
        video_bytes = b"\x00\x00\x00\x18ftypmp42" + b"\0" * 128
        data_url = "data:application/octet-stream;base64," + base64.b64encode(video_bytes).decode("ascii")

        saved = web._write_background_preference(
            {
                "data_url": data_url,
                "file_name": "fallback.mp4",
            }
        )

        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["media_type"], "video/mp4")
        self.assertEqual(saved["media_file"], "custom_background.mp4")


if __name__ == "__main__":
    unittest.main()
