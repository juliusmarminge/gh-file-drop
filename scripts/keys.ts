/**
 * Mint, list and revoke API keys.
 *
 *   vpr keys create --label ci [--save]
 *   vpr keys list
 *   vpr keys revoke <keyId>
 *   vpr keys create --stage prod
 *
 * Maintainer tooling: the admin token is read from alchemy state, so this only
 * works from a checkout with access to the stack. The `ghdrop` binary never
 * sees the admin token.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as Os from "node:os";
import { api } from "../src/api.ts";
import { configPath, writeStoredConfig } from "../src/config.ts";
import { readDeployment, StackError } from "./stack.ts";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

/** A client authenticated with the stack's admin token. */
const adminClient = Effect.fn(function* () {
  const { adminToken, url } = yield* readDeployment(flag("stage"));
  const client = yield* HttpApiClient.make(api, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(adminToken),
    ),
  });
  return { client, url };
});

const create = Effect.gen(function* () {
  const { client, url } = yield* adminClient();
  const created = yield* client.keys.create({
    payload: { label: flag("label") ?? Os.hostname() },
  });
  if (argv.includes("--save")) {
    yield* writeStoredConfig({ url, apiKey: created.apiKey });
    yield* Console.log(`saved ${yield* configPath}`);
  }
  yield* Console.log(`apiKey: ${created.apiKey}`);
  yield* Console.log(`keyId:  ${created.keyId}`);
});

const list = Effect.gen(function* () {
  const { client } = yield* adminClient();
  const keys = yield* client.keys.list({});
  if (keys.length === 0) {
    return yield* Console.log("no API keys");
  }
  for (const key of keys) {
    yield* Console.log(`${key.keyId}  ${key.createdAt}  ${key.label}`);
  }
});

const revoke = Effect.gen(function* () {
  const keyId = argv[1];
  if (keyId === undefined || keyId.startsWith("--")) {
    return yield* new StackError({ message: "usage: vpr keys revoke <keyId>" });
  }
  const { client } = yield* adminClient();
  const result = yield* client.keys.revoke({ params: { keyId } });
  yield* Console.log(`revoked ${result.revoked}`);
});

const usage = Console.error(
  "usage: vpr keys <create|list|revoke> [--label <l>] [--save] [--stage <s>]",
).pipe(Effect.andThen(Effect.sync(() => process.exit(1))));

const program =
  command === "create"
    ? create
    : command === "list"
      ? list
      : command === "revoke"
        ? revoke
        : usage;

program.pipe(
  Effect.catchCause((cause) =>
    Console.error(`error: ${cause}`).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1))),
    ),
  ),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
