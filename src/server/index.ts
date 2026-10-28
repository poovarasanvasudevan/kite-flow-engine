import { mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { Engine } from './engine';
import { DatabaseStore } from './database';
import { SecretVault } from './vault';
import { PluginManager } from './plugins';
import { listEmailFolders } from './email';
import { normalizeWorkflowTags, sameDeploymentContent, type AutomationSummary, type Workflow } from '../shared';
import type { ServerWebSocket } from 'bun';

const root = process.cwd();
const dataDir = resolve(process.env.WFLOW_DATA_DIR || join(root, 'data'));
await mkdir(dataDir, { recursive: true });
const store = new DatabaseStore();
await store.initialize(dataDir);
const vault = new SecretVault(store);
const engine = new Engine(store, store, vault);
type SocketData = { workflowId: string; nodeId: string; connectionId: string; parseJson: boolean };
const webSockets = new Map<string, ServerWebSocket<SocketData>>();
engine.onStop = workflowId => { for (const socket of webSockets.values()) if (socket.data.workflowId === workflowId) socket.close(1001, 'Workflow stopped'); };
engine.websocketSender = (workflowId, nodeId, connectionId, payload, broadcast) => {
  const flow = engine.deployed.get(workflowId);
  if (!flow?.nodes.some(node => node.id === nodeId && node.data.nodeType === 'websocket-in')) throw new Error('WebSocket In node not found in this workflow');
  let sent = 0;
  for (const socket of webSockets.values()) if (socket.data.workflowId === workflowId && socket.data.nodeId === nodeId && (broadcast || socket.data.connectionId === connectionId) && socket.readyState === 1) {
    if (socket.send(payload) >= 0) sent++;
  }
  return sent;
};
const plugins = new PluginManager(engine, dataDir, join(root, 'plugins'));
await plugins.initialize();
let workflows: Workflow[] = await store.listWorkflows();
for (const flow of await store.listDeployments()) try { engine.deploy(flow); } catch (error) { engine.log('error', `Could not restore ${flow.name}: ${String(error)}`); }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const error = (message: string, status = 400) => json({ error: message }, status);
async function body(request: Request) { try { return await request.json(); } catch { throw new Error('Expected a JSON request body'); } }
function find(id: string) { const flow = workflows.find(item => item.id === id); if (!flow) throw new Error('Workflow not found'); return flow; }
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };

let server: Bun.Server<SocketData>;
server = Bun.serve<SocketData>({
  hostname: process.env.WFLOW_HOST || '127.0.0.1', port: Number(process.env.WFLOW_PORT || 3001),
  async fetch(request) {
    const url = new URL(request.url); const path = url.pathname; const method = request.method;
    try {
      if (path.startsWith('/hook/')) return engine.handleHook(request, decodeURIComponent(path.slice(6)).replace(/^\/+|\/+$/g, ''));
      if (path.startsWith('/ws/')) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket upgrade required', 426);
        const route = decodeURIComponent(path.slice(4)).replace(/^\/+|\/+$/g, '');
        for (const flow of engine.deployed.values()) {
          const node = flow.nodes.find(item => item.data.nodeType === 'websocket-in' && String(item.data.config.path || '').replace(/^\/+|\/+$/g, '') === route);
          if (!node) continue;
          const tokenEnv = String(node.data.config.tokenEnv || '').trim();
          if (tokenEnv) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv) || !process.env[tokenEnv]) return error('WebSocket access token is not configured', 503);
            const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
            if (provided !== process.env[tokenEnv]) return error('WebSocket access denied', 401);
          }
          const upgraded = server.upgrade(request, { data: { workflowId: flow.id, nodeId: node.id, connectionId: crypto.randomUUID(), parseJson: node.data.config.parseJson !== false } satisfies SocketData });
          return upgraded ? undefined : error('WebSocket upgrade failed', 500);
        }
        return error('No deployed WebSocket In node for this route', 404);
      }
      if (path === '/api/bootstrap' && method === 'GET') return json({ workflows: workflows.map(flow => {
        const deployed = engine.deployed.get(flow.id);
        return { id: flow.id, name: flow.name, tags: normalizeWorkflowTags(flow.tags), updatedAt: flow.updatedAt, deployed: Boolean(deployed), needsDeploy: Boolean(deployed && !sameDeploymentContent(flow, deployed)) };
      }), definitions: [...engine.definitions.values()], packages: plugins.packages, custom: plugins.custom.map(item => item.definition.type) });
      if (path === '/api/automations' && method === 'GET') {
        const stats = await store.listAutomationStats();
        const rows: AutomationSummary[] = workflows.map(flow => {
          const deployed = engine.deployed.get(flow.id);
          return { id: flow.id, name: flow.name, description: flow.description || '', tags: normalizeWorkflowTags(flow.tags), updatedAt: flow.updatedAt,
            active: Boolean(deployed), needsDeploy: Boolean(deployed && !sameDeploymentContent(flow, deployed)), nodeCount: flow.nodes.length,
            executionCount: 0, ...stats.get(flow.id) };
        });
        return json(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
      if (path === '/api/logs' && method === 'GET') return json(engine.logs.filter(item => !url.searchParams.get('workflowId') || item.workflowId === url.searchParams.get('workflowId')).slice(0, 100));
      if (path === '/api/secrets' && method === 'GET') return json(await vault.list());
      if (path === '/api/secrets' && method === 'POST') {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return error('Cross-origin vault changes are not allowed', 403);
        if (!request.headers.get('content-type')?.includes('application/json')) return error('Expected application/json', 415);
        const input = await body(request) as { name: string; description?: string; value: string };
        return json(await vault.create(input), 201);
      }
      const secretMatch = path.match(/^\/api\/secrets\/([^/]+)$/);
      if (secretMatch && (method === 'PUT' || method === 'DELETE')) {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return error('Cross-origin vault changes are not allowed', 403);
        const id = secretMatch[1];
        if (method === 'DELETE') return await vault.delete(id) ? json({ ok: true }) : error('Secret not found', 404);
        if (!request.headers.get('content-type')?.includes('application/json')) return error('Expected application/json', 415);
        const input = await body(request) as { description?: string; value?: string };
        const updated = await vault.update(id, input);
        return updated ? json(updated) : error('Secret not found', 404);
      }
      const executionsMatch = path.match(/^\/api\/workflows\/([^/]+)\/executions$/);
      if (executionsMatch && method === 'GET') { find(executionsMatch[1]); return json(await store.listExecutions(executionsMatch[1], Number(url.searchParams.get('limit') || 50), Number(url.searchParams.get('offset') || 0))); }
      const executionMatch = path.match(/^\/api\/executions\/([^/]+)$/);
      if (executionMatch && method === 'GET') { const detail = await store.getExecution(executionMatch[1]); return detail ? json(detail) : error('Execution not found', 404); }
      if (path === '/api/workflows' && method === 'POST') {
        const input = await body(request) as Partial<Workflow>;
        const flow: Workflow = { id: crypto.randomUUID(), name: String(input.name || 'Untitled flow').slice(0, 80), description: String(input.description || '').slice(0, 500), tags: normalizeWorkflowTags(input.tags), nodes: [], edges: [], updatedAt: new Date().toISOString() };
        await store.saveWorkflow(flow); workflows.push(flow); return json(flow, 201);
      }
      const workflowMatch = path.match(/^\/api\/workflows\/([^/]+)(?:\/(deploy|stop|inject\/[^/]+))?$/);
      if (workflowMatch) {
        const [, id, action] = workflowMatch;
        if (method === 'GET' && !action) return json(find(id));
        if (method === 'PUT' && !action) {
          find(id);
          const input = await body(request) as Workflow;
          if (input.id !== id || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return error('Invalid workflow');
          engine.validate(input);
          const flow: Workflow = { id, name: String(input.name || 'Untitled flow').slice(0, 80), description: String(input.description || '').slice(0, 500), tags: normalizeWorkflowTags(input.tags), nodes: input.nodes, edges: input.edges, updatedAt: new Date().toISOString() };
          await store.saveWorkflow(flow); workflows = workflows.map(item => item.id === id ? flow : item); return json(flow);
        }
        if (method === 'DELETE' && !action) { find(id); await store.deleteWorkflow(id); engine.stop(id); workflows = workflows.filter(item => item.id !== id); return json({ ok: true }); }
        if (method === 'POST' && action === 'deploy') { const deployed = engine.deploy(find(id)); try { await store.saveDeployment(deployed); } catch (cause) { engine.stop(id); throw cause; } return json({ deployedAt: deployed.deployedAt }); }
        if (method === 'POST' && action === 'stop') { await store.deleteDeployment(id); engine.stop(id); return json({ ok: true }); }
        if (method === 'POST' && action?.startsWith('inject/')) { await engine.inject(id, action.slice(7)); return json({ ok: true }); }
      }
      if (path === '/api/plugins/install' && method === 'POST') { const input = await body(request) as { spec?: string }; return json(await plugins.install(String(input.spec || ''))); }
      if (path === '/api/email/folders' && method === 'POST') { const input = await body(request) as Record<string, unknown>; return json(await listEmailFolders(input)); }
      if (path === '/api/custom-nodes' && method === 'POST') { const input = await body(request) as any; await plugins.addCustom(input); return json({ ok: true }, 201); }
      const customMatch = path.match(/^\/api\/custom-nodes\/([^/]+)$/);
      if (customMatch && method === 'DELETE') { await plugins.removeCustom(customMatch[1]); return json({ ok: true }); }
      if (path.startsWith('/api/')) return error('Endpoint not found', 404);
      const dist = resolve(root, 'dist'); const filePath = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
      const target = filePath.startsWith(dist + '\\') || filePath === dist ? filePath : join(dist, 'index.html');
      const file = Bun.file(target);
      if (await file.exists()) return new Response(file, { headers: { 'Content-Type': mime[extname(target)] || 'application/octet-stream' } });
      const index = Bun.file(join(dist, 'index.html'));
      return await index.exists() ? new Response(index, { headers: { 'Content-Type': 'text/html' } }) : error('UI not built. Run bun run dev or bun run build.', 404);
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); engine.log('error', message); return error(message, message === 'Workflow not found' ? 404 : 400); }
  },
  websocket: {
    maxPayloadLength: 262144,
    open(socket) { webSockets.set(socket.data.connectionId, socket); },
    close(socket) { webSockets.delete(socket.data.connectionId); },
    message(socket, raw) {
      const data = socket.data;
      let payload: unknown = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (data.parseJson) { try { payload = JSON.parse(String(payload)); } catch { socket.send(JSON.stringify({ error: 'Invalid JSON message' })); return; } }
      const message = { payload, _msgid: crypto.randomUUID(), _websocket: { nodeId: data.nodeId, connectionId: data.connectionId } };
      void engine.triggerWebSocket(data.workflowId, data.nodeId, message).catch(cause => engine.log('error', `WebSocket execution failed: ${String(cause)}`, undefined, data.workflowId, data.nodeId));
    },
  },
});
console.log(`Wflow API listening on http://${server.hostname}:${server.port}`);
