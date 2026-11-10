// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface SummaryInput {
  questions: { text: string; upvotes: number }[];
}

/** Host-only summary. No knowledge bases. Off unless the function is deployed. */
export async function handler(event: SummaryInput): Promise<{ text: string }> {
  const modelId = process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";
  const maxTokens = Number(process.env.BEDROCK_MAX_TOKENS || 400);
  const lines = (event.questions ?? [])
    .slice(0, Number(process.env.BEDROCK_TOP_N || 10))
    .map((q, i) => `${i + 1}. (${q.upvotes} votes) ${q.text}`)
    .join("\n");
  const prompt = [
    "Summarise these meetup questions for a host in a few short bullets.",
    "Use only the questions below. Do not invent any.",
    "",
    lines || "No questions.",
  ].join("\n");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "ap-southeast-2" });
  const guardrailId = process.env.BEDROCK_GUARDRAIL_ID || "";
  const out = await client.send(new ConverseCommand({
    modelId,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
    ...(guardrailId
      ? { guardrailConfig: { guardrailIdentifier: guardrailId, guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION || "DRAFT" } }
      : {}),
  }));
  const text = (out.output?.message?.content ?? []).map((part) => ("text" in part ? part.text : "")).join("").trim();
  return { text };
}
