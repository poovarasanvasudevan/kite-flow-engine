import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Engine } from './engine';
import { PluginManager } from './plugins';
import type { Workflow } from '../shared';

const require = createRequire(import.meta.url);
const plugin = require(resolve(import.meta.dir, '../../plugins/bundled/websocket/index.cjs'));
const node = (id: string, nodeType: string, config: Record<string, unknown> = {}) => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType, config } });

test('WebSocket plugin registers input, output, and client nodes', async () => {
  const engine = new Engine();
  const manager = new PluginManager(engine, resolve(import.meta.dir, '../../data'), resolve(import.meta.dir, '../../plugins'));
  await manager.loadPackages();
  expect(manager.packages.find(item => item.name === '@wflow/websocket')?.types).toEqual(['websocket-in', 'websocket-out', 'websocket-client']);
});

test('WebSocket In starts an execution and WebSocket Out replies to its connection', async () => {
  const engine = new Engine();
  const manager = new PluginManager(engine, resolve(import.meta.dir, '../../data'), resolve(import.meta.dir, '../../plugins'));
  await manager.loadPackages();
  const replies: string[] = [];
  engine.websocketSender = (_flowId, nodeId, connectionId, payload, broadcast) => {
    expect(nodeId).toBe('in'); expect(connectionId).toBe('client-1'); expect(broadcast).toBe(false);
    replies.push(payload); return 1;
  };
  const flow: Workflow = { id: 'websocket-test', name: 'WebSocket test', updatedAt: new Date().toISOString(), nodes: [node('in', 'websocket-in', { path: 'test' }), node('out', 'websocket-out')], edges: [{ id: 'reply', source: 'in', target: 'out', sourceHandle: '0' }] };
  engine.deploy(flow);
  expect(await engine.triggerWebSocket(flow.id, 'in', { payload: { hello: 'world' }, _websocket: { nodeId: 'in', connectionId: 'client-1' } })).toBe(true);
  expect(replies).toEqual(['{"hello":"world"}']);
  expect(engine.logs.some(event => event.level === 'error')).toBe(false);
  engine.stop(flow.id);
});

test('WebSocket Client sends a message and reads the first response', async () => {
  const server = Bun.serve({ port: 0, fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Upgrade failed', { status: 500 }); }, websocket: { message(socket, raw) { socket.send(raw); } } });
  try {
    const received = await plugin.requestReply(`ws://127.0.0.1:${server.port}/echo`, { value: 7 }, { mode: 'receive', parseJson: true, timeoutMs: 2000 });
    expect(received).toEqual({ value: 7 });
    expect(plugin.requestReply('http://example.com', 'x', { timeoutMs: 1000 })).rejects.toThrow('ws:// or wss://');
  } finally { server.stop(true); }
});
