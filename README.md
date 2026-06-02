![权限控制器](https://raw.githubusercontent.com/xiaokangzaina/astrbot_plugin_permission_controller/main/logo.png)

# 权限控制器

AstrBot 私聊、群聊调用权限控制插件。

它只控制“谁可以使用机器人”，不会授予 AstrBot 管理员权限，也不会修改 `admins_id`。

## 功能

- 私聊白名单
- 群聊整体放行
- 本群允许用户
- 本群不允许调用用户
- 全局群聊用户黑名单
- AstrBot 管理员绕过限制
- AstrBot 管理员绕过唤醒词
- 自动同步整群放行列表到 AstrBot 平台白名单
- Web 可视化单群配置页

## 安装

下载 Release ZIP 后，在 AstrBot 插件管理页面选择本地安装。

最新版本：

```text
v1.9.4
```

Release：

```text
https://github.com/xiaokangzaina/astrbot_plugin_permission_controller/releases/tag/v1.9.4
```

## Web 配置

打开 AstrBot Dashboard → 插件管理 → 权限控制器 → 配置页面。

单群配置项：

| 页面字段 | 配置项 | 说明 |
|---|---|---|
| 整群放行 | `allowed_groups` | 开启后，该群所有成员可调用机器人。 |
| 本群允许用户 | `simple_rules` | 每行一个 QQ，保存为 `用户QQ-群号`。 |
| 本群不允许调用用户 | `group_deny_rules` | 每行一个 QQ，保存为 `用户QQ-群号`，优先级高于整群放行和允许用户。 |

## 配置项

| 配置项 | 说明 |
|---|---|
| `private_chat_users` | 私聊白名单用户 QQ。 |
| `admin_bypass` | AstrBot 管理员绕过权限限制。 |
| `admin_wake_bypass` | AstrBot 管理员绕过唤醒词。 |
| `enable_group_rules` | 启用群聊权限规则。 |
| `allowed_groups` | 整群放行群号列表。 |
| `simple_rules` | 本群允许用户规则，格式 `用户QQ-群号`。 |
| `group_deny_rules` | 本群禁止用户规则，格式 `用户QQ-群号`。 |
| `enable_group_blacklist` | 启用全局群聊用户黑名单。 |
| `group_blacklist` | 全局群聊禁止用户 QQ。 |

## 群聊判断顺序

1. 命中全局群聊黑名单：拦截。
2. AstrBot 管理员且开启 `admin_bypass`：放行。
3. `enable_group_rules` 关闭：放行。
4. 命中 `group_deny_rules`：拦截。
5. 群号在 `allowed_groups`：放行。
6. 命中 `simple_rules`：放行。
7. 其他情况：拦截。

## 说明

`allowed_groups` 会同步到 AstrBot 平台白名单，避免核心白名单阶段提前拦截群消息。

私聊白名单、群聊放行和本群允许用户都只是“允许使用机器人”，不会让用户变成管理员。

## 支持平台

```text
qq_official
aiocqhttp
```
