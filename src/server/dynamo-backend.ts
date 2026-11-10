// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { StoreBackend } from "./room-store.js";

const table = () => process.env.TABLE_NAME ?? "";
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

function isConflict(err: unknown): boolean {
  return (err as { name?: string }).name === "ConditionalCheckFailedException";
}

export class DynamoBackend implements StoreBackend {
  ttl(hours = Number(process.env.DATA_TTL_HOURS ?? 24)): number {
    return Math.floor(Date.now() / 1000) + hours * 3600;
  }

  async get(pk: string, sk: string): Promise<Record<string, unknown> | null> {
    const out = await doc.send(new GetCommand({ TableName: table(), Key: { pk, sk } }));
    return (out.Item as Record<string, unknown> | undefined) ?? null;
  }

  async put(item: Record<string, unknown>, condition?: string, values?: Record<string, unknown>): Promise<"ok" | "conflict"> {
    try {
      await doc.send(
        new PutCommand({
          TableName: table(),
          Item: item,
          ConditionExpression: condition,
          ExpressionAttributeValues: values,
        }),
      );
      return "ok";
    } catch (err) {
      if (isConflict(err)) return "conflict";
      throw err;
    }
  }

  async update(
    pk: string,
    sk: string,
    update: string,
    values: Record<string, unknown>,
    names?: Record<string, string>,
    condition?: string,
  ): Promise<"ok" | "conflict" | "missing"> {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table(),
          Key: { pk, sk },
          UpdateExpression: update,
          ExpressionAttributeValues: values,
          ExpressionAttributeNames: names,
          ConditionExpression: condition,
        }),
      );
      return "ok";
    } catch (err) {
      if (isConflict(err)) return "conflict";
      if ((err as { name?: string }).name === "ResourceNotFoundException") return "missing";
      // Update with ADD creates the item; ConditionalCheckFailed is the main race signal.
      throw err;
    }
  }

  async query(pk: string, skPrefix: string): Promise<Record<string, unknown>[]> {
    const out = await doc.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: skPrefix
          ? "pk = :pk AND begins_with(sk, :sk)"
          : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":sk": skPrefix } : { ":pk": pk },
      }),
    );
    return (out.Items as Record<string, unknown>[] | undefined) ?? [];
  }

  async remove(pk: string, sk: string): Promise<void> {
    await doc.send(new DeleteCommand({ TableName: table(), Key: { pk, sk } }));
  }
}
