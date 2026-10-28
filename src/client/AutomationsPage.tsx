import { useEffect, useMemo, useState } from 'react';
import { Activity, Clock3, GitBranch, History, Plus, Search } from 'lucide-react';
import type { AutomationSummary } from '../shared';

function elapsed(ms?: number) {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function dateTime(value?: string) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function AutomationsPage({ onOpen, onHistory, onCreate }: { onOpen: (id: string) => void; onHistory: (id: string) => void; onCreate: () => void }) {
  const [rows, setRows] = useState<AutomationSummary[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'draft'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const response = await fetch('/api/automations');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load automations');
        if (mounted) { setRows(data); setError(''); }
      } catch (cause) {
        if (mounted) setError((cause as Error).message);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const visible = useMemo(() => rows.filter(row => {
    if (status === 'active' && !row.active) return false;
    if (status === 'draft' && row.active) return false;
    const haystack = `${row.name} ${row.description} ${row.tags.join(' ')}`.toLocaleLowerCase();
    return haystack.includes(query.trim().toLocaleLowerCase());
  }), [rows, query, status]);
  const activeCount = rows.filter(row => row.active).length;
  const runCount = rows.reduce((count, row) => count + row.executionCount, 0);

  return <main className="automations-page">
    <div className="automations-content">
      <div className="automations-heading"><div><span className="eyebrow">WORKSPACE</span><h1>Automations</h1><p>Manage workflows and review their recent activity.</p></div><button className="activate-button" onClick={onCreate}><Plus size={16}/> New workflow</button></div>
      <div className="automations-overview" aria-label="Automation overview">
        <div><GitBranch size={18}/><span><strong>{rows.length}</strong><small>Workflows</small></span></div>
        <div><Activity size={18}/><span><strong>{activeCount}</strong><small>Active</small></span></div>
        <div><Clock3 size={18}/><span><strong>{runCount}</strong><small>Executions</small></span></div>
      </div>
      <section className="automations-card" aria-label="Workflows">
        <div className="automations-toolbar"><div><h2>All workflows</h2><span>{visible.length} of {rows.length}</span></div><div className="automations-controls"><label className="automations-search"><Search size={15}/><input aria-label="Search workflows" placeholder="Search workflows or tags" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">All statuses</option><option value="active">Active</option><option value="draft">Draft</option></select></div></div>
        {error && <div className="automations-error" role="alert">{error} <button onClick={() => window.location.reload()}>Retry</button></div>}
        {loading ? <div className="automations-empty">Loading workflows…</div> : visible.length ? <div className="automations-table-scroll"><table className="automations-table"><thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Last execution</th><th>Avg. time</th><th>Runs</th><th>Tags</th><th>View history</th></tr></thead><tbody>{visible.map(row => <tr key={row.id} className="automation-row" onClick={() => onOpen(row.id)}>
          <td><button className="automation-name" onClick={event => { event.stopPropagation(); onOpen(row.id); }}><span className="automation-icon"><GitBranch size={15}/></span><span><strong>{row.name}</strong><small>{row.nodeCount} {row.nodeCount === 1 ? 'node' : 'nodes'} · Updated {dateTime(row.updatedAt)}</small></span></button></td>
          <td><span className="automation-description" title={row.description}>{row.description || '—'}</span></td>
          <td><span className={`automation-status ${row.active ? 'active' : ''}`}>{row.active ? 'Active' : 'Draft'}</span>{row.needsDeploy && <small className="automation-pending">Changes pending</small>}</td>
          <td><span className="automation-last"><strong>{dateTime(row.lastExecutionAt)}</strong>{row.lastExecutionStatus && <small className={row.lastExecutionStatus}>{row.lastExecutionStatus}</small>}</span></td>
          <td>{elapsed(row.avgExecutionMs)}</td><td>{row.executionCount}</td>
          <td><div className="automation-tags">{row.tags.length ? row.tags.map(tag => <span key={tag}>{tag}</span>) : <span className="automation-no-tags">—</span>}</div></td>
          <td><button className="automation-history-link" aria-label={`View history for ${row.name}`} onClick={event => { event.stopPropagation(); onHistory(row.id); }}><History size={14}/> View history</button></td>
        </tr>)}</tbody></table></div> : <div className="automations-empty"><GitBranch size={24}/><strong>{rows.length ? 'No matching workflows' : 'No workflows yet'}</strong><span>{rows.length ? 'Try a different search or status.' : 'Create a workflow to get started.'}</span>{!rows.length && <button className="activate-button" onClick={onCreate}><Plus size={15}/> New workflow</button>}</div>}
      </section>
    </div>
  </main>;
}
