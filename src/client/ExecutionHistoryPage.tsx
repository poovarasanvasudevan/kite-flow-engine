import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2,
  Clock3, Copy, ExternalLink, GitBranch, Globe2, History, Layers3,
  Mail, Play, Radio, RefreshCw, Search, ShieldCheck, Terminal, X, XCircle, Zap
} from 'lucide-react';
import type { ExecutionDetail, ExecutionRun, ExecutionStep, Workflow } from '../shared';
import { CodeEditor } from './CodeEditor';

const formatDate = (value?: string) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
};

const formatDuration = (started: string, finished?: string) => {
  if (!finished) return 'Running…';
  const ms = Math.max(0, Date.parse(finished) - Date.parse(started));
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;
};

const triggerInfo = (trigger: ExecutionRun['trigger']) => {
  switch (trigger) {
    case 'manual':
      return { label: 'Manual Trigger', icon: <Play size={13} />, color: '#6366f1' };
    case 'http':
      return { label: 'Webhook (HTTP In)', icon: <Globe2 size={13} />, color: '#0ea5e9' };
    case 'email':
      return { label: 'Email Ingest', icon: <Mail size={13} />, color: '#8b5cf6' };
    case 'schedule':
      return { label: 'Scheduled Cron', icon: <Clock3 size={13} />, color: '#f59e0b' };
    case 'websocket':
      return { label: 'WebSocket Stream', icon: <Radio size={13} />, color: '#10b981' };
    case 'redis':
      return { label: 'Redis Pub/Sub', icon: <Terminal size={13} />, color: '#ef4444' };
    default:
      return { label: trigger || 'Event', icon: <Zap size={13} />, color: '#64748b' };
  }
};

const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);

async function loadJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load execution history');
  return data as T;
}

function PayloadPanel({ title, name, value }: { title: string; name: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const jsonStr = pretty(value);

  const copyPayload = () => {
    navigator.clipboard.writeText(jsonStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="execution-payload-panel">
      <div className="execution-payload-heading">
        <div className="flex items-center gap-2">
          <h3>{title}</h3>
          <span className="payload-type-tag">JSON</span>
        </div>
        <button
          type="button"
          className="payload-copy-btn"
          title={`Copy ${title} JSON`}
          onClick={copyPayload}
        >
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <CodeEditor name={name} mode="json" value={jsonStr} readOnly height={220} />
    </section>
  );
}

export function ExecutionHistoryPage({
  workflowId,
  executionId,
  onBack,
  onOpenWorkflow,
  onOpenRun,
  onBackToHistory,
}: {
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
  const [query, setQuery] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [copiedRunId, setCopiedRunId] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelectedStepId(null);

    const load = async () => {
      try {
        const [flow, result] = await Promise.all([
          loadJson<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}`),
          executionId
            ? loadJson<ExecutionDetail>(`/api/executions/${encodeURIComponent(executionId)}`)
            : loadJson<ExecutionRun[]>(`/api/workflows/${encodeURIComponent(workflowId)}/executions?limit=50`),
        ]);
        if (cancelled) return;
        setWorkflow({ name: flow.name, description: flow.description });
        if (executionId) {
          const next = result as ExecutionDetail;
          if (next.run.workflowId !== workflowId) throw new Error('Execution does not belong to this workflow');
          setDetail(next);
          setSelectedStepId(next.steps[0]?.id || null);
        } else {
          const list = result as ExecutionRun[];
          setRuns(list);
          setHasMore(list.length === 50);
          setDetail(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [workflowId, executionId, refreshKey]);

  const more = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await loadJson<ExecutionRun[]>(
        `/api/workflows/${encodeURIComponent(workflowId)}/executions?limit=50&offset=${runs.length}`
      );
      setRuns(current => [...current, ...next.filter(item => !current.some(existing => existing.id === item.id))]);
      setHasMore(next.length === 50);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  // Run statistics
  const stats = useMemo(() => {
    if (!runs.length) return { total: 0, success: 0, error: 0, running: 0, successRate: '100%', avgDuration: '—' };
    const success = runs.filter(r => r.status === 'success').length;
    const err = runs.filter(r => r.status === 'error').length;
    const running = runs.filter(r => r.status === 'running').length;
    const rate = Math.round((success / runs.length) * 100);

    const durations = runs
      .filter(r => r.finishedAt)
      .map(r => Date.parse(r.finishedAt!) - Date.parse(r.startedAt));
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const avgStr = avg < 1000 ? `${avg}ms` : `${(avg / 1000).toFixed(1)}s`;

    return {
      total: runs.length,
      success,
      error: err,
      running,
      successRate: `${rate}%`,
      avgDuration: avgStr,
    };
  }, [runs]);

  const visibleRuns = useMemo(() => {
    return runs.filter(run => {
      if (status !== 'all' && run.status !== status) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        run.id.toLowerCase().includes(q) ||
        run.trigger.toLowerCase().includes(q) ||
        (run.status && run.status.toLowerCase().includes(q))
      );
    });
  }, [runs, status, query]);

  const selectedStep: ExecutionStep | undefined = detail?.steps.find(step => step.id === selectedStepId);
  const selected = selectedStep || detail?.run;
  const selectedName = selectedStep ? selectedStep.nodeName : 'Entire Execution Overview';
  const selectedInput = selectedStep ? selectedStep.input : detail?.run.input;
  const selectedOutput = selectedStep ? selectedStep.output : detail?.run.output;

  const copyExecutionId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedRunId(true);
    setTimeout(() => setCopiedRunId(false), 2000);
  };

  return (
    <main className="execution-page">
      <div className="execution-content">
        
        {/* 1. TOP HEADER & WORKFLOW CONTEXT */}
        <div className="execution-heading">
          <div>
            <button className="execution-back" onClick={executionId ? onBackToHistory : onBack}>
              <ArrowLeft size={14} />
              <span>{executionId ? 'Back to All Executions' : 'Back to Automations'}</span>
            </button>
            <div className="flex items-center gap-3 mt-1">
              <h1>{executionId ? 'Execution Run Inspector' : 'Execution History'}</h1>
              {workflow && (
                <span className="workflow-context-tag">
                  <GitBranch size={12} />
                  {workflow.name}
                </span>
              )}
            </div>
            <p>
              {executionId
                ? 'Step-by-step telemetry, intermediate state, and payload inspection.'
                : 'Auditable log of every pipeline execution, trigger source, and runtime latency.'}
            </p>
          </div>

          <div className="execution-heading-actions">
            <button className="secondary-button" onClick={onOpenWorkflow}>
              <GitBranch size={14} /> Edit Workflow
            </button>
            <button
              className="secondary-button"
              title="Refresh executions"
              onClick={() => setRefreshKey(k => k + 1)}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="execution-error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button type="button" onClick={() => setRefreshKey(k => k + 1)}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="execution-loading">
            <Clock3 size={24} className="animate-spin text-indigo-500" />
            <span>Loading telemetry data…</span>
          </div>
        ) : executionId && detail ? (
          /* ====================================================================
             A. DETAILED EXECUTION RUN INSPECTOR (When executionId is selected)
             ==================================================================== */
          <>
            {/* Run KPI Summary Grid */}
            <div className="execution-summary">
              <div className="summary-status-cell">
                <span className={`history-status ${detail.run.status}`}>
                  <span className="status-dot" />
                  {detail.run.status.toUpperCase()}
                </span>
                <div className="summary-trigger-title">
                  {triggerInfo(detail.run.trigger).icon}
                  <strong>{triggerInfo(detail.run.trigger).label}</strong>
                </div>
                <button
                  type="button"
                  className="summary-run-id"
                  title="Copy Execution ID"
                  onClick={() => copyExecutionId(detail.run.id)}
                >
                  <code>{detail.run.id}</code>
                  {copiedRunId ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                </button>
              </div>

              <div>
                <span>Started Timestamp</span>
                <strong>{formatDate(detail.run.startedAt)}</strong>
              </div>

              <div>
                <span>Finished Timestamp</span>
                <strong>{detail.run.finishedAt ? formatDate(detail.run.finishedAt) : 'Still Running'}</strong>
              </div>

              <div>
                <span>Total Latency</span>
                <strong className="text-indigo-600 font-mono">
                  {formatDuration(detail.run.startedAt, detail.run.finishedAt)}
                </strong>
              </div>

              <div>
                <span>Steps Traversed</span>
                <strong>{detail.steps.length} {detail.steps.length === 1 ? 'node' : 'nodes'}</strong>
              </div>
            </div>

            {/* Error Banner (if execution failed) */}
            {detail.run.error && (
              <div className="execution-error-banner" role="alert">
                <div className="error-badge-icon">
                  <XCircle size={18} />
                </div>
                <div className="error-copy">
                  <strong>Execution Terminated with Error</strong>
                  <code>{detail.run.error}</code>
                </div>
              </div>
            )}

            {/* Dual Pane Layout: Left Step Pipeline + Right Step Inspector */}
            <div className="execution-detail-layout">
              
              {/* LEFT: STEP PATH PIPELINE */}
              <section className="execution-path" aria-label="Execution step path">
                <div className="execution-section-title">
                  <History size={16} />
                  <h2>Pipeline Step Path</h2>
                  <span className="step-count-badge">{detail.steps.length} nodes</span>
                </div>

                <div className="execution-path-list">
                  {/* Overview Root Step */}
                  <button
                    type="button"
                    className={`execution-path-step ${selectedStepId === null ? 'selected' : ''}`}
                    onClick={() => setSelectedStepId(null)}
                  >
                    <span className="execution-path-index root-step">
                      <GitBranch size={14} />
                    </span>
                    <span className="execution-path-copy">
                      <strong>Full Pipeline Overview</strong>
                      <small>Initial Trigger Input $\rightarrow$ Final Output</small>
                    </span>
                    <span className={`history-status ${detail.run.status}`}>
                      <span className="status-dot" />
                      {detail.run.status}
                    </span>
                  </button>

                  {/* Individual Node Steps */}
                  {detail.steps.map(step => (
                    <button
                      key={step.id}
                      type="button"
                      className={`execution-path-step ${selectedStepId === step.id ? 'selected' : ''} ${step.status === 'error' ? 'has-error' : ''}`}
                      onClick={() => setSelectedStepId(step.id)}
                    >
                      <span className="execution-path-index">
                        {step.sequence}
                      </span>
                      <span className="execution-path-copy">
                        <strong title={step.nodeName}>{step.nodeName}</strong>
                        <small className="font-mono">{step.nodeType} • {formatDuration(step.startedAt, step.finishedAt)}</small>
                      </span>
                      <span className={`history-status ${step.status}`}>
                        <span className="status-dot" />
                        {step.status}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              {/* RIGHT: SELECTED STEP DATA INSPECTOR */}
              <section className="execution-inspect" aria-label="Selected step details">
                <div className="execution-inspect-heading">
                  <div>
                    <span className="inspect-eyebrow">
                      {selectedStep
                        ? `STEP ${selectedStep.sequence} • NODE TYPE: ${selectedStep.nodeType.toUpperCase()}`
                        : 'RUN TELEMETRY DATA'}
                    </span>
                    <h2>{selectedName}</h2>
                  </div>
                  <span className={`history-status ${selected?.status || 'running'}`}>
                    <span className="status-dot" />
                    {selected?.status || 'running'}
                  </span>
                </div>

                {/* Micro-Timings Grid */}
                <div className="execution-times">
                  <div>
                    <span>Started</span>
                    <strong>{formatDate(selected?.startedAt)}</strong>
                  </div>
                  <div>
                    <span>Finished</span>
                    <strong>{selected?.finishedAt ? formatDate(selected.finishedAt) : 'In Progress'}</strong>
                  </div>
                  <div>
                    <span>Step Duration</span>
                    <strong className="font-mono text-indigo-600">
                      {selected?.startedAt ? formatDuration(selected.startedAt, selected.finishedAt) : '—'}
                    </strong>
                  </div>
                </div>

                {/* Step Error Notice */}
                {selectedStep?.error && (
                  <div className="step-error-notice">
                    <AlertCircle size={15} />
                    <span>{selectedStep.error}</span>
                  </div>
                )}

                {/* Input & Output Payloads Side-by-Side */}
                <div className="execution-payload-grid">
                  <PayloadPanel
                    title="Input Payload"
                    name={`input-${selectedStepId || detail.run.id}`}
                    value={selectedInput}
                  />
                  <PayloadPanel
                    title="Output Payload"
                    name={`output-${selectedStepId || detail.run.id}`}
                    value={selectedOutput}
                  />
                </div>

                {/* Step Parameters & Emitted Port Dispatches */}
                {selectedStep && (
                  <div className="execution-extra-grid">
                    <details className="inspect-details-box">
                      <summary>Configured Node Parameters</summary>
                      <div className="p-2">
                        <CodeEditor
                          name={`parameters-${selectedStep.id}`}
                          mode="json"
                          value={pretty(selectedStep.parameters)}
                          readOnly
                          height={160}
                        />
                      </div>
                    </details>
                    <details className="inspect-details-box">
                      <summary>Port Emitted Messages</summary>
                      <div className="p-2">
                        <CodeEditor
                          name={`outputs-${selectedStep.id}`}
                          mode="json"
                          value={pretty(selectedStep.outputs)}
                          readOnly
                          height={160}
                        />
                      </div>
                    </details>
                  </div>
                )}

              </section>

            </div>

            {/* Event Audit Trail */}
            {detail.events.length > 0 && (
              <section className="execution-events">
                <h2>Execution Event Audit Trail</h2>
                <div className="event-stream-list">
                  {detail.events.map(event => (
                    <div key={event.id} className="event-stream-row">
                      <time>{formatDate(event.time)}</time>
                      <span className={`event-level-badge ${event.level}`}>
                        {event.level.toUpperCase()}
                      </span>
                      <span className="event-msg">{event.message}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

          </>
        ) : (
          /* ====================================================================
             B. WORKFLOW EXECUTION RUNS LIST (When viewing history overview)
             ==================================================================== */
          <>
            {/* KPI Telemetry Strip */}
            <div className="execution-kpi-bar">
              <div className="kpi-card">
                <span className="kpi-label">Total Executions</span>
                <span className="kpi-value">{stats.total}</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Success Rate</span>
                <span className="kpi-value text-emerald-600">{stats.successRate}</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Average Latency</span>
                <span className="kpi-value text-indigo-600 font-mono">{stats.avgDuration}</span>
              </div>
              <div className="kpi-card">
                <span className="kpi-label">Failed Runs</span>
                <span className={`kpi-value ${stats.error > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                  {stats.error}
                </span>
              </div>
            </div>

            <section className="execution-runs-card" aria-label="Execution history table">
              
              {/* TOOLBAR */}
              <div className="execution-runs-toolbar">
                <div className="flex items-center gap-2">
                  <h2>All Executions</h2>
                  <span className="runs-count-badge">
                    {visibleRuns.length} of {runs.length} shown
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {/* Search Filter */}
                  <label className="plugins-search">
                    <Search size={14} />
                    <input
                      aria-label="Filter runs"
                      placeholder="Filter by ID or trigger…"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                    />
                    {query && (
                      <button type="button" className="plugins-clear-search" onClick={() => setQuery('')}>
                        <X size={12} />
                      </button>
                    )}
                  </label>

                  {/* Status Segmented Control */}
                  <div className="plugins-chip-group">
                    {([
                      ['all', 'All'],
                      ['success', 'Success'],
                      ['error', 'Errors'],
                      ['running', 'Running'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={status === val ? 'active' : ''}
                        onClick={() => setStatus(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* TABLE */}
              {visibleRuns.length ? (
                <div className="execution-table-scroll">
                  <table className="execution-table">
                    <thead>
                      <tr>
                        <th>Started & Timing</th>
                        <th>Status</th>
                        <th>Trigger Source</th>
                        <th>Duration</th>
                        <th>Steps</th>
                        <th>Errors</th>
                        <th>Execution ID</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRuns.map(run => {
                        const trg = triggerInfo(run.trigger);
                        return (
                          <tr
                            key={run.id}
                            tabIndex={0}
                            aria-label={`Open execution ${run.id}`}
                            onClick={() => onOpenRun(run.id)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') onOpenRun(run.id);
                            }}
                          >
                            <td>
                              <div className="execution-time-cell">
                                <strong>{formatDate(run.startedAt)}</strong>
                                <small>
                                  {run.finishedAt ? `Finished ${formatDate(run.finishedAt)}` : 'Still active'}
                                </small>
                              </div>
                            </td>
                            <td>
                              <span className={`history-status ${run.status}`}>
                                <span className="status-dot" />
                                {run.status}
                              </span>
                            </td>
                            <td>
                              <div className="execution-trigger-cell">
                                <span className="trigger-icon-wrap" style={{ color: trg.color }}>
                                  {trg.icon}
                                </span>
                                <span>{trg.label}</span>
                              </div>
                            </td>
                            <td>
                              <span className="font-mono text-slate-700 font-semibold text-xs">
                                {formatDuration(run.startedAt, run.finishedAt)}
                              </span>
                            </td>
                            <td>
                              <span className="step-pill">{run.nodeCount}</span>
                            </td>
                            <td>
                              {run.errorCount ? (
                                <span className="error-count-pill">{run.errorCount}</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                            <td>
                              <code className="execution-id-chip">{run.id.slice(0, 8)}</code>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="execution-open-btn"
                                onClick={e => {
                                  e.stopPropagation();
                                  onOpenRun(run.id);
                                }}
                              >
                                <span>Inspect</span>
                                <ArrowRight size={13} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="execution-empty">
                  <div className="plugins-empty-icon">
                    <History size={28} />
                  </div>
                  <strong>{runs.length ? 'No matching executions' : 'No executions recorded yet'}</strong>
                  <span>
                    {runs.length
                      ? 'Adjust your status filter or search query.'
                      : 'Trigger this workflow or run an Inject node to record telemetry.'}
                  </span>
                </div>
              )}

              {hasMore && (
                <div className="execution-more">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={loadingMore}
                    onClick={() => void more()}
                  >
                    {loadingMore ? 'Loading older runs…' : 'Load more executions'}
                  </button>
                </div>
              )}

            </section>
          </>
        )}

      </div>
    </main>
  );
}
