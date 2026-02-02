import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type {
  FeishuConfig,
  FeishuMessageContext,
  FeishuMediaInfo,
  FeishuHistoryMessage,
} from "./types.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getMessageFeishu, listMessagesFeishu } from "./send.js";
import { downloadImageFeishu, downloadMessageResourceFeishu } from "./media.js";
import {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
} from "./mention.js";

// --- Chat history request patterns ---
const HISTORY_REQUEST_PATTERNS = [
  /读取.*历史/i,
  /获取.*历史/i,
  /查看.*历史/i,
  /聊天记录/i,
  /历史消息/i,
  /历史记录/i,
  /chat\s*history/i,
  /message\s*history/i,
  /fetch.*history/i,
  /get.*history/i,
  /总结.*聊天/i,
  /聊天.*总结/i,
  /summarize.*chat/i,
  /chat.*summary/i,
];

/**
 * Check if user message is requesting chat history
 */
export function isHistoryRequest(content: string): boolean {
  const normalizedContent = content.toLowerCase().trim();
  return HISTORY_REQUEST_PATTERNS.some((pattern) => pattern.test(normalizedContent));
}

/**
 * Extract requested message count from user message
 * Returns default of 200 if not specified
 */
function extractHistoryCount(content: string): number {
  const patterns = [
    /最近\s*(\d+)\s*条/,
    /(\d+)\s*条消息/,
    /(\d+)\s*条记录/,
    /last\s*(\d+)/i,
    /(\d+)\s*messages/i,
    /获取\s*(\d+)/,
    /读取\s*(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num <= 1000) {
        return num;
      }
    }
  }

  return 200; // Default
}

export type ChatHistoryResult = {
  messages: FeishuHistoryMessage[];
  total: number;
  formatted: string;
};

/**
 * Fetch chat history and format it for agent context
 */
export async function fetchChatHistoryForAgent(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  requestContent: string;
  runtime?: RuntimeEnv;
}): Promise<ChatHistoryResult> {
  const { cfg, chatId, requestContent, runtime } = params;
  const log = runtime?.log ?? console.log;

  const count = extractHistoryCount(requestContent);
  log(`feishu: fetching ${count} messages from chat ${chatId}`);

  const result = await listMessagesFeishu({
    cfg,
    chatId,
    count,
    sortType: "ByCreateTimeDesc",
  });

  // Format messages for agent (reverse to chronological order)
  const chronologicalMessages = [...result.messages].reverse();

  const formatted = chronologicalMessages
    .filter((msg) => !msg.deleted && msg.content.trim())
    .map((msg) => {
      const time = new Date(msg.createTime).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const sender = msg.senderType === "app" ? "[Bot]" : msg.senderId;
      return `[${time}] ${sender}: ${msg.content}`;
    })
    .join("\n");

  log(`feishu: fetched ${result.total} messages, formatted ${chronologicalMessages.length} for agent`);

  return {
    messages: result.messages,
    total: result.total,
    formatted,
  };
}

// --- Helper: Generate Feishu image URL for model access ---
// Feishu images can be accessed via URL: https://{domain}/im/v1/images/{imageKey}
// This allows downstream models to fetch and process the image content.
function getFeishuImageUrl(params: {
  imageKey: string;
  domain?: string;
  tenantKey?: string;
}): string {
  const { imageKey, domain = "feishu", tenantKey } = params;
  const baseUrl = domain === "lark" ? "https://lark.im" : "https://feishu.cn";
  const url = new URL(`${baseUrl}/im/v1/images/${imageKey}`);
  if (tenantKey) {
    url.searchParams.set("tenant_key", tenantKey);
  }
  return url.toString();
}

// --- Message deduplication ---
const processedMessages = new Map<string, number>(); // messageId -> timestamp
const MESSAGE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodically clean up expired message IDs (every hour)
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > MESSAGE_EXPIRY_MS) {
      processedMessages.delete(id);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`feishu: cleaned ${cleanedCount} expired message IDs, remaining: ${processedMessages.size}`);
  }
}, 60 * 60 * 1000); // Clean every hour

// --- Permission error extraction ---
// Extract permission grant URL from Feishu API error response.
type PermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;

  // Axios error structure: err.response.data contains the Feishu error
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code: 99991672
  if (feishuErr.code !== 99991672) return null;

  // Extract the grant URL from the error message (contains the direct link)
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/open\.feishu\.cn\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0];

  return {
    code: feishuErr.code,
    message: msg,
    grantUrl,
  };
}

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by open_id to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type SenderNameResult = {
  name?: string;
  permissionError?: PermissionError;
};

async function resolveFeishuSenderName(params: {
  feishuCfg?: FeishuConfig;
  senderOpenId: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { feishuCfg, senderOpenId, log } = params;
  if (!feishuCfg) return {};
  if (!senderOpenId) return {};

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };

  try {
    const client = createFeishuClient(feishuCfg);

    // contact/v3/users/:user_id?user_id_type=open_id
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }

    return {};
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }

    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${senderOpenId}: ${String(err)}`);
    return {};
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "post") {
      // Extract text content from rich text post
      const { textContent } = parsePostContent(content);
      return textContent;
    }
    return content;
  } catch {
    return content;
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) return false;
  if (!botOpenId) return mentions.length > 0;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(text: string, mentions?: FeishuMessageEvent["message"]["mentions"]): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(`@${mention.name}\\s*`, "g"), "").trim();
    result = result.replace(new RegExp(mention.key, "g"), "").trim();
  }
  return result;
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key };
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "audio":
        return { fileKey: parsed.file_key };
      case "video":
      case "media":
        // Video/media has both file_key (video) and image_key (thumbnail)
        return { fileKey: parsed.file_key, imageKey: parsed.image_key, fileName: parsed.file_name };
      case "sticker":
        return { fileKey: parsed.file_key };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Parse post (rich text) content and extract embedded image keys.
 * Post structure: { title?: string, content: [[{ tag, text?, image_key?, ... }]] }
 */
function parsePostContent(content: string): {
  textContent: string;
  imageKeys: string[];
} {
  try {
    const parsed = JSON.parse(content);
    const title = parsed.title || "";
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") {
            textContent += element.text || "";
          } else if (element.tag === "a") {
            // Link: show text or href
            textContent += element.text || element.href || "";
          } else if (element.tag === "at") {
            // Mention: @username
            textContent += `@${element.user_name || element.user_id || ""}`;
          } else if (element.tag === "img" && element.image_key) {
            // Embedded image
            imageKeys.push(element.image_key);
          }
        }
        textContent += "\n";
      }
    }

    return {
      textContent: textContent.trim() || "[富文本消息]",
      imageKeys,
    };
  } catch {
    return { textContent: "[富文本消息]", imageKeys: [] };
  }
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
    case "media":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Get Feishu config for domain
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const domain = feishuCfg?.domain ?? "feishu";

  // Handle post (rich text) messages with embedded images
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    if (imageKeys.length === 0) {
      return [];
    }

    log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        // Generate accessible URL for downstream models
        const imageUrl = getFeishuImageUrl({ imageKey, domain });

        out.push({
          path: saved.path,
          url: imageUrl,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}, URL: ${imageUrl}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    // For video/media messages, prefer file_key (actual video) over image_key (thumbnail)
    const isVideoType = messageType === "video" || messageType === "media";
    const fileKey = isVideoType 
      ? (mediaKeys.fileKey || mediaKeys.imageKey)
      : (mediaKeys.imageKey || mediaKeys.fileKey);
    if (!fileKey) {
      return [];
    }

    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    // Generate accessible URL for downstream models (only for images)
    let imageUrl: string | undefined;
    if (messageType === "image" && mediaKeys.imageKey) {
      imageUrl = getFeishuImageUrl({ imageKey: mediaKeys.imageKey, domain });
    }

    out.push({
      path: saved.path,
      url: imageUrl,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}${imageUrl ? `, URL: ${imageUrl}` : ""}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 *
 * IMPORTANT: We prioritize URL over local path so downstream models (like minimax)
 * can access the image content. Local paths are only kept for debugging/cleanup.
 */
function buildFeishuMediaPayload(
  mediaList: FeishuMediaInfo[],
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaUrls = mediaList.map((media) => media.url ?? media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.url ?? first?.path, // Prioritize URL for model access
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined, // Prioritize URLs
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);

  // Extract image_key if this is an image message
  let imageKey: string | undefined;
  if (event.message.message_type === "image") {
    try {
      const parsed = JSON.parse(event.message.content);
      imageKey = parsed.image_key;
    } catch {
      // Ignore parse errors
    }
  }

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || "",
    senderOpenId: event.sender.sender_id.open_id || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    content,
    contentType: event.message.message_type,
    imageKey,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
      // Extract message body (remove all @ placeholders)
      const allMentionKeys = (event.message.mentions ?? []).map((m) => m.key);
      ctx.mentionMessageBody = extractMessageBody(content, allMentionKeys);
    }
  }

  return ctx;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, event, botOpenId, runtime, chatHistories } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Deduplication: skip if already processed
  const messageId = event.message.message_id;
  if (processedMessages.has(messageId)) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }
  processedMessages.set(messageId, Date.now());

  let ctx = parseFeishuMessageEvent(event, botOpenId);
  const isGroup = ctx.chatType === "group";

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  const senderResult = await resolveFeishuSenderName({
    feishuCfg,
    senderOpenId: ctx.senderOpenId,
    log,
  });
  if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };

  // Track permission error to inform agent later (with cooldown to avoid repetition)
  let permissionErrorForAgent: PermissionError | undefined;
  if (senderResult.permissionError) {
    const appKey = feishuCfg?.appId ?? "default";
    const now = Date.now();
    const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

    if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
      permissionErrorNotifiedAt.set(appKey, now);
      permissionErrorForAgent = senderResult.permissionError;
    }
  }

  log(`feishu: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`);

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  if (isGroup) {
    const groupPolicy = feishuCfg?.groupPolicy ?? "open";
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(`feishu: group ${ctx.chatId} not in allowlist`);
      return;
    }

    // Additional sender-level allowlist check if group has specific allowFrom config
    const senderAllowFrom = groupConfig?.allowFrom ?? [];
    if (senderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: senderAllowFrom,
        senderId: ctx.senderOpenId,
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }

    const { requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    });

    if (requireMention && !ctx.mentionedBot) {
      log(`feishu: message in group ${ctx.chatId} did not mention bot, recording to history`);
      if (chatHistories) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.chatId,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  } else {
    const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
    const allowFrom = feishuCfg?.allowFrom ?? [];

    if (dmPolicy === "allowlist") {
      const match = resolveFeishuAllowlistMatch({
        allowFrom,
        senderId: ctx.senderOpenId,
      });
      if (!match.allowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in DM allowlist`);
        return;
      }
    }
  }

  try {
    const core = getFeishuRuntime();

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.chatId : ctx.senderOpenId,
      },
    });

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu message in group ${ctx.chatId}`
      : `Feishu DM from ${ctx.senderOpenId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
    });

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    let mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
    });

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    let quotedImageKey: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({ cfg, messageId: ctx.parentId });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(`feishu: fetched quoted message: ${quotedContent?.slice(0, 100)}`);

          // Extract image_key from quoted message if it's an image
          if (quotedMsg.contentType === "image") {
            try {
              const parsed = JSON.parse(quotedMsg.content);
              quotedImageKey = parsed.image_key;
            } catch {
              // Ignore parse errors
            }
          }

          // Resolve media from quoted message and merge with main media list
          const quotedMediaList = await resolveFeishuMediaList({
            cfg,
            messageId: quotedMsg.messageId,
            messageType: quotedMsg.contentType,
            content: quotedMsg.content,
            maxBytes: mediaMaxBytes,
            log,
          });
          mediaList = [...mediaList, ...quotedMediaList];
          log(`feishu: resolved ${quotedMediaList.length} media items from quoted message`);
        }
      } catch (err) {
        log(`feishu: failed to fetch quoted message: ${String(err)}`);
      }
    }

    // Download images for AI vision support
    const attachments: Array<{ type: "image"; data: Buffer; mimeType: string }> = [];

    // Download current message image if present
    if (ctx.imageKey) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId: ctx.messageId,
          fileKey: ctx.imageKey,
          type: "image",
        });

        let mimeType = result.contentType || "image/jpeg";
        if (!result.contentType) {
          mimeType = await core.media.detectMime({ buffer: result.buffer });
        }

        attachments.push({
          type: "image",
          data: result.buffer,
          mimeType,
        });

        log(`feishu: downloaded image for AI: ${ctx.imageKey}, size: ${result.buffer.length} bytes, mimeType: ${mimeType}`);
      } catch (err: any) {
        log(`feishu: failed to download image for AI: ${err.message || String(err)}`);
      }
    }

    // Download quoted message image if present
    if (quotedImageKey && ctx.parentId) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId: ctx.parentId,
          fileKey: quotedImageKey,
          type: "image",
        });

        let mimeType = result.contentType || "image/jpeg";
        if (!result.contentType) {
          mimeType = await core.media.detectMime({ buffer: result.buffer });
        }

        attachments.push({
          type: "image",
          data: result.buffer,
          mimeType,
        });

        log(`feishu: downloaded quoted image for AI: ${quotedImageKey}, size: ${result.buffer.length} bytes, mimeType: ${mimeType}`);
      } catch (err: any) {
        log(`feishu: failed to download quoted image for AI: ${err.message || String(err)}`);
      }
    }

    const mediaPayload = buildFeishuMediaPayload(mediaList);

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Check if user is requesting chat history for summarization
    let historyContext = "";
    if (isGroup && isHistoryRequest(ctx.content)) {
      try {
        log(`feishu: detected history request in message`);
        const historyResult = await fetchChatHistoryForAgent({
          cfg,
          chatId: ctx.chatId,
          requestContent: ctx.content,
          runtime,
        });

        if (historyResult.formatted) {
          historyContext = `\n\n--- 群聊历史记录 (最近 ${historyResult.total} 条消息) ---\n${historyResult.formatted}\n--- 历史记录结束 ---\n\n`;
          log(`feishu: included ${historyResult.total} history messages in context`);
        }
      } catch (err) {
        error(`feishu: failed to fetch chat history: ${String(err)}`);
        // Continue without history, don't block the message
      }
    }

    // Build message body with quoted content if available
    let messageBody = ctx.content;
    if (quotedContent) {
      messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
    }

    // Prepend history context if available
    if (historyContext) {
      messageBody = historyContext + messageBody;
    }

    // Include a readable speaker label so the model can attribute instructions.
    // (DMs already have per-sender sessions, but the prefix is still useful for clarity.)
    const speaker = ctx.senderName ?? ctx.senderOpenId;
    messageBody = `${speaker}: ${messageBody}`;

    // If there are mention targets, inform the agent that replies will auto-mention them
    if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
      const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
      messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
    }

    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;

    // If there's a permission error, dispatch a separate notification first
    if (permissionErrorForAgent) {
      const grantUrl = permissionErrorForAgent.grantUrl ?? "";
      const permissionNotifyBody = `[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;

      const permissionBody = core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: envelopeFrom,
        timestamp: new Date(),
        envelope: envelopeOptions,
        body: permissionNotifyBody,
      });

      const permissionCtx = core.channel.reply.finalizeInboundContext({
        Body: permissionBody,
        RawBody: permissionNotifyBody,
        CommandBody: permissionNotifyBody,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName: "system",
        SenderId: "system",
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: `${ctx.messageId}:permission-error`,
        Timestamp: Date.now(),
        WasMentioned: false,
        CommandAuthorized: true,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
      });

      const { dispatcher: permDispatcher, replyOptions: permReplyOptions, markDispatchIdle: markPermIdle } =
        createFeishuReplyDispatcher({
          cfg,
          agentId: route.agentId,
          runtime: runtime as RuntimeEnv,
          chatId: ctx.chatId,
          replyToMessageId: ctx.messageId,
        });

      log(`feishu: dispatching permission error notification to agent`);

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: permissionCtx,
        cfg,
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
      });

      markPermIdle();
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = isGroup ? ctx.chatId : undefined;

    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: feishuFrom,
      To: feishuTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.chatId : undefined,
      SenderName: ctx.senderName ?? ctx.senderOpenId,
      SenderId: ctx.senderOpenId,
      Provider: "feishu" as const,
      Surface: "feishu" as const,
      MessageSid: ctx.messageId,
      Timestamp: Date.now(),
      WasMentioned: ctx.mentionedBot,
      CommandAuthorized: true,
      OriginatingChannel: "feishu" as const,
      OriginatingTo: feishuTo,
      ...mediaPayload,
      Attachments: attachments.length > 0 ? attachments : undefined,
    } as any);

    // Debug: log attachment info
    if (attachments.length > 0) {
      log(`feishu: passing ${attachments.length} attachment(s) to agent for AI vision`);
      attachments.forEach((att, idx) => {
        log(`feishu: attachment ${idx}: type=${att.type}, size=${att.data.length} bytes, mimeType=${att.mimeType}`);
      });
    }

    const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      chatId: ctx.chatId,
      replyToMessageId: ctx.messageId,
      mentionTargets: ctx.mentionTargets,
    });

    log(`feishu: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    if (isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    log(`feishu: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
  } catch (err) {
    error(`feishu: failed to dispatch message: ${String(err)}`);
  }
}
