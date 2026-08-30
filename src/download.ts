import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

interface FileMetadata {
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { readonly contentType?: string };
}

interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface DownloadBucket<R> {
  head(key: string): Effect.Effect<FileMetadata | null, never, R>;
  get(
    key: string,
    options?: { range: ByteRange },
  ): Effect.Effect<(FileMetadata & { body: ReadableStream<Uint8Array> }) | null, never, R>;
}

// Ignore malformed, unknown-unit and multipart ranges, serving the full file.
// A valid single range that cannot overlap the file gets a 416 instead.
const parseRange = (header: string, size: number): ByteRange | "unsatisfiable" | undefined => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length === 0 ? "unsatisfiable" : { offset: size - length, length };
  }

  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && end < offset) return undefined;
  if (offset >= size) return "unsatisfiable";
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
};

const fileHeaders = (object: FileMetadata) => ({
  "accept-ranges": "bytes",
  "cache-control": "public, max-age=31536000, immutable",
  "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
  etag: object.httpEtag,
});

export const downloadFile = <R>(bucket: DownloadBucket<R>, key: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    let range: ByteRange | undefined;
    const rangeHeader = request.method === "GET" ? request.headers.range : undefined;

    if (request.method === "HEAD" || rangeHeader !== undefined) {
      const metadata = yield* bucket.head(key);
      if (metadata === null) return yield* new HttpApiError.NotFound();

      if (request.method === "HEAD") {
        return HttpServerResponse.empty({
          status: 200,
          headers: { ...fileHeaders(metadata), "content-length": String(metadata.size) },
        });
      }

      // We advertise an ETag, not Last-Modified. Only a matching strong ETag
      // allows If-Range to reuse a partial representation.
      const ifRange = request.headers["if-range"];
      if (rangeHeader !== undefined && (ifRange === undefined || ifRange === metadata.httpEtag)) {
        const parsed = parseRange(rangeHeader, metadata.size);
        if (parsed === "unsatisfiable") {
          return HttpServerResponse.empty({
            status: 416,
            headers: {
              "accept-ranges": "bytes",
              "content-range": `bytes */${metadata.size}`,
            },
          });
        }
        range = parsed;
      }
    }

    // Uploaded keys are immutable. Read only the requested bytes from R2,
    // without downloading or buffering the rest of the video in the Worker.
    const object = yield* bucket.get(key, range ? { range } : undefined);
    if (object === null) return yield* new HttpApiError.NotFound();

    // Preserve R2's native stream, which carries its byte length in workerd.
    // Converting through an Effect stream loses that length and causes the
    // runtime to discard Content-Length, even when the header is set here.
    return HttpServerResponse.raw(object.body, {
      status: range ? 206 : 200,
      contentLength: range?.length ?? object.size,
      headers: {
        ...fileHeaders(object),
        ...(range
          ? {
              "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
            }
          : {}),
      },
    });
  });
