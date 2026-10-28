import type { ExecutionEvent, ExecutionRecorder, ExecutionRun, ExecutionStep, FlowNode, LogEvent, Message, NodeContext, NodeDefinition, NodeHandler, NodeStarter, Workflow } from '../shared';
import { builtins, handlers, parseValue } from './builtins';
import { startEmailPoller, type EmailCursorStore } from './email';

type RunState = { record: ExecutionRun; pending: number; closed: boolean; resolve: () => void; reject: (error: Error) => void; done: Promise<void>; writes: Promise<unknown>[]; secretValues: Set<string> };
type PendingResponse = { resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout>; run: RunState };

function redactText(value: string, secrets?: Iterable<string>): string {
  for (const secret of secrets || []) if (secret) value = value.replaceAll(secret, '[redacted]');
  return value;
}

export function historySnapshot(value: unknown, secrets?: Iterable<string>): unknown {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (key, entry) => {
      if (key && /password|secret|token|authorization|cookie|api[-_]?key/i.test(key)) return '[redacted]';
      if (typeof entry === 'string') return redactText(entry, secrets);
      if (typeof entry === 'bigint') return entry.toString();
      if (entry instanceof Error) return { name: entry.name, message: entry.message };
      if (entry && typeof entry === 'object') { if (seen.has(entry)) return '[circular]'; seen.add(entry); }
      return entry;
    });
    if (!serialized) return null;
    if (serialized.length > 262144) return { truncated: true, preview: serialized.slice(0, 262144) };
    return JSON.parse(serialized);
  } catch { return '[unserializable]'; }
}
export class Engine {
  definitions = new Map<string, NodeDefinition>();
  handlers = new Map<string, NodeHandler>();
  starters = new Map<string, NodeStarter>();
  deployed = new Map<string, Workflow>();
  logs: LogEvent[] = [];
  contexts = new Map<string, Map<string, unknown>>();
  timers = new Map<string, ReturnType<typeof setInterval>[]>();
  emailStops = new Map<string, (() => void)[]>();
  pluginStops = new Map<string, (() => void)[]>();
  pending = new Map<string, PendingResponse>();
  listeners = new Set<(event: LogEvent) => void>();
  websocketSender?: (workflowId: string, nodeId: string, connectionId: string | undefined, payload: string, broadcast: boolean) => number;
  onStop?: (workflowId: string) => void;

  constructor(private recorder?: ExecutionRecorder, private emailCursors?: EmailCursorStore, private secrets?: { get(name: string): Promise<string> }) { builtins.forEach((definition) => this.register(definition, handlers[definition.type])); }
  register(definition: NodeDefinition, handler: NodeHandler, starter?: NodeStarter) {
    if (!/^[a-z][\w-]*$/.test(definition.type)) throw new Error(`Invalid node type: ${definition.type}`);
    if (this.definitions.has(definition.type)) throw new Error(`Node type already registered: ${definition.type}`);
    this.definitions.set(definition.type, definition); this.handlers.set(definition.type, handler);
    if (starter) this.starters.set(definition.type, starter);
  }
  unregister(type: string) { if (builtins.some(item => item.type === type)) throw new Error('Cannot remove a built-in node'); this.definitions.delete(type); this.handlers.delete(type); this.starters.delete(type); }
  log(level: LogEvent['level'], message: string, data?: unknown, workflowId?: string, nodeId?: string, run?: RunState, stepId?: string) {
    const event: LogEvent = { id: crypto.randomUUID(), time: new Date().toISOString(), level, message: redactText(message, run?.secretValues), data: run ? historySnapshot(data, run.secretValues) : data, workflowId, nodeId };
    this.logs.unshift(event); if (this.logs.length > 300) this.logs.length = 300;
    this.listeners.forEach(listener => listener(event));
    if (run && this.recorder) {
      const persisted: ExecutionEvent = { id: event.id, executionId: run.record.id, stepId, nodeId, level, time: event.time, message: event.message, data: event.data };
      run.writes.push(this.recorder.recordEvent(persisted).catch(error => { run.record.errorCount++; run.record.error ||= `Could not save an execution event: ${String(error)}`; }));
    }
  }
  validate(flow: Workflow) {
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) throw new Error('Invalid workflow');
    const ids = new Set<string>();
    for (const node of flow.nodes) { if (!node.id || ids.has(node.id)) throw new Error('Duplicate or missing node ID'); ids.add(node.id); if (!this.definitions.has(node.data?.nodeType)) throw new Error(`Unknown node type: ${node.data?.nodeType}`); }
    for (const edge of flow.edges) {
      const source = flow.nodes.find(node => node.id === edge.source); const target = flow.nodes.find(node => node.id === edge.target);
      if (!source || !target) throw new Error('An edge points to a missing node');
      const port = Number.parseInt(edge.sourceHandle || '0', 10); const def = this.definitions.get(source.data.nodeType)!;
      if (!Number.isInteger(port) || port < 0 || port >= def.outputs) throw new Error(`Invalid output on ${source.data.nodeType}`);
      if (!this.definitions.get(target.data.nodeType)!.inputs) throw new Error(`${target.data.nodeType} does not accept input`);
    }
    const localRoutes = new Set<string>();
    for (const node of flow.nodes.filter(node => node.data.nodeType === 'http-in')) {
      const path = String(node.data.config.path || '').replace(/^\/+|\/+$/g, '');
      if (!path || path.includes('..') || !/^[\w/-]+$/.test(path)) throw new Error('HTTP In path must contain only letters, numbers, /, _ or -');
      const route = `${String(node.data.config.method || 'GET').toUpperCase()} /hook/${path}`;
      if (localRoutes.has(route)) throw new Error(`Duplicate HTTP route: ${route}`);
      localRoutes.add(route);
      for (const deployed of this.deployed.values()) for (const other of deployed.nodes.filter(item => item.data.nodeType === 'http-in')) {
        if (deployed.id !== flow.id && String(other.data.config.method).toUpperCase() === String(node.data.config.method).toUpperCase() && String(other.data.config.path).replace(/^\/+|\/+$/g, '') === path) throw new Error(`HTTP route already deployed: ${path}`);
      }
    }
    const websocketRoutes = new Set<string>();
    for (const node of flow.nodes.filter(node => node.data.nodeType === 'websocket-in')) {
      const path = String(node.data.config.path || '').replace(/^\/+|\/+$/g, '');
      if (!path || path.includes('..') || !/^[\w/-]+$/.test(path)) throw new Error('WebSocket In path must contain only letters, numbers, /, _ or -');
      if (websocketRoutes.has(path)) throw new Error(`Duplicate WebSocket route: ${path}`);
      websocketRoutes.add(path);
      for (const deployed of this.deployed.values()) if (deployed.id !== flow.id && deployed.nodes.some(other => other.data.nodeType === 'websocket-in' && String(other.data.config.path || '').replace(/^\/+|\/+$/g, '') === path)) throw new Error(`WebSocket route already deployed: ${path}`);
    }
  }
  deploy(flow: Workflow) {
    this.validate(flow); this.stop(flow.id);
    const snapshot = structuredClone(flow); snapshot.deployedAt = new Date().toISOString(); this.deployed.set(flow.id, snapshot);
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const node of snapshot.nodes.filter(item => item.data.nodeType === 'inject')) {
      const interval = Number(node.data.config.interval) || 0;
      if (interval > 0) timers.push(setInterval(() => { void this.inject(snapshot.id, node.id, 'schedule').catch(error => this.log('error', `Scheduled execution failed: ${String(error)}`, undefined, snapshot.id, node.id)); }, Math.max(0.1, interval) * 1000));
    }
    this.timers.set(flow.id, timers); this.log('info', `Deployed ${flow.name}`, undefined, flow.id);
    if (this.emailCursors) this.emailStops.set(flow.id, snapshot.nodes.filter(item => item.data.nodeType === 'email-in').map(node =>
      startEmailPoller(flow.id, node, this.emailCursors!, message => this.triggerEmail(flow.id, node.id, message),
        message => this.log('error', message, undefined, flow.id, node.id))));
    const pluginStops: (() => void)[] = [];
    this.pluginStops.set(flow.id, pluginStops);
    try {
      for (const node of snapshot.nodes) {
        const starter = this.starters.get(node.data.nodeType);
        if (!starter) continue;
        const stop = starter({ workflowId: flow.id, node,
          emit: message => this.triggerPlugin(flow.id, node.id, message),
          log: message => this.log('error', message, undefined, flow.id, node.id),
          getSecret: name => { if (!this.secrets) throw new Error('Secret Vault is not configured'); return this.secrets.get(name); },
        });
        if (typeof stop !== 'function') throw new Error(`${node.data.nodeType} start must return a stop function`);
        pluginStops.push(stop);
      }
    } catch (error) { this.stop(flow.id); throw error; }
    return snapshot;
  }
  stop(id: string) { this.timers.get(id)?.forEach(clearInterval); this.timers.delete(id); this.emailStops.get(id)?.forEach(stop => stop()); this.emailStops.delete(id); this.pluginStops.get(id)?.forEach(stop => stop()); this.pluginStops.delete(id); this.onStop?.(id); this.deployed.delete(id); for (const key of this.contexts.keys()) if (key.startsWith(`${id}:`)) this.contexts.delete(key); }
  private async beginRun(flow: Workflow, trigger: ExecutionRun['trigger'], input: unknown): Promise<RunState> {
    const record: ExecutionRun = { id: crypto.randomUUID(), workflowId: flow.id, workflowName: flow.name, trigger, status: 'running', startedAt: new Date().toISOString(), input: historySnapshot(input), nodeCount: 0, errorCount: 0 };
    let resolve!: () => void; let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const run: RunState = { record, pending: 0, closed: false, resolve, reject, done, writes: [], secretValues: new Set() };
    await this.recorder?.startRun(record);
    return run;
  }
  private async finishRunIfDone(run: RunState) {
    if (run.pending !== 0 || run.closed) return;
    run.closed = true;
    await Promise.all(run.writes);
    run.record.status = run.record.errorCount ? 'error' : 'success';
    run.record.finishedAt = new Date().toISOString();
    try { await this.recorder?.finishRun(run.record); run.resolve(); }
    catch (error) { run.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  private noteRunError(run: RunState, message: string, nodeId?: string, stepId?: string) {
    run.record.errorCount++;
    run.record.error ||= redactText(message, run.secretValues);
    this.log('error', message, undefined, run.record.workflowId, nodeId, run, stepId);
  }
  async inject(workflowId: string, nodeId: string, trigger: 'manual' | 'schedule' = 'manual', override?: Message) {
    const flow = this.deployed.get(workflowId); if (!flow) throw new Error('Workflow is not deployed');
    const node = flow.nodes.find(item => item.id === nodeId); if (!node || node.data.nodeType !== 'inject') throw new Error('Inject node not found');
    const msg = override ?? { payload: parseValue(node.data.config.payload), _msgid: crypto.randomUUID() };
    const run = await this.beginRun(flow, trigger, msg);
    run.pending++;
    await this.execute(flow, node, msg, 0, run);
    await run.done;
  }
  async triggerEmail(workflowId: string, nodeId: string, msg: Message): Promise<boolean> {
    const flow = this.deployed.get(workflowId); if (!flow) return false;
    const node = flow.nodes.find(item => item.id === nodeId && item.data.nodeType === 'email-in');
    if (!node) return false;
    const run = await this.beginRun(flow, 'email', msg);
    run.pending++;
    await this.execute(flow, node, msg, 0, run);
    await run.done;
    return run.record.status === 'success';
  }
  async triggerWebSocket(workflowId: string, nodeId: string, msg: Message): Promise<boolean> {
    const flow = this.deployed.get(workflowId); if (!flow) return false;
    const node = flow.nodes.find(item => item.id === nodeId && item.data.nodeType === 'websocket-in');
    if (!node) return false;
    const run = await this.beginRun(flow, 'websocket', msg);
    run.pending++;
    await this.execute(flow, node, msg, 0, run);
    await run.done;
    return run.record.status === 'success';
  }
  async triggerPlugin(workflowId: string, nodeId: string, msg: Message): Promise<boolean> {
    const flow = this.deployed.get(workflowId); if (!flow) return false;
    const node = flow.nodes.find(item => item.id === nodeId && this.starters.has(item.data.nodeType) && this.definitions.get(item.data.nodeType)?.inputs === 0);
    if (!node) return false;
    const run = await this.beginRun(flow, node.data.nodeType === 'redis-subscriber' ? 'redis' : 'plugin', msg);
    run.pending++;
    await this.execute(flow, node, msg, 0, run);
    await run.done;
    return run.record.status === 'success';
  }
  async execute(flow: Workflow, node: FlowNode, msg: Message, depth: number, run: RunState, completionBranch = false): Promise<void> {
    if (this.deployed.get(flow.id) !== flow) { run.pending--; await this.finishRunIfDone(run); return; }
    const step: ExecutionStep = { id: crypto.randomUUID(), executionId: run.record.id, sequence: ++run.record.nodeCount, nodeId: node.id, nodeName: node.data.name || this.definitions.get(node.data.nodeType)?.label || node.data.nodeType, nodeType: node.data.nodeType, status: 'running', startedAt: new Date().toISOString(), input: historySnapshot(msg, run.secretValues), parameters: historySnapshot(node.data.config, run.secretValues), outputs: [] };
    const key = `${flow.id}:${node.id}`; if (!this.contexts.has(key)) this.contexts.set(key, new Map());
    const context: NodeContext = {
      nodeId: node.id, workflowId: flow.id, config: node.data.config, context: this.contexts.get(key)!,
      getSecret: async name => {
        if (!this.secrets) throw new Error('Secret Vault is not configured');
        const value = await this.secrets.get(name);
        run.secretValues.add(value);
        return value;
      },
      websocketSend: this.websocketSender ? (targetNodeId, connectionId, payload, broadcast) => this.websocketSender!(flow.id, targetNodeId, connectionId, payload, broadcast) : undefined,
      log: (message, data, level = 'info') => this.log(level, message, data, flow.id, node.id, run, step.id),
      send: (port, message) => {
        if (message == null) return;
        const output = historySnapshot(message, run.secretValues);
        step.outputs!.push({ port, message: output }); run.record.output = output;
        for (const edge of flow.edges.filter(item => item.source === node.id && Number.parseInt(item.sourceHandle || '0', 10) === port)) {
          const target = flow.nodes.find(item => item.id === edge.target)!;
          const copy = structuredClone(message);
          run.pending++;
          queueMicrotask(() => { void this.execute(flow, target, copy, depth + 1, run, completionBranch); });
        }
      },
      respond: (requestId, status, body, headers) => {
        const pending = this.pending.get(requestId); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(requestId);
        const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
        run.record.output = historySnapshot({ status, body, headers }, run.secretValues);
        pending.resolve(new Response(text, { status: status >= 100 && status <= 599 ? status : 200, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers } }));
        pending.run.pending--; void this.finishRunIfDone(pending.run);
      },
    };
    let started = false;
    try {
      await this.recorder?.startStep(step); started = true;
      if (depth > 100) throw new Error('Message stopped after 100 hops (possible loop)');
      const handler = this.handlers.get(node.data.nodeType);
      if (!handler) throw new Error(`No handler for ${node.data.nodeType}`);
      await handler(msg, context);
      step.status = 'success';
    } catch (error) {
      step.status = 'error'; step.error = redactText(error instanceof Error ? error.message : String(error), run.secretValues);
      this.noteRunError(run, `${step.nodeName}: ${step.error}`, node.id, step.id);
    } finally {
      step.finishedAt = new Date().toISOString();
      step.output = step.outputs?.length ? step.outputs.at(-1)!.message : step.status === 'error' ? null : historySnapshot(msg, run.secretValues);
      if (step.output !== undefined && run.record.output === undefined) run.record.output = step.output;
      if (started) try { await this.recorder?.finishStep(step); } catch (error) { this.noteRunError(run, `Could not save ${step.nodeName} result: ${String(error)}`, node.id, step.id); }
      if (!completionBranch && node.data.nodeType !== 'continue') {
        for (const watcher of flow.nodes.filter(item => item.data.nodeType === 'continue')) {
          if (step.status === 'error' && watcher.data.config.includeErrors === false) continue;
          const scope = String(watcher.data.config.watch || '*').trim();
          if (scope !== '*' && !scope.split(',').map(item => item.trim()).includes(node.id) && !scope.split(',').map(item => item.trim()).includes(node.data.nodeType) && !scope.split(',').map(item => item.trim()).includes(node.data.name || '')) continue;
          try {
            const copy = structuredClone(msg);
            copy.completion = { nodeId: node.id, nodeName: step.nodeName, nodeType: step.nodeType, status: step.status, error: step.error, finishedAt: step.finishedAt, executionId: run.record.id };
            run.pending++;
            queueMicrotask(() => { void this.execute(flow, watcher, copy, depth + 1, run, true); });
          } catch (error) { this.noteRunError(run, `Could not dispatch Continue: ${String(error)}`, node.id, step.id); }
        }
      }
      run.pending--;
      await this.finishRunIfDone(run);
    }
  }
  async handleHook(request: Request, path: string): Promise<Response> {
    const method = request.method.toUpperCase();
    for (const flow of this.deployed.values()) {
      const node = flow.nodes.find(item => item.data.nodeType === 'http-in' && String(item.data.config.method || 'GET').toUpperCase() === method && String(item.data.config.path || '').replace(/^\/+|\/+$/g, '') === path);
      if (!node) continue;
      const requestId = crypto.randomUUID(); const raw = await request.text();
      let payload: unknown = raw; if (raw && request.headers.get('content-type')?.includes('application/json')) { try { payload = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); } }
      const msg = { payload, _requestId: requestId, _msgid: crypto.randomUUID(), method, url: request.url, headers: Object.fromEntries(request.headers) };
      const run = await this.beginRun(flow, 'http', msg);
      run.pending += 2; // Root node plus the pending HTTP response.
      void run.done.catch(error => this.log('error', `Could not finish execution history: ${String(error)}`, undefined, flow.id));
      const response = new Promise<Response>(resolve => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          this.noteRunError(run, 'Workflow did not respond within 30 seconds', node.id);
          run.record.output = historySnapshot({ status: 504, error: 'Workflow did not respond within 30 seconds' });
          run.pending--; void this.finishRunIfDone(run);
          resolve(Response.json({ error: 'Workflow did not respond within 30 seconds' }, { status: 504 }));
        }, 30000);
        this.pending.set(requestId, { resolve, timer, run });
      });
      void this.execute(flow, node, msg, 0, run);
      return response;
    }
    return Response.json({ error: 'No deployed HTTP In node for this route' }, { status: 404 });
  }
}
