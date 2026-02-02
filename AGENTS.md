# AGENTS.md

Agent coding guidelines for the clawdbot-feishu project.

## Project Overview

This is a Feishu/Lark (飞书) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). It enables OpenClaw to send/receive messages through Feishu's enterprise messaging platform. TypeScript ESM project with no build step - plugin is loaded directly as `.ts` files by OpenClaw.

## Build/Lint/Test Commands

```bash
# Install dependencies
npm install
# or
pnpm install

# Type check (primary validation)
npx tsc --noEmit

# No dedicated test suite currently - manual testing via OpenClaw runtime
```

**Running a single test**: No test framework configured. Testing is done through OpenClaw runtime.

## Code Style Guidelines

### Import Organization

1. **Group imports by source** (external libs → openclaw → local):
   ```typescript
   import * as Lark from "@larksuiteoapi/node-sdk";
   import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
   import { createFeishuClient } from "./client.js";
   import type { FeishuConfig } from "./types.js";
   ```

2. **Always use `.js` extension** for local imports (ESM requirement):
   ```typescript
   import { foo } from "./bar.js";  // ✓ Correct
   import { foo } from "./bar";     // ✗ Wrong
   ```

3. **Use `type` imports** when importing only types:
   ```typescript
   import type { FeishuConfig } from "./types.js";
   import type * as Lark from "@larksuiteoapi/node-sdk";
   ```

### TypeScript Conventions

**Type Safety**:
- Use `strict: false` and `noImplicitAny: false` (per tsconfig.json)
- Explicit types for function parameters and return values
- Type assertions for external SDK responses

**Type Definitions**:
- Centralize shared types in `src/types.ts`
- Schema-specific types in `*-schema.ts` files (zod or typebox)
- Export types from schema files when needed elsewhere

**Example**:
```typescript
// Good - explicit types
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
}): Promise<FeishuMessageInfo | null> {
  // ...
}

// Type assertions for SDK responses
const response = (await client.im.message.get({
  path: { message_id: messageId },
})) as {
  code?: number;
  msg?: string;
  data?: { /* ... */ };
};
```

### Naming Conventions

**Files**: kebab-case
- `config-schema.ts`, `reply-dispatcher.ts`, `doc-schema.ts`

**Functions**: camelCase with verb prefixes
- `createFeishuClient()`, `resolveFeishuAccount()`, `sendMessageFeishu()`
- Suffix with `Feishu` for exported public APIs: `uploadImageFeishu()`

**Types/Interfaces**: PascalCase
- `FeishuConfig`, `FeishuMessageContext`, `ResolvedFeishuAccount`

**Constants**: SCREAMING_SNAKE_CASE
- `DEFAULT_ACCOUNT_ID`, `SENDER_NAME_TTL_MS`, `WIKI_ACCESS_HINT`

**Enums/String Literals**: lowercase string literals
- `"websocket" | "webhook"`, `"open" | "pairing" | "allowlist"`

### Formatting

**Indentation**: 2 spaces (standard TypeScript)

**Line Length**: Flexible, prioritize readability

**Object Literals**:
```typescript
// Multi-line when complex
const config = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu/Lark (飞书)",
};
```

**Function Params**: Destructure object params for functions with 2+ parameters
```typescript
// Good
async function sendMessage(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
}) {
  const { cfg, to, text } = params;
}
```

### Error Handling

**Try-catch blocks**: Use liberally, especially for SDK calls

**Error handling patterns**:
```typescript
// Return null/undefined on error (non-critical)
try {
  const result = await client.someApi();
  return result;
} catch {
  return null;  // Silent fail for optional operations
}

// Throw for configuration errors
if (!feishuCfg) {
  throw new Error("Feishu channel not configured");
}

// Check SDK response codes
if (response.code !== 0) {
  throw new Error(response.msg || "API request failed");
}
```

**Permission errors**: Extract and surface to users
```typescript
// See bot.ts for permission error extraction pattern
function extractPermissionError(err: unknown): PermissionError | null {
  // Extract Feishu API permission error (code: 99991672)
  // Return grant URL for user notification
}
```

### Comments

**File Headers**: Not required, but helpful for complex modules

**Function Comments**: Document parameters and return types for public APIs
```typescript
/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(/* ... */) {
```

**Inline Comments**: Explain non-obvious logic
```typescript
// Cache display names by open_id to avoid an API call on every message.
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
```

**Section Dividers**: Use for logical grouping
```typescript
// ============ Helpers ============
// ============ Actions ============
// --- Permission error extraction ---
```

### Schema Definitions

**Zod** (for config schemas):
```typescript
import { z } from "zod";

const FeishuConfigSchema = z.object({
  enabled: z.boolean().optional(),
  appId: z.string(),
  // ...
}).strict();

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
```

**TypeBox** (for tool parameter schemas):
```typescript
import { Type, type Static } from "@sinclair/typebox";

const FeishuDocSchema = Type.Object({
  action: Type.String(),
  documentId: Type.Optional(Type.String()),
  // ...
});

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
```

## Architecture Notes

**Entry Point**: `index.ts` - Plugin registration, exports public API

**Core Modules**:
- `client.ts` - SDK client factory
- `bot.ts` - Message event handler
- `send.ts` - Outbound messages
- `media.ts` - File/image upload/download
- `channel.ts` - Channel plugin implementation

**Tool Registration**: Tools registered in `register()` function
```typescript
export function registerFeishuDocTools(api: OpenClawPluginApi) {
  api.registerTool({
    name: "feishu_doc",
    description: "...",
    parameters: FeishuDocSchema,
    execute: async (params) => { /* ... */ },
  });
}
```

## Best Practices

1. **Always use `createFeishuClient()`** - Never instantiate SDK client directly
2. **Normalize targets** with `normalizeFeishuTarget()` before sending messages
3. **Check tool config** with `resolveToolsConfig()` before enabling tools
4. **Use helper functions** like `json()` for consistent tool responses
5. **Cache aggressively** - See `senderNameCache` pattern in `bot.ts`
6. **Provide helpful error messages** - Include context and action items
7. **Surface permission errors** to users with grant URLs

## Common Patterns

**SDK Client Creation**:
```typescript
const client = createFeishuClient(feishuCfg);
const response = await client.im.message.create({ /* ... */ });
```

**Tool Parameter Validation**:
```typescript
export type FeishuDocParams = Static<typeof FeishuDocSchema>;
// Schema validates automatically via OpenClaw
```

**Conditional Tool Registration**:
```typescript
const tools = resolveToolsConfig(cfg);
if (!tools.wiki) return; // Skip registration
```

**Helper Response Formatting**:
```typescript
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}
```
