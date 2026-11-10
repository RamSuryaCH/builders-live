import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the SAM template stays serverless, cheap, and in Sydney", async () => {
  const yaml = await readFile(new URL("../infra/template.yaml", import.meta.url), "utf8");
  assert.match(yaml, /ap-southeast-2/);
  assert.match(yaml, /PAY_PER_REQUEST/);
  assert.match(yaml, /TimeToLiveSpecification/);
  assert.match(yaml, /ProtocolType: WEBSOCKET/);
  assert.match(yaml, /AWS::Budgets::Budget/);
  assert.match(yaml, /Amount: "5"/);
  assert.match(yaml, /SecureString/);
  assert.match(yaml, /EnableBedrockSummary:\n\s+Type: String\n\s+Default: "false"/);
  assert.match(yaml, /amazon\.nova-lite-v1:0/);
  assert.match(yaml, /ReservedConcurrentExecutions: 1/);
  assert.doesNotMatch(yaml, /AWS::EC2::NatGateway/);
  assert.doesNotMatch(yaml, /ProvisionedThroughput/);
  assert.doesNotMatch(yaml, /AWS::SecretsManager/);
  assert.doesNotMatch(yaml, /KnowledgeBase/);
});
