import { createApi } from "./api.js";

const bridge = window.AstrBotPluginPage;
const root = document.documentElement;
const themeMediaQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

const THEME_STORAGE_KEY = "permission-controller-theme-mode";
const TONE_STORAGE_KEY = "permission-controller-tone-settings";
const GROUP_TOUCH_STORAGE_KEY = "permission-controller-group-touch-times";
const BACKGROUND_MAX_BYTES = 12 * 1024 * 1024;
const VALID_BACKGROUND_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DEFAULT_BACKGROUND_SETTINGS = {
  enabled: false,
  data_url: "",
  file_name: "",
  media_type: "",
  crop_x: 50,
  crop_y: 50,
  overlay: 0.42,
  blur: 0,
};
const DEFAULT_TONE_SETTINGS = {
  primary: "#25d8ff",
  secondary: "#8b74ff",
  glow: "#ff6fa9",
  backdropCard: "#5c78c8",
  panelOpacity: 0.22,
};
const PLUGIN_REGISTRY = [
  {
    id: "permission",
    directory: "astrbot_plugin_permission_controller",
    title: "权限控制器",
    shortTitle: "权限",
    eyebrow: "Permission",
    summary: "群聊、私聊、白名单、黑名单和思考强度的实时调用权限入口。",
    status: "已深度接入",
    tone: "policy",
    level: "平铺",
    routeHint: "当前页",
    modules: [
      { id: "objects", level: 1, title: "对象权限", summary: "群聊/私聊放行、允许名单、拒绝名单。", live: true },
      { id: "reasoning", level: 2, title: "思考强度", summary: "群默认、成员覆盖、私聊覆盖强度。", live: true },
      { id: "priority", level: 3, title: "判定优先级", summary: "拒绝名单、整群放行、允许名单、默认拦截。", live: false },
      { id: "backdrop", level: 2, title: "视觉背景", summary: "液态玻璃背景、GIF/图片上传和裁切焦点。", live: true },
    ],
  },
  {
    id: "raw-image",
    directory: "astrbot_plugin_general_raw_image_2026",
    title: "通用生图",
    shortTitle: "生图",
    eyebrow: "Image",
    summary: "多模型图像生成、服务商配置、起始图、工具路由和素材预设。",
    status: "已融合",
    tone: "creative",
    level: "平铺",
    routeHint: "pages/settings",
    modules: [
      { id: "providers", level: 1, title: "服务商与模型", summary: "OpenAI 兼容服务、模型档案、默认参数。", live: false },
      { id: "workflow", level: 2, title: "生成流程", summary: "提示词、起始图、工具路由和输出策略。", live: false },
      { id: "assets", level: 3, title: "素材与背景", summary: "背景库、上传图片、历史预览和复用素材。", live: false },
    ],
  },
  {
    id: "aip-review",
    directory: "astrbot_plugin_group_aip_review",
    title: "安全审核",
    shortTitle: "审核",
    eyebrow: "Audit",
    summary: "文本/图片审核、违规撤回、禁言、踢出、通知和分群策略。",
    status: "已融合",
    tone: "audit",
    level: "平铺",
    routeHint: "pages/settings",
    modules: [
      { id: "global-policy", level: 1, title: "全局审核", summary: "模型接口、审核阈值、文本/图片开关。", live: false },
      { id: "group-policy", level: 2, title: "分群策略", summary: "群级配置、启用群列表、覆盖策略。", live: false },
      { id: "violations", level: 3, title: "违规动作", summary: "撤回、禁言、踢出、通知和违规记录清理。", live: false },
    ],
  },
  {
    id: "qqadmin",
    directory: "astrbot_plugin_qqadmin",
    title: "QQ群管",
    shortTitle: "群管",
    eyebrow: "Admin",
    summary: "禁言、踢人、公告、审核、宵禁、违禁词、刷屏检测和群文件管理。",
    status: "已融合",
    tone: "admin",
    level: "平铺",
    routeHint: "pages/settings",
    modules: [
      { id: "actions", level: 1, title: "即时操作", summary: "禁言、全体禁言、踢人、拉黑、撤回。", live: false },
      { id: "automation", level: 2, title: "自动防护", summary: "宵禁、违禁词、刷屏检测、入群审核。", live: false },
      { id: "group-assets", level: 3, title: "群资料", summary: "群名片、头衔、公告、精华、群文件。", live: false },
    ],
  },
  {
    id: "webshot",
    directory: "astrbot_plugin_webpage_screenshot",
    title: "网页截图",
    shortTitle: "截图",
    eyebrow: "Capture",
    summary: "定时截取网页并推送到群聊或私聊，支持手动获取和运行状态。",
    status: "已融合",
    tone: "capture",
    level: "平铺",
    routeHint: "pages/settings",
    modules: [
      { id: "targets", level: 1, title: "截图目标", summary: "URL、群/私聊目标、启用状态。", live: false },
      { id: "schedule", level: 2, title: "计划投递", summary: "间隔、投递会话、失败重试和手动执行。", live: false },
      { id: "preview", level: 2, title: "预览监控", summary: "截图预览、最近运行和异常提示。", live: false },
    ],
  },
];
const PREVIEW_FUSION_PLUGINS = PLUGIN_REGISTRY.slice(1).map((plugin) => ({
  id: plugin.id,
  directory: plugin.directory,
  loaded: true,
  initialized: true,
  api_base: `/${plugin.directory}`,
  config_path: `data/config/${plugin.directory}_config.json`,
  bundled_page: `../../bundled_plugins/${plugin.directory}/pages/settings/index.html`,
}));
const FUSION_TARGET_LABELS = {
  global: "全局模板",
  groups: "群聊",
  privates: "私聊",
};
const ROLE_OPTIONS = ["超管", "群主", "管理员", "高等级成员", "成员"];
const ASPECT_RATIO_OPTIONS = ["不指定", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const FUSION_FIELD_LABELS = {
  enable_llm_tool: "启用 LLM 工具",
  name: "供应商名称",
  base_url: "API Base URL",
  proxy: "代理地址",
  api_keys: "API 密钥",
  available_models: "可用模型列表",
  capability_options: "模型能力",
  timeout: "超时时间覆盖（秒）",
  max_retry_attempts: "失败重试次数",
  enable_stream: "启用流式请求",
  model_family: "模型系列",
  watermark: "添加水印",
  sequential_image_generation: "组图模式",
  sequential_max_images: "组图最大生成张数",
  model: "模型",
  default_resolution: "默认分辨率",
  default_aspect_ratio: "默认宽高比",
  show_generation_info: "显示生成信息",
  show_model_info: "显示模型信息",
  max_concurrent_tasks: "最大并发任务数",
  reply_to_source_message: "完成后引用原消息",
  completion_reply_text: "完成回复文本",
  generation_failure_message_template: "失败发送文本",
  failure_reply_to_source_message: "失败后引用原消息",
  failure_mention_sender: "失败后艾特发送人",
  start_task_message_template: "开始任务提示模板",
  enable_start_task_image: "开始任务时发送固定图片",
  start_task_image_path: "开始绘图回复图片",
  enable_start_task_image_paths: "启用开始图片列表",
  start_task_image_paths: "开始图片列表",
  start_task_image_select_mode: "开始图片选择模式",
  enable_usage_limits: "启用使用限制",
  umo_blacklist: "会话 QQ 黑名单",
  admin_bypass_limits: "管理员无视使用限制",
  umo_whitelist: "使用限制白名单",
  blacklist_block_message: "黑名单拒绝提示",
  rate_limit_seconds: "速率限制（秒）",
  max_image_size_mb: "最大参考图大小（MB）",
  enable_daily_limit: "启用每日额度",
  daily_limit_count: "每日额度",
  api_key: "API Key",
  audit_prompt: "审核提示词",
  log_level: "日志级别",
  group_id: "群号",
  remark_name: "备注名",
  enabled: "启用",
  notify_group_id: "通知群号",
  enable_text_censor: "启用文本审核",
  enable_image_censor: "启用图片审核",
  skip_admin_messages: "跳过管理员消息",
  debug_trace: "输出诊断日志",
  single_user_violation_threshold: "单人违规阈值",
  group_violation_threshold: "群违规阈值",
  time_window: "时间窗口（天）",
  mute_duration: "禁言时长（秒）",
  mute_kick_threshold: "禁言次数踢出阈值",
  kick_user: "启用踢人",
  kick_user_threshold: "踢人阈值",
  is_kick_user_and_block: "踢出并拉黑用户",
  violation_notice_template: "确认违规通知模板",
  suspicious_notice_template: "疑似违规通知模板",
  group_admin_enabled: "群聊总开关",
  random_ban_time: "随机禁言配置",
  ttl: "投票时长（秒）",
  threshold: "投票通过票数",
  llm_get_msg_count: "取名消息轮数",
  level_threshold: "高等级成员阈值",
  join_switch: "进群审核",
  join_min_level: "进群等级门槛",
  join_max_time: "进群最大尝试次数",
  join_accept_words: "进群白词",
  join_reject_words: "进群黑词",
  join_no_match_reject: "未命中白词自动拒绝",
  reject_word_block: "命中黑词自动拉黑",
  block_ids: "进群黑名单",
  join_welcome: "进群欢迎词",
  join_ban_time: "进群禁言时长",
  builtin_ban: "启用内置禁词",
  custom_ban_words: "自定义违禁词",
  word_ban_time: "触发禁词禁言时长",
  spamming_ban_time: "刷屏禁言时长",
  link_whitelist: "链接白名单",
  filter_non_whitelist_links: "过滤非白名单链接",
  recall_admin_links: "撤回管理员链接",
  link_recall_ban: "链接撤回后禁言",
  link_recall_ban_time: "链接撤回禁言时长",
  link_recall_warn: "链接/禁词撤回提醒",
  link_recall_warn_text: "链接/禁词警告语",
  link_recall_kick_count: "链接撤回踢出次数",
  join_notice_enabled: "进群通知",
  join_notice_admin_ids: "进群事件通知 ID",
  leave_notify: "主动退群通知",
  leave_block: "主动退群拉黑",
  default_viewport_width: "默认浏览器窗口宽度",
  default_viewport_height: "默认浏览器窗口高度",
  default_wait_seconds: "默认页面等待秒数",
  platform: "平台实例 ID",
  platform_type: "平台类型",
  url: "截图 URL",
  send_to: "发送到",
  target_id: "目标 ID",
  screenshot_text: "附加说明文本",
  interval_minutes: "投递间隔（分钟）",
  wait_seconds: "页面等待秒数",
  timeout_seconds: "截图超时秒数",
  viewport_width: "任务窗口宽度",
  viewport_height: "任务窗口高度",
  send_text: "发送附加文本",
  mention_and_quote_sender: "引用并提醒触发者",
  notify_on_failure: "失败时通知",
  last_status: "最近状态",
  last_error: "最近异常",
  note: "运维备注",
  "fusion_access.enabled": "当前对象启用",
  "fusion_access.enable_groups": "群聊启用",
  "fusion_access.enable_privates": "私聊启用",
  enable_groups: "群聊启用",
  enable_privates: "私聊启用",
};
const FUSION_ACCESS_PATH = "fusion_access.enabled";
const FUSION_ACCESS_LEGACY_PATHS = {
  groups: "fusion_access.enable_groups",
  privates: "fusion_access.enable_privates",
};
const FUSION_ACCESS_SECTION = {
  level: 2,
  title: "当前对象启用",
  summary: "根据第二列当前选中的群聊或私聊，保存该对象自己的启用状态。",
  fields: [FUSION_ACCESS_PATH],
  custom: {
    fusion_access: {
      enabled: {
        description: "当前对象启用",
        type: "bool",
        default: true,
        hint: "只影响当前选中的群聊或私聊对象。",
      },
    },
  },
};
const FUSION_OBJECT_STATUS_RULES = {
  "raw-image": {
    label: "通用生图",
    moduleId: "providers",
    paths: { groups: FUSION_ACCESS_PATH, privates: FUSION_ACCESS_PATH },
    legacyPaths: FUSION_ACCESS_LEGACY_PATHS,
    defaultValue: true,
  },
  "aip-review": {
    label: "安全审核",
    moduleId: "global-policy",
    paths: { groups: FUSION_ACCESS_PATH, privates: FUSION_ACCESS_PATH },
    legacyPaths: FUSION_ACCESS_LEGACY_PATHS,
    defaultValue: true,
  },
  webshot: {
    label: "网页截图",
    moduleId: "targets",
    paths: { groups: FUSION_ACCESS_PATH, privates: FUSION_ACCESS_PATH },
    legacyPaths: FUSION_ACCESS_LEGACY_PATHS,
    defaultValue: true,
  },
  qqadmin: {
    label: "QQ群管",
    moduleId: "actions",
    paths: { groups: "default.group_admin_enabled" },
    defaultValue: true,
    unavailableText: "仅群聊",
  },
};
const FUSION_CONFIG_LAYOUT = {
  "raw-image": {
    providers: [
      FUSION_ACCESS_SECTION,
      {
        level: 2,
        title: "工具开关",
        summary: "决定 LLM 是否可以调用生图工具。",
        fields: ["enable_llm_tool"],
      },
      {
        level: 3,
        title: "OpenAI 兼容供应商",
        summary: "常用中转、OpenAI、Grok、Gemini 兼容端点。",
        fields: [
          "api_providers.openai.name",
          "api_providers.openai.base_url",
          "api_providers.openai.proxy",
          "api_providers.openai.model_family",
          "api_providers.openai.timeout",
          "api_providers.openai.max_retry_attempts",
        ],
        children: [
          {
            level: 4,
            title: "密钥与模型能力",
            summary: "把密钥、模型名和能力勾选集中在高级层，避免主表单过长。",
            fields: [
              "api_providers.openai.api_keys",
              "api_providers.openai.available_models",
              "api_providers.openai.capability_options",
              "api_providers.openai.enable_stream",
            ],
          },
        ],
      },
      {
        level: 3,
        title: "Gemini / Grok / 火山",
        summary: "多供应商模板字段，可按对象记录覆盖值。",
        fields: [
          "api_providers.gemini.base_url",
          "api_providers.gemini.api_keys",
          "api_providers.gemini.available_models",
          "api_providers.grok.base_url",
          "api_providers.grok.api_keys",
          "api_providers.volcengine_ark.watermark",
          "api_providers.volcengine_ark.sequential_image_generation",
          "api_providers.volcengine_ark.sequential_max_images",
        ],
      },
    ],
    workflow: [
      {
        level: 2,
        title: "生成参数",
        summary: "模型、尺寸、比例、超时和并发上限。",
        fields: [
          "generation.model",
          "generation.timeout",
          "generation.max_retry_attempts",
          "generation.default_resolution",
          "generation.default_aspect_ratio",
          "generation.max_concurrent_tasks",
          "generation.show_generation_info",
          "generation.show_model_info",
        ],
      },
      {
        level: 3,
        title: "回复策略",
        summary: "任务开始、成功、失败时的消息表现。",
        fields: [
          "generation.reply_to_source_message",
          "generation.completion_reply_text",
          "generation.generation_failure_message_template",
          "generation.failure_reply_to_source_message",
          "generation.failure_mention_sender",
          "generation.start_task_message_template",
        ],
      },
    ],
    assets: [
      {
        level: 2,
        title: "开始任务图片",
        summary: "开始生图时的固定图或图片列表。",
        fields: [
          "generation.enable_start_task_image",
          "generation.start_task_image_path",
          "generation.enable_start_task_image_paths",
          "generation.start_task_image_paths",
          "generation.start_task_image_select_mode",
        ],
      },
      {
        level: 3,
        title: "使用限制",
        summary: "按会话、用户和额度保存覆盖策略。",
        fields: [
          "user_limits.enable_usage_limits",
          "user_limits.umo_blacklist",
          "user_limits.admin_bypass_limits",
          "user_limits.umo_whitelist",
          "user_limits.blacklist_block_message",
          "user_limits.rate_limit_seconds",
          "user_limits.max_image_size_mb",
          "user_limits.enable_daily_limit",
          "user_limits.daily_limit_count",
        ],
      },
    ],
  },
  "aip-review": {
    "global-policy": [
      FUSION_ACCESS_SECTION,
      {
        level: 2,
        title: "AI 审核接口",
        summary: "接口地址、密钥、模型、超时和全局审核提示词。",
        fields: [
          "openai_audit.base_url",
          "openai_audit.api_key",
          "openai_audit.model",
          "openai_audit.timeout",
          "openai_audit.audit_prompt",
          "log_level",
        ],
      },
    ],
    "group-policy": [
      {
        level: 2,
        title: "群级审核开关",
        summary: "当前群/私聊对象的审核启用、通知和内容类型。",
        fields: [
          "disposal.group_custom.default_group_config.group_id",
          "disposal.group_custom.default_group_config.remark_name",
          "disposal.group_custom.default_group_config.enabled",
          "disposal.group_custom.default_group_config.notify_group_id",
          "disposal.group_custom.default_group_config.enable_text_censor",
          "disposal.group_custom.default_group_config.enable_image_censor",
        ],
      },
      {
        level: 3,
        title: "跳过与诊断",
        summary: "管理员消息、诊断日志和独立审核提示词。",
        fields: [
          "disposal.group_custom.default_group_config.skip_admin_messages",
          "disposal.group_custom.default_group_config.debug_trace",
          "disposal.group_custom.default_group_config.audit_prompt",
        ],
      },
    ],
    violations: [
      {
        level: 2,
        title: "违规阈值",
        summary: "单人、群级、时间窗口和禁言阈值。",
        fields: [
          "disposal.group_custom.default_group_config.single_user_violation_threshold",
          "disposal.group_custom.default_group_config.group_violation_threshold",
          "disposal.group_custom.default_group_config.time_window",
          "disposal.group_custom.default_group_config.mute_duration",
          "disposal.group_custom.default_group_config.mute_kick_threshold",
        ],
      },
      {
        level: 3,
        title: "处置动作",
        summary: "踢出、拉黑和通知模板。",
        fields: [
          "disposal.group_custom.default_group_config.kick_user",
          "disposal.group_custom.default_group_config.kick_user_threshold",
          "disposal.group_custom.default_group_config.is_kick_user_and_block",
          "disposal.group_custom.default_group_config.violation_notice_template",
          "disposal.group_custom.default_group_config.suspicious_notice_template",
        ],
      },
    ],
  },
  qqadmin: {
    actions: [
      {
        level: 2,
        title: "群管总控",
        summary: "群管总开关、随机禁言、投票禁言和等级阈值。",
        fields: [
          "default.group_admin_enabled",
          "random_ban_time",
          "vote_ban.ttl",
          "vote_ban.threshold",
          "llm_get_msg_count",
          "level_threshold",
        ],
        custom: {
          default: {
            group_admin_enabled: {
              description: "群聊总开关",
              type: "bool",
              default: true,
              hint: "关闭后，该群不启用 QQ群管能力。",
            },
          },
        },
      },
      {
        level: 3,
        title: "即时操作权限",
        summary: "禁言、踢人、撤回、拉黑等指令等级。",
        fields: [
          "perms.set_group_ban",
          "perms.cancel_group_ban",
          "perms.whole_ban",
          "perms.set_group_kick",
          "perms.set_group_block",
          "perms.delete_msg",
          "perms.admin",
        ],
      },
    ],
    automation: [
      {
        level: 2,
        title: "入群审核",
        summary: "进群门槛、白词、黑词、黑名单和欢迎配置。",
        fields: [
          "default.join_switch",
          "default.join_min_level",
          "default.join_max_time",
          "default.join_accept_words",
          "default.join_reject_words",
          "default.join_no_match_reject",
          "default.reject_word_block",
          "default.block_ids",
          "default.join_welcome",
          "default.join_ban_time",
        ],
      },
      {
        level: 3,
        title: "防刷屏与链接",
        summary: "违禁词、刷屏、链接白名单和撤回处罚。",
        fields: [
          "default.builtin_ban",
          "default.custom_ban_words",
          "default.word_ban_time",
          "default.spamming_ban_time",
          "default.link_whitelist",
          "default.filter_non_whitelist_links",
          "default.recall_admin_links",
          "default.link_recall_ban",
          "default.link_recall_ban_time",
          "default.link_recall_warn",
          "default.link_recall_warn_text",
          "default.link_recall_kick_count",
        ],
      },
      {
        level: 4,
        title: "通知与退群",
        summary: "进群通知、退群通知和拉黑。",
        fields: [
          "join_notice_enabled",
          "join_notice_admin_ids",
          "default.leave_notify",
          "default.leave_block",
        ],
      },
    ],
    "group-assets": [
      {
        level: 2,
        title: "群资料权限",
        summary: "公告、群名、群头像、精华和文件操作等级。",
        fields: [
          "perms.send_group_notice",
          "perms.get_group_notice",
          "perms.set_group_portrait",
          "perms.set_group_name",
          "perms.essence",
          "perms.get_essence_msg_list",
          "perms.upload_group_file",
          "perms.delete_group_file",
          "perms.view_group_file",
        ],
      },
      {
        level: 3,
        title: "成员资料",
        summary: "群名片、头衔、群友信息与 AI 取名。",
        fields: [
          "perms.set_group_card",
          "perms.set_group_card_me",
          "perms.set_group_special_title",
          "perms.set_group_special_title_me",
          "perms.get_group_member_list",
          "perms.clear_group_member",
          "perms.ai_set_card",
          "perms.ai_set_title",
        ],
      },
    ],
  },
  webshot: {
    targets: [
      FUSION_ACCESS_SECTION,
      {
        level: 2,
        title: "目标与投递",
        summary: "为当前对象记录截图任务的 URL、启用状态和目标会话。",
        fields: [
          "task.name",
          "task.enabled",
          "task.url",
          "task.send_to",
          "task.target_id",
          "task.screenshot_text",
        ],
        custom: {
          task: {
            name: { description: "任务名称", type: "string", default: "" },
            enabled: { description: "启用任务", type: "bool", default: false },
            url: { description: "截图 URL", type: "string", default: "" },
            send_to: { description: "发送到", type: "string", options: ["群聊", "私聊"], default: "群聊" },
            target_id: { description: "目标 ID", type: "string", default: "" },
            screenshot_text: { description: "附加说明文本", type: "text", default: "" },
          },
        },
      },
    ],
    schedule: [
      {
        level: 2,
        title: "截图默认参数",
        summary: "浏览器窗口、等待时间和当前任务投递间隔。",
        fields: [
          "screenshot_settings.default_viewport_width",
          "screenshot_settings.default_viewport_height",
          "screenshot_settings.default_wait_seconds",
          "task.interval_minutes",
          "task.wait_seconds",
          "task.timeout_seconds",
        ],
        custom: {
          task: {
            interval_minutes: { description: "投递间隔（分钟）", type: "float", default: "" },
            wait_seconds: { description: "页面等待秒数", type: "float", default: "" },
            timeout_seconds: { description: "截图超时秒数", type: "float", default: "" },
          },
        },
      },
      {
        level: 3,
        title: "高级运行",
        summary: "平台实例、平台类型和消息发送行为。",
        fields: [
          "advanced_settings.platform",
          "advanced_settings.platform_type",
          "task.viewport_width",
          "task.viewport_height",
          "task.send_text",
          "task.mention_and_quote_sender",
          "task.notify_on_failure",
        ],
        custom: {
          task: {
            viewport_width: { description: "任务窗口宽度", type: "int", default: "" },
            viewport_height: { description: "任务窗口高度", type: "int", default: "" },
            send_text: { description: "发送附加文本", type: "bool", default: false },
            mention_and_quote_sender: { description: "引用并提醒触发者", type: "bool", default: false },
            notify_on_failure: { description: "失败时通知", type: "bool", default: false },
          },
        },
      },
    ],
    preview: [
      {
        level: 2,
        title: "预览与状态",
        summary: "保留最近运行和异常提示的对象级备注。",
        fields: [
          "preview.last_status",
          "preview.last_error",
          "preview.note",
        ],
        custom: {
          preview: {
            last_status: { description: "最近状态", type: "string", options: ["未运行", "成功", "失败", "暂停"], default: "未运行" },
            last_error: { description: "最近异常", type: "text", default: "" },
            note: { description: "运维备注", type: "text", default: "" },
          },
        },
      },
    ],
  },
};
const PREVIEW_GROUPS = [
  {
    group_id: "10086001",
    group_name: "Developers Hub",
    avatar: "",
    group_enabled: true,
    reasoning_effort: "medium",
    config_updated_at: Date.now() - 1000 * 60 * 8,
  },
  {
    group_id: "10086002",
    group_name: "Design Community",
    avatar: "",
    group_enabled: true,
    reasoning_effort: "high",
    config_updated_at: Date.now() - 1000 * 60 * 42,
  },
  {
    group_id: "10086003",
    group_name: "Product Discussion",
    avatar: "",
    group_enabled: false,
    reasoning_effort: "",
    config_updated_at: Date.now() - 1000 * 60 * 88,
  },
  {
    group_id: "10086004",
    group_name: "General Chat",
    avatar: "",
    group_enabled: true,
    reasoning_effort: "low",
    config_updated_at: Date.now() - 1000 * 60 * 160,
  },
  {
    group_id: "10086005",
    group_name: "AI Enthusiasts",
    avatar: "",
    group_enabled: false,
    reasoning_effort: "medium",
    config_updated_at: Date.now() - 1000 * 60 * 220,
  },
];
const PREVIEW_PRIVATE_CONTACTS = [
  {
    user_id: "26880001",
    nickname: "Admin",
    remark: "Super Administrator",
    avatar: "",
    source: "configured",
    private_enabled: true,
    reasoning_effort: "high",
  },
  {
    user_id: "26880002",
    nickname: "Ops Helper",
    remark: "风险巡检",
    avatar: "",
    source: "configured",
    private_enabled: false,
    reasoning_effort: "medium",
  },
];
const REASONING_OPTIONS = [
  ["", "默认"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高 / 超高"],
];
const PRECISE_LOCATION_TARGET_METERS = 100;
const PRECISE_LOCATION_TIMEOUT_MS = 18000;
const PRECISE_LOCATION_MAX_AGE_MS = 30 * 1000;

let api = null;
let groups = [];
let privateContacts = [];
let bootstrapConfig = {};
let fusionPlugins = [];
let fusionAccessIndex = {};
let activeMode = "groups";
let selected = null;
let themePreference = loadThemePreference();
let toneSettings = loadToneSettings();
let backgroundSettings = { ...DEFAULT_BACKGROUND_SETTINGS };
let tonePersistTimer = 0;
let backgroundPersistTimer = 0;
let pointerFrame = 0;
let activePluginId = "permission";
let activeFusionRenderToken = 0;
let activeFusionConfig = null;
let fusionConfigCache = new Map();
let previewFusionOverrides = {};
let previewMode = false;

const els = {
  groupList: document.getElementById("groupList"),
  groupForm: document.getElementById("groupForm"),
  pluginNav: document.getElementById("pluginNav"),
  pluginStack: document.getElementById("pluginStack"),
  railItems: Array.from(document.querySelectorAll("[data-rail-plugin]")),
  railThemeBtn: document.getElementById("railThemeBtn"),
  pluginCount: document.getElementById("pluginCount"),
  activePluginLabel: document.getElementById("activePluginLabel"),
  permissionObjectPanel: document.getElementById("permissionObjectPanel"),
  groupSearchInput: document.getElementById("groupSearchInput"),
  currentScopeLabel: document.getElementById("currentScopeLabel"),
  currentGroupTitle: document.getElementById("currentGroupTitle"),
  currentGroupMeta: document.getElementById("currentGroupMeta"),
  toastLayer: document.getElementById("toastLayer"),
  toggleThemeBtn: document.getElementById("toggleThemeBtn"),
  themeText: document.getElementById("themeText"),
  refreshGroupsBtn: document.getElementById("refreshGroupsBtn"),
  resetGroupBtn: document.getElementById("resetGroupBtn"),
  saveGroupBtn: document.getElementById("saveGroupBtn"),
  groupTabBtn: document.getElementById("groupTabBtn"),
  privateTabBtn: document.getElementById("privateTabBtn"),
  listTitle: document.getElementById("listTitle"),
  listCount: document.getElementById("listCount"),
  metricGrid: document.getElementById("metricGrid"),
  selectedSummary: document.getElementById("selectedSummary"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  currentDateLabel: document.getElementById("currentDateLabel"),
  systemVersionLabel: document.getElementById("systemVersionLabel"),
  pythonVersionLabel: document.getElementById("pythonVersionLabel"),
  weatherLabel: document.getElementById("weatherLabel"),
  weatherMetaLabel: document.getElementById("weatherMetaLabel"),
  backgroundInput: document.getElementById("backgroundInput"),
  uploadBackgroundBtn: document.getElementById("uploadBackgroundBtn"),
  resetBackgroundBtn: document.getElementById("resetBackgroundBtn"),
  backgroundDropzone: document.getElementById("backgroundDropzone"),
  backgroundFileName: document.getElementById("backgroundFileName"),
  backgroundStatusLabel: document.getElementById("backgroundStatusLabel"),
  backgroundCropX: document.getElementById("backgroundCropX"),
  backgroundCropY: document.getElementById("backgroundCropY"),
  backgroundOverlay: document.getElementById("backgroundOverlay"),
  backgroundBlur: document.getElementById("backgroundBlur"),
  panelOpacityInput: document.getElementById("panelOpacityInput"),
  tonePrimaryInput: document.getElementById("tonePrimaryInput"),
  toneSecondaryInput: document.getElementById("toneSecondaryInput"),
  toneGlowInput: document.getElementById("toneGlowInput"),
  toneBackdropCardInput: document.getElementById("toneBackdropCardInput"),
  resetToneBtn: document.getElementById("resetToneBtn"),
  railAdminTitle: document.querySelector(".rail-admin strong"),
  railAdminMeta: document.querySelector(".rail-admin em"),
  fusionLoadedCount: document.getElementById("fusionLoadedCount"),
  fusionObjectCount: document.getElementById("fusionObjectCount"),
  fusionMenuCount: document.getElementById("fusionMenuCount"),
  fusionHealthText: document.getElementById("fusionHealthText"),
  fusionHealthMeta: document.getElementById("fusionHealthMeta"),
  fusionInitializedCount: document.getElementById("fusionInitializedCount"),
  fusionPendingCount: document.getElementById("fusionPendingCount"),
  fusionErrorCount: document.getElementById("fusionErrorCount"),
};

function isValidThemePreference(value) {
  return value === "light" || value === "dark" || value === "auto";
}

function loadThemePreferenceFromCookie() {
  try {
    const prefix = `${THEME_STORAGE_KEY}=`;
    const matched = (document.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    if (!matched) return null;
    const value = decodeURIComponent(matched.slice(prefix.length));
    return isValidThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

function loadThemePreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidThemePreference(stored)) return stored;
  } catch {}
  return loadThemePreferenceFromCookie() || "auto";
}

function saveThemePreference() {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  } catch {}
  try {
    document.cookie = `${THEME_STORAGE_KEY}=${encodeURIComponent(themePreference)}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

function readCookieValue(key) {
  try {
    const prefix = `${key}=`;
    const matched = (document.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    return matched ? decodeURIComponent(matched.slice(prefix.length)) : "";
  } catch {
    return "";
  }
}

function writeCookieValue(key, value) {
  try {
    document.cookie = `${key}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

function normalizeHexColor(value, fallback) {
  const text = String(value || "").trim();
  const match = text.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

function hexToRgbTriplet(hex) {
  const value = normalizeHexColor(hex, "#000000").slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbText(hex) {
  return hexToRgbTriplet(hex).join(", ");
}

function mixRgbText(foregroundHex, baseHex, ratio) {
  const foreground = hexToRgbTriplet(foregroundHex);
  const base = hexToRgbTriplet(baseHex);
  const amount = Math.min(1, Math.max(0, Number(ratio)));
  return foreground
    .map((channel, index) => Math.round(base[index] * (1 - amount) + channel * amount))
    .join(", ");
}

function normalizeToneSettings(settings = {}) {
  return {
    primary: normalizeHexColor(settings.primary, DEFAULT_TONE_SETTINGS.primary),
    secondary: normalizeHexColor(settings.secondary, DEFAULT_TONE_SETTINGS.secondary),
    glow: normalizeHexColor(settings.glow, DEFAULT_TONE_SETTINGS.glow),
    backdropCard: normalizeHexColor(settings.backdropCard, DEFAULT_TONE_SETTINGS.backdropCard),
    panelOpacity: clampNumber(settings.panelOpacity, DEFAULT_TONE_SETTINGS.panelOpacity, 0.04, 0.38),
  };
}

function loadToneSettings() {
  const fromCookie = readCookieValue(TONE_STORAGE_KEY);
  const candidates = [];
  try {
    candidates.push(window.localStorage.getItem(TONE_STORAGE_KEY) || "");
  } catch {}
  candidates.push(fromCookie);
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      return normalizeToneSettings(JSON.parse(raw));
    } catch {}
  }
  return { ...DEFAULT_TONE_SETTINGS };
}

function saveToneSettings() {
  try {
    window.localStorage.setItem(TONE_STORAGE_KEY, JSON.stringify(toneSettings));
  } catch {}
  writeCookieValue(TONE_STORAGE_KEY, JSON.stringify(toneSettings));
}

function applyToneSettings(settings = {}) {
  toneSettings = normalizeToneSettings(settings);
  root.style.setProperty("--accent", toneSettings.primary);
  root.style.setProperty("--accent-rgb", rgbText(toneSettings.primary));
  root.style.setProperty("--accent-2", toneSettings.secondary);
  root.style.setProperty("--accent-2-rgb", rgbText(toneSettings.secondary));
  root.style.setProperty("--accent-4", toneSettings.glow);
  root.style.setProperty("--accent-4-rgb", rgbText(toneSettings.glow));
  const bgA = mixRgbText(toneSettings.primary, "#355f95", 0.45);
  const bgB = mixRgbText(toneSettings.secondary, "#314a7a", 0.40);
  const bgC = mixRgbText(toneSettings.glow, "#392d67", 0.34);
  const surface = mixRgbText(toneSettings.primary, "#466aa6", 0.28);
  const surfaceDeep = mixRgbText(toneSettings.secondary, "#304c86", 0.22);
  const backdropCard = mixRgbText(toneSettings.backdropCard, "#4267a8", 0.68);
  const backdropCardDeep = mixRgbText(toneSettings.backdropCard, "#263d78", 0.42);
  root.style.setProperty("--bg", `rgb(${bgA})`);
  root.style.setProperty("--bg-2", `rgb(${bgC})`);
  root.style.setProperty("--tone-bg-a", `rgb(${bgA})`);
  root.style.setProperty("--tone-bg-b", `rgb(${bgB})`);
  root.style.setProperty("--tone-bg-c", `rgb(${bgC})`);
  root.style.setProperty("--tone-surface-rgb", surface);
  root.style.setProperty("--tone-surface-deep-rgb", surfaceDeep);
  root.style.setProperty("--backdrop-card-rgb", backdropCard);
  root.style.setProperty("--backdrop-card-deep-rgb", backdropCardDeep);
  root.style.setProperty("--panel-alpha", String(toneSettings.panelOpacity));
  root.style.setProperty("--panel-alpha-strong", String(Math.min(0.52, toneSettings.panelOpacity + 0.14)));
  root.style.setProperty("--panel-alpha-soft", String(Math.max(0.04, toneSettings.panelOpacity * 0.72)));
  root.style.setProperty("--panel-border-alpha", String(Math.min(0.36, toneSettings.panelOpacity + 0.08)));
  if (els.tonePrimaryInput) els.tonePrimaryInput.value = toneSettings.primary;
  if (els.toneSecondaryInput) els.toneSecondaryInput.value = toneSettings.secondary;
  if (els.toneGlowInput) els.toneGlowInput.value = toneSettings.glow;
  if (els.toneBackdropCardInput) els.toneBackdropCardInput.value = toneSettings.backdropCard;
  if (els.panelOpacityInput) els.panelOpacityInput.value = String(Math.round(toneSettings.panelOpacity * 100));
}

function collectToneControls() {
  return {
    primary: els.tonePrimaryInput?.value || toneSettings.primary,
    secondary: els.toneSecondaryInput?.value || toneSettings.secondary,
    glow: els.toneGlowInput?.value || toneSettings.glow,
    backdropCard: els.toneBackdropCardInput?.value || toneSettings.backdropCard,
    panelOpacity: Number(els.panelOpacityInput?.value || toneSettings.panelOpacity * 100) / 100,
  };
}

function updateToneFromControls(options = {}) {
  applyToneSettings(collectToneControls());
  saveToneSettings();
  if (options.immediate) persistToneSettingsNow();
  else scheduleTonePersist();
}

function resetToneSettings() {
  applyToneSettings(DEFAULT_TONE_SETTINGS);
  saveToneSettings();
  persistToneSettingsNow();
}

async function loadToneFromBackend() {
  if (!api) return;
  try {
    const result = await api.safeGet("/settings/tone");
    const next = result?.tone || result;
    applyToneSettings(next);
    saveToneSettings();
  } catch {}
}

function persistToneSettingsNow() {
  if (!api) return;
  window.clearTimeout(tonePersistTimer);
  api.safePost("/settings/tone", { tone: toneSettings }).catch(() => {});
}

function scheduleTonePersist() {
  if (!api) return;
  window.clearTimeout(tonePersistTimer);
  tonePersistTimer = window.setTimeout(persistToneSettingsNow, 260);
}

function effectiveTheme() {
  if (themePreference === "auto") {
    return themeMediaQuery && themeMediaQuery.matches ? "dark" : "light";
  }
  return themePreference;
}

function themeLabel() {
  if (themePreference === "dark") return "深色";
  if (themePreference === "light") return "浅色";
  return "自动";
}

function applyTheme() {
  root.setAttribute("data-theme", effectiveTheme());
  if (els.themeText) els.themeText.textContent = themeLabel();
}

async function loadThemeFromBackend() {
  if (!api) return;
  try {
    const result = await api.safeGet("/settings/theme");
    const value = result?.theme || result;
    if (isValidThemePreference(value)) {
      themePreference = value;
      saveThemePreference();
    }
  } catch {}
}

function saveThemeToBackend() {
  if (!api) return;
  api.safePost("/settings/theme", { theme: themePreference }).catch(() => {});
}

function cycleTheme() {
  themePreference =
    themePreference === "auto" ? "light" : themePreference === "light" ? "dark" : "auto";
  saveThemePreference();
  saveThemeToBackend();
  applyTheme();
}

function activePlugin() {
  return PLUGIN_REGISTRY.find((plugin) => plugin.id === activePluginId) || PLUGIN_REGISTRY[0];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fusionStatusFor(plugin) {
  return fusionPlugins.find((item) => item.id === plugin.id || item.directory === plugin.directory) || null;
}

function fusionCacheKey(pluginId, targetType, targetId) {
  return `${pluginId}::${targetType}::${targetId || "default"}`;
}

function ensureAccessIndexBucket(pluginId, targetType, targetId, moduleId) {
  if (!fusionAccessIndex[pluginId]) fusionAccessIndex[pluginId] = {};
  if (!fusionAccessIndex[pluginId][targetType]) fusionAccessIndex[pluginId][targetType] = {};
  if (!fusionAccessIndex[pluginId][targetType][targetId]) fusionAccessIndex[pluginId][targetType][targetId] = {};
  if (!fusionAccessIndex[pluginId][targetType][targetId][moduleId]) {
    fusionAccessIndex[pluginId][targetType][targetId][moduleId] = {};
  }
  return fusionAccessIndex[pluginId][targetType][targetId][moduleId];
}

function fusionWatchedPaths(rule) {
  return Array.from(new Set([
    ...Object.values(rule?.paths || {}),
    ...Object.values(rule?.legacyPaths || {}),
  ].filter(Boolean)));
}

function syncFusionAccessIndex(plugin, target, modules = {}) {
  const rule = FUSION_OBJECT_STATUS_RULES[plugin.id];
  if (!rule || !target?.type || !target?.id) return;
  const watchedPaths = fusionWatchedPaths(rule);
  const moduleValues = modules?.[rule.moduleId]?.values;
  const bucket = ensureAccessIndexBucket(plugin.id, target.type, target.id, rule.moduleId);
  watchedPaths.forEach((path) => {
    if (moduleValues && Object.prototype.hasOwnProperty.call(moduleValues, path)) {
      bucket[path] = moduleValues[path];
    } else {
      delete bucket[path];
    }
  });
}

function rememberFusionConfig(plugin, target, data = {}) {
  if (!plugin?.id || !target?.type || !target?.id) return;
  const normalized = {
    ...data,
    modules: data.modules && typeof data.modules === "object" ? data.modules : {},
  };
  fusionConfigCache.set(fusionCacheKey(plugin.id, target.type, target.id), normalized);
  syncFusionAccessIndex(plugin, target, normalized.modules);
}

function fusionIndexedValues(pluginId, targetType, targetId, moduleId) {
  const cached = fusionConfigCache.get(fusionCacheKey(pluginId, targetType, targetId));
  const cachedValues = cached?.modules?.[moduleId]?.values;
  if (cachedValues && typeof cachedValues === "object") return cachedValues;
  const indexedValues = fusionAccessIndex?.[pluginId]?.[targetType]?.[targetId]?.[moduleId];
  return indexedValues && typeof indexedValues === "object" ? indexedValues : null;
}

function fusionStatusValue(plugin, targetType, targetId, moduleId, paths, fallback) {
  const candidates = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
  const specificValues = fusionIndexedValues(plugin.id, targetType, targetId, moduleId);
  for (const path of candidates) {
    if (specificValues && Object.prototype.hasOwnProperty.call(specificValues, path)) {
      return specificValues[path];
    }
  }
  const globalValues = fusionIndexedValues(plugin.id, "global", "default", moduleId);
  for (const path of candidates) {
    if (globalValues && Object.prototype.hasOwnProperty.call(globalValues, path)) {
      return globalValues[path];
    }
  }
  return fallback;
}

function fusionObjectStatus(plugin, targetType, targetId) {
  const rule = FUSION_OBJECT_STATUS_RULES[plugin.id];
  if (!rule) return null;
  const path = rule.paths?.[targetType];
  if (!path) {
    return {
      parts: [`${rule.label} ${rule.unavailableText || "不适用"}`],
      kind: "is-neutral",
    };
  }
  const enabled = Boolean(
    fusionStatusValue(
      plugin,
      targetType,
      targetId,
      rule.moduleId,
      [path, rule.legacyPaths?.[targetType]],
      rule.defaultValue,
    ),
  );
  return {
    parts: [`${rule.label} ${enabled ? "开" : "关"}`],
    kind: enabled ? "is-on" : "is-off",
  };
}

function setPermissionChrome(visible) {
  els.permissionObjectPanel?.toggleAttribute("hidden", false);
  const canEdit = activePluginId !== "permission" || Boolean(visible && activePluginId === "permission");
  if (els.saveGroupBtn) els.saveGroupBtn.hidden = !canEdit;
  if (els.resetGroupBtn) els.resetGroupBtn.hidden = !canEdit;
  if (els.refreshGroupsBtn) els.refreshGroupsBtn.hidden = false;
}

function renderPluginNav() {
  if (!els.pluginNav) return;
  els.pluginNav.innerHTML = "";
  if (els.pluginCount) els.pluginCount.textContent = String(PLUGIN_REGISTRY.length);
  els.railItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.railPlugin === activePluginId);
  });
  PLUGIN_REGISTRY.forEach((plugin, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `plugin-nav-item tone-${plugin.tone} ${plugin.id === activePluginId ? "active" : ""}`;
    button.style.setProperty("--i", String(index));
    button.innerHTML = `
      <span class="plugin-glyph" aria-hidden="true">${plugin.shortTitle.slice(0, 1)}</span>
      <span class="plugin-copy">
        <strong></strong>
        <em></em>
      </span>
      <span class="plugin-level"></span>
    `;
    button.querySelector("strong").textContent = plugin.title;
    button.querySelector("em").textContent = plugin.status;
    button.querySelector(".plugin-level").textContent = plugin.level;
    button.addEventListener("click", () => setActivePlugin(plugin.id));
    els.pluginNav.appendChild(button);
  });
}

function renderPluginStack() {
  if (!els.pluginStack) return;
  const current = activePlugin();
  if (els.activePluginLabel) els.activePluginLabel.textContent = current.shortTitle;
  els.pluginStack.innerHTML = "";
  PLUGIN_REGISTRY.forEach((plugin) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `plugin-stack-row tone-${plugin.tone} ${plugin.id === activePluginId ? "active" : ""}`;
    row.innerHTML = `
      <span class="stack-dot" aria-hidden="true"></span>
      <span>
        <strong></strong>
        <em></em>
      </span>
    `;
    row.querySelector("strong").textContent = plugin.shortTitle;
    const status = fusionStatusFor(plugin);
    row.querySelector("em").textContent = plugin.id === "permission" ? "真实编辑" : status?.loaded ? "已融合" : "待检查";
    row.addEventListener("click", () => setActivePlugin(plugin.id));
    els.pluginStack.appendChild(row);
  });
}

function pluginSupportsMode(plugin, mode) {
  if (plugin?.id === "aip-review" && mode === "privates") return false;
  return mode === "groups" || mode === "privates";
}

function normalizeModeForPlugin(plugin, mode = activeMode) {
  return pluginSupportsMode(plugin, mode) ? mode : "groups";
}

function syncModeControlsForPlugin() {
  const plugin = activePlugin();
  const privateSupported = pluginSupportsMode(plugin, "privates");
  if (!privateSupported && activeMode === "privates") activeMode = "groups";
  if (!privateSupported && selected?.type === "privates") selected = null;
  els.groupTabBtn?.classList.toggle("active", activeMode === "groups");
  els.privateTabBtn?.classList.toggle("active", activeMode === "privates");
  els.groupTabBtn?.setAttribute("aria-selected", activeMode === "groups" ? "true" : "false");
  els.privateTabBtn?.setAttribute("aria-selected", activeMode === "privates" ? "true" : "false");
  if (els.privateTabBtn) els.privateTabBtn.hidden = !privateSupported;
}

function updateOverviewStats() {
  const totalPlugins = PLUGIN_REGISTRY.length;
  const childStatuses = fusionPlugins.filter((item) => item.id !== "permission");
  const loadedChildren = childStatuses.filter((item) => item.loaded).length;
  const initializedChildren = childStatuses.filter((item) => item.initialized).length;
  const errorChildren = childStatuses.filter((item) => !item.loaded || item.error).length;
  const loadedTotal = 1 + loadedChildren;
  const pending = childStatuses.filter((item) => item.loaded && !item.initialized && !item.error).length;
  const objectCount = groups.length + privateContacts.length;
  const featureCount = PLUGIN_REGISTRY.reduce((sum, plugin) => sum + plugin.modules.length, 0);

  if (els.fusionLoadedCount) els.fusionLoadedCount.textContent = `${loadedTotal}/${totalPlugins}`;
  if (els.fusionObjectCount) els.fusionObjectCount.textContent = String(objectCount);
  if (els.fusionMenuCount) els.fusionMenuCount.textContent = String(featureCount);
  if (els.fusionInitializedCount) els.fusionInitializedCount.textContent = String(1 + initializedChildren);
  if (els.fusionPendingCount) els.fusionPendingCount.textContent = String(pending);
  if (els.fusionErrorCount) els.fusionErrorCount.textContent = String(errorChildren);
  if (els.fusionHealthText) els.fusionHealthText.textContent = errorChildren ? "需检查" : "在线";
  if (els.fusionHealthMeta) els.fusionHealthMeta.textContent = errorChildren ? `${errorChildren} 个异常` : "全部在线";
}

function renderFusionShell() {
  root.setAttribute("data-active-plugin", activePluginId);
  renderPluginNav();
  renderPluginStack();
  updateOverviewStats();
}

function setActivePlugin(pluginId) {
  const next = PLUGIN_REGISTRY.find((plugin) => plugin.id === pluginId) || PLUGIN_REGISTRY[0];
  activePluginId = next.id;
  activeMode = normalizeModeForPlugin(next, activeMode);
  if (!pluginSupportsMode(next, selected?.type)) selected = null;
  syncModeControlsForPlugin();
  renderFusionShell();
  renderActiveWorkspace();
}

function renderActiveWorkspace() {
  const plugin = activePlugin();
  if (plugin.id !== "permission") {
    renderExternalPluginWorkspace(plugin);
    renderObjectList();
    return;
  }
  setPermissionChrome(true);
  if (selected?.payload) {
    if (selected.type === "groups") renderGroupForm(selected.payload);
    else if (selected.type === "privates") renderPrivateForm(selected.payload);
    else renderWelcomePanel();
  } else {
    renderWelcomePanel();
  }
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeBackgroundSettings(settings = {}) {
  const next = { ...DEFAULT_BACKGROUND_SETTINGS, ...(settings || {}) };
  const hasMedia = Boolean(next.data_url || next.media_file);
  return {
    enabled: Boolean(next.enabled && hasMedia),
    data_url: String(next.data_url || ""),
    file_name: String(next.file_name || ""),
    media_type: String(next.media_type || ""),
    crop_x: clampNumber(next.crop_x, 50, 0, 100),
    crop_y: clampNumber(next.crop_y, 50, 0, 100),
    overlay: clampNumber(next.overlay, 0.42, 0.18, 0.72),
    blur: clampNumber(next.blur, 0, 0, 36),
  };
}

function cssImageUrl(dataUrl) {
  const value = String(dataUrl || "");
  return value ? `url("${value.replace(/["\\]/g, "\\$&")}")` : "none";
}

function applyBackgroundSettings(settings = {}) {
  backgroundSettings = normalizeBackgroundSettings(settings);
  const hasCustomBackground = Boolean(backgroundSettings.enabled && backgroundSettings.data_url);
  document.body.classList.toggle("has-custom-background", hasCustomBackground);
  root.style.setProperty(
    "--custom-bg-image",
    hasCustomBackground ? cssImageUrl(backgroundSettings.data_url) : "none",
  );
  root.style.setProperty("--custom-bg-position", `${backgroundSettings.crop_x}% ${backgroundSettings.crop_y}%`);
  root.style.setProperty("--custom-bg-overlay", String(backgroundSettings.overlay));
  root.style.setProperty("--custom-bg-readable-overlay", String(Math.max(backgroundSettings.overlay, 0.34)));
  const backdropVeil = Math.max(0.16, 0.34 - backgroundSettings.overlay * 0.18);
  root.style.setProperty("--custom-bg-veil", String(backdropVeil));
  root.style.setProperty("--custom-bg-veil-soft", String(backdropVeil * 0.72));
  root.style.setProperty("--custom-bg-veil-deep", String(backdropVeil * 0.88));
  root.style.setProperty("--custom-bg-blur", `${backgroundSettings.blur}px`);
  const blurRatio = backgroundSettings.blur / 36;
  const backdropCardAlpha = 0.07 + blurRatio * 0.18;
  root.style.setProperty("--backdrop-card-alpha", String(backdropCardAlpha));
  root.style.setProperty("--backdrop-card-alpha-deep", String(backdropCardAlpha + 0.03));
  root.style.setProperty("--backdrop-card-alpha-soft", String(backdropCardAlpha * 0.7));
  root.style.setProperty("--backdrop-card-border-alpha", String(0.14 + blurRatio * 0.18));

  if (els.backgroundDropzone) {
    els.backgroundDropzone.style.setProperty(
      "--preview-image",
      hasCustomBackground ? cssImageUrl(backgroundSettings.data_url) : "none",
    );
    els.backgroundDropzone.classList.toggle("has-preview", hasCustomBackground);
  }
  if (els.backgroundFileName) {
    els.backgroundFileName.textContent = hasCustomBackground
      ? backgroundSettings.file_name || "自定义背景"
      : "混色背景";
  }
  if (els.backgroundStatusLabel) {
    els.backgroundStatusLabel.textContent = hasCustomBackground
      ? backgroundSettings.media_type === "image/gif"
        ? "GIF 动态"
        : "自定义背景"
      : "系统混色";
  }
  if (els.backgroundCropX) els.backgroundCropX.value = String(Math.round(backgroundSettings.crop_x));
  if (els.backgroundCropY) els.backgroundCropY.value = String(Math.round(backgroundSettings.crop_y));
  if (els.backgroundOverlay) els.backgroundOverlay.value = String(Math.round(backgroundSettings.overlay * 100));
  if (els.backgroundBlur) els.backgroundBlur.value = String(Math.round(backgroundSettings.blur));
}

async function loadBackgroundFromBackend() {
  if (!api) return;
  try {
    applyBackgroundSettings(await api.safeGet("/settings/background"));
  } catch {}
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("背景读取失败"));
    reader.readAsDataURL(file);
  });
}

function readImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("无法识别背景尺寸"));
    image.src = dataUrl;
  });
}

function recommendedCropForSize(size) {
  const width = Number(size?.width || 0);
  const height = Number(size?.height || 0);
  if (!width || !height) return { crop_x: 50, crop_y: 50 };
  const ratio = width / height;
  if (ratio < 0.85) return { crop_x: 50, crop_y: 38 };
  if (ratio > 2.35) return { crop_x: 50, crop_y: 52 };
  return { crop_x: 50, crop_y: 50 };
}

async function persistBackgroundSettings(settings, options = {}) {
  if (!api) {
    applyBackgroundSettings(settings);
    return;
  }
  const payload = {
    enabled: settings.enabled,
    file_name: settings.file_name,
    crop_x: settings.crop_x,
    crop_y: settings.crop_y,
    overlay: settings.overlay,
    blur: settings.blur,
  };
  if (options.includeDataUrl && settings.data_url) {
    payload.data_url = settings.data_url;
  }
  applyBackgroundSettings(await api.safePost("/settings/background", payload));
}

function scheduleBackgroundPersist() {
  if (!api) return;
  window.clearTimeout(backgroundPersistTimer);
  backgroundPersistTimer = window.setTimeout(() => {
    persistBackgroundSettings(backgroundSettings).catch((err) => {
      toast(`背景保存失败：${err.message}`, "error");
    });
  }, 420);
}

function collectBackgroundControls() {
  return normalizeBackgroundSettings({
    ...backgroundSettings,
    crop_x: Number(els.backgroundCropX?.value || backgroundSettings.crop_x),
    crop_y: Number(els.backgroundCropY?.value || backgroundSettings.crop_y),
    overlay: Number(els.backgroundOverlay?.value || backgroundSettings.overlay * 100) / 100,
    blur: Number(els.backgroundBlur?.value || backgroundSettings.blur),
  });
}

function updateBackgroundFromControls() {
  if (!backgroundSettings.data_url) return;
  applyBackgroundSettings(collectBackgroundControls());
  scheduleBackgroundPersist();
}

async function handleBackgroundFile(file) {
  if (!file) return;
  if (!VALID_BACKGROUND_TYPES.has(file.type)) {
    toast("背景仅支持 GIF、PNG、JPG、WebP", "error");
    return;
  }
  if (file.size > BACKGROUND_MAX_BYTES) {
    toast("背景文件不能超过 12 MB", "error");
    return;
  }
  els.backgroundDropzone?.classList.add("is-loading");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const size = await readImageSize(dataUrl).catch(() => null);
    const crop = recommendedCropForSize(size);
    const next = normalizeBackgroundSettings({
      ...backgroundSettings,
      enabled: true,
      data_url: dataUrl,
      file_name: file.name,
      media_type: file.type,
      crop_x: crop.crop_x,
      crop_y: crop.crop_y,
      overlay: backgroundSettings.overlay || 0.42,
      blur: backgroundSettings.blur || 0,
    });
    applyBackgroundSettings(next);
    await persistBackgroundSettings(next, { includeDataUrl: true });
    toast(api ? (file.type === "image/gif" ? "GIF 背景已保存" : "背景已保存") : "背景已应用到预览", "success");
  } catch (err) {
    toast(`背景处理失败：${err.message}`, "error");
  } finally {
    els.backgroundDropzone?.classList.remove("is-loading");
    if (els.backgroundInput) els.backgroundInput.value = "";
  }
}

async function resetBackground() {
  els.resetBackgroundBtn.disabled = true;
  try {
    if (api) {
      applyBackgroundSettings(await api.safePost("/settings/background/reset", {}));
    } else {
      applyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS);
    }
    toast("背景已重置", "success");
  } catch (err) {
    toast(`背景重置失败：${err.message}`, "error");
  } finally {
    els.resetBackgroundBtn.disabled = false;
  }
}

function bindBackgroundEvents() {
  els.uploadBackgroundBtn?.addEventListener("click", () => els.backgroundInput?.click());
  els.resetBackgroundBtn?.addEventListener("click", resetBackground);
  els.backgroundInput?.addEventListener("change", () => {
    handleBackgroundFile(els.backgroundInput.files?.[0]);
  });
  [els.backgroundCropX, els.backgroundCropY, els.backgroundOverlay, els.backgroundBlur].forEach((control) => {
    control?.addEventListener("input", updateBackgroundFromControls);
  });
  els.panelOpacityInput?.addEventListener("input", updateToneFromControls);
  els.panelOpacityInput?.addEventListener("change", () => updateToneFromControls({ immediate: true }));
  if (!els.backgroundDropzone) return;
  ["dragenter", "dragover"].forEach((eventName) => {
    els.backgroundDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.backgroundDropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.backgroundDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.backgroundDropzone.classList.remove("is-dragging");
    });
  });
  els.backgroundDropzone.addEventListener("drop", (event) => {
    handleBackgroundFile(event.dataTransfer?.files?.[0]);
  });
}

function bindPointerField() {
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) return;
  window.addEventListener("pointermove", (event) => {
    if (pointerFrame) return;
    pointerFrame = window.requestAnimationFrame(() => {
      pointerFrame = 0;
      const x = clampNumber((event.clientX / Math.max(window.innerWidth, 1)) * 100, 50, 0, 100);
      const y = clampNumber((event.clientY / Math.max(window.innerHeight, 1)) * 100, 50, 0, 100);
      root.style.setProperty("--pointer-x", `${x}%`);
      root.style.setProperty("--pointer-y", `${y}%`);
      root.style.setProperty("--tilt-x", `${((50 - y) / 50).toFixed(3)}deg`);
      root.style.setProperty("--tilt-y", `${((x - 50) / 42).toFixed(3)}deg`);
    });
  });
}

function normalizeListText(value) {
  return String(value || "")
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeReasoningValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["ultra", "max", "maximum", "最高", "超高"].includes(normalized)) return "high";
  return REASONING_OPTIONS.some(([key]) => key === normalized) ? normalized : "";
}

function reasoningLabel(value) {
  const normalized = normalizeReasoningValue(value);
  return REASONING_OPTIONS.find(([key]) => key === normalized)?.[1] || "默认";
}

function parseReasoningRules(value) {
  return normalizeListText(value)
    .map((item) => {
      const [target, effort = ""] = item.split(/[=：:]/, 2).map((part) => part.trim());
      const normalized = normalizeReasoningValue(effort);
      return target && normalized ? `${target}=${normalized}` : "";
    })
    .filter(Boolean);
}

function parseReasoningMap(value) {
  const map = new Map();
  parseReasoningRules(value).forEach((item) => {
    const [target, effort] = item.split("=", 2);
    map.set(target, effort);
  });
  return map;
}

function previewGroupPayload(group) {
  const id = String(group?.group_id || PREVIEW_GROUPS[0].group_id);
  const enabled = Boolean(group?.group_enabled);
  return {
    group_info: { ...group },
    config: {
      group_enabled: enabled,
      allowed_users: enabled ? ["26880001", "26880002", "26880003"] : ["26880001"],
      denied_users: group?.group_name?.includes("Design") ? ["99887766"] : [],
      reasoning_effort: group?.reasoning_effort || "",
      reasoning_user_rules: group?.reasoning_effort ? [`26880001=${group.reasoning_effort}`] : [],
    },
  };
}

function previewPrivatePayload(contact) {
  const userId = String(contact?.user_id || PREVIEW_PRIVATE_CONTACTS[0].user_id);
  return {
    contact_info: { ...contact },
    config: {
      private_enabled: Boolean(contact?.private_enabled),
      reasoning_effort: contact?.reasoning_effort || "",
      user_id: userId,
    },
  };
}

function activatePreviewMode() {
  previewMode = true;
  fusionPlugins = PREVIEW_FUSION_PLUGINS.map((item) => ({ ...item }));
  fusionAccessIndex = {};
  fusionConfigCache = new Map();
  groups = PREVIEW_GROUPS.map((item) => ({ ...item }));
  privateContacts = PREVIEW_PRIVATE_CONTACTS.map((item) => ({ ...item }));
  applySystemInfo({ platform: "Windows", platform_release: "Local Preview", python: "3.10", astrbot: "Fusion" });
  setWeatherStatus("本地预览", "进入 AstrBot 后显示真实天气");
  renderFusionShell();
  renderGroupForm(previewGroupPayload(groups[0]));
  toast("本地预览模式已启用，进入 AstrBot 后会读取真实配置", "success");
}

function loadGroupTouchTimes() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GROUP_TOUCH_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveGroupTouchTimes(times) {
  try {
    window.localStorage.setItem(GROUP_TOUCH_STORAGE_KEY, JSON.stringify(times));
  } catch {}
}

function touchGroupConfig(groupId) {
  const target = String(groupId || "").trim();
  if (!target) return;
  const times = loadGroupTouchTimes();
  times[target] = Date.now();
  saveGroupTouchTimes(times);
}

function groupTouchTime(group) {
  const backendTime = Number(group?.config_updated_at || 0);
  if (backendTime) return backendTime;
  return Number(loadGroupTouchTimes()[String(group?.group_id || "")] || 0);
}

function sortGroups(groupList) {
  return [...groupList].sort((a, b) => {
    const recent = groupTouchTime(b) - groupTouchTime(a);
    if (recent) return recent;
    return String(a.group_name || a.group_id || "").localeCompare(
      String(b.group_name || b.group_id || ""),
      "zh-Hans-CN",
    );
  });
}

function toast(message, kind = "info") {
  if (!els.toastLayer) return;
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  els.toastLayer.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 220);
  }, 2600);
}

function updateClock() {
  const now = new Date();
  if (els.currentTimeLabel) {
    els.currentTimeLabel.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  }
  if (els.currentDateLabel) {
    els.currentDateLabel.textContent = now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
  }
}

function applySystemInfo(system = {}) {
  const platformText = [system.platform, system.platform_release].filter(Boolean).join(" ") || "未知系统";
  if (els.systemVersionLabel) els.systemVersionLabel.textContent = platformText;
  if (els.pythonVersionLabel) {
    els.pythonVersionLabel.textContent = `Python ${system.python || "--"} / AstrBot ${system.astrbot || "未知"}`;
  }
}

function weatherCodeText(code) {
  const map = {
    0: "晴",
    1: "少云",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小雨",
    53: "小雨",
    55: "中雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "阵雨",
    82: "强阵雨",
    95: "雷暴",
  };
  return map[Number(code)] || "天气";
}

async function fetchWeather(latitude, longitude, options = {}) {
  const data = await api.safeGet("settings/weather", { latitude, longitude });
  const metaParts = [];
  if (options.accuracyText) metaParts.push(options.accuracyText);
  if (data.time) metaParts.push(`更新 ${data.time}`);
  applyWeatherData(data, metaParts.join(" · ") || "定位已授权");
}

function applyWeatherData(data, metaText) {
  if (typeof data.temperature !== "number") throw new Error("天气数据为空");
  if (els.weatherLabel) {
    els.weatherLabel.textContent = `${weatherCodeText(data.weather_code)} ${Math.round(data.temperature)}°C`;
  }
  if (els.weatherMetaLabel) {
    els.weatherMetaLabel.textContent = metaText || (data.time ? `更新 ${data.time}` : "定位已授权");
  }
}

function setWeatherStatus(label, meta) {
  if (els.weatherLabel) els.weatherLabel.textContent = label;
  if (els.weatherMetaLabel) els.weatherMetaLabel.textContent = meta;
}

function geolocationMessage(error) {
  if (!error) return "定位失败";
  if (error.code === 1) return "定位被浏览器拒绝";
  if (error.code === 2) return "系统位置暂不可用";
  if (error.code === 3) return "高精度定位超时，已尝试粗定位";
  return error.message || "定位失败";
}

function positionAccuracy(position) {
  const accuracy = Number(position?.coords?.accuracy);
  return Number.isFinite(accuracy) ? accuracy : Number.POSITIVE_INFINITY;
}

function formatAccuracy(position) {
  const accuracy = positionAccuracy(position);
  if (!Number.isFinite(accuracy)) return "定位已授权";
  return accuracy <= PRECISE_LOCATION_TARGET_METERS
    ? `精准定位 ±${Math.round(accuracy)}m`
    : `定位精度 ±${Math.round(accuracy)}m`;
}

function requestPreciseBrowserPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("浏览器未提供定位"));
      return;
    }
    let settled = false;
    let bestPosition = null;
    let timeoutId = 0;
    let watchId = null;

    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (watchId !== null && navigator.geolocation.clearWatch) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const acceptPosition = (position) => {
      const accuracy = positionAccuracy(position);
      if (!bestPosition || accuracy < positionAccuracy(bestPosition)) {
        bestPosition = position;
      }
      if (accuracy <= PRECISE_LOCATION_TARGET_METERS) {
        finish(resolve, position);
      }
    };
    const failPosition = (error) => {
      if (bestPosition) {
        finish(resolve, bestPosition);
      } else {
        finish(reject, error);
      }
    };

    timeoutId = window.setTimeout(() => {
      if (bestPosition) {
        finish(resolve, bestPosition);
      } else {
        finish(
          reject,
          Object.assign(new Error("高精度定位超时"), { code: 3 }),
        );
      }
    }, PRECISE_LOCATION_TIMEOUT_MS);

    if (navigator.geolocation.watchPosition) {
      watchId = navigator.geolocation.watchPosition(
        acceptPosition,
        failPosition,
        {
          enableHighAccuracy: true,
          timeout: PRECISE_LOCATION_TIMEOUT_MS,
          maximumAge: PRECISE_LOCATION_MAX_AGE_MS,
        },
      );
    } else {
      navigator.geolocation.getCurrentPosition(
        acceptPosition,
        failPosition,
        {
          enableHighAccuracy: true,
          timeout: PRECISE_LOCATION_TIMEOUT_MS,
          maximumAge: PRECISE_LOCATION_MAX_AGE_MS,
        },
      );
    }
  });
}

async function queryGeolocationPermission() {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status?.state || "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchCoarseWeather() {
  const data = await api.safeGet("settings/weather/ip");
  const metaParts = [];
  if (data.place) metaParts.push(`IP 粗定位 ${data.place}`);
  if (data.time) metaParts.push(`更新 ${data.time}`);
  applyWeatherData(data, metaParts.join(" · ") || "IP 粗定位已启用");
}

async function loadLocationWeather() {
  if (!els.weatherLabel || !els.weatherMetaLabel) return;
  const permission = await queryGeolocationPermission();
  const canUseBrowserPosition = Boolean(navigator.geolocation) && permission !== "denied";
  if (canUseBrowserPosition) {
    setWeatherStatus(permission === "granted" ? "精确定位中" : "请求定位", "正在尝试 100 米内定位精度");
    try {
      const position = await requestPreciseBrowserPosition();
      await fetchWeather(position.coords.latitude, position.coords.longitude, {
        accuracyText: formatAccuracy(position),
      });
      return;
    } catch (err) {
      setWeatherStatus("定位切换中", geolocationMessage(err));
    }
  } else {
    setWeatherStatus(permission === "denied" ? "未授权" : "不可用", permission === "denied" ? "定位被浏览器拒绝，尝试粗定位" : "浏览器未提供定位，尝试粗定位");
  }

  try {
    await fetchCoarseWeather();
  } catch (err) {
    setWeatherStatus("获取失败", err.message || "定位与粗定位均不可用");
  }
}

function setMode(mode) {
  const requestedMode = mode === "privates" ? "privates" : "groups";
  activeMode = normalizeModeForPlugin(activePlugin(), requestedMode);
  if (!pluginSupportsMode(activePlugin(), selected?.type)) selected = null;
  syncModeControlsForPlugin();
  updateRailObjectSummary();
  renderObjectList();
}

function updateRailObjectSummary() {
  const isPrivate = activeMode === "privates";
  if (els.railAdminTitle) {
    els.railAdminTitle.textContent = isPrivate ? "私聊列表" : "群聊列表";
  }
  if (els.railAdminMeta) {
    const count = isPrivate ? privateContacts.length : groups.length;
    els.railAdminMeta.textContent = isPrivate ? `${count} 位好友` : `${count} 个群聊`;
  }
}

function privateContactsFromConfig(config) {
  const enabledUsers = new Set(normalizeListText(config?.private_chat_users || ""));
  const reasoningMap = parseReasoningMap(config?.reasoning_private_users || "");
  const userIds = new Set([...enabledUsers, ...reasoningMap.keys()]);
  return [...userIds].map((userId) => ({
    user_id: userId,
    nickname: `好友 ${userId}`,
    remark: "",
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`,
    source: "configured",
    private_enabled: enabledUsers.has(userId),
    reasoning_effort: reasoningMap.get(userId) || "",
  }));
}

async function refreshPrivateContacts(options = {}) {
  try {
    privateContacts = await api.safePost("settings/private/refresh", {});
  } catch (err) {
    if (!options.fallbackConfig) throw err;
    privateContacts = privateContactsFromConfig(options.fallbackConfig);
  }
}

function filteredObjects() {
  const keyword = String(els.groupSearchInput?.value || "").trim().toLowerCase();
  if (activeMode === "privates") {
    return privateContacts
      .filter((item) => {
        const text = `${item.nickname || ""} ${item.remark || ""} ${item.user_id || ""}`.toLowerCase();
        return !keyword || text.includes(keyword);
      })
      .sort((a, b) => String(a.nickname || a.user_id || "").localeCompare(String(b.nickname || b.user_id || ""), "zh-Hans-CN"));
  }
  return sortGroups(groups).filter((item) => {
    const text = `${item.group_name || ""} ${item.group_id || ""}`.toLowerCase();
    return !keyword || text.includes(keyword);
  });
}

function makeFallbackAvatar(text) {
  const node = document.createElement("span");
  node.className = "avatar-fallback";
  node.textContent = String(text || "?").slice(0, 1).toUpperCase();
  return node;
}

function makeAvatar(src, label) {
  if (!src) return makeFallbackAvatar(label);
  const img = document.createElement("img");
  img.className = "avatar";
  img.src = src;
  img.alt = label || "";
  img.onerror = () => img.replaceWith(makeFallbackAvatar(label));
  return img;
}

function makeStatusLine(parts, kind = "") {
  const node = document.createElement("span");
  node.className = `status-line ${kind}`.trim();
  parts.filter(Boolean).forEach((part) => {
    const chip = document.createElement("span");
    chip.className = "status-chip";
    chip.textContent = part;
    node.appendChild(chip);
  });
  return node;
}

function renderObjectList() {
  const items = filteredObjects();
  const total = activeMode === "privates" ? privateContacts.length : groups.length;
  updateRailObjectSummary();
  if (els.listTitle) els.listTitle.textContent = activeMode === "privates" ? "私聊对象" : "群聊对象";
  if (els.listCount) els.listCount.textContent = String(total);
  updateOverviewStats();
  els.groupList.innerHTML = "";
  els.groupList.classList.toggle("empty-state", !items.length);
  if (!items.length) {
    els.groupList.textContent = activeMode === "privates" ? "没有匹配的私聊对象" : "没有匹配的群聊对象";
    return;
  }
  items.forEach((item) => {
    const isPrivate = activeMode === "privates";
    const id = String(isPrivate ? item.user_id : item.group_id);
    const name = isPrivate
      ? item.nickname || item.remark || `好友 ${id}`
      : item.group_name || `群 ${id}`;
    const active = selected?.type === activeMode && selected?.id === id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `object-item ${active ? "active" : ""}`;
    button.appendChild(makeAvatar(item.avatar, name));

    const body = document.createElement("span");
    body.className = "object-body";
    const title = document.createElement("span");
    title.className = "object-name";
    title.textContent = name;
    const meta = document.createElement("span");
    meta.className = "object-meta";
    meta.textContent = isPrivate ? `QQ ${id}` : `群号 ${id}`;
    const statusParts = [];
    let statusKind = "";
    const pluginStatus = activePluginId === "permission" ? null : fusionObjectStatus(activePlugin(), activeMode, id);
    if (pluginStatus) {
      statusKind = pluginStatus.kind || "";
      statusParts.push(...pluginStatus.parts);
    } else if (isPrivate) {
      statusKind = item.private_enabled ? "is-on" : "is-off";
      statusParts.push(item.private_enabled ? "私聊放行" : "私聊关闭");
      statusParts.push(item.reasoning_effort ? `思考 ${reasoningLabel(item.reasoning_effort)}` : "默认思考");
    } else {
      statusKind = item.group_enabled ? "is-on" : "is-neutral";
      statusParts.push(item.group_enabled ? "整群放行" : "精确授权");
      statusParts.push(item.reasoning_effort ? `思考 ${reasoningLabel(item.reasoning_effort)}` : "默认思考");
    }
    body.append(title, meta, makeStatusLine(statusParts, statusKind));
    button.appendChild(body);
    button.addEventListener("click", () => {
      if (activePluginId !== "permission") {
        selected = {
          type: activeMode,
          id,
          payload: isPrivate ? previewPrivatePayload(item) : previewGroupPayload(item),
        };
        renderExternalPluginWorkspace(activePlugin());
        renderObjectList();
        return;
      }
      if (isPrivate) {
        selectPrivateContact(item);
      } else {
        loadGroupConfig(id);
      }
    });
    els.groupList.appendChild(button);
  });
}

function setMetrics(metrics) {
  els.metricGrid.innerHTML = "";
  metrics.forEach((metric) => {
    const node = document.createElement("article");
    node.className = `metric-tile ${metric.kind || ""}`.trim();
    node.innerHTML = `<span></span><strong></strong><em></em>`;
    node.querySelector("span").textContent = metric.label;
    node.querySelector("strong").textContent = metric.value;
    node.querySelector("em").textContent = metric.meta;
    els.metricGrid.appendChild(node);
  });
}

function setSelectedSummary(title, lines = []) {
  els.selectedSummary.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = title;
  els.selectedSummary.appendChild(strong);
  lines.forEach((line) => {
    const span = document.createElement("span");
    span.textContent = line;
    els.selectedSummary.appendChild(span);
  });
}

function selectedObjectLabel() {
  if (!selected?.payload) return "未选择对象";
  if (selected.type === "groups") {
    const info = selected.payload.group_info || {};
    return info.group_name || `群 ${selected.id}`;
  }
  if (selected.type === "privates") {
    const info = selected.payload.contact_info || {};
    return info.nickname || info.remark || `好友 ${selected.id}`;
  }
  return "未选择对象";
}

function selectedObjectMeta() {
  if (!selected?.payload) return "从左侧选择群聊或私聊对象";
  return selected.type === "groups" ? `群号 ${selected.id}` : `QQ ${selected.id}`;
}

function fusionTargetContext() {
  if (!selected?.id) {
    return {
      type: "global",
      id: "default",
      label: "全局模板",
      meta: "选择群聊或私聊后，可保存为对象级覆盖",
      selected: false,
    };
  }
  return {
    type: selected.type,
    id: selected.id,
    label: selectedObjectLabel(),
    meta: selectedObjectMeta(),
    selected: true,
  };
}

function fusionTargetLabel(type) {
  return FUSION_TARGET_LABELS[type] || "对象";
}

function previewFusionKey(pluginId, target) {
  return `${pluginId}::${target.type}::${target.id}`;
}

function previewFusionConfig(plugin, target) {
  const key = previewFusionKey(plugin.id, target);
  const modules = previewFusionOverrides[key] || {};
  return {
    plugin: fusionStatusFor(plugin) || {
      id: plugin.id,
      directory: plugin.directory,
      loaded: true,
      initialized: true,
      api_base: `/${plugin.directory}`,
      config_path: `data/config/${plugin.directory}_config.json`,
    },
    schema: {},
    target: { type: target.type, id: target.id },
    modules,
    updated_at: 0,
  };
}

async function loadFusionConfig(plugin, target) {
  if (previewMode || !api) return previewFusionConfig(plugin, target);
  return api.safeGet("settings/fusion/config", {
    plugin_id: plugin.id,
    target_type: target.type,
    target_id: target.id,
  });
}

function setPreviewFusionModule(plugin, target, moduleId, values) {
  const key = previewFusionKey(plugin.id, target);
  const bucket = previewFusionOverrides[key] || {};
  bucket[moduleId] = { values, updated_at: Date.now() / 1000 };
  previewFusionOverrides[key] = bucket;
  return previewFusionConfig(plugin, target);
}

function resetPreviewFusionModule(plugin, target, moduleId) {
  const key = previewFusionKey(plugin.id, target);
  const bucket = previewFusionOverrides[key] || {};
  delete bucket[moduleId];
  previewFusionOverrides[key] = bucket;
  return previewFusionConfig(plugin, target);
}

function fusionModuleSections(plugin, module) {
  return FUSION_CONFIG_LAYOUT[plugin.id]?.[module.id] || [
    {
      title: "融合覆盖",
      summary: "该模块暂未声明专属字段，可记录对象级备注。",
      fields: ["fusion.note"],
      custom: {
        fusion: {
          note: { description: "对象级备注", type: "text", default: "" },
        },
      },
    },
  ];
}

function fusionPluginBlocks(plugin) {
  return plugin.modules.map((module) => ({
    module,
    sections: fusionModuleSections(plugin, module),
  }));
}

function countFusionFields(sections = []) {
  return sections.reduce(
    (sum, section) => sum + (section.fields?.length || 0) + countFusionFields(section.children || []),
    0,
  );
}

function findCustomField(sections, path) {
  const [rootKey, ...rest] = path.split(".");
  for (const section of sections || []) {
    let node = section.custom?.[rootKey];
    for (const part of rest) {
      node = node?.[part];
    }
    if (node) return node;
    const child = findCustomField(section.children || [], path);
    if (child) return child;
  }
  return null;
}

function getSchemaField(schema, path) {
  if (!schema || typeof schema !== "object") return null;
  let node = { type: "object", items: schema };
  for (const part of path.split(".")) {
    if (node?.templates?.[part]) {
      node = node.templates[part];
    } else if (node?.items?.[part]) {
      node = node.items[part];
    } else {
      return null;
    }
  }
  return node && typeof node === "object" ? node : null;
}

function fallbackFieldDefinition(path) {
  const last = path.split(".").pop();
  const field = {
    description: FUSION_FIELD_LABELS[path] || FUSION_FIELD_LABELS[last] || last,
    type: "string",
    default: "",
  };
  if (path.startsWith("perms.")) {
    field.options = ROLE_OPTIONS;
    field.default = "";
    return field;
  }
  if (last === "log_level") {
    field.options = ["DEBUG", "INFO", "WARNING", "ERROR"];
    field.default = "INFO";
    return field;
  }
  if (last === "default_aspect_ratio") {
    field.options = ASPECT_RATIO_OPTIONS;
    field.default = "不指定";
    return field;
  }
  if (last === "start_task_image_select_mode") {
    field.options = ["顺序轮询", "随机"];
    field.default = "顺序轮询";
    return field;
  }
  if (last === "sequential_image_generation") {
    field.options = ["disabled", "auto"];
    field.default = "disabled";
    return field;
  }
  if (last === "platform_type") {
    field.options = ["aiocqhttp"];
    field.default = "aiocqhttp";
    return field;
  }
  if (last === "send_to") {
    field.options = ["群聊", "私聊"];
    field.default = "群聊";
    return field;
  }
  if (last === "last_status") {
    field.options = ["未运行", "成功", "失败", "暂停"];
    field.default = "未运行";
    return field;
  }
  if (last === "enable_llm_tool") {
    field.type = "list";
    field.options = ["生图工具"];
    field.default = ["生图工具"];
    return field;
  }
  if (last === "capability_options") {
    field.type = "list";
    field.options = ["文生图", "图生图", "宽高比", "分辨率"];
    field.default = [];
    return field;
  }
  if (
    /^(enable_|show_|reply_|failure_|admin_|skip_|debug_|kick_user$|is_|join_no_match|reject_word|builtin_|filter_|recall_|link_recall|join_notice|leave_|send_text|mention_|notify_|watermark)/.test(last)
    || last === "enabled"
  ) {
    field.type = "bool";
    field.default = false;
    return field;
  }
  if (
    last.includes("list")
    || last.includes("ids")
    || last.includes("words")
    || last.includes("blacklist")
    || last.includes("whitelist")
    || last.includes("api_keys")
    || last.includes("models")
    || last.includes("paths")
    || last.includes("path")
  ) {
    field.type = "list";
    field.default = [];
    return field;
  }
  if (
    last.includes("prompt")
    || last.includes("template")
    || last.includes("text")
    || last.includes("notice")
    || last.includes("error")
    || last === "note"
  ) {
    field.type = "text";
    return field;
  }
  if (
    last.includes("timeout")
    || last.includes("retry")
    || last.includes("count")
    || last.includes("threshold")
    || last.includes("duration")
    || last.includes("seconds")
    || last.includes("minutes")
    || last.includes("width")
    || last.includes("height")
    || last.includes("level")
    || last === "ttl"
  ) {
    field.type = last.includes("minutes") || last.includes("seconds") ? "float" : "int";
    field.default = "";
  }
  return field;
}

function fieldDefinition(schema, sections, path) {
  const custom = findCustomField(sections, path);
  const schemaField = getSchemaField(schema, path);
  const fallback = fallbackFieldDefinition(path);
  const field = { ...fallback, ...(schemaField || {}), ...(custom || {}) };
  if (!field.type && Array.isArray(field.options)) field.type = "string";
  if (!field.type) field.type = "string";
  field.description = field.description || fallback.description || path.split(".").pop();
  return field;
}

function targetScopedField(path, field, target) {
  if (path !== FUSION_ACCESS_PATH) return field;
  const description =
    target.type === "groups"
      ? "当前群聊启用"
      : target.type === "privates"
        ? "当前私聊启用"
        : "全局默认启用";
  const hint = target.selected
    ? `只影响当前${fusionTargetLabel(target.type)}：${target.label}`
    : "未选择对象时保存为默认模板，选择群聊或私聊后可单独覆盖。";
  return { ...field, description, hint };
}

function fusionDefaultValue(path, field, target) {
  if (path.endsWith(".group_id") && target.type === "groups") return target.id;
  if (path === "task.target_id" && target.type !== "global") return target.id;
  if (path === "task.send_to") return target.type === "privates" ? "私聊" : "群聊";
  if (Object.prototype.hasOwnProperty.call(field, "default")) {
    if (Array.isArray(field.default)) return [...field.default];
    if (field.default && typeof field.default === "object") return { ...field.default };
    return field.default;
  }
  if (field.type === "bool") return false;
  if (field.type === "list" || field.type === "file") return [];
  return "";
}

function fusionFieldValue(values, path, field, target) {
  if (Object.prototype.hasOwnProperty.call(values, path)) return values[path];
  return fusionDefaultValue(path, field, target);
}

function listValueText(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value || "");
}

function scalarValueText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function fusionFieldInput(path, field, value, hasOverride, moduleId = "") {
  const label = escapeHtml(field.description || path);
  const hint = field.hint ? `<span>${escapeHtml(field.hint)}</span>` : "";
  const overrideBadge = "";
  const escapedPath = escapeHtml(path);
  const common = `data-fusion-field="${escapedPath}" data-fusion-module="${escapeHtml(moduleId)}"`;
  if (field.type === "bool") {
    return `
      <label class="fusion-field fusion-switch-field ${hasOverride ? "has-override" : ""}">
        <input ${common} data-fusion-kind="bool" type="checkbox" ${value ? "checked" : ""}>
        <span class="fusion-switch-copy"><strong>${label}</strong>${hint}${overrideBadge}</span>
        <i class="switch-rail" aria-hidden="true"></i>
      </label>
    `;
  }
  if (Array.isArray(field.options) && (field.type === "list" || Array.isArray(value))) {
    const values = new Set(Array.isArray(value) ? value.map(String) : normalizeListText(value));
    return `
      <div class="fusion-field fusion-check-field ${hasOverride ? "has-override" : ""}" ${common} data-fusion-kind="list-options">
        <div class="fusion-field-label"><strong>${label}</strong>${overrideBadge}</div>
        ${hint}
        <div class="fusion-check-list">
          ${field.options.map((option) => `
            <label>
              <input type="checkbox" value="${escapeHtml(option)}" ${values.has(String(option)) ? "checked" : ""}>
              <span>${escapeHtml(option)}</span>
            </label>
          `).join("")}
        </div>
      </div>
    `;
  }
  if (Array.isArray(field.options)) {
    return `
      <label class="fusion-field ${hasOverride ? "has-override" : ""}">
        <span class="fusion-field-label"><strong>${label}</strong>${overrideBadge}</span>
        ${hint}
        <select ${common} data-fusion-kind="string">
          ${field.options.map((option) => `<option value="${escapeHtml(option)}" ${String(value) === String(option) ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </label>
    `;
  }
  if (field.type === "text" || field.multiline || field.widget === "textarea") {
    return `
      <label class="fusion-field fusion-field-wide ${hasOverride ? "has-override" : ""}">
        <span class="fusion-field-label"><strong>${label}</strong>${overrideBadge}</span>
        ${hint}
        <textarea ${common} data-fusion-kind="text">${escapeHtml(scalarValueText(value))}</textarea>
      </label>
    `;
  }
  if (field.type === "list" || field.type === "file") {
    return `
      <label class="fusion-field fusion-field-wide ${hasOverride ? "has-override" : ""}">
        <span class="fusion-field-label"><strong>${label}</strong>${overrideBadge}</span>
        ${hint}
        <textarea ${common} data-fusion-kind="${field.type === "file" ? "file" : "list"}">${escapeHtml(listValueText(value))}</textarea>
      </label>
    `;
  }
  const numeric = field.type === "int" || field.type === "float";
  const slider = field.slider || {};
  return `
    <label class="fusion-field ${hasOverride ? "has-override" : ""}">
      <span class="fusion-field-label"><strong>${label}</strong>${overrideBadge}</span>
      ${hint}
      <input
        ${common}
        data-fusion-kind="${numeric ? field.type : "string"}"
        type="${numeric ? "number" : "text"}"
        value="${escapeHtml(scalarValueText(value))}"
        ${numeric && slider.min !== undefined ? `min="${escapeHtml(slider.min)}"` : ""}
        ${numeric && slider.max !== undefined ? `max="${escapeHtml(slider.max)}"` : ""}
        ${numeric && slider.step !== undefined ? `step="${escapeHtml(slider.step)}"` : ""}
      >
    </label>
  `;
}

function renderFusionSection(section, schema, sections, values, target, moduleId = "") {
  const fields = section.fields || [];
  const children = section.children || [];
  return `
    <section class="fusion-config-section">
      <header class="fusion-config-section-head">
        <span class="section-number">${fields.length + countFusionFields(children)}</span>
        <div>
          <strong>${escapeHtml(section.title)}</strong>
          <em>${escapeHtml(section.summary || "")}</em>
        </div>
      </header>
      <div class="fusion-field-grid">
        ${fields.map((path) => {
          const field = targetScopedField(path, fieldDefinition(schema, sections, path), target);
          const hasOverride = Object.prototype.hasOwnProperty.call(values, path);
          return fusionFieldInput(path, field, fusionFieldValue(values, path, field, target), hasOverride, moduleId);
        }).join("")}
      </div>
      ${children.map((child) => renderFusionSection(child, schema, sections, values, target, moduleId)).join("")}
    </section>
  `;
}

function fusionObjectNotice(target) {
  if (target.selected) {
    return `${fusionTargetLabel(target.type)} · ${target.label} · ${target.meta}`;
  }
  return "当前显示全局模板；从第二列选择群聊或私聊后，可写入对象级覆盖。";
}

function pluginFlatMetrics(plugin) {
  const status = fusionStatusFor(plugin);
  const stateValue = status?.loaded ? "已并入" : "异常";
  const stateMeta = status?.initialized ? "已初始化" : status?.loaded ? "待初始化" : "查看错误";
  const fieldCount = fusionPluginBlocks(plugin).reduce((sum, block) => sum + countFusionFields(block.sections), 0);
  return [
    { label: "插件", value: plugin.shortTitle, meta: plugin.status, kind: "ok" },
    { label: "功能块", value: String(plugin.modules.length), meta: "直接平铺" },
    { label: "配置项", value: String(fieldCount), meta: "全部展开" },
    { label: "融合状态", value: stateValue, meta: stateMeta },
  ];
}

function renderExternalPluginWorkspace(plugin) {
  setPermissionChrome(false);
  activeFusionConfig = null;
  const status = fusionStatusFor(plugin);
  const loaded = Boolean(status?.loaded);
  const initialized = Boolean(status?.initialized);
  const statusTitle = loaded ? (initialized ? "已并入并初始化" : "已并入，等待初始化") : "融合加载异常";
  const statusDetail = loaded
    ? `API 前缀：${status?.api_base || `/${plugin.directory}`}`
    : (status?.error || "后端未返回该模块状态");
  const target = fusionTargetContext();
  const renderToken = ++activeFusionRenderToken;
  els.currentScopeLabel.textContent = `${plugin.shortTitle} · ${fusionTargetLabel(target.type)}`;
  els.currentGroupTitle.textContent = plugin.title;
  els.currentGroupMeta.textContent = `${plugin.summary} · ${fusionObjectNotice(target)}`;
  if (els.resetGroupBtn) els.resetGroupBtn.textContent = "重置全部覆盖";
  if (els.saveGroupBtn) els.saveGroupBtn.textContent = "保存全部覆盖";
  setMetrics(pluginFlatMetrics(plugin));
  setSelectedSummary(plugin.title, [
    `${plugin.modules.length} 个功能块直接展开`,
    fusionObjectNotice(target),
    statusTitle,
  ]);
  els.groupForm.classList.remove("empty-state");
  els.groupForm.innerHTML = `
    <section class="fusion-hero-panel tone-${plugin.tone}">
      <div>
        <p class="eyebrow">${plugin.eyebrow}</p>
        <h3>${plugin.title}</h3>
        <p>${plugin.summary}</p>
      </div>
      <div class="fusion-route-card">
        <span>${statusTitle}</span>
        <strong>${escapeHtml(target.label)}</strong>
        <em>${escapeHtml(target.meta)}</em>
      </div>
    </section>
    <section class="section-panel fusion-loading-panel">
      <span class="section-number">${plugin.modules.length}</span>
      <h3>${escapeHtml(plugin.title)} 配置正在展开</h3>
      <p>${escapeHtml(statusDetail)} · 正在读取 schema 与对象级覆盖。</p>
    </section>
  `;
  loadFusionConfig(plugin, target)
    .then((data) => {
      if (renderToken !== activeFusionRenderToken || activePluginId !== plugin.id) return;
      renderExternalPluginConfig(plugin, target, data, { statusTitle, statusDetail });
    })
    .catch((err) => {
      if (renderToken !== activeFusionRenderToken) return;
      els.groupForm.innerHTML += `
        <section class="section-panel fusion-error-panel">
          <span class="section-number">ERR</span>
          <h3>融合配置读取失败</h3>
          <p>${escapeHtml(err.message || "未知错误")}</p>
        </section>
      `;
    });
}

function renderExternalPluginConfig(plugin, target, data, statusInfo = {}) {
  activeFusionConfig = data;
  rememberFusionConfig(plugin, target, data);
  renderObjectList();
  const blocks = fusionPluginBlocks(plugin);
  const fieldCount = blocks.reduce((sum, block) => sum + countFusionFields(block.sections), 0);
  const overrideCount = blocks.reduce((sum, block) => {
    const values = data?.modules?.[block.module.id]?.values;
    return sum + (values && typeof values === "object" ? Object.keys(values).length : 0);
  }, 0);
  setMetrics([
    { label: "插件", value: plugin.shortTitle, meta: plugin.status, kind: "ok" },
    { label: "当前对象", value: fusionTargetLabel(target.type), meta: target.label },
    { label: "配置项", value: String(fieldCount), meta: "全部展开" },
    { label: "覆盖值", value: String(overrideCount), meta: overrideCount ? "已保存覆盖" : "使用原配置" },
  ]);
  setSelectedSummary(target.label, [
    `${plugin.title} · ${plugin.modules.length} 个功能块`,
    target.meta,
    overrideCount ? `${overrideCount} 项覆盖` : "继承原插件配置",
  ]);
  els.groupForm.innerHTML = `
    <section class="fusion-hero-panel tone-${plugin.tone}">
      <div>
        <p class="eyebrow">${plugin.eyebrow}</p>
        <h3>${escapeHtml(plugin.title)}</h3>
        <p>${escapeHtml(plugin.summary)}</p>
      </div>
      <div class="fusion-route-card">
        <span>${escapeHtml(statusInfo.statusTitle || "已融合")}</span>
        <strong>${escapeHtml(target.label)}</strong>
        <em>${escapeHtml(target.meta)}</em>
      </div>
    </section>
    <section class="fusion-target-ribbon tone-${plugin.tone}">
      <article>
        <span>对象范围</span>
        <strong>${escapeHtml(fusionObjectNotice(target))}</strong>
      </article>
      <article>
        <span>配置来源</span>
        <strong>${escapeHtml(data?.plugin?.config_path || statusInfo.statusDetail || plugin.directory)}</strong>
      </article>
      <article>
        <span>保存方式</span>
        <strong>保存为权限控制器覆盖层，不直接破坏原插件配置</strong>
      </article>
    </section>
    <section class="fusion-config-tree fusion-config-flat" data-plugin-id="${escapeHtml(plugin.id)}">
      ${blocks.map((block) => {
        const moduleValues = data?.modules?.[block.module.id]?.values;
        const values = moduleValues && typeof moduleValues === "object" ? moduleValues : {};
        return `
          <section class="fusion-feature-block tone-${plugin.tone}" data-fusion-feature="${escapeHtml(block.module.id)}">
            <header class="fusion-feature-head">
              <span>${escapeHtml(block.module.shortTitle || block.module.title.slice(0, 1))}</span>
              <div>
                <strong>${escapeHtml(block.module.title)}</strong>
                <em>${escapeHtml(block.module.summary)}</em>
              </div>
              <b>${countFusionFields(block.sections)} 项</b>
            </header>
            ${block.sections.map((section) => renderFusionSection(section, data?.schema || {}, block.sections, values, target, block.module.id)).join("")}
          </section>
        `;
      }).join("")}
    </section>
  `;
}

function renderWelcomePanel() {
  selected = null;
  setPermissionChrome(true);
  els.currentScopeLabel.textContent = "权限配置";
  els.currentGroupTitle.textContent = "选择配置对象";
  els.currentGroupMeta.textContent = "从第二列选择群聊或私聊对象，第三列会直接展开权限配置";
  els.resetGroupBtn.textContent = "清空配置";
  els.saveGroupBtn.textContent = "保存配置";
  setMetrics([
    { label: "群聊", value: String(groups.length), meta: "已同步对象" },
    { label: "私聊", value: String(privateContacts.length), meta: "已同步好友" },
    { label: "当前对象", value: "未选", meta: "等待选择" },
    { label: "思考强度", value: "默认", meta: "未覆盖" },
  ]);
  setSelectedSummary("未选择", ["等待选择配置对象"]);
  els.groupForm.classList.remove("empty-state");
  els.groupForm.innerHTML = `
    <div class="welcome-panel">
      <p class="eyebrow">Ready</p>
      <h3>选择一个群聊或私聊对象，开始调整调用权限</h3>
      <p>当前分区会直接写入权限控制器配置；其它插件分区会在同一控制台内保存群聊/私聊对象级覆盖。</p>
    </div>
  `;
  renderObjectList();
}

function makeReasoningSelect(id, value) {
  const select = document.createElement("select");
  select.id = id;
  const current = normalizeReasoningValue(value);
  REASONING_OPTIONS.forEach(([optionValue, label]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === current;
    select.appendChild(option);
  });
  return select;
}

function makeToggle(id, title, meta, enabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = `toggle-card ${enabled ? "is-on" : ""}`;
  button.dataset.enabled = enabled ? "true" : "false";
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.innerHTML = `
    <span>
      <strong></strong>
      <span></span>
    </span>
    <i class="switch-rail" aria-hidden="true"></i>
  `;
  button.querySelector("strong").textContent = title;
  button.querySelector("span span").textContent = meta;
  button.addEventListener("click", () => {
    const next = button.dataset.enabled !== "true";
    button.dataset.enabled = next ? "true" : "false";
    button.setAttribute("aria-pressed", next ? "true" : "false");
    button.classList.toggle("is-on", next);
  });
  return button;
}

function sectionPanel(number, title, meta) {
  const panel = document.createElement("section");
  panel.className = "section-panel";
  const head = document.createElement("div");
  head.className = "section-head";
  head.innerHTML = `
    <div>
      <span class="section-number"></span>
      <h3></h3>
      <p></p>
    </div>
  `;
  head.querySelector(".section-number").textContent = number;
  head.querySelector("h3").textContent = title;
  head.querySelector("p").textContent = meta;
  panel.appendChild(head);
  return panel;
}

function renderGroupForm(payload) {
  const info = payload.group_info || {};
  const config = payload.config || {};
  const id = String(info.group_id || "");
  const name = info.group_name || `群 ${id}`;
  const allowedUsers = Array.isArray(config.allowed_users) ? config.allowed_users : [];
  const deniedUsers = Array.isArray(config.denied_users) ? config.denied_users : [];
  const reasoningRules = Array.isArray(config.reasoning_user_rules) ? config.reasoning_user_rules : [];

  selected = { type: "groups", id, payload };
  els.currentScopeLabel.textContent = "群聊配置";
  els.currentGroupTitle.textContent = name;
  els.currentGroupMeta.textContent = `群号 ${id}`;
  els.resetGroupBtn.textContent = "清空群配置";
  els.saveGroupBtn.textContent = "保存群配置";

  setMetrics([
    { label: "访问模式", value: config.group_enabled ? "整群" : "精确", meta: config.group_enabled ? "群内默认放行" : "依赖名单规则", kind: config.group_enabled ? "ok" : "" },
    { label: "允许", value: String(allowedUsers.length), meta: "白名单成员", kind: "ok" },
    { label: "拒绝", value: String(deniedUsers.length), meta: "黑名单成员", kind: deniedUsers.length ? "danger" : "" },
    { label: "思考", value: reasoningLabel(config.reasoning_effort), meta: reasoningRules.length ? `${reasoningRules.length} 条成员覆盖` : "群默认" },
  ]);
  setSelectedSummary(name, [`群号 ${id}`, `访问模式：${config.group_enabled ? "整群放行" : "精确授权"}`, `思考强度：${reasoningLabel(config.reasoning_effort)}`]);

  els.groupForm.classList.remove("empty-state");
  els.groupForm.innerHTML = "";

  const access = sectionPanel("01", "访问策略", "控制该群是整群放行，还是仅允许名单成员调用。");
  access.appendChild(makeToggle("groupEnabledInput", "整群放行", "开启后群内成员默认可调用", Boolean(config.group_enabled)));

  const lists = sectionPanel("02", "成员名单", "允许名单与拒绝名单会写入当前群的独立规则。");
  const listGrid = document.createElement("div");
  listGrid.className = "field-grid";
  listGrid.innerHTML = `
    <label class="field">
      <span>允许用户 QQ</span>
      <textarea id="allowedUsersInput" spellcheck="false"></textarea>
    </label>
    <label class="field">
      <span>拒绝用户 QQ</span>
      <textarea id="deniedUsersInput" spellcheck="false"></textarea>
    </label>
  `;
  listGrid.querySelector("#allowedUsersInput").value = allowedUsers.join("\n");
  listGrid.querySelector("#deniedUsersInput").value = deniedUsers.join("\n");
  lists.appendChild(listGrid);

  const reasoning = sectionPanel("03", "思考强度", "群默认强度可被成员覆盖规则替代。");
  const reasoningGrid = document.createElement("div");
  reasoningGrid.className = "reasoning-grid";
  const selectField = document.createElement("label");
  selectField.className = "field";
  const selectLabel = document.createElement("span");
  selectLabel.textContent = "群默认强度";
  selectField.append(selectLabel, makeReasoningSelect("groupReasoningEffortInput", config.reasoning_effort));
  const ruleField = document.createElement("label");
  ruleField.className = "field";
  ruleField.innerHTML = `<span>成员覆盖规则</span><textarea id="reasoningUsersInput" spellcheck="false"></textarea>`;
  ruleField.querySelector("textarea").value = reasoningRules.join("\n");
  reasoningGrid.append(selectField, ruleField);
  reasoning.appendChild(reasoningGrid);

  const tokens = document.createElement("div");
  tokens.className = "token-row";
  tokens.append(
    makeToken("格式：QQ=强度"),
    makeToken("强度：低 / 中 / 高 / 超高"),
    makeToken("保存后实时生效"),
  );
  reasoning.appendChild(tokens);

  els.groupForm.append(access, lists, reasoning);
  renderObjectList();
}

function makeToken(text) {
  const token = document.createElement("span");
  token.className = "token";
  token.textContent = text;
  return token;
}

function renderPrivateForm(payload) {
  const info = payload.contact_info || {};
  const config = payload.config || {};
  const id = String(info.user_id || "");
  const name = info.nickname || info.remark || `好友 ${id}`;

  selected = { type: "privates", id, payload };
  els.currentScopeLabel.textContent = "私聊配置";
  els.currentGroupTitle.textContent = name;
  els.currentGroupMeta.textContent = `QQ ${id}`;
  els.resetGroupBtn.textContent = "关闭私聊权限";
  els.saveGroupBtn.textContent = "保存私聊配置";

  setMetrics([
    { label: "私聊权限", value: config.private_enabled ? "开启" : "关闭", meta: config.private_enabled ? "允许私聊调用" : "私聊保持拦截", kind: config.private_enabled ? "ok" : "" },
    { label: "思考强度", value: reasoningLabel(config.reasoning_effort), meta: config.reasoning_effort ? "单人覆盖" : "默认策略" },
    { label: "对象类型", value: "私聊", meta: `QQ ${id}` },
    { label: "来源", value: info.source === "live" ? "实时" : "配置", meta: "好友列表" },
  ]);
  setSelectedSummary(name, [`QQ ${id}`, `私聊权限：${config.private_enabled ? "开启" : "关闭"}`, `思考强度：${reasoningLabel(config.reasoning_effort)}`]);

  els.groupForm.classList.remove("empty-state");
  els.groupForm.innerHTML = "";

  const access = sectionPanel("01", "私聊权限", "控制该好友是否可以在私聊中调用机器人。");
  access.appendChild(makeToggle("privateEnabledInput", "开启私聊调用", "仅影响当前好友", Boolean(config.private_enabled)));

  const reasoning = sectionPanel("02", "思考强度", "为该好友设置独立的模型请求强度。");
  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.textContent = "私聊强度";
  field.append(label, makeReasoningSelect("privateReasoningEffortInput", config.reasoning_effort));
  reasoning.appendChild(field);

  els.groupForm.append(access, reasoning);
  renderObjectList();
}

function collectGroupForm() {
  return {
    group_enabled: document.getElementById("groupEnabledInput")?.dataset.enabled === "true",
    allowed_users: normalizeListText(document.getElementById("allowedUsersInput")?.value),
    denied_users: normalizeListText(document.getElementById("deniedUsersInput")?.value),
    reasoning_effort: document.getElementById("groupReasoningEffortInput")?.value || "",
    reasoning_user_rules: parseReasoningRules(document.getElementById("reasoningUsersInput")?.value),
  };
}

function collectPrivateForm() {
  return {
    private_enabled: document.getElementById("privateEnabledInput")?.dataset.enabled === "true",
    reasoning_effort: document.getElementById("privateReasoningEffortInput")?.value || "",
  };
}

function fusionValuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a.map(String) : normalizeListText(a);
    const bb = Array.isArray(b) ? b.map(String) : normalizeListText(b);
    return JSON.stringify(aa) === JSON.stringify(bb);
  }
  return String(a ?? "") === String(b ?? "");
}

function collectFusionFormValuesByModule() {
  const plugin = activePlugin();
  const target = fusionTargetContext();
  const blocks = fusionPluginBlocks(plugin);
  const sectionsByModule = new Map(blocks.map((block) => [block.module.id, block.sections]));
  const schema = activeFusionConfig?.schema || {};
  const valuesByModule = {};
  els.groupForm.querySelectorAll("[data-fusion-field]").forEach((field) => {
    const path = field.dataset.fusionField;
    const moduleId = field.dataset.fusionModule || blocks[0]?.module.id || "default";
    const kind = field.dataset.fusionKind || "string";
    if (!path) return;
    const sections = sectionsByModule.get(moduleId) || [];
    const definition = fieldDefinition(schema, sections, path);
    const defaultValue = fusionDefaultValue(path, definition, target);
    let nextValue;
    if (kind === "bool") {
      nextValue = Boolean(field.checked);
    } else if (kind === "list-options") {
      nextValue = Array.from(field.querySelectorAll("input[type='checkbox']:checked"))
        .map((input) => input.value)
        .filter(Boolean);
    } else if (kind === "list" || kind === "file") {
      nextValue = normalizeListText(field.value || "");
    } else if (kind === "int") {
      nextValue = field.value === "" ? "" : Number.parseInt(field.value, 10);
    } else if (kind === "float") {
      nextValue = field.value === "" ? "" : Number.parseFloat(field.value);
    } else {
      nextValue = field.value || "";
    }
    if (!fusionValuesEqual(nextValue, defaultValue)) {
      if (!valuesByModule[moduleId]) valuesByModule[moduleId] = {};
      valuesByModule[moduleId][path] = nextValue;
    }
  });
  return valuesByModule;
}

async function saveFusionConfig() {
  const plugin = activePlugin();
  const target = fusionTargetContext();
  const valuesByModule = collectFusionFormValuesByModule();
  els.saveGroupBtn.disabled = true;
  try {
    let data;
    if (previewMode || !api) {
      data = previewFusionConfig(plugin, target);
      for (const block of fusionPluginBlocks(plugin)) {
        data = setPreviewFusionModule(plugin, target, block.module.id, valuesByModule[block.module.id] || {});
      }
      toast("预览覆盖已保存，进入 AstrBot 后可写入真实覆盖文件", "success");
    } else {
      const results = [];
      for (const block of fusionPluginBlocks(plugin)) {
        results.push(await api.safePost("settings/fusion/config", {
          plugin_id: plugin.id,
          module_id: block.module.id,
          target_type: target.type,
          target_id: target.id,
          values: valuesByModule[block.module.id] || {},
        }));
      }
      data = {
        ...(activeFusionConfig || {}),
        modules: {
          ...((activeFusionConfig && activeFusionConfig.modules) || {}),
          ...Object.fromEntries(results.map((result) => [result.module_id, result.module])),
        },
      };
      toast("融合覆盖配置已保存", "success");
    }
    renderExternalPluginConfig(plugin, target, data, {
      statusTitle: "已保存",
      statusDetail: data?.plugin?.config_path || plugin.directory,
    });
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  } finally {
    els.saveGroupBtn.disabled = false;
  }
}

async function resetFusionConfig() {
  const plugin = activePlugin();
  const target = fusionTargetContext();
  const ok = window.confirm(`确定重置 ${target.label} 的 ${plugin.shortTitle} 全部覆盖配置？`);
  if (!ok) return;
  els.resetGroupBtn.disabled = true;
  try {
    let data;
    if (previewMode || !api) {
      data = previewFusionConfig(plugin, target);
      for (const block of fusionPluginBlocks(plugin)) {
        data = resetPreviewFusionModule(plugin, target, block.module.id);
      }
      toast("预览覆盖已重置", "success");
    } else {
      await Promise.all(fusionPluginBlocks(plugin).map((block) => api.safePost("settings/fusion/config/reset", {
        plugin_id: plugin.id,
        module_id: block.module.id,
        target_type: target.type,
        target_id: target.id,
      })));
      data = {
        ...(activeFusionConfig || {}),
        modules: {
          ...((activeFusionConfig && activeFusionConfig.modules) || {}),
          ...Object.fromEntries(fusionPluginBlocks(plugin).map((block) => [block.module.id, { values: {}, updated_at: 0 }])),
        },
      };
      toast("融合覆盖配置已重置", "success");
    }
    renderExternalPluginConfig(plugin, target, data, {
      statusTitle: "已重置",
      statusDetail: data?.plugin?.config_path || plugin.directory,
    });
  } catch (err) {
    toast(`重置失败：${err.message}`, "error");
  } finally {
    els.resetGroupBtn.disabled = false;
  }
}

async function loadGroupConfig(groupId) {
  const target = String(groupId || "").trim();
  if (!target) return;
  if (previewMode || !api) {
    const group = groups.find((item) => String(item.group_id) === target) || groups[0];
    renderGroupForm(previewGroupPayload(group));
    return;
  }
  try {
    const data = await api.safeGet("settings/group", { group_id: target });
    const listInfo = groups.find((group) => String(group.group_id) === target);
    if (listInfo) data.group_info = { ...(data.group_info || {}), ...listInfo };
    renderGroupForm(data);
  } catch (err) {
    toast(`加载群配置失败：${err.message}`, "error");
  }
}

async function selectPrivateContact(contact) {
  const userId = String(contact?.user_id || "").trim();
  if (!userId) return;
  if (previewMode || !api) {
    renderPrivateForm(previewPrivatePayload(contact));
    return;
  }
  try {
    const data = await api.safeGet("settings/private", { user_id: userId });
    data.contact_info = { ...(data.contact_info || {}), ...contact };
    renderPrivateForm(data);
  } catch (err) {
    toast(`加载私聊配置失败：${err.message}`, "error");
  }
}

async function refreshObjects(options = {}) {
  if (previewMode || !api) {
    renderObjectList();
    if (!options.silent) toast("预览对象已刷新", "success");
    return;
  }
  const fallbackConfig = options.fallbackConfig || bootstrapConfig;
  const [nextGroups] = await Promise.all([
    api.safePost("settings/groups/refresh", {}),
    refreshPrivateContacts({ fallbackConfig }),
  ]);
  groups = Array.isArray(nextGroups) ? nextGroups : [];
  renderObjectList();
  if (!options.silent) toast("对象列表已同步", "success");
}

async function loadBootstrap() {
  els.groupList.classList.add("empty-state");
  els.groupList.textContent = "正在同步对象列表";
  const data = await api.safeGet("settings/bootstrap");
  bootstrapConfig = data.config || {};
  applySystemInfo(data.system || {});
  groups = Array.isArray(data.groups) ? data.groups : [];
  await refreshPrivateContacts({ fallbackConfig: bootstrapConfig }).catch(() => {
    privateContacts = privateContactsFromConfig(bootstrapConfig);
  });
  renderWelcomePanel();
}

async function loadFusionStatus() {
  const data = await api.safeGet("settings/fusion");
  fusionPlugins = Array.isArray(data.plugins) ? data.plugins : [];
  fusionAccessIndex = data.access_index && typeof data.access_index === "object" ? data.access_index : {};
  renderFusionShell();
}

async function saveCurrentConfig() {
  if (activePluginId !== "permission") {
    await saveFusionConfig();
    return;
  }
  if (!selected) {
    toast("请先选择配置对象", "error");
    return;
  }
  if (previewMode || !api) {
    toast("预览模式不会写入配置，进入 AstrBot 后可真实保存", "success");
    return;
  }
  els.saveGroupBtn.disabled = true;
  try {
    if (selected.type === "groups") {
      const data = await api.safePost("settings/group", {
        group_id: selected.id,
        config: collectGroupForm(),
      });
      touchGroupConfig(selected.id);
      await refreshObjects({ silent: true });
      renderGroupForm(data);
      toast("群配置已保存", "success");
    } else {
      const data = await api.safePost("settings/private", {
        user_id: selected.id,
        config: collectPrivateForm(),
      });
      await refreshObjects({ silent: true });
      renderPrivateForm(data);
      toast("私聊配置已保存", "success");
    }
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  } finally {
    els.saveGroupBtn.disabled = false;
  }
}

async function resetCurrentConfig() {
  if (activePluginId !== "permission") {
    await resetFusionConfig();
    return;
  }
  if (!selected) {
    toast("请先选择配置对象", "error");
    return;
  }
  if (previewMode || !api) {
    toast("预览模式不会重置真实配置", "success");
    return;
  }
  const ok = window.confirm(selected.type === "groups" ? "确定清空该群配置？" : "确定关闭该好友私聊权限？");
  if (!ok) return;
  els.resetGroupBtn.disabled = true;
  try {
    if (selected.type === "groups") {
      const data = await api.safePost("settings/group/reset", { group_id: selected.id });
      touchGroupConfig(selected.id);
      await refreshObjects({ silent: true });
      renderGroupForm(data);
      toast("群配置已重置", "success");
    } else {
      const data = await api.safePost("settings/private/reset", { user_id: selected.id });
      await refreshObjects({ silent: true });
      renderPrivateForm(data);
      toast("私聊配置已重置", "success");
    }
  } catch (err) {
    toast(`重置失败：${err.message}`, "error");
  } finally {
    els.resetGroupBtn.disabled = false;
  }
}

function bindEvents() {
  bindBackgroundEvents();
  bindPointerField();
  els.toggleThemeBtn?.addEventListener("click", cycleTheme);
  els.railThemeBtn?.addEventListener("click", cycleTheme);
  els.railItems.forEach((button) => {
    button.addEventListener("click", () => setActivePlugin(button.dataset.railPlugin));
  });
  els.refreshGroupsBtn?.addEventListener("click", () => refreshObjects().catch((err) => toast(`同步失败：${err.message}`, "error")));
  els.groupSearchInput?.addEventListener("input", renderObjectList);
  els.groupTabBtn?.addEventListener("click", () => setMode("groups"));
  els.privateTabBtn?.addEventListener("click", () => setMode("privates"));
  els.saveGroupBtn?.addEventListener("click", saveCurrentConfig);
  els.resetGroupBtn?.addEventListener("click", resetCurrentConfig);
  [els.tonePrimaryInput, els.toneSecondaryInput, els.toneGlowInput, els.toneBackdropCardInput].forEach((control) => {
    control?.addEventListener("input", updateToneFromControls);
    control?.addEventListener("change", () => updateToneFromControls({ immediate: true }));
  });
  els.resetToneBtn?.addEventListener("click", resetToneSettings);
  if (themeMediaQuery) {
    const handler = () => {
      if (themePreference === "auto") applyTheme();
    };
    if (themeMediaQuery.addEventListener) themeMediaQuery.addEventListener("change", handler);
    else if (themeMediaQuery.addListener) themeMediaQuery.addListener(handler);
  }
}

async function init() {
  applyTheme();
  applyToneSettings(toneSettings);
  applyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS);
  renderFusionShell();
  bindEvents();
  updateClock();
  window.setInterval(updateClock, 1000);
  if (!bridge) {
    activatePreviewMode();
    return;
  }
  try {
    api = createApi(bridge);
    loadLocationWeather();
    await loadThemeFromBackend();
    applyTheme();
    await loadToneFromBackend();
    await loadBackgroundFromBackend();
    await loadFusionStatus();
    await loadBootstrap();
  } catch (err) {
    els.groupForm.textContent = `加载失败：${err.message}`;
    els.groupForm.classList.add("empty-state");
    toast(`加载失败：${err.message}`, "error");
  }
}

init();
