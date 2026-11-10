// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { ServerMessage } from "../shared/protocol.js";
import { listConnections } from "./aws-store.js";

const endpoint = process.env.WEBSOCKET_MANAGEMENT_ENDPOINT ?? "";
const api = new ApiGatewayManagementApiClient({ endpoint });

export async function post(connectionId: string, msg: ServerMessage): Promise<void> {
  try {
    await api.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(msg)) }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 410) throw err;
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
