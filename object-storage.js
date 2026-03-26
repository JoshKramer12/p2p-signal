const fs = require("fs");
const { pipeline } = require("stream/promises");
const {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function trimEnv(name = "", fallback = "") {
  return String(process.env[name] || fallback || "").trim();
}

function envFlag(name = "", fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function normalizePrefix(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function sanitizeKeySegment(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

let cachedClient = null;

const config = {
  bucket: trimEnv("OBJECT_STORAGE_BUCKET"),
  region: trimEnv("OBJECT_STORAGE_REGION", "auto"),
  endpoint: trimEnv("OBJECT_STORAGE_ENDPOINT"),
  accessKeyId: trimEnv("OBJECT_STORAGE_ACCESS_KEY_ID"),
  secretAccessKey: trimEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
  forcePathStyle: envFlag("OBJECT_STORAGE_FORCE_PATH_STYLE", false),
  uploadUrlTtlSec: Math.max(60, Number(process.env.OBJECT_STORAGE_UPLOAD_URL_TTL_SEC || 15 * 60)),
  downloadUrlTtlSec: Math.max(60, Number(process.env.OBJECT_STORAGE_DOWNLOAD_URL_TTL_SEC || 15 * 60)),
  prefix: normalizePrefix(trimEnv("OBJECT_STORAGE_PREFIX")),
  intentPrefix: normalizePrefix(trimEnv("OBJECT_STORAGE_INTENT_PREFIX", "intents")),
  fileHolderPrefix: normalizePrefix(trimEnv("OBJECT_STORAGE_FILE_HOLDER_PREFIX", "file-holder"))
};

function isEnabled() {
  return Boolean(
    config.bucket &&
    config.endpoint &&
    config.accessKeyId &&
    config.secretAccessKey
  );
}

function client() {
  if (!isEnabled()) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  return cachedClient;
}

function joinKey(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function buildIntentObjectKey(intentId = "", fileName = "") {
  return joinKey(
    config.prefix,
    config.intentPrefix,
    sanitizeKeySegment(intentId),
    sanitizeKeySegment(fileName || "file")
  );
}

function buildFileHolderObjectKey(owner = "", itemId = "", fileName = "") {
  return joinKey(
    config.prefix,
    config.fileHolderPrefix,
    sanitizeKeySegment(owner || "user"),
    sanitizeKeySegment(itemId),
    sanitizeKeySegment(fileName || "file")
  );
}

async function createUploadUrl(objectKey = "", contentType = "application/octet-stream", expiresInSec = config.uploadUrlTtlSec) {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const url = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: String(contentType || "application/octet-stream").trim() || "application/octet-stream"
    }),
    { expiresIn: Math.max(60, Number(expiresInSec || config.uploadUrlTtlSec)) }
  );
  return {
    url,
    method: "PUT",
    headers: {
      "content-type": String(contentType || "application/octet-stream").trim() || "application/octet-stream"
    }
  };
}

async function createMultipartUpload(objectKey = "", contentType = "application/octet-stream") {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const response = await client().send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: String(contentType || "application/octet-stream").trim() || "application/octet-stream"
  }));
  const uploadId = String(response?.UploadId || "").trim();
  if (!uploadId) return null;
  return {
    key,
    uploadId
  };
}

async function createMultipartUploadPartUrl(objectKey = "", uploadId = "", partNumber = 1, expiresInSec = config.uploadUrlTtlSec) {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  const part = Math.max(1, Math.min(10000, Number(partNumber || 0)));
  if (!key || !upload || !Number.isFinite(part)) return null;
  const url = await getSignedUrl(
    client(),
    new UploadPartCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: upload,
      PartNumber: part
    }),
    { expiresIn: Math.max(60, Number(expiresInSec || config.uploadUrlTtlSec)) }
  );
  return {
    url,
    method: "PUT",
    headers: {}
  };
}

async function completeMultipartUpload(objectKey = "", uploadId = "", parts = []) {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  const normalizedParts = Array.isArray(parts)
    ? parts
      .map((part) => ({
        PartNumber: Math.max(1, Math.min(10000, Number(part?.PartNumber || part?.partNumber || 0))),
        ETag: String(part?.ETag || part?.etag || "").trim()
      }))
      .filter((part) => Number.isFinite(part.PartNumber) && part.ETag)
      .sort((a, b) => a.PartNumber - b.PartNumber)
    : [];
  if (!key || !upload || !normalizedParts.length) return null;
  await client().send(new CompleteMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: upload,
    MultipartUpload: {
      Parts: normalizedParts
    }
  }));
  return {
    key,
    uploadId: upload,
    parts: normalizedParts.length
  };
}

async function abortMultipartUpload(objectKey = "", uploadId = "") {
  if (!isEnabled()) return false;
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  if (!key || !upload) return false;
  try {
    await client().send(new AbortMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: upload
    }));
    return true;
  } catch (err) {
    if (isMissingObjectError(err)) return false;
    throw err;
  }
}

async function createDownloadUrl(objectKey = "", options = {}) {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const url = await getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ResponseContentDisposition: options?.contentDisposition,
      ResponseContentType: options?.contentType
    }),
    { expiresIn: Math.max(60, Number(options?.expiresInSec || config.downloadUrlTtlSec)) }
  );
  return url;
}

function isMissingObjectError(err) {
  const code = String(err?.name || err?.Code || err?.code || err?.$metadata?.httpStatusCode || "").trim();
  return (
    code === "404" ||
    code === "NotFound" ||
    code === "NoSuchKey" ||
    Number(err?.$metadata?.httpStatusCode || 0) === 404
  );
}

async function headObject(objectKey = "") {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  if (!key) return null;
  try {
    const response = await client().send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key
    }));
    return {
      key,
      size: Math.max(0, Number(response?.ContentLength || 0)),
      contentType: String(response?.ContentType || "").trim(),
      etag: String(response?.ETag || "").replace(/"/g, ""),
      lastModified: response?.LastModified ? new Date(response.LastModified).getTime() : 0
    };
  } catch (err) {
    if (isMissingObjectError(err)) return null;
    throw err;
  }
}

async function deleteObject(objectKey = "") {
  if (!isEnabled()) return false;
  const key = String(objectKey || "").trim();
  if (!key) return false;
  try {
    await client().send(new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key
    }));
    return true;
  } catch (err) {
    if (isMissingObjectError(err)) return false;
    throw err;
  }
}

async function putFile(objectKey = "", localPath = "", contentType = "application/octet-stream") {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  const filePath = String(localPath || "").trim();
  if (!key || !filePath) return null;
  const stat = fs.statSync(filePath);
  const body = fs.createReadStream(filePath);
  await client().send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: String(contentType || "application/octet-stream").trim() || "application/octet-stream",
    ContentLength: Math.max(0, Number(stat?.size || 0))
  }));
  return {
    key,
    size: Math.max(0, Number(stat?.size || 0))
  };
}

async function putBuffer(objectKey = "", buffer = Buffer.alloc(0), contentType = "application/octet-stream") {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!key) return null;
  await client().send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: String(contentType || "application/octet-stream").trim() || "application/octet-stream",
    ContentLength: body.length
  }));
  return {
    key,
    size: body.length
  };
}

async function getObjectStream(objectKey = "", options = {}) {
  if (!isEnabled()) return null;
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const range = options?.range && typeof options.range === "object"
    ? `bytes=${Math.max(0, Number(options.range.start || 0))}-${Math.max(0, Number(options.range.end || 0))}`
    : undefined;
  const response = await client().send(new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Range: range
  }));
  return {
    body: response?.Body || null,
    size: Math.max(0, Number(response?.ContentLength || 0)),
    contentType: String(response?.ContentType || "").trim(),
    etag: String(response?.ETag || "").replace(/"/g, ""),
    lastModified: response?.LastModified ? new Date(response.LastModified).getTime() : 0,
    contentRange: String(response?.ContentRange || "").trim()
  };
}

async function downloadObjectToFile(objectKey = "", outputPath = "") {
  if (!isEnabled()) return null;
  const targetPath = String(outputPath || "").trim();
  if (!targetPath) return null;
  const response = await getObjectStream(objectKey);
  if (!response?.body) return null;
  await pipeline(response.body, fs.createWriteStream(targetPath));
  return targetPath;
}

async function streamToBuffer(readable = null) {
  if (!readable) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readObjectBuffer(objectKey = "") {
  if (!isEnabled()) return null;
  const response = await getObjectStream(objectKey);
  if (!response?.body) return null;
  return streamToBuffer(response.body);
}

module.exports = {
  config,
  isEnabled,
  buildIntentObjectKey,
  buildFileHolderObjectKey,
  createUploadUrl,
  createMultipartUpload,
  createMultipartUploadPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  createDownloadUrl,
  headObject,
  deleteObject,
  putFile,
  putBuffer,
  getObjectStream,
  downloadObjectToFile,
  readObjectBuffer,
  sanitizeKeySegment
};
