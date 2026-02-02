import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";
import { sendMediaFeishu } from "./media.js";
import type { FeishuConfig } from "./types.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text }) => {
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const renderMode = feishuCfg?.renderMode ?? "auto";
    
    // Check if we should render as card
    let useCard = false;
    if (renderMode === "card") {
      useCard = true;
    } else if (renderMode === "auto") {
      // Auto-detect rich content: code blocks, tables, bold, inline code
      if (
        text.includes("```") || 
        (text.includes("|") && text.includes("-")) ||
        text.includes("**") ||
        text.includes("`")
      ) {
        useCard = true;
      }
    }

    if (useCard) {
      try {
        const result = await sendMarkdownCardFeishu({ cfg, to, text });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error("[feishu] Failed to send card, falling back to text. Error:", err);
        // Fallback will happen below
      }
    }

    const result = await sendMessageFeishu({ cfg, to, text });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    // Send text first if provided
    if (text?.trim()) {
      // Use standard send function (which defaults to text, but we could upgrade this later)
      await sendMessageFeishu({ cfg, to, text });
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
            const delay = 1000 * Math.pow(2, attempt - 1); // 1000ms, 2000ms
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
