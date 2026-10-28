import { useMemo, useState } from 'react';
import { Box, Cable, Code2, Layers3, PackagePlus, Plus, Search } from 'lucide-react';
import type { NodeDefinition } from '../shared';

type PluginPackage = { name: string; version: string; types: string[]; builtIn: boolean };
type Filter = 'all' | 'installed' | 'builtin' | 'available';
type Kind = 'all' | 'plugin' | 'node';
type Row = { id: string; name: string; description: string; kind: 'plugin' | 'node'; source: string; version: string; nodes: string; status: 'Installed' | 'Built-in' | 'Available'; filter: Exclude<Filter, 'all'> };

export function PluginsPage({ definitions, packages, refresh, notify, openCustom, connectorsOnly = false, onBrowsePlugins }: {
  definitions: NodeDefinition[];
  packages: PluginPackage[];
  refresh: () => Promise<unknown>;
  notify: (message: string, error?: boolean) => void;
  openCustom: () => void;
  connectorsOnly?: boolean;
  onBrowsePlugins?: () => void;
}) {
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [error, setError] = useState('');

  const rows = useMemo<Row[]>(() => {
    const pluginRows: Row[] = packages.map(item => ({
      id: `plugin:${item.name}`, name: item.name, description: item.types.join(', '), kind: 'plugin', source: item.builtIn ? 'Bundled' : 'npm', version: item.version,
      nodes: String(item.types.length), status: item.builtIn ? 'Built-in' : 'Installed', filter: item.builtIn ? 'builtin' : 'installed',
    }));
    const connectorTypes = new Set(['http-in', 'http-response', 'email-in', 'email-out', 'websocket-in', 'websocket-out', 'websocket-client', 'ssh', 'file-read', 'file-write', 'openai', 'redis', 'redis-subscriber']);
    const nodeRows: Row[] = definitions.filter(item => !connectorsOnly || connectorTypes.has(item.type) || item.category === 'Network').map(item => {
      const sourcePackage = packages.find(pkg => pkg.name === item.source);
      const isCore = !item.source;
      const isCustom = item.source === 'custom';
      return {
        id: `node:${item.type}`, name: item.label, description: item.description, kind: 'node',
        source: isCore ? 'Core' : isCustom ? 'Workspace' : item.source || 'Unknown',
        version: sourcePackage?.version || '—', nodes: item.type,
        status: isCore ? 'Built-in' : 'Available', filter: isCore ? 'builtin' : isCustom ? 'installed' : 'available',
      };
    });
    return connectorsOnly ? nodeRows : [...pluginRows, ...nodeRows];
  }, [packages, definitions, connectorsOnly]);

  const visible = useMemo(() => rows.filter(row => {
    if (filter !== 'all' && row.filter !== filter) return false;
    if (kind !== 'all' && row.kind !== kind) return false;
    return `${row.name} ${row.description} ${row.source} ${row.nodes}`.toLowerCase().includes(query.trim().toLowerCase());
  }), [rows, query, filter, kind]);
  const install = async () => {
    if (!spec.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/plugins/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: spec.trim() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not install plugin');
      await refresh();
      setSpec('');
      notify('Plugin installed');
    } catch (cause) {
      setError((cause as Error).message);
      notify((cause as Error).message, true);
    } finally { setBusy(false); }
  };

  return <main className="plugins-page">
    <div className="plugins-content">
      <div className="plugins-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{connectorsOnly ? 'Connectors' : 'Plugins & nodes'}</h1><p>{connectorsOnly ? 'Browse the nodes that connect workflows to external services and files.' : 'Browse the node library and manage installed packages.'}</p></div><button className="secondary-button" onClick={connectorsOnly ? onBrowsePlugins : openCustom}>{connectorsOnly ? <><Layers3 size={15}/> Browse plugins</> : <><Plus size={15}/> Create custom node</>}</button></div>
      {!connectorsOnly && <div className="plugins-install"><div className="plugins-install-icon"><PackagePlus size={20}/></div><div className="plugins-install-copy"><strong>Install a plugin</strong><span>Enter a Wflow compatible npm package name to add its nodes.</span></div><form onSubmit={event => { event.preventDefault(); void install(); }}><input aria-label="npm package name" placeholder="npm package name" value={spec} onChange={event => setSpec(event.target.value)}/><button className="activate-button" disabled={busy || !spec.trim()}>{busy ? 'Installing…' : 'Install'}</button></form></div>}
      {error && <div className="plugins-error" role="alert">{error}</div>}
      <section className="plugins-card" aria-label="Plugins and nodes">
        <div className="plugins-toolbar"><div><h2>{connectorsOnly ? 'Connectors' : 'Library'}</h2><span>{visible.length} of {rows.length}</span></div><label className="plugins-search"><Search size={15}/><input aria-label={connectorsOnly ? 'Search connectors' : 'Search plugins and nodes'} placeholder={connectorsOnly ? 'Search connectors' : 'Search plugins and nodes'} value={query} onChange={event => setQuery(event.target.value)}/></label></div>
        <div className="plugins-filter-bar"><div aria-label="Status filters" className="plugins-chip-group">{([['all', 'All'], ['installed', 'Installed'], ['builtin', 'Built-in'], ['available', 'Available']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>{!connectorsOnly && <div aria-label="Item filters" className="plugins-chip-group">{([['all', 'Everything'], ['plugin', 'Plugins'], ['node', 'Nodes']] as const).map(([value, label]) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>)}</div>}</div>
        {visible.length ? <div className="plugins-table-scroll"><table className="plugins-table"><thead><tr><th>Name</th><th>Type</th><th>Source</th><th>Version</th><th>Nodes / type</th><th>Status</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td><div className="plugins-row-name"><span className={row.kind === 'plugin' ? 'package' : 'node'}>{row.kind === 'plugin' ? <Box size={16}/> : connectorsOnly ? <Cable size={16}/> : <Code2 size={16}/>}</span><span><strong>{row.name}</strong><small title={row.description}>{row.description}</small></span></div></td><td>{row.kind === 'plugin' ? 'Plugin' : 'Node'}</td><td>{row.source}</td><td>{row.version}</td><td>{row.nodes}</td><td><span className={`plugins-status ${row.status.toLowerCase().replace('-', '')}`}>{row.status}</span></td></tr>)}</tbody></table></div> : <div className="plugins-empty"><Layers3 size={25}/><strong>No matching items</strong><span>Try another search or filter.</span></div>}
      </section>
    </div>
  </main>;
}
