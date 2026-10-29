import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, Copy, Eye, EyeOff, KeyRound, LayoutGrid, List,
  Lock, Pencil, Plus, RefreshCw, Search, Shield, ShieldCheck,
  Sparkles, Terminal, Trash2, X
} from 'lucide-react';

type Secret = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  version: number;
};

const formatDate = (value?: string) => {
  if (!value) return 'Never';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Vault request failed');
  return data as T;
}

export function SecretVaultPage({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Secret | null | 'new'>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [formError, setFormError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const refresh = async () => {
    setSecrets(await request<Secret[]>('/api/secrets'));
  };

  useEffect(() => {
    void refresh()
      .catch(error => notify((error as Error).message, true))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return secrets;
    return secrets.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(q));
  }, [secrets, query]);

  const open = (item: Secret | 'new') => {
    setEditing(item);
    setName(item === 'new' ? '' : item.name);
    setDescription(item === 'new' ? '' : item.description);
    setValue('');
    setVisible(false);
    setFormError('');
  };

  const close = () => {
    if (!busy) {
      setValue('');
      setVisible(false);
      setEditing(null);
    }
  };

  const save = async () => {
    if (busy || !editing) return;
    setBusy(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await request<Secret>('/api/secrets', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), description, value })
        });
      } else {
        await request<Secret>(`/api/secrets/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ description, ...(value ? { value } : {}) })
        });
      }
      setValue('');
      setEditing(null);
      await refresh();
      notify(editing === 'new' ? 'Secret created and encrypted' : 'Secret updated and rotated');
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Secret) => {
    if (!window.confirm(`Delete secret "${item.name}"? Workflows referring to this key will fail at runtime.`)) return;
    try {
      await request(`/api/secrets/${item.id}`, { method: 'DELETE' });
      await refresh();
      notify('Secret deleted');
    } catch (error) {
      notify((error as Error).message, true);
    }
  };

  const copySnippet = (secretName: string, id: string) => {
    navigator.clipboard.writeText(`await getSecret('${secretName}')`);
    setCopiedId(id);
    notify(`Copied snippet: await getSecret('${secretName}')`);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const generateRandomSecret = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+~|}{[]';
    let res = '';
    const array = new Uint32Array(32);
    crypto.getRandomValues(array);
    for (let i = 0; i < 32; i++) {
      res += chars[array[i] % chars.length];
    }
    setValue(res);
    setVisible(true);
  };

  return (
    <main className="vault-page">
      <div className="vault-content">
        
        {/* 1. HERO HEADER */}
        <div className="vault-hero-header">
          <div className="vault-hero-copy">
            <span className="eyebrow">ENCRYPTED CREDENTIALS</span>
            <h1>Secret Vault</h1>
            <p>Store API keys, database credentials, and certificates securely with encrypted zero-knowledge storage.</p>
          </div>
          <div className="vault-header-actions">
            <button className="activate-button" onClick={() => open('new')}>
              <Plus size={15} /> Add Secret
            </button>
          </div>
        </div>

        {/* 2. SECURITY & STATUS METRICS */}
        <div className="vault-stats-bar">
          <div className="stat-pill">
            <span className="stat-label">Stored Secrets</span>
            <span className="stat-value">{secrets.length}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Encryption</span>
            <span className="stat-value text-emerald-600 flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-emerald-500" /> AES-256-GCM
            </span>
          </div>
          <div className="stat-pill">
            <span className="stat-label">Zero Knowledge</span>
            <span className="stat-value text-indigo-600 flex items-center gap-1.5">
              <Lock size={13} className="text-indigo-500" /> Write-Only UI
            </span>
          </div>
        </div>

        {/* 3. ENCRYPTION POLICY BANNER */}
        <div className="vault-notice-card">
          <div className="vault-notice-icon">
            <Shield size={18} />
          </div>
          <div className="vault-notice-copy">
            <strong>Hardware-Grade Cryptographic Storage</strong>
            <span>
              All values are encrypted prior to database persistence. Existing secrets cannot be viewed in plaintext.
              To rotate a credential, enter a new value to issue a new revision.
            </span>
          </div>
        </div>

        {/* 4. MAIN REGISTRY CARD */}
        <section className="vault-card" aria-label="Stored secrets">
          
          {/* TOOLBAR */}
          <div className="vault-toolbar">
            <div className="vault-toolbar-left">
              <h2>Secrets</h2>
              <span className="vault-count-badge">
                {filtered.length} of {secrets.length} {filtered.length === 1 ? 'secret' : 'secrets'}
              </span>
            </div>

            <div className="vault-toolbar-right">
              {/* Search Bar */}
              <label className="plugins-search">
                <Search size={14} />
                <input
                  aria-label="Search secrets"
                  placeholder="Filter secrets by name or tag…"
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

          {/* 5. CONTENT (GRID OR TABLE) */}
          {filtered.length ? (
            viewMode === 'grid' ? (
              /* GRID CARDS VIEW */
              <div className="vault-grid-view">
                {filtered.map(item => (
                  <div key={item.id} className="vault-node-card">
                    <div className="vault-card-top">
                      <div className="vault-card-icon">
                        <KeyRound size={17} />
                      </div>
                      <span className="vault-version-badge">
                        v{item.version}
                      </span>
                    </div>

                    <div className="vault-card-body">
                      <div className="vault-card-name-row">
                        <strong className="vault-card-name" title={item.name}>{item.name}</strong>
                      </div>
                      
                      {/* Code Snippet Pill */}
                      <button
                        type="button"
                        className="vault-snippet-pill"
                        title="Click to copy getSecret() call"
                        onClick={() => copySnippet(item.name, item.id)}
                      >
                        <code>await getSecret('{item.name}')</code>
                        {copiedId === item.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                      </button>

                      <p className="vault-card-desc" title={item.description}>
                        {item.description || 'No description provided.'}
                      </p>
                    </div>

                    {/* Masked Secret Value Visualizer */}
                    <div className="vault-masked-bar">
                      <Lock size={12} className="text-slate-400" />
                      <span className="vault-masked-dots">••••••••••••••••</span>
                      <span className="vault-encrypted-label">Encrypted</span>
                    </div>

                    {/* Footer */}
                    <div className="vault-card-footer">
                      <div className="vault-dates-meta">
                        <span>Updated: {formatDate(item.updatedAt)}</span>
                        {item.lastUsedAt && <span>Used: {formatDate(item.lastUsedAt)}</span>}
                      </div>

                      <div className="vault-actions-group">
                        <button
                          type="button"
                          className="vault-action-btn"
                          title="Rotate / Edit details"
                          aria-label={`Edit ${item.name}`}
                          onClick={() => open(item)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="vault-action-btn danger"
                          title="Delete secret"
                          aria-label={`Delete ${item.name}`}
                          onClick={() => void remove(item)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* TABLE VIEW */
              <div className="vault-table-scroll">
                <table className="vault-table">
                  <thead>
                    <tr>
                      <th>Key Name</th>
                      <th>Runtime Access Call</th>
                      <th>Description</th>
                      <th>Version</th>
                      <th>Last Modified</th>
                      <th>Last Accessed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(item => (
                      <tr key={item.id}>
                        <td>
                          <div className="vault-name">
                            <span className="vault-table-icon"><KeyRound size={15} /></span>
                            <strong>{item.name}</strong>
                          </div>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="vault-table-snippet"
                            title="Copy getSecret() call"
                            onClick={() => copySnippet(item.name, item.id)}
                          >
                            <code>getSecret('{item.name}')</code>
                            {copiedId === item.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                          </button>
                        </td>
                        <td className="vault-description" title={item.description}>
                          {item.description || '—'}
                        </td>
                        <td>
                          <span className="vault-version-pill">v{item.version}</span>
                        </td>
                        <td>{formatDate(item.updatedAt)}</td>
                        <td>{formatDate(item.lastUsedAt)}</td>
                        <td>
                          <div className="vault-row-actions">
                            <button
                              type="button"
                              title={`Rotate or edit ${item.name}`}
                              aria-label={`Edit ${item.name}`}
                              onClick={() => open(item)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="danger"
                              title={`Delete ${item.name}`}
                              aria-label={`Delete ${item.name}`}
                              onClick={() => void remove(item)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="vault-empty">
              <div className="vault-empty-icon">
                <KeyRound size={32} />
              </div>
              <strong>{secrets.length ? 'No matching secrets' : 'No secrets stored yet'}</strong>
              <span>{secrets.length ? 'Try a different search query.' : 'Add your first API key, database URL, or token.'}</span>
              {secrets.length === 0 && (
                <button type="button" className="activate-button" onClick={() => open('new')}>
                  <Plus size={15} /> Create First Secret
                </button>
              )}
            </div>
          )}

        </section>

      </div>

      {/* 6. SLIDE-OVER DRAWER MODAL */}
      {editing && (
        <div
          className="vault-overlay"
          onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
        >
          <aside className="vault-drawer" aria-label={editing === 'new' ? 'Add secret' : 'Edit secret'}>
            
            <div className="drawer-header">
              <div className="vault-drawer-heading">
                <span className="eyebrow">ENCRYPTED CREDENTIAL</span>
                <h2>{editing === 'new' ? 'Add New Secret' : 'Rotate Secret'}</h2>
              </div>
              <button className="small-icon" aria-label="Close drawer" onClick={close}>
                <X size={17} />
              </button>
            </div>

            <div className="vault-fields">
              
              <label className="field">
                <span>Secret Identifier Name</span>
                <input
                  autoFocus
                  disabled={editing !== 'new'}
                  maxLength={128}
                  placeholder="e.g. stripe/api_key, database/prod_password"
                  value={name}
                  onChange={event => setName(event.target.value)}
                />
              </label>
              
              <div className="vault-snippet-preview">
                <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Runtime Usage:</span>
                <code>await getSecret('{name || "identifier"}')</code>
              </div>

              <label className="field">
                <span>Description (Optional)</span>
                <textarea
                  rows={3}
                  maxLength={500}
                  placeholder="What service or integration uses this credential?"
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                />
              </label>

              <label className="field">
                <div className="flex items-center justify-between">
                  <span>{editing === 'new' ? 'Secret Value' : 'New Value (Leave blank to keep existing)'}</span>
                  <button
                    type="button"
                    className="vault-generate-btn"
                    onClick={generateRandomSecret}
                  >
                    <Sparkles size={12} /> Generate Key
                  </button>
                </div>
                <div className="vault-value-input">
                  <input
                    type={visible ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={editing === 'new' ? 'Paste token, key, or password' : 'Enter new value to rotate'}
                    value={value}
                    onChange={event => setValue(event.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={visible ? 'Hide value' : 'Show value'}
                    onClick={() => setVisible(current => !current)}
                  >
                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>

              {editing !== 'new' && (
                <div className="vault-rotation-notice">
                  <ShieldCheck size={15} className="text-emerald-500" />
                  <span>Existing value remains securely encrypted. Providing a new value will bump version to v{editing.version + 1}.</span>
                </div>
              )}

              {formError && (
                <div className="vault-form-error" role="alert">
                  {formError}
                </div>
              )}
            </div>

            <div className="workflow-settings-actions">
              <button className="secondary-button" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button
                className="activate-button"
                disabled={busy || (editing === 'new' && (!name.trim() || !value))}
                onClick={() => void save()}
              >
                {busy ? 'Encrypting…' : editing === 'new' ? 'Save & Encrypt' : 'Rotate Credential'}
              </button>
            </div>

          </aside>
        </div>
      )}

    </main>
  );
}
