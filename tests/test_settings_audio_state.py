import tempfile
import unittest
from pathlib import Path

from astrbot_plugin_permission_controller import web


class SettingsAudioStateTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.original_file = web.AUDIO_STATE_FILE
        web.AUDIO_STATE_FILE = Path(self.temp_dir.name) / "settings_audio.json"
        self.addCleanup(lambda: setattr(web, "AUDIO_STATE_FILE", self.original_file))

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


if __name__ == "__main__":
    unittest.main()
