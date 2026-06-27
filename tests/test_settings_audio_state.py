import tempfile
import unittest
import base64
from pathlib import Path

from astrbot_plugin_permission_controller import web


class SettingsAudioStateTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.original_file = web.AUDIO_STATE_FILE
        self.original_media_dir = web.AUDIO_MEDIA_DIR
        self.original_metadata_file = web.CUSTOM_AUDIO_METADATA_FILE
        web.AUDIO_STATE_FILE = Path(self.temp_dir.name) / "settings_audio.json"
        web.AUDIO_MEDIA_DIR = Path(self.temp_dir.name) / "audio"
        web.CUSTOM_AUDIO_METADATA_FILE = web.AUDIO_MEDIA_DIR / "custom_background_audio.json"
        self.addCleanup(lambda: setattr(web, "AUDIO_STATE_FILE", self.original_file))
        self.addCleanup(lambda: setattr(web, "AUDIO_MEDIA_DIR", self.original_media_dir))
        self.addCleanup(lambda: setattr(web, "CUSTOM_AUDIO_METADATA_FILE", self.original_metadata_file))

    def test_audio_state_round_trips_bgm_enabled(self):
        self.assertFalse(web._read_audio_state()["persisted"])

        saved = web._write_audio_state(
            {
                "bgmEnabled": True,
                "buttonEnabled": False,
                "source": "default",
                "trackName": "track.mp3",
                "volume": 0.42,
            }
        )

        self.assertTrue(saved["persisted"])
        self.assertTrue(saved["bgmEnabled"])
        self.assertFalse(saved["buttonEnabled"])

        loaded = web._read_audio_state()
        self.assertTrue(loaded["persisted"])
        self.assertTrue(loaded["bgmEnabled"])
        self.assertFalse(loaded["buttonEnabled"])
        self.assertEqual(loaded["trackName"], "track.mp3")
        self.assertEqual(loaded["volume"], 0.42)

    def test_audio_state_normalizes_invalid_values(self):
        saved = web._write_audio_state(
            {
                "bgmEnabled": 1,
                "buttonEnabled": "yes",
                "source": "remote",
                "volume": 8,
            }
        )

        self.assertTrue(saved["bgmEnabled"])
        self.assertTrue(saved["buttonEnabled"])
        self.assertEqual(saved["source"], "default")
        self.assertEqual(saved["volume"], 1)

    def test_custom_audio_round_trips_through_backend_storage(self):
        audio_bytes = b"ID3" + b"\0" * 2048
        saved = web._write_custom_audio(
            {
                "fileName": "custom.mp3",
                "mime": "audio/mpeg",
                "content": base64.b64encode(audio_bytes).decode("ascii"),
            }
        )

        self.assertTrue(saved["exists"])
        self.assertEqual(saved["fileName"], "custom.mp3")

        loaded = web._read_custom_audio()
        self.assertTrue(loaded["exists"])
        self.assertEqual(loaded["mime"], "audio/mpeg")
        self.assertEqual(base64.b64decode(loaded["content"]), audio_bytes)
        self.assertEqual(web._read_audio_state()["source"], "custom")

        reset = web._reset_custom_audio()
        self.assertFalse(reset["exists"])
        self.assertFalse(web._read_custom_audio()["exists"])
        self.assertEqual(web._read_audio_state()["source"], "default")


if __name__ == "__main__":
    unittest.main()
