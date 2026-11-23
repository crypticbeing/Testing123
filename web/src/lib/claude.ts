import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { InputImage } from "./types";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Reads ANTHROPIC_API_KEY (or another configured credential) from the environment.
  client ??= new Anthropic();
  return client;
}

type Block = Anthropic.Beta.BetaContentBlockParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function imageBlock(img: { mediaType: InputImage["mediaType"]; data: string }): Block {
  return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } };
}

export function textBlock(text: string): Block {
  return { type: "text", text };
}

/**
 * One Claude call that must return JSON matching `schema`.
 * Server-side refusal fallbacks are enabled so a safety decline is retried on another model.
 */
export async function askStructured<S extends z.ZodType>(opts: {
  system: string;
  content: Block[];
  schema: S;
  effort?: Effort;
}): Promise<z.infer<S>> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: opts.effort ?? (process.env.CLAUDE_EFFORT as Effort | undefined) ?? "medium",
      format: betaZodOutputFormat(opts.schema),
    },
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off (max_tokens). Try fewer or smaller images.");
  }
  if (response.parsed_output == null) {
    throw new Error("Claude returned an answer that did not match the expected format.");
  }
  return response.parsed_output as z.infer<S>;
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude API authentication failed. Set ANTHROPIC_API_KEY in web/.env.local.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API. Check your network.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  if (err instanceof Error && err.message.startsWith("Could not resolve authentication method")) {
    return "No Claude API key found. Add ANTHROPIC_API_KEY to web/.env.local and restart the app.";
  }
  return err instanceof Error ? err.message : String(err);
}
