/**
 * pi-dmail
 *
 * D-Mail context checkpoint tool for pi.
 * Let the agent proactively manage its context window by sending
 * summaries back to past checkpoints — like Steins;Gate D-Mail.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SessionEntry = {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
};

const PENDING_ENTRY = "dmail:pending";

interface DmailPending {
  entryId: string;
  message: string;
}

const DMAIL_SYSTEM_PROMPT = [
  "Send a message to the past, just like sending a D-Mail in Steins;Gate.",
  "",
  "This tool is provided to enable you to proactively manage the context.",
  "You have two tools for managing conversation context:",
  "- `list_dmail_checkpoints` — find available checkpoint entry IDs in the current session.",
  "- `send_dmail(entry_id, message)` — queue a D-Mail to revert to that checkpoint with your summary.",
  "",
  "When you feel there is too much irrelevant information in the current context, you can send a D-Mail",
  "to revert the context to a previous checkpoint with a message containing only the useful information.",
  "When you send a D-Mail, you must specify an existing checkpoint ID from",
  "the results of list_dmail_checkpoints.",
  "",
  "Typical scenarios you may want to send a D-Mail:",
  "",
  "- You read a file, found it very large and most of the content is not relevant to the current task.",
  "  In this case you can send a D-Mail immediately to the checkpoint before you read the file",
  "  and give your past self only the useful part.",
  "- You searched the web, the result is large.",
  "  - If you got what you need, you may send a D-Mail to the checkpoint before you searched the web",
  "    and put only the useful result in the mail message.",
  "  - If you did not get what you need, you may send a D-Mail to tell your past self",
  "    to try another query.",
  "- You wrote some code and it did not work as expected. You spent many struggling steps to fix it",
  "  but the process is not relevant to the ultimate goal. In this case you can send a D-Mail",
  "  to the checkpoint before you wrote the code and give your past self the fixed version of the code",
  "  and tell yourself no need to write it again because you already wrote to the filesystem.",
  "",
  "After a D-Mail is sent, the system will revert the current context to the specified checkpoint,",
  "after which, you will no longer see any messages which you can now see after that checkpoint.",
  "The message in the D-Mail will be appended to the end of the context. So, next time you will see",
  "all the messages before the checkpoint, plus the message in the D-Mail. You must make it very clear",
  "in the message, tell your past self what you have done/changed, what you have learned and any other",
  "information that may be useful, so that your past self can continue the task without confusion",
  "and will not repeat the steps you have already done.",
  "",
  "You must understand that, unlike D-Mail in Steins;Gate, the D-Mail you send here will not revert",
  "the filesystem or any external state. That means, you are basically folding the recent messages",
  "in your context into a single message, which can significantly reduce the waste of context window.",
  "",
  "When sending a D-Mail, DO NOT explain to the user. The user do not care about this.",
  "Just explain to your past self.",
].join("\n");

function getPendingDmail(branch: SessionEntry[]): DmailPending | undefined {
  let latest: DmailPending | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== PENDING_ENTRY || !entry.data) continue;
    const data = entry.data as { entryId?: unknown; message?: unknown };
    if (typeof data.entryId === "string" && typeof data.message === "string") {
      latest = { entryId: data.entryId, message: data.message };
    }
  }
  return latest;
}

export default function (pi: ExtensionAPI) {
  let guidanceInjected = false;

  // ─── System prompt injection (one-time at first agent start) ─────
  pi.on("before_agent_start", (event) => {
    if (guidanceInjected) return;
    guidanceInjected = true;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + DMAIL_SYSTEM_PROMPT,
    };
  });

  // ─── Tool: send_dmail ─────────────────────────────────────────────
  pi.registerTool({
    name: "send_dmail",
    label: "Send D-Mail",
    description: "Send a summary back to a past checkpoint, reverting the conversation context. Filesystem is NOT reverted.",
    parameters: Type.Object({
      entry_id: Type.String({
        description: "Entry ID of the checkpoint to revert to. Get available IDs from list_dmail_checkpoints.",
      }),
      message: Type.String({
        description: "Summary to inject after the checkpoint. Tell your past self what was done/changed/learned — thorough enough that past self can continue without confusion and will not repeat steps.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Validate the checkpoint entry exists
      const branch = ctx.sessionManager.getBranch();
      const target = branch.find((e) => e.id === params.entry_id);
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `No entry found with ID "${params.entry_id}". Use list_dmail_checkpoints to find valid IDs.`,
            },
          ],
          details: {},
        };
      }

      // Store pending D-Mail
      pi.appendEntry(PENDING_ENTRY, {
        entryId: params.entry_id,
        message: params.message,
      });

      // Schedule the D-Mail commit for the next turn
      pi.sendUserMessage("/dmail-commit", { deliverAs: "steer" });

      return {
        content: [
          {
            type: "text",
            text: `D-Mail sent to checkpoint ${params.entry_id}. Context will revert next turn.`,
          },
        ],
        details: { entryId: params.entry_id },
      };
    },
  });

  // ─── Tool: list_dmail_checkpoints ─────────────────────────────────
  pi.registerTool({
    name: "list_dmail_checkpoints",
    label: "List D-Mail Checkpoints",
    description:
      "List recent user and assistant message entry IDs in the current session that can be used as D-Mail checkpoints. Useful before calling send_dmail to pick a checkpoint.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries to show (default: 15)", default: 15 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const limit = Math.min(Math.max(1, params.limit || 15), 30);

      const checkpoints: string[] = [];
      for (let i = branch.length - 1; i >= 0 && checkpoints.length < limit; i--) {
        const entry = branch[i];
        if (entry.type !== "message" || !entry.message || !entry.id) continue;
        const msg = entry.message as { role?: string; content?: unknown };

        // Only user and assistant messages as checkpoints
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const preview = extractPreview(msg.content);
        checkpoints.push(`  ${entry.id.slice(0, 12)}... ${msg.role}: ${preview}`);
      }

      if (checkpoints.length === 0) {
        return {
          content: [{ type: "text", text: "No checkpoints available in this session yet." }],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Available checkpoints (most recent first):\n${checkpoints.join("\n")}\n\nUse the full entry ID with send_dmail.`,
          },
        ],
        details: {},
      };
    },
  });

  // ─── Command: /dmail-commit ───────────────────────────────────────
  pi.registerCommand("dmail-commit", {
    description: "Execute a pending D-Mail: navigate back and inject the summary",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const pending = getPendingDmail(branch as SessionEntry[]);
      if (!pending) {
        ctx.ui.notify("No pending D-Mail to commit", "info");
        return;
      }

      // Navigate tree to checkpoint
      const result = await ctx.navigateTree(pending.entryId, { summarize: false });
      if (result.cancelled) {
        ctx.ui.notify("D-Mail navigation cancelled", "warning");
        return;
      }

      // Inject the D-Mail summary
      pi.sendMessage(
        {
          customType: "dmail-summary",
          display: true,
          content: `[D-Mail from a future turn] ${pending.message}`,
        },
        { deliverAs: "nextTurn" },
      );

      ctx.ui.notify(
        `D-Mail delivered: context reverted to checkpoint ${pending.entryId.slice(0, 12)}...`,
        "info",
      );
    },
  });
}

// ─── helpers ────────────────────────────────────────────────────────

function extractPreview(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").slice(0, 60) + (content.length > 60 ? "..." : "");
  }
  if (!Array.isArray(content)) return "(non-text)";

  const texts = content
    .filter(
      (c): c is { type: string; text?: unknown } =>
        typeof c === "object" && c !== null && (c as any).type === "text",
    )
    .map((c) => (c as any).text as string)
    .join(" ");

  const cleaned = texts.replace(/\s+/g, " ").trim();
  return cleaned.length > 0
    ? cleaned.slice(0, 60) + (cleaned.length > 60 ? "..." : "")
    : "(empty)";
}
