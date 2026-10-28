import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, vaultKey } from './vault';
import { Engine } from './engine';
import type { ExecutionRecorder, ExecutionRun, ExecutionStep, Workflow } from '../shared';

test('vault values use authenticated encryption and bind ciphertext to the name', () => {
  const key = vaultKey(randomBytes(32).toString('hex'));
  const encrypted = encryptSecret('correct horse battery staple', key, 'servers/prod/password');
  expect(encrypted.ciphertext.toString('utf8')).not.toContain('correct horse');
  expect(decryptSecret({ name: 'servers/prod/password', ...encrypted, auth_tag: encrypted.authTag }, key)).toBe('correct horse battery staple');
  expect(() => decryptSecret({ name: 'servers/other/password', ...encrypted, auth_tag: encrypted.authTag }, key)).toThrow();
  expect(() => decryptSecret({ name: 'servers/prod/password', ...encrypted, auth_tag: Buffer.alloc(16) }, key)).toThrow();
  expect(() => vaultKey('short')).toThrow('64 hexadecimal');
});

test('Function can read a secret while execution history and logs redact it', async () => {
  const runs: ExecutionRun[] = []; const steps: ExecutionStep[] = [];
  const recorder: ExecutionRecorder = {
    async startRun() {}, async finishRun(run) { runs.push(structuredClone(run)); }, async startStep() {},
    async finishStep(step) { steps.push(structuredClone(step)); }, async recordEvent() {},
  };
  const engine = new Engine(recorder, undefined, { async get(name) { expect(name).toBe('ssh/password'); return 'super-private-value'; } });
  const flow: Workflow = { id: 'vault-test', name: 'Vault test', updatedAt: new Date().toISOString(), nodes: [
    { id: 'start', type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType: 'inject', config: { payload: '"hello"' } } },
    { id: 'script', type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType: 'function', config: { code: "msg.payload = await getSecret('ssh/password'); log(msg.payload); return msg;" } } },
  ], edges: [{ id: 'one', source: 'start', target: 'script', sourceHandle: '0' }] };
  engine.deploy(flow); await engine.inject(flow.id, 'start');
  expect(runs[0].status).toBe('success');
  expect(JSON.stringify(runs)).not.toContain('super-private-value');
  expect(JSON.stringify(steps)).not.toContain('super-private-value');
  expect(JSON.stringify(engine.logs)).not.toContain('super-private-value');
  expect((steps.at(-1)?.output as any).payload).toBe('[redacted]');
});
