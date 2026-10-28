import { afterAll, expect, test } from 'bun:test';
import { foldersFromConfig, listEmailFolders, pollEmailNode, sendEmail } from './email';
import type { FlowNode } from '../shared';

const prior = { IMAP_USER: process.env.IMAP_USER, IMAP_PASSWORD: process.env.IMAP_PASSWORD, SMTP_USER: process.env.SMTP_USER, SMTP_PASSWORD: process.env.SMTP_PASSWORD };
process.env.IMAP_USER = 'test-user'; process.env.IMAP_PASSWORD = 'test-password';
process.env.SMTP_USER = 'test-user'; process.env.SMTP_PASSWORD = 'test-password';
afterAll(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('Email Out composes text with SMTP settings and forwards delivery information', async () => {
  let options: any; let mail: any;
  const result = await sendEmail({ payload: 'Hello Ada', email: { to: 'ada@example.test' } },
    { host: 'smtp.example.test', from: 'bot@example.test', subject: 'Report: {{msg.payload}}' },
    selected => { options = selected; return { async sendMail(message) { mail = message; return { messageId: 'mail-1', accepted: ['ada@example.test'], rejected: [] }; } }; });
  expect(options.host).toBe('smtp.example.test');
  expect(options.requireTLS).toBe(true);
  expect(options.auth.user).toBe('test-user');
  expect(mail).toMatchObject({ from: 'bot@example.test', to: 'ada@example.test', subject: 'Report: Hello Ada', text: 'Hello Ada' });
  expect(result).toEqual({ messageId: 'mail-1', accepted: ['ada@example.test'], rejected: [], response: undefined });
});

test('Email In lists folders and polls new messages with a persistent UID cursor', async () => {
  const seen: string[] = []; const cursors = new Map<string, { uidValidity: string; lastUid: number }>();
  const raw = Buffer.from('From: Ada <ada@example.test>\r\nTo: Bot <bot@example.test>\r\nSubject: Example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello');
  const factory = (_options: any): any => ({ usable: true, mailbox: { uidValidity: 42n },
    async connect() {}, async list() { return [{ path: 'INBOX', flags: new Set() }, { path: 'Archive/Work', flags: new Set() }]; },
    async getMailboxLock(folder: string) { seen.push(folder); return { release() {} }; },
    async search() { return [1, 2]; },
    async fetchOne(uid: number) { return { uid, size: raw.length, source: raw }; },
    async logout() {}, close() {},
  });
  expect(foldersFromConfig('INBOX, Archive/Work\nINBOX')).toEqual(['INBOX', 'Archive/Work']);
  expect(await listEmailFolders({ host: 'imap.example.test' }, factory)).toEqual(['INBOX', 'Archive/Work']);
  const node: FlowNode = { id: 'email', type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType: 'email-in', config: { host: 'imap.example.test', folders: 'INBOX,Archive/Work' } } };
  const messages: any[] = [];
  const store = { async getEmailCursor(_flow: string, _node: string, folder: string) { return cursors.get(folder) || null; },
    async setEmailCursor(_flow: string, _node: string, folder: string, uidValidity: string, lastUid: number) { cursors.set(folder, { uidValidity, lastUid }); } };
  await pollEmailNode('flow', node, store, async message => { messages.push(message); return true; }, () => {}, factory);
  expect(messages).toHaveLength(4);
  expect(messages[0].payload).toBe('Hello');
  expect(messages[0].email.folder).toBe('INBOX');
  expect(cursors.get('INBOX')).toEqual({ uidValidity: '42', lastUid: 2 });
  await pollEmailNode('flow', node, store, async message => { messages.push(message); return true; }, () => {}, factory);
  expect(messages).toHaveLength(4);
  expect(seen).toContain('Archive/Work');
});
