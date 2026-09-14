const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');

const RECORD_KEY = /^(?:mlbhr:(?:(?:raw|checkpoint|discovery|top100|failure):\d{4}-\d{2}-\d{2}(?::(?:0817|1117|1717|2017))?|latest|top100:latest|triples-model:(?:\d{4}-\d{2}-\d{2}|latest|state:latest|state:\d{4}-\d{2}-\d{2}-[a-f0-9]{16}:part-\d{3}\.bin))|mlb(?:triples|strikeouts|tb2|doubles):checkpoint:\d{4}-\d{2}-\d{2}:(?:0817|1117|1717|2017)|mlbtb2:frozen-selections:\d{4}-\d{2}-\d{2}:0817)$/;
const LEASE_KEY = /^(?:mlbhr:attempt:\d{4}-\d{2}-\d{2}:(?:0817|1117|1717|2017)|mlbhr:top100-lock:\d{4}-\d{2}-\d{2}|mlbhr:triples-model:lock:\d{4}-\d{2}-\d{2}|archive-maintenance)$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const encodedKey = (key) => Buffer.from(key).toString('base64url');
const isConflict = (error) => [409, 412].includes(error?.$metadata?.httpStatusCode || error?.status);
const isMissing = (error) => error?.$metadata?.httpStatusCode === 404 || error?.status === 404 || error?.name === 'NoSuchKey';

function archiveConfig() {
  const mode = process.env.ARCHIVE_MODE || 'off';
  if (!['off', 'mirror', 'active'].includes(mode)) throw new Error('ARCHIVE_MODE must be off, mirror or active');
  const names = ['ARCHIVE_R2_ENDPOINT', 'ARCHIVE_R2_BUCKET', 'ARCHIVE_R2_ACCESS_KEY_ID', 'ARCHIVE_R2_SECRET_ACCESS_KEY'];
  const missing = names.filter((name) => !process.env[name]);
  return { mode, configured: missing.length === 0, missing,
    hotDays: Math.max(1, Math.min(14, Number(process.env.ARCHIVE_HOT_DAYS) || 14)) };
}

class S3Transport {
  constructor() {
    const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const endpoint = new URL(process.env.ARCHIVE_R2_ENDPOINT);
    if (endpoint.protocol !== 'https:') throw new Error('Archive endpoint must use HTTPS');
    this.commands = { GetObjectCommand, PutObjectCommand, DeleteObjectCommand };
    this.bucket = process.env.ARCHIVE_R2_BUCKET;
    this.client = new S3Client({ region: 'auto', endpoint: endpoint.href, forcePathStyle: true,
      credentials: { accessKeyId: process.env.ARCHIVE_R2_ACCESS_KEY_ID, secretAccessKey: process.env.ARCHIVE_R2_SECRET_ACCESS_KEY },
      maxAttempts: 3, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  }
  async get(key, { timeoutMs = 10000 } = {}) {
    try {
      const result = await this.client.send(new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      return { body: Buffer.from(await result.Body.transformToByteArray()), etag: result.ETag };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async put(key, body, { etag, absent = false } = {}) {
    return this.client.send(new this.commands.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body,
      ContentType: 'application/octet-stream', CacheControl: 'private, no-store',
      ...(etag ? { IfMatch: etag } : {}), ...(absent ? { IfNoneMatch: '*' } : {}) }), { abortSignal: AbortSignal.timeout(30000) });
  }
  async remove(key) {
    if (!key.startsWith('mlb-archive/v1/control/probe/')) throw new Error('Archive object deletion is restricted to health probes');
    return this.client.send(new this.commands.DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
  }
}

class ObjectArchive {
  constructor(transport, { now = () => Date.now() } = {}) { this.transport = transport; this.now = now; }
  root(key) {
    if (!RECORD_KEY.test(key)) throw new Error('Key is not an archival record');
    return `mlb-archive/v1/records/${encodedKey(key)}`;
  }
  async head(key) {
    const result = await this.transport.get(`${this.root(key)}/head.json`, { timeoutMs: 3000 });
    if (!result) return null;
    const head = JSON.parse(result.body.toString('utf8'));
    if (head.key !== key || !/^[a-f0-9]{64}$/.test(head.sha256)) throw new Error('Archive pointer integrity failure');
    return { ...head, etag: result.etag };
  }
  async readVersion(key, sha256) {
    const result = await this.transport.get(`${this.root(key)}/versions/${sha256}.json.gz`);
    if (!result) throw new Error('Archive version is missing');
    const record = JSON.parse(gunzipSync(result.body).toString('utf8'));
    if (record.key !== key || record.sha256 !== sha256 || typeof record.value !== 'string' || digest(record.value) !== sha256) {
      throw new Error('Archive record integrity failure');
    }
    return record.value;
  }
  async read(key) { const head = await this.head(key); return head ? this.readVersion(key, head.sha256) : null; }
  async write(key, value, { onlyIfAbsent = false } = {}) {
    if (typeof value !== 'string') throw new Error('Archive values must be strings');
    const sha256 = digest(value);
    const root = this.root(key);
    const versionKey = `${root}/versions/${sha256}.json.gz`;
    const record = { schemaVersion: 1, key, sha256, value, archivedAt: new Date(this.now()).toISOString() };
    try { await this.transport.put(versionKey, gzipSync(JSON.stringify(record)), { absent: true }); }
    catch (error) { if (!isConflict(error)) throw error; }
    // Read back the permanent bytes before publishing a pointer or changing TTL.
    if (await this.readVersion(key, sha256) !== value) throw new Error('Archive verification failed');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.head(key);
      if (current && onlyIfAbsent) return { written: false, sha256, currentSha256: current.sha256 };
      if (current?.sha256 === sha256) return { written: true, sha256 };
      const pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, key, sha256, updatedAt: record.archivedAt }));
      try {
        await this.transport.put(`${root}/head.json`, pointer, current ? { etag: current.etag } : { absent: true });
        return { written: true, sha256 };
      } catch (error) { if (!isConflict(error)) throw error; }
    }
    throw new Error('Archive update conflicted repeatedly');
  }
  async acquireLease(key, value, seconds) {
    if (!LEASE_KEY.test(key)) throw new Error('Unsupported lease key');
    const objectKey = `mlb-archive/v1/leases/${encodedKey(key)}.json`;
    const previous = await this.transport.get(objectKey);
    if (previous && JSON.parse(previous.body).expiresAt > this.now()) return false;
    const body = Buffer.from(JSON.stringify({ key, value, expiresAt: this.now() + seconds * 1000 }));
    try { await this.transport.put(objectKey, body, previous ? { etag: previous.etag } : { absent: true }); return true; }
    catch (error) { if (isConflict(error)) return false; throw error; }
  }
  async readLease(key) {
    if (!LEASE_KEY.test(key)) throw new Error('Unsupported lease key');
    const result = await this.transport.get(`mlb-archive/v1/leases/${encodedKey(key)}.json`);
    if (!result) return null;
    const lease = JSON.parse(result.body);
    return lease.expiresAt > this.now() ? lease.value : null;
  }
  async releaseLease(key, owner) {
    if (!LEASE_KEY.test(key)) throw new Error('Unsupported lease key');
    const objectKey = `mlb-archive/v1/leases/${encodedKey(key)}.json`;
    const previous = await this.transport.get(objectKey);
    if (!previous) return false;
    const lease = JSON.parse(previous.body);
    if (lease.value !== owner) return false;
    try { await this.transport.put(objectKey, Buffer.from(JSON.stringify({ ...lease, expiresAt: 0 })), { etag: previous.etag }); return true; }
    catch (error) { if (isConflict(error)) return false; throw error; }
  }
  async readControl(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid control name');
    const result = await this.transport.get(`mlb-archive/v1/control/${name}.json`);
    return result ? JSON.parse(result.body) : null;
  }
  async writeControl(name, value) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid control name');
    await this.transport.put(`mlb-archive/v1/control/${name}.json`, Buffer.from(JSON.stringify(value)));
  }
}

let instance;
function getArchive() {
  const config = archiveConfig();
  if (config.mode === 'off') return null;
  if (!config.configured) throw new Error(`Archive configuration missing: ${config.missing.join(', ')}`);
  if (!instance) instance = new ObjectArchive(new S3Transport());
  return instance;
}

function cacheSeconds(key, value, now = Date.now()) {
  const days = archiveConfig().hotDays;
  let date = key.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) {
    try {
      const payload = JSON.parse(require('./redis-value-codec').decodeRedisValue(value));
      date = payload.date || payload.slate_date || payload.state_as_of;
    } catch { /* Undated pointers use a bounded cache lifetime. */ }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return days * 86400;
  // UTC midnight is conservative in both Eastern DST and standard time.
  return Math.max(0, Math.min(days * 86400, Math.floor((Date.parse(`${date}T00:00:00Z`) + days * 86400000 - now) / 1000)));
}

module.exports = { ObjectArchive, S3Transport, archiveConfig, getArchive, cacheSeconds, digest,
  isRecordKey: (key) => RECORD_KEY.test(String(key)), isLeaseKey: (key) => LEASE_KEY.test(String(key)) };
