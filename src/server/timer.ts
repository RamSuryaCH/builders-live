// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { apply } from "../shared/engine.js";
import { loadConfig } from "../shared/event-config.js";
import { loadQuestions } from "../shared/questions.js";
import { battleView, standingsView } from "../shared/views.js";
import { commitRoom, loadRoom } from "./aws-store.js";
import { roomFanout } from "./fanout.js";
import { handler as flushHandler } from "./ws.js";

const env = { config: loadConfig(), questions: loadQuestions() };
const sqs = new SQSClient({});

interface RecordBody {
  kind: "tick" | "flush";
  roomCode: string;
  generation?: number;
}

export async function handler(event: { Records?: { body: string }[] }): Promise<void> {
  for (const record of event.Records ?? []) {
    const body = JSON.parse(record.body) as RecordBody;
    if (body.kind === "flush") {
      await flushHandler({ action: "flush", roomCode: body.roomCode });
      continue;
    }
    const room = await loadRoom(body.roomCode);
    if (!room || room.battle.generation !== body.generation) continue;
    if (room.battle.endsAt == null || Date.now() + 250 < room.battle.endsAt) continue;
    const working = structuredClone(room);
    const result = apply(working, { type: "tick" }, Date.now(), env);
    if (!result.phaseChanged) continue;
    const saved = await commitRoom(room, working, []);
    if (!saved) continue;
    await roomFanout(body.roomCode, {
      type: "battle",
      battle: battleView(working, env),
      standings: standingsView(working, env.config),
      screenMode: working.screenMode,
      serverTs: Date.now(),
    }, () => true);
    if (result.scheduleAt && process.env.TIMER_QUEUE_URL) {
      const delay = Math.min(900, Math.max(0, Math.ceil((result.scheduleAt - Date.now()) / 1000)));
      await sqs.send(new SendMessageCommand({
        QueueUrl: process.env.TIMER_QUEUE_URL,
        DelaySeconds: delay,
        MessageBody: JSON.stringify({ kind: "tick", roomCode: body.roomCode, generation: working.battle.generation }),
      }));
    }
  }
}
