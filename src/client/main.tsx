import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, Handle, Position,
  BaseEdge, EdgeLabelRenderer, MarkerType, addEdge, getSmoothStepPath,
  getNodesBounds, getViewportForBounds,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Bell, BookOpen, Cable,
  Box, Braces, Bug, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Database,
  CircleCheck, Code2, Copy, FileText, GitBranch, Globe2, Layers3, ListChecks, Mail, MailPlus, Menu,
  ImageDown, KeyRound, MoreHorizontal, PackagePlus, Pencil, Play, Plus, Rocket, Search, Send,
  Settings2, Sparkles, Square, Table2, Trash2, X, Zap, ArrowUpRight, ChevronUp,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import '@fontsource-variable/radio-canada/wght.css';
import './style.css';
import { normalizeWorkflowTags, type FlowNode, type LogEvent, type NodeDefinition, type Workflow } from '../shared';
import { CodeEditor } from './CodeEditor';
import { HistoryDrawer } from './HistoryDrawer';
import { AutomationsPage } from './AutomationsPage';
import { ExecutionHistoryPage } from './ExecutionHistoryPage';
import { PluginsPage } from './PluginsPage';
import { ConnectorsPage } from './ConnectorsPage';
import { SecretVaultPage } from './SecretVaultPage';
import { toPng } from 'html-to-image';

type CanvasNode = Node<FlowNode['data']>;
type FlowSummary = { id: string; name: string; tags: string[]; updatedAt: string; deployed: boolean; needsDeploy: boolean };
type Bootstrap = { workflows: FlowSummary[]; definitions: NodeDefinition[]; packages: { name: string; version: string; types: string[]; builtIn: boolean }[]; custom: string[] };
type PaletteGroup = 'Event' | 'Condition' | 'Action' | 'More';
const icons: Record<string, React.ComponentType<any>> = {
  play: Play, globe: Globe2, bug: Bug, send: Send, code: Code2,
  pencil: Pencil, 'git-branch': GitBranch, 'file-text': FileText,
  braces: Braces, clock: Clock3, table: Table2, mail: Mail, 'mail-plus': MailPlus, 'circle-check': CircleCheck, 'arrow-up-right': ArrowUpRight,
  sparkles: Sparkles, database: Database,
};
let definitionsRef: NodeDefinition[] = [];
let nodesRef: CanvasNode[] = [];

function groupOf(definition: NodeDefinition): PaletteGroup {
  if (definition.category === 'Input') return 'Event';
  if (definition.type === 'switch') return 'Condition';
  if (definition.category === 'Custom') return 'More';
  return 'Action';
}
function toneOf(type: string) {
  if (type === 'inject' || type === 'http-in' || type === 'email-in' || type === 'websocket-in' || type === 'redis-subscriber' || type === 'continue') return 'event';
  if (type === 'switch') return 'condition';
  if (type === 'http-request' || type === 'http-response' || type === 'email-out' || type === 'websocket-out' || type === 'websocket-client') return 'network';
  return 'action';
}
function showSetting(nodeType: string, config: Record<string, unknown>, key: string) {
  if (nodeType === 'ssh') return config.authMode === 'password' ? !['privateKeyEnv', 'passphraseEnv'].includes(key) : key !== 'passwordEnv';
  if (nodeType === 'redis') {
    if (key === 'ttlSeconds') return config.operation === 'set';
    if (key === 'parseJson') return !config.operation || config.operation === 'get';
    if (key === 'incrementBy') return config.operation === 'increment';
  }
  return true;
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
const post = <T,>(path: string, data?: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data ?? {}) });

function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const definition = definitionsRef.find(item => item.type === data.nodeType);
  const Icon = icons[definition?.icon || ''] || Box;
  const outputs = definition?.outputs || 0;
  return <div className={`workflow-node ${toneOf(data.nodeType)} ${selected ? 'selected' : ''}`}>
    {definition?.inputs ? <>
      <Handle type="target" id="left" position={Position.Left} className="node-port input left" />
      <Handle type="target" id="top" position={Position.Top} className="node-port input top" />
    </> : null}
    <span className="workflow-node-badge"><Icon size={22} strokeWidth={2.25} /></span>
    <span className="workflow-node-copy"><strong>{data.name || definition?.label || data.nodeType}</strong><small>{definition?.label}</small></span>
    {Array.from({ length: outputs }, (_, port) => <Handle key={port} type="source" id={String(port)} position={Position.Right} className="node-port output right" style={{ top: `${((port + 1) / (outputs + 1)) * 100}%` }} />)}
    {outputs ? <Handle type="source" id={`${outputs === 1 ? 0 : 1}-bottom`} position={Position.Bottom} className="node-port output bottom" /> : null}
  </div>;
}

function WorkflowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition,
    targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition,
    borderRadius: 4, offset: 24,
  });
  const source = nodesRef.find(item => item.id === props.source);
  const label = source?.data.nodeType === 'switch' ? (Number.parseInt(props.sourceHandleId || '0', 10) === 0 ? 'YES' : 'NO') : null;
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={{ stroke: '#aeb7bc', strokeWidth: 2 }} />
    <EdgeLabelRenderer><div className="edge-midpoint" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
      <span className="edge-joint" />{label && <span className="edge-caption">{label}</span>}
    </div></EdgeLabelRenderer>
  </>;
}
const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = { workflow: WorkflowEdge };
const edgeDefaults = { type: 'workflow', markerEnd: { type: MarkerType.ArrowClosed, color: '#aeb7bc', width: 20, height: 20 } };

function DrawerResizeHandle({ width, resize }: { width: number; resize: (width: number) => void }) {
  const updateFromPointer = (clientX: number) => resize(window.innerWidth - clientX);
  return <div
    className="drawer-resize-handle"
    role="separator"
    aria-label="Resize settings drawer"
    aria-orientation="vertical"
    aria-valuemin={280}
    aria-valuemax={640}
    aria-valuenow={width}
    tabIndex={0}
    title="Drag to resize settings"
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); updateFromPointer(event.clientX); }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event.clientX); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 24); }
      if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 24); }
      if (event.key === 'Home') { event.preventDefault(); resize(280); }
      if (event.key === 'End') { event.preventDefault(); resize(640); }
    }}
  />;
}

function historyPath(path: string): { workflowId: string; executionId?: string } | null {
  const match = path.match(/^\/automations\/([^/]+)\/history(?:\/([^/]+))?$/);
  return match ? { workflowId: decodeURIComponent(match[1]), executionId: match[2] ? decodeURIComponent(match[2]) : undefined } : null;
}

function Studio() {
  const [page, setPage] = useState<'editor' | 'automations' | 'plugins' | 'connectors' | 'vault' | 'history' | 'execution'>(() => {
    const route = historyPath(window.location.pathname);
    return route ? route.executionId ? 'execution' : 'history' : window.location.pathname === '/automations' ? 'automations' : window.location.pathname === '/plugins' ? 'plugins' : window.location.pathname === '/connectors' ? 'connectors' : window.location.pathname === '/vault' ? 'vault' : 'editor';
  });
  const [historyRoute, setHistoryRoute] = useState(() => historyPath(window.location.pathname));
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ workflows: [], definitions: [], packages: [], custom: [] });
  const [flow, setFlow] = useState<Workflow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteGroup | 'All' | null>(null);
  const [query, setQuery] = useState('');
  const [flowMenu, setFlowMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<'debug' | 'help'>('debug');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [workflowTitleDraft, setWorkflowTitleDraft] = useState('');
  const [workflowDescriptionDraft, setWorkflowDescriptionDraft] = useState('');
  const [workflowTagsDraft, setWorkflowTagsDraft] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagInputFocused, setTagInputFocused] = useState(false);
  const [workflowActiveDraft, setWorkflowActiveDraft] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('wflow-inspector-width'));
    return Number.isFinite(saved) && saved >= 280 && saved <= 640 ? saved : 360;
  });
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const reactFlow = useReactFlow<CanvasNode, Edge>();
  nodesRef = nodes;
  const resizeInspector = (width: number) => setInspectorWidth(Math.round(Math.max(280, Math.min(640, width))));
  useEffect(() => { window.localStorage.setItem('wflow-inspector-width', String(inspectorWidth)); }, [inspectorWidth]);

  const notify = (message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 4000);
  };
  const refresh = useCallback(async () => {
    const data = await api<Bootstrap>('/api/bootstrap');
    definitionsRef = data.definitions;
    setBootstrap(data);
    return data;
  }, []);
  const openFlow = useCallback(async (id: string, navigate = true) => {
    const data = await api<Workflow>(`/api/workflows/${id}`);
    if (navigate) window.history.pushState({}, '', `/automations/${encodeURIComponent(id)}`);
    setPage('editor');
    setFlow(data);
    setNodes(data.nodes.map(node => ({ id: node.id, type: 'workflow', position: node.position, data: node.data })) as CanvasNode[]);
    setEdges(data.edges.map(edge => ({ ...edge, ...edgeDefaults })) as Edge[]);
    setSelectedId(null); setSelectedLogId(null); setDirty(false); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false);
    window.setTimeout(() => reactFlow.fitView({ padding: 0.35, duration: 350 }), 100);
  }, [reactFlow, setNodes, setEdges]);
  useEffect(() => {
    void refresh().then(data => {
      const path = window.location.pathname;
      if (path === '/automations' || path === '/plugins' || path === '/connectors' || path === '/vault' || historyPath(path)) return;
      const direct = path.match(/^\/automations\/([^/]+)$/);
      if (direct) return openFlow(decodeURIComponent(direct[1]), false);
      if (data.workflows[0]) return openFlow(data.workflows[0].id, false);
    }).catch(error => notify(error.message, true));
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const route = historyPath(window.location.pathname);
      if (route) { setHistoryRoute(route); setPage(route.executionId ? 'execution' : 'history'); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); return; }
      const direct = window.location.pathname.match(/^\/automations\/([^/]+)$/);
      if (direct) void openFlow(decodeURIComponent(direct[1]), false).catch(error => notify(error.message, true));
      else {
        setPage(window.location.pathname === '/automations' ? 'automations' : window.location.pathname === '/plugins' ? 'plugins' : window.location.pathname === '/connectors' ? 'connectors' : window.location.pathname === '/vault' ? 'vault' : 'editor');
        setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openFlow]);
  const showAutomations = () => {
    if (page === 'editor' && dirty && !window.confirm('Discard unsaved changes?')) return;
    if (window.location.pathname !== '/automations') window.history.pushState({}, '', '/automations');
    setPage('automations'); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); setSelectedId(null);
  };
  const showExecutionHistory = (workflowId: string, executionId?: string) => {
    if (page === 'editor' && dirty && !window.confirm('Discard unsaved changes?')) return;
    const path = `/automations/${encodeURIComponent(workflowId)}/history${executionId ? `/${encodeURIComponent(executionId)}` : ''}`;
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setHistoryRoute({ workflowId, executionId }); setPage(executionId ? 'execution' : 'history');
    setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); setSelectedId(null);
  };
  const showPlugins = () => {
    if (page === 'editor' && dirty && !window.confirm('Discard unsaved changes?')) return;
    if (window.location.pathname !== '/plugins') window.history.pushState({}, '', '/plugins');
    setPage('plugins'); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); setSelectedId(null);
  };
  const showConnectors = () => {
    if (page === 'editor' && dirty && !window.confirm('Discard unsaved changes?')) return;
    if (window.location.pathname !== '/connectors') window.history.pushState({}, '', '/connectors');
    setPage('connectors'); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); setSelectedId(null);
  };
  const showVault = () => {
    if (page === 'editor' && dirty && !window.confirm('Discard unsaved changes?')) return;
    if (window.location.pathname !== '/vault') window.history.pushState({}, '', '/vault');
    setPage('vault'); setFlowMenu(false); setPalette(null); setWorkflowSettingsOpen(false); setHistoryOpen(false); setSelectedId(null);
  };
  useEffect(() => {
    if (!flow) return;
    const load = () => { void api<LogEvent[]>(`/api/logs?workflowId=${flow.id}`).then(setLogs); };
    load(); const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [flow?.id]);

  const current = bootstrap.workflows.find(item => item.id === flow?.id);
  const selected = nodes.find(item => item.id === selectedId);
  const selectedDefinition = bootstrap.definitions.find(item => item.type === selected?.data.nodeType);
  const selectedLog = logs.find(item => item.id === selectedLogId);
  const paletteNodes = useMemo(() => bootstrap.definitions.filter(item =>
    (palette === 'All' || groupOf(item) === palette) &&
    `${item.label} ${item.type} ${item.description}`.toLowerCase().includes(query.toLowerCase()),
  ), [bootstrap.definitions, palette, query]);
  const tagSuggestions = useMemo(() => normalizeWorkflowTags(bootstrap.workflows.flatMap(item => item.tags || []))
    .filter(tag => !workflowTagsDraft.some(selectedTag => selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    .filter(tag => tag.toLocaleLowerCase().includes(tagDraft.trim().toLocaleLowerCase())).slice(0, 5),
  [bootstrap.workflows, workflowTagsDraft, tagDraft]);
  const mark = () => setDirty(true);
  const onConnect = useCallback((connection: Connection) => {
    setEdges(existing => addEdge({ ...connection, id: crypto.randomUUID(), ...edgeDefaults }, existing));
    mark();
  }, [setEdges]);
  const addNode = (definition: NodeDefinition, position?: { x: number; y: number }) => {
    const center = position || reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const node: CanvasNode = { id: crypto.randomUUID(), type: 'workflow', position: { x: center.x - 110, y: center.y - 45 }, data: { nodeType: definition.type, name: '', config: structuredClone(definition.defaults) } };
    setNodes(existing => [...existing, node]); setSelectedId(node.id); setWorkflowSettingsOpen(false); setHistoryOpen(false); setPalette(null); mark();
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const definition = bootstrap.definitions.find(item => item.type === event.dataTransfer.getData('application/wflow-node'));
    if (definition) addNode(definition, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };
  const updateSelected = (key: string, value: unknown, name = false) => {
    setNodes(existing => existing.map(item => item.id === selectedId ? {
      ...item, data: name ? { ...item.data, name: String(value) } : { ...item.data, config: { ...item.data.config, [key]: value } },
    } : item));
    mark();
  };
  const save = async (deploy = false) => {
    if (!flow) return;
    setBusy(true);
    try {
      const savedNodes = nodes.map(({ id, position, data }) => ({ id, type: 'workflow', position, data }));
      const savedEdges = edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
      const updated = await api<Workflow>(`/api/workflows/${flow.id}`, { method: 'PUT', body: JSON.stringify({ ...flow, nodes: savedNodes, edges: savedEdges }) });
      setFlow(updated); setDirty(false);
      if (deploy) { await post(`/api/workflows/${flow.id}/deploy`); notify('Workflow activated'); }
      else notify('Workflow saved');
      await refresh();
    } catch (error) { notify((error as Error).message, true); }
    finally { setBusy(false); }
  };
  const openWorkflowSettings = () => {
    if (!flow) return;
    setWorkflowTitleDraft(flow.name);
    setWorkflowDescriptionDraft(flow.description || '');
    setWorkflowTagsDraft(normalizeWorkflowTags(flow.tags));
    setTagDraft('');
    setTagInputFocused(false);
    setWorkflowActiveDraft(Boolean(current?.deployed));
    setSelectedId(null);
    setHistoryOpen(false);
    setWorkflowSettingsOpen(true);
  };
  const openHistory = () => { if (!flow) return; setSelectedId(null); setWorkflowSettingsOpen(false); setHistoryOpen(true); };
  const addWorkflowTag = (value: string) => {
    const next = normalizeWorkflowTags([...workflowTagsDraft, value]);
    if (next.length > workflowTagsDraft.length) setWorkflowTagsDraft(next);
    setTagDraft('');
  };
  const saveWorkflowSettings = async () => {
    if (!flow) return;
    const name = workflowTitleDraft.trim();
    if (!name) { notify('Enter a workflow title', true); return; }
    setBusy(true);
    try {
      const savedNodes = nodes.map(({ id, position, data }) => ({ id, type: 'workflow', position, data }));
      const savedEdges = edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
      const tags = normalizeWorkflowTags([...workflowTagsDraft, tagDraft]);
      const updated = await api<Workflow>(`/api/workflows/${flow.id}`, { method: 'PUT', body: JSON.stringify({ ...flow, name, description: workflowDescriptionDraft.trim(), tags, nodes: savedNodes, edges: savedEdges }) });
      setFlow(updated); setDirty(false);
      if (workflowActiveDraft && !current?.deployed) await post(`/api/workflows/${flow.id}/deploy`);
      if (!workflowActiveDraft && current?.deployed) await post(`/api/workflows/${flow.id}/stop`);
      setWorkflowSettingsOpen(false);
      await refresh(); notify('Workflow details saved');
    } catch (error) { await refresh().catch(() => {}); notify((error as Error).message, true); }
    finally { setBusy(false); }
  };
  const createFlow = async () => {
    try { const created = await post<Workflow>('/api/workflows', { name: 'Untitled workflow' }); await refresh(); await openFlow(created.id); }
    catch (error) { notify((error as Error).message, true); }
  };
  const stopFlow = async () => {
    if (!flow) return;
    try { await post(`/api/workflows/${flow.id}/stop`); await refresh(); notify('Workflow deactivated'); }
    catch (error) { notify((error as Error).message, true); }
  };
  const runInject = async (nodeId: string) => {
    if (!flow) return;
    try { if (dirty) throw new Error('Save and activate changes before running'); await post(`/api/workflows/${flow.id}/inject/${nodeId}`); setBottomTab('debug'); setBottomOpen(true); notify('Message injected'); }
    catch (error) { notify((error as Error).message, true); }
  };
  const deleteFlow = async () => {
    if (!flow || !confirm(`Delete ${flow.name}?`)) return;
    try {
      await api(`/api/workflows/${flow.id}`, { method: 'DELETE' });
      const next = bootstrap.workflows.find(item => item.id !== flow.id); await refresh();
      if (next) await openFlow(next.id); else { setFlow(null); setNodes([]); setEdges([]); window.history.pushState({}, '', '/automations'); setPage('automations'); }
      setMoreMenu(false); notify('Workflow deleted');
    } catch (error) { notify((error as Error).message, true); }
  };
  const exportFlow = () => {
    if (!flow) return;
    const savedNodes = nodes.map(({ id, position, data }) => ({ id, type: 'workflow', position, data }));
    const savedEdges = edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle }));
    const blob = new Blob([JSON.stringify({ ...flow, nodes: savedNodes, edges: savedEdges }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = `${flow.name.toLowerCase().replace(/\W+/g, '-')}.json`; link.click(); URL.revokeObjectURL(link.href);
    setMoreMenu(false);
  };
  const exportImage = async () => {
    if (!flow || !nodes.length) { notify('Add a node before saving an image', true); return; }
    setMoreMenu(false);
    try {
      const viewport = document.querySelector<HTMLElement>('.canvas .react-flow__viewport');
      if (!viewport) throw new Error('Workflow canvas is not ready');
      await document.fonts.ready;
      const bounds = getNodesBounds(reactFlow.getNodes());
      const width = Math.min(4096, Math.max(800, Math.ceil(bounds.width + 180)));
      const height = Math.min(4096, Math.max(450, Math.ceil(bounds.height + 180)));
      const transform = getViewportForBounds(bounds, width, height, 0.1, 2, 0.12);
      const dataUrl = await toPng(viewport, {
        backgroundColor: '#ffffff', width, height, pixelRatio: 2,
        filter: element => !element.classList?.contains('node-port'),
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})` },
      });
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `${flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workflow'}-diagram.png`;
      link.click();
      notify('Workflow image downloaded');
    } catch (error) { notify(`Could not save image: ${(error as Error).message}`, true); }
  };
  const importFlow = async (file: File) => {
    try {
      const imported = JSON.parse(await file.text()) as Workflow;
      if (!Array.isArray(imported.nodes) || !Array.isArray(imported.edges)) throw new Error('Invalid workflow file');
      const created = await post<Workflow>('/api/workflows', { name: `${imported.name || 'Imported'} copy` });
      await api(`/api/workflows/${created.id}`, { method: 'PUT', body: JSON.stringify({ ...imported, id: created.id, name: created.name }) });
      await refresh(); await openFlow(created.id); notify('Workflow imported');
    } catch (error) { notify((error as Error).message, true); }
  };

  return <div className="app-shell">
    <nav className="global-rail" aria-label="Main navigation">
      <button className="rail-logo" aria-label="Wflow home" data-tooltip="Wflow home" onClick={showAutomations}><img src="/wflow-logo.svg" alt="Wflow Logo" /></button>
      <div className="rail-divider" />
      <button className={`rail-item ${page === 'automations' || page === 'history' || page === 'execution' ? 'active' : ''}`} aria-label="Automations" data-tooltip="Automations" onClick={showAutomations}><GitBranch size={20} /></button>
      <button className="rail-item" aria-label="Debug activity" data-tooltip="Debug activity" onClick={() => { setBottomTab('debug'); setBottomOpen(true); }}><Activity size={20} /></button>
      <button className={`rail-item ${page === 'plugins' ? 'active' : ''}`} aria-label="Plugins and nodes" data-tooltip="Plugins and nodes" onClick={showPlugins}><Layers3 size={20} /></button>
      <button className={`rail-item ${page === 'connectors' ? 'active' : ''}`} aria-label="Connectors" data-tooltip="Connectors" onClick={showConnectors}><Cable size={20} /></button>
      <button className={`rail-item ${page === 'vault' ? 'active' : ''}`} aria-label="Secret Vault" data-tooltip="Secret Vault" onClick={showVault}><KeyRound size={20} /></button>
      <div className="rail-spacer" />
      <button className="rail-item" aria-label="Manage plugins" data-tooltip="Manage plugins" onClick={showPlugins}><Settings2 size={20} /></button>
      <button className="rail-grid" aria-label="Node library" data-tooltip="Node library" onClick={() => setPalette('All')}><span/><span/><span/><span/><span/><span/><span/><span/><span/></button>
    </nav>

    <div className="application">
      <header className="global-header">
        <div className="breadcrumbs"><button onClick={showAutomations}>Workspace</button><ChevronRight size={13}/>{page === 'editor' ? <><button onClick={showAutomations}>Automations</button><ChevronRight size={13}/><strong>{flow?.name || 'Workflows'}</strong></> : page === 'history' || page === 'execution' ? <><button onClick={showAutomations}>Automations</button><ChevronRight size={13}/>{page === 'execution' && historyRoute ? <><button onClick={() => showExecutionHistory(historyRoute.workflowId)}>History</button><ChevronRight size={13}/><strong>Execution details</strong></> : <strong>History</strong>}</> : <strong>{page === 'plugins' ? 'Plugins & nodes' : page === 'connectors' ? 'Connectors' : page === 'vault' ? 'Secret Vault' : 'Automations'}</strong>}</div>
        <div className="header-spacer" />
        {page === 'editor' && <div className="header-search"><Search size={14}/><input aria-label="Search nodes" placeholder="Search nodes" value={query} onClick={() => setPalette('All')} onChange={event => { setQuery(event.target.value); setPalette('All'); }}/></div>}
        <button className="header-plus" title="New workflow" onClick={createFlow}><Plus size={15}/></button>
        <button className="header-icon" title="All workflows" onClick={showAutomations}><ListChecks size={16}/></button>
        <button className="header-icon" title="Help" onClick={() => { setBottomTab('help'); setBottomOpen(true); }}><CircleHelp size={16}/></button>
        <button className="header-icon" title="Debug activity" onClick={() => { setBottomTab('debug'); setBottomOpen(true); }}><Bell size={16}/>{logs.some(item => item.level === 'error') && <i className="notification-dot"/>}</button>
        <button className="user-avatar" title="Local workspace">W</button>
      </header>
      {page === 'automations' ? <AutomationsPage onOpen={id => { void openFlow(id).catch(error => notify(error.message, true)); }} onHistory={id => showExecutionHistory(id)} onCreate={() => { void createFlow(); }}/> : (page === 'history' || page === 'execution') && historyRoute ? <ExecutionHistoryPage workflowId={historyRoute.workflowId} executionId={historyRoute.executionId} onBack={showAutomations} onOpenWorkflow={() => { void openFlow(historyRoute.workflowId).catch(error => notify(error.message, true)); }} onOpenRun={id => showExecutionHistory(historyRoute.workflowId, id)} onBackToHistory={() => showExecutionHistory(historyRoute.workflowId)}/> : page === 'connectors' ? <ConnectorsPage definitions={bootstrap.definitions} onBrowsePlugins={showPlugins} notify={notify}/> : page === 'plugins' ? <PluginsPage key={page} connectorsOnly={false} onBrowsePlugins={showPlugins} definitions={bootstrap.definitions} packages={bootstrap.packages} refresh={refresh} notify={notify} openCustom={() => setCustomOpen(true)}/> : page === 'vault' ? <SecretVaultPage notify={notify}/> : <>
      <div className="workflow-header">
        <div className="workflow-heading">
          <div className="workflow-heading-top"><h1 className="workflow-title" title={flow?.name || ''}>{flow?.name || 'Select a workflow'}</h1><span className={`state-badge ${current?.deployed ? 'active' : ''}`}><span className="state-badge-dot"/>{current?.deployed ? 'ACTIVE' : 'DRAFT'}</span><button className="title-edit" title="Edit workflow details" aria-label="Edit workflow details" disabled={!flow} onClick={openWorkflowSettings}><Pencil size={14}/></button>{dirty && <span className="unsaved-label">Unsaved changes</span>}</div>
        </div>
        <div className="workflow-actions">
          {dirty && <button className="save-button" disabled={busy} onClick={() => void save()}><Check size={15}/> Save</button>}
          <button className="history-button" disabled={!flow} onClick={openHistory}><Clock3 size={14}/> History</button>
          {current?.deployed && <button className="deactivate-button" onClick={stopFlow}><Square size={13}/> Deactivate</button>}
          <button className="activate-button" disabled={!flow || busy || (current?.deployed && !dirty && !current.needsDeploy)} onClick={() => void save(true)}><Rocket size={15}/>{busy ? 'Working…' : current?.deployed ? 'Redeploy' : 'Activate'}</button>
          <div className="popover-anchor"><button className="more-button" title="More workflow actions" onClick={() => setMoreMenu(value => !value)}><MoreHorizontal size={18}/></button>{moreMenu && <div className="action-menu"><button onClick={() => void exportImage()}><ImageDown size={15}/> Save as image</button><button onClick={exportFlow}><ArrowDownToLine size={15}/> Export JSON</button><button onClick={() => { importRef.current?.click(); setMoreMenu(false); }}><ArrowUpFromLine size={15}/> Import JSON</button><button className="danger" onClick={deleteFlow}><Trash2 size={15}/> Delete workflow</button></div>}</div>
          <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importFlow(file); event.target.value = ''; }}/>
        </div>
      </div>

      <div className="editor-body">
        <aside className="node-toolbox" aria-label="Node tools">
          <button className="tool-search" title="Search all nodes" onClick={() => setPalette('All')}><Search size={18}/></button>
          {(['Event', 'Condition', 'Action', 'More'] as PaletteGroup[]).map(group => <button key={group} className={`tool-category ${group.toLowerCase()} ${palette === group ? 'chosen' : ''}`} onClick={() => { setQuery(''); setPalette(palette === group ? null : group); }}><span className="tool-symbol">{group === 'Event' ? <Zap size={16} fill="currentColor"/> : group === 'Condition' ? <ListChecks size={16}/> : group === 'Action' ? <ArrowRight size={16} strokeWidth={2.5}/> : <MoreHorizontal size={17}/>}</span><span>{group.toUpperCase()}</span></button>)}
          <div className="tool-spacer"/><button className="tool-bottom" title="Help" onClick={() => { setBottomTab('help'); setBottomOpen(true); }}><CircleHelp size={18}/></button>
        </aside>

        {palette && <aside className="palette-drawer"><div className="drawer-header"><div><span className="eyebrow">NODE LIBRARY</span><h2>{palette === 'All' ? 'All nodes' : palette}</h2></div><button className="small-icon" title="Close node library" onClick={() => setPalette(null)}><X size={18}/></button></div><div className="palette-search"><Search size={16}/><input placeholder="Find a node…" value={query} onChange={event => setQuery(event.target.value)}/></div><div className="palette-items">{paletteNodes.map(definition => { const Icon = icons[definition.icon] || Box; return <button key={definition.type} draggable onDragStart={event => event.dataTransfer.setData('application/wflow-node', definition.type)} onClick={() => addNode(definition)}><span className={`palette-item-icon ${toneOf(definition.type)}`}><Icon size={18}/></span><span><strong>{definition.label}</strong><small>{definition.description}</small></span><Plus size={16}/></button>; })}{paletteNodes.length === 0 && <div className="palette-empty">No nodes match your search.</div>}</div><div className="palette-footer"><button onClick={() => { setPalette(null); setCustomOpen(true); }}><Plus size={16}/> Create custom node</button><button onClick={showPlugins}><PackagePlus size={16}/> Manage plugins</button></div></aside>}

        {flow ? <div className="canvas" onDragOver={event => event.preventDefault()} onDrop={onDrop}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultEdgeOptions={edgeDefaults} onNodesChange={changes => { onNodesChange(changes); if (changes.some(change => change.type !== 'select' && change.type !== 'dimensions')) mark(); }} onEdgesChange={changes => { onEdgesChange(changes); if (changes.some(change => change.type !== 'select')) mark(); }} onConnect={onConnect} onNodeClick={(_, node) => { setSelectedId(node.id); setWorkflowSettingsOpen(false); setHistoryOpen(false); }} onNodeDoubleClick={(_, node) => { if (node.data.nodeType === 'inject') void runInject(node.id); }} onPaneClick={() => { setSelectedId(null); setPalette(null); }} fitView fitViewOptions={{ padding: .35 }} snapToGrid snapGrid={[20, 20]} proOptions={{ hideAttribution: true }}>
            <Background variant={BackgroundVariant.Dots} color="#cbd5e1" gap={24} size={1.2}/>
            <Controls position="bottom-right" showInteractive={false}/>
          </ReactFlow>
          <div className="canvas-tip"><Sparkles size={12}/> Drag nodes onto the canvas or click to add</div>
        </div> : <div className="canvas empty-canvas"><GitBranch size={42}/><h2>Create your first workflow</h2><button className="activate-button" onClick={createFlow}><Plus size={16}/> New workflow</button></div>}

        {workflowSettingsOpen && flow && <aside className="inspector-drawer workflow-settings-drawer" aria-label="Workflow details" style={{ width: `min(${inspectorWidth}px, calc(100vw - 140px))` }}>
          <DrawerResizeHandle width={inspectorWidth} resize={resizeInspector}/>
          <div className="drawer-header"><div><span className="eyebrow">WORKFLOW SETTINGS</span><h2>Edit details</h2></div><button className="small-icon" title="Close workflow details" onClick={() => setWorkflowSettingsOpen(false)}><X size={18}/></button></div>
          <div className="inspector-fields">
            <label className="field"><span>Title</span><input autoFocus maxLength={80} value={workflowTitleDraft} onChange={event => setWorkflowTitleDraft(event.target.value)} /></label>
            <label className="field"><span>Description</span><textarea rows={6} maxLength={500} placeholder="Describe this workflow" value={workflowDescriptionDraft} onChange={event => setWorkflowDescriptionDraft(event.target.value)} /></label>
            <div className="field workflow-tags-field"><span id="workflow-tags-label">Tags</span><div className="workflow-tag-picker" onClick={() => document.getElementById('workflow-tag-input')?.focus()}>
              {workflowTagsDraft.map(tag => <span className="workflow-tag-chip" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag} tag`} onClick={event => { event.stopPropagation(); setWorkflowTagsDraft(existing => existing.filter(item => item !== tag)); }}><X size={12}/></button></span>)}
              <input id="workflow-tag-input" aria-labelledby="workflow-tags-label" maxLength={32} placeholder={workflowTagsDraft.length ? 'Add another…' : 'Add tags…'} value={tagDraft} onFocus={() => setTagInputFocused(true)} onBlur={() => setTagInputFocused(false)} onChange={event => setTagDraft(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addWorkflowTag(tagDraft); }
                if (event.key === 'Backspace' && !tagDraft) setWorkflowTagsDraft(existing => existing.slice(0, -1));
              }}/>
            </div>{tagInputFocused && tagSuggestions.length > 0 && <div className="workflow-tag-suggestions">{tagSuggestions.map(tag => <button type="button" key={tag} onMouseDown={event => event.preventDefault()} onClick={() => addWorkflowTag(tag)}>{tag}</button>)}</div>}<small className="workflow-tag-hint">Press Enter or comma to add a tag</small></div>
            <label className="workflow-active-setting"><span className="workflow-active-copy"><strong>Is active</strong><small>Run this workflow after saving</small></span><input type="checkbox" role="switch" checked={workflowActiveDraft} onChange={event => setWorkflowActiveDraft(event.target.checked)}/><span className="workflow-toggle-track" aria-hidden="true"><span/></span></label>
          </div>
          <div className="workflow-settings-actions"><button className="secondary-button" disabled={busy} onClick={() => setWorkflowSettingsOpen(false)}>Cancel</button><button className="activate-button" disabled={busy || !workflowTitleDraft.trim()} onClick={() => void saveWorkflowSettings()}>{busy ? 'Saving…' : 'Save'}</button></div>
        </aside>}

        {historyOpen && flow && <HistoryDrawer workflowId={flow.id} width={inspectorWidth} resizeHandle={<DrawerResizeHandle width={inspectorWidth} resize={resizeInspector}/>} close={() => setHistoryOpen(false)}/>}

        {selected && selectedDefinition && <aside className="inspector-drawer" style={{ width: `min(${inspectorWidth}px, calc(100vw - 140px))` }}><DrawerResizeHandle width={inspectorWidth} resize={resizeInspector}/><div className="drawer-header"><div><span className="eyebrow">NODE SETTINGS</span><h2>{selectedDefinition.label}</h2></div><button className="small-icon" onClick={() => setSelectedId(null)} title="Close settings"><X size={18}/></button></div><div className="inspector-intro"><span className={`inspector-icon ${toneOf(selected.data.nodeType)}`}>{React.createElement(icons[selectedDefinition.icon] || Box, { size: 22 })}</span><p>{selectedDefinition.description}</p></div><div className="inspector-fields"><label className="field"><span>Name</span><input value={selected.data.name || ''} placeholder={selectedDefinition.label} onChange={event => updateSelected('name', event.target.value, true)}/></label>{selectedDefinition.fields.filter(field => showSetting(selected.data.nodeType, selected.data.config, field.key)).map(field => <label className="field" key={field.key}><span>{field.label}</span>{selected.data.nodeType === 'email-in' && field.key === 'folders' ? <EmailFoldersField value={String(selected.data.config.folders ?? 'INBOX')} config={selected.data.config} onChange={value => updateSelected('folders', value)}/> : field.type === 'select' ? <select value={String(selected.data.config[field.key] ?? '')} onChange={event => updateSelected(field.key, event.target.value)}>{field.options?.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'boolean' ? <span className="toggle-line"><input type="checkbox" checked={Boolean(selected.data.config[field.key])} onChange={event => updateSelected(field.key, event.target.checked)}/>{selected.data.config[field.key] ? 'Enabled' : 'Disabled'}</span> : field.type === 'code' || field.type === 'json' ? <CodeEditor name={`${selected.id}-${field.key}`} mode={field.type === 'code' ? 'javascript' : 'json'} value={String(selected.data.config[field.key] ?? '')} onChange={value => updateSelected(field.key, value)} height={field.type === 'code' ? 210 : 115}/> : field.type === 'textarea' ? <textarea rows={5} value={String(selected.data.config[field.key] ?? '')} placeholder={field.placeholder} onChange={event => updateSelected(field.key, event.target.value)}/> : <input type={field.type === 'number' ? 'number' : 'text'} value={String(selected.data.config[field.key] ?? '')} placeholder={field.placeholder} onChange={event => updateSelected(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)}/>}</label>)}{selected.data.nodeType === 'inject' && <button className="run-button" onClick={() => void runInject(selected.id)}><Play size={16}/> Run injection</button>}</div><div className="inspector-actions"><button onClick={() => { const copy = { ...selected, id: crypto.randomUUID(), position: { x: selected.position.x + 40, y: selected.position.y + 110 } }; setNodes(existing => [...existing, copy]); mark(); }}><Copy size={15}/> Duplicate</button><button className="danger" onClick={() => { setNodes(existing => existing.filter(item => item.id !== selected.id)); setEdges(existing => existing.filter(item => item.source !== selected.id && item.target !== selected.id)); setSelectedId(null); mark(); }}><Trash2 size={15}/> Delete</button></div></aside>}

      </div>
      <section className={`bottom-panel ${bottomOpen ? '' : 'collapsed'}`} aria-label="Debug and help">
        <div className="bottom-tabs">
          <button className={bottomTab === 'debug' ? 'active' : ''} onClick={() => { setBottomTab('debug'); setBottomOpen(true); }}><Activity size={15}/> Debug <span className="log-count">{logs.length}</span></button>
          <button className={bottomTab === 'help' ? 'active' : ''} onClick={() => { setBottomTab('help'); setBottomOpen(true); }}><CircleHelp size={15}/> Help</button>
          <span className="bottom-spacer"/>
          <button className="bottom-toggle" title={bottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'} onClick={() => setBottomOpen(value => !value)}>{bottomOpen ? <ChevronDown size={17}/> : <ChevronUp size={17}/>}</button>
        </div>
        {bottomOpen && (bottomTab === 'debug' ? <div className="bottom-debug">
          <div className="bottom-log-list">{logs.length ? logs.map(item => <button key={item.id} className={`bottom-log ${item.level} ${selectedLog?.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedLogId(item.id)}><time>{new Date(item.time).toLocaleTimeString()}</time><span className="bottom-log-level">{item.level}</span><span className="bottom-log-message">{item.message}{item.data !== undefined && <small>{typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}</small>}</span></button>) : <div className="bottom-empty"><Bug size={17}/> Activate a workflow and run an Inject node to see messages.</div>}</div>
          <div className="debug-json-panel"><div className="debug-json-heading">MESSAGE DATA <span>JSON VIEW</span></div>{selectedLog?.data !== undefined ? <CodeEditor name="debug-json-view" mode="json" value={JSON.stringify(selectedLog.data, null, 2) ?? 'null'} readOnly height="100%"/> : <div className="debug-json-empty">Select a message to inspect its data.</div>}</div>
        </div> : <div className="bottom-help"><strong>Build a workflow</strong><span>Choose an Event, Condition, or Action from the toolbox.</span><span>Connect the node handles, edit settings, then save and activate.</span><span>Double-click an Inject node to run it.</span></div>)}
      </section>
      </>}
    </div>

    {flowMenu && <div className="flow-switcher"><div className="drawer-header"><div><span className="eyebrow">WORKSPACE</span><h2>Workflows</h2></div><button className="small-icon" onClick={() => setFlowMenu(false)}><X size={18}/></button></div><div className="flow-switcher-list">{bootstrap.workflows.map(item => <button key={item.id} className={item.id === flow?.id ? 'current' : ''} onClick={() => { if (dirty && !confirm('Discard unsaved changes?')) return; void openFlow(item.id); }}><GitBranch size={18}/><span><strong>{item.name}</strong><small>{item.deployed ? 'Active' : 'Draft'} · {new Date(item.updatedAt).toLocaleDateString()}</small></span>{item.deployed && <i/>}</button>)}</div><button className="new-flow" onClick={() => { setFlowMenu(false); void createFlow(); }}><Plus size={17}/> New workflow</button></div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <X size={16}/> : <Check size={16}/>} {toast.message}</div>}
    {customOpen && <CustomModal close={() => setCustomOpen(false)} refresh={refresh} notify={notify}/>}
  </div>;
}

function EmailFoldersField({ value, config, onChange }: { value: string; config: Record<string, unknown>; onChange: (value: string) => void }) {
  const [available, setAvailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selected = value.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean);
  const browse = async () => {
    setLoading(true); setError('');
    try { setAvailable(await post<string[]>('/api/email/folders', config)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  const toggle = (folder: string) => onChange(selected.includes(folder) ? selected.filter(item => item !== folder).join('\n') : [...selected, folder].join('\n'));
  return <div className="email-folders-field" onClick={event => event.stopPropagation()}>
    <textarea aria-label="IMAP folders" rows={3} value={value} onChange={event => onChange(event.target.value)} placeholder="INBOX, Archive/Orders"/>
    <button type="button" className="email-browse-button" disabled={loading} onClick={() => void browse()}>{loading ? 'Loading folders…' : 'Browse folders'}</button>
    {error && <small className="history-error">{error}</small>}
    {available.length > 0 && <div className="email-folder-list">{available.map(folder => <label key={folder}><input type="checkbox" checked={selected.includes(folder)} onChange={() => toggle(folder)}/>{folder}</label>)}</div>}
  </div>;
}

function CustomModal({ close, refresh, notify }: { close: () => void; refresh: () => Promise<Bootstrap>; notify: (message: string, error?: boolean) => void }) {
  const [type, setType] = useState('custom-my-node'); const [label, setLabel] = useState('My node'); const [description, setDescription] = useState('A custom workflow node.'); const [code, setCode] = useState('msg.payload = String(msg.payload).toUpperCase();\nreturn msg;'); const [fieldsText, setFieldsText] = useState('[]'); const [outputs, setOutputs] = useState(1); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); try { const fields = JSON.parse(fieldsText); if (!Array.isArray(fields)) throw new Error('Fields must be a JSON array'); const defaults = Object.fromEntries(fields.map((field: { key: string; default?: unknown }) => [field.key, field.default ?? ''])); await post('/api/custom-nodes', { definition: { type, label, description, category: 'Custom', color: '#c8d7f0', icon: 'code', inputs: 1, outputs, defaults, fields }, code }); await refresh(); notify('Custom node created'); close(); } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); } };
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal custom-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-header"><div><span className="eyebrow">NODE BUILDER</span><h2>Create custom node</h2></div><button className="small-icon" onClick={close}><X size={19}/></button></div>
      <div className="custom-fields">
        <label className="field"><span>Type ID</span><input value={type} onChange={event => setType(event.target.value)}/></label>
        <label className="field"><span>Display name</span><input value={label} onChange={event => setLabel(event.target.value)}/></label>
        <label className="field"><span>Description</span><input value={description} onChange={event => setDescription(event.target.value)}/></label>
        <label className="field"><span>Outputs</span><input type="number" min="0" max="8" value={outputs} onChange={event => setOutputs(Number(event.target.value))}/></label>
        <div className="field"><span>Editor fields (JSON array)</span><CodeEditor name="custom-fields-json" mode="json" value={fieldsText} onChange={setFieldsText} height={92}/></div>
        <div className="field"><span>JavaScript body</span><CodeEditor name="custom-node-javascript" mode="javascript" value={code} onChange={setCode} height={184}/></div>
        <p className="field-help">Use <code>msg</code>, <code>config</code>, <code>context</code>, <code>send(port, msg)</code>, and <code>log(value)</code>. Return a message to send on output 1.</p>
      </div>
      <div className="modal-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="activate-button" disabled={busy} onClick={create}>Create node</button></div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Studio/></ReactFlowProvider>);
