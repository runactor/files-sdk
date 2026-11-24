// An in-memory, path-style S3 endpoint exposed as an injectable `fetch`
// implementation. Backs the s3-fetch core and r2 `client: "fetch"` tests —
// enough of the REST surface (PutObject, GetObject + Range, HeadObject,
// DeleteObject, CopyObject, ListObjectsV2, the multipart upload calls, and the
// If-Match / If-None-Match predicates) to exercise every code path without a
// network.

export interface FakeS3Object {
  bytes: Uint8Array;
  type: string;
  meta: Record<string, string>;
  cacheControl?: string;
  etag: string;
  lastModified: string;
  version?: string;
}

export interface FakeS3Upload {
  key: string;
  headers: Headers;
  parts: Map<number, Uint8Array>;
}

export interface FakeS3 {
  fetchImpl: (request: Request) => Promise<Response>;
  requests: Request[];
  store: Map<string, FakeS3Object>;
  /** When set, the next CopyObject returns 200 with an `<Error>` body. */
  failNextCopyWith200: boolean;
  /** When `true`, every request returns 403 AccessDenied. */
  denyAll: boolean;
  /** When `true`, every write answers a conditional header with 501, as B2 does. */
  conditionalNotImplemented: boolean;
  /** When `true`, every write gets a version id (`x-amz-version-id`). */
  versioned: boolean;
  /** Multipart uploads started and neither completed nor aborted. */
  uploads: Map<string, FakeS3Upload>;
  seed: (key: string, text: string, type?: string) => void;
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const errorXml = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;

const errorResponse = (
  status: number,
  code: string,
  message: string
): Response =>
  new Response(errorXml(code, message), {
    headers: { "content-type": "application/xml" },
    status,
  });

const objectHeaders = (obj: FakeS3Object): Record<string, string> => ({
  ...(obj.version && { "x-amz-version-id": obj.version }),
  "content-length": String(obj.bytes.byteLength),
  "content-type": obj.type,
  etag: `"${obj.etag}"`,
  "last-modified": obj.lastModified,
  ...Object.fromEntries(
    Object.entries(obj.meta).map(([name, value]) => [
      `x-amz-meta-${name}`,
      value,
    ])
  ),
});

const parseRange = (
  header: string,
  size: number
): { start: number; end: number } | null => {
  const match = /^bytes=(?<from>\d+)-(?<to>\d*)$/u.exec(header);
  if (!match?.groups) {
    return null;
  }
  const start = Number(match.groups.from);
  const end = match.groups.to
    ? Math.min(Number(match.groups.to), size - 1)
    : size - 1;
  return { end, start };
};

const listResponse = (
  store: Map<string, FakeS3Object>,
  params: URLSearchParams
): Response => {
  const prefix = params.get("prefix") ?? "";
  const delimiter = params.get("delimiter");
  const maxKeys = Number(params.get("max-keys") ?? 1000);
  const token = params.get("continuation-token");
  const matching = [...store.keys()]
    .filter((key) => key.startsWith(prefix))
    .toSorted();
  const contents: string[] = [];
  const prefixes = new Set<string>();
  let truncated = false;
  let nextToken = "";
  for (const key of matching) {
    if (token && key <= token) {
      continue;
    }
    if (delimiter) {
      const rest = key.slice(prefix.length);
      const at = rest.indexOf(delimiter);
      if (at !== -1) {
        prefixes.add(prefix + rest.slice(0, at + delimiter.length));
        continue;
      }
    }
    if (contents.length >= maxKeys) {
      truncated = true;
      break;
    }
    const obj = store.get(key) as FakeS3Object;
    contents.push(
      `<Contents><Key>${escapeXml(key)}</Key><Size>${obj.bytes.byteLength}</Size><ETag>&quot;${obj.etag}&quot;</ETag><LastModified>${new Date(obj.lastModified).toISOString()}</LastModified></Contents>`
    );
    nextToken = key;
  }
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>`,
    `<IsTruncated>${truncated}</IsTruncated>`,
    truncated
      ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>`
      : "",
    ...contents,
    ...[...prefixes].map(
      (p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`
    ),
    "</ListBucketResult>",
  ].join("");
  return new Response(xml, {
    headers: { "content-type": "application/xml" },
    status: 200,
  });
};

const metaHeaders = (headers: Headers): Record<string, string> => {
  const meta: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith("x-amz-meta-")) {
      meta[name.slice("x-amz-meta-".length)] = value;
    }
  }
  return meta;
};

const precondition = (): Response =>
  errorResponse(
    412,
    "PreconditionFailed",
    "At least one of the pre-conditions you specified did not hold"
  );

/** Whether `headers`' If-None-Match / If-Match hold against `current`. */
const holds = (
  headers: Headers,
  current: FakeS3Object | undefined
): boolean => {
  const ifNoneMatch = headers.get("if-none-match");
  const ifMatch = headers.get("if-match");
  if (ifNoneMatch === "*" && current) {
    return false;
  }
  return ifMatch === null || ifMatch === `"${current?.etag}"`;
};

const hasPredicate = (headers: Headers): boolean =>
  headers.has("if-none-match") || headers.has("if-match");

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const written = (object: FakeS3Object): Record<string, string> => ({
  ...(object.version && { "x-amz-version-id": object.version }),
});

const notImplemented = (): Response =>
  errorResponse(
    501,
    "NotImplemented",
    "A header you provided implies functionality that is not implemented"
  );

export const makeFakeS3 = (bucket = "uploads"): FakeS3 => {
  const store = new Map<string, FakeS3Object>();
  const uploads = new Map<string, FakeS3Upload>();
  const requests: Request[] = [];
  const flags = {
    conditionalNotImplemented: false,
    failNextCopyWith200: false,
    versioned: false,
  };
  let nextEtag = 0;
  let nextUpload = 0;

  const stamp = (): { etag: string; version?: string } => {
    nextEtag += 1;
    return {
      etag: `etag-${nextEtag}`,
      ...(flags.versioned && { version: `v-${nextEtag}` }),
    };
  };

  const multipart = async (
    request: Request,
    url: URL,
    key: string
  ): Promise<Response | undefined> => {
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      nextUpload += 1;
      const uploadId = `up&${nextUpload}`;
      uploads.set(uploadId, {
        headers: request.headers,
        key,
        parts: new Map(),
      });
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${escapeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`
      );
    }
    const uploadId = url.searchParams.get("uploadId");
    if (uploadId === null) {
      return;
    }
    const upload = uploads.get(uploadId);
    if (!upload) {
      return errorResponse(404, "NoSuchUpload", "No such upload");
    }
    if (request.method === "PUT") {
      const partNumber = Number(url.searchParams.get("partNumber"));
      upload.parts.set(partNumber, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { headers: { etag: `"part-${partNumber}"` } });
    }
    if (request.method === "DELETE") {
      uploads.delete(uploadId);
      return new Response(null, { status: 204 });
    }
    if (flags.conditionalNotImplemented && hasPredicate(request.headers)) {
      return notImplemented();
    }
    if (!holds(request.headers, store.get(key))) {
      return precondition();
    }
    const body = await request.text();
    const listed = [
      ...body.matchAll(/<PartNumber>(?<n>\d+)<\/PartNumber>/gu),
    ].map(
      (match) => upload.parts.get(Number(match.groups?.n)) ?? new Uint8Array()
    );
    uploads.delete(uploadId);
    const object: FakeS3Object = {
      bytes: concat(listed),
      ...stamp(),
      lastModified: new Date().toUTCString(),
      meta: metaHeaders(upload.headers),
      type: upload.headers.get("content-type") ?? "application/octet-stream",
    };
    store.set(key, object);
    return new Response(
      `<CompleteMultipartUploadResult><ETag>&quot;${object.etag}&quot;</ETag></CompleteMultipartUploadResult>`,
      { headers: written(object) }
    );
  };

  const put = async (request: Request, key: string): Promise<Response> => {
    if (flags.conditionalNotImplemented && hasPredicate(request.headers)) {
      return notImplemented();
    }
    // AWS's contract: a CopyObject's destination `If-None-Match` / `If-Match`
    // and its `x-amz-copy-source-if-match` are checked in the one request
    // that commits it. Only an AWS-endpoint adapter advertises the copy.
    if (!holds(request.headers, store.get(key))) {
      return precondition();
    }
    const copySource = request.headers.get("x-amz-copy-source");
    if (copySource) {
      if (flags.failNextCopyWith200) {
        flags.failNextCopyWith200 = false;
        return new Response(
          errorXml("InternalError", "Copy failed mid-flight"),
          { status: 200 }
        );
      }
      const sourceKey = decodeURIComponent(
        copySource.replace(`/${bucket}/`, "")
      );
      const source = store.get(sourceKey);
      if (!source) {
        return errorResponse(404, "NoSuchKey", "No such key");
      }
      const pinned = request.headers.get("x-amz-copy-source-if-match");
      if (pinned !== null && pinned !== `"${source.etag}"`) {
        return precondition();
      }
      const copied = { ...source, ...stamp() };
      store.set(key, copied);
      return new Response(
        `<CopyObjectResult><ETag>&quot;${copied.etag}&quot;</ETag></CopyObjectResult>`,
        { headers: written(copied), status: 200 }
      );
    }
    const cacheControl = request.headers.get("cache-control");
    const object: FakeS3Object = {
      bytes: new Uint8Array(await request.arrayBuffer()),
      ...(cacheControl && { cacheControl }),
      ...stamp(),
      lastModified: new Date().toUTCString(),
      meta: metaHeaders(request.headers),
      type: request.headers.get("content-type") ?? "application/octet-stream",
    };
    store.set(key, object);
    return new Response(null, {
      headers: { etag: `"${object.etag}"`, ...written(object) },
      status: 200,
    });
  };

  const fake: FakeS3 = {
    get conditionalNotImplemented() {
      return flags.conditionalNotImplemented;
    },
    set conditionalNotImplemented(value) {
      flags.conditionalNotImplemented = value;
    },
    denyAll: false,
    get failNextCopyWith200() {
      return flags.failNextCopyWith200;
    },
    set failNextCopyWith200(value) {
      flags.failNextCopyWith200 = value;
    },
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- a flat method+path dispatch table; splitting it hides the request routing this fake exists to model
    fetchImpl: (request: Request): Promise<Response> => {
      requests.push(request);
      const respond = async (): Promise<Response> => {
        if (fake.denyAll) {
          return errorResponse(403, "AccessDenied", "Access Denied");
        }
        const url = new URL(request.url);
        if (
          url.pathname !== `/${bucket}` &&
          !url.pathname.startsWith(`/${bucket}/`)
        ) {
          return errorResponse(404, "NoSuchBucket", "No such bucket");
        }
        const key = decodeURIComponent(
          url.pathname.slice(`/${bucket}/`.length)
        );
        if (request.method === "GET" && url.searchParams.has("list-type")) {
          return listResponse(store, url.searchParams);
        }
        const multipartResponse = await multipart(request, url, key);
        if (multipartResponse) {
          return multipartResponse;
        }
        if (request.method === "PUT") {
          return put(request, key);
        }
        if (request.method === "DELETE") {
          store.delete(key);
          return new Response(null, { status: 204 });
        }
        // GET / HEAD on an object.
        const obj = store.get(key);
        if (!obj) {
          return request.method === "HEAD"
            ? new Response(null, { status: 404 })
            : errorResponse(404, "NoSuchKey", "No such key");
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: objectHeaders(obj),
            status: 200,
          });
        }
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          const range = parseRange(rangeHeader, obj.bytes.byteLength);
          if (range) {
            const slice = obj.bytes.slice(range.start, range.end + 1);
            return new Response(slice, {
              headers: {
                ...objectHeaders(obj),
                "content-length": String(slice.byteLength),
                "content-range": `bytes ${range.start}-${range.end}/${obj.bytes.byteLength}`,
              },
              status: 206,
            });
          }
        }
        return new Response(new Uint8Array(obj.bytes), {
          headers: objectHeaders(obj),
          status: 200,
        });
      };
      return respond();
    },
    requests,
    seed: (key, text, type = "text/plain") => {
      nextEtag += 1;
      store.set(key, {
        bytes: new TextEncoder().encode(text),
        etag: `etag-${nextEtag}`,
        lastModified: new Date().toUTCString(),
        meta: {},
        type,
      });
    },
    store,
    uploads,
    get versioned() {
      return flags.versioned;
    },
    set versioned(value) {
      flags.versioned = value;
    },
  };
  return fake;
};
