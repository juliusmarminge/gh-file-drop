import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import { FilesGroup } from "./api.ts";
import { downloadFile, type DownloadBucket } from "./download.ts";

const testApi = HttpApi.make("test").add(
  HttpApiGroup.make("files").add(FilesGroup.endpoints.download),
);
const key = "0123456789abcdef/video.mp4";
const url = `https://ghdrop.test/f/${key}`;
const contents = new TextEncoder().encode("0123456789");
const metadata = {
  size: contents.length,
  httpEtag: '"video-etag"',
  httpMetadata: { contentType: "video/mp4" },
};
const fileSystem = FileSystem.layerNoop({});
const platform = Layer.mergeAll(
  fileSystem,
  HttpPlatform.layer.pipe(Layer.provide(fileSystem)),
  Etag.layerWeak,
  Path.layer,
);

const setup = (
  options: { missing?: boolean; deletedAfterHead?: boolean; empty?: boolean } = {},
) => {
  const bytes = options.empty ? new Uint8Array() : contents;
  const object = { ...metadata, size: bytes.length };
  const head = mock.fn<DownloadBucket<never>["head"]>(() =>
    Effect.succeed(options.missing ? null : object),
  );
  const get = mock.fn<DownloadBucket<never>["get"]>((_key, options_) => {
    if (options.missing || options.deletedAfterHead) return Effect.succeed(null);
    const range = options_?.range;
    return Effect.succeed({
      ...object,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            range ? bytes.slice(range.offset, range.offset + range.length) : bytes,
          );
          controller.close();
        },
      }),
    });
  });
  const handlers = HttpApiBuilder.group(testApi, "files", (handlers) =>
    handlers.handle("download", ({ params }) =>
      downloadFile({ head, get }, `${params.id}/${params.name}`),
    ),
  );
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(testApi).pipe(Layer.provide(handlers), Layer.provide(platform)),
    { disableLogger: true },
  );
  return { ...app, head, get };
};

await test("ordinary downloads stream the full file and advertise ranges", async (t) => {
  const app = setup();
  t.after(app.dispose);
  const response = await app.handler(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("etag"), metadata.httpEtag);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await response.text(), "0123456789");
  assert.equal(app.head.mock.callCount(), 0);
});

for (const [range, expected, offset] of [
  ["bytes=0-1", "01", 0],
  ["bytes=4-6", "456", 4],
  ["bytes=7-", "789", 7],
  ["bytes=-3", "789", 7],
  ["bytes=8-100", "89", 8],
  ["bytes=-100", "0123456789", 0],
  ["bytes=0-", "0123456789", 0],
  ["bytes=9-9", "9", 9],
  ["bytes=8-9999999999999999999999999", "89", 8],
  ["bytes=-9999999999999999999999999", "0123456789", 0],
  ["BYTES=0-1", "01", 0],
] as const) {
  await test(`${range} returns only the requested bytes with 206`, async (t) => {
    const app = setup();
    t.after(app.dispose);
    const response = await app.handler(new Request(url, { headers: { range } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-length"), String(expected.length));
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${offset}-${offset + expected.length - 1}/10`,
    );
    assert.equal(response.headers.get("etag"), metadata.httpEtag);
    assert.equal(await response.text(), expected);
    assert.deepEqual(app.head.mock.calls[0].arguments, [key]);
    assert.deepEqual(app.get.mock.calls[0].arguments, [
      key,
      { range: { offset, length: expected.length } },
    ]);
  });
}

for (const range of [
  "bytes=10-",
  "bytes=100-200",
  "bytes=-0",
  "bytes=9999999999999999999999999-",
]) {
  await test(`${range} returns 416 without reading a body`, async (t) => {
    const app = setup();
    t.after(app.dispose);
    const response = await app.handler(new Request(url, { headers: { range } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(await response.text(), "");
    assert.equal(app.get.mock.callCount(), 0);
  });
}

for (const range of [
  "bytes=bad",
  "bytes=-",
  "bytes=5-2",
  "items=0-1",
  "bytes=0-1,4-5",
  "bytes=1.5-3",
]) {
  await test(`${range} falls back to a full 200 response`, async (t) => {
    const app = setup();
    t.after(app.dispose);
    const response = await app.handler(new Request(url, { headers: { range } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-range"), null);
    assert.equal(await response.text(), "0123456789");
    assert.deepEqual(app.get.mock.calls[0].arguments, [key, undefined]);
  });
}

for (const ifRange of [
  metadata.httpEtag,
  '"old-etag"',
  `W/${metadata.httpEtag}`,
  "Sun, 30 Aug 2026 12:00:00 GMT",
]) {
  await test(`If-Range ${ifRange} requires a matching strong ETag`, async (t) => {
    const app = setup();
    t.after(app.dispose);
    const response = await app.handler(
      new Request(url, { headers: { range: "bytes=0-1", "if-range": ifRange } }),
    );
    const matches = ifRange === metadata.httpEtag;
    assert.equal(response.status, matches ? 206 : 200);
    assert.equal(await response.text(), matches ? "01" : "0123456789");
  });
}

await test("HEAD ignores Range and returns metadata without fetching the body", async (t) => {
  const app = setup();
  t.after(app.dispose);
  const response = await app.handler(
    new Request(url, { method: "HEAD", headers: { range: "bytes=100-" } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(await response.text(), "");
  assert.equal(app.get.mock.callCount(), 0);
});

for (const range of [undefined, "bytes=0-1"]) {
  await test(`missing files return 404 with range ${range}`, async (t) => {
    const app = setup({ missing: true });
    t.after(app.dispose);
    const response = await app.handler(new Request(url, { headers: range ? { range } : {} }));
    assert.equal(response.status, 404);
    await response.text();
  });
}

await test("a file deleted between head and get still returns 404", async (t) => {
  const app = setup({ deletedAfterHead: true });
  t.after(app.dispose);
  const response = await app.handler(new Request(url, { headers: { range: "bytes=0-1" } }));
  assert.equal(response.status, 404);
  await response.text();
});

await test("a range on an empty object returns 416", async (t) => {
  const app = setup({ empty: true });
  t.after(app.dispose);
  const response = await app.handler(new Request(url, { headers: { range: "bytes=0-1" } }));
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */0");
  assert.equal(app.get.mock.callCount(), 0);
});
