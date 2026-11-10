// Keeps a populated local room open so the projector, phones, and host console have something to show.
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.js";

const url = process.env.WS_URL ?? "ws://127.0.0.1:8080/ws";

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function once(ws: WebSocket, type: string): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(type)), 5000);
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

const names = ["Ada", "Grace", "Lin", "Nikhil", "Priya", "Owen", "Maya", "Jules", "Sam", "Noor", "Kai", "Rae", "Imani", "Theo", "Hana", "Leo"];
const host = await connect();
host.send(JSON.stringify({ type: "host.login", secret: "local-dev-pin", clientTs: Date.now() } satisfies ClientMessage));
const welcome = await once(host, "host.welcome");
if (welcome.type !== "host.welcome") throw new Error("login");
host.send(JSON.stringify({ type: "host.createRoom", token: welcome.token, clientTs: Date.now() } satisfies ClientMessage));
const created = await once(host, "room.created");
if (created.type !== "room.created") throw new Error("room");
const code = created.roomCode;

const phones: WebSocket[] = [];
for (const [i, name] of names.entries()) {
  const phone = await connect();
  phone.send(JSON.stringify({ type: "join", roomCode: code, displayName: name, deviceId: `seed-${i}`, clientTs: Date.now() } satisfies ClientMessage));
  const joined = await once(phone, "welcome");
  if (joined.type !== "welcome") throw new Error("join");
  phone.send(JSON.stringify({ type: "subscribe", views: ["board", "battle", "qa"], clientTs: Date.now() } satisfies ClientMessage));
  phones.push(phone);
  if (i % 3 === 0) {
    phone.send(JSON.stringify({ type: "qa.post", text: ["How does Lambda scale to zero?", "When would you pick SQS over SNS?", "What does a VPC actually isolate?", "Is DynamoDB strongly consistent by default?"][i % 4], clientMsgId: `qa-${i}`, clientTs: Date.now() } satisfies ClientMessage));
  }
  if (i < 8) {
    phone.send(JSON.stringify({ type: "match.set", interests: i % 2 === 0 ? ["Serverless", "AI / Bedrock"] : ["Serverless", "Frontend"], clientTs: Date.now() } satisfies ClientMessage));
  }
}

host.send(JSON.stringify({ type: "host.board.challenge", token: welcome.token, challengeId: "photos", clientTs: Date.now() } satisfies ClientMessage));
const tiles = ["s3", "lambda", "dynamodb", "apigw", "cloudfront", "bedrock"];
for (const [i, tile] of tiles.entries()) {
  phones[i % phones.length].send(JSON.stringify({
    type: "board.place",
    tileType: tile,
    x: 15 + (i % 3) * 28,
    y: 25 + Math.floor(i / 3) * 35,
    clientMsgId: `tile-${i}`,
    clientTs: Date.now(),
  } satisfies ClientMessage));
}

console.log(JSON.stringify({
  code,
  join: `http://127.0.0.1:8080/join/${code}`,
  play: `http://127.0.0.1:8080/play/${code}`,
  screen: `http://127.0.0.1:8080/screen/${code}`,
  host: "http://127.0.0.1:8080/host",
  pin: "local-dev-pin",
}, null, 2));

const flag = "/tmp/bl-advance";
while (true) {
  try {
    await import("node:fs/promises").then((fs) => fs.access(flag));
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
host.send(JSON.stringify({ type: "host.start", token: welcome.token, clientTs: Date.now() } satisfies ClientMessage));
await new Promise((r) => setTimeout(r, 400));
phones.forEach((phone, i) => {
  phone.send(JSON.stringify({
    type: "answer",
    questionId: "q01",
    choiceId: i % 4 === 0 ? "b" : "a",
    clientMsgId: `ans-${i}`,
    clientTs: Date.now(),
  } satisfies ClientMessage));
});
await new Promise((r) => setTimeout(r, 300));
host.send(JSON.stringify({ type: "host.pause", token: welcome.token, clientTs: Date.now() } satisfies ClientMessage));
console.log("battle-ready");

setInterval(() => {
  for (const phone of phones) {
    if (phone.readyState === phone.OPEN) phone.send(JSON.stringify({ type: "ping", clientTs: Date.now(), v: 0 }));
  }
}, 15000);
