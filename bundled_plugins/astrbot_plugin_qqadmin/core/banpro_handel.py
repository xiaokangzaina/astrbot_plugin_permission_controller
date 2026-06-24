import asyncio
import json
import re
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from astrbot.api import logger
from astrbot.core.message.components import At, Plain
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)

from ..config import PluginConfig
from ..data import QQAdminDB
from ..utils import get_ats, get_nickname, parse_bool

DEFAULT_LINK_RECALL_WARN_TEXT = "你发的链接不符合社区规定警告一次，二次直接踢出群聊"


class BanproHandle:
    def __init__(self, config: PluginConfig, db: QQAdminDB):
        self.cfg = config
        self.db = db
        self.builtin_ban_data = json.loads(
            config.ban_lexicon_path.read_text(encoding="utf-8")
        )
        self.builtin_ban_words = self.builtin_ban_data["words"]
        self.msg_timestamps: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=self.cfg.spamming_count))
        )
        self.last_banned_time: dict[str, dict[str, float]] = defaultdict(
            lambda: defaultdict(float)
        )
        # 记录投票 {group_id: {"target": target_id, "votes": {user_id: bool}, "expire": timestamp, "threshold": threshold,}}
        self.vote_cache: dict[str, dict] = {}

    async def _is_group_admin(self, event: AiocqhttpMessageEvent) -> bool:
        """判断发送者是否为 QQ 群主/管理员；兼容 AstrBot 超管和 QQNT/NapCat uid。"""
        if event.is_admin():
            return True

        raw = event.message_obj.raw_message or {}
        sender_role = raw.get("sender", {}).get("role", "unknown")
        if sender_role in ("owner", "admin"):
            return True

        group_id = event.get_group_id()
        user_id = event.get_sender_id()
        if not str(group_id).isdigit() or not str(user_id).isdigit():
            logger.debug(
                "跳过群成员权限接口查询：group_id=%s, user_id=%s, role=%s",
                group_id,
                user_id,
                sender_role,
            )
            return False

        try:
            info = await event.bot.get_group_member_info(
                group_id=int(group_id),
                user_id=int(user_id),
                no_cache=True,
            )
            return info.get("role") in ("owner", "admin")
        except Exception as exc:
            logger.debug(
                "获取群成员权限失败，按非管理员处理: group_id=%s, user_id=%s, error=%r",
                group_id,
                user_id,
                exc,
            )
            return False

    async def handle_word_ban_time(
        self, event: AiocqhttpMessageEvent, time: int | None
    ):
        """设置禁词禁言时长"""
        gid = event.get_group_id()
        if isinstance(time, int):
            await self.db.set(gid, "word_ban_time", time)
            msg = (
                f"本群禁词禁言时长已设为：{time} 秒"
                if time > 0
                else "本群禁词禁言已关闭"
            )
            await event.send(event.plain_result(msg))
        else:
            status = await self.db.get(gid, "word_ban_time", 0)
            await event.send(event.plain_result(f"本群禁词禁言时长：{status} 秒"))

    async def handle_ban_words(self, event: AiocqhttpMessageEvent):
        """设置/查看违禁词"""
        gid = event.get_group_id()
        raw = event.message_str.partition(" ")[2]

        # 1. 空指令：查看
        if not raw:
            words = await self.db.get(gid, "custom_ban_words", [])
            await event.send(event.plain_result(f"本群违禁词：{words}"))
            return

        # 2. 纯单词列表（无 +/-）：整表覆写
        toks = raw.split()
        if all(not tok.startswith(("+", "-")) for tok in toks):
            await self.db.set(gid, "custom_ban_words", toks)
            await event.send(
                event.plain_result(f"本群违禁词已覆写为：{' '.join(toks)}")
            )
            return

        # 3. 增量模式：+word / -word
        curr = set(await self.db.get(gid, "custom_ban_words", []))
        added, removed = [], []

        for tok in toks:
            if tok.startswith("+") and len(tok) > 1:
                w = tok[1:]
                if w not in curr:
                    curr.add(w)
                    added.append(w)
            elif tok.startswith("-") and len(tok) > 1:
                w = tok[1:]
                if w in curr:
                    curr.discard(w)
                    removed.append(w)

        await self.db.set(gid, "custom_ban_words", list(curr))

        reply = ["本群违禁词"]
        if added:
            reply.append(f"新增：{'、'.join(added)}")
        if removed:
            reply.append(f"移除：{'、'.join(removed)}")
        if not added and not removed:
            reply.append("无变动")
        await event.send(event.plain_result("\n".join(reply)))

    async def handle_builtin_ban_words(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """启用/停用内置违禁词"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)

        if isinstance(mode, bool):
            await self.db.set(gid, "builtin_ban", mode)
            await event.send(event.plain_result(f"本群内置禁词：{mode}"))
        else:
            status = await self.db.get(gid, "builtin_ban", False)
            await event.send(event.plain_result(f"本群内置禁词：{status}"))

    async def handle_link_whitelist(self, event: AiocqhttpMessageEvent):
        """链接白名单 [+域名/-域名/域名列表]；无参数查看。"""
        gid = event.get_group_id()
        raw = event.message_str.partition(" ")[2].strip()
        if not raw:
            whitelist = await self.db.get(gid, "link_whitelist", [])
            await event.send(
                event.plain_result(
                    f"本群链接白名单：{' '.join(whitelist) if whitelist else '空'}"
                )
            )
            return

        toks = raw.split()
        curr = list(await self.db.get(gid, "link_whitelist", []))
        curr_set = set(curr)

        if all(not tok.startswith(("+", "-")) for tok in toks):
            await self.db.set(gid, "link_whitelist", toks)
            await event.send(
                event.plain_result(
                    f"本群链接白名单已覆写为：{' '.join(toks) if toks else '空'}"
                )
            )
            return

        added, removed = [], []
        for tok in toks:
            if tok.startswith("+") and len(tok) > 1:
                item = tok[1:]
                if item not in curr_set:
                    curr.append(item)
                    curr_set.add(item)
                    added.append(item)
            elif tok.startswith("-") and len(tok) > 1:
                item = tok[1:]
                if item in curr_set:
                    curr_set.remove(item)
                    curr = [x for x in curr if x != item]
                    removed.append(item)

        await self.db.set(gid, "link_whitelist", curr)
        reply = ["本群链接白名单已更新"]
        if added:
            reply.append(f"新增：{'、'.join(added)}")
        if removed:
            reply.append(f"移除：{'、'.join(removed)}")
        if not added and not removed:
            reply.append("无变动")
        reply.append(f"当前：{' '.join(curr) if curr else '空'}")
        await event.send(event.plain_result("\n".join(reply)))

    async def handle_filter_non_whitelist_links(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """链接过滤 开/关。"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)
        if isinstance(mode, bool):
            await self.db.set(gid, "filter_non_whitelist_links", mode)
            await event.send(event.plain_result(f"本群过滤非白名单链接：{mode}"))
        else:
            status = await self.db.get(gid, "filter_non_whitelist_links", False)
            await event.send(event.plain_result(f"本群过滤非白名单链接：{status}"))

    async def handle_recall_admin_links(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """撤回管理员链接 开/关。"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)
        if isinstance(mode, bool):
            await self.db.set(gid, "recall_admin_links", mode)
            await event.send(event.plain_result(f"本群撤回管理员链接：{mode}"))
        else:
            status = await self.db.get(gid, "recall_admin_links", True)
            await event.send(event.plain_result(f"本群撤回管理员链接：{status}"))

    async def handle_link_recall_ban(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """链接撤回禁言 开/关。"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)
        if isinstance(mode, bool):
            await self.db.set(gid, "link_recall_ban", mode)
            await event.send(event.plain_result(f"本群链接撤回后禁言：{mode}"))
        else:
            status = await self.db.get(gid, "link_recall_ban", False)
            await event.send(event.plain_result(f"本群链接撤回后禁言：{status}"))

    async def handle_link_recall_ban_time(
        self, event: AiocqhttpMessageEvent, seconds: int | None
    ):
        """链接撤回禁言时长 <秒数>。"""
        gid = event.get_group_id()
        if isinstance(seconds, int):
            seconds = max(0, seconds)
            await self.db.set(gid, "link_recall_ban_time", seconds)
            await event.send(event.plain_result(f"本群链接撤回禁言时长：{seconds} 秒"))
        else:
            status = await self.db.get(gid, "link_recall_ban_time", 0)
            await event.send(event.plain_result(f"本群链接撤回禁言时长：{status} 秒"))

    async def handle_link_recall_warn(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """链接/禁词撤回提醒 开/关。"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)
        if isinstance(mode, bool):
            await self.db.set(gid, "link_recall_warn", mode)
            await event.send(event.plain_result(f"本群链接/禁词撤回后提醒：{mode}"))
        else:
            status = await self.db.get(gid, "link_recall_warn", True)
            await event.send(event.plain_result(f"本群链接/禁词撤回后提醒：{status}"))

    async def handle_link_recall_warn_text(self, event: AiocqhttpMessageEvent):
        """链接撤回警告语 <文本|重置>；无参数查看。"""
        gid = event.get_group_id()
        raw = event.message_str.partition(" ")[2].strip()
        default_text = DEFAULT_LINK_RECALL_WARN_TEXT
        if not raw:
            text = await self.db.get(gid, "link_recall_warn_text", default_text)
            await event.send(event.plain_result(f"本群链接撤回警告语：{text}"))
            return
        if raw in {"重置", "默认", "reset"}:
            await self.db.set(gid, "link_recall_warn_text", default_text)
            await event.send(
                event.plain_result(f"本群链接撤回警告语已重置：{default_text}")
            )
            return
        await self.db.set(gid, "link_recall_warn_text", raw)
        await event.send(event.plain_result(f"本群链接撤回警告语已设置：{raw}"))

    async def handle_link_recall_ban_admin(
        self, event: AiocqhttpMessageEvent, mode_str: str | bool | None
    ):
        """链接撤回禁言管理员 开/关。"""
        gid = event.get_group_id()
        mode = parse_bool(mode_str)
        if isinstance(mode, bool):
            await self.db.set(gid, "link_recall_ban_admin", mode)
            await event.send(event.plain_result(f"本群链接撤回后禁言管理员：{mode}"))
        else:
            status = await self.db.get(gid, "link_recall_ban_admin", False)
            await event.send(event.plain_result(f"本群链接撤回后禁言管理员：{status}"))

    async def handle_link_recall_kick_count(
        self, event: AiocqhttpMessageEvent, count: int | None
    ):
        """链接撤回踢出 <次数>，0 关闭。"""
        gid = event.get_group_id()
        if isinstance(count, int):
            count = max(0, count)
            await self.db.set(gid, "link_recall_kick_count", count)
            await self.db.set(gid, "link_recall_counts", {})
            msg = (
                f"本群链接撤回达到 {count} 次后踢出，计数已清空"
                if count > 0
                else "本群链接撤回踢出已关闭，计数已清空"
            )
            await event.send(event.plain_result(msg))
        else:
            status = await self.db.get(gid, "link_recall_kick_count", 0)
            counts = await self.db.get(gid, "link_recall_counts", {})
            await event.send(
                event.plain_result(f"本群链接撤回踢出次数：{status}；当前计数：{counts}")
            )

    async def handle_link_recall_counts_clear(self, event: AiocqhttpMessageEvent):
        """清空本群链接撤回踢出计数。"""
        gid = event.get_group_id()
        await self.db.set(gid, "link_recall_counts", {})
        await event.send(event.plain_result("已清空本群链接撤回计数"))

    async def on_ban_words(self, event: AiocqhttpMessageEvent):
        """检测禁词/非白名单链接，并撤回消息、按配置禁言用户。"""
        gid = event.get_group_id()

        if await self.db.get(gid, "filter_non_whitelist_links", False):
            if await self.check_non_whitelist_links(event):
                return

        if await self._is_group_admin(event):
            return

        if ban_words := await self.db.get(gid, "custom_ban_words", []):
            if await self.check_ban_words(event, ban_words):
                return

        if await self.db.get(gid, "builtin_ban", False):
            if await self.check_ban_words(event, self.builtin_ban_words):
                return

    @staticmethod
    def _extract_links(text: str) -> list[str]:
        if not text:
            return []
        pattern = re.compile(
            r"(?:https?://|www\.)[^\s\]\)）>]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:/[^\s\]\)）>]*)?",
            re.IGNORECASE,
        )
        return [m.group(0).rstrip(".,;:!?，。；：！？") for m in pattern.finditer(text)]

    @staticmethod
    def _message_contains_whitelist_domain(message_text: str, whitelist: list[str]) -> bool:
        """基于已解析出的链接做 host 级白名单匹配；任一链接命中即放行。"""
        links = BanproHandle._extract_links(str(message_text or ""))
        return any(BanproHandle._link_in_whitelist(link, whitelist) for link in links)

    @staticmethod
    def _normalize_link_host(value: str) -> str:
        text = str(value or "").strip().lower()
        if not text:
            return ""
        text = text.strip("<>[]()（）{}『』【】\"'").rstrip(".,;:!?，。；：！？")
        if text[:1] in {"+", "-"}:
            text = text[1:]
        target = text if re.match(r"^[a-z][a-z0-9+.-]*://", text) else f"http://{text}"
        host = (urlparse(target).hostname or "").lower().strip(".")
        if host.startswith("www."):
            host = host[4:]
        return host

    @staticmethod
    def _link_in_whitelist(link: str, whitelist: list[str]) -> bool:
        link_l = str(link or "").strip().lower()
        host = BanproHandle._normalize_link_host(link_l)
        if not host:
            return False
        for item in whitelist or []:
            item_l = str(item or "").strip().lower()
            if not item_l:
                continue
            item_host = BanproHandle._normalize_link_host(item_l)
            if not item_host:
                continue
            if host == item_host or host.endswith(f".{item_host}"):
                return True
        return False

    @staticmethod
    def _format_warn_text(template: str, uid: str) -> str:
        """格式化链接撤回警告语，支持 {uid}/{qq}/{at}。"""
        text = str(template or "")
        for key, value in {
            "{uid}": str(uid),
            "{qq}": str(uid),
        }.items():
            text = text.replace(key, value)
        return text

    @staticmethod
    def _build_warn_chain(warn_text: str, uid: str):
        """构建带 At 的警告消息链；未写 {at} 时默认开头艾特。"""
        text = str(warn_text or "")
        if "{at}" not in text:
            return [At(qq=uid), Plain(text=f" {text}")]
        chain = []
        parts = text.split("{at}")
        for index, part in enumerate(parts):
            if part:
                chain.append(Plain(text=part))
            if index < len(parts) - 1:
                chain.append(At(qq=uid))
        return chain

    async def _send_link_recall_warning(
        self, event: AiocqhttpMessageEvent, gid: str | int
    ) -> None:
        """链接/禁词消息被撤回后发送警告语，不依赖禁言是否执行。"""
        if not await self.db.get(gid, "link_recall_warn", True):
            return
        warn_text = await self.db.get(
            gid,
            "link_recall_warn_text",
            DEFAULT_LINK_RECALL_WARN_TEXT,
        )
        if not warn_text:
            return
        warn_text = self._format_warn_text(str(warn_text), str(event.get_sender_id()))
        chain = self._build_warn_chain(warn_text, str(event.get_sender_id()))
        try:
            await event.send(event.chain_result(chain))
        except Exception as exc:
            logger.warning(f"链接撤回警告语发送失败: {exc}")

    async def check_non_whitelist_links(self, event: AiocqhttpMessageEvent) -> bool:
        gid = event.get_group_id()
        links = self._extract_links(event.message_str)
        if not links:
            return False

        whitelist = await self.db.get(gid, "link_whitelist", [])
        if self._message_contains_whitelist_domain(event.message_str, whitelist):
            return False

        is_admin = await self._is_group_admin(event)
        if is_admin and not await self.db.get(gid, "recall_admin_links", True):
            return False

        recall_success = False
        try:
            message_id = event.message_obj.message_id
            await event.bot.delete_msg(message_id=int(message_id))
            recall_success = True
        except Exception as exc:
            logger.warning(
                "撤回非白名单链接消息失败: group_id=%s, user_id=%s, error=%r",
                gid,
                event.get_sender_id(),
                exc,
                exc_info=True,
            )
        if recall_success:
            await self._send_link_recall_warning(event, gid)
            await self._handle_link_recall_kick(event, is_admin)

            if await self.db.get(gid, "link_recall_ban", False):
                if is_admin and not await self.db.get(gid, "link_recall_ban_admin", False):
                    return True
                ban_time = await self.db.get(gid, "link_recall_ban_time", 0)
                if ban_time > 0:
                    try:
                        await event.bot.set_group_ban(
                            group_id=int(event.get_group_id()),
                            user_id=int(event.get_sender_id()),
                            duration=int(ban_time),
                        )
                    except Exception:
                        logger.error(
                            f"bot在群{event.get_group_id()}权限不足，撤回链接后禁言失败"
                        )
        return True

    async def _handle_link_recall_kick(
        self, event: AiocqhttpMessageEvent, is_admin: bool
    ) -> bool:
        gid = event.get_group_id()
        threshold = await self.db.get(gid, "link_recall_kick_count", 0)
        try:
            threshold = int(threshold)
        except (TypeError, ValueError):
            threshold = 0
        if threshold <= 0 or is_admin:
            return False

        uid = str(event.get_sender_id())
        counts = await self.db.get(gid, "link_recall_counts", {})
        if not isinstance(counts, dict):
            counts = {}
        counts[uid] = int(counts.get(uid, 0) or 0) + 1

        if counts[uid] >= threshold:
            try:
                await event.bot.set_group_kick(
                    group_id=int(gid),
                    user_id=int(uid),
                    reject_add_request=False,
                )
                counts.pop(uid, None)
                await self.db.set(gid, "link_recall_counts", counts)
                logger.info(f"群{gid}用户{uid}链接撤回达到{threshold}次，已踢出")
                return True
            except Exception:
                logger.error(f"bot在群{gid}权限不足，链接撤回达到{threshold}次后踢出失败")

        await self.db.set(gid, "link_recall_counts", counts)
        return False

    async def check_ban_words(
        self, event: AiocqhttpMessageEvent, ban_words: list[str]
    ) -> bool:
        """检测违禁词并撤回消息"""
        gid = event.get_group_id()
        msg = event.message_str.lower()
        for word in ban_words:
            if word in msg:
                recall_success = False
                try:
                    message_id = event.message_obj.message_id
                    await event.bot.delete_msg(message_id=int(message_id))
                    recall_success = True
                except Exception:
                    pass
                if recall_success:
                    await self._send_link_recall_warning(event, gid)
                # 禁言发送者
                ban_time = await self.db.get(gid, "word_ban_time", 0)
                if ban_time > 0:
                    try:
                        await event.bot.set_group_ban(
                            group_id=int(event.get_group_id()),
                            user_id=int(event.get_sender_id()),
                            duration=ban_time,
                        )
                    except Exception:
                        logger.error(f"bot在群{event.get_group_id()}权限不足，禁言失败")
                        pass
                return True
        return False

    async def handle_spamming_ban_time(
        self, event: AiocqhttpMessageEvent, time: int | None
    ):
        """设置刷屏禁言时长"""
        gid = event.get_group_id()
        if isinstance(time, int):
            await self.db.set(gid, "spamming_ban_time", time)
            msg = (
                f"本群刷屏禁言时长已设为：{time} 秒"
                if time > 0
                else "本群刷屏禁言已关闭"
            )
            await event.send(event.plain_result(msg))
        else:
            status = await self.db.get(gid, "spamming_ban_time", 0)
            await event.send(event.plain_result(f"本群刷屏禁言时长：{status} 秒"))

    async def spamming_ban(self, event: AiocqhttpMessageEvent):
        """刷屏禁言"""
        group_id = event.get_group_id()
        sender_id = event.get_sender_id()
        ban_time = await self.db.get(group_id, "spamming_ban_time", 0)
        if (
            sender_id == event.get_self_id()
            or ban_time <= 0
            or len(event.get_messages()) == 0
        ):
            return

        now = time.time()

        last_time = self.last_banned_time[group_id][sender_id]
        if now - last_time < ban_time:
            return

        timestamps = self.msg_timestamps[group_id][sender_id]
        timestamps.append(now)
        count = self.cfg.spamming_count
        if len(timestamps) >= count:
            recent = list(timestamps)[-count:]
            intervals = [recent[i + 1] - recent[i] for i in range(count - 1)]
            if all(interval < self.cfg.spamming_interval for interval in intervals):
                # 提前写入禁止标记，防止并发重复禁
                self.last_banned_time[group_id][sender_id] = now

                try:
                    await event.bot.set_group_ban(
                        group_id=int(group_id),
                        user_id=int(sender_id),
                        duration=ban_time,
                    )
                    nickname = await get_nickname(event, sender_id)
                    await event.send(
                        event.plain_result(f"检测到{nickname}刷屏，已禁言")
                    )
                except Exception:
                    logger.error(f"bot在群{group_id}权限不足，禁言失败")
                timestamps.clear()

    async def start_vote_mute(self, event, ban_time: int | None = None):
        """
        发起投票禁言：如果已有对该用户的投票，直接提示
        """
        target_ids = get_ats(event)
        if not target_ids:
            return
        target_id = target_ids[0]
        group_id = event.get_group_id()
        group_config = self.db.get_group_snapshot(group_id)
        ban_time = self.cfg.get_ban_time_with_range(
            group_config.get("random_ban_time"), ban_time
        )

        if group_id in self.vote_cache:
            await event.send(event.plain_result("群内已有正在进行的禁言投票"))
            return

        vote_ban = group_config.get("vote_ban", {})
        ttl = int(vote_ban.get("ttl", self.cfg.vote_ban.ttl))
        threshold = int(vote_ban.get("threshold", self.cfg.vote_ban.threshold))

        expire_at = time.time() + ttl
        self.vote_cache[group_id] = {
            "target": target_id,
            "votes": {},
            "ban_time": ban_time,
            "expire": expire_at,
            "threshold": threshold,
        }

        nickname = await get_nickname(event, target_id)
        await event.send(
            event.plain_result(
                f"已发起对 {nickname} 的禁言投票(禁言{ban_time}秒)，输入“赞同禁言/反对禁言”进行表态，{ttl}秒后结算"
            )
        )

        # ===== 新增：定时结算逻辑 =====
        async def settle_vote():
            await asyncio.sleep(ttl)
            record = self.vote_cache.get(group_id)
            if not record:
                return  # 已被提前结算
            votes = list(record["votes"].values())
            agree_count = sum(votes)
            disagree_count = len(votes) - agree_count
            nickname2 = await get_nickname(event, record["target"])

            # 到期按多数票决定（平票视为否决）
            if agree_count > disagree_count:
                try:
                    await event.bot.set_group_ban(
                        group_id=int(group_id),
                        user_id=int(record["target"]),
                        duration=record["ban_time"],
                    )
                    await event.send(
                        event.plain_result(f"投票时间到！已禁言{nickname2}")
                    )
                except Exception:
                    logger.error(f"bot在群{group_id}权限不足，禁言失败")
            else:
                await event.send(
                    event.plain_result(f"投票时间到！禁言被否决，{nickname2}安全了")
                )
            # 清理投票记录
            del self.vote_cache[group_id]

        asyncio.create_task(settle_vote())

    async def vote_mute(self, event: AiocqhttpMessageEvent, agree: bool):
        """
        赞同/反对禁言
        agree=True 表示赞同，False 表示反对
        """
        group_id = event.get_group_id()
        voter_id = event.get_sender_id()

        record = self.vote_cache.get(group_id)
        if not record:
            await event.send(event.plain_result("当前没有进行中的禁言投票"))
            return

        threshold = record["threshold"]
        target_id = record["target"]

        # 记录/更新该用户的立场
        record["votes"][voter_id] = agree

        votes = list(record["votes"].values())
        agree_count = sum(votes)
        disagree_count = len(votes) - agree_count
        nickname = await get_nickname(event, target_id)

        # 提前达成赞同阈值 → 立即禁言
        if agree_count >= threshold:
            try:
                await event.bot.set_group_ban(
                    group_id=int(group_id),
                    user_id=int(target_id),
                    duration=record["ban_time"],
                )
                await event.send(event.plain_result(f"投票通过！已禁言{nickname}"))
            except Exception:
                logger.error(f"bot在群{group_id}权限不足，禁言失败")
            finally:
                # 清理记录（定时任务见前面会检测到记录已删除并直接返回）
                del self.vote_cache[group_id]
            return

        # 提前达成反对阈值 → 立即否决
        if disagree_count >= threshold:
            await event.send(event.plain_result(f"禁言投票被否决，{nickname}安全了"))
            del self.vote_cache[group_id]
            return

        # 否则展示当前进度
        await event.send(
            event.plain_result(
                f"禁言【{nickname}】：\n赞同({agree_count}/{threshold})\n反对({disagree_count}/{threshold})"
            )
        )
