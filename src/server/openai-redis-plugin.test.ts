import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Engine } from './engine';
import { PluginManager } from './plugins';
import type { ExecutionRecorder, ExecutionRun, FlowNode, Workflow } from '../shared';

const require = createRequire(import.meta.url);
const openai = require(resolve(import.meta.dir, '../../plugins/bundled/openai/index.cjs'));
const redis = require(resolve(import.meta.dir, '../../plugins/bundled/redis/index.cjs'));

test('OpenAI and Redis nodes load from bundled plugins', async () => {
  const engine = new Engine();
  const manager = new PluginManager(engine, resolve(import.meta.dir, '../../data'), resolve(import.meta.dir, '../../plugins'));
  await manager.loadPackages();
  expect(manager.packages.find(item => item.name === '@wflow/openai')?.types).toEqual(['openai']);
  expect(manager.packages.find(item => item.name === '@wflow/redis')?.types).toEqual(['redis', 'redis-subscriber']);
  expect(engine.definitions.get('openai')?.icon).toBe('sparkles');
  expect(engine.definitions.get('redis')?.icon).toBe('database');
  expect(engine.definitions.get('redis-subscriber')?.inputs).toBe(0);
});

test('Redis Subscriber starts runs for messages and releases its connection on stop', async () => {
  const runs: ExecutionRun[] = [];
  const recorder: ExecutionRecorder = {
    async startRun() {}, async finishRun(run) { runs.push(structuredClone(run)); },
    async startStep() {}, async finishStep() {}, async recordEvent() {},
  };
  const engine = new Engine(recorder);
  let receive!: (message: string, channel: string) => void;
  let destroyed = 0;
  let subscribed: string[] = [];
  const factory = () => ({
    on() {}, connect: async () => {}, destroy: () => { destroyed++; },
    subscribe: async (channels: string[], callback: typeof receive) => { subscribed = channels; receive = callback; },
  });
  const subscriber = redis.nodes.find((entry: { definition: { type: string } }) => entry.definition.type === 'redis-subscriber');
  engine.register(subscriber.definition, subscriber.run, (context) => redis.startRedisSubscriber(
    context.node.data.config, context.emit, context.log, context.getSecret, factory,
  ));
  const debug = engine.definitions.get('debug')!;
  const nodes: FlowNode[] = [
    { id: 'source', type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType: 'redis-subscriber', config: { connectionRef: 'redis://127.0.0.1:6379', channels: 'events,alerts', parseJson: true } } },
    { id: 'sink', type: 'workflow', position: { x: 200, y: 0 }, data: { nodeType: debug.type, config: { complete: false } } },
  ];
  const flow: Workflow = { id: 'redis-test', name: 'Redis test', updatedAt: new Date().toISOString(), nodes, edges: [{ id: 'edge', source: 'source', target: 'sink', sourceHandle: '0' }] };
  engine.deploy(flow);
  for (let attempt = 0; attempt < 20 && !receive; attempt++) await Bun.sleep(1);
  expect(subscribed).toEqual(['events', 'alerts']);
  receive('{"ready":true}', 'events');
  for (let attempt = 0; attempt < 20 && !runs.length; attempt++) await Bun.sleep(1);
  expect(runs).toHaveLength(1);
  expect(runs[0].trigger).toBe('redis');
  expect(runs[0].input).toMatchObject({ payload: { ready: true }, topic: 'events' });
  expect(engine.logs.find(event => event.nodeId === 'sink' && event.level === 'debug')?.data).toEqual({ ready: true });
  engine.stop(flow.id);
  expect(destroyed).toBe(1);
  receive('after stop', 'events');
  await Bun.sleep(1);
  expect(runs).toHaveLength(1);
});

test('Redis Subscriber validates channels and supports pattern subscriptions', async () => {
  expect(() => redis.startRedisSubscriber({ channels: ' ' }, async () => true, () => {}, undefined, () => ({}))).toThrow('at least one channel');
  let patternChannels: string[] = [];
  let received!: (message: string, channel: string) => void;
  let destroyed = 0;
  const values: unknown[] = [];
  const stop = redis.startRedisSubscriber({ connectionRef: 'vault:redis/url', channels: 'orders:*', pattern: true, parseJson: false },
    async (message: unknown) => { values.push(message); return true; }, () => {}, async () => 'redis://127.0.0.1:6379',
    () => ({ on() {}, connect: async () => {}, destroy: () => { destroyed++; }, pSubscribe: async (channels: string[], callback: typeof received) => { patternChannels = channels; received = callback; } }));
  for (let attempt = 0; attempt < 20 && !received; attempt++) await Bun.sleep(1);
  expect(patternChannels).toEqual(['orders:*']);
  received('plain text', 'orders:new');
  await Bun.sleep(1);
  expect(values).toMatchObject([{ payload: 'plain text', topic: 'orders:new', redis: { channel: 'orders:new', subscription: 'pattern' } }]);
  stop();
  expect(destroyed).toBe(1);
});

test('OpenAI node renders message input and keeps the key out of its output', async () => {
  let options: Record<string, unknown> = {};
  let request: Record<string, unknown> = {};
  class FakeOpenAI {
    responses = { create: async (value: Record<string, unknown>) => {
      request = value;
      return { id: 'resp-test', model: 'test-model', status: 'completed', output_text: 'Hello there', usage: { total_tokens: 12 } };
    } };
    constructor(value: Record<string, unknown>) { options = value; }
  }
  const message = { payload: 'world', topic: 'greeting' };
  const result = await openai.executeOpenAI(message, { apiKeyRef: 'vault:ai/key', model: 'test-model', prompt: 'Hello {{msg.payload}}', instructions: 'Be brief', maxOutputTokens: 100 }, async (name: string) => {
    expect(name).toBe('ai/key'); return 'private-key';
  }, FakeOpenAI);
  expect(options.apiKey).toBe('private-key');
  expect(request).toEqual({ model: 'test-model', input: 'Hello world', instructions: 'Be brief', max_output_tokens: 100, store: false });
  expect(result.payload).toBe('Hello there');
  expect(result.openai).toEqual({ id: 'resp-test', model: 'test-model', status: 'completed', usage: { total_tokens: 12 } });
  expect(JSON.stringify(result)).not.toContain('private-key');
  await expect(openai.executeOpenAI({ payload: '' }, { model: 'test-model', prompt: '{{msg.payload}}' }, undefined, FakeOpenAI)).rejects.toThrow('prompt is empty');
});

test('Redis node handles get, set with expiry, and connection cleanup', async () => {
  const calls: unknown[][] = [];
  let destroyed = 0;
  const factory = (options: { url: string }) => {
    expect(options.url).toBe('redis://127.0.0.1:6379');
    return {
      on() {}, connect: async () => { calls.push(['connect']); }, destroy: () => { destroyed++; },
      get: async (key: string) => { calls.push(['get', key]); return '{"count":2}'; },
      set: async (key: string, value: string, expiry: unknown) => { calls.push(['set', key, value, expiry]); return 'OK'; },
      del: async (key: string) => { calls.push(['delete', key]); return 1; },
      incrBy: async (key: string, amount: number) => { calls.push(['increment', key, amount]); return 5; },
      publish: async (channel: string, value: string) => { calls.push(['publish', channel, value]); return 2; },
    };
  };
  const got = await redis.executeRedis({ payload: 'old', topic: 'items' }, { connectionRef: 'redis://127.0.0.1:6379', operation: 'get', key: 'cache:{{msg.topic}}', parseJson: true }, undefined, factory);
  expect(got.payload).toEqual({ count: 2 });
  expect(got.redis).toEqual({ operation: 'get', key: 'cache:items', result: 'found' });
  const set = await redis.executeRedis({ payload: { count: 3 }, topic: 'items' }, { connectionRef: 'redis://127.0.0.1:6379', operation: 'set', key: 'cache:{{msg.topic}}', ttlSeconds: 60 }, undefined, factory);
  expect(set.payload).toEqual({ count: 3 });
  expect(set.redis.result).toBe('OK');
  expect(calls).toContainEqual(['set', 'cache:items', '{"count":3}', { EX: 60 }]);
  const deleted = await redis.executeRedis({ payload: 'keep', topic: 'items' }, { connectionRef: 'redis://127.0.0.1:6379', operation: 'delete', key: '{{msg.topic}}' }, undefined, factory);
  expect(deleted.payload).toBe('keep');
  expect(deleted.redis.result).toBe(1);
  const incremented = await redis.executeRedis({ payload: 'keep', topic: 'items' }, { connectionRef: 'redis://127.0.0.1:6379', operation: 'increment', key: '{{msg.topic}}', incrementBy: 2 }, undefined, factory);
  expect(incremented.redis.result).toBe(5);
  const published = await redis.executeRedis({ payload: { ok: true }, topic: 'events' }, { connectionRef: 'redis://127.0.0.1:6379', operation: 'publish', key: '{{msg.topic}}' }, undefined, factory);
  expect(published.redis.result).toBe(2);
  expect(calls).toContainEqual(['publish', 'events', '{"ok":true}']);
  expect(destroyed).toBe(5);
  await expect(redis.executeRedis({ payload: 'x', topic: 'k' }, { connectionRef: 'redis://user:password@127.0.0.1', key: 'k' }, undefined, factory)).rejects.toThrow('Store a Redis URL with credentials');
});
