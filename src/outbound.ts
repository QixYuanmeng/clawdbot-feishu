import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";
import { sendMediaFeishu } from "./media.js";
import { createFeishuRenderer } from "./renderers/feishu-renderer.js";
import type { FeishuConfig } from "./types.js";

function shouldUseCard(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text }) => {
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const renderMode = feishuCfg?.renderMode ?? "auto";
    const useCard =
      renderMode === "card" || (renderMode === "auto" && shouldUseCard(text ?? ""));

    const renderer = createFeishuRenderer({
      cfg,
      agentId: "feishu-outbound",
      runtime: getFeishuRuntime(),
      chatId: to,
    });

    if (useCard) {
      const result = await renderer.deliver({
        chatId: to,
        text: text ?? "",
        replyToMessageId: undefined,
      });
      return { channel: "feishu", result };
    }

    const result = await sendMessageFeishu({ cfg, to, text: text ?? "" });
    return { channel: "feishu", result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    const renderer = createFeishuRenderer({
      cfg,
      agentId: "feishu-outbound",
      runtime: getFeishuRuntime(),
      chatId: to,
    });

    // Send text first if provided
    if (text?.trim()) {
      const useCard = shouldUseCard(text ?? "");

      if (useCard) {
        await renderer.deliver({
          chatId: to,
          text: text ?? "",
          replyToMessageId: undefined,
        });
      } else {
        await sendMessageFeishu({ cfg, to, text });
      }
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await sendMediaFeishu({ cfg, to, mediaUrl });
          return { channel: "feishu", ...result };
        } catch (err) {
          lastError = err;
          console.error(`[feishu] sendMediaFeishu failed (attempt ${attempt}/3):`, err);
          if (attempt < 3) {
            const delay = 1000 * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      // Fallback to URL link if upload fails after retries
      console.error(`[feishu] sendMediaFeishu failed after 3 attempts. Fallback to URL.`);
      const fallbackText = `[Media Upload Failed] Click to view: ${mediaUrl}`;
      const result = await sendMessageFeishu({ cfg, to, text: fallbackText });
      return { channel: "feishu", ...result };
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({ cfg, to, text: text ?? "" });
    return { channel: "feishu", ...result };
  },
};
