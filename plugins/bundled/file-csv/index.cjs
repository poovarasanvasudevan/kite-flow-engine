const fs = require('node:fs/promises');
const path = require('node:path');

function property(message, key) {
  return key.split('.').reduce((value, part) => value == null ? undefined : value[part], message);
}

function filePath(configured, message) {
  const base = path.resolve(process.env.WFLOW_FILES_DIR || path.join(process.env.WFLOW_DATA_DIR || 'data', 'files'));
  const template = String(configured || message.filename || '').trim();
  const name = template.replace(/{{\s*msg\.([\w.]+)\s*}}/g, (_, key) => String(property(message, key) ?? ''));
  if (!name || path.isAbsolute(name)) throw new Error('File path must be relative to the workflow files directory');
  const resolved = path.resolve(base, name);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('File path must stay within the workflow files directory');
  }
  return { base, resolved, relative };
}

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function checkReadPath(file) {
  const [base, target] = await Promise.all([fs.realpath(file.base), fs.realpath(file.resolved)]);
  if (!isInside(base, target)) throw new Error('File path must stay within the workflow files directory');
}

async function checkWritePath(file, createDirectories) {
  if (createDirectories) await fs.mkdir(path.dirname(file.resolved), { recursive: true });
  const [base, parent] = await Promise.all([fs.realpath(file.base), fs.realpath(path.dirname(file.resolved))]);
  if (!isInside(base, parent)) throw new Error('File path must stay within the workflow files directory');
  try {
    if ((await fs.lstat(file.resolved)).isSymbolicLink()) throw new Error('File Write does not follow symbolic links');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function parseCsv(source, delimiter = ',', headers = true, skipEmptyLines = true) {
  if (typeof source !== 'string') throw new Error('CSV Parser expects text in msg.payload');
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new Error('CSV delimiter must be one character other than a quote or newline');
  }
  const text = source.replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false, atStart = true, rowHasData = false;
  function finishField() { row.push(field); field = ''; atStart = true; afterQuote = false; }
  function finishRow() { finishField(); if (!skipEmptyLines || rowHasData) rows.push(row); row = []; rowHasData = false; }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
      continue;
    }
    if (char === delimiter) { rowHasData = true; finishField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow(); continue;
    }
    if (char === '"' && atStart) { quoted = true; atStart = false; rowHasData = true; continue; }
    if (afterQuote || char === '"') throw new Error(`Invalid CSV quoting near character ${i + 1}`);
    field += char; atStart = false; rowHasData = true;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  if (row.length || field !== '' || afterQuote || (text.at(-1) !== '\n' && text.at(-1) !== '\r')) finishRow();
  if (!headers || rows.length === 0) return rows;
  const names = rows.shift();
  if (new Set(names).size !== names.length) throw new Error('CSV header names must be unique');
  return rows.map((values, index) => {
    if (values.length !== names.length) throw new Error(`CSV row ${index + 2} has ${values.length} columns; expected ${names.length}`);
    return Object.fromEntries(names.map((name, column) => [name, values[column]]));
  });
}

exports.parseCsv = parseCsv;
exports.nodes = [
  {
    definition: {
      type: 'file-read', label: 'File Read', category: 'File', color: '#3262c4', icon: 'file-text',
      inputs: 1, outputs: 1, description: 'Read a UTF-8 or base64 file from the workflow files directory into msg.payload.',
      defaults: { path: '', mode: 'text' },
      fields: [
        { key: 'path', label: 'Relative path', type: 'text', placeholder: 'input/data.csv or {{msg.filename}}' },
        { key: 'mode', label: 'Read as', type: 'select', options: ['text', 'base64'] },
      ],
    },
    async run(message, context) {
      const file = filePath(context.config.path, message);
      const mode = context.config.mode || 'text';
      if (mode !== 'text' && mode !== 'base64') throw new Error('Read as must be text or base64');
      await checkReadPath(file);
      const contents = await fs.readFile(file.resolved);
      message.payload = mode === 'base64' ? contents.toString('base64') : contents.toString('utf8');
      message.file = { path: file.relative, bytes: contents.length, encoding: mode === 'text' ? 'utf8' : 'base64' };
      context.send(0, message);
    },
  },
  {
    definition: {
      type: 'file-write', label: 'File Write', category: 'File', color: '#3262c4', icon: 'file-text',
      inputs: 1, outputs: 1, description: 'Write msg.payload to a file in the workflow files directory.',
      defaults: { path: '', append: false, createDirectories: true },
      fields: [
        { key: 'path', label: 'Relative path', type: 'text', placeholder: 'output/result.txt or {{msg.filename}}' },
        { key: 'append', label: 'Append to file', type: 'boolean' },
        { key: 'createDirectories', label: 'Create directories', type: 'boolean' },
      ],
    },
    async run(message, context) {
      const file = filePath(context.config.path, message);
      const payload = message.payload;
      const contents = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
      await checkWritePath(file, context.config.createDirectories !== false);
      if (context.config.append) await fs.appendFile(file.resolved, contents, 'utf8');
      else await fs.writeFile(file.resolved, contents, 'utf8');
      message.file = { path: file.relative, bytes: Buffer.byteLength(contents), operation: context.config.append ? 'append' : 'write' };
      context.send(0, message);
    },
  },
  {
    definition: {
      type: 'csv-parser', label: 'CSV Parser', category: 'File', color: '#3262c4', icon: 'table',
      inputs: 1, outputs: 1, description: 'Parse CSV text in msg.payload into rows of objects or arrays.',
      defaults: { delimiter: ',', headers: true, skipEmptyLines: true },
      fields: [
        { key: 'delimiter', label: 'Delimiter', type: 'text', placeholder: ',' },
        { key: 'headers', label: 'First row contains headers', type: 'boolean' },
        { key: 'skipEmptyLines', label: 'Skip empty lines', type: 'boolean' },
      ],
    },
    run(message, context) {
      message.payload = parseCsv(message.payload, context.config.delimiter || ',', context.config.headers !== false, context.config.skipEmptyLines !== false);
      context.send(0, message);
    },
  },
];
