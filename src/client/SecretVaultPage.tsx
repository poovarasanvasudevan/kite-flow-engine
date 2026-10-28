import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react';

type Secret = { id: string; name: string; description: string; createdAt: string; updatedAt: string; lastUsedAt?: string; version: number };
const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Never';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
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
  const refresh = async () => { setSecrets(await request<Secret[]>('/api/secrets')); };
  useEffect(() => { void refresh().catch(error => notify((error as Error).message, true)).finally(() => setLoading(false)); }, []);
  const filtered = useMemo(() => secrets.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())), [secrets, query]);
  const open = (item: Secret | 'new') => {
    setEditing(item); setName(item === 'new' ? '' : item.name); setDescription(item === 'new' ? '' : item.description);
    setValue(''); setVisible(false); setFormError('');
  };
  const close = () => { if (!busy) { setValue(''); setVisible(false); setEditing(null); } };
  const save = async () => {
    if (busy || !editing) return;
    setBusy(true); setFormError('');
    try {
      if (editing === 'new') await request<Secret>('/api/secrets', { method: 'POST', body: JSON.stringify({ name: name.trim(), description, value }) });
      else await request<Secret>(`/api/secrets/${editing.id}`, { method: 'PUT', body: JSON.stringify({ description, ...(value ? { value } : {}) }) });
      setValue(''); setEditing(null); await refresh(); notify(editing === 'new' ? 'Secret created' : 'Secret updated');
    } catch (error) { setFormError((error as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (item: Secret) => {
    if (!window.confirm(`Delete ${item.name}? Workflows using it will fail until the reference is changed.`)) return;
    try { await request(`/api/secrets/${item.id}`, { method: 'DELETE' }); await refresh(); notify('Secret deleted'); }
    catch (error) { notify((error as Error).message, true); }
  };

  return <main className="vault-page">
    <div className="vault-content">
      <div className="plugins-heading vault-heading"><div><span className="eyebrow">WORKSPACE</span><h1>Secret Vault</h1><p>Keep credentials encrypted and use them in workflows at runtime.</p></div><button className="activate-button" onClick={() => open('new')}><Plus size={16}/> Add secret</button></div>
      <section className="vault-card" aria-label="Stored secrets">
        <div className="vault-toolbar"><div><h2>Secrets</h2><span>{filtered.length} of {secrets.length}</span></div><label className="plugins-search"><Search size={15}/><input aria-label="Search secrets" placeholder="Search secrets" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
        <div className="vault-notice"><ShieldCheck size={17}/><span>Values are encrypted before storage. Existing values are never shown here; enter a new value to rotate one.</span></div>
        <div className="vault-table-scroll"><table className="vault-table"><thead><tr><th>Name</th><th>Description</th><th>Version</th><th>Updated</th><th>Last used</th><th>Actions</th></tr></thead><tbody>
          {filtered.map(item => <tr key={item.id}><td><div className="vault-name"><span><KeyRound size={16}/></span><strong>{item.name}</strong></div></td><td className="vault-description" title={item.description}>{item.description || '—'}</td><td>v{item.version}</td><td>{date(item.updatedAt)}</td><td>{date(item.lastUsedAt)}</td><td><div className="vault-row-actions"><button title={`Edit ${item.name}`} aria-label={`Edit ${item.name}`} onClick={() => open(item)}><Pencil size={15}/></button><button className="danger" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} onClick={() => void remove(item)}><Trash2 size={15}/></button></div></td></tr>)}
        </tbody></table>{!loading && !filtered.length && <div className="vault-empty"><KeyRound size={23}/><strong>{secrets.length ? 'No matching secrets' : 'No secrets yet'}</strong><span>{secrets.length ? 'Try a different search.' : 'Add a secret to use it in a workflow.'}</span></div>}</div>
      </section>
    </div>
    {editing && <div className="vault-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><aside className="vault-drawer" aria-label={editing === 'new' ? 'Add secret' : 'Edit secret'}>
      <div className="drawer-header"><div><span className="eyebrow">SECRET VAULT</span><h2>{editing === 'new' ? 'Add secret' : 'Edit secret'}</h2></div><button className="small-icon" aria-label="Close" onClick={close}><X size={18}/></button></div>
      <div className="vault-fields"><label className="field"><span>Name</span><input autoFocus disabled={editing !== 'new'} maxLength={128} placeholder="servers/prod/password" value={name} onChange={event => setName(event.target.value)}/></label><small className="vault-field-help">Use this name in a Function node with await getSecret('name').</small>
        <label className="field"><span>Description</span><textarea rows={3} maxLength={500} placeholder="What is this credential for?" value={description} onChange={event => setDescription(event.target.value)}/></label>
        <label className="field"><span>{editing === 'new' ? 'Secret value' : 'New value (optional)'}</span><div className="vault-value-input"><input type={visible ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} placeholder={editing === 'new' ? 'Enter secret value' : 'Leave blank to keep the current value'} value={value} onChange={event => setValue(event.target.value)}/><button type="button" aria-label={visible ? 'Hide value' : 'Show value'} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>
        {editing !== 'new' && <small className="vault-field-help">Current value is hidden. Supplying a new value creates version {editing.version + 1}.</small>}
        {formError && <div className="vault-form-error" role="alert">{formError}</div>}
      </div>
      <div className="workflow-settings-actions"><button className="secondary-button" disabled={busy} onClick={close}>Cancel</button><button className="activate-button" disabled={busy || (editing === 'new' && (!name.trim() || !value))} onClick={() => void save()}>{busy ? 'Saving…' : editing === 'new' ? 'Create secret' : 'Save changes'}</button></div>
    </aside></div>}
  </main>;
}
