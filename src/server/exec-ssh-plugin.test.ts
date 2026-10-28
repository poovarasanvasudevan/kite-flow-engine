import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Engine } from './engine';
import { PluginManager } from './plugins';

const require = createRequire(import.meta.url);
const plugin = require(resolve(import.meta.dir, '../../plugins/bundled/exec-ssh/index.cjs'));

async function run(type: string, message: Record<string, unknown>, config: Record<string, unknown>) {
  const node = plugin.nodes.find((item: any) => item.definition.type === type);
  const sent: any[] = [];
  await node.run(message, { config, send: (_port: number, value: Record<string, unknown>) => sent.push(value) });
  return sent[0];
}

test('bundled Exec and SSH nodes register as a plugin', async () => {
  const engine = new Engine();
  const manager = new PluginManager(engine, resolve(import.meta.dir, '../../data'), resolve(import.meta.dir, '../../plugins'));
  await manager.loadPackages();
  expect(manager.packages.find(item => item.name === '@wflow/exec-ssh')?.types).toEqual(['exec', 'ssh']);
  expect(engine.definitions.get('ssh')?.source).toBe('@wflow/exec-ssh');
});

test('Exec forwards stdout and captures exit information', async () => {
  const result = await run('exec', { payload: 'before' }, { command: 'bun --version', timeoutMs: 10000 });
  expect(String(result.payload).trim()).toMatch(/^\d+\.\d+\.\d+/);
  expect(result.exec.exitCode).toBe(0);
  expect(result.exec.durationMs).toBeGreaterThanOrEqual(0);
  expect(run('exec', {}, { command: '' })).rejects.toThrow('command is required');
  const failing = 'bun -e "process.exit(7)"';
  expect(run('exec', {}, { command: failing, timeoutMs: 10000 })).rejects.toThrow('code 7');
  const tolerated = await run('exec', {}, { command: failing, timeoutMs: 10000, failOnNonZero: false });
  expect(tolerated.exec.exitCode).toBe(7);
});

test('SSH executes with environment authentication and a pinned host key', async () => {
  const hostKey = Buffer.from('test-host-public-key');
  const fingerprint = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
  let connectionOptions: any;
  class FakeClient extends EventEmitter {
    connect(options: any) {
      connectionOptions = options;
      queueMicrotask(() => options.hostVerifier(hostKey) ? this.emit('ready') : this.emit('error', new Error('Host rejected')));
    }
    exec(command: string, callback: (error: Error | null, stream?: any) => void) {
      const stream: any = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.end = () => queueMicrotask(() => {
        stream.emit('data', Buffer.from(`ran: ${command}`));
        stream.stderr.emit('data', Buffer.from('notice'));
        stream.emit('close', 0);
      });
      callback(null, stream);
    }
    end() { queueMicrotask(() => this.emit('close')); }
  }
  process.env.WFLOW_TEST_SSH_PASSWORD = 'test-password';
  try {
    const config = { host: '127.0.0.1', port: 22, username: 'test', command: 'uptime', authMode: 'password', passwordEnv: 'WFLOW_TEST_SSH_PASSWORD', hostKeySha256: `SHA256:${fingerprint}`, timeoutMs: 10000 };
    const result = await plugin.executeSsh(config, '', FakeClient);
    expect(result).toMatchObject({ stdout: 'ran: uptime', stderr: 'notice', exitCode: 0 });
    await plugin.executeSsh({ ...config, username: 'vault:ssh/user', passwordEnv: 'vault:ssh/password' }, '', FakeClient, async (name: string) => ({ 'ssh/user': 'vault-user', 'ssh/password': 'vault-pass' })[name]);
    expect(connectionOptions.username).toBe('vault-user');
    expect(connectionOptions.password).toBe('vault-pass');
    expect(plugin.executeSsh({ ...config, hostKeySha256: `SHA256:${'A'.repeat(43)}` }, '', FakeClient)).rejects.toThrow('fingerprint does not match');
  } finally {
    delete process.env.WFLOW_TEST_SSH_PASSWORD;
  }
});
