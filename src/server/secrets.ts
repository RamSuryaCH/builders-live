// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
let cache: { hash: string; signing: string; at: number } | null = null;

export async function loadSecrets(): Promise<{ hash: string; signing: string }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const [hash, signing] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: process.env.HASH_PARAM, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: process.env.SIGNING_PARAM, WithDecryption: true })),
  ]);
  cache = {
    hash: hash.Parameter?.Value ?? "",
    signing: signing.Parameter?.Value ?? "",
    at: Date.now(),
  };
  return cache;
}
