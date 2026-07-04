# AstrBot 权限控制台

AstrBot 权限控制台是一个面向 AstrBot 管理者的权限管理插件。它只负责权限控制器本体逻辑：群聊调用权限、私聊白名单、群聊黑名单、管理员绕过、唤醒词绕过和模型思考强度注入。

插件内部 ID 仍为 `astrbot_plugin_permission_controller`，可以覆盖旧版目录升级。`v3.1.0` 起已删除旧版内置扩展包、事件接管逻辑和对象级扩展配置接口，避免与单独安装的其它插件发生命令或事件冲突。

## 功能

- 群聊权限：支持整群放行、用户-群号组合放行、本群拒绝用户和群聊黑名单。
- 私聊权限：支持好友私聊白名单。
- 管理员绕过：可让 AstrBot 平台管理员绕过私聊和群聊限制。
- 唤醒词绕过：可让管理员在普通消息中唤醒机器人。
- 思考强度：按全局、群聊、群成员或私聊好友注入 `reasoning_effort`。
- 配置同步：可把允许的群聊同步到 AstrBot 平台白名单。
- 可视化设置页：提供群聊/私聊对象列表、权限编辑区、运行状态区、天气信息和系统信息。
- 音频体验：保留背景音乐、按钮音效、自定义背景音上传和播放进度保存。
- 视觉背景：支持上传图片、GIF 和视频作为设置页背景。

## 安装

下载发行版后，确保插件目录名为：

```text
astrbot_plugin_permission_controller
```

把整个目录放入 AstrBot 插件目录：

```text
data/plugins/astrbot_plugin_permission_controller
```

然后重启 AstrBot，或在 AstrBot 插件管理页重新加载插件。

## 升级说明

从旧版升级到 `v3.1.0` 后，权限控制器自身配置会继续保留，包括群聊放行、私聊白名单、黑名单、管理员绕过、思考强度、背景音乐和自定义背景。

旧版内置的其它插件能力已不再随本插件加载。如果你需要生图、安全审核、QQ群管或网页截图，请单独安装对应插件，并让它们各自管理自己的配置。

升级前建议备份：

```text
data/plugins/astrbot_plugin_permission_controller
```

升级后建议重新打开插件设置页，检查群聊列表、私聊列表、权限规则、音频开关和自定义背景是否符合预期。

## 常见用法

让某个群可以使用机器人：进入插件设置页，选择群聊，把群号加入整群放行。

让某个人只在指定群使用机器人：选择对应群聊，把 `QQ-群号` 写入用户-群号放行规则。

让某个私聊好友可以使用机器人：选择私聊对象，把该好友 QQ 加入私聊白名单。

禁止某个用户在指定群使用机器人：选择对应群聊，把 `QQ-群号` 写入本群拒绝用户。

调整模型思考强度：在全局、群聊、群成员或私聊好友规则里写入 `low`、`medium` 或 `high`。

开启或关闭背景音乐：使用设置页顶部或右侧音频模块里的 BGM 开关。状态和播放进度会保存，重新进入后会尽量从上次位置继续。

上传自定义背景音：在音频模块点击“上传背景音”，选择本地音频文件；点击“恢复默认”会重新使用内置曲目。

上传视觉背景：在视觉背景模块点击“上传背景”，支持图片、GIF 和视频。启用后卡片会使用高透明材质，方便看清背景。

## 配置项

主要配置位于 `_conf_schema.json`：

- `private_chat_settings.private_chat_users`
- `private_chat_settings.admin_bypass`
- `private_chat_settings.admin_wake_bypass`
- `group_chat_settings.enable_group_rules`
- `group_chat_settings.allowed_groups`
- `group_chat_settings.simple_rules`
- `group_chat_settings.group_deny_rules`
- `group_chat_settings.enable_group_blacklist`
- `group_chat_settings.group_blacklist`
- `reasoning_settings.reasoning_default_effort`
- `reasoning_settings.reasoning_group_defaults`
- `reasoning_settings.reasoning_group_user_rules`
- `reasoning_settings.reasoning_private_users`

## 版本

### v3.1.0

- 删除旧版内置扩展包，不再加载或接管其它插件。
- 删除旧版扩展运行时绑定、事件包装、重复命令清理和对象级扩展配置接口。
- 删除已经失效的扩展运行时测试。
- 更新插件注册描述、元数据和 README，使插件定位回到纯权限控制器。
- 保留设置页、背景音乐、按钮音效、自定义背景音、自定义视觉背景和播放进度保存。

### v3.0.14

- 修复自定义视频背景播放进度恢复失败。
- 避免旧进度被错误的 0 秒初始时间覆盖。
- 后端进度保存不再刷新媒体身份时间戳。

### v3.0.13

- 自定义图片、GIF 和视频背景改为双层显示，减少黑边。
- 视频背景进度保存增加本地兜底。
- 优化浅色模式下主题状态文字对比度。

## 许可证

本项目使用 MIT License。
