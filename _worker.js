export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("OK");
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const missingEnv = getMissingEnv(env);
    if (missingEnv) {
      return new Response(`Missing ${missingEnv}`, { status: 500 });
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response("Unsupported Media Type", { status: 415 });
    }

    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > CONFIG.MAX_WEBHOOK_BODY_BYTES) {
      logEvent("warn", "webhook_body_too_large", { contentLength });
      return new Response("Payload Too Large", { status: 413 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await processUpdate(update, env);
    } catch (error) {
      logEvent("error", "worker_error", {
        updateId: update?.update_id ?? null,
        error: error?.message || String(error)
      });
    }

    return new Response("OK");
  }
};

// =========================
// Config / Constants
// =========================

const CONFIG = {
  VERIFY_TTL: 300,
  VERIFIED_TTL: 30 * 24 * 60 * 60,
  BAN_TTL: 365 * 24 * 60 * 60,
  OWNER_MAP_TTL: 7 * 24 * 60 * 60,
  VERIFY_FAIL_MAX: 3,
  VERIFY_COOLDOWN_TTL: 60,
  VERIFY_PENDING_MAX: 5,
  UPDATE_DEDUPE_TTL: 300,
  RATE_LIMIT_WINDOW_VERIFIED: 60,
  RATE_LIMIT_WINDOW_UNVERIFIED: 60,
  RATE_LIMIT_VERIFIED_MAX: 20,
  RATE_LIMIT_UNVERIFIED_MAX: 6,
  MAX_WEBHOOK_BODY_BYTES: 256 * 1024
};

const Keys = {
  ban: (userId) => `ban:${userId}`,
  verified: (userId) => `verified:${userId}`,
  verifyCooldown: (userId) => `verify_cooldown:${userId}`,
  challenge: (challengeId) => `challenge:${challengeId}`,
  challengeUser: (userId) => `challenge:user:${userId}`,
  ownerMsg: (messageId) => `owner_msg:${messageId}`,
  rateVerified: (userId) => `rate:v:${userId}`,
  rateUnverified: (userId) => `rate:u:${userId}`,
  update: (updateId) => `update:${updateId}`
};

const TEXTS = {
  TOO_FAST: "发送太频繁了，请稍后再试。",
  VERIFIED_OK: "✅ 验证成功",
  VERIFY_PASS: "验证通过",
  VERIFY_EXPIRED: "验证已过期，已为你重新发送一题。",
  VERIFY_INVALID: "无效操作。",
  VERIFY_NOT_YOURS: "这不是你的验证。",
  VERIFY_LOCKED: "答错 3 次，请 60 秒后再试。",
  VERIFY_LOCKED_MESSAGE: "❌ 你已连续答错 3 次，请 60 秒后再试。",
  VERIFY_COOLDOWN: "你操作太快了，验证失败次数过多，请 60 秒后再试。",
  BANNED: "你已被封禁。",
  MESSAGE_RECEIVED: "已收到，消息已转交。",
  DIRECT_REPLY_HINT: "请直接回复我转给你的那条消息，这样我才能知道你要回给谁。",
  MAPPING_EXPIRED: "这条消息没有找到对应用户，可能映射已过期。请等对方重新发消息后再回复。",
  TARGET_BANNED: "该用户已被封禁，无法发送。",
  MENU_MESSAGE: "直接发送消息给我就可以啦 ✨",
  MENU_PICK: "请选择你想查看的内容：",
  OWNER_SELF_BAN: "不能封禁自己。",
  INVALID_USER_ID: "用户ID格式无效。"
};

const OWNER_COMMAND_HELP =
  "主人你好。\n直接回复我转给你的消息即可回用户。\n\n可用命令：\n/status\n/ban 用户ID [理由]\n/unban 用户ID\n/baninfo 用户ID\n/id";

const USER_HELP_TEXT =
  `ℹ️ 使用帮助\n\n` +
  `1. 直接发送任何消息给我\n` +
  `2. 支持文字、图片、语音、视频、文件等\n` +
  `3. 你的消息会直接转交给我\n` +
  `4. 我回复后，你会在这里收到通知`;

const USER_RULES_TEXT =
  `📌 注意事项\n\n` +
  `• 请勿发送广告或骚扰内容\n` +
  `• 请尽量简洁说明来意\n` +
  `• 如遇验证提示，请按步骤完成`;

const START_INTRO_TEXT =
  `🎉 你好，欢迎来到我的私聊机器人 ✨\n\n` +
  `💌 你可以直接把想说的话发给我，\n` +
  `文字、图片、语音、文件都可以。\n\n` +
  `👇 点下面按钮可查看帮助和说明。`;

// =========================
// Entry Flow
// =========================

async function processUpdate(update, env) {
  const deduped = await dedupeUpdate(update, env);
  if (deduped) return;

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat?.type !== "private") return;

  const fromId = String(msg.from?.id || "");
  if (!fromId) return;

  if (fromId === String(env.OWNER_ID)) {
    await handleOwnerMessage(msg, env);
  } else {
    await handleUserMessage(msg, env);
  }
}

// =========================
// User Flow
// =========================

async function handleUserMessage(msg, env) {
  const userId = String(msg.from.id);

  if (await isBanned(env, userId)) {
    logEvent("warn", "banned_user_message_ignored", { userId });
    return;
  }

  const verified = await isVerified(env, userId);
  const rateOk = await checkRateLimit(env, userId, verified);

  if (!rateOk) {
    await sendMessage(env, userId, TEXTS.TOO_FAST);
    logEvent("warn", "rate_limited", { userId, verified });
    return;
  }

  const text = (msg.text || "").trim();
  const isStart = text === "/start" || text.startsWith("/start ");

  if (isStart) {
    if (verified) {
      await sendStartPack(userId, env);
      logEvent("info", "start_pack_sent", { userId });
    } else {
      await sendVerification(userId, env, {
        pendingMessageId: null,
        fromUser: msg.from,
        showWelcomeAfterVerify: true
      });
      logEvent("info", "verification_sent_from_start", { userId });
    }
    return;
  }

  if (!verified) {
    await sendVerification(userId, env, {
      pendingMessageId: msg.message_id,
      fromUser: msg.from,
      showWelcomeAfterVerify: false
    });

    logEvent("info", "verification_sent_from_message", {
      userId,
      messageId: msg.message_id
    });
    return;
  }

  await forwardUserMessageToOwner(msg, env);
}

// =========================
// Owner Flow
// =========================

async function handleOwnerMessage(msg, env) {
  const ownerId = String(env.OWNER_ID);
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  const replyToMessageId = msg.reply_to_message?.message_id
    ? String(msg.reply_to_message.message_id)
    : "";

  const targetUserId = replyToMessageId
    ? await env.BOT_KV.get(Keys.ownerMsg(replyToMessageId))
    : "";

  const isReplyingToMappedUser = !!(replyToMessageId && targetUserId);

  if (!isReplyingToMappedUser) {
    const handled = await routeOwnerCommand(text, env);
    if (handled) return;
  }

  if (!replyToMessageId) {
    await sendMessage(env, ownerId, TEXTS.DIRECT_REPLY_HINT);
    return;
  }

  if (!targetUserId) {
    await sendMessage(env, ownerId, TEXTS.MAPPING_EXPIRED);
    return;
  }

  if (await isBanned(env, targetUserId)) {
    await sendMessage(env, ownerId, TEXTS.TARGET_BANNED);
    return;
  }

  const sendResult = await relayOwnerReplyToUser(msg, targetUserId, env);

  if (!sendResult.ok) {
    await sendMessage(env, ownerId, `发送失败：${sendResult.description || "unknown error"}`);
    logEvent("error", "owner_reply_failed", {
      ownerId,
      targetUserId,
      replyToMessageId,
      description: sendResult.description || "unknown error"
    });
    return;
  }

  logEvent("info", "owner_reply_sent", {
    ownerId,
    targetUserId,
    replyToMessageId
  });
}

async function routeOwnerCommand(text, env) {
  const ownerId = String(env.OWNER_ID);

  if (text === "/start") {
    await sendMessage(env, ownerId, OWNER_COMMAND_HELP);
    return true;
  }

  if (text === "/status") {
    await sendOwnerStatus(env);
    return true;
  }

  if (text === "/id") {
    await sendMessage(env, ownerId, `你的用户ID是：${ownerId}`);
    return true;
  }

  if (text.startsWith("/baninfo ")) {
    await handleBanInfoCommand(text, env);
    return true;
  }

  if (text.startsWith("/ban ")) {
    await handleBanCommand(text, env);
    return true;
  }

  if (text.startsWith("/unban ")) {
    await handleUnbanCommand(text, env);
    return true;
  }

  return false;
}

async function handleBanInfoCommand(text, env) {
  const ownerId = String(env.OWNER_ID);
  const targetUserId = normalizeUserId(text.slice(9));

  if (!targetUserId) {
    await sendMessage(env, ownerId, "用法：/baninfo 用户ID");
    return;
  }

  const raw = await env.BOT_KV.get(Keys.ban(targetUserId));
  if (!raw) {
    await sendMessage(env, ownerId, "该用户当前未被封禁。");
    return;
  }

  const info = safeJsonParse(raw, null);
  if (!info) {
    await sendMessage(env, ownerId, `用户 ${targetUserId} 已被封禁`);
    return;
  }

  await sendMessage(
    env,
    ownerId,
    `用户 ${targetUserId} 已被封禁\n原因：${info.reason || "未填写"}\n时间：${formatTimestamp(info.at)}`
  );
}

async function handleBanCommand(text, env) {
  const ownerId = String(env.OWNER_ID);
  const rest = text.slice(5).trim();

  if (!rest) {
    await sendMessage(env, ownerId, "用法：/ban 用户ID [理由]");
    return;
  }

  const [rawUserId, ...reasonParts] = rest.split(/\s+/);
  const targetUserId = normalizeUserId(rawUserId);
  const reason = reasonParts.join(" ").trim() || "未填写";

  if (!targetUserId) {
    await sendMessage(env, ownerId, TEXTS.INVALID_USER_ID);
    return;
  }

  if (targetUserId === ownerId) {
    await sendMessage(env, ownerId, TEXTS.OWNER_SELF_BAN);
    return;
  }

  await env.BOT_KV.put(
    Keys.ban(targetUserId),
    JSON.stringify({
      reason,
      by: ownerId,
      at: Date.now()
    }),
    { expirationTtl: CONFIG.BAN_TTL }
  );

  await sendMessage(env, ownerId, `已封禁 ${targetUserId}\n原因：${reason}`);
  logEvent("warn", "user_banned", { ownerId, targetUserId, reason });
}

async function handleUnbanCommand(text, env) {
  const ownerId = String(env.OWNER_ID);
  const targetUserId = normalizeUserId(text.slice(7));

  if (!targetUserId) {
    await sendMessage(env, ownerId, "用法：/unban 用户ID");
    return;
  }

  await env.BOT_KV.delete(Keys.ban(targetUserId));
  await sendMessage(env, ownerId, `已解封 ${targetUserId}`);
  logEvent("info", "user_unbanned", { ownerId, targetUserId });
}

async function sendOwnerStatus(env) {
  const ownerId = String(env.OWNER_ID);

  const [ownerVerified, ownerCooldown, ownerBanned, activeChallengeId, webhookInfo] = await Promise.all([
    env.BOT_KV.get(Keys.verified(ownerId)),
    env.BOT_KV.get(Keys.verifyCooldown(ownerId)),
    env.BOT_KV.get(Keys.ban(ownerId)),
    env.BOT_KV.get(Keys.challengeUser(ownerId)),
    tgCall(env, "getWebhookInfo", {})
  ]);

  const webhookOk = !!webhookInfo?.ok;
  const webhook = webhookOk ? webhookInfo.result || {} : null;
  const webhookStatus = webhookOk ? (webhook.url ? "已设置" : "未设置") : "获取失败";

  const healthSummary =
    webhookOk &&
    webhook?.url &&
    !webhook?.last_error_message &&
    (webhook?.pending_update_count ?? 0) < 10
      ? "正常"
      : "需要检查";

  const lastErrorText =
    webhookOk && (webhook.last_error_message || webhook.last_error_date)
      ? `${webhook.last_error_message || "未知错误"}${webhook.last_error_date ? `\n  时间：${formatUnixSeconds(webhook.last_error_date)}` : ""}`
      : "无";

  const statusText =
    `📊 Bot 状态面板\n` +
    `- 健康状态：${healthSummary}\n\n` +
    `👤 主人信息\n` +
    `- Owner ID：${ownerId}\n` +
    `- Verified：${ownerVerified ? "是" : "否"}\n` +
    `- Cooldown：${ownerCooldown ? "是" : "否"}\n` +
    `- Banned：${ownerBanned ? "是" : "否"}\n` +
    `- Active Challenge：${activeChallengeId ? "有" : "无"}\n\n` +
    `⚙️ 环境状态\n` +
    `- BOT_TOKEN：已设置\n` +
    `- BOT_KV：${env.BOT_KV ? "已绑定" : "未绑定"}\n` +
    `- START_PHOTO_FILE_ID：${env.START_PHOTO_FILE_ID ? "已设置" : "未设置"}\n\n` +
    `🔗 Webhook 状态\n` +
    `- 状态：${webhookStatus}\n` +
    `- 待处理更新：${webhookOk ? webhook.pending_update_count ?? 0 : "未知"}\n` +
    `- 最大连接数：${webhookOk ? webhook.max_connections ?? "未知" : "未知"}\n` +
    `- 最后错误：${lastErrorText}\n\n` +
    `🛡️ 验证配置\n` +
    `- VERIFY_TTL：${formatDuration(CONFIG.VERIFY_TTL)}\n` +
    `- VERIFIED_TTL：${formatDuration(CONFIG.VERIFIED_TTL)}\n` +
    `- VERIFY_FAIL_MAX：${CONFIG.VERIFY_FAIL_MAX}\n` +
    `- VERIFY_COOLDOWN_TTL：${formatDuration(CONFIG.VERIFY_COOLDOWN_TTL)}\n` +
    `- VERIFY_PENDING_MAX：${CONFIG.VERIFY_PENDING_MAX}\n\n` +
    `🚦 限流配置\n` +
    `- 已验证用户：${CONFIG.RATE_LIMIT_VERIFIED_MAX}/${formatDuration(CONFIG.RATE_LIMIT_WINDOW_VERIFIED)}\n` +
    `- 未验证用户：${CONFIG.RATE_LIMIT_UNVERIFIED_MAX}/${formatDuration(CONFIG.RATE_LIMIT_WINDOW_UNVERIFIED)}\n\n` +
    `🗂️ 其他配置\n` +
    `- OWNER_MAP_TTL：${formatDuration(CONFIG.OWNER_MAP_TTL)}\n` +
    `- BAN_TTL：${formatDuration(CONFIG.BAN_TTL)}\n` +
    `- UPDATE_DEDUPE_TTL：${formatDuration(CONFIG.UPDATE_DEDUPE_TTL)}`;

  await sendMessage(env, ownerId, statusText);
}

// =========================
// Telegram UI / Menus
// =========================

async function sendStartPack(userId, env) {
  await sendMessage(env, userId, START_INTRO_TEXT);

  const keyboard = {
    inline_keyboard: [
      [
        { text: "💌 直接留言", callback_data: "menu:message" },
        { text: "❓ 使用帮助", callback_data: "menu:help" }
      ],
      [{ text: "📌 注意事项", callback_data: "menu:rules" }]
    ]
  };

  if (env.START_PHOTO_FILE_ID) {
    await tgCall(env, "sendPhoto", {
      chat_id: userId,
      photo: env.START_PHOTO_FILE_ID,
      caption: "欢迎使用 ✨",
      reply_markup: keyboard
    });
    return;
  }

  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: TEXTS.MENU_PICK,
    reply_markup: keyboard
  });
}

// =========================
// Relay Logic
// =========================

async function forwardUserMessageToOwner(msg, env) {
  const ownerId = String(env.OWNER_ID);
  const userId = String(msg.from.id);
  const name = getDisplayName(msg.from);
  const username = getUsernameText(msg.from);

  if (msg.text) {
    const res = await tgCall(env, "sendMessage", {
      chat_id: ownerId,
      text:
        `📩 收到新私信\n\n` +
        `用户：${name}\n` +
        `用户名：${username}\n` +
        `用户ID：${userId}\n\n` +
        `内容：\n${msg.text}`
    });

    if (res.ok && res.result?.message_id) {
      await bindOwnerMessage(res.result.message_id, userId, env);
    }

    await sendMessage(env, userId, TEXTS.MESSAGE_RECEIVED);

    logEvent("info", "user_text_forwarded", {
      userId,
      ownerId,
      userMessageId: msg.message_id,
      ownerMessageId: res.result?.message_id || null
    });
    return;
  }

  const infoRes = await tgCall(env, "sendMessage", {
    chat_id: ownerId,
    text:
      `📩 收到新私信\n\n` +
      `用户：${name}\n` +
      `用户名：${username}\n` +
      `用户ID：${userId}\n\n` +
      `下面是对方发来的内容，请直接回复这条说明或下面的转发消息。`
  });

  if (infoRes.ok && infoRes.result?.message_id) {
    await bindOwnerMessage(infoRes.result.message_id, userId, env);
  }

  const forwardRes = await tgCall(env, "forwardMessage", {
    chat_id: ownerId,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id
  });

  if (forwardRes.ok && forwardRes.result?.message_id) {
    await bindOwnerMessage(forwardRes.result.message_id, userId, env);
  }

  if (!forwardRes.ok) {
    await sendMessage(env, ownerId, `转发媒体失败：${forwardRes.description || "unknown error"}`);
  }

  await sendMessage(env, userId, TEXTS.MESSAGE_RECEIVED);

  logEvent("info", "user_media_forwarded", {
    userId,
    ownerId,
    userMessageId: msg.message_id,
    ownerInfoMessageId: infoRes.result?.message_id || null,
    ownerForwardedMessageId: forwardRes.result?.message_id || null
  });
}

async function relayOwnerReplyToUser(msg, targetUserId, env) {
  const copyRes = await tgCall(env, "copyMessage", {
    chat_id: targetUserId,
    from_chat_id: String(env.OWNER_ID),
    message_id: msg.message_id
  });

  if (copyRes.ok) return copyRes;

  if (typeof msg.text === "string") {
    return sendMessage(env, targetUserId, msg.text);
  }

  return copyRes;
}

// =========================
// Verification Flow
// =========================

async function sendVerification(
  userId,
  env,
  { pendingMessageId = null, fromUser = null, showWelcomeAfterVerify = false } = {}
) {
  const cooldown = await env.BOT_KV.get(Keys.verifyCooldown(userId));
  if (cooldown) {
    await sendMessage(env, userId, TEXTS.VERIFY_COOLDOWN);
    return;
  }

  const existingChallengeId = await env.BOT_KV.get(Keys.challengeUser(userId));
  if (existingChallengeId) {
    const raw = await env.BOT_KV.get(Keys.challenge(existingChallengeId));

    if (!raw) {
      await env.BOT_KV.delete(Keys.challengeUser(userId));
    } else {
      const state = safeJsonParse(raw, null);
      if (state) {
        let pendingMessageIds = Array.isArray(state.pendingMessageIds) ? state.pendingMessageIds : [];

        if (pendingMessageId) {
          pendingMessageIds.push(pendingMessageId);
        }

        state.pendingMessageIds = [...new Set(pendingMessageIds)].slice(-CONFIG.VERIFY_PENDING_MAX);
        state.showWelcomeAfterVerify = !!state.showWelcomeAfterVerify || !!showWelcomeAfterVerify;

        if (fromUser) {
          state.fromUser = normalizeUserSnapshot(fromUser);
        }

        await saveChallenge(env, existingChallengeId, state);
        return;
      }

      await env.BOT_KV.delete(Keys.challengeUser(userId));
      await env.BOT_KV.delete(Keys.challenge(existingChallengeId));
    }
  }

  const challenge = generateEmojiChallenge();
  const challengeId = crypto.randomUUID();

  const state = {
    userId: String(userId),
    targetEmoji: challenge.targetEmoji,
    buttons: challenge.buttons,
    failCount: 0,
    showWelcomeAfterVerify: !!showWelcomeAfterVerify,
    pendingMessageIds: pendingMessageId ? [pendingMessageId] : [],
    fromUser: normalizeUserSnapshot(fromUser)
  };

  await saveChallenge(env, challengeId, state);

  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: buildVerifyText(state),
    reply_markup: {
      inline_keyboard: buildVerifyKeyboard(state, challengeId)
    }
  });
}

async function handleCallbackQuery(cbq, env) {
  const data = cbq.data || "";
  const userId = String(cbq.from.id);

  if (data.startsWith("verify:") && await isBanned(env, userId)) {
    const challengeId = data.split(":")[1];
    if (challengeId) {
      await clearChallenge(env, challengeId, userId);
    }

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.BANNED,
      show_alert: true
    });
    return;
  }

  if (data === "menu:message") {
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.MENU_MESSAGE
    });
    return;
  }

  if (data === "menu:help") {
    await tgCall(env, "answerCallbackQuery", { callback_query_id: cbq.id });
    await sendMessage(env, cbq.from.id, USER_HELP_TEXT);
    return;
  }

  if (data === "menu:rules") {
    await tgCall(env, "answerCallbackQuery", { callback_query_id: cbq.id });
    await sendMessage(env, cbq.from.id, USER_RULES_TEXT);
    return;
  }

  if (!data.startsWith("verify:")) {
    await tgCall(env, "answerCallbackQuery", { callback_query_id: cbq.id });
    return;
  }

  const parts = data.split(":");
  if (parts.length !== 3) {
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_INVALID,
      show_alert: true
    });
    return;
  }

  const challengeId = parts[1];
  const selectedButtonIndex = Number(parts[2]);
  const raw = await env.BOT_KV.get(Keys.challenge(challengeId));

  if (!raw) {
    await env.BOT_KV.delete(Keys.challengeUser(userId));

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_EXPIRED,
      show_alert: true
    });

    await sendVerification(userId, env, {
      pendingMessageId: null,
      fromUser: cbq.from,
      showWelcomeAfterVerify: false
    });

    logEvent("warn", "verification_expired_resent", { userId, challengeId });
    return;
  }

  const state = safeJsonParse(raw, null);
  if (!state) {
    await clearChallenge(env, challengeId, userId);

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: "验证状态异常，已为你重新发送一题。",
      show_alert: true
    });

    await sendVerification(userId, env, {
      pendingMessageId: null,
      fromUser: cbq.from,
      showWelcomeAfterVerify: false
    });
    return;
  }

  if (String(state.userId) !== userId) {
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_NOT_YOURS,
      show_alert: true
    });
    return;
  }

  if (
    Number.isNaN(selectedButtonIndex) ||
    selectedButtonIndex < 0 ||
    selectedButtonIndex >= state.buttons.length
  ) {
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_INVALID,
      show_alert: true
    });
    return;
  }

  const selectedEmoji = state.buttons[selectedButtonIndex];
  const expectedEmoji = state.targetEmoji;

  if (selectedEmoji === expectedEmoji) {
    await env.BOT_KV.put(Keys.verified(userId), "1", {
      expirationTtl: CONFIG.VERIFIED_TTL
    });

    await clearChallenge(env, challengeId, userId);
    await env.BOT_KV.delete(Keys.verifyCooldown(userId));

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_PASS
    });

    await editMessageTextSafe(env, {
      chat_id: userId,
      message_id: cbq.message?.message_id,
      text: TEXTS.VERIFIED_OK
    });

    await forwardPendingMessagesAfterVerification(state, env);

    if (state.showWelcomeAfterVerify) {
      await sendStartPack(userId, env);
    }

    logEvent("info", "verification_passed", {
      userId,
      showWelcomeAfterVerify: !!state.showWelcomeAfterVerify
    });
    return;
  }

  state.failCount = Number(state.failCount || 0) + 1;

  if (state.failCount >= CONFIG.VERIFY_FAIL_MAX) {
    await clearChallenge(env, challengeId, userId);
    await env.BOT_KV.put(Keys.verifyCooldown(userId), "1", {
      expirationTtl: CONFIG.VERIFY_COOLDOWN_TTL
    });

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_LOCKED,
      show_alert: true
    });

    await editMessageTextSafe(env, {
      chat_id: userId,
      message_id: cbq.message?.message_id,
      text: TEXTS.VERIFY_LOCKED_MESSAGE
    });

    logEvent("warn", "verification_failed_locked", {
      userId,
      failCount: state.failCount
    });
    return;
  }

  const refreshed = generateEmojiChallenge();
  state.targetEmoji = refreshed.targetEmoji;
  state.buttons = refreshed.buttons;

  await saveChallenge(env, challengeId, state);

  await tgCall(env, "answerCallbackQuery", {
    callback_query_id: cbq.id,
    text: `点错了，再试一次（${state.failCount}/${CONFIG.VERIFY_FAIL_MAX}）`,
    show_alert: true
  });

  await editMessageTextSafe(env, {
    chat_id: userId,
    message_id: cbq.message?.message_id,
    text: buildVerifyText(state),
    reply_markup: {
      inline_keyboard: buildVerifyKeyboard(state, challengeId)
    }
  });
}

async function forwardPendingMessagesAfterVerification(state, env) {
  const ownerId = String(env.OWNER_ID);
  const fromUser = state.fromUser;
  const pendingMessageIds = Array.isArray(state.pendingMessageIds) ? state.pendingMessageIds : [];

  if (!fromUser || pendingMessageIds.length === 0) return;

  const userId = String(fromUser.id);
  const name = getDisplayName(fromUser);
  const username = getUsernameText(fromUser);

  const infoRes = await tgCall(env, "sendMessage", {
    chat_id: ownerId,
    text:
      `📩 收到新私信（验证后自动转交）\n\n` +
      `用户：${name}\n` +
      `用户名：${username}\n` +
      `用户ID：${userId}\n\n` +
      `下面是对方刚才发送的消息，请直接回复这条说明或下面的转发消息。`
  });

  if (infoRes.ok && infoRes.result?.message_id) {
    await bindOwnerMessage(infoRes.result.message_id, userId, env);
  }

  let successCount = 0;

  for (const pendingMessageId of pendingMessageIds) {
    const forwardRes = await tgCall(env, "forwardMessage", {
      chat_id: ownerId,
      from_chat_id: userId,
      message_id: pendingMessageId
    });

    if (forwardRes.ok && forwardRes.result?.message_id) {
      await bindOwnerMessage(forwardRes.result.message_id, userId, env);
      successCount += 1;
    }
  }

  if (successCount > 0) {
    await sendMessage(env, userId, "✅ 验证成功，刚才的消息已转交。");
  }

  logEvent("info", "pending_messages_forwarded_after_verify", {
    userId,
    count: successCount
  });
}

function generateEmojiChallenge() {
  const pool = [
    "🐱", "🐶", "🐼", "🦊", "🐸", "🐵",
    "🍎", "🍌", "🍇", "🍓", "🍉", "🥝",
    "⭐", "🌙", "☀️", "⚡", "🔥", "❄️",
    "🚗", "🚲", "✈️", "🚀", "🎈", "🎁"
  ];

  const buttons = shuffle(pool).slice(0, 4);
  const targetEmoji = buttons[randInt(0, buttons.length - 1)];

  return { targetEmoji, buttons };
}

function buildVerifyText(state) {
  return (
    `🛡️ 人机验证\n\n` +
    `请点击下面的表情：\n${state.targetEmoji}`
  );
}

function buildVerifyKeyboard(state, challengeId) {
  return chunk(
    state.buttons.map((emoji, idx) => ({
      text: emoji,
      callback_data: `verify:${challengeId}:${idx}`
    })),
    2
  );
}

async function saveChallenge(env, challengeId, state) {
  await env.BOT_KV.put(Keys.challenge(challengeId), JSON.stringify(state), {
    expirationTtl: CONFIG.VERIFY_TTL
  });

  await env.BOT_KV.put(Keys.challengeUser(state.userId), challengeId, {
    expirationTtl: CONFIG.VERIFY_TTL
  });
}

async function clearChallenge(env, challengeId, userId) {
  await env.BOT_KV.delete(Keys.challenge(challengeId));
  await env.BOT_KV.delete(Keys.challengeUser(userId));
}

// =========================
// KV / State Helpers
// =========================

async function bindOwnerMessage(ownerMessageId, userId, env) {
  await env.BOT_KV.put(Keys.ownerMsg(ownerMessageId), String(userId), {
    expirationTtl: CONFIG.OWNER_MAP_TTL
  });
}

async function isBanned(env, userId) {
  return !!(await env.BOT_KV.get(Keys.ban(userId)));
}

async function isVerified(env, userId) {
  return !!(await env.BOT_KV.get(Keys.verified(userId)));
}

async function dedupeUpdate(update, env) {
  const updateId = update?.update_id;
  if (typeof updateId !== "number") return false;

  const key = Keys.update(updateId);
  const exists = await env.BOT_KV.get(key);

  if (exists) {
    logEvent("info", "update_deduped", { updateId });
    return true;
  }

  await env.BOT_KV.put(key, "1", {
    expirationTtl: CONFIG.UPDATE_DEDUPE_TTL
  });

  return false;
}

async function checkRateLimit(env, userId, isVerifiedUser) {
  const key = isVerifiedUser ? Keys.rateVerified(userId) : Keys.rateUnverified(userId);
  const limit = isVerifiedUser ? CONFIG.RATE_LIMIT_VERIFIED_MAX : CONFIG.RATE_LIMIT_UNVERIFIED_MAX;
  const window = isVerifiedUser ? CONFIG.RATE_LIMIT_WINDOW_VERIFIED : CONFIG.RATE_LIMIT_WINDOW_UNVERIFIED;

  const current = parseInt((await env.BOT_KV.get(key)) || "0", 10);
  if (current >= limit) return false;

  await env.BOT_KV.put(key, String(current + 1), {
    expirationTtl: window
  });

  return true;
}

// =========================
// Telegram API Helpers
// =========================

async function sendMessage(env, chatId, text, extra = {}) {
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function editMessageTextSafe(env, body) {
  if (!body?.chat_id || !body?.message_id) return;

  const res = await tgCall(env, "editMessageText", body);
  if (!res.ok) {
    const desc = res.description || "";
    if (!desc.includes("message is not modified")) {
      logEvent("warn", "edit_message_failed", {
        chatId: body.chat_id,
        messageId: body.message_id,
        description: desc
      });
    }
  }
}

async function tgCall(env, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await resp.json();
  } catch {
    data = { ok: false, description: "invalid telegram response" };
  }

  if (!data.ok) {
    logEvent("warn", "telegram_api_error", {
      method,
      description: data.description || null,
      error_code: data.error_code || null
    });
  }

  return data;
}

// =========================
// Generic Utilities
// =========================

function getMissingEnv(env) {
  if (!env.BOT_TOKEN) return "BOT_TOKEN";
  if (!env.OWNER_ID) return "OWNER_ID";
  if (!env.BOT_KV) return "BOT_KV";
  return "";
}

function logEvent(level, action, data = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    action,
    ...data
  };

  const line = JSON.stringify(payload);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeUserId(value) {
  return /^\d+$/.test(String(value || "").trim()) ? String(value).trim() : "";
}

function normalizeUserSnapshot(fromUser) {
  if (!fromUser?.id) return null;

  return {
    id: fromUser.id,
    first_name: fromUser.first_name || "",
    last_name: fromUser.last_name || "",
    username: fromUser.username || ""
  };
}

function getDisplayName(user) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Unknown";
}

function getUsernameText(user) {
  return user?.username ? `@${user.username}` : "无用户名";
}

function formatTimestamp(ts) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

function formatDuration(seconds) {
  const s = Number(seconds || 0);

  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  return `${days}d ${hours}h`;
}

function formatUnixSeconds(sec) {
  if (!sec) return "无";
  return formatTimestamp(sec * 1000);
}

function randInt(min, max) {
  const range = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % range);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
