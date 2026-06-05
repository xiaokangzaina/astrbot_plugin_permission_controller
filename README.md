# AstrBot 权限控制器

按 **用户 QQ、群号、私聊白名单、群聊黑名单** 精细控制 AstrBot 机器人调用权限。

支持 Web 配置页、群聊整体放行、用户-群号组合规则、私聊白名单、群聊黑名单，并会把放行对象同步到 AstrBot 平台白名单，避免核心白名单阶段提前拦截。

## 功能特性

- 群聊权限控制
  - 群聊整体放行
  - 用户 QQ + 群号组合放行
  - 群聊黑名单
  - 管理员绕过
- 私聊权限控制
  - 私聊白名单
  - 管理员可按配置绕过
- 运行时兼容
  - 自动同步放行群号/用户到平台 `id_whitelist`
  - 支持 Web 配置页保存后热重载
  - 可选管理员绕过唤醒词
- 群管插件兼容
  - 自动放行 aiocqhttp 的 `request` / `notice` / `meta_event`
  - 不再拦截加群申请、进退群通知等非普通聊天事件
  - 避免影响 QQ 群管类插件的自动审批、欢迎、退群通知功能

## 安装

将插件目录放入 AstrBot：

```text
data/plugins/astrbot_plugin_permission_controller
```

重启 AstrBot 或在插件管理页重载插件。

## 配置说明

插件支持 AstrBot WebUI 配置，也支持插件自带配置页。

### 群聊权限

#### enable_group_rules

是否启用群聊权限规则。

```text
true：启用群聊权限控制
false：不拦截群聊普通消息
```

#### allowed_groups

整体放行的群号列表。

命中后，该群所有用户都能调用机器人。

#### simple_rules

用户 QQ + 群号组合放行规则。

格式：

```text
用户QQ-群号
```

示例：

```text
123456-987654321
234567-987654321
```

含义：

```text
123456 只允许在 987654321 群调用
234567 只允许在 987654321 群调用
```

#### group_deny_rules

用户 QQ + 群号组合拒绝规则。

格式同 `simple_rules`。

该规则用于在某个群内拒绝指定用户。

#### enable_group_blacklist

是否启用群聊黑名单。

#### group_blacklist

群聊黑名单 QQ 列表。

命中后，该用户在群聊中会被拦截。

### 私聊权限

#### private_chat_users

允许私聊调用机器人的用户 QQ 列表。

为空时，默认不放行普通私聊用户。

#### admin_bypass

是否允许 AstrBot 全局管理员绕过权限限制。

```text
true：管理员绕过群聊/私聊限制
false：管理员也按规则判断
```

#### admin_wake_bypass

是否允许 AstrBot 全局管理员绕过唤醒词。

```text
true：管理员无需唤醒词即可触发
false：仍按 AstrBot 原唤醒逻辑
```

## 拦截逻辑

### 群聊普通消息

顺序：

```text
1. request / notice / meta_event 直接放行
2. 群聊黑名单判断
3. 群聊规则开关判断
4. 管理员绕过判断
5. 用户-群号拒绝规则
6. 群整体放行
7. 用户-群号放行
8. 未命中则 stop_event
```

### 私聊消息

顺序：

```text
1. request / notice / meta_event 直接放行
2. 判断是否私聊
3. 管理员绕过判断
4. 私聊白名单判断
5. 未命中则 stop_event
```

## 与 QQ 群管插件的兼容

早期版本会拦截 `GROUP_MESSAGE` 中承载的 aiocqhttp 原始事件。

部分 QQ 群管插件会用同一个事件通道监听：

```text
post_type=request   加群申请
post_type=notice    进群/退群通知
post_type=meta_event 心跳等元事件
```

如果权限控制器先执行 `event.stop_event()`，会导致群管插件的：

```text
进群自动审批
进群欢迎
退群通知
进群禁言
```

无法触发。

当前版本已修复：

```text
request / notice / meta_event 不再进入权限拦截逻辑
普通聊天 message 仍正常受控
```

## Web 配置页

插件提供可视化配置页，可用于：

```text
查看群列表
编辑群整体放行
编辑用户-群号规则
编辑私聊白名单
编辑群聊黑名单
保存后热重载运行时配置
```

## 注意事项

- 修改核心平台白名单后，插件会尽量保留用户手动维护的白名单项。
- 插件只移除自己曾同步过、但当前配置已删除的 ID。
- 如果更改管理员 ID，建议重载插件。
- 如果使用 QQ 群管类插件，请使用包含非聊天事件放行逻辑的版本。

## 更新日志

### v1.9.6

- 修复权限控制器拦截 AstrBot Dashboard Chat/WebChat 测试会话的问题
- Dashboard / WebChat 测试会话直接放行，不影响 QQ 群聊、QQ 私聊权限规则

### v1.9.5

- 修复权限控制器可能拦截 QQ 群管插件进群自动审批的问题
- 对 aiocqhttp `request` / `notice` / `meta_event` 原始事件直接放行
- 保持普通群聊消息、私聊消息权限控制逻辑不变
- 重写 README 文档

### v1.9.4

- 支持 Web 配置页
- 支持分组配置结构
- 优化平台白名单同步逻辑

## 许可证

见 `LICENSE`。
