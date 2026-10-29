import React, { useMemo, useState } from 'react';
import {
  Box, Cable, Check, Code2, Download, ExternalLink, Globe2,
  Layers3, LayoutGrid, List, PackagePlus, Plus, Search,
  Sliders, Sparkles, Terminal, X, Zap
} from 'lucide-react';
import type { NodeDefinition } from '../shared';

type PluginPackage = { name: string; version: string; types: string[]; builtIn: boolean };
type Filter = 'all' | 'installed' | 'builtin' | 'available';
type Kind = 'all' | 'plugin' | 'node';
type Row = {
  id: string;
  name: string;
  description: string;
  kind: 'plugin' | 'node';
  source: string;
  version: string;
  nodes: string;
  status: 'Installed' | 'Built-in' | 'Available';
  filter: Exclude<Filter, 'all'>;
  category: string;
  inputs?: number;
  outputs?: number;
};

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
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [error, setError] = useState('');

  const rows = useMemo<Row[]>(() => {
    const pluginRows: Row[] = packages.map(item => ({
      id: `plugin:${item.name}`,
      name: item.name,
      description: item.types.join(', '),
      kind: 'plugin',
      source: item.builtIn ? 'Bundled' : 'npm',
      version: item.version,
      nodes: String(item.types.length),
      status: item.builtIn ? 'Built-in' : 'Installed',
      filter: item.builtIn ? 'builtin' : 'installed',
      category: 'Package',
    }));

    const connectorTypes = new Set([
      'http-in', 'http-response', 'email-in', 'email-out',
      'websocket-in', 'websocket-out', 'websocket-client',
      'ssh', 'file-read', 'file-write', 'openai', 'redis', 'redis-subscriber'
    ]);

    const nodeRows: Row[] = definitions
      .filter(item => !connectorsOnly || connectorTypes.has(item.type) || item.category === 'Network')
      .map(item => {
        const sourcePackage = packages.find(pkg => pkg.name === item.source);
        const isCore = !item.source;
        const isCustom = item.source === 'custom';
        return {
          id: `node:${item.type}`,
          name: item.label,
          description: item.description,
          kind: 'node',
          source: isCore ? 'Core' : isCustom ? 'Workspace' : item.source || 'Unknown',
          version: sourcePackage?.version || '—',
          nodes: item.type,
          status: isCore ? 'Built-in' : 'Available',
          filter: isCore ? 'builtin' : isCustom ? 'installed' : 'available',
          category: item.category || 'General',
          inputs: item.inputs,
          outputs: item.outputs,
        };
      });

    return connectorsOnly ? nodeRows : [...pluginRows, ...nodeRows];
  }, [packages, definitions, connectorsOnly]);

  const stats = useMemo(() => {
    return {
      total: rows.length,
      installed: rows.filter(r => r.filter === 'installed').length,
      builtin: rows.filter(r => r.filter === 'builtin').length,
      available: rows.filter(r => r.filter === 'available').length,
      packages: packages.length,
    };
  }, [rows, packages]);

  const visible = useMemo(() => rows.filter(row => {
    if (filter !== 'all' && row.filter !== filter) return false;
    if (kind !== 'all' && row.kind !== kind) return false;
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return `${row.name} ${row.description} ${row.source} ${row.nodes} ${row.category}`.toLowerCase().includes(term);
  }), [rows, query, filter, kind]);

  const install = async () => {
    if (!spec.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec.trim() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not install plugin');
      await refresh();
      setSpec('');
      notify('Plugin installed successfully');
    } catch (cause) {
      setError((cause as Error).message);
      notify((cause as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const getCategoryBadgeClass = (category: string, kind: string) => {
    if (kind === 'plugin') return 'badge-plugin';
    const c = category.toLowerCase();
    if (c.includes('input') || c.includes('event')) return 'badge-event';
    if (c.includes('logic') || c.includes('condition')) return 'badge-condition';
    if (c.includes('network') || c.includes('connector')) return 'badge-network';
    if (c.includes('custom')) return 'badge-custom';
    return 'badge-general';
  };

  const getIconForCategory = (category: string, kind: string) => {
    if (kind === 'plugin') return <Box size={18} />;
    const c = category.toLowerCase();
    if (c.includes('input') || c.includes('event')) return <Zap size={18} />;
    if (c.includes('logic') || c.includes('condition')) return <Sliders size={18} />;
    if (c.includes('network') || c.includes('connector')) return <Globe2 size={18} />;
    if (c.includes('custom')) return <Code2 size={18} />;
    return <Cable size={18} />;
  };

  return (
    <main className="plugins-page">
      <div className="plugins-content">
        
        {/* 1. HERO HEADER */}
        <div className="plugins-hero-header">
          <div className="plugins-hero-copy">
            <span className="eyebrow">REGISTRY & EXTENSIONS</span>
            <h1>{connectorsOnly ? 'Connectors' : 'Plugins & Nodes'}</h1>
            <p>
              {connectorsOnly
                ? 'Integrate your workflows with databases, external APIs, and cloud services.'
                : 'Browse core automation nodes, install npm plugins, and manage custom logic.'}
            </p>
          </div>

          <div className="plugins-header-actions">
            {connectorsOnly ? (
              <button className="secondary-button" onClick={onBrowsePlugins}>
                <Layers3 size={15} /> Browse Plugins
              </button>
            ) : (
              <button className="activate-button" onClick={openCustom}>
                <Plus size={15} /> Create Custom Node
              </button>
            )}
          </div>
        </div>

        {/* 2. STATS PILLS BAR */}
        <div className="plugins-stats-bar">
          <div className="stat-pill">
            <span className="stat-label">Total Items</span>
            <span className="stat-value">{stats.total}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Built-in Core</span>
            <span className="stat-value text-emerald-600">{stats.builtin}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Installed Packages</span>
            <span className="stat-value text-indigo-600">{stats.installed}</span>
          </div>
          {!connectorsOnly && (
            <div className="stat-pill">
              <span className="stat-label">Available Nodes</span>
              <span className="stat-value text-amber-600">{stats.available}</span>
            </div>
          )}
        </div>

        {/* 3. NPM INSTALL CARD */}
        {!connectorsOnly && (
          <div className="plugins-install-card">
            <div className="plugins-install-badge">
              <Terminal size={18} />
            </div>
            <div className="plugins-install-details">
              <strong>Install npm Extension</strong>
              <span>Enter a compatible npm package name to dynamically register its node definitions.</span>
            </div>
            <form className="plugins-install-form" onSubmit={event => { event.preventDefault(); void install(); }}>
              <div className="plugins-input-wrapper">
                <span className="plugins-input-prefix">npm i</span>
                <input
                  aria-label="npm package name"
                  placeholder="e.g. wflow-plugin-s3, @wflow/plugin-ai"
                  value={spec}
                  onChange={event => setSpec(event.target.value)}
                />
              </div>
              <button type="submit" className="activate-button" disabled={busy || !spec.trim()}>
                {busy ? 'Installing…' : <><Download size={14} /> Install</>}
              </button>
            </form>
          </div>
        )}

        {error && <div className="plugins-error" role="alert">{error}</div>}

        {/* 4. MAIN REGISTRY CARD */}
        <section className="plugins-card" aria-label="Plugins and nodes catalog">
          
          {/* TOOLBAR */}
          <div className="plugins-toolbar">
            <div className="plugins-toolbar-left">
              <h2>{connectorsOnly ? 'Connectors' : 'Catalog'}</h2>
              <span className="plugins-count-badge">
                {visible.length} of {rows.length} {visible.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            <div className="plugins-toolbar-right">
              {/* Search Bar */}
              <label className="plugins-search">
                <Search size={14} />
                <input
                  aria-label={connectorsOnly ? 'Search connectors' : 'Search plugins and nodes'}
                  placeholder={connectorsOnly ? 'Filter connectors…' : 'Filter nodes & packages…'}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
                {query && (
                  <button type="button" className="plugins-clear-search" onClick={() => setQuery('')}>
                    <X size={12} />
                  </button>
                )}
              </label>

              {/* View Mode Switcher */}
              <div className="plugins-view-switcher" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={viewMode === 'grid' ? 'active' : ''}
                  title="Grid view"
                  onClick={() => setViewMode('grid')}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  type="button"
                  className={viewMode === 'table' ? 'active' : ''}
                  title="Table view"
                  onClick={() => setViewMode('table')}
                >
                  <List size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* FILTER SEGMENTS */}
          <div className="plugins-filter-bar">
            {/* Status Segment */}
            <div className="plugins-chip-group" aria-label="Filter by status">
              {([
                ['all', `All (${rows.length})`],
                ['installed', `Installed (${stats.installed})`],
                ['builtin', `Built-in (${stats.builtin})`],
                ['available', `Available (${stats.available})`]
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? 'active' : ''}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Type Segment */}
            {!connectorsOnly && (
              <div className="plugins-chip-group" aria-label="Filter by type">
                {([['all', 'All Types'], ['plugin', 'Packages'], ['node', 'Nodes']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={kind === value ? 'active' : ''}
                    onClick={() => setKind(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 5. CONTENT (GRID OR TABLE) */}
          {visible.length ? (
            viewMode === 'grid' ? (
              /* GRID CARDS VIEW */
              <div className="plugins-grid-view">
                {visible.map(row => (
                  <div key={row.id} className="plugins-node-card">
                    <div className="plugins-card-top">
                      <div className={`plugins-card-icon ${getCategoryBadgeClass(row.category, row.kind)}`}>
                        {getIconForCategory(row.category, row.kind)}
                      </div>
                      <span className={`plugins-status ${row.status.toLowerCase().replace('-', '')}`}>
                        <span className="status-dot" />
                        {row.status}
                      </span>
                    </div>

                    <div className="plugins-card-body">
                      <div className="plugins-card-title-row">
                        <strong className="plugins-card-name" title={row.name}>{row.name}</strong>
                        <span className="plugins-category-pill">{row.category}</span>
                      </div>
                      <code className="plugins-card-type">{row.nodes}</code>
                      <p className="plugins-card-desc" title={row.description}>
                        {row.description || 'No description provided.'}
                      </p>
                    </div>

                    <div className="plugins-card-footer">
                      <span className="plugins-source-chip">
                        {row.source}
                      </span>
                      {row.version !== '—' && (
                        <span className="plugins-version-chip">
                          v{row.version}
                        </span>
                      )}
                      {row.kind === 'node' && (
                        <span className="plugins-io-chip">
                          {row.inputs ?? 1} in • {row.outputs ?? 1} out
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* TABLE VIEW */
              <div className="plugins-table-scroll">
                <table className="plugins-table">
                  <thead>
                    <tr>
                      <th>Name & Details</th>
                      <th>Type</th>
                      <th>Category</th>
                      <th>Source</th>
                      <th>Version</th>
                      <th>Node Identifier</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(row => (
                      <tr key={row.id}>
                        <td>
                          <div className="plugins-row-name">
                            <span className={`plugins-row-icon ${getCategoryBadgeClass(row.category, row.kind)}`}>
                              {getIconForCategory(row.category, row.kind)}
                            </span>
                            <div className="plugins-row-text">
                              <strong>{row.name}</strong>
                              <small title={row.description}>{row.description}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="plugins-kind-tag">{row.kind === 'plugin' ? 'Package' : 'Node'}</span>
                        </td>
                        <td>
                          <span className="plugins-category-text">{row.category}</span>
                        </td>
                        <td>
                          <span className="plugins-source-text">{row.source}</span>
                        </td>
                        <td>
                          <span className="plugins-version-text">{row.version}</span>
                        </td>
                        <td>
                          <code className="plugins-code-text">{row.nodes}</code>
                        </td>
                        <td>
                          <span className={`plugins-status ${row.status.toLowerCase().replace('-', '')}`}>
                            <span className="status-dot" />
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="plugins-empty">
              <div className="plugins-empty-icon">
                <Layers3 size={32} />
              </div>
              <strong>No matching plugins or nodes</strong>
              <span>No items matched your current search or status filter.</span>
              {(query || filter !== 'all' || kind !== 'all') && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => { setQuery(''); setFilter('all'); setKind('all'); }}
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}

        </section>

      </div>
    </main>
  );
}
