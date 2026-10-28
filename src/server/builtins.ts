import type { Message, NodeContext, NodeDefinition, NodeHandler } from '../shared';
import { emailOutHandler } from './email';

const field = (key: string, label: string, type: NodeDefinition['fields'][number]['type'], placeholder?: string) => ({ key, label, type, placeholder });
export const builtins: NodeDefinition[] = [
  { type: 'inject', label: 'Inject', category: 'Input', color: '#d9c7e8', icon: 'play', inputs: 0, outputs: 1, description: 'Start a flow manually or on an interval.', defaults: { payload: '"Hello, world!"', interval: 0 }, fields: [field('payload', 'Payload (JSON)', 'json'), field('interval', 'Repeat every seconds (0 = off)', 'number')] },
  { type: 'http-in', label: 'HTTP In', category: 'Input', color: '#b8d8d8', icon: 'globe', inputs: 0, outputs: 1, description: 'Receive an HTTP request at /hook/{path}. Connect to HTTP Response.', defaults: { method: 'GET', path: 'hello' }, fields: [{ key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, field('path', 'Path after /hook/', 'text')] },
  { type: 'email-in', label: 'Email In', category: 'Input', color: '#b8d8d8', icon: 'mail', inputs: 0, outputs: 1, description: 'Poll IMAP folders and start a workflow for each new email.', defaults: { host: '', port: 993, secure: true, userEnv: 'IMAP_USER', passwordEnv: 'IMAP_PASSWORD', folders: 'INBOX', pollSeconds: 60, unseenOnly: true, markRead: false, maxBytes: 5000000 }, fields: [field('host', 'IMAP host (or IMAP_HOST)', 'text'), field('port', 'IMAP port', 'number'), field('secure', 'Use TLS', 'boolean'), field('userEnv', 'Username environment variable', 'text'), field('passwordEnv', 'Password environment variable', 'text'), field('folders', 'Folders (comma or newline separated)', 'textarea'), field('pollSeconds', 'Poll every seconds (minimum 15)', 'number'), field('unseenOnly', 'Only unread messages', 'boolean'), field('markRead', 'Mark processed mail as read', 'boolean'), field('maxBytes', 'Maximum message bytes', 'number')] },
  { type: 'continue', label: 'Continue', category: 'Input', color: '#d9c7e8', icon: 'circle-check', inputs: 0, outputs: 1, description: 'Trigger when another node finishes. Blank or * watches all nodes.', defaults: { watch: '*', includeErrors: true }, fields: [field('watch', 'Watch node ID, type, or name (comma separated; * = all)', 'text'), field('includeErrors', 'Include failed nodes', 'boolean')] },
  { type: 'debug', label: 'Debug', category: 'Output', color: '#b6d7a8', icon: 'bug', inputs: 1, outputs: 0, description: 'Write a message or payload to the Debug panel.', defaults: { complete: false }, fields: [field('complete', 'Show complete message', 'boolean')] },
  { type: 'http-response', label: 'HTTP Response', category: 'Output', color: '#b8d8d8', icon: 'send', inputs: 1, outputs: 0, description: 'Reply to an HTTP In request using msg.payload.', defaults: { status: 200 }, fields: [field('status', 'Status code', 'number')] },
  { type: 'email-out', label: 'Email Out', category: 'Output', color: '#b8d8d8', icon: 'mail-plus', inputs: 1, outputs: 1, description: 'Send msg.payload through SMTP, then forward delivery details.', defaults: { host: '', port: 587, secure: false, requireTLS: true, userEnv: 'SMTP_USER', passwordEnv: 'SMTP_PASSWORD', from: '', to: '', subject: '', bodyMode: 'text' }, fields: [field('host', 'SMTP host (or SMTP_HOST)', 'text'), field('port', 'SMTP port', 'number'), field('secure', 'Use implicit TLS', 'boolean'), field('requireTLS', 'Require STARTTLS when not using implicit TLS', 'boolean'), field('userEnv', 'Username environment variable', 'text'), field('passwordEnv', 'Password environment variable', 'text'), field('from', 'From (or SMTP_FROM)', 'text'), field('to', 'To (supports {{msg.email.to}})', 'text'), field('cc', 'Cc', 'text'), field('bcc', 'Bcc', 'text'), field('replyTo', 'Reply-to', 'text'), field('subject', 'Subject (supports {{msg.payload}})', 'text'), { key: 'bodyMode', label: 'Body format', type: 'select', options: ['text', 'html'] }] },
  { type: 'function', label: 'Function', category: 'Function', color: '#e8d6a8', icon: 'code', inputs: 1, outputs: 1, description: 'Run trusted JavaScript. Use await getSecret(name) for Vault values.', defaults: { code: 'return msg;' }, fields: [field('code', 'JavaScript body', 'code')] },
  { type: 'change', label: 'Change', category: 'Function', color: '#e8d6a8', icon: 'pencil', inputs: 1, outputs: 1, description: 'Set or delete a dot-path on the message.', defaults: { operation: 'set', property: 'payload', value: '"updated"' }, fields: [{ key: 'operation', label: 'Operation', type: 'select', options: ['set', 'delete'] }, field('property', 'Message property', 'text'), field('value', 'Value (JSON)', 'json')] },
  { type: 'switch', label: 'Switch', category: 'Function', color: '#e8d6a8', icon: 'git-branch', inputs: 1, outputs: 2, description: 'Send matching messages to output 1 and other messages to output 2.', defaults: { property: 'payload', operator: 'equals', value: 'true' }, fields: [field('property', 'Message property', 'text'), { key: 'operator', label: 'Condition', type: 'select', options: ['equals', 'not equals', 'greater than', 'less than', 'contains', 'exists'] }, field('value', 'Compare to (JSON)', 'json')] },
  { type: 'template', label: 'Template', category: 'Function', color: '#e8d6a8', icon: 'file-text', inputs: 1, outputs: 1, description: 'Render {{msg.path}} placeholders into msg.payload.', defaults: { template: 'Hello {{msg.payload}}' }, fields: [field('template', 'Template', 'textarea')] },
  { type: 'json', label: 'JSON', category: 'Function', color: '#e8d6a8', icon: 'braces', inputs: 1, outputs: 1, description: 'Parse a JSON string or stringify a value.', defaults: { action: 'parse' }, fields: [{ key: 'action', label: 'Action', type: 'select', options: ['parse', 'stringify'] }] },
  { type: 'delay', label: 'Delay', category: 'Function', color: '#e8d6a8', icon: 'clock', inputs: 1, outputs: 1, description: 'Wait before forwarding a message.', defaults: { milliseconds: 1000 }, fields: [field('milliseconds', 'Delay (ms)', 'number')] },
  { type: 'http-request', label: 'HTTP Request', category: 'Network', color: '#b8d8d8', icon: 'arrow-up-right', inputs: 1, outputs: 1, description: 'Make an outbound HTTP request and place the response in msg.payload.', defaults: { method: 'GET', url: 'https://example.com' }, fields: [{ key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, field('url', 'URL (supports {{msg.path}})', 'text')] },
];

export function getPath(value: any, path: string): any { return path.split('.').reduce((current, part) => current?.[part], value); }
function setPath(value: Message, path: string, next: unknown) {
  const keys = path.split('.').filter(Boolean);
  if (!keys.length || ['__proto__', 'prototype', 'constructor'].some(part => keys.includes(part))) throw new Error('Invalid property path');
  let current: any = value;
  for (const key of keys.slice(0, -1)) { if (typeof current[key] !== 'object' || current[key] === null) current[key] = {}; current = current[key]; }
  if (next === undefined) delete current[keys.at(-1)!]; else current[keys.at(-1)!] = next;
}
export function parseValue(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
function render(template: string, msg: Message) { return template.replace(/{{\s*msg\.([\w.]+)\s*}}/g, (_, path) => String(getPath(msg, path) ?? '')); }

export const handlers: Record<string, NodeHandler> = {
  inject: (msg, ctx) => ctx.send(0, msg),
  'http-in': (msg, ctx) => ctx.send(0, msg),
  'email-in': (msg, ctx) => ctx.send(0, msg),
  continue: (msg, ctx) => ctx.send(0, msg),
  debug: (msg, ctx) => ctx.log(ctx.config.complete ? 'Complete message' : 'Payload', ctx.config.complete ? msg : msg.payload, 'debug'),
  'http-response': (msg, ctx) => { if (!msg._requestId) throw new Error('HTTP Response requires an HTTP In request'); ctx.respond(msg._requestId, Number(msg.statusCode ?? ctx.config.status ?? 200), msg.payload, msg.headers); },
  'email-out': emailOutHandler,
  function: async (msg, ctx) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('msg', 'context', 'send', 'log', 'getSecret', String(ctx.config.code ?? 'return msg;'));
    const result = await run(msg, ctx.context, (port: number, value: Message) => ctx.send(port, value), (value: unknown) => ctx.log('Function', value), ctx.getSecret);
    if (result !== null && result !== undefined) ctx.send(0, result);
  },
  change: (msg, ctx) => { setPath(msg, String(ctx.config.property || 'payload'), ctx.config.operation === 'delete' ? undefined : parseValue(ctx.config.value)); ctx.send(0, msg); },
  switch: (msg, ctx) => {
    const actual = getPath(msg, String(ctx.config.property || 'payload')); const expected: any = parseValue(ctx.config.value);
    const matches = ({ equals: () => actual === expected, 'not equals': () => actual !== expected, 'greater than': () => actual > expected, 'less than': () => actual < expected, contains: () => String(actual).includes(String(expected)), exists: () => actual !== undefined } as Record<string, () => boolean>)[ctx.config.operator]?.() ?? false;
    ctx.send(matches ? 0 : 1, msg);
  },
  template: (msg, ctx) => { msg.payload = render(String(ctx.config.template ?? ''), msg); ctx.send(0, msg); },
  json: (msg, ctx) => { msg.payload = ctx.config.action === 'stringify' ? JSON.stringify(msg.payload) : JSON.parse(String(msg.payload)); ctx.send(0, msg); },
  delay: async (msg, ctx) => { await Bun.sleep(Math.max(0, Math.min(Number(ctx.config.milliseconds) || 0, 300000))); ctx.send(0, msg); },
  'http-request': async (msg, ctx) => {
    const method = String(ctx.config.method || 'GET').toUpperCase(); const url = render(String(ctx.config.url || ''), msg);
    const response = await fetch(url, { method, headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : undefined, body: ['GET', 'HEAD'].includes(method) ? undefined : typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload ?? null), signal: AbortSignal.timeout(30000) });
    const body = await response.text(); msg.statusCode = response.status; msg.payload = parseValue(body); ctx.send(0, msg);
  },
};
