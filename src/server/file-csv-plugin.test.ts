import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Engine } from './engine';
import { PluginManager } from './plugins';

const require = createRequire(import.meta.url);
const plugin = require(resolve(import.meta.dir, '../../plugins/bundled/file-csv/index.cjs'));
const temporary = await mkdtemp(join(tmpdir(), 'wflow-file-csv-'));
const previous = process.env.WFLOW_FILES_DIR;
process.env.WFLOW_FILES_DIR = temporary;
afterAll(async () => {
  if (previous === undefined) delete process.env.WFLOW_FILES_DIR;
  else process.env.WFLOW_FILES_DIR = previous;
  await rm(temporary, { recursive: true, force: true });
});

async function run(type: string, message: Record<string, unknown>, config: Record<string, unknown>) {
  const node = plugin.nodes.find((item: any) => item.definition.type === type);
  const sent: Record<string, unknown>[] = [];
  await node.run(message, { config, send: (_port: number, value: Record<string, unknown>) => sent.push(value) });
  return sent[0];
}

test('bundled file and CSV package loads into the engine', async () => {
  const engine = new Engine();
  const manager = new PluginManager(engine, temporary, resolve(import.meta.dir, '../../plugins'));
  await manager.initialize();
  expect(manager.packages.find(item => item.name === '@wflow/file-csv')?.types).toEqual(['file-read', 'file-write', 'csv-parser']);
  expect(engine.definitions.get('csv-parser')?.source).toBe('@wflow/file-csv');
});

test('file write, read, and CSV parser work together', async () => {
  const csv = 'name,note\r\nAda,"a,b"\r\nLin,"line 1\nline 2"\r\n';
  const written = await run('file-write', { payload: csv, filename: 'sample.csv' }, { path: 'sub/{{msg.filename}}', createDirectories: true });
  expect(written.file).toEqual({ path: join('sub', 'sample.csv'), bytes: Buffer.byteLength(csv), operation: 'write' });
  expect(await readFile(join(temporary, 'sub', 'sample.csv'), 'utf8')).toBe(csv);
  const read = await run('file-read', { filename: 'sample.csv' }, { path: 'sub/{{msg.filename}}', mode: 'text' });
  expect(read.payload).toBe(csv);
  const parsed = await run('csv-parser', read, { delimiter: ',', headers: true, skipEmptyLines: true });
  expect(parsed.payload).toEqual([{ name: 'Ada', note: 'a,b' }, { name: 'Lin', note: 'line 1\nline 2' }]);
});

test('file paths cannot leave the configured files directory', async () => {
  expect(run('file-read', {}, { path: '../outside.txt' })).rejects.toThrow('stay within');
  expect(run('file-write', { payload: 'x' }, { path: '../outside.txt' })).rejects.toThrow('stay within');
});

test('CSV parser rejects malformed quoting and column counts', () => {
  expect(() => plugin.parseCsv('name\n"unfinished')).toThrow('Unclosed');
  expect(() => plugin.parseCsv('a,b\n1')).toThrow('columns');
  expect(plugin.parseCsv('a;b\n1;2', ';', false)).toEqual([['a', 'b'], ['1', '2']]);
  expect(plugin.parseCsv('""\n\nvalue', ',', false)).toEqual([[''], ['value']]);
});
