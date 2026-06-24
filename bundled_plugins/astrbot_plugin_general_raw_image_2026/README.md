![通用生图 General Raw Image 2026](https://raw.githubusercontent.com/xiaokangzaina/General-Raw-Image_2026/main/logo.png)

# 通用生图 General Raw Image 2026

AstrBot 通用图像生成插件，支持多供应商、多模型、文生图、图生图和参考图生成。

## 版本

```text
v1.2.8
```

## 功能

- 文生图
- 图生图
- 头像 / 参考图生成
- 多供应商配置
- 多模型切换
- 宽高比、分辨率等参数配置
- LLM 工具调用生图
- 失败重试和超时控制
- 用户限额、黑名单和冷却控制

## 安装

下载 Release ZIP 后，在 AstrBot 插件管理页面选择本地安装。

Release：

```text
https://github.com/xiaokangzaina/General-Raw-Image_2026/releases/tag/v1.2.8
```

## 基础配置

主要配置项：

| 配置项 | 说明 |
|---|---|
| `api_providers` | 图像模型供应商列表。 |
| `api_keys` | API Key / Token，默认空。 |
| `available_models` | 可用模型列表。 |
| `generation` | 生图默认参数。 |
| `user_limits` | 用户限额和黑名单。 |
| `cooldown` | 调用冷却。 |
| `proxy` | 代理配置。 |

## 使用

常见用法：

```text
画一只赛博朋克风格的猫
```

或上传图片后让机器人进行图生图。

具体命令以插件实际注册命令和 AstrBot 当前配置为准。

## 注意

- API Key / Token 默认留空，需要自行配置。
- 本地图片路径默认留空，避免携带本机路径隐私。
- 使用 LLM 工具调用时，请注意 AstrBot 和插件侧权限配置。
- 不同模型支持的宽高比、分辨率和图生图能力不同。

## 支持

仓库：

```text
https://github.com/xiaokangzaina/General-Raw-Image_2026
```
