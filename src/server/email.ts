import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { FlowNode, Message, NodeContext } from '../shared';

export type EmailCursorStore = {
  getEmailCursor(workflowId: string, nodeId: string, folder: string): Promise<{ uidValidity: string; lastUid: number } | null>;
  setEmailCursor(workflowId: string, nodeId: string, folder: string, uidValidity: string, lastUid: number): Promise<void>;
};

type EmailConfig = Record<string, unknown>;
type MailTransport = { sendMail(message: Record<string, unknown>): Promise<any>; close?(): void };

function envReference(value: unknown, fallback: string, required = true) {
  const name = String(value || fallback).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  const resolved = process.env[name];
  if (required && !resolved) throw new Error(`${name} is not set`);
  return resolved;
}

function positivePort(value: unknown, fallback: number) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Email port must be between 1 and 65535');
  return port;
}

export function imapOptions(config: EmailConfig): ImapFlowOptions {
  const host = String(config.host || process.env.IMAP_HOST || '').trim();
  if (!host) throw new Error('IMAP host is required');
  const user = envReference(config.userEnv, 'IMAP_USER');
  const pass = envReference(config.passwordEnv, 'IMAP_PASSWORD');
  const secure = config.secure !== false;
  return { host, port: positivePort(config.port || process.env.IMAP_PORT, secure ? 993 : 143), secure,
    ...(!secure ? { doSTARTTLS: true } : {}), auth: { user: user!, pass: pass! }, logger: false,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 };
}

export function foldersFromConfig(value: unknown): string[] {
  const folders = String(value || 'INBOX').split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean);
  return [...new Set(folders)];
}

export async function listEmailFolders(config: EmailConfig, createClient = (options: ImapFlowOptions) => new ImapFlow(options)) {
  const client = createClient(imapOptions(config));
  try {
    await client.connect();
    return (await client.list()).filter(item => !item.flags.has('\\Noselect')).map(item => item.path);
  } finally { await closeClient(client); }
}

async function closeClient(client: ImapFlow) {
  try { if (client.usable) await client.logout(); else client.close(); }
  catch { client.close(); }
}

function lookup(message: Message, key: string): unknown {
  return key.split('.').reduce((value: any, part) => value?.[part], message);
}
function render(value: unknown, message: Message) {
  return String(value ?? '').replace(/{{\s*msg\.([\w.]+)\s*}}/g, (_, key) => String(lookup(message, key) ?? ''));
}
function addressText(value: { text: string } | { text: string }[] | undefined) {
  return Array.isArray(value) ? value.map(item => item.text).join(', ') : value?.text || '';
}

export async function sendEmail(message: Message, config: EmailConfig, transportFactory: (options: any) => MailTransport = options => nodemailer.createTransport(options)) {
  const host = String(config.host || process.env.SMTP_HOST || '').trim();
  if (!host) throw new Error('SMTP host is required');
  const secure = config.secure === true;
  const user = envReference(config.userEnv, 'SMTP_USER', false);
  const pass = envReference(config.passwordEnv, 'SMTP_PASSWORD', false);
  if (Boolean(user) !== Boolean(pass)) throw new Error('Set both SMTP_USER and SMTP_PASSWORD, or neither');
  const from = render(config.from || process.env.SMTP_FROM || message.from, message).trim();
  const to = render(config.to || message.to || message.email?.to, message).trim();
  if (!from || !to) throw new Error('Email Out requires From and To addresses');
  const subject = render(config.subject || message.subject || message.email?.subject, message);
  const payload = message.payload;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const mail: Record<string, unknown> = { from, to, subject,
    ...(config.bodyMode === 'html' ? { html: body } : { text: body }) };
  for (const field of ['cc', 'bcc', 'replyTo'] as const) {
    const value = render(config[field] || message[field], message).trim();
    if (value) mail[field] = value;
  }
  const transport = transportFactory({ host, port: positivePort(config.port || process.env.SMTP_PORT, secure ? 465 : 587), secure,
    ...(!secure ? { requireTLS: config.requireTLS !== false } : {}),
    ...(user && pass ? { auth: { user, pass } } : {}), connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  try {
    const result = await transport.sendMail(mail);
    return { messageId: result.messageId, accepted: result.accepted || [], rejected: result.rejected || [], response: result.response };
  } finally { transport.close?.(); }
}

export async function emailOutHandler(message: Message, context: NodeContext) {
  message.emailResult = await sendEmail(message, context.config);
  context.send(0, message);
}

export async function pollEmailNode(
  workflowId: string, node: FlowNode, cursors: EmailCursorStore,
  emit: (message: Message) => Promise<boolean>, log: (message: string, error?: unknown) => void,
  createClient = (options: ImapFlowOptions) => new ImapFlow(options),
) {
  const config = node.data.config;
  const client = createClient(imapOptions(config));
  const maxBytes = Math.min(Math.max(Number(config.maxBytes) || 5_000_000, 1024), 25_000_000);
  try {
    await client.connect();
    for (const folder of foldersFromConfig(config.folders)) {
      if (folder.length > 255) { log('Skipped IMAP folder name longer than 255 characters'); continue; }
      let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: config.markRead !== true });
        const uidValidity = String(client.mailbox && client.mailbox.uidValidity || '');
        const cursor = await cursors.getEmailCursor(workflowId, node.id, folder);
        const lastUid = cursor?.uidValidity === uidValidity ? cursor.lastUid : 0;
        const found = await client.search({ uid: `${Math.max(1, lastUid + 1)}:*`, ...(config.unseenOnly !== false ? { seen: false } : {}) }, { uid: true });
        const uids = Array.isArray(found) ? found.filter(uid => uid > lastUid).sort((a, b) => a - b).slice(0, 25) : [];
        for (const uid of uids) {
          const fetched = await client.fetchOne(uid, { uid: true, size: true, source: { maxLength: maxBytes + 1 } }, { uid: true });
          if (!fetched) continue;
          if ((fetched.size || 0) > maxBytes || !fetched.source || fetched.source.length > maxBytes) {
            log(`Skipped oversized email in ${folder} (UID ${uid})`);
            await cursors.setEmailCursor(workflowId, node.id, folder, uidValidity, uid);
            continue;
          }
          const mail = await simpleParser(fetched.source);
          const incoming: Message = {
            payload: mail.text || mail.html || '',
            email: {
              folder, uid, uidValidity, messageId: mail.messageId, subject: mail.subject || '',
              from: addressText(mail.from), to: addressText(mail.to), cc: addressText(mail.cc),
              date: mail.date?.toISOString(), html: mail.html || '',
              attachments: mail.attachments.map(item => ({ filename: item.filename, contentType: item.contentType, size: item.size })),
            },
            _msgid: crypto.randomUUID(),
          };
          const succeeded = await emit(incoming);
          if (!succeeded) { log(`Email workflow failed in ${folder} (UID ${uid}); retrying on next poll`); break; }
          if (config.markRead === true) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          await cursors.setEmailCursor(workflowId, node.id, folder, uidValidity, uid);
        }
      } catch (error) { log(`Could not poll IMAP folder ${folder}: ${error instanceof Error ? error.message : String(error)}`, error); }
      finally { lock?.release(); }
    }
  } finally { await closeClient(client); }
}

export function startEmailPoller(
  workflowId: string, node: FlowNode, cursors: EmailCursorStore,
  emit: (message: Message) => Promise<boolean>, log: (message: string, error?: unknown) => void,
) {
  let stopped = false;
  let busy = false;
  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await pollEmailNode(workflowId, node, cursors, message => stopped ? Promise.resolve(false) : emit(message), log); }
    catch (error) { if (!stopped) log(`Email In ${node.data.name || node.id}: ${error instanceof Error ? error.message : String(error)}`, error); }
    finally { busy = false; }
  };
  const seconds = Math.max(15, Math.min(Number(node.data.config.pollSeconds) || 60, 3600));
  const timer = setInterval(() => { void poll(); }, seconds * 1000);
  void poll();
  return () => { stopped = true; clearInterval(timer); };
}
