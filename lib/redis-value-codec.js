const zlib = require('node:zlib');

const PREFIX = 'mlbbr1:';
const OPTIONS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
const JSON_KEYS = /^(?:mlbhr:(?:checkpoint:|discovery:|top100:|latest$)|mlb(?:triples|strikeouts|tb2|doubles):checkpoint:)/;
const RAW_KEYS = /^mlbhr:raw:\d{4}-\d{2}-\d{2}:(?:0817|1117|1717|2017)$/;

function isCompressibleKey(key) {
  return JSON_KEYS.test(String(key)) || RAW_KEYS.test(String(key));
}

function isCompressedPrefix(value) {
  return String(value).startsWith(PREFIX) || /"responseEncoding"\s*:\s*"br\+base64"/.test(String(value));
}

function decodeRedisValue(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  return zlib.brotliDecompressSync(Buffer.from(value.slice(PREFIX.length), 'base64')).toString('utf8');
}

// Only audited shared-reader keys are eligible. Locks, credentials, model
// state parts, frozen selections and ledgers retain their existing formats.
function encodeRedisValue(key, value) {
  if (typeof value !== 'string' || value.length < 4096 || value.startsWith(PREFIX)) return value;
  if (RAW_KEYS.test(String(key))) {
    const archive = JSON.parse(value);
    if (archive.responseEncoding !== 'gzip+base64' || !archive.responseGzipBase64) return value;
    const original = zlib.gunzipSync(Buffer.from(archive.responseGzipBase64, 'base64'));
    const compressed = zlib.brotliCompressSync(original, OPTIONS);
    if (!zlib.brotliDecompressSync(compressed).equals(original)) throw new Error('Raw archive compression verification failed');
    const compact = { ...archive, responseEncoding: 'br+base64', responseBrotliBase64: compressed.toString('base64') };
    delete compact.responseGzipBase64;
    const encoded = JSON.stringify(compact);
    return Buffer.byteLength(encoded) < Buffer.byteLength(value) * 0.9 ? encoded : value;
  }
  if (!JSON_KEYS.test(String(key))) return value;
  JSON.parse(value);
  const encoded = PREFIX + zlib.brotliCompressSync(Buffer.from(value), OPTIONS).toString('base64');
  if (Buffer.byteLength(encoded) >= Buffer.byteLength(value) * 0.9) return value;
  if (decodeRedisValue(encoded) !== value) throw new Error('Archive compression verification failed');
  return encoded;
}

module.exports = { decodeRedisValue, encodeRedisValue, isCompressibleKey, isCompressedPrefix };
