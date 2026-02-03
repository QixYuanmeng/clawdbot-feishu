import type { ReplyPayload, ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "../runtime.js";
import {
  sendMessageFeishu,
  sendCardFeishu,
  sendMarkdownCardFeishu,
  updateCardFeishu,
} from "../send.js";
import type { FeishuConfig } from "../types.js";
import {
  AgentRunStatus,
  AgentRunTracker,
  buildLarkCard,
} from "./agent-card-view.js";
import { buildMentionedCardContent, type MentionTarget } from "../mention.js";

type FeishuRenderController = {
  deliver: (payload: ReplyPayload) => Promise<void>;
  finalize?: () => Promise<void>;
  onError?: (err: unknown) => Promise<void>;
};

type CreateFeishuRendererParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
};

function shouldUseCard(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

function mergeStreamText(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  return prev + next;
}

function applyMentions(mentions: MentionTarget[] | undefined, text: string): string {
  if (!mentions || mentions.length === 0) return text;
  return buildMentionedCardContent(mentions, text);
}

const TOOL_NAMES = new Set(
  [
    "read",
    "write",
    "edit",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "message",
    "sessions_list",
    "sessions_send",
    "sessions_read",
    "sessions_search",
    "sessions_info",
    "librarian",
    "oracle",
    "explore",
    "prometheus",
    "sisyphus-junior",
    "metis",
    "momus",
    "multimodal-looker",
    "skill",
    "skill_mcp",
    "google_search",
    "zread_search_doc",
    "zread_read_file",
    "zread_get_repo_structure",
    "web-search-prime_webSearchPrime",
    "zai-mcp-server_ui_to_artifact",
    "zai-mcp-server_extract_text_from_screenshot",
    "zai-mcp-server_diagnose_error_screenshot",
    "zai-mcp-server_understand_technical_diagram",
    "zai-mcp-server_analyze_data_visualization",
    "zai-mcp-server_ui_diff_check",
    "zai-mcp-server_analyze_image",
    "zai-mcp-server_analyze_video",
    "cron",
  ].map((s) => s.toLowerCase()),
);

function splitToolSummaryLines(text: string) {
  const lines = text.split("\n");
  const toolLines: string[] = [];
  const contentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lower = trimmed.toLowerCase();
    const hasToolEmoji =
      lower.startsWith("🔧") ||
      lower.startsWith("🔍") ||
      lower.startsWith("📝") ||
      lower.startsWith("💻");

    const matchedTool = Array.from(TOOL_NAMES).find((name) => lower.includes(name));

    if (hasToolEmoji && matchedTool && (lower.includes(":") || lower.includes("："))) {
      toolLines.push(trimmed);
    } else {
      contentLines.push(line);
    }
  }

  return {
    toolLines,
    remainingText: contentLines.join("\n").trim(),
  };
}

function extractAgentMessages(payload: ReplyPayload): any[] {
  const p = payload as any;
  return (
    p.messages ||
    p.meta?.agentMessages ||
    p.meta?.messages ||
    p.extra?.messages ||
    p.context?.messages ||
    p.delta?.messages ||
    []
  );
}

function extractVerboseEvents(payload: ReplyPayload): any[] {
  const p = payload as any;
  return (
    p.events ||
    p.meta?.events ||
    p.extra?.events ||
    p.context?.events ||
    p.delta?.events ||
    []
  );
}

function inferStatusFromMessages(messages: any[]): AgentRunStatus | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") return AgentRunStatus.WaitingToolResult;
    if (m.role === "assistant") {
      const hasToolCall = m.content?.some((c: any) => c.type === "tool-call");
      if (hasToolCall) return AgentRunStatus.ToolCalling;
    }
  }
  return null;
}

function applyVerboseEvent(params: {
  tracker: AgentRunTracker;
  event: any;
  assistantBuffer: { text: string };
}) {
  const { tracker, event, assistantBuffer } = params;
  const data = event.data || {};
  const stream = event.stream || event.event || event.payload?.stream;

  if (stream === "assistant") {
    if (data.text) {
      assistantBuffer.text = mergeStreamText(assistantBuffer.text, data.text);
      tracker.setDraftAnswer(assistantBuffer.text);
    }
    if (tracker.currentStatus === AgentRunStatus.Idle) {
      tracker.setStatus(AgentRunStatus.Thinking);
    }
  } else if (stream === "tool") {
    const phase = data.phase;
    if (phase === "start") {
      tracker.setStatus(AgentRunStatus.ToolCalling);
    } else if (phase === "result" || phase === "output") {
      tracker.setStatus(AgentRunStatus.WaitingToolResult);
    } else if (phase === "error") {
      tracker.setStatus(AgentRunStatus.Error);
    }
  } else if (stream === "lifecycle") {
    if (data.phase === "start") {
      tracker.setStatus(AgentRunStatus.Thinking);
    } else if (data.phase === "error") {
      tracker.setStatus(AgentRunStatus.Error);
    }
  }
}

function createCardUpdateController(params: {
  cfg: ClawdbotConfig;
  messageId: string;
}) {
  const { cfg, messageId } = params;
  let pending: Record<string, unknown> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSentAt = 0;
  const MIN_INTERVAL_MS = 350;

  const flushOnce = async () => {
    if (!pending) return;
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSentAt));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const card = pending;
    pending = null;
    lastSentAt = Date.now();
    await updateCardFeishu({ cfg, messageId, card });
  };

  const kick = () => {
    if (inFlight) return;
    inFlight = (async () => {
      try {
        while (pending) {
          await flushOnce();
        }
      } finally {
        inFlight = null;
        if (pending) kick();
      }
    })();
  };

  return {
    schedule(card: Record<string, unknown>) {
      pending = card;
      kick();
    },
    async flush() {
      if (inFlight) await inFlight;
      if (pending) {
        await flushOnce();
      }
    },
  };
}

function createSimpleRenderer(params: CreateFeishuRendererParams): FeishuRenderController {
  const core = getFeishuRuntime();
  const { cfg, runtime, chatId, replyToMessageId, mentionTargets } = params;
  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "feishu",
    defaultLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  let isFirstChunk = true;

  return {
    async deliver(payload: ReplyPayload) {
      runtime.log?.(`feishu deliver called: text=${payload.text?.slice(0, 100)}`);
      const text = payload.text ?? "";
      if (!text.trim()) {
        runtime.log?.(`feishu deliver: empty text, skipping`);
        return;
      }

      const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
      const renderMode = feishuCfg?.renderMode ?? "auto";
      const useCard =
        renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

      if (useCard) {
        const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        runtime.log?.(`feishu deliver: sending ${chunks.length} card chunks to ${chatId}`);
        for (const chunk of chunks) {
          await sendMarkdownCardFeishu({
            cfg,
            to: chatId,
            text: chunk,
            replyToMessageId,
            mentions: isFirstChunk ? mentionTargets : undefined,
          });
          isFirstChunk = false;
        }
        return;
      }

      const converted = core.channel.text.convertMarkdownTables(text, tableMode);
      const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
      runtime.log?.(`feishu deliver: sending ${chunks.length} text chunks to ${chatId}`);
      for (const chunk of chunks) {
        await sendMessageFeishu({
          cfg,
          to: chatId,
          text: chunk,
          replyToMessageId,
          mentions: isFirstChunk ? mentionTargets : undefined,
        });
        isFirstChunk = false;
      }
    },
  };
}

function createAgentCardRenderer(params: CreateFeishuRendererParams): FeishuRenderController {
  const { cfg, runtime, chatId, replyToMessageId, mentionTargets } = params;
  const tracker = new AgentRunTracker();
  let messageId: string | null = null;
  let assistantBuffer = "";
  let updater: ReturnType<typeof createCardUpdateController> | null = null;

  const assistantBufferState = { text: "" };
  let initialSendPromise: Promise<void> | null = null;

  const renderCard = (collapseTimeline: boolean) => {
    const state = tracker.buildRenderState({ collapseTimeline });
    const body = applyMentions(mentionTargets, state.body);
    const card = buildLarkCard({
      ...state,
      body,
    });
    if (messageId && updater) {
      updater.schedule(card);
    }
    return card;
  };

  const ensureInitialCard = () => {
    if (messageId || initialSendPromise) return;

    initialSendPromise = (async () => {
      try {
        const card = renderCard(false);
        const result = await sendCardFeishu({ cfg, to: chatId, card, replyToMessageId });
        messageId = result.messageId;
        updater = createCardUpdateController({ cfg, messageId });
        renderCard(false);
      } catch (err) {
        runtime.error?.(`feishu initial send failed: ${String(err)}`);
        initialSendPromise = null;
      }
    })();
  };

  return {
    async deliver(payload: ReplyPayload) {
      if (runtime.debug) {
        try {
          const snapshot = JSON.stringify(payload);
          runtime.log?.(
            `feishu payload keys=${Object.keys(payload as Record<string, unknown>).join(",")} size=${snapshot.length}`,
          );
        } catch (err) {
          runtime.log?.(`feishu payload log failed: ${String(err)}`);
        }
      }
      const messages = extractAgentMessages(payload);
      const events = extractVerboseEvents(payload);
      const payloadText = payload.text ?? "";

      if (events && events.length > 0) {
        for (const evt of events) {
          applyVerboseEvent({ tracker, event: evt, assistantBuffer: assistantBufferState });
        }
        if (assistantBufferState.text) {
          assistantBuffer = assistantBufferState.text;
        }
      }

      if (messages && messages.length > 0) {
        const nextStatus = inferStatusFromMessages(messages);
        if (nextStatus) {
          tracker.setStatus(nextStatus);
        }
        tracker.appendMessages(messages);
      } else if (payloadText.trim()) {
        const { toolLines, remainingText } = splitToolSummaryLines(payloadText);

        if (toolLines.length > 0) {
          tracker.setStatus(AgentRunStatus.ToolCalling);
          tracker.appendMessages([
            {
              role: "assistant",
              content: toolLines.map((line) => ({ type: "text", text: line })),
            },
          ]);
        }

        if (remainingText) {
          assistantBuffer = mergeStreamText(assistantBuffer, remainingText);
          tracker.setDraftAnswer(assistantBuffer);
          if (toolLines.length === 0) {
            tracker.setStatus(AgentRunStatus.Thinking);
          }
        }
      } else if (!events || events.length === 0) {
        return;
      }

      ensureInitialCard();

      if (messageId) {
        renderCard(false);
      }
    },
    finalize: async () => {
      if (initialSendPromise) await initialSendPromise;
      if (!messageId && !assistantBuffer.trim() && tracker.currentStatus === AgentRunStatus.Thinking) {
        return;
      }
      tracker.setStatus(AgentRunStatus.Completed);
      renderCard(true);
      await updater?.flush();
    },
    onError: async () => {
      if (initialSendPromise) await initialSendPromise;
      if (!messageId && !assistantBuffer.trim()) return;
      tracker.setStatus(AgentRunStatus.Error);
      renderCard(true);
      await updater?.flush();
    },
  };
}

export function createFeishuRenderer(params: CreateFeishuRendererParams): FeishuRenderController {
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
  const renderEngine = feishuCfg?.renderEngine ?? "simple";
  if (renderEngine === "agent-card") {
    return createAgentCardRenderer(params);
  }
  return createSimpleRenderer(params);
}
