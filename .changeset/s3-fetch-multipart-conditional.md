---
"@runactor/files-sdk": minor
---

The S3 `fetch` engine (`files-sdk/s3-fetch`, and R2 / MinIO / RustFS with `client: "fetch"`) now uploads a `ReadableStream` body past one part as a multipart upload in equal parts instead of buffering it whole, and `multipart` splits a buffered body the same way; a failed upload is aborted. `s3Fetch({ conditional: true })` (the default on AWS endpoints) adds conditional create (`If-None-Match: *`), replace (`If-Match`), and copy pinned to the source ETag, carrying the predicate on `CompleteMultipartUpload` for a multipart body; an endpoint that answers `501` rejects with `Unsupported`. The adapter exposes its `endpoint` origin and `forcePathStyle`, and `FileInfo.version` reports the provider's object version (`x-amz-version-id`) from `upload()`, `head()`, and `download()`. The R2 Workers binding adds conditional create and replace through the binding's `onlyIf`.
