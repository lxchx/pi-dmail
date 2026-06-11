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
  // ─── Tool: send_dmail ─────────────────────────────────────────────
  pi.registerTool({
    name: "send_dmail",
    label: "Send D-Mail",
    description:
      "Send a message back to a past checkpoint in this session. Reverts the conversation context to the specified checkpoint entry, then appends your summary message so the agent continues from a cleaner, pruned context. Use this when you've read a large file with mostly irrelevant content, or when a long debugging struggle produced useful fixes but wasted context. The filesystem is NOT reverted — only the conversation context is folded into a summary.",
    parameters: Type.Object({
      entry_id: Type.String({
        description:
          "The entry ID of the checkpoint to revert to. Use the entry IDs visible in the conversation (each message has an id). Pick an entry that precedes the irrelevant context you want to drop.",
      }),
      message: Type.String({
        description:
          "Summary message to inject after the checkpoint. Tell your past self what you learned, what you changed on the filesystem, and what to do next. Be thorough — this replaces all the dropped context messages.",
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
              text: `Error: no entry found with ID "${params.entry_id}". Use a valid entry ID from the current session.`,
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
            text: `D-Mail stored. The next turn will revert context to checkpoint ${params.entry_id} and inject your summary.`,
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
