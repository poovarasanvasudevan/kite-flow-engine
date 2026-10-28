import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Clock3, GitBranch, X } from 'lucide-react';
import type { ExecutionDetail, ExecutionRun } from '../shared';
import { CodeEditor } from './CodeEditor';

type DataTab = 'input' | 'output' | 'parameters' | 'emissions';
const duration = (started: string, finished?: string) => finished ? `${Math.max(0, Date.parse(finished) - Date.parse(started))} ms` : 'Running';
const triggerLabel = (trigger: ExecutionRun['trigger']) => trigger === 'http' ? 'HTTP request' : trigger === 'email' ? 'Incoming email' : trigger === 'redis' ? 'Redis message' : trigger === 'plugin' ? 'Plugin event' : trigger === 'websocket' ? 'WebSocket message' : trigger === 'schedule' ? 'Scheduled run' : 'Manual run';
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

export function HistoryDrawer({ workflowId, width, resizeHandle, close }: { workflowId: string; width: number; resizeHandle: ReactNode; close: () => void }) {
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dataTab, setDataTab] = useState<DataTab>('input');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getJson<ExecutionRun[]>(`/api/workflows/${workflowId}/executions?limit=50`);
        if (cancelled) return;
        setRuns(list); setError('');
        const id = selectedRunId || list[0]?.id;
        if (!selectedRunId && id) setSelectedRunId(id);
        if (id) {
          const next = await getJson<ExecutionDetail>(`/api/executions/${id}`);
          if (!cancelled) setDetail(next);
        } else setDetail(null);
      } catch (cause) { if (!cancelled) setError((cause as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workflowId, selectedRunId]);

  const step = detail?.steps.find(item => item.id === selectedStepId);
  const tabs: DataTab[] = step ? ['input', 'output', 'parameters', 'emissions'] : ['input', 'output'];
  const value = step ? (dataTab === 'parameters' ? step.parameters : dataTab === 'emissions' ? step.outputs : step[dataTab]) : detail?.run[dataTab === 'output' ? 'output' : 'input'];
  const selectRun = (id: string) => { setSelectedRunId(id); setSelectedStepId(null); setDataTab('input'); setDetail(null); };

  return <aside className="inspector-drawer history-drawer" aria-label="Execution history" style={{ width: `min(${width}px, calc(100vw - 140px))` }}>
    {resizeHandle}
    <div className="drawer-header"><div><span className="eyebrow">WORKFLOW ACTIVITY</span><h2>Execution history</h2></div><button className="small-icon" title="Close execution history" onClick={close}><X size={18}/></button></div>
    <div className="history-runs">
      {loading && !runs.length && <p className="history-empty">Loading executions…</p>}
      {!loading && !runs.length && !error && <p className="history-empty">No executions yet. Run an Inject node or call an HTTP trigger to see history here.</p>}
      {error && <p className="history-error">{error}</p>}
      {runs.map(run => <button key={run.id} className={`history-run ${selectedRunId === run.id ? 'selected' : ''}`} onClick={() => selectRun(run.id)}><span className={`history-status ${run.status}`}>{run.status}</span><span className="history-run-copy"><strong>{triggerLabel(run.trigger)}</strong><small>{new Date(run.startedAt).toLocaleString()} · {duration(run.startedAt, run.finishedAt)}</small></span><ChevronRight size={14}/></button>)}
    </div>
    {detail && <div className="history-detail">
      <div className="history-overview"><span className={`history-status ${detail.run.status}`}>{detail.run.status}</span><strong>{triggerLabel(detail.run.trigger)}</strong><small>{detail.run.nodeCount} nodes · {duration(detail.run.startedAt, detail.run.finishedAt)}</small><div>Started: {new Date(detail.run.startedAt).toLocaleString()}</div><div>Finished: {detail.run.finishedAt ? new Date(detail.run.finishedAt).toLocaleString() : 'Running'}</div>{detail.run.error && <p className="history-error">{detail.run.error}</p>}</div>
      <div className="history-section-label">NODE STEPS</div>
      <button className={`history-step ${!selectedStepId ? 'selected' : ''}`} onClick={() => { setSelectedStepId(null); setDataTab('input'); }}><span className="history-step-index"><GitBranch size={13}/></span><span><strong>Entire execution</strong><small>Run input and output</small></span></button>
      {detail.steps.map(item => <button key={item.id} className={`history-step ${selectedStepId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedStepId(item.id); setDataTab('input'); }}><span className="history-step-index">{item.sequence}</span><span><strong>{item.nodeName}</strong><small>{item.nodeType} · {duration(item.startedAt, item.finishedAt)}</small></span><i className={`history-step-dot ${item.status}`}/></button>)}
      <div className="history-payload"><div className="history-payload-heading"><strong>{step ? step.nodeName : 'Entire execution'}</strong><span>{step ? step.status : detail.run.status}</span></div>{step && <div className="history-step-times"><span>Start: {new Date(step.startedAt).toLocaleString()}</span><span>End: {step.finishedAt ? new Date(step.finishedAt).toLocaleString() : 'Running'}</span>{step.error && <span className="history-error">{step.error}</span>}</div>}<div className="history-data-tabs">{tabs.map(tab => <button key={tab} className={dataTab === tab ? 'active' : ''} onClick={() => setDataTab(tab)}>{tab}</button>)}</div><CodeEditor name={`history-${step?.id || detail.run.id}-${dataTab}`} mode="json" value={JSON.stringify(value ?? null, null, 2)} readOnly height={180}/></div>
      {detail.events.length > 0 && <><div className="history-section-label">EVENTS</div><div className="history-events">{detail.events.map(event => <div key={event.id} className={`history-event ${event.level}`}><time>{new Date(event.time).toLocaleTimeString()}</time><strong>{event.level}</strong><span>{event.message}</span></div>)}</div></>}
    </div>}
    {!detail && runs.length > 0 && !error && <div className="history-empty history-loading"><Clock3 size={18}/> Loading details…</div>}
  </aside>;
}
