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
  AbortMultipartUploadCommand,
  ListPartsCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const DEFAULT_PROFILE_ID = "default";
const STORAGE_TARGET_KEY_PREFIX = "__storage-target";

function trimEnv(name = "", fallback = "") {
  return String(process.env[name] || fallback || "").trim();
}

function trimEnvAny(names = [], fallback = "") {
  for (const name of names) {
    const value = trimEnv(name);
    if (value) return value;
  }
  return String(fallback || "").trim();
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

function normalizeProfileId(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || DEFAULT_PROFILE_ID;
}

function parseEndpointHost(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return String(new URL(raw).host || "").trim().toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim()
      .toLowerCase();
  }
}

function providerNameFromHost(host = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!normalizedHost) return "S3-compatible";
  if (normalizedHost.includes("tigris")) return "Fly Tigris";
  if (normalizedHost.includes("r2.cloudflarestorage.com")) return "Cloudflare R2";
  if (normalizedHost.includes("amazonaws.com")) return "AWS S3";
  return "S3-compatible";
}

function buildProfileLabel(providerName = "", region = "", profileId = DEFAULT_PROFILE_ID, isDefault = false) {
  const base = String(providerName || "S3-compatible").trim();
  const regionName = String(region || "").trim();
  if (regionName && regionName.toLowerCase() !== "auto") {
    return `${base} ${regionName}${isDefault ? " (control)" : ""}`;
  }
  return `${base}${isDefault ? " (control)" : ""}`;
}

function buildProfile(profileId = DEFAULT_PROFILE_ID, source = {}) {
  const id = normalizeProfileId(profileId);
  const endpointHost = parseEndpointHost(source.endpoint);
  const providerName = String(source.providerName || "").trim() || providerNameFromHost(endpointHost);
  const region = String(source.region || "auto").trim() || "auto";
  const isDefault = id === DEFAULT_PROFILE_ID;
  return {
    id,
    label: String(source.label || "").trim() || buildProfileLabel(providerName, region, id, isDefault),
    providerName,
    region,
    bucket: String(source.bucket || "").trim(),
    endpoint: String(source.endpoint || "").trim(),
    endpointHost,
    accessKeyId: String(source.accessKeyId || "").trim(),
    secretAccessKey: String(source.secretAccessKey || "").trim(),
    forcePathStyle: Boolean(source.forcePathStyle),
    uploadUrlTtlSec: Math.max(60, Number(source.uploadUrlTtlSec || 15 * 60)),
    downloadUrlTtlSec: Math.max(60, Number(source.downloadUrlTtlSec || 15 * 60)),
    prefix: normalizePrefix(source.prefix),
    intentPrefix: normalizePrefix(source.intentPrefix || "intents"),
    fileHolderPrefix: normalizePrefix(source.fileHolderPrefix || "file-holder")
  };
}

function loadDefaultProfile() {
  return buildProfile(DEFAULT_PROFILE_ID, {
    label: trimEnv("OBJECT_STORAGE_LABEL"),
    providerName: trimEnv("OBJECT_STORAGE_PROVIDER_NAME"),
    bucket: trimEnvAny(["OBJECT_STORAGE_BUCKET", "BUCKET_NAME"]),
    region: trimEnvAny(["OBJECT_STORAGE_REGION", "AWS_REGION"], "auto"),
    endpoint: trimEnvAny(["OBJECT_STORAGE_ENDPOINT", "AWS_ENDPOINT_URL_S3"]),
    accessKeyId: trimEnvAny(["OBJECT_STORAGE_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"]),
    secretAccessKey: trimEnvAny(["OBJECT_STORAGE_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"]),
    forcePathStyle: envFlag("OBJECT_STORAGE_FORCE_PATH_STYLE", false),
    uploadUrlTtlSec: Number(process.env.OBJECT_STORAGE_UPLOAD_URL_TTL_SEC || 15 * 60),
    downloadUrlTtlSec: Number(process.env.OBJECT_STORAGE_DOWNLOAD_URL_TTL_SEC || 15 * 60),
    prefix: trimEnv("OBJECT_STORAGE_PREFIX"),
    intentPrefix: trimEnv("OBJECT_STORAGE_INTENT_PREFIX", "intents"),
    fileHolderPrefix: trimEnv("OBJECT_STORAGE_FILE_HOLDER_PREFIX", "file-holder")
  });
}

function parseBenchmarkTargetIds() {
  return Array.from(new Set(
    String(process.env.OBJECT_STORAGE_BENCH_TARGETS || "")
      .split(",")
      .map((value) => normalizeProfileId(value))
      .filter((value) => value && value !== DEFAULT_PROFILE_ID)
  ));
}

function benchmarkEnvPrefix(profileId = "") {
  return `OBJECT_STORAGE_BENCH_${String(profileId || "").trim().toUpperCase()}_`;
}

function loadBenchmarkProfiles(defaultProfile) {
  return parseBenchmarkTargetIds().map((profileId) => {
    const prefix = benchmarkEnvPrefix(profileId);
    return buildProfile(profileId, {
      label: trimEnv(`${prefix}LABEL`),
      providerName: trimEnv(`${prefix}PROVIDER_NAME`),
      bucket: trimEnv(`${prefix}BUCKET`),
      region: trimEnv(`${prefix}REGION`, defaultProfile.region || "auto"),
      endpoint: trimEnv(`${prefix}ENDPOINT`),
      accessKeyId: trimEnv(`${prefix}ACCESS_KEY_ID`),
      secretAccessKey: trimEnv(`${prefix}SECRET_ACCESS_KEY`),
      forcePathStyle: envFlag(`${prefix}FORCE_PATH_STYLE`, defaultProfile.forcePathStyle),
      uploadUrlTtlSec: Number(process.env[`${prefix}UPLOAD_URL_TTL_SEC`] || defaultProfile.uploadUrlTtlSec),
      downloadUrlTtlSec: Number(process.env[`${prefix}DOWNLOAD_URL_TTL_SEC`] || defaultProfile.downloadUrlTtlSec),
      prefix: trimEnv(`${prefix}PREFIX`, defaultProfile.prefix),
      intentPrefix: trimEnv(`${prefix}INTENT_PREFIX`, defaultProfile.intentPrefix),
      fileHolderPrefix: trimEnv(`${prefix}FILE_HOLDER_PREFIX`, defaultProfile.fileHolderPrefix)
    });
  });
}

function parseTargetIds() {
  return Array.from(new Set(
    String(process.env.OBJECT_STORAGE_TARGETS || "")
      .split(",")
      .map((value) => normalizeProfileId(value))
      .filter((value) => value && value !== DEFAULT_PROFILE_ID)
  ));
}

function targetEnvPrefix(profileId = "") {
  return `OBJECT_STORAGE_TARGET_${String(profileId || "").trim().toUpperCase()}_`;
}

function loadRoutingProfiles(defaultProfile) {
  return parseTargetIds().map((profileId) => {
    const prefix = targetEnvPrefix(profileId);
    return buildProfile(profileId, {
      label: trimEnv(`${prefix}LABEL`),
      providerName: trimEnv(`${prefix}PROVIDER_NAME`),
      bucket: trimEnv(`${prefix}BUCKET`),
      region: trimEnv(`${prefix}REGION`, defaultProfile.region || "auto"),
      endpoint: trimEnv(`${prefix}ENDPOINT`),
      accessKeyId: trimEnv(`${prefix}ACCESS_KEY_ID`),
      secretAccessKey: trimEnv(`${prefix}SECRET_ACCESS_KEY`),
      forcePathStyle: envFlag(`${prefix}FORCE_PATH_STYLE`, defaultProfile.forcePathStyle),
      uploadUrlTtlSec: Number(process.env[`${prefix}UPLOAD_URL_TTL_SEC`] || defaultProfile.uploadUrlTtlSec),
      downloadUrlTtlSec: Number(process.env[`${prefix}DOWNLOAD_URL_TTL_SEC`] || defaultProfile.downloadUrlTtlSec),
      prefix: trimEnv(`${prefix}PREFIX`, defaultProfile.prefix),
      intentPrefix: trimEnv(`${prefix}INTENT_PREFIX`, defaultProfile.intentPrefix),
      fileHolderPrefix: trimEnv(`${prefix}FILE_HOLDER_PREFIX`, defaultProfile.fileHolderPrefix)
    });
  });
}

const defaultProfile = loadDefaultProfile();
const routingProfiles = loadRoutingProfiles(defaultProfile);
const benchmarkProfiles = loadBenchmarkProfiles(defaultProfile);
const profilesById = new Map([
  [defaultProfile.id, defaultProfile],
  ...routingProfiles.map((profile) => [profile.id, profile]),
  ...benchmarkProfiles.map((profile) => [profile.id, profile])
]);
const cachedClients = new Map();

function getProfile(profileId = DEFAULT_PROFILE_ID) {
  const id = normalizeProfileId(profileId);
  return profilesById.get(id) || null;
}

function profileIsEnabled(profile = null) {
  return Boolean(
    profile &&
    profile.bucket &&
    profile.endpoint &&
    profile.accessKeyId &&
    profile.secretAccessKey
  );
}

function isEnabled(profileId = "") {
  const requestedId = String(profileId || "").trim();
  if (!requestedId) {
    return Array.from(profilesById.values()).some((profile) => profileIsEnabled(profile));
  }
  const profile = getProfile(requestedId);
  return profileIsEnabled(profile);
}

function describeProfile(profileId = DEFAULT_PROFILE_ID) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  return {
    id: profile.id,
    label: profile.label,
    providerName: profile.providerName,
    region: profile.region,
    endpointHost: profile.endpointHost,
    bucket: profile.bucket,
    forcePathStyle: Boolean(profile.forcePathStyle),
    enabled: isEnabled(profile.id),
    isDefault: profile.id === DEFAULT_PROFILE_ID
  };
}

function listRoutingTargets() {
  return [defaultProfile, ...routingProfiles].map((profile) => describeProfile(profile.id));
}

function listUploadBenchmarkTargets() {
  const seen = new Set();
  return [defaultProfile, ...routingProfiles, ...benchmarkProfiles]
    .map((profile) => describeProfile(profile.id))
    .filter((profile) => {
      const id = String(profile?.id || "").trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function resolveProfileIdFromObjectKey(objectKey = "") {
  const key = String(objectKey || "").trim().replace(/^\/+/, "");
  if (!key) return DEFAULT_PROFILE_ID;
  const marker = `${STORAGE_TARGET_KEY_PREFIX}/`;
  if (!key.startsWith(marker)) return DEFAULT_PROFILE_ID;
  const remainder = key.slice(marker.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0) return DEFAULT_PROFILE_ID;
  const profileId = normalizeProfileId(remainder.slice(0, slashIndex));
  return getProfile(profileId) ? profileId : DEFAULT_PROFILE_ID;
}

function describeObjectKeyTarget(objectKey = "") {
  return describeProfile(resolveProfileIdFromObjectKey(objectKey));
}

function embedProfileIdInObjectKey(objectKey = "", profileId = DEFAULT_PROFILE_ID) {
  const key = String(objectKey || "").trim().replace(/^\/+/, "");
  const id = normalizeProfileId(profileId);
  if (!key) return key;
  if (key.startsWith(`${STORAGE_TARGET_KEY_PREFIX}/`)) return key;
  if (id === DEFAULT_PROFILE_ID) return key;
  return `${STORAGE_TARGET_KEY_PREFIX}/${id}/${key}`;
}

function resolveProfileIdFromStorageMetadata(source = null) {
  const input = source && typeof source === "object" ? source : {};
  const explicitId = normalizeProfileId(
    input.storageTargetId ||
    input.targetId ||
    input.profileId ||
    ""
  );
  if (explicitId && getProfile(explicitId)) return explicitId;
  return resolveProfileIdFromObjectKey(input.objectKey || input.storedObjectKey || "");
}

function resolveObjectKey(source = null, fallbackObjectKey = "") {
  const input = source && typeof source === "object" ? source : {};
  const rawKey = String(
    input.objectKey ||
    input.storedObjectKey ||
    fallbackObjectKey ||
    ""
  ).trim();
  if (!rawKey) return "";
  if (rawKey.startsWith(`${STORAGE_TARGET_KEY_PREFIX}/`)) return rawKey.replace(/^\/+/, "");
  const profileId = resolveProfileIdFromStorageMetadata(input);
  return embedProfileIdInObjectKey(rawKey, profileId);
}

function buildCanonicalStorageMetadata(source = null, options = {}) {
  const input = source && typeof source === "object" ? source : {};
  const objectKey = resolveObjectKey({
    ...input,
    storageTargetId: options.storageTargetId || input.storageTargetId,
    profileId: options.profileId || input.profileId
  }, options.fallbackObjectKey || "");
  if (!objectKey) return null;
  const profileId = resolveProfileIdFromStorageMetadata({
    ...input,
    objectKey,
    storageTargetId: options.storageTargetId || input.storageTargetId,
    profileId: options.profileId || input.profileId
  });
  const profile = getProfile(profileId) || defaultProfile;
  return {
    storageProvider: String(profile?.providerName || "").trim(),
    storageRegion: String(profile?.region || "").trim(),
    storageTargetId: String(profile?.id || DEFAULT_PROFILE_ID).trim() || DEFAULT_PROFILE_ID,
    storageEndpointHost: String(profile?.endpointHost || "").trim(),
    bucket: String(profile?.bucket || "").trim(),
    objectKey
  };
}

function redactStorageMetadataForDiagnostics(source = null, options = {}) {
  const metadata = buildCanonicalStorageMetadata(source, options);
  if (!metadata) return null;
  return {
    storageProvider: metadata.storageProvider,
    storageRegion: metadata.storageRegion,
    storageTargetId: metadata.storageTargetId,
    storageEndpointHost: metadata.storageEndpointHost,
    bucket: metadata.bucket
  };
}

function client(profileId = DEFAULT_PROFILE_ID) {
  const profile = getProfile(profileId);
  if (!profile || !isEnabled(profile.id)) return null;
  if (cachedClients.has(profile.id)) return cachedClients.get(profile.id);
  const nextClient = new S3Client({
    region: profile.region || "auto",
    endpoint: profile.endpoint,
    forcePathStyle: profile.forcePathStyle,
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey
    }
  });
  cachedClients.set(profile.id, nextClient);
  return nextClient;
}

function clientForObjectKey(objectKey = "") {
  return client(resolveProfileIdFromObjectKey(objectKey));
}

function profileForObjectKey(objectKey = "") {
  return getProfile(resolveProfileIdFromObjectKey(objectKey));
}

function joinKey(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function buildIntentObjectKey(intentId = "", fileName = "", options = {}) {
  const profileId = normalizeProfileId(options?.profileId || DEFAULT_PROFILE_ID);
  const profile = getProfile(profileId) || defaultProfile;
  const baseKey = joinKey(
    profile.prefix,
    profile.intentPrefix,
    sanitizeKeySegment(intentId),
    sanitizeKeySegment(fileName || "file")
  );
  return embedProfileIdInObjectKey(baseKey, profile.id);
}

function buildFileHolderObjectKey(owner = "", itemId = "", fileName = "", options = {}) {
  const profileId = normalizeProfileId(options?.profileId || DEFAULT_PROFILE_ID);
  const profile = getProfile(profileId) || defaultProfile;
  const baseKey = joinKey(
    profile.prefix,
    profile.fileHolderPrefix,
    sanitizeKeySegment(owner || "user"),
    sanitizeKeySegment(itemId),
    sanitizeKeySegment(fileName || "file")
  );
  return embedProfileIdInObjectKey(baseKey, profile.id);
}

async function createUploadUrl(objectKey = "", contentType = "application/octet-stream", expiresInSec = 0) {
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const url = await getSignedUrl(
    clientForObjectKey(key),
    new PutObjectCommand({
      Bucket: profile.bucket,
      Key: key,
      ContentType: String(contentType || "application/octet-stream").trim() || "application/octet-stream"
    }),
    { expiresIn: Math.max(60, Number(expiresInSec || profile.uploadUrlTtlSec)) }
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
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const response = await clientForObjectKey(key).send(new CreateMultipartUploadCommand({
    Bucket: profile.bucket,
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

async function createMultipartUploadPartUrl(objectKey = "", uploadId = "", partNumber = 1, expiresInSec = 0) {
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  const part = Math.max(1, Math.min(10000, Number(partNumber || 0)));
  if (!key || !upload || !Number.isFinite(part)) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const url = await getSignedUrl(
    clientForObjectKey(key),
    new UploadPartCommand({
      Bucket: profile.bucket,
      Key: key,
      UploadId: upload,
      PartNumber: part
    }),
    { expiresIn: Math.max(60, Number(expiresInSec || profile.uploadUrlTtlSec)) }
  );
  return {
    url,
    method: "PUT",
    headers: {}
  };
}

async function completeMultipartUpload(objectKey = "", uploadId = "", parts = []) {
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
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  await clientForObjectKey(key).send(new CompleteMultipartUploadCommand({
    Bucket: profile.bucket,
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
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  if (!key || !upload) return false;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return false;
  try {
    await clientForObjectKey(key).send(new AbortMultipartUploadCommand({
      Bucket: profile.bucket,
      Key: key,
      UploadId: upload
    }));
    return true;
  } catch (err) {
    if (isMissingObjectError(err)) return false;
    throw err;
  }
}

async function listMultipartUploadParts(objectKey = "", uploadId = "") {
  const key = String(objectKey || "").trim();
  const upload = String(uploadId || "").trim();
  if (!key || !upload) return [];
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return [];

  const parts = [];
  let marker = 0;
  while (true) {
    const response = await clientForObjectKey(key).send(new ListPartsCommand({
      Bucket: profile.bucket,
      Key: key,
      UploadId: upload,
      PartNumberMarker: marker > 0 ? marker : undefined
    }));
    const pageParts = Array.isArray(response?.Parts) ? response.Parts : [];
    pageParts.forEach((part) => {
      const number = Math.max(1, Math.min(10000, Number(part?.PartNumber || 0)));
      const etag = String(part?.ETag || "").trim().replace(/"/g, "");
      const size = Math.max(0, Number(part?.Size || 0));
      if (!Number.isFinite(number) || !etag) return;
      parts.push({
        PartNumber: number,
        ETag: etag,
        Size: size
      });
    });
    const truncated = Boolean(response?.IsTruncated);
    const nextMarker = Math.max(0, Number(response?.NextPartNumberMarker || 0));
    if (!truncated || !nextMarker || nextMarker === marker) break;
    marker = nextMarker;
  }

  parts.sort((a, b) => a.PartNumber - b.PartNumber);
  return parts;
}

async function createDownloadUrl(objectKey = "", options = {}) {
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const url = await getSignedUrl(
    clientForObjectKey(key),
    new GetObjectCommand({
      Bucket: profile.bucket,
      Key: key,
      ResponseContentDisposition: options?.contentDisposition,
      ResponseContentType: options?.contentType
    }),
    { expiresIn: Math.max(60, Number(options?.expiresInSec || profile.downloadUrlTtlSec)) }
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
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  try {
    const response = await clientForObjectKey(key).send(new HeadObjectCommand({
      Bucket: profile.bucket,
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
  const key = String(objectKey || "").trim();
  if (!key) return false;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return false;
  try {
    await clientForObjectKey(key).send(new DeleteObjectCommand({
      Bucket: profile.bucket,
      Key: key
    }));
    return true;
  } catch (err) {
    if (isMissingObjectError(err)) return false;
    throw err;
  }
}

async function putFile(objectKey = "", localPath = "", contentType = "application/octet-stream") {
  const key = String(objectKey || "").trim();
  const filePath = String(localPath || "").trim();
  if (!key || !filePath) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const stat = fs.statSync(filePath);
  const body = fs.createReadStream(filePath);
  await clientForObjectKey(key).send(new PutObjectCommand({
    Bucket: profile.bucket,
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
  const key = String(objectKey || "").trim();
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  await clientForObjectKey(key).send(new PutObjectCommand({
    Bucket: profile.bucket,
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
  const key = String(objectKey || "").trim();
  if (!key) return null;
  const profile = profileForObjectKey(key);
  if (!profile || !isEnabled(profile.id)) return null;
  const range = options?.range && typeof options.range === "object"
    ? `bytes=${Math.max(0, Number(options.range.start || 0))}-${Math.max(0, Number(options.range.end || 0))}`
    : undefined;
  const response = await clientForObjectKey(key).send(new GetObjectCommand({
    Bucket: profile.bucket,
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
  const response = await getObjectStream(objectKey);
  if (!response?.body) return null;
  return streamToBuffer(response.body);
}

module.exports = {
  DEFAULT_PROFILE_ID,
  STORAGE_TARGET_KEY_PREFIX,
  config: defaultProfile,
  isEnabled,
  describeProfile,
  listRoutingTargets,
  listUploadBenchmarkTargets,
  resolveProfileIdFromObjectKey,
  resolveProfileIdFromStorageMetadata,
  describeObjectKeyTarget,
  resolveObjectKey,
  buildCanonicalStorageMetadata,
  redactStorageMetadataForDiagnostics,
  buildIntentObjectKey,
  buildFileHolderObjectKey,
  createUploadUrl,
  createMultipartUpload,
  createMultipartUploadPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  listMultipartUploadParts,
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
