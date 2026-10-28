import { describe, expect, test } from 'bun:test';
import { Engine, historySnapshot } from './engine';
import type { ExecutionEvent, ExecutionRecorder, ExecutionRun, ExecutionStep, Workflow } from '../shared';

const node = (id: string, nodeType: string, config: Record<string, unknown> = {}) => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType, config } });
const flow = (nodes: ReturnType<typeof node>[], edges: Workflow['edges']): Workflow => ({ id: 'flow-1', name: 'Test', updatedAt: new Date().toISOString(), nodes, edges });

describe('workflow engine', () => {
  test('records run and per-node input, output, parameters, timing and errors', async () => {
    const runs = new Map<string, ExecutionRun>(); const steps = new Map<string, ExecutionStep>(); const events: ExecutionEvent[] = [];
    const recorder: ExecutionRecorder = {
      async startRun(run) { runs.set(run.id, structuredClone(run)); },
      async finishRun(run) { runs.set(run.id, structuredClone(run)); },
      async startStep(step) { steps.set(step.id, structuredClone(step)); },
      async finishStep(step) { steps.set(step.id, structuredClone(step)); },
      async recordEvent(event) { events.push(structuredClone(event)); },
    };
    const engine = new Engine(recorder);
    const workflow = flow([node('start', 'inject', { payload: '"hello"' }), node('change', 'change', { operation: 'set', property: 'payload', value: '"done"' }), node('debug', 'debug')], [
      { id: 'a', source: 'start', target: 'change', sourceHandle: '0' }, { id: 'b', source: 'change', target: 'debug', sourceHandle: '0' },
    ]);
    engine.deploy(workflow); await engine.inject(workflow.id, 'start');
    const run = [...runs.values()][0]; const records = [...steps.values()].sort((a, b) => a.sequence - b.sequence);
    expect(run.status).toBe('success'); expect(run.finishedAt).toBeTruthy(); expect(run.nodeCount).toBe(3);
    expect(records.map(step => step.nodeType)).toEqual(['inject', 'change', 'debug']);
    expect((records[1].input as any).payload).toBe('hello'); expect((records[1].output as any).payload).toBe('done');
    expect(records[1].parameters).toEqual({ operation: 'set', property: 'payload', value: '"done"' });
    expect(records.every(step => step.startedAt && step.finishedAt && step.status === 'success')).toBe(true);
    expect(events.some(event => event.level === 'debug')).toBe(true);

    const failing = flow([node('start', 'inject', { payload: '"not-json"' }), node('parse', 'json', { action: 'parse' })], [{ id: 'c', source: 'start', target: 'parse', sourceHandle: '0' }]);
    engine.deploy(failing); await engine.inject(failing.id, 'start');
    expect([...runs.values()].at(-1)?.status).toBe('error');
    expect([...steps.values()].some(step => step.nodeId === 'parse' && step.status === 'error' && step.error)).toBe(true);
    expect(historySnapshot({ password: 'secret', nested: { authorization: 'Bearer token', value: 1 } })).toEqual({ password: '[redacted]', nested: { authorization: '[redacted]', value: 1 } });
  });
  test('inject, change, switch and debug route messages through the right output', async () => {
    const engine = new Engine();
    const workflow = flow([
      node('start', 'inject', { payload: '42' }), node('change', 'change', { operation: 'set', property: 'payload', value: '7' }),
      node('switch', 'switch', { property: 'payload', operator: 'greater than', value: '5' }),
      node('yes', 'debug', { complete: false }), node('no', 'debug', { complete: false }),
    ], [
      { id: 'a', source: 'start', target: 'change', sourceHandle: '0-bottom' }, { id: 'b', source: 'change', target: 'switch', sourceHandle: '0' },
      { id: 'c', source: 'switch', target: 'yes', sourceHandle: '0' }, { id: 'd', source: 'switch', target: 'no', sourceHandle: '1' },
    ]);
    engine.deploy(workflow); await engine.inject(workflow.id, 'start'); await Bun.sleep(20);
    const debug = engine.logs.filter(item => item.level === 'debug');
    expect(debug).toHaveLength(1); expect(debug[0].nodeId).toBe('yes'); expect(debug[0].data).toBe(7);
  });
  test('rejects invalid output wiring', () => {
    const engine = new Engine();
    const workflow = flow([node('start', 'inject'), node('end', 'debug')], [{ id: 'a', source: 'start', target: 'end', sourceHandle: '2' }]);
    expect(() => engine.deploy(workflow)).toThrow('Invalid output');
  });
  test('HTTP In responds through HTTP Response', async () => {
    const engine = new Engine();
    const workflow = flow([node('in', 'http-in', { method: 'POST', path: 'echo' }), node('out', 'http-response', { status: 201 })], [{ id: 'a', source: 'in', target: 'out', sourceHandle: '0' }]);
    engine.deploy(workflow);
    const response = await engine.handleHook(new Request('http://localhost/hook/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hello":"world"}' }), 'echo');
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ hello: 'world' });
  });
  test('Continue fires after any successful node without recursively completing its own branch', async () => {
    const engine = new Engine();
    const workflow = flow([
      node('start', 'inject', { payload: '"hello"' }),
      node('change', 'change', { operation: 'set', property: 'payload', value: '"done"' }),
      node('main', 'debug'), node('on-complete', 'continue', { watch: '*' }), node('completed', 'debug', { complete: true }),
    ], [
      { id: 'a', source: 'start', target: 'change', sourceHandle: '0' },
      { id: 'b', source: 'change', target: 'main', sourceHandle: '0' },
      { id: 'c', source: 'on-complete', target: 'completed', sourceHandle: '0' },
    ]);
    engine.deploy(workflow);
    await engine.inject(workflow.id, 'start');
    const completions = engine.logs.filter(item => item.nodeId === 'completed' && item.level === 'debug');
    expect(completions).toHaveLength(3);
    expect(completions.map(item => (item.data as any).completion.nodeId).sort()).toEqual(['change', 'main', 'start']);
  });
  test('Continue can handle a failed node after the error is recorded', async () => {
    const engine = new Engine();
    const workflow = flow([
      node('start', 'inject', { payload: '"not-json"' }), node('parse', 'json', { action: 'parse' }),
      node('on-complete', 'continue', { watch: 'parse', includeErrors: true }), node('completed', 'debug', { complete: true }),
    ], [{ id: 'a', source: 'start', target: 'parse', sourceHandle: '0' }, { id: 'b', source: 'on-complete', target: 'completed', sourceHandle: '0' }]);
    engine.deploy(workflow);
    await engine.inject(workflow.id, 'start');
    const event = engine.logs.find(item => item.nodeId === 'completed' && item.level === 'debug');
    expect((event?.data as any).completion.status).toBe('error');
    expect((event?.data as any).completion.error).toContain('Unexpected');
  });
});
