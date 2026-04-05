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
    if (!contentType.toLowerCase().includes("application/json")) {
      return new Response("Unsupported Media Type", { status: 415 });
    }

    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        return new Response("Bad Request", { status: 400 });
      }

      if (contentLength > CONFIG.MAX_WEBHOOK_BODY_BYTES) {
        logEvent("warn", "webhook_body_too_large", { contentLength });
        return new Response("Payload Too Large", { status: 413 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (!isPlainObject(update)) {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await processUpdate(update, env);
      return new Response("OK");
    } catch (error) {
      logEvent("error", "worker_error", {
        updateId: getUpdateId(update),
        error: error?.message || String(error)
      });

      return new Response("Internal Server Error", { status: 500 });
    }
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
  MAX_WEBHOOK_BODY_BYTES: 256 * 1024,
  TELEGRAM_MAX_ATTEMPTS: 3,
  TELEGRAM_REQUEST_TIMEOUT_MS: 8000,
  TELEGRAM_RETRY_BASE_MS: 300,
  TELEGRAM_RETRY_MAX_MS: 1500
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
  VERIFY_ALREADY_SENT: "验证题已发送，请先完成验证。",
  VERIFY_STATE_RESET: "验证状态异常，已为你重新发送一题。",
  BANNED: "你已被封禁。",
  MESSAGE_RECEIVED: "已收到，消息已转交。",
  DIRECT_REPLY_HINT: "请直接回复我转给你的那条消息，这样我才能知道你要回给谁。",
  MAPPING_EXPIRED: "这条消息没有找到对应用户，可能映射已过期。请等对方重新发消息后再回复。",
  TARGET_BANNED: "该用户已被封禁，无法发送。",
  MENU_MESSAGE: "直接发送消息给我就可以啦 ✨",
  MENU_PICK: "请选择你想查看的内容：",
  OWNER_SELF_BAN: "不能封禁自己。",
  INVALID_USER_ID: "用户ID格式无效。",
  MESSAGE_TRANSFER_FAILED: "消息转交失败，请稍后重试。",
  MESSAGE_TRANSFER_PARTIAL: "已收到，但转交可能不完整，请稍后重试或重新发送。",
  UNKNOWN_COMMAND: "未知命令，请发送 /start 查看可用命令。"
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
  const updateId = getUpdateId(update);
  if (updateId !== null && await isDuplicateUpdate(updateId, env)) {
    logEvent("info", "update_deduped", { updateId });
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
  } else {
    const msg = update.message;
    if (msg && msg.chat?.type === "private" && msg.from?.id) {
      const fromId = String(msg.from.id);
      if (fromId === String(env.OWNER_ID)) {
        await handleOwnerMessage(msg, env);
      } else {
        await handleUserMessage(msg, env);
      }
    }
  }

  if (updateId !== null) {
    await markUpdateProcessed(updateId, env);
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

  const text = typeof msg.text === "string" ? msg.text.trim() : "";
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

  if (text === "/baninfo") {
    await sendMessage(env, ownerId, "用法：/baninfo 用户ID");
    return true;
  }

  if (text.startsWith("/baninfo ")) {
    await handleBanInfoCommand(text, env);
    return true;
  }

  if (text === "/ban") {
    await sendMessage(env, ownerId, "用法：/ban 用户ID [理由]");
    return true;
  }

  if (text.startsWith("/ban ")) {
    await handleBanCommand(text, env);
    return true;
  }

  if (text === "/unban") {
    await sendMessage(env, ownerId, "用法：/unban 用户ID");
    return true;
  }

  if (text.startsWith("/unban ")) {
    await handleUnbanCommand(text, env);
    return true;
  }

  if (text.startsWith("/")) {
    await sendMessage(env, ownerId, TEXTS.UNKNOWN_COMMAND);
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

  const activeChallengeId = await env.BOT_KV.get(Keys.challengeUser(targetUserId));
  if (activeChallengeId) {
    await clearChallenge(env, activeChallengeId, targetUserId);
  }

  await Promise.all([
    env.BOT_KV.delete(Keys.verified(targetUserId)),
    env.BOT_KV.delete(Keys.verifyCooldown(targetUserId)),
    env.BOT_KV.delete(Keys.rateVerified(targetUserId)),
    env.BOT_KV.delete(Keys.rateUnverified(targetUserId))
  ]);

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

  const [ownerBanned, webhookInfo] = await Promise.all([
    env.BOT_KV.get(Keys.ban(ownerId)),
    tgCall(env, "getWebhookInfo", {})
  ]);

  const webhookOk = !!webhookInfo?.ok;
  const webhook = webhookOk ? webhookInfo.result || {} : null;

  const healthSummary =
    webhookOk &&
    webhook?.url &&
    !webhook?.last_error_message &&
    (webhook?.pending_update_count ?? 0) < 10
      ? "正常"
      : "需要检查";

  const webhookStatus = webhookOk
    ? (webhook.url ? "已设置" : "未设置")
    : "获取失败";

  const lastErrorText = webhook?.last_error_message || "无";

  const statusText =
    `📊 Bot 状态\n\n` +
    `- 健康状态：${healthSummary}\n` +
    `- Webhook：${webhookStatus}\n` +
    `- 待处理更新：${webhookOk ? webhook.pending_update_count ?? 0 : "未知"}\n` +
    `- 最后错误：${lastErrorText}\n\n` +
    `👤 主人\n` +
    `- Owner ID：${ownerId}\n` +
    `- 封禁状态：${ownerBanned ? "是" : "否"}\n\n` +
    `⚙️ 环境\n` +
    `- BOT_KV：${env.BOT_KV ? "已绑定" : "未绑定"}\n` +
    `- START_PHOTO_FILE_ID：${env.START_PHOTO_FILE_ID ? "已设置" : "未设置"}\n\n` +
    `🛡️ 验证\n` +
    `- 冷却时间：${CONFIG.VERIFY_COOLDOWN_TTL}s\n` +
    `- 失败上限：${CONFIG.VERIFY_FAIL_MAX}\n\n` +
    `🚦 限流\n` +
    `- 已验证：${CONFIG.RATE_LIMIT_VERIFIED_MAX}/${CONFIG.RATE_LIMIT_WINDOW_VERIFIED}s\n` +
    `- 未验证：${CONFIG.RATE_LIMIT_UNVERIFIED_MAX}/${CONFIG.RATE_LIMIT_WINDOW_UNVERIFIED}s`;

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
    const photoRes = await tgCall(env, "sendPhoto", {
      chat_id: userId,
      photo: env.START_PHOTO_FILE_ID,
      caption: "欢迎使用 ✨",
      reply_markup: keyboard
    });

    if (photoRes.ok) {
      return;
    }

    logEvent("warn", "start_photo_failed_fallback_to_text", {
      userId,
      description: photoRes.description || null
    });
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

  const textOrCaption = getMessageTextOrCaption(msg);
  const hasRichEntities = hasMessageEntities(msg);
  const isPureTextMessage = typeof msg.text === "string" && msg.text.length > 0;
  const preview = textOrCaption ? buildTextPreview(textOrCaption, 3000) : "";
  const previewSuffix = textOrCaption && preview !== textOrCaption ? "\n\n（内容过长，已截断预览）" : "";

  const infoText =
    `📩 收到新私信\n\n` +
    `用户：${name}\n` +
    `用户名：${username}\n` +
    `用户ID：${userId}` +
    (preview
      ? `\n\n内容预览：\n${preview}${previewSuffix}`
      : `\n\n下面是对方发来的内容，请直接回复这条说明或下面的转发消息。`);

  const infoRes = await tgCall(env, "sendMessage", {
    chat_id: ownerId,
    text: infoText
  });

  if (infoRes.ok && infoRes.result?.message_id) {
    await bindOwnerMessage(infoRes.result.message_id, userId, env);
  }

  let forwardRes = { ok: false, description: "not_needed" };
  const shouldForwardOriginal =
    !isPureTextMessage ||
    textOrCaption.length > 3000 ||
    hasRichEntities;

  if (shouldForwardOriginal) {
    forwardRes = await tgCall(env, "forwardMessage", {
      chat_id: ownerId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });

    if (forwardRes.ok && forwardRes.result?.message_id) {
      await bindOwnerMessage(forwardRes.result.message_id, userId, env);
    }
  }

  const delivered = isPureTextMessage ? (infoRes.ok || forwardRes.ok) : forwardRes.ok;

  if (delivered) {
    await sendMessage(env, userId, TEXTS.MESSAGE_RECEIVED);
  } else {
    await sendMessage(env, userId, TEXTS.MESSAGE_TRANSFER_FAILED);
  }

  if (!forwardRes.ok && shouldForwardOriginal) {
    await sendMessage(
      env,
      ownerId,
      `转发原始消息失败：${forwardRes.description || "unknown error"}`
    );
  }

  logEvent("info", isPureTextMessage ? "user_text_forwarded" : "user_media_forwarded", {
    userId,
    ownerId,
    userMessageId: msg.message_id,
    ownerInfoMessageId: infoRes.result?.message_id || null,
    ownerForwardedMessageId: forwardRes.result?.message_id || null,
    delivered
  });
}

async function relayOwnerReplyToUser(msg, targetUserId, env) {
  const copyRes = await tgCall(env, "copyMessage", {
    chat_id: targetUserId,
    from_chat_id: String(env.OWNER_ID),
    message_id: msg.message_id
  });

  if (copyRes.ok) return copyRes;

  if (typeof msg.text === "string" && msg.text.length > 0) {
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
    const existingState = sanitizeChallengeState(safeJsonParse(raw, null));

    if (existingState) {
      if (pendingMessageId) {
        existingState.pendingMessageIds = appendPendingMessageId(
          existingState.pendingMessageIds,
          pendingMessageId
        );
      }

      existingState.showWelcomeAfterVerify =
        !!existingState.showWelcomeAfterVerify || !!showWelcomeAfterVerify;

      if (fromUser) {
        existingState.fromUser = normalizeUserSnapshot(fromUser);
      }

      await saveChallenge(env, existingChallengeId, existingState);
      await sendMessage(
        env,
        userId,
        `${TEXTS.VERIFY_ALREADY_SENT}\n\n请点击下面的表情：\n${existingState.targetEmoji}`,
        {
          reply_markup: {
            inline_keyboard: buildVerifyKeyboard(existingState, existingChallengeId)
          }
        }
      );
      return;
    }

    await clearChallenge(env, existingChallengeId, userId);
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

  const promptRes = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: buildVerifyText(state),
    reply_markup: {
      inline_keyboard: buildVerifyKeyboard(state, challengeId)
    }
  });

  if (!promptRes.ok) {
    await clearChallenge(env, challengeId, userId);
    logEvent("warn", "verification_prompt_send_failed", {
      userId,
      challengeId,
      description: promptRes.description || null
    });
  }
}

async function handleCallbackQuery(cbq, env) {
  const data = typeof cbq.data === "string" ? cbq.data : "";
  const userId = String(cbq.from?.id || "");

  if (!userId) {
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_INVALID,
      show_alert: true
    });
    return;
  }

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

  const state = sanitizeChallengeState(safeJsonParse(raw, null));
  if (!state) {
    await clearChallenge(env, challengeId, userId);

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: cbq.id,
      text: TEXTS.VERIFY_STATE_RESET,
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
    !Number.isInteger(selectedButtonIndex) ||
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
  const fromUser = normalizeUserSnapshot(state.fromUser);
  const pendingMessageIds = normalizePendingMessageIds(state.pendingMessageIds);

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
  } else {
    await sendMessage(env, userId, TEXTS.MESSAGE_TRANSFER_PARTIAL);
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

async function isDuplicateUpdate(updateId, env) {
  return !!(await env.BOT_KV.get(Keys.update(updateId)));
}

async function markUpdateProcessed(updateId, env) {
  await env.BOT_KV.put(Keys.update(updateId), "1", {
    expirationTtl: CONFIG.UPDATE_DEDUPE_TTL
  });
}

async function checkRateLimit(env, userId, isVerifiedUser) {
  const key = isVerifiedUser ? Keys.rateVerified(userId) : Keys.rateUnverified(userId);
  const limit = isVerifiedUser ? CONFIG.RATE_LIMIT_VERIFIED_MAX : CONFIG.RATE_LIMIT_UNVERIFIED_MAX;
  const window = isVerifiedUser ? CONFIG.RATE_LIMIT_WINDOW_VERIFIED : CONFIG.RATE_LIMIT_WINDOW_UNVERIFIED;

  const current = toSafeInteger(await env.BOT_KV.get(key), 0);
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
  if (!text) {
    return { ok: false, description: "empty text" };
  }

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
  let lastResult = null;

  for (let attempt = 1; attempt <= CONFIG.TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    let resp;
    let result;

    try {
      resp = await withTimeout(
        fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }),
        CONFIG.TELEGRAM_REQUEST_TIMEOUT_MS,
        `telegram request timeout: ${method}`
      );
    } catch (error) {
      result = {
        ok: false,
        description: error?.message || "telegram fetch failed"
      };

      logEvent("warn", "telegram_api_error", {
        method,
        attempt,
        description: result.description,
        error_code: null
      });

      if (attempt < CONFIG.TELEGRAM_MAX_ATTEMPTS) {
        await sleep(getRetryDelayMs(null, attempt));
        continue;
      }

      return result;
    }

    try {
      result = await resp.json();
    } catch {
      result = {
        ok: false,
        description: `invalid telegram response (http ${resp.status})`
      };
    }

    if (result.ok) {
      return result;
    }

    lastResult = result;

    logEvent("warn", "telegram_api_error", {
      method,
      attempt,
      description: result.description || null,
      error_code: result.error_code || resp.status || null
    });

    if (!shouldRetryTelegram(resp.status, result, attempt)) {
      return result;
    }

    await sleep(getRetryDelayMs(result, attempt));
  }

  return lastResult || { ok: false, description: "telegram call failed" };
}

function shouldRetryTelegram(status, result, attempt) {
  if (attempt >= CONFIG.TELEGRAM_MAX_ATTEMPTS) return false;
  if (status >= 500) return true;
  if (result?.error_code === 429) return true;
  return false;
}

function getRetryDelayMs(result, attempt) {
  const retryAfterSeconds = Number(result?.parameters?.retry_after || 0);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return clamp(retryAfterSeconds * 1000, CONFIG.TELEGRAM_RETRY_BASE_MS, CONFIG.TELEGRAM_RETRY_MAX_MS);
  }

  const delay = CONFIG.TELEGRAM_RETRY_BASE_MS * attempt;
  return clamp(delay, CONFIG.TELEGRAM_RETRY_BASE_MS, CONFIG.TELEGRAM_RETRY_MAX_MS);
}

// =========================
// Generic Utilities
// =========================

function getMissingEnv(env) {
  if (!env?.BOT_TOKEN) return "BOT_TOKEN";
  if (!env?.OWNER_ID) return "OWNER_ID";
  if (!env?.BOT_KV || typeof env.BOT_KV.get !== "function" || typeof env.BOT_KV.put !== "function" || typeof env.BOT_KV.delete !== "function") {
    return "BOT_KV";
  }
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

  const normalizedId = normalizeUserId(fromUser.id);
  if (!normalizedId) return null;

  return {
    id: normalizedId,
    first_name: typeof fromUser.first_name === "string" ? fromUser.first_name : "",
    last_name: typeof fromUser.last_name === "string" ? fromUser.last_name : "",
    username: typeof fromUser.username === "string" ? fromUser.username : ""
  };
}

function getDisplayName(user) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Unknown";
}

function getUsernameText(user) {
  return user?.username ? `@${user.username}` : "无用户名";
}

function buildTextPreview(text, maxLength = 3000) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function getMessageTextOrCaption(msg) {
  if (typeof msg?.text === "string") return msg.text;
  if (typeof msg?.caption === "string") return msg.caption;
  return "";
}

function hasMessageEntities(msg) {
  return (
    (Array.isArray(msg?.entities) && msg.entities.length > 0) ||
    (Array.isArray(msg?.caption_entities) && msg.caption_entities.length > 0)
  );
}

function sanitizeChallengeState(rawState) {
  if (!isPlainObject(rawState)) return null;

  const userId = normalizeUserId(rawState.userId);
  const targetEmoji = typeof rawState.targetEmoji === "string" ? rawState.targetEmoji : "";
  const buttons = Array.isArray(rawState.buttons)
    ? rawState.buttons.filter((item) => typeof item === "string" && item)
    : [];

  if (!userId) return null;
  if (buttons.length !== 4) return null;
  if (new Set(buttons).size !== 4) return null;
  if (!buttons.includes(targetEmoji)) return null;

  return {
    userId,
    targetEmoji,
    buttons,
    failCount: clamp(toSafeInteger(rawState.failCount, 0), 0, CONFIG.VERIFY_FAIL_MAX - 1),
    showWelcomeAfterVerify: !!rawState.showWelcomeAfterVerify,
    pendingMessageIds: normalizePendingMessageIds(rawState.pendingMessageIds),
    fromUser: normalizeUserSnapshot(rawState.fromUser)
  };
}

function appendPendingMessageId(existingIds, pendingMessageId) {
  const ids = normalizePendingMessageIds(existingIds);
  const normalized = normalizeSingleMessageId(pendingMessageId);
  if (normalized === null) return ids;
  ids.push(normalized);
  return [...new Set(ids)].slice(-CONFIG.VERIFY_PENDING_MAX);
}

function normalizePendingMessageIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const normalized = normalizeSingleMessageId(item);
    if (normalized !== null) out.push(normalized);
  }
  return [...new Set(out)].slice(-CONFIG.VERIFY_PENDING_MAX);
}

function normalizeSingleMessageId(value) {
  if (!Number.isInteger(value)) {
    if (!/^-?\d+$/.test(String(value ?? "").trim())) {
      return null;
    }
    value = Number(value);
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function formatTimestamp(ts) {
  const millis = Number(ts);
  if (!Number.isFinite(millis) || millis <= 0) {
    return "无";
  }

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
    }).format(new Date(millis));
  } catch {
    return new Date(millis).toISOString();
  }
}

function getUpdateId(update) {
  return Number.isInteger(update?.update_id) ? update.update_id : null;
}

function randInt(min, max) {
  const range = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % range);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
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

function toSafeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timerId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}
