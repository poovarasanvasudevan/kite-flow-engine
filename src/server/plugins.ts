import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { NodeDefinition, NodeHandler, NodeStarter } from '../shared';
import { Engine } from './engine';

export type CustomNode = { definition: NodeDefinition; code: string };
export class PluginManager {
  custom: CustomNode[] = [];
  packages: { name: string; version: string; types: string[]; builtIn: boolean }[] = [];
  constructor(public engine: Engine, public dataDir: string, public pluginDir: string) {}
  async initialize() {
    await mkdir(this.dataDir, { recursive: true }); await mkdir(this.pluginDir, { recursive: true });
    try { this.custom = JSON.parse(await readFile(join(this.dataDir, 'custom-nodes.json'), 'utf8')); } catch { this.custom = []; }
    for (const node of this.custom) this.registerCustom(node);
    await this.loadPackages();
  }
  registerCustom(node: CustomNode) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const body = new AsyncFunction('msg', 'context', 'send', 'log', 'config', 'getSecret', node.code);
    const handler: NodeHandler = async (message, context) => {
      const result = await body(message, context.context, (port: number, value: unknown) => context.send(port, value as any), (value: unknown) => context.log('Custom node', value), context.config, context.getSecret);
      if (result !== null && result !== undefined) context.send(0, result);
    };
    this.engine.register({ ...node.definition, source: 'custom' }, handler);
  }
  async addCustom(node: CustomNode) {
    if (!node.definition.type.startsWith('custom-')) throw new Error('Custom node type must start with custom-');
    if (!node.code.trim()) throw new Error('JavaScript body is required');
    if (!node.definition.label || !Array.isArray(node.definition.fields) || !node.definition.fields.every(field => field.key && field.label && ['text', 'textarea', 'number', 'boolean', 'select', 'json', 'code'].includes(field.type))) throw new Error('Invalid node editor fields');
    if (!Number.isInteger(node.definition.outputs) || node.definition.outputs < 0 || node.definition.outputs > 8) throw new Error('Outputs must be between 0 and 8');
    this.registerCustom(node); this.custom.push(node);
    await writeFile(join(this.dataDir, 'custom-nodes.json'), JSON.stringify(this.custom, null, 2));
  }
  async removeCustom(type: string) {
    if (!this.custom.some(item => item.definition.type === type)) throw new Error('Custom node not found');
    for (const flow of this.engine.deployed.values()) if (flow.nodes.some(node => node.data.nodeType === type)) throw new Error('Stop workflows using this node before deleting it');
    this.custom = this.custom.filter(item => item.definition.type !== type); this.engine.unregister(type);
    await writeFile(join(this.dataDir, 'custom-nodes.json'), JSON.stringify(this.custom, null, 2));
  }
  async loadPackages() {
    this.packages = [];
    let manifest: { dependencies?: Record<string, string> };
    try { manifest = JSON.parse(await readFile(join(this.pluginDir, 'package.json'), 'utf8')); }
    catch { manifest = { dependencies: {} }; await writeFile(join(this.pluginDir, 'package.json'), JSON.stringify({ name: 'wflow-plugins', private: true, dependencies: {} }, null, 2)); }
    const require = createRequire(join(this.pluginDir, 'package.json'));
    const builtInPaths = [
      join(this.pluginDir, 'bundled', 'file-csv', 'package.json'),
      join(this.pluginDir, 'bundled', 'exec-ssh', 'package.json'),
      join(this.pluginDir, 'bundled', 'websocket', 'package.json'),
      join(this.pluginDir, 'bundled', 'openai', 'package.json'),
      join(this.pluginDir, 'bundled', 'redis', 'package.json'),
    ];
    const packagePaths = [
      ...builtInPaths,
      ...Object.keys(manifest.dependencies || {}).map(name => join(this.pluginDir, 'node_modules', name, 'package.json')),
    ];
    for (const packagePath of packagePaths) {
      let name = packagePath;
      try {
        const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
        name = packageJson.name;
        if (!packageJson.wflow?.entry) continue;
        const module = require(join(packagePath, '..', packageJson.wflow.entry));
        const nodes = module.nodes ?? module.default?.nodes;
        if (!Array.isArray(nodes)) throw new Error('Plugin must export a nodes array');
        if (nodes.some(node => !node.definition || typeof node.run !== 'function' || (node.start !== undefined && (typeof node.start !== 'function' || node.definition.inputs !== 0)))) throw new Error('Invalid node export');
        const types: string[] = [];
        for (const node of nodes) {
          if (this.engine.definitions.get(node.definition.type)?.source === name) this.engine.unregister(node.definition.type);
          this.engine.register({ ...node.definition, source: name }, node.run as NodeHandler, node.start as NodeStarter | undefined); types.push(node.definition.type);
        }
        this.packages.push({ name, version: packageJson.version, types, builtIn: builtInPaths.includes(packagePath) });
      } catch (error) { this.engine.log('error', `Plugin ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  async install(spec: string) {
    if (!/^(?:@[-\w]+\/)?[-\w.]+(?:@(?:\d+\.\d+\.\d+(?:[-\w.]*)?|latest))?$/.test(spec)) throw new Error('Enter an npm package name with an optional version');
    const proc = Bun.spawn(['bun', 'add', spec], { cwd: this.pluginDir, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error((err || out).slice(-1000));
    await this.loadPackages();
    const name = spec.startsWith('@') ? spec.split('@').slice(0, 2).join('@') : spec.split('@')[0];
    if (!this.packages.some(item => item.name === name)) throw new Error('Package installed, but no valid wflow nodes were found');
    return this.packages.find(item => item.name === name);
  }
}
