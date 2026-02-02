#!/usr/bin/env node

/**
 * Feishu Table Rendering Diagnostic Tool
 *
 * This script helps diagnose why tables might not render as native Feishu tables.
 * It checks:
 * 1. Configuration (renderMode)
 * 2. Table format validation
 * 3. Table parsing simulation
 */

import { containsMarkdownTable, splitIntoSegments, buildCardElements } from "./src/table-parser.js";
import { buildMarkdownCard } from "./src/send.js";

const ANSI = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function color(text: string, colorName: keyof typeof ANSI): string {
  return `${ANSI[colorName]}${text}${ANSI.reset}`;
}

function printHeader(title: string) {
  console.log(`\n${color("═══ " + title + " ═══", "cyan")}\n`);
}

function printSuccess(message: string) {
  console.log(`${color("✓", "green")} ${message}`);
}

function printError(message: string) {
  console.log(`${color("✗", "red")} ${message}`);
}

function printWarning(message: string) {
  console.log(`${color("⚠", "yellow")} ${message}`);
}

function printInfo(message: string) {
  console.log(`${color("→", "blue")} ${message}`);
}

const testTables = {
  standard: `| 列1 | 列2 | 列3 |
|------|-------|-------|
| 数据1 | 数据2 | 数据3 |
| 数据4 | 数据5 | 数据6 |`,

  simple: `| 姓名 | 年龄 |
|------|-------|
| 张三 | 25 |
| 李四 | 30 |`,

  missingSeparator: `| 列1 | 列2 |
| 数据1 | 数据2 |`,

  noLeadingPipe: `列1 | 列2 |
|------|-------|
| 数据1 | 数据2 |`,

  noTrailingPipe: `| 列1 | 列2
|------|-------|
| 数据1 | 数据2`,
};

printHeader("Feishu Table Rendering Diagnostic Tool");

printHeader("Configuration Check");
printInfo("Please manually check your OpenClaw configuration:");
console.log(`
${color("File:", "bright")} ~/.openclaw/config.yml  (or your config file)
${color("Section:", "bright")} channels.feishu
${color("Key:", "bright")} renderMode

${color("Expected values:", "cyan")} "auto" (recommended) or "card"
${color("Wrong value:", "red")} "raw" (tables will show as ASCII text)

${color("Example config:", "yellow")}
channels:
  feishu:
    enabled: true
    renderMode: "auto"  # ← Check this!
`);

printHeader("Table Format Validation");

let validCount = 0;
let invalidCount = 0;

Object.entries(testTables).forEach(([name, table]) => {
  const isStandard = name === "standard" || name === "simple";

  console.log(`\n${color(name.toUpperCase(), "bright")}:`);
  console.log(table);

  if (containsMarkdownTable(table)) {
    validCount++;
    printSuccess("✓ Format matches Feishu table detection");
  } else {
    invalidCount++;
    printError("✗ Format does NOT match Feishu table detection");
  }
});

console.log(`\n${color("Summary:", "bright")}`);
console.log(`  Valid tables: ${color(validCount.toString(), "green")}`);
console.log(`  Invalid tables: ${color(invalidCount.toString(), "red")}`);

printHeader("Table Parsing Simulation");

const standardTable = testTables.standard;
console.log(`Parsing standard table...\n`);

try {
  const card = buildMarkdownCard(standardTable);
  const cardJson = JSON.stringify(card, null, 2);

  printSuccess("Card JSON generated successfully");
  console.log(`\n${color("Generated card structure:", "cyan")}`);
  console.log(cardJson);

  const hasTableComponent = JSON.stringify(card).includes('"tag":"table"');
  if (hasTableComponent) {
    printSuccess("✓ Table component found in card");
  } else {
    printError("✗ Table component NOT found in card (unexpected)");
  }
} catch (error) {
  printError(`Failed to parse table: ${error}`);
}

printHeader("Diagnostic Checklist");

const checklist = [
  {
    question: "Is renderMode set to 'auto' or 'card'?",
    action: "Check OpenClaw config file",
  },
  {
    question: "Does your table have a correct format?",
    action: "Use standard format: | col | ... | \\n |---| ... |",
  },
  {
    question: "Does every line start and end with |?",
    action: "Fix formatting to include leading/trailing pipes",
  },
  {
    question: "Is there a separator line with - or :?",
    action: "Add separator line: |---|---|",
  },
  {
    question: "Is OpenClaw restarted after config change?",
    action: "Restart OpenClaw service",
  },
];

checklist.forEach((item, index) => {
  console.log(`\n${color(`${index + 1}. ${item.question}`, "bright")}`);
  console.log(`   ${color("Action:", "cyan")} ${item.action}`);
});

printHeader("Troubleshooting Guide");

console.log(`
${color("If tables still don't render:", "bright")}

${color("Step 1: Verify config", "cyan")}
  Run: openclaw config get channels.feishu.renderMode
  Expected: "auto" or "card"

${color("Step 2: Test with simple table", "cyan")}
  Send this exact message:

  | 姓名 | 年龄 |
  |------|-------|
  | 张三 | 25 |

${color("Step 3: Check logs", "cyan")}
  Look for errors in OpenClaw logs:
  - "Failed to send card, falling back to text"
  - Any other errors during message sending

${color("Step 4: Verify permissions", "cyan")}
  Ensure bot has these permissions:
  - im:message:send_as_bot
  - im:resource (for media if needed)

${color("Step 5: Restart service", "cyan")}
  After any config change, restart OpenClaw:
  - openclaw restart
  - Or systemctl restart openclaw
`);

printHeader("Diagnostic Complete");

console.log(`
${color("Next Steps:", "bright")}
  1. Check your OpenClaw configuration
  2. Test with simple table above
  3. If still failing, check OpenClaw logs
  4. Report back with:
     - Your renderMode setting
     - The exact table content you're testing
     - Any error messages from logs

${color("Good luck!", "green")}
`);
