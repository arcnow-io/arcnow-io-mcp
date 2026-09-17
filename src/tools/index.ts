/**
 * The tool registry, and the one place a call is dispatched.
 *
 * `listTools` and `callTool` here are plain functions over plain data. The MCP
 * transport in `server.ts` is a thin wrapper around them, which is what lets
 * the whole surface — what is published in each mode, what a refusal says, how
 * an on-chain revert is rendered — be tested without a transport, a client or a
 * chain.
 *
 * @module
 */

import type { ServerConfig } from "../config.js";
import { renderError } from "./errors.js";
import { READ_TOOLS } from "./read.js";
import type { AnyTool, ToolContext, ToolOutput } from "./schema.js";
import { WRITE_TOOLS, writeRefusal } from "./write.js";

export { renderError };

/** Every tool this server knows about, in either mode. */
export const ALL_TOOLS: readonly AnyTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What the client is told exists.
 *
 * In read-only mode the write tools are **not listed**. A model offered a
 * `arcnow_launch` it cannot use will try it, and the interesting failure is not
 * the one where a tool exists and refuses — it is the one where a user is told
 * "I could launch that for you" on the strength of a tool listing. So they are
 * absent from the list, and still refused by name if called anyway, because a
 * client may have cached an older list.
 */
export function listTools(config: ServerConfig): readonly AnyTool[] {
  return config.canWrite ? ALL_TOOLS : READ_TOOLS;
}

export function findTool(name: string): AnyTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

/**
 * Run one tool call. Never throws: an MCP tool error is a result with
 * `isError`, so the model can read what went wrong and do something else.
 */
export async function callTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const tool = findTool(name);
  if (tool === undefined) {
    return {
      isError: true,
      text: `There is no tool called ${name} on this server. It has: `
        + `${listTools(ctx.config).map((t) => t.name).join(", ")}.`,
    };
  }

  // The gate. It is here, in dispatch, and not inside each write handler —
  // one check that cannot be forgotten when a seventh write tool is added.
  if (tool.access === "write" && !ctx.config.canWrite) {
    return writeRefusal(name);
  }

  try {
    return await tool.run(args, ctx);
  } catch (error) {
    return { isError: true, text: renderError(name, error) };
  }
}
