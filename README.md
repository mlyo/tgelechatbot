# Telegram Private Relay Bot

<p align="center">
  <b>一个基于 Cloudflare Workers 的 Telegram 私聊双向中继机器人</b>
</p>

<p align="center">
  极简、高效、低成本、易维护。<br>
  支持主人直连回复、表情验证、防骚扰、限流与封禁管理。
</p>

<p align="center">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-orange">
  <img alt="Telegram Bot" src="https://img.shields.io/badge/Telegram-Bot-blue">
  <img alt="KV" src="https://img.shields.io/badge/Storage-KV-green">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-black">
</p>

---

## 项目简介

**Telegram Private Relay Bot** 是一个部署在 **Cloudflare Workers** 上的 Telegram 私聊双向机器人。

它的工作方式很直接：

- 用户私聊机器人发送消息
- 机器人自动把消息转给主人
- 主人只需要 **直接回复机器人转发的消息**
- 机器人就会自动把回复发回给对应用户

整个方案不依赖传统服务器，不需要数据库集群，也不需要复杂后台。
对于个人使用者、独立开发者、内容创作者来说，它可以作为一个轻量的 **Telegram 私信中枢**。

---

## 功能特性

### 双向私聊中继
- 用户消息自动转给主人
- 主人直接回复即可回传给原用户
- 支持私聊场景下的轻量消息中继

### 极简部署
- 基于 Cloudflare Workers 运行
- 基于 Cloudflare KV 存储状态
- 无需传统服务器，维护成本低

### 表情人机验证
- 新用户可通过表情顺序点击验证
- 降低广告、骚扰与机器滥用
- 未验证用户先发出的消息可在通过验证后自动转交

### 分级限流
- 已验证用户与未验证用户使用不同频率限制
- 减少刷屏和探测行为

### 封禁管理
- 支持封禁、解封、封禁信息查询
- 适合处理恶意骚扰或广告用户

### 消息去重
- 基于 update_id 做基础去重
- 降低 Telegram 重试回调带来的重复处理风险

### 多消息类型支持
- 文本
- 图片
- 视频
- 语音
- 文件
- 贴纸
- 以及大多数 Telegram 常见消息类型

---

## 适用场景

- 搭建个人 Telegram 留言机器人
- 作为个人私信收件箱
- 为频道主 / 博主 / 创作者提供私信入口
- 做一个轻量级匿名留言或联系入口
- 构建低成本的 Telegram DM 中继系统

---

## 项目预览

### 用户侧流程
1. 普通用户发送 `/start`
2. 未验证用户会先收到表情验证
3. 验证通过后进入欢迎页
4. 用户直接发送消息给机器人
5. 消息自动转给主人
6. 主人回复后，用户在机器人里收到回信

### 主人侧流程
1. 收到机器人转发的用户消息
2. 直接回复那条消息
3. 机器人自动识别回复目标并转发给对应用户

---

## 命令说明

### 主人命令

| 命令 | 说明 |
|---|---|
| `/start` | 查看主人控制提示 |
| `/status` | 查看机器人状态面板 |
| `/id` | 查看自己的 Telegram 用户 ID |
| `/ban 用户ID [理由]` | 封禁指定用户 |
| `/unban 用户ID` | 解封指定用户 |
| `/baninfo 用户ID` | 查看封禁信息 |

---

## 用户交互说明

### 用户发送 `/start` 时会发生什么？

#### 未验证用户
机器人会先发送表情验证题：

```text
🛡️ 人机验证

请按顺序点击：
🐱 → 🍎 → ⭐

当前进度：0/3
```

验证成功后：
- 验证消息会更新为 `✅ 验证成功`
- 如果之前已经发过消息，系统会自动转交给主人
- 然后发送欢迎页

#### 已验证用户
会直接收到欢迎消息和快捷菜单。

欢迎页一般包括：
- 💌 直接留言
- ❓ 使用帮助
- 📌 注意事项

---

## 状态面板 `/status`

主人发送 `/status` 后，可查看：

- 当前健康状态
- 主人自身状态
- 是否存在激活中的 challenge
- BOT_KV / 欢迎图配置状态
- Webhook 状态
- 待处理更新数
- 最近错误信息
- 验证和限流配置摘要

适合快速排查部署与回调问题。

---

## 项目结构

```text
.
├── worker.js
├── wrangler.toml
├── package.json
├── README.md
├── .gitignore
├── .dev.vars.example
└── LICENSE
```

---

## 快速部署

### 1. 克隆仓库

```bash
git clone https://github.com/yourname/your-repo.git
cd your-repo
```

### 2. 安装依赖

```bash
npm install
```

### 3. 创建 KV Namespace

```bash
npx wrangler kv namespace create BOT_KV
```

执行后会得到一个 KV Namespace ID。
把它填入 `wrangler.toml`：

```toml
name = "your-worker-name"
main = "worker.js"
compatibility_date = "2026-04-05"

[[kv_namespaces]]
binding = "BOT_KV"
id = "YOUR_KV_NAMESPACE_ID"
```

### 4. 配置 Secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put OWNER_ID
```

可选欢迎图：

```bash
npx wrangler secret put START_PHOTO_FILE_ID
```

### 5. 部署 Worker

```bash
npx wrangler deploy
```

部署后会得到一个 Worker 地址，例如：

```text
https://your-worker-name.your-subdomain.workers.dev
```

### 6. 设置 Telegram Webhook

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-worker-name.your-subdomain.workers.dev"
```

---

## 配置说明

### Secrets

| 名称 | 必填 | 说明 |
|---|---|---|
| `BOT_TOKEN` | 是 | Telegram Bot Token |
| `OWNER_ID` | 是 | 机器人主人的 Telegram 用户 ID |
| `START_PHOTO_FILE_ID` | 否 | 欢迎图的 Telegram file_id |

### KV Binding

| 绑定名 | 说明 |
|---|---|
| `BOT_KV` | 用于存储验证状态、封禁状态、消息映射、去重信息 |

---

## 本地开发

先复制环境变量模板：

```bash
cp .dev.vars.example .dev.vars
```

然后填入本地开发变量。

启动本地开发：

```bash
npx wrangler dev
```

---

## FAQ

### 为什么用户发消息没反应？
请检查以下内容：

- Worker 是否部署成功
- Webhook 是否设置成功
- `BOT_TOKEN` 是否正确
- `OWNER_ID` 是否正确
- `BOT_KV` 是否已绑定

### 为什么主人回复失败？
请确认你是 **直接回复机器人转发给你的那条消息**，而不是单独新发一条消息。

系统依赖消息映射来找到目标用户。

### 为什么 `/start` 后先验证？
这是为了减少骚扰、广告和机器人滥用。

### 为什么有人会被限流？
项目对未验证用户和已验证用户采用不同的频率限制，避免刷屏和滥用。

### Cloudflare KV 是否适合强一致场景？
当前版本适合个人使用和轻量部署。
如果你要做高并发强一致版本，建议迁移部分状态到 Durable Objects。

---

## 安全说明

本项目已内置基础防护：

- 表情验证
- 限流
- 封禁
- update 去重

但它仍然是一个 **轻量个人项目**，不是完整的企业级风控系统。

如果你要面对更复杂的场景，建议继续增强：

- 更细粒度限流
- 黑白名单机制
- Durable Objects 状态管理
- 更完整的日志审计

---

## 公开仓库建议

如果你准备把这个项目放到 GitHub 公开仓库，建议：

- `wrangler.toml` 中保留 `YOUR_KV_NAMESPACE_ID` 占位符
- 不要提交真实 `BOT_TOKEN`
- 不要提交真实 `OWNER_ID`
- 使用 `wrangler secret put` 配置敏感信息

---

## License

MIT

---

## Star History

如果这个项目对你有帮助，欢迎点个 Star。
