const { createClient } = require('redis');

function text(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? null); }
function render(template, message) {
  return String(template).replace(/\{\{\s*msg\.([\w.]+)\s*\}\}/g, (_match, path) => {
    const value = path.split('.').reduce((item, key) => item == null ? undefined : item[key], message);
    return value == null ? '' : text(value);
  });
}
function timeout(value) {
  const ms = Number(value ?? 15_000);
  if (!Number.isInteger(ms) || ms < 100 || ms > 300_000) throw new Error('Redis timeout must be between 100 and 300000 ms');
  return ms;
}
async function connectionUrl(reference, getSecret) {
  const ref = String(reference || 'REDIS_URL').trim();
  let value;
  if (ref.startsWith('vault:')) {
    if (!getSecret) throw new Error('Secret Vault is unavailable for Redis');
    const name = ref.slice(6).trim();
    if (!name) throw new Error('Redis vault secret name is required');
    value = await getSecret(name);
  } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    value = process.env[ref];
    if (!value) throw new Error(`Redis connection environment variable ${ref} is not set`);
  } else if (/^rediss?:\/\//.test(ref)) {
    value = ref;
    const parsed = new URL(value);
    if (parsed.username || parsed.password) throw new Error('Store a Redis URL with credentials in an environment variable or Secret Vault');
  } else throw new Error('Redis connection must be an environment variable, vault:name, or redis:// URL without credentials');
  let url;
  try { url = new URL(value); } catch { throw new Error('Redis connection URL is invalid'); }
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Redis connection URL must use redis:// or rediss://');
  return url.toString();
}

async function executeRedis(message, config, getSecret, clientFactory = createClient) {
  const operation = String(config.operation || 'get').toLowerCase();
  if (!['get', 'set', 'delete', 'increment', 'publish'].includes(operation)) throw new Error('Unsupported Redis operation');
  const key = render(config.key || '{{msg.topic}}', message).trim();
  if (!key) throw new Error('Redis key or channel is required');
  if (Buffer.byteLength(key) > 1024) throw new Error('Redis key or channel exceeds 1024 bytes');
  const ms = timeout(config.timeoutMs);
  const ttl = Number(config.ttlSeconds ?? 0);
  if (operation === 'set' && (!Number.isInteger(ttl) || ttl < 0 || ttl > 31_536_000)) throw new Error('Redis TTL must be between 0 and 31536000 seconds');
  const increment = Number(config.incrementBy ?? 1);
  if (operation === 'increment' && (!Number.isSafeInteger(increment) || increment === 0)) throw new Error('Redis increment must be a non-zero integer');
  const value = ['set', 'publish'].includes(operation) ? text(message.payload) : undefined;
  if (value && Buffer.byteLength(value) > 262_144) throw new Error('Redis value exceeds 256 KiB');
  const url = await connectionUrl(config.connectionRef, getSecret);
  let client;
  let timer;
  try {
    client = clientFactory({ url, socket: { connectTimeout: Math.min(ms, 10_000), reconnectStrategy: false } });
    client.on('error', () => {});
    const result = await Promise.race([
      (async () => {
        await client.connect();
        switch (operation) {
          case 'get': return client.get(key);
          case 'set': return ttl ? client.set(key, value, { EX: ttl }) : client.set(key, value);
          case 'delete': return client.del(key);
          case 'increment': return client.incrBy(key, increment);
          case 'publish': return client.publish(key, value);
        }
      })(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Redis operation timed out')), ms); }),
    ]);
    if (operation === 'get') {
      if (typeof result === 'string' && Buffer.byteLength(result) > 262_144) throw new Error('Redis value exceeds 256 KiB');
      if (result === null) message.payload = null;
      else if (config.parseJson) { try { message.payload = JSON.parse(result); } catch { message.payload = result; } }
      else message.payload = result;
    }
    message.redis = { operation, key, result: operation === 'get' ? (result === null ? 'missing' : 'found') : result };
    return message;
  } catch (error) {
    let reason = String(error instanceof Error ? error.message : error).replaceAll(url, '[redacted Redis URL]');
    const encodedPassword = new URL(url).password;
    let password = encodedPassword;
    try { password = decodeURIComponent(encodedPassword); } catch {}
    if (encodedPassword) reason = reason.replaceAll(encodedPassword, '[redacted]');
    if (password) reason = reason.replaceAll(password, '[redacted]');
    throw new Error(reason);
  } finally {
    clearTimeout(timer);
    client?.destroy();
  }
}

function subscriptionChannels(value) {
  const channels = [...new Set(String(value || '').split(/[\r\n,]+/).map(channel => channel.trim()).filter(Boolean))];
  if (!channels.length) throw new Error('Redis Subscriber needs at least one channel');
  if (channels.length > 32) throw new Error('Redis Subscriber supports at most 32 channels');
  if (channels.some(channel => Buffer.byteLength(channel) > 1024)) throw new Error('Redis channel exceeds 1024 bytes');
  return channels;
}

function safeRedisError(error, url) {
  let reason = String(error instanceof Error ? error.message : error);
  if (!url) return reason;
  reason = reason.replaceAll(url, '[redacted Redis URL]');
  const encodedPassword = new URL(url).password;
  let password = encodedPassword;
  try { password = decodeURIComponent(encodedPassword); } catch {}
  if (encodedPassword) reason = reason.replaceAll(encodedPassword, '[redacted]');
  if (password) reason = reason.replaceAll(password, '[redacted]');
  return reason;
}

function startRedisSubscriber(config, emit, log, getSecret, clientFactory = createClient) {
  const channels = subscriptionChannels(config.channels);
  const pattern = config.pattern === true;
  let stopped = false;
  let client;
  let url;
  let destroyed = false;
  const destroy = () => { if (client && !destroyed) { destroyed = true; client.destroy(); } };
  const received = (value, channel) => {
    if (stopped) return;
    if (Buffer.byteLength(value) > 262_144) { log(`Redis Subscriber skipped oversized message on ${channel}`); return; }
    let payload = value;
    if (config.parseJson !== false) { try { payload = JSON.parse(value); } catch {} }
    const message = { payload, topic: channel, _msgid: crypto.randomUUID(), redis: { channel, subscription: pattern ? 'pattern' : 'channel' } };
    void Promise.resolve().then(() => emit(message)).then(succeeded => {
      if (!succeeded && !stopped) log(`Redis Subscriber workflow failed for ${channel}`);
    }).catch(error => { if (!stopped) log(`Redis Subscriber execution failed: ${safeRedisError(error, url)}`); });
  };
  void (async () => {
    try {
      url = await connectionUrl(config.connectionRef, getSecret);
      if (stopped) return;
      client = clientFactory({ url, socket: { connectTimeout: 10_000, reconnectStrategy: retries => Math.min(100 * 2 ** Math.min(retries, 8), 30_000) } });
      client.on('error', error => { if (!stopped) log(`Redis Subscriber connection error: ${safeRedisError(error, url)}`); });
      await client.connect();
      if (stopped) return;
      if (pattern) await client.pSubscribe(channels, received);
      else await client.subscribe(channels, received);
    } catch (error) {
      if (!stopped) log(`Redis Subscriber could not start: ${safeRedisError(error, url)}`);
      destroy();
    }
  })();
  return () => { stopped = true; destroy(); };
}

exports.executeRedis = executeRedis;
exports.startRedisSubscriber = startRedisSubscriber;
exports.nodes = [{
  definition: {
    type: 'redis', label: 'Redis', category: 'Database', color: '#183247', icon: 'database',
    inputs: 1, outputs: 1, description: 'Get, set, delete, increment, or publish using a Redis connection stored outside the workflow.',
    defaults: { connectionRef: 'REDIS_URL', operation: 'get', key: '{{msg.topic}}', ttlSeconds: 0, parseJson: true, incrementBy: 1, timeoutMs: 15000 },
    fields: [
      { key: 'connectionRef', label: 'Connection env variable, vault:name, or local redis:// URL', type: 'text', placeholder: 'REDIS_URL' },
      { key: 'operation', label: 'Operation', type: 'select', options: ['get', 'set', 'delete', 'increment', 'publish'] },
      { key: 'key', label: 'Key or channel (supports {{msg.topic}})', type: 'text', placeholder: '{{msg.topic}}' },
      { key: 'ttlSeconds', label: 'Set expiry in seconds (0 means no expiry)', type: 'number' },
      { key: 'parseJson', label: 'Parse JSON returned by Get', type: 'boolean' },
      { key: 'incrementBy', label: 'Increment by', type: 'number' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    ],
  },
  async run(message, context) { context.send(0, await executeRedis(message, context.config, context.getSecret)); },
}, {
  definition: {
    type: 'redis-subscriber', label: 'Redis Subscriber', category: 'Input', color: '#2ab88b', icon: 'database',
    inputs: 0, outputs: 1, description: 'Start a workflow for each Redis Pub/Sub message received on the selected channels.',
    defaults: { connectionRef: 'REDIS_URL', channels: 'events', pattern: false, parseJson: true },
    fields: [
      { key: 'connectionRef', label: 'Connection env variable, vault:name, or local redis:// URL', type: 'text', placeholder: 'REDIS_URL' },
      { key: 'channels', label: 'Channels (comma or newline separated)', type: 'textarea', placeholder: 'events' },
      { key: 'pattern', label: 'Use Redis pattern subscription', type: 'boolean' },
      { key: 'parseJson', label: 'Parse JSON messages when possible', type: 'boolean' },
    ],
  },
  run(message, context) { context.send(0, message); },
  start(context) { return startRedisSubscriber(context.node.data.config, context.emit, context.log, context.getSecret); },
}];
