import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseStore } from './database';

export type SecretSummary = { id: string; name: string; description: string; createdAt: string; updatedAt: string; lastUsedAt?: string; version: number };
type SecretRow = { id: string; name: string; description: string; created_at: string; updated_at: string; last_used_at: string | null; version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };

export function vaultKey(value: string | undefined): Buffer {
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new Error('WFLOW_VAULT_KEY must be 64 hexadecimal characters (32 random bytes)');
  return Buffer.from(value, 'hex');
}

export function encryptSecret(value: string, key: Buffer, name: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptSecret(row: Pick<SecretRow, 'name' | 'nonce' | 'ciphertext' | 'auth_tag'>, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
  decipher.setAAD(Buffer.from(row.name, 'utf8'));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}

const summary = (row: SecretRow): SecretSummary => ({ id: row.id, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at || undefined, version: Number(row.version) });
const validName = (name: string) => /^[A-Za-z][A-Za-z0-9_./-]{0,127}$/.test(name);

export class SecretVault {
  private key: Buffer;
  constructor(private store: DatabaseStore, key = process.env.WFLOW_VAULT_KEY) { this.key = vaultKey(key); }

  async list(): Promise<SecretSummary[]> {
    const rows = await this.store.sql`SELECT id, name, description, created_at, updated_at, last_used_at, version FROM wflow_secrets ORDER BY name` as SecretRow[];
    return rows.map(summary);
  }

  async create(input: { name: string; description?: string; value: string }): Promise<SecretSummary> {
    const name = String(input.name || '').trim();
    if (!validName(name)) throw new Error('Secret name must start with a letter and use letters, numbers, _, -, . or / (up to 128 characters)');
    if (typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 65536) throw new Error('Secret value must contain 1 to 65536 UTF-8 bytes');
    const description = String(input.description || '').trim().slice(0, 500);
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    const encrypted = encryptSecret(input.value, this.key, name);
    try {
      await this.store.sql`INSERT INTO wflow_secrets (id, name, description, created_at, updated_at, version, nonce, ciphertext, auth_tag) VALUES (${id}, ${name}, ${description}, ${now}, ${now}, ${1}, ${encrypted.nonce}, ${encrypted.ciphertext}, ${encrypted.authTag})`;
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new Error('A secret with this name already exists');
      throw error;
    }
    return { id, name, description, createdAt: now, updatedAt: now, version: 1 };
  }

  async update(id: string, input: { description?: string; value?: string }): Promise<SecretSummary | null> {
    const rows = await this.store.sql`SELECT * FROM wflow_secrets WHERE id = ${id}` as SecretRow[];
    const row = rows[0]; if (!row) return null;
    const description = input.description === undefined ? row.description : String(input.description).trim().slice(0, 500);
    const changed = input.value !== undefined;
    if (changed && (typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 65536)) throw new Error('Secret value must contain 1 to 65536 UTF-8 bytes');
    const encrypted = changed ? encryptSecret(input.value!, this.key, row.name) : null;
    const now = new Date().toISOString();
    if (encrypted) await this.store.sql`UPDATE wflow_secrets SET description = ${description}, updated_at = ${now}, version = version + 1, nonce = ${encrypted.nonce}, ciphertext = ${encrypted.ciphertext}, auth_tag = ${encrypted.authTag} WHERE id = ${id}`;
    else await this.store.sql`UPDATE wflow_secrets SET description = ${description}, updated_at = ${now} WHERE id = ${id}`;
    return { ...summary(row), description, updatedAt: now, version: row.version + (changed ? 1 : 0) };
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.store.sql`SELECT id FROM wflow_secrets WHERE id = ${id}`;
    if (!rows.length) return false;
    await this.store.sql`DELETE FROM wflow_secrets WHERE id = ${id}`;
    return true;
  }

  async get(name: string): Promise<string> {
    const rows = await this.store.sql`SELECT * FROM wflow_secrets WHERE name = ${name}` as SecretRow[];
    if (!rows.length) throw new Error(`Secret ${name} was not found`);
    const value = decryptSecret(rows[0], this.key);
    await this.store.sql`UPDATE wflow_secrets SET last_used_at = ${new Date().toISOString()} WHERE id = ${rows[0].id}`;
    return value;
  }
}
