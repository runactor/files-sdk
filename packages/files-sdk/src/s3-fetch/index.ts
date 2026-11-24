import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3FetchAdapter } from "../internal/s3-fetch.js";
import type { S3FetchAdapter } from "../internal/s3-fetch.js";

export type { S3FetchAdapter } from "../internal/s3-fetch.js";

// The public home of the aws4fetch-signed S3 engine that also powers r2()'s
// `client: "fetch"` mode and hybrid signing. `files-sdk/s3` statically imports
// `@aws-sdk/client-s3` by design (#105), and that SDK's XML parsing needs
// `DOMParser` on browser-targeted bundles — absent on Cloudflare Workers — so
// Workers, Deno Deploy, and browser-adjacent runtimes talking to AWS S3, MinIO,
// Tigris, or any other S3-compatible endpoint reach for this entry instead.
// Same coverage and trade-offs as r2's fetch client: multipart uploads but no
// resumable sessions, per-key bulk deletes, no presigned POST policies.

export interface S3FetchAdapterOptions {
  /** Bucket name. All operations are scoped to it. */
  bucket: string;
  /**
   * Service endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com`,
   * `http://localhost:9000`, or `https://t3.storage.dev`. Only the origin is
   * used — a path component is dropped, so front the service with a host, not
   * a route prefix.
   */
  endpoint: string;
  /**
   * SigV4 signing region. Falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`,
   * then `us-east-1`. Every S3-compatible service needs *some* region in the
   * signature; most ignore it for routing.
   */
  region?: string;
  /**
   * Expose the native conditional writes: `upload({ condition })` as
   * `If-None-Match: *` (create) or `If-Match` (replace), on a single PUT or
   * on the CompleteMultipartUpload of a stream body past one part. Defaults
   * to `true` only for an AWS endpoint (`amazonaws.com`, `amazonaws.com.cn`);
   * set it for an S3-compatible service you know honors the headers (R2 does;
   * Backblaze B2 answers them `501`, which surfaces as `Unsupported`).
   *
   * `copy({ condition })`, a CopyObject pinned to the source's ETag with the
   * destination predicate, is AWS's only: it promises both settle in one
   * step, which R2 documents it does not do (its destination headers are its
   * own and checked apart from the source's) and other services don't
   * document. Elsewhere a conditional copy rejects with `Unsupported`.
   */
  conditional?: boolean;
  /**
   * Static credentials. Falls back to `AWS_ACCESS_KEY_ID`; required if that
   * env var isn't set. No credential chain — there is no IAM role, shared
   * profile, or SSO resolution here, which is what keeps this engine
   * `@aws-sdk/*`-free.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `AWS_SECRET_ACCESS_KEY`; required if
   * that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Session token for temporary credentials. Falls back to
   * `AWS_SESSION_TOKEN`, but only when `accessKeyId` and `secretAccessKey`
   * also come from the environment. Explicit keys never pick up an env token.
   */
  sessionToken?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of the
   * default virtual-hosted style (`https://bucket.endpoint/key`). Set it for
   * MinIO and other self-hosted services without per-bucket DNS, and for
   * bucket names containing dots (virtual-hosted TLS breaks on them).
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — for a public bucket policy or a CDN in front
   * of it. When unset, `url()` falls back to a presigned GetObject. An
   * explicit `url(key, { expiresIn })` or `responseContentDisposition` still
   * presigns, since a permanent link can't expire or carry the override.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when no per-call `expiresIn` is given. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
  /**
   * Override the `fetch` implementation used for every request — for tests,
   * or runtimes that hand out a bound/instrumented fetch. Defaults to
   * `globalThis.fetch`. The adapter's `signedFetch` sends through it too;
   * `raw.fetch` (aws4fetch's own) does not.
   */
  fetch?: (request: Request) => Promise<Response>;
}

export const s3Fetch = (opts: S3FetchAdapterOptions): S3FetchAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("AWS_SECRET_ACCESS_KEY");
  // `AWS_SESSION_TOKEN` belongs to the env key pair. Pairing it with keys
  // passed explicitly (static R2 / MinIO keys on a Lambda or SSO shell, say)
  // would sign with an unrelated token and every request would 403.
  const keysFromEnv =
    opts.accessKeyId === undefined && opts.secretAccessKey === undefined;
  const sessionToken =
    opts.sessionToken ??
    (keysFromEnv ? readEnv("AWS_SESSION_TOKEN") : undefined);
  const region =
    opts.region ?? readEnv("AWS_REGION") ?? readEnv("AWS_DEFAULT_REGION");

  if (!opts.endpoint) {
    throw new FilesError(
      "Invalid",
      "s3-fetch adapter: missing endpoint. Pass `endpoint` (e.g. https://s3.us-east-1.amazonaws.com)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Invalid",
      "s3-fetch adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (there is no credential chain on this client)."
    );
  }

  return s3FetchAdapter({
    accessKeyId,
    bucket: opts.bucket,
    ...(opts.conditional !== undefined && { conditional: opts.conditional }),
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    endpoint: opts.endpoint,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    name: "s3-fetch",
    providerLabel: "S3 error",
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    ...(region && { region }),
    secretAccessKey,
    ...(sessionToken && { sessionToken }),
  });
};
