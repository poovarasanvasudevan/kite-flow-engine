export type Field = { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json' | 'code'; options?: string[]; placeholder?: string };
export type NodeDefinition = { type: string; label: string; category: string; color: string; icon: string; inputs: number; outputs: number; description: string; defaults: Record<string, unknown>; fields: Field[]; source?: string };
export type FlowNode = { id: string; type: string; position: { x: number; y: number }; data: { nodeType: string; name?: string; config: Record<string, unknown> } };
export type FlowEdge = { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
export type Workflow = { id: string; name: string; description?: string; tags?: string[]; nodes: FlowNode[]; edges: FlowEdge[]; updatedAt: string; deployedAt?: string };
export type AutomationSummary = { id: string; name: string; description: string; tags: string[]; updatedAt: string; active: boolean; needsDeploy: boolean; nodeCount: number; executionCount: number; lastExecutionAt?: string; lastExecutionStatus?: ExecutionStatus; avgExecutionMs?: number };

export function normalizeWorkflowTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.reduce<string[]>((tags, entry) => {
    const tag = String(entry).trim().replace(/\s+/g, ' ').slice(0, 32);
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key) && tags.length < 20) { seen.add(key); tags.push(tag); }
    return tags;
  }, []);
}

export function sameDeploymentContent(left: Workflow, right: Workflow): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
  };
  const content = (flow: Workflow) => stable({ name: flow.name, description: flow.description || '', tags: normalizeWorkflowTags(flow.tags), nodes: flow.nodes, edges: flow.edges });
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}
export type Message = Record<string, any>;
export type LogEvent = { id: string; time: string; level: 'info' | 'error' | 'debug'; nodeId?: string; workflowId?: string; message: string; data?: unknown };
export type ExecutionStatus = 'running' | 'success' | 'error';
export type ExecutionRun = { id: string; workflowId: string; workflowName: string; trigger: 'manual' | 'schedule' | 'http' | 'email' | 'websocket' | 'redis' | 'plugin'; status: ExecutionStatus; startedAt: string; finishedAt?: string; input: unknown; output?: unknown; error?: string; nodeCount: number; errorCount: number };
export type ExecutionStep = { id: string; executionId: string; sequence: number; nodeId: string; nodeName: string; nodeType: string; status: ExecutionStatus; startedAt: string; finishedAt?: string; input: unknown; output?: unknown; outputs?: { port: number; message: unknown }[]; parameters: unknown; error?: string };
export type ExecutionEvent = { id: string; executionId: string; stepId?: string; nodeId?: string; level: LogEvent['level']; time: string; message: string; data?: unknown };
export type ExecutionDetail = { run: ExecutionRun; steps: ExecutionStep[]; events: ExecutionEvent[] };
export type ExecutionRecorder = { startRun(run: ExecutionRun): Promise<void>; finishRun(run: ExecutionRun): Promise<void>; startStep(step: ExecutionStep): Promise<void>; finishStep(step: ExecutionStep): Promise<void>; recordEvent(event: ExecutionEvent): Promise<void> };
export type NodeContext = { nodeId: string; workflowId: string; config: Record<string, any>; send: (port: number, message: Message) => void; log: (message: string, data?: unknown, level?: LogEvent['level']) => void; getSecret: (name: string) => Promise<string>; context: Map<string, unknown>; respond: (requestId: string, status: number, body: unknown, headers?: Record<string, string>) => void; websocketSend?: (nodeId: string, connectionId: string | undefined, payload: string, broadcast: boolean) => number };
export type NodeHandler = (message: Message, context: NodeContext) => void | Promise<void>;
export type NodeStarter = (context: { workflowId: string; node: FlowNode; emit: (message: Message) => Promise<boolean>; log: (message: string) => void; getSecret: (name: string) => Promise<string> }) => () => void;
