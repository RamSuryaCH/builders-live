// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { randomBytes } from "node:crypto";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { hashSecret } from "../shared/tokens.js";

const ssm = new SSMClient({});

interface Event {
  RequestType: "Create" | "Update" | "Delete";
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: { AdminSecret?: string; HashName: string; SigningName: string };
}

async function respond(event: Event, status: "SUCCESS" | "FAILED", physicalId: string, reason?: string): Promise<void> {
  await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "content-type": "" },
    body: JSON.stringify({
      Status: status,
      Reason: reason ?? "ok",
      PhysicalResourceId: physicalId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: { HashName: event.ResourceProperties.HashName },
    }),
  });
}

export async function handler(event: Event): Promise<void> {
  const physical = event.PhysicalResourceId || event.ResourceProperties.HashName;
  try {
    if (event.RequestType === "Delete") {
      await ssm.send(new DeleteParameterCommand({ Name: event.ResourceProperties.HashName })).catch(() => undefined);
      await ssm.send(new DeleteParameterCommand({ Name: event.ResourceProperties.SigningName })).catch(() => undefined);
      await respond(event, "SUCCESS", physical);
      return;
    }
    const secret = event.ResourceProperties.AdminSecret ?? "";
    if (secret.length < 8) throw new Error("Admin secret is too short");
    await ssm.send(new PutParameterCommand({
      Name: event.ResourceProperties.HashName,
      Value: hashSecret(secret),
      Type: "SecureString",
      Tier: "Standard",
      Overwrite: true,
    }));
    let signing = "";
    try {
      const existing = await ssm.send(new GetParameterCommand({ Name: event.ResourceProperties.SigningName, WithDecryption: true }));
      signing = existing.Parameter?.Value ?? "";
    } catch {
      signing = "";
    }
    if (!signing) {
      await ssm.send(new PutParameterCommand({
        Name: event.ResourceProperties.SigningName,
        Value: randomBytes(32).toString("hex"),
        Type: "SecureString",
        Tier: "Standard",
        Overwrite: false,
      }));
    }
    await respond(event, "SUCCESS", physical);
  } catch (err) {
    await respond(event, "FAILED", physical, err instanceof Error ? err.message : "secret init failed");
  }
}
