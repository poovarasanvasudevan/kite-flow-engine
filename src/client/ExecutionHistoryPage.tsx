import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock3, GitBranch, History, RefreshCw } from 'lucide-react';
import type { ExecutionDetail, ExecutionRun, ExecutionStep, Workflow } from '../shared';
import { CodeEditor } from './CodeEditor';

const formatDate = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const formatDuration = (started: string, finished?: string) => {
  if (!finished) return 'Running';
  const ms = Math.max(0, Date.parse(finished) - Date.parse(started));
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
};
const triggerLabel = (trigger: ExecutionRun['trigger']) => ({ manual: 'Manual', schedule: 'Schedule', http: 'HTTP', email: 'Email', websocket: 'WebSocket', redis: 'Redis', plugin: 'Plugin' })[trigger] || trigger;
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);

async function loadJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load execution history');
  return data as T;
}

function PayloadPanel({ title, name, value }: { title: string; name: string; value: unknown }) {
  return <section className="execution-payload-panel"><div className="execution-payload-heading"><h3>{title}</h3><span>JSON</span></div><CodeEditor name={name} mode="json" value={pretty(value)} readOnly height={210}/></section>;
}

export function ExecutionHistoryPage({ workflowId, executionId, onBack, onOpenWorkflow, onOpenRun, onBackToHistory }: {
  workflowId: string;
  executionId?: string;
  onBack: () => void;
  onOpenWorkflow: () => void;
  onOpenRun: (id: string) => void;
  onBackToHistory: () => void;
}) {
  const [workflow, setWorkflow] = useState<Pick<Workflow, 'name' | 'description'> | null>(null);
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'all' | 'success' | 'error' | 'running'>('all');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setSelectedStepId(null);
    const load = async () => {
      try {
        const [flow, result] = await Promise.all([
          loadJson<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}`),
          executionId ? loadJson<ExecutionDetail>(`/api/executions/${encodeURIComponent(executionId)}`) : loadJson<ExecutionRun[]>(`/api/workflows/${encodeURIComponent(workflowId)}/executions?limit=50`),
        ]);
        if (cancelled) return;
        setWorkflow({ name: flow.name, description: flow.description });
        if (executionId) {
          const next = result as ExecutionDetail;
          if (next.run.workflowId !== workflowId) throw new Error('Execution does not belong to this workflow');
          setDetail(next); setSelectedStepId(next.steps[0]?.id || null);
        } else {
          const list = result as ExecutionRun[];
          setRuns(list); setHasMore(list.length === 50); setDetail(null);
        }
      } catch (cause) { if (!cancelled) setError((cause as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load();
    return () => { cancelled = true; };
  }, [workflowId, executionId, refreshKey]);

  const more = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await loadJson<ExecutionRun[]>(`/api/workflows/${encodeURIComponent(workflowId)}/executions?limit=50&offset=${runs.length}`);
      setRuns(current => [...current, ...next.filter(item => !current.some(existing => existing.id === item.id))]);
      setHasMore(next.length === 50);
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoadingMore(false); }
  };
  const visible = useMemo(() => runs.filter(run => status === 'all' || run.status === status), [runs, status]);
  const selectedStep: ExecutionStep | undefined = detail?.steps.find(step => step.id === selectedStepId);
  const selected = selectedStep || detail?.run;
  const selectedName = selectedStep ? selectedStep.nodeName : 'Entire execution';
  const selectedInput = selectedStep ? selectedStep.input : detail?.run.input;
  const selectedOutput = selectedStep ? selectedStep.output : detail?.run.output;

  return <main className="execution-page">
    <div className="execution-content">
      <div className="execution-heading"><div><button className="execution-back" onClick={executionId ? onBackToHistory : onBack}><ArrowLeft size={15}/>{executionId ? 'All executions' : 'Automations'}</button><h1>{executionId ? 'Execution details' : 'Execution history'}</h1><p>{workflow?.name || 'Workflow'}{executionId ? ' · Inspect each node in the path' : ' · Review every recorded run'}</p></div><div className="execution-heading-actions"><button className="secondary-button" onClick={onOpenWorkflow}><GitBranch size={15}/> Edit workflow</button><button className="secondary-button" onClick={() => setRefreshKey(key => key + 1)}><RefreshCw size={15}/> Refresh</button></div></div>
      {error && <div className="execution-error" role="alert">{error}<button onClick={() => setRefreshKey(key => key + 1)}>Retry</button></div>}
      {loading ? <div className="execution-loading"><Clock3 size={22}/> Loading {executionId ? 'execution' : 'history'}…</div> : executionId && detail ? <>
        <div className="execution-summary"><div><span className={`history-status ${detail.run.status}`}>{detail.run.status}</span><strong>{triggerLabel(detail.run.trigger)} run</strong><small>{detail.run.id}</small></div><div><span>Started</span><strong>{formatDate(detail.run.startedAt)}</strong></div><div><span>Finished</span><strong>{detail.run.finishedAt ? formatDate(detail.run.finishedAt) : 'Running'}</strong></div><div><span>Duration</span><strong>{formatDuration(detail.run.startedAt, detail.run.finishedAt)}</strong></div><div><span>Steps</span><strong>{detail.steps.length}</strong></div></div>
        {detail.run.error && <div className="execution-error">{detail.run.error}</div>}
        <div className="execution-detail-layout">
          <section className="execution-path" aria-label="Execution step path"><div className="execution-section-title"><History size={17}/><h2>Step path</h2><span>{detail.steps.length} steps</span></div><div className="execution-path-list">
            <button className={`execution-path-step ${selectedStepId === null ? 'selected' : ''}`} onClick={() => setSelectedStepId(null)}><span className="execution-path-index"><GitBranch size={15}/></span><span className="execution-path-copy"><strong>Entire execution</strong><small>Run input and final output</small></span><span className={`history-status ${detail.run.status}`}>{detail.run.status}</span></button>
            {detail.steps.map(step => <button key={step.id} className={`execution-path-step ${selectedStepId === step.id ? 'selected' : ''}`} onClick={() => setSelectedStepId(step.id)}><span className="execution-path-index">{step.sequence}</span><span className="execution-path-copy"><strong>{step.nodeName}</strong><small>{step.nodeType} · {formatDuration(step.startedAt, step.finishedAt)}</small></span><span className={`history-status ${step.status}`}>{step.status}</span></button>)}
          </div></section>
          <section className="execution-inspect" aria-label="Selected step details"><div className="execution-inspect-heading"><div><span>{selectedStep ? `STEP ${selectedStep.sequence} · ${selectedStep.nodeType}` : 'RUN DATA'}</span><h2>{selectedName}</h2></div><span className={`history-status ${selected?.status || 'running'}`}>{selected?.status || 'running'}</span></div>
            <div className="execution-times"><div><span>Started</span><strong>{formatDate(selected?.startedAt)}</strong></div><div><span>Finished</span><strong>{selected?.finishedAt ? formatDate(selected.finishedAt) : 'Running'}</strong></div><div><span>Duration</span><strong>{selected?.startedAt ? formatDuration(selected.startedAt, selected.finishedAt) : '—'}</strong></div></div>
            {selectedStep?.error && <div className="execution-error">{selectedStep.error}</div>}
            <div className="execution-payload-grid"><PayloadPanel title="Input" name={`input-${selectedStepId || detail.run.id}`} value={selectedInput}/><PayloadPanel title="Output" name={`output-${selectedStepId || detail.run.id}`} value={selectedOutput}/></div>
            {selectedStep && <div className="execution-extra-grid"><details><summary>Node parameters</summary><CodeEditor name={`parameters-${selectedStep.id}`} mode="json" value={pretty(selectedStep.parameters)} readOnly height={160}/></details><details><summary>Emitted messages</summary><CodeEditor name={`outputs-${selectedStep.id}`} mode="json" value={pretty(selectedStep.outputs)} readOnly height={160}/></details></div>}
          </section>
        </div>
        {detail.events.length > 0 && <section className="execution-events"><h2>Events</h2><div>{detail.events.map(event => <div key={event.id}><time>{formatDate(event.time)}</time><span className={`history-status ${event.level === 'error' ? 'error' : 'success'}`}>{event.level}</span><span>{event.message}</span></div>)}</div></section>}
      </> : !executionId ? <section className="execution-runs-card" aria-label="Execution history"><div className="execution-runs-toolbar"><div><h2>All executions</h2><span>{visible.length} shown</span></div><select aria-label="Filter executions by status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">All statuses</option><option value="success">Success</option><option value="error">Error</option><option value="running">Running</option></select></div>
        {visible.length ? <div className="execution-table-scroll"><table className="execution-table"><thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Duration</th><th>Steps</th><th>Errors</th><th>Execution ID</th><th></th></tr></thead><tbody>{visible.map(run => <tr key={run.id} tabIndex={0} aria-label={`Open execution ${run.id}`} onClick={() => onOpenRun(run.id)} onKeyDown={event => { if (event.key === 'Enter') onOpenRun(run.id); }}><td><strong>{formatDate(run.startedAt)}</strong><small>{run.finishedAt ? `Finished ${formatDate(run.finishedAt)}` : 'Still running'}</small></td><td><span className={`history-status ${run.status}`}>{run.status}</span></td><td>{triggerLabel(run.trigger)}</td><td>{formatDuration(run.startedAt, run.finishedAt)}</td><td>{run.nodeCount}</td><td>{run.errorCount || '—'}</td><td><code>{run.id.slice(0, 8)}</code></td><td><button className="execution-open" aria-label={`View execution ${run.id}`} onClick={event => { event.stopPropagation(); onOpenRun(run.id); }}>View details <ArrowRight size={14}/></button></td></tr>)}</tbody></table></div> : <div className="execution-empty"><History size={25}/><strong>{runs.length ? 'No executions match this status' : 'No executions yet'}</strong><span>{runs.length ? 'Choose another status.' : 'Run the workflow to record its first execution.'}</span></div>}
        {hasMore && <div className="execution-more"><button className="secondary-button" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? 'Loading…' : 'Load more executions'}</button></div>}
      </section> : null}
    </div>
  </main>;
}
