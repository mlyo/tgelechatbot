# Telegram Private Relay Bot

<p align="center">
  一个基于 Cloudflare Workers + KV 的 Telegram 私聊双向机器人
</p>

<p align="center">
  轻量、直接、适合个人使用
</p>

---

## 项目介绍

一个基于 Cloudflare Workers + KV 的 Telegram 私聊双向机器人。

用户消息会自动转发给主人，主人直接回复即可回传给用户。  
内置单次表情验证、限流、封禁和状态查看，适合个人轻量使用。

---

## 功能特性

- 私聊双向转发
- 主人直接回复回传
- 单次表情点击验证
- 未验证消息验证后自动转交
- 限流
- 封禁 / 解封 / 封禁信息查询
- `/status` 日常状态查看
- 基于 Cloudflare Workers + KV 轻量部署

---

## 当前验证方式

当前版本使用 **单次表情点击验证**：

- 4 个按钮
- 2 列布局
- 点对一次直接通过
- 点错会重新出一题
- 连错 3 次冷却 60 秒

示例：

```text
🛡️ 人机验证

请点击下面的表情：
🐱

[ 🐱 ] [ 🍎 ]
[ ⭐ ] [ 🐸 ]
```

---

## 命令

### 普通用户

- `/start`

### 主人命令

- `/start`
- `/status`
- `/id`
- `/ban 用户ID [理由]`
- `/unban 用户ID`
- `/baninfo 用户ID`

---

## 部署教程

### 前置准备

你需要准备：

- 一个 Telegram Bot
- 一个 Cloudflare 账号
- 一个 GitHub 仓库
- 你自己的 Telegram 用户 ID

---

### 1. 创建 Telegram Bot

打开 [@BotFather](https://t.me/BotFather)，创建一个机器人，并拿到：

- `BOT_TOKEN`

---

### 2. 上传项目到 GitHub

把项目代码上传到你自己的 GitHub 仓库。

---

### 3. 在 Cloudflare 连接 GitHub 部署

1. 登录 Cloudflare
2. 进入 **Workers & Pages**
3. 点击 **Create application**
4. 选择 **Import a repository**
5. 连接 GitHub
6. 选择你的仓库
7. 点击 **Save and Deploy**

首次部署完成后，继续配置 Worker。

---

### 4. 创建并绑定 KV

1. 在 Cloudflare 左侧进入 **KV**
2. 新建一个 Namespace
3. 回到 Worker 的 **Settings**
4. 打开 **Bindings**
5. 添加一个 **KV Namespace Binding**
6. 变量名填写：

```text
BOT_KV
```

7. 绑定到刚才创建的 KV Namespace

---

### 5. 配置 Variables / Secrets

进入 Worker 的 **Settings** → **Variables and Secrets**，添加：

- `BOT_TOKEN`
- `OWNER_ID`
- `START_PHOTO_FILE_ID`（可选）

说明：

- `BOT_TOKEN`：BotFather 给你的 token
- `OWNER_ID`：你的 Telegram 用户 ID
- `START_PHOTO_FILE_ID`：欢迎图 file_id，可不填

配置完成后，重新部署一次。

---

### 6. 设置 Webhook

部署成功后，把 Telegram webhook 指向你的 Worker 地址：

```bash
curl -X POST "https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook"   -H "Content-Type: application/json"   -d '{
    "url": "https://你的workers地址",
    "allowed_updates": ["message", "callback_query"]
  }'
```

---

### 7. 检查是否部署成功

执行：

```bash
curl "https://api.telegram.org/bot<你的BOT_TOKEN>/getWebhookInfo"
```

重点看：

- `url` 是否正确
- `last_error_message` 是否为空
- `pending_update_count` 是否正常

---

### 8. 如果 Webhook 异常

先清掉旧 webhook 和积压更新：

```bash
curl "https://api.telegram.org/bot<你的BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
```

然后重新设置 webhook。

---

## 使用流程

### 普通用户发送 `/start`

#### 未验证用户
先收到表情验证。

#### 已验证用户
直接收到欢迎页和菜单按钮。

---

### 普通用户直接发消息

#### 已验证
消息直接转给主人。

#### 未验证
先触发验证，通过后自动转交刚才的消息。

---

### 主人回复消息

主人只需要：

- **直接回复** 机器人转发的那条消息

即可把消息回传给对应用户。

---

## `/status` 日常版示例

```text
📊 Bot 状态

- 健康状态：正常
- Webhook：已设置
- 待处理更新：1
- 最后错误：无

👤 主人
- Owner ID：5762770125
- 封禁状态：否

⚙️ 环境
- BOT_KV：已绑定
- START_PHOTO_FILE_ID：未设置

🛡️ 验证
- 冷却时间：60s
- 失败上限：3

🚦 限流
- 已验证：20/60s
- 未验证：6/60s
```

---

## 数据存储说明

当前实现中：

### 存在 Telegram 的
- 用户消息内容本体
- 图片 / 文件 / 语音 / 视频等原始消息

### 存在 Cloudflare KV 的
- 封禁信息
- 验证状态
- 冷却状态
- challenge 状态
- 主人回复映射
- 限流计数
- update 去重标记

也就是说：

> 消息内容本体不存 KV，KV 只存状态和映射。

---

## FAQ

### 为什么机器人没有反应？

优先检查：

- Webhook 是否设置成功
- `BOT_TOKEN` 是否正确
- `OWNER_ID` 是否正确
- `BOT_KV` 是否绑定成功
- 是否重新部署过

---

### 为什么主人回复失败？

请确认你是：

- **直接回复** 机器人转给你的那条消息
- 不是单独发一条新消息

---

### 为什么未验证消息没有立刻转发？

因为当前逻辑是：

- 先做人机验证
- 验证通过后
- 再自动转交刚才的消息

---

### 为什么不用 Durable Objects？

当前项目定位是：

- 个人使用
- 单文件
- 轻量部署
- 低维护成本

所以当前版本保持：

- Workers + KV
- 不引入 DO

---

## 项目定位

当前版本有意保持为：

- 单文件 Worker
- Workers + KV
- 不拆复杂架构
- 不引入 Durable Objects
- 以实用和轻量为主

---

## 已知边界

当前版本是个人实用型项目，不是企业级强一致系统。

已知边界：

- KV 限流 / 去重 / challenge 状态不是强一致
- `owner_msg` 映射过期后，无法继续回复旧消息
- 不做消息历史归档

对于个人私聊中继场景，这些通常可以接受。

---

## License

MIT
