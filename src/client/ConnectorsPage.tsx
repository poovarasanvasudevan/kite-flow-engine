import React, { useMemo, useState } from 'react';
import {
  ArrowUpRight, Box, Cable, Check, Copy, Database, ExternalLink,
  FileText, Globe2, Info, KeyRound, Layers3, Lock, Mail, MailPlus,
  Play, Radio, Search, Send, ShieldCheck, Sparkles, Terminal, X, Zap
} from 'lucide-react';
import type { NodeDefinition } from '../shared';

type ConnectorGroup = 'all' | 'ai' | 'api' | 'data' | 'messaging' | 'system';

type ConnectorMeta = {
  type: string;
  name: string;
  group: ConnectorGroup;
  groupLabel: string;
  description: string;
  icon: React.ReactNode;
  iconBg: string;
  ioType: 'Trigger (Input)' | 'Action (Output)' | 'Bidirectional';
  securityNote?: string;
  fieldsCount: number;
  definition?: NodeDefinition;
};

export function ConnectorsPage({
  definitions,
  onBrowsePlugins,
  notify,
}: {
  definitions: NodeDefinition[];
  onBrowsePlugins: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<ConnectorGroup>('all');
  const [selectedConnector, setSelectedConnector] = useState<ConnectorMeta | null>(null);
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const defMap = useMemo(() => {
    const map = new Map<string, NodeDefinition>();
    for (const d of definitions) map.set(d.type, d);
    return map;
  }, [definitions]);

  const connectors = useMemo<ConnectorMeta[]>(() => {
    const list: Omit<ConnectorMeta, 'definition'>[] = [
      {
        type: 'openai',
        name: 'OpenAI GPT Intelligence',
        group: 'ai',
        groupLabel: 'AI & Machine Learning',
        description: 'Run natural language completions, embeddings, and structured JSON parsing via OpenAI models.',
        icon: <Sparkles size={20} />,
        iconBg: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Uses Vault secret for OPENAI_API_KEY',
        fieldsCount: 4,
      },
      {
        type: 'redis',
        name: 'Redis Cache & Store',
        group: 'data',
        groupLabel: 'Databases & Caches',
        description: 'Execute GET, SET, DEL, and cache commands against Redis instances with sub-millisecond latency.',
        icon: <Database size={20} />,
        iconBg: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Supports Redis AUTH & TLS',
        fieldsCount: 3,
      },
      {
        type: 'redis-subscriber',
        name: 'Redis Pub/Sub Listener',
        group: 'data',
        groupLabel: 'Databases & Caches',
        description: 'Listen to real-time message channels and trigger workflow events when messages arrive.',
        icon: <Radio size={20} />,
        iconBg: 'linear-gradient(135deg, #f97316 0%, #c2410c 100%)',
        ioType: 'Trigger (Input)',
        securityNote: 'Subscribes on background thread',
        fieldsCount: 3,
      },
      {
        type: 'http-in',
        name: 'Webhook Endpoint (HTTP In)',
        group: 'api',
        groupLabel: 'Webhooks & APIs',
        description: 'Expose a live HTTP URL to ingest webhooks from GitHub, Stripe, Shopify, or internal microservices.',
        icon: <Globe2 size={20} />,
        iconBg: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
        ioType: 'Trigger (Input)',
        securityNote: 'Routes automatically to /hook/{path}',
        fieldsCount: 2,
      },
      {
        type: 'http-request',
        name: 'HTTP Client Request',
        group: 'api',
        groupLabel: 'Webhooks & APIs',
        description: 'Send outbound HTTP REST / GraphQL requests with customizable verbs, headers, and dynamic payloads.',
        icon: <ArrowUpRight size={20} />,
        iconBg: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
        ioType: 'Bidirectional',
        securityNote: 'Dynamic auth tokens from Vault',
        fieldsCount: 2,
      },
      {
        type: 'http-response',
        name: 'HTTP Response Dispatcher',
        group: 'api',
        groupLabel: 'Webhooks & APIs',
        description: 'Send custom HTTP status codes and responses back to the original caller of an HTTP In webhook.',
        icon: <Send size={20} />,
        iconBg: 'linear-gradient(135deg, #38bdf8 0%, #2563eb 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Pairs with active HTTP In request',
        fieldsCount: 1,
      },
      {
        type: 'email-in',
        name: 'IMAP Email Ingest',
        group: 'messaging',
        groupLabel: 'Email & Messaging',
        description: 'Poll IMAP inboxes (Gmail, Outlook, self-hosted) and trigger automations on new unread emails.',
        icon: <Mail size={20} />,
        iconBg: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
        ioType: 'Trigger (Input)',
        securityNote: 'Uses Vault credentials: IMAP_PASSWORD',
        fieldsCount: 8,
      },
      {
        type: 'email-out',
        name: 'SMTP Email Dispatcher',
        group: 'messaging',
        groupLabel: 'Email & Messaging',
        description: 'Deliver templated transaction emails or alerts through SMTP with TLS/STARTTLS support.',
        icon: <MailPlus size={20} />,
        iconBg: 'linear-gradient(135deg, #ec4899 0%, #be185d 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Uses Vault credentials: SMTP_PASSWORD',
        fieldsCount: 9,
      },
      {
        type: 'websocket-in',
        name: 'WebSocket Server Receiver',
        group: 'messaging',
        groupLabel: 'Email & Messaging',
        description: 'Accept real-time duplex socket connections and ingest streaming event frames.',
        icon: <Radio size={20} />,
        iconBg: 'linear-gradient(135deg, #14b8a6 0%, #0f766e 100%)',
        ioType: 'Trigger (Input)',
        securityNote: 'Native WebSocket WS/WSS protocol',
        fieldsCount: 2,
      },
      {
        type: 'websocket-client',
        name: 'WebSocket Client Stream',
        group: 'messaging',
        groupLabel: 'Email & Messaging',
        description: 'Connect to remote WebSocket endpoints (crypto feeds, chat servers) as a persistent client.',
        icon: <Cable size={20} />,
        iconBg: 'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)',
        ioType: 'Bidirectional',
        securityNote: 'Automatic reconnection support',
        fieldsCount: 2,
      },
      {
        type: 'ssh',
        name: 'SSH Command Executor',
        group: 'system',
        groupLabel: 'Infrastructure & Protocols',
        description: 'Execute remote shell commands or deploy scripts securely on Linux/Unix servers over SSH.',
        icon: <Terminal size={20} />,
        iconBg: 'linear-gradient(135deg, #334155 0%, #0f172a 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Private key & password from Vault',
        fieldsCount: 6,
      },
      {
        type: 'file-read',
        name: 'File System Reader & CSV',
        group: 'system',
        groupLabel: 'Infrastructure & Protocols',
        description: 'Read local files, parse structured CSV data, and stream records directly into the workflow canvas.',
        icon: <FileText size={20} />,
        iconBg: 'linear-gradient(135deg, #eab308 0%, #a16207 100%)',
        ioType: 'Action (Output)',
        securityNote: 'Restricted to configured workspace path',
        fieldsCount: 3,
      },
    ];

    return list.map(item => ({
      ...item,
      definition: defMap.get(item.type),
      fieldsCount: defMap.get(item.type)?.fields.length ?? item.fieldsCount,
    }));
  }, [defMap]);

  const filteredConnectors = useMemo(() => {
    return connectors.filter(c => {
      if (activeGroup !== 'all' && c.group !== activeGroup) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.type.toLowerCase().includes(q) ||
        c.groupLabel.toLowerCase().includes(q)
      );
    });
  }, [connectors, activeGroup, query]);

  const copyType = (type: string) => {
    navigator.clipboard.writeText(type);
    setCopiedType(type);
    notify(`Copied node type "${type}" to clipboard`);
    setTimeout(() => setCopiedType(null), 1800);
  };

  return (
    <main className="connectors-page">
      <div className="connectors-content">
        
        {/* 1. HERO HEADER */}
        <div className="connectors-hero-header">
          <div className="connectors-hero-copy">
            <span className="eyebrow">INTEGRATIONS & PROTOCOLS</span>
            <h1>Connectors Hub</h1>
            <p>
              Pre-built network, database, messaging, and protocol gateways ready to plug directly into workflows.
            </p>
          </div>
          <div className="connectors-header-actions">
            <button className="secondary-button" onClick={onBrowsePlugins}>
              <Layers3 size={15} /> All NPM Plugins
            </button>
          </div>
        </div>

        {/* 2. SECURITY & STATUS TELEMETRY BAR */}
        <div className="connectors-stats-bar">
          <div className="stat-pill">
            <span className="stat-label">Active Protocols</span>
            <span className="stat-value">{connectors.length}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Network Transport</span>
            <span className="stat-value text-sky-600">HTTP, WS, IMAP, SMTP, SSH</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Security Model</span>
            <span className="stat-value text-emerald-600 flex items-center gap-1.5">
              <ShieldCheck size={14} /> Vault Encrypted Auth
            </span>
          </div>
        </div>

        {/* 3. CATALOG CONTAINER */}
        <section className="connectors-card" aria-label="Connector directory">
          
          {/* TOOLBAR */}
          <div className="connectors-toolbar">
            <div className="connectors-toolbar-left">
              <h2>Connector Directory</h2>
              <span className="connectors-count-badge">
                {filteredConnectors.length} of {connectors.length} available
              </span>
            </div>

            <div className="connectors-toolbar-right">
              {/* Search Bar */}
              <label className="plugins-search">
                <Search size={14} />
                <input
                  aria-label="Search connectors"
                  placeholder="Filter by protocol, keyword, or service…"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
                {query && (
                  <button type="button" className="plugins-clear-search" onClick={() => setQuery('')}>
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>
          </div>

          {/* CATEGORY FILTER TABS */}
          <div className="connectors-category-bar">
            {([
              ['all', 'All Protocols'],
              ['ai', 'AI & Intelligence'],
              ['api', 'Webhooks & APIs'],
              ['data', 'Databases & Caches'],
              ['messaging', 'Email & Sockets'],
              ['system', 'System & Files'],
            ] as const).map(([groupKey, groupTitle]) => (
              <button
                key={groupKey}
                type="button"
                className={`connector-tab-btn ${activeGroup === groupKey ? 'active' : ''}`}
                onClick={() => setActiveGroup(groupKey)}
              >
                {groupTitle}
              </button>
            ))}
          </div>

          {/* CONNECTOR CARDS GRID */}
          {filteredConnectors.length ? (
            <div className="connectors-grid">
              {filteredConnectors.map(c => (
                <div
                  key={c.type}
                  className="connector-card"
                  onClick={() => setSelectedConnector(c)}
                >
                  <div className="connector-card-top">
                    <div className="connector-icon-badge" style={{ background: c.iconBg }}>
                      {c.icon}
                    </div>
                    <span className={`connector-io-badge ${c.ioType.toLowerCase().replace(/[^a-z]/g, '')}`}>
                      {c.ioType}
                    </span>
                  </div>

                  <div className="connector-card-body">
                    <div className="connector-title-row">
                      <strong className="connector-name">{c.name}</strong>
                      <span className="connector-group-pill">{c.groupLabel}</span>
                    </div>

                    <div className="connector-type-row">
                      <code className="connector-type-code">type: {c.type}</code>
                      <button
                        type="button"
                        className="connector-copy-btn"
                        title="Copy node type ID"
                        onClick={e => {
                          e.stopPropagation();
                          copyType(c.type);
                        }}
                      >
                        {copiedType === c.type ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                      </button>
                    </div>

                    <p className="connector-description">{c.description}</p>
                  </div>

                  <div className="connector-card-footer">
                    {c.securityNote && (
                      <div className="connector-security-pill" title={c.securityNote}>
                        <Lock size={11} className="text-emerald-500" />
                        <span>{c.securityNote}</span>
                      </div>
                    )}
                    <span className="connector-config-count">
                      {c.fieldsCount} {c.fieldsCount === 1 ? 'parameter' : 'parameters'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="plugins-empty">
              <div className="plugins-empty-icon">
                <Cable size={32} />
              </div>
              <strong>No matching connectors found</strong>
              <span>Try a different search keyword or category tab.</span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => { setQuery(''); setActiveGroup('all'); }}
              >
                Reset filters
              </button>
            </div>
          )}

        </section>

      </div>

      {/* 4. CONNECTOR PARAMETER DETAILS DRAWER */}
      {selectedConnector && (
        <div
          className="vault-overlay"
          onMouseDown={e => { if (e.target === e.currentTarget) setSelectedConnector(null); }}
        >
          <aside className="connector-drawer" aria-label="Connector details">
            
            <div className="drawer-header">
              <div className="flex items-center gap-3">
                <div className="connector-icon-badge" style={{ background: selectedConnector.iconBg, width: 34, height: 34 }}>
                  {selectedConnector.icon}
                </div>
                <div>
                  <span className="eyebrow">{selectedConnector.groupLabel.toUpperCase()}</span>
                  <h2>{selectedConnector.name}</h2>
                </div>
              </div>
              <button
                className="small-icon"
                aria-label="Close"
                onClick={() => setSelectedConnector(null)}
              >
                <X size={17} />
              </button>
            </div>

            <div className="connector-drawer-body">
              
              <div className="connector-drawer-overview">
                <p>{selectedConnector.description}</p>
                
                <div className="connector-meta-pills">
                  <span className="meta-pill">
                    <strong>I/O Role:</strong> {selectedConnector.ioType}
                  </span>
                  <span className="meta-pill font-mono">
                    <strong>ID:</strong> {selectedConnector.type}
                  </span>
                </div>
              </div>

              {selectedConnector.securityNote && (
                <div className="vault-notice-card" style={{ marginBottom: 16 }}>
                  <ShieldCheck size={16} className="text-emerald-500" />
                  <span style={{ fontSize: 11.5, color: '#065f46' }}>
                    {selectedConnector.securityNote}
                  </span>
                </div>
              )}

              {/* Parameter Schema */}
              <div className="connector-schema-section">
                <h3>Configurable Parameters ({selectedConnector.definition?.fields.length ?? selectedConnector.fieldsCount})</h3>
                
                {selectedConnector.definition?.fields.length ? (
                  <div className="connector-fields-list">
                    {selectedConnector.definition.fields.map(f => (
                      <div key={f.key} className="connector-field-row">
                        <div className="connector-field-header">
                          <strong className="connector-field-label">{f.label}</strong>
                          <code className="connector-field-type">{f.type}</code>
                        </div>
                        <div className="connector-field-key">Key: <code>config.{f.key}</code></div>
                        {f.placeholder && (
                          <div className="connector-field-placeholder">Default/Example: {f.placeholder}</div>
                        )}
                        {f.options && (
                          <div className="connector-field-options">
                            Options: {f.options.map(opt => <span key={opt} className="opt-chip">{opt}</span>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Configured via dynamic node properties on the canvas.</p>
                )}
              </div>

            </div>

            <div className="workflow-settings-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => copyType(selectedConnector.type)}
              >
                <Copy size={13} /> Copy Node ID
              </button>
              <button
                type="button"
                className="activate-button"
                onClick={() => {
                  notify(`Connector "${selectedConnector.name}" can be dragged from the Left Node Library on the Canvas.`);
                  setSelectedConnector(null);
                }}
              >
                <Play size={13} /> Done
              </button>
            </div>

          </aside>
        </div>
      )}

    </main>
  );
}
