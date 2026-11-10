// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ServerMessage } from "../shared/protocol.js";
import { deleteConnection, listConnections } from "./aws-store.js";

const endpoint = process.env.WEBSOCKET_MANAGEMENT_ENDPOINT ?? "";
const api = new ApiGatewayManagementApiClient({ endpoint });

function isGone(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number };
  return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410 || e.statusCode === 410;
}

export async function post(connectionId: string, msg: ServerMessage): Promise<void> {
  try {
    await api.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(msg)) }));
  } catch (err) {
    if (isGone(err)) {
      try {
        await deleteConnection(connectionId);
      } catch (cleanupErr) {
        console.error("failed to clean gone connection", connectionId, cleanupErr);
      }
      return;
    }
    throw err;
  }
}

export async function postMany(ids: string[], msg: ServerMessage): Promise<void> {
  const queue = [...ids];
  const workers = Array.from({ length: Math.min(25, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.pop();
      if (id) await post(id, msg);
    }
  });
  await Promise.all(workers);
}

export async function roomFanout(roomCode: string, msg: ServerMessage, filter: (conn: { role?: string; views?: string[] }) => boolean): Promise<void> {
  const conns = await listConnections(roomCode);
  await postMany(conns.filter(filter).map((c) => c.id), msg);
}
