from __future__ import annotations

import asyncio
import copy
import json
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

PLUGIN_DIR = Path(__file__).resolve().parents[1]
ASTRBOT_ROOT = PLUGIN_DIR.parents[2]
PLUGINS_DIR = PLUGIN_DIR.parent
for path in (ASTRBOT_ROOT, PLUGINS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from astrbot.core.message.components import At, File, Image, Plain, Reply  # noqa: E402

from astrbot_plugin_qqadmin.core.banpro_handel import BanproHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.curfew_handle import CurfewHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.file_handle import FileHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.join_handle import JoinHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.llm_handle import LLMHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.member_handle import MemberHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.normal_handle import NormalHandle  # noqa: E402
from astrbot_plugin_qqadmin.core.notice_handle import NoticeHandle  # noqa: E402
from astrbot_plugin_qqadmin.data import QQAdminDB  # noqa: E402
from astrbot_plugin_qqadmin.page_service import (  # noqa: E402
    DEFAULT_GROUP_ID,
    QQAdminPageService,
)
from astrbot_plugin_qqadmin.permission import (  # noqa: E402
    PermLevel,
    perm_manager,
)

import astrbot_plugin_qqadmin.core.banpro_handel as banpro_mod  # noqa: E402
import astrbot_plugin_qqadmin.core.file_handle as file_mod  # noqa: E402
import astrbot_plugin_qqadmin.core.member_handle as member_mod  # noqa: E402
import astrbot_plugin_qqadmin.core.notice_handle as notice_mod  # noqa: E402


class VoteCfg:
    def __init__(self, ttl: int = 1, threshold: int = 2):
        self.ttl = ttl
        self.threshold = threshold


class FakeCfg:
    def __init__(self, root: Path):
        schema = json.loads((PLUGIN_DIR / "_conf_schema.json").read_text("utf-8"))
        self.default = {
            key: copy.deepcopy(value.get("default"))
            for key, value in schema["default"]["items"].items()
        }
        self.join_notice_enabled = True
        self.join_notice_admin_ids = ["9001"]
        self.random_ban_time = "10~10"
        self.vote_ban = VoteCfg()
        self.llm_get_msg_count = 1
        self.level_threshold = 50
        self.perms = {
            key: value.get("default") for key, value in schema["perms"]["items"].items()
        }
        self.admins_id = ["1"]
        self.data_dir = root
        self.plugin_dir = PLUGIN_DIR
        self.db_path = root / "qqadmin_test.db"
        self.ban_lexicon_path = PLUGIN_DIR / "SensitiveLexicon.json"
        self.group_notice_dir = root / "group_notice"
        self.group_notice_dir.mkdir(parents=True, exist_ok=True)
        self.curfew_file = root / "curfew_data.json"
        self.curfew_file.write_text("{}", encoding="utf-8")
        self.file_dir = root / "file"
        self.file_dir.mkdir(parents=True, exist_ok=True)
        self.spamming_count = 3
        self.spamming_interval = 2
        self.refresh_runtime_settings()

    @staticmethod
    def _clean_ids(ids):
        return [str(item) for item in ids if str(item).isdigit()]

    def refresh_runtime_settings(self):
        try:
            start, end = map(int, str(self.random_ban_time).split("~", 1))
        except Exception:
            start, end = 30, 300
        self.min_ban_time = max(1, start)
        self.max_ban_time = max(self.min_ban_time, end)

    def get_ban_time_with_range(self, random_ban_time, seconds=None):
        if isinstance(seconds, int) and seconds > 0:
            return min(seconds, 2592000)
        if random_ban_time and "~" in str(random_ban_time):
            start, _ = map(int, str(random_ban_time).split("~", 1))
            return max(1, start)
        return self.min_ban_time

    def build_group_default_config(self):
        return {
            **copy.deepcopy(self.default),
            "join_notice_enabled": self.join_notice_enabled,
            "join_notice_admin_ids": list(self.join_notice_admin_ids),
            "random_ban_time": self.random_ban_time,
            "vote_ban": {
                "ttl": self.vote_ban.ttl,
                "threshold": self.vote_ban.threshold,
            },
            "llm_get_msg_count": self.llm_get_msg_count,
            "level_threshold": self.level_threshold,
            "perms": copy.deepcopy(self.perms),
        }

    def save_config(self):
        self.saved = True


class FakeApi:
    def __init__(self, bot):
        self.bot = bot

    async def call_action(self, action, **kwargs):
        self.bot.record("api.call_action", action=action, **kwargs)
        if action == "get_group_msg_history":
            return {"messages": list(self.bot.history)}
        return {}


class FakeBot:
    def __init__(self):
        self.calls = []
        self.api = FakeApi(self)
        self.history = [
            {
                "message_id": 300,
                "sender": {"user_id": 222},
                "message": [{"type": "text", "data": {"text": "alpha text"}}],
            },
            {
                "message_id": 299,
                "sender": {"user_id": 333},
                "message": [{"type": "text", "data": {"text": "other text"}}],
            },
        ]
        self.root_files = {
            "folders": [{"folder_name": "docs", "folder_id": "folder1"}],
            "files": [
                {
                    "file_name": "root.txt",
                    "file_id": "file-root",
                    "size": 2048,
                    "uploader_name": "u",
                    "uploader": 1,
                    "download_times": 0,
                    "upload_time": 1700000000,
                    "dead_time": 0,
                }
            ],
        }
        self.folder_files = {
            "folder1": {
                "folders": [],
                "files": [
                    {
                        "file_name": "inner.txt",
                        "file_id": "file-inner",
                        "size": 1024,
                        "uploader_name": "u",
                        "uploader": 1,
                        "download_times": 1,
                        "upload_time": 1700000000,
                        "dead_time": 0,
                    }
                ],
            }
        }
        self.members = {
            1: {"role": "owner", "level": 99, "card": "super"},
            10000: {"role": "admin", "level": 99, "card": "bot"},
            111: {"role": "member", "level": 10, "card": "sender"},
            222: {"role": "member", "level": 10, "card": "target"},
            333: {"role": "member", "level": 80, "card": "high"},
            444: {"role": "admin", "level": 80, "card": "admin"},
            555: {"role": "owner", "level": 99, "card": "owner"},
        }

    def record(self, call_name, **kwargs):
        self.calls.append({"__call_name__": call_name, **kwargs})

    def called(self, call_name, **pred):
        return any(
            call.get("__call_name__") == call_name
            and all(call.get(key) == value for key, value in pred.items())
            for call in self.calls
        )

    def count(self, call_name):
        return sum(1 for call in self.calls if call.get("__call_name__") == call_name)

    async def set_group_ban(self, **kwargs):
        self.record("set_group_ban", **kwargs)

    async def set_group_whole_ban(self, **kwargs):
        self.record("set_group_whole_ban", **kwargs)

    async def set_group_card(self, **kwargs):
        self.record("set_group_card", **kwargs)

    async def set_group_special_title(self, **kwargs):
        self.record("set_group_special_title", **kwargs)

    async def set_group_kick(self, **kwargs):
        self.record("set_group_kick", **kwargs)

    async def set_group_admin(self, **kwargs):
        self.record("set_group_admin", **kwargs)

    async def set_essence_msg(self, **kwargs):
        self.record("set_essence_msg", **kwargs)

    async def delete_essence_msg(self, **kwargs):
        self.record("delete_essence_msg", **kwargs)

    async def get_essence_msg_list(self, **kwargs):
        self.record("get_essence_msg_list", **kwargs)
        return [{"message_id": 1}]

    async def set_group_portrait(self, **kwargs):
        self.record("set_group_portrait", **kwargs)

    async def set_group_name(self, **kwargs):
        self.record("set_group_name", **kwargs)

    async def delete_msg(self, **kwargs):
        self.record("delete_msg", **kwargs)

    async def get_group_member_info(self, group_id, user_id, no_cache=False):
        self.record(
            "get_group_member_info",
            group_id=group_id,
            user_id=user_id,
            no_cache=no_cache,
        )
        return dict(
            self.members.get(
                int(user_id),
                {
                    "role": "member",
                    "level": 1,
                    "card": f"user{user_id}",
                    "nickname": f"user{user_id}",
                },
            )
        )

    async def get_stranger_info(self, user_id):
        self.record("get_stranger_info", user_id=user_id)
        return {"nickname": f"nick{user_id}", "qqLevel": 20}

    async def get_group_info(self, group_id):
        self.record("get_group_info", group_id=group_id)
        return {"member_count": 42}

    async def send_private_msg(self, **kwargs):
        self.record("send_private_msg", **kwargs)

    async def send_group_msg(self, **kwargs):
        self.record("send_group_msg", **kwargs)

    async def set_group_add_request(self, **kwargs):
        self.record("set_group_add_request", **kwargs)

    async def _send_group_notice(self, **kwargs):
        self.record("_send_group_notice", **kwargs)

    async def _get_group_notice(self, **kwargs):
        self.record("_get_group_notice", **kwargs)
        return [
            {
                "sender_id": 1,
                "publish_time": 1700000000,
                "message": {"text": "notice&#10;text"},
            }
        ]

    async def get_group_root_files(self, **kwargs):
        self.record("get_group_root_files", **kwargs)
        return copy.deepcopy(self.root_files)

    async def get_group_files_by_folder(self, **kwargs):
        self.record("get_group_files_by_folder", **kwargs)
        return copy.deepcopy(
            self.folder_files.get(kwargs.get("folder_id"), {"folders": [], "files": []})
        )

    async def create_group_file_folder(self, **kwargs):
        self.record("create_group_file_folder", **kwargs)
        name = kwargs["folder_name"]
        folder_id = "folder-new"
        self.root_files["folders"].append({"folder_name": name, "folder_id": folder_id})
        self.folder_files[folder_id] = {"folders": [], "files": []}

    async def upload_group_file(self, **kwargs):
        self.record("upload_group_file", **kwargs)

    async def delete_group_file(self, **kwargs):
        self.record("delete_group_file", **kwargs)

    async def delete_group_folder(self, **kwargs):
        self.record("delete_group_folder", **kwargs)

    async def get_group_member_list(self, **kwargs):
        self.record("get_group_member_list", **kwargs)
        now = int(time.time())
        return [
            {
                "join_time": 1700000000,
                "last_sent_time": now - 90 * 86400,
                "level": 1,
                "user_id": 777,
                "nickname": "old",
            },
            {
                "join_time": 1700001000,
                "last_sent_time": now,
                "level": 99,
                "user_id": 888,
                "nickname": "active",
            },
        ]


class MsgObj:
    def __init__(self, message, raw=None, message_id=1234):
        self.message = message
        self.raw_message = raw or {}
        self.message_id = message_id


class PlatformMeta:
    name = "aiocqhttp"


class FakeEvent:
    def __init__(
        self,
        bot,
        group_id="1000",
        sender_id="111",
        self_id="10000",
        message=None,
        text="",
        raw=None,
        message_id=1234,
        admin=False,
        private=False,
    ):
        self.bot = bot
        self._group_id = str(group_id)
        self._sender_id = str(sender_id)
        self._self_id = str(self_id)
        self.message_obj = MsgObj(
            message if message is not None else [Plain(text=text or "msg")],
            raw=raw,
            message_id=message_id,
        )
        self.message_str = text
        self.sends = []
        self.stopped = False
        self._admin = admin
        self._private = private
        self.platform_meta = PlatformMeta()

    def get_group_id(self):
        return self._group_id

    def get_sender_id(self):
        return self._sender_id

    def get_self_id(self):
        return self._self_id

    def get_messages(self):
        return self.message_obj.message

    def is_admin(self):
        return self._admin

    def is_private_chat(self):
        return self._private

    def stop_event(self):
        self.stopped = True

    async def send(self, result):
        self.sends.append(result)

    def plain_result(self, text):
        return {"kind": "plain", "text": str(text)}

    def chain_result(self, chain):
        return {"kind": "chain", "chain": chain}

    def image_result(self, url):
        return {"kind": "image", "url": url}


class FakeGroupCache:
    def __init__(self):
        self.groups = [
            {
                "group_id": "1000",
                "group_name": "G1000",
                "member_count": 1,
                "max_member_count": 100,
                "avatar": "",
            }
        ]
        self.removed = []

    async def list_groups(self, force=False):
        return list(self.groups)

    async def get_group(self, group_id, force=False):
        for group in self.groups:
            if str(group["group_id"]) == str(group_id):
                return dict(group)
        return {"group_id": str(group_id), "group_name": "cached", "source": "cached"}

    def invalidate(self, group_id=None):
        pass

    def remove_group(self, group_id):
        self.removed.append(str(group_id))


class FakeContext:
    def __init__(self, provider=None):
        self.provider = provider
        self.platform_manager = SimpleNamespace(platform_insts=[])

    def get_config(self):
        return {"admins_id": ["1"], "timezone": "Asia/Shanghai"}

    def get_using_provider(self):
        return self.provider


class FakeProvider:
    async def text_chat(self, **kwargs):
        return SimpleNamespace(completion_text="new name: **Alpha**\nreason: 'ok'")


class FakePlugin:
    async def text_to_image(self, text):
        self.last_text = text
        return "http://fake/image.png"


class FakeCurfewManager:
    def __init__(self):
        self.tasks = {}
        self.enabled = []
        self.disabled = []

    async def enable_curfew(self, group_id, start_time, end_time):
        self.enabled.append((group_id, start_time, end_time))
        self.tasks[group_id] = (start_time, end_time)

    async def disable_curfew(self, group_id):
        self.disabled.append(group_id)
        return self.tasks.pop(group_id, None) is not None


async def fake_download(url, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(b"data")
    return Path(path)


def fake_create_task(coro):
    coro.close()
    return SimpleNamespace(cancel=lambda: None)


def fake_session_waiter(timeout=60):
    def decorator(fn):
        async def wrapper(initial_event):
            class Controller:
                def stop(self):
                    self.stopped = True

            confirm_text = "\u786e\u8ba4\u6e05\u7406"
            for item in fn.__code__.co_consts:
                if isinstance(item, str) and ("\u786e" in item or "\u7ea4" in item):
                    confirm_text = item
            event = FakeEvent(initial_event.bot, text=confirm_text)
            event._group_id = initial_event.get_group_id()
            event._sender_id = initial_event.get_sender_id()
            await fn(Controller(), event)

        return wrapper

    return decorator


async def run_simulation():
    results = []

    def check(name, ok, detail=""):
        results.append({"name": name, "ok": bool(ok), "detail": str(detail)})
        print(f"[sim] {name}: {'ok' if ok else 'fail'}", flush=True)

    notice_mod.download_file = fake_download
    file_mod.download_file = fake_download
    member_mod.session_waiter = fake_session_waiter
    original_create_task = banpro_mod.asyncio.create_task
    banpro_mod.asyncio.create_task = fake_create_task

    with tempfile.TemporaryDirectory(prefix="qqadmin_sim_") as temp_dir:
        root = Path(temp_dir)
        cfg = FakeCfg(root)
        bot = FakeBot()
        db = QQAdminDB(cfg)
        await db.init()
        cfg.default = cfg.build_group_default_config()
        perm_manager.refresh(cfg, db)

        normal = NormalHandle(cfg, db)
        join = JoinHandle(cfg, db)
        banpro = BanproHandle(cfg, db)
        notice = NoticeHandle(FakePlugin(), cfg)
        file_handle = FileHandle(cfg)
        llm = LLMHandle(FakeContext(FakeProvider()), cfg, db)
        member = MemberHandle(FakePlugin())

        await db.set("1000", "custom_ban_words", ["bad"])
        await db.add("1000", "custom_ban_words", "worse")
        await db.remove("1000", "custom_ban_words", "bad")
        exported = await db.export_cn_lines("1000")
        imported = await db.import_cn_lines("1000", exported)
        check("db set/add/remove/export/import", imported["custom_ban_words"] == ["worse"])

        await db.set("9999", "word_ban_time", 99)
        page = QQAdminPageService(cfg, db, FakeGroupCache())
        groups = await page.list_groups(force=True)
        check(
            "page list/default/stale cleanup",
            groups[0]["group_id"] == DEFAULT_GROUP_ID
            and any(group["group_id"] == "1000" for group in groups)
            and "9999" not in db.list_group_ids(),
        )
        updated = await page.update_group_config(
            "1000",
            {"follow_default": False, "word_ban_time": 77, "spamming_ban_time": 66},
        )
        reset = await page.reset_group_config("1000")
        await page.update_default_group_config(
            {
                "follow_default": False,
                "random_ban_time": "12~12",
                "vote_ban": {"ttl": 60, "threshold": 4},
            }
        )
        check(
            "page update/reset/default update",
            updated["config"]["word_ban_time"] == 77
            and reset["config"]["follow_default"] is True
            and cfg.random_ban_time == "12~12"
            and cfg.vote_ban.threshold == 4
            and getattr(cfg, "saved", False),
        )
        cfg.random_ban_time = "10~10"
        cfg.vote_ban.ttl = 1
        cfg.vote_ban.threshold = 2
        cfg.refresh_runtime_settings()
        db.default_cfg = cfg.build_group_default_config()

        event_perm = FakeEvent(bot, sender_id="333", message=[At(qq="222")])
        await db.set("1000", "perms", {"set_group_ban": str(PermLevel.ADMIN)})
        check(
            "permission levels and block",
            await perm_manager.get_perm_level(event_perm, "333") == PermLevel.HIGH
            and await perm_manager.get_perm_level(event_perm, "222") == PermLevel.MEMBER
            and bool(
                await perm_manager.perm_block(
                    event_perm, PermLevel.ADMIN, "set_group_ban"
                )
            ),
        )

        event = FakeEvent(bot, message=[At(qq="222")])
        await normal.set_group_ban(event, 123)
        await normal.set_group_ban_me(FakeEvent(bot), 50)
        await normal.cancel_group_ban(FakeEvent(bot, message=[At(qq="222")]))
        await normal.set_group_whole_ban(FakeEvent(bot))
        await normal.cancel_group_whole_ban(FakeEvent(bot))
        await normal.set_group_card(FakeEvent(bot, message=[At(qq="222")]), "Card")
        await normal.set_group_card_me(FakeEvent(bot), "MeCard")
        await normal.set_group_special_title(
            FakeEvent(bot, message=[At(qq="222")]), "Title"
        )
        await normal.set_group_special_title_me(FakeEvent(bot), "MyTitle")
        await normal.set_group_kick(FakeEvent(bot, message=[At(qq="222")]))
        await normal.set_group_block(FakeEvent(bot, message=[At(qq="333")]))
        await normal.set_group_admin(FakeEvent(bot, message=[At(qq="222")]))
        await normal.cancel_group_admin(FakeEvent(bot, message=[At(qq="222")]))
        await normal.set_essence_msg(FakeEvent(bot, message=[Reply(id="88")]))
        await normal.delete_essence_msg(FakeEvent(bot, message=[Reply(id="88")]))
        await normal.get_essence_msg_list(FakeEvent(bot))
        await normal.set_group_portrait(
            FakeEvent(bot, message=[Image(file="x", url="http://img")])
        )
        await normal.set_group_name(FakeEvent(bot), "NewGroup")
        await normal.delete_msg(FakeEvent(bot, message=[Reply(id="89")]))
        await normal.delete_msg(FakeEvent(bot, message=[At(qq="222")], text="cmd 5"))
        check(
            "normal group operations",
            bot.called("set_group_ban", group_id=1000, user_id=222, duration=123)
            and bot.called("set_group_ban", group_id=1000, user_id=111, duration=50)
            and bot.called("set_group_ban", group_id=1000, user_id=222, duration=0)
            and bot.called("set_group_whole_ban", group_id=1000, enable=True)
            and bot.called("set_group_whole_ban", group_id=1000, enable=False)
            and bot.called("set_group_card", group_id=1000, user_id=222, card="Card")
            and bot.called(
                "set_group_special_title",
                group_id=1000,
                user_id=222,
                special_title="Title",
                duration=-1,
            )
            and bot.called(
                "set_group_kick",
                group_id=1000,
                user_id=333,
                reject_add_request=True,
            )
            and bot.called("set_group_admin", group_id=1000, user_id=222, enable=True)
            and bot.called("set_essence_msg", message_id=88)
            and bot.called("delete_msg", message_id=89),
        )

        await notice.send_group_notice(FakeEvent(bot, text="notice hello"))
        await notice.send_group_notice(
            FakeEvent(bot, message=[Image(file="x", url="http://img")], text="notice img")
        )
        notice_event = FakeEvent(bot)
        await notice.get_group_notice(notice_event)
        check(
            "notice text/image/list",
            bot.called("_send_group_notice", group_id=1000, content="hello")
            and any(
                call["__call_name__"] == "_send_group_notice"
                and call.get("content") == "img"
                and call.get("image")
                for call in bot.calls
            )
            and any(result["kind"] == "image" for result in notice_event.sends),
        )

        await join.handle_join_review(FakeEvent(bot), True)
        await join.handle_accept_words(FakeEvent(bot, text="cmd pass ok"))
        await join.handle_reject_words(FakeEvent(bot, text="cmd nope"))
        await join.handle_no_match_reject(FakeEvent(bot), True)
        await join.handle_join_min_level(FakeEvent(bot), 30)
        await join.handle_join_max_time(FakeEvent(bot), 2)
        await join.handle_block_ids(FakeEvent(bot, text="cmd +444 -555"))
        await join.handle_join_ban(FakeEvent(bot), 33)
        await join.handle_join_welcome(FakeEvent(bot, text="cmd {at} hi {member_count}"))
        await join.handle_leave_notify(FakeEvent(bot), True)
        await join.handle_leave_block(FakeEvent(bot), True)
        snapshot = db.get_group_snapshot("1000")
        approve, _ = await join.should_approve("1000", "223", "answer pass", 80)
        reject, _ = await join.should_approve("1000", "224", "answer nope", 80)
        low_level_reject, _ = await join.should_approve(
            "1000", "225", "answer pass", 1
        )
        await db.set("1000", "join_min_level", 0)
        raw_req = {
            "post_type": "request",
            "request_type": "group",
            "sub_type": "add",
            "group_id": 1000,
            "user_id": 225,
            "comment": "answer pass",
            "flag": "flag225",
        }
        await join.event_monitoring(FakeEvent(bot, raw=raw_req))
        raw_inc = {
            "post_type": "notice",
            "notice_type": "group_increase",
            "group_id": 1000,
            "user_id": 226,
        }
        increase_event = FakeEvent(bot, raw=raw_inc)
        await join.event_monitoring(increase_event)
        raw_leave = {
            "post_type": "notice",
            "notice_type": "group_decrease",
            "sub_type": "leave",
            "group_id": 1000,
            "user_id": 227,
        }
        leave_event = FakeEvent(bot, raw=raw_leave)
        await join.event_monitoring(leave_event)
        reply_text = (
            "\u3010\u8fdb\u7fa4\u7533\u8bf7\u3011\n"
            "\u6635\u79f0\uff1aNick\n"
            "QQ\uff1a123\n"
            "flag\uff1aflagManual"
        )
        await join.agree_add_group(FakeEvent(bot, message=[Reply(id="1", message_str=reply_text)]))
        await join.refuse_add_group(
            FakeEvent(bot, message=[Reply(id="1", message_str=reply_text)]), "no"
        )
        join_checks = {
            "config": snapshot["join_switch"] is True
            and snapshot["join_accept_words"] == ["pass", "ok"],
            "decision": approve is True and reject is False and low_level_reject is False,
            "auto_request": bot.called(
                "set_group_add_request",
                flag="flag225",
                sub_type="add",
                approve=True,
                reason="",
            ),
            "admin_notice": bot.called("send_private_msg", user_id=9001),
            "increase": any(result["kind"] == "chain" for result in increase_event.sends)
            and bot.called("set_group_ban", group_id=1000, user_id=226, duration=33),
            "leave": any(result["kind"] == "plain" for result in leave_event.sends)
            and "227" in await db.get("1000", "block_ids", []),
            "manual_approve": bot.called(
                "set_group_add_request",
                flag="flagManual",
                sub_type="add",
                approve=True,
                reason="",
            ),
            "manual_refuse": bot.called(
                "set_group_add_request",
                flag="flagManual",
                sub_type="add",
                approve=False,
                reason="no",
            ),
        }
        check(
            "join config/request/welcome/leave/manual approve",
            all(join_checks.values()),
            {
                "checks": join_checks,
                "set_group_add_request_calls": [
                    call
                    for call in bot.calls
                    if call.get("__call_name__") == "set_group_add_request"
                ],
            },
        )

        await banpro.handle_word_ban_time(FakeEvent(bot), 55)
        await banpro.handle_ban_words(FakeEvent(bot, text="cmd blockedword"))
        await banpro.handle_builtin_ban_words(FakeEvent(bot), True)
        await banpro.handle_link_whitelist(FakeEvent(bot, text="cmd safe.example"))
        await banpro.handle_filter_non_whitelist_links(FakeEvent(bot), True)
        await banpro.handle_recall_admin_links(FakeEvent(bot), True)
        await banpro.handle_link_recall_ban(FakeEvent(bot), True)
        await banpro.handle_link_recall_ban_time(FakeEvent(bot), 44)
        await banpro.handle_link_recall_warn(FakeEvent(bot), True)
        await banpro.handle_link_recall_warn_text(FakeEvent(bot, text="cmd warn {qq}"))
        await banpro.handle_link_recall_ban_admin(FakeEvent(bot), True)
        await banpro.handle_link_recall_kick_count(FakeEvent(bot), 1)
        await banpro.on_ban_words(
            FakeEvent(bot, sender_id="222", text="this has blockedword", message_id=501)
        )
        before = bot.count("delete_msg")
        await banpro.on_ban_words(
            FakeEvent(
                bot,
                sender_id="444",
                admin=True,
                text="this has blockedword",
                message_id=502,
            )
        )
        admin_skipped = bot.count("delete_msg") == before
        before = bot.count("delete_msg")
        await banpro.on_ban_words(
            FakeEvent(
                bot,
                sender_id="222",
                text="go http://safe.example/path",
                message_id=503,
            )
        )
        whitelist_skipped = bot.count("delete_msg") == before
        await banpro.on_ban_words(
            FakeEvent(
                bot,
                sender_id="222",
                text="go http://evil.example/path",
                message_id=504,
            )
        )
        await banpro.handle_link_recall_counts_clear(FakeEvent(bot))
        await banpro.handle_spamming_ban_time(FakeEvent(bot), 66)
        for index in range(3):
            await banpro.spamming_ban(
                FakeEvent(
                    bot,
                    sender_id="333",
                    text=f"spam{index}",
                    message=[Plain(text=f"spam{index}")],
                )
            )
        await banpro.start_vote_mute(FakeEvent(bot, message=[At(qq="222")]), 77)
        await banpro.vote_mute(FakeEvent(bot, sender_id="333"), True)
        await banpro.vote_mute(FakeEvent(bot, sender_id="444"), True)
        check(
            "ban/link/spam/vote",
            bot.called("delete_msg", message_id=501)
            and bot.called("set_group_ban", group_id=1000, user_id=222, duration=55)
            and admin_skipped
            and whitelist_skipped
            and bot.called("delete_msg", message_id=504)
            and bot.called("set_group_ban", group_id=1000, user_id=222, duration=44)
            and bot.called(
                "set_group_kick",
                group_id=1000,
                user_id=222,
                reject_add_request=False,
            )
            and await db.get("1000", "link_recall_counts") == {}
            and await db.get("1000", "spamming_ban_time") == 66
            and bot.called("set_group_ban", group_id=1000, user_id=333, duration=66)
            and bot.called("set_group_ban", group_id=1000, user_id=222, duration=77)
            and "1000" not in banpro.vote_cache,
        )

        root_results = []
        async for result in file_handle.view_group_file(FakeEvent(bot), ""):
            root_results.append(result)
        folder_results = []
        async for result in file_handle.view_group_file(FakeEvent(bot), "docs"):
            folder_results.append(result)
        file_results = []
        async for result in file_handle.view_group_file(FakeEvent(bot), "docs/inner.txt"):
            file_results.append(result)
        await file_handle.delete_group_file(FakeEvent(bot), "docs/inner.txt")
        await file_handle.delete_group_file(FakeEvent(bot), "docs")
        await file_handle.upload_group_file(
            FakeEvent(bot, message=[Reply(id="1", chain=[File(name="upload.txt", url="http://file")])]),
            "newdir/upload.txt",
        )
        check(
            "file view/delete/upload",
            len(root_results) == 1
            and len(folder_results) == 1
            and len(file_results) == 1
            and bot.called("delete_group_file", group_id=1000, file_id="file-inner")
            and bot.called("delete_group_folder", group_id=1000, folder_id="folder1")
            and bot.called(
                "upload_group_file",
                group_id=1000,
                name="upload.txt",
                folder_id="folder-new",
            ),
        )

        curfew = object.__new__(CurfewHandle)
        curfew.curfew_managers = {"10000": FakeCurfewManager()}
        await curfew.start_curfew(FakeEvent(bot), "08:00", "09:00")
        await curfew.stop_curfew(FakeEvent(bot))
        check(
            "curfew parse/start/stop",
            CurfewHandle.parse_time("08:30") is not None
            and CurfewHandle.parse_time("25:00") is None
            and curfew.curfew_managers["10000"].enabled == [("1000", "08:00", "09:00")]
            and curfew.curfew_managers["10000"].disabled == ["1000"],
        )

        target_id, _, rounds = await llm.parse_args(
            FakeEvent(bot, message=[At(qq="222")], text="name 1")
        )
        context_text = await llm.get_msg_contexts(FakeEvent(bot), "222", 1)
        nick, reason = await llm.get_llm_nick(context_text)
        await llm.ai_set_card(FakeEvent(bot, message=[At(qq="222")], text="name 1"))
        await llm.ai_set_title(FakeEvent(bot, message=[At(qq="222")], text="title 1"))
        check(
            "llm context/nick/apply",
            target_id == "222"
            and rounds == 1
            and "alpha text" in context_text
            and nick == "Alpha"
            and reason == "ok"
            and bot.called("set_group_card", group_id=1000, user_id=222, card="Alpha")
            and bot.called(
                "set_group_special_title",
                group_id=1000,
                user_id=222,
                special_title="Alpha",
            ),
        )

        member_list_event = FakeEvent(bot)
        await member.get_group_member_list(member_list_event)
        await member.clear_group_member(FakeEvent(bot), inactive_days=30, under_level=10)
        check(
            "member list/clear",
            any(result["kind"] == "image" for result in member_list_event.sends)
            and bot.called(
                "set_group_kick",
                group_id=1000,
                user_id=777,
                reject_add_request=False,
            ),
        )

        await db.close()

    banpro_mod.asyncio.create_task = original_create_task
    failed = [result for result in results if not result["ok"]]
    return {
        "passed": len(results) - len(failed),
        "total": len(results),
        "failed": failed,
    }


if __name__ == "__main__":
    report = asyncio.run(asyncio.wait_for(run_simulation(), timeout=60))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(1 if report["failed"] else 0)
