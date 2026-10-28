import { describe, expect, test } from 'bun:test';
import { normalizeWorkflowTags, sameDeploymentContent, type Workflow } from './shared';

const flow: Workflow = {
  id: 'flow-1', name: 'Example', description: '', tags: [], updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [{ id: 'node-1', type: 'workflow', position: { x: 0, y: 0 }, data: { nodeType: 'debug', config: { complete: false } } }],
  edges: [],
};

describe('workflow metadata', () => {
  test('normalizes and deduplicates tags', () => {
    expect(normalizeWorkflowTags([' Blue ', 'blue', 'red  tag', '', 'Green'])).toEqual(['Blue', 'red tag', 'Green']);
  });

  test('redeploy comparison ignores timestamps and unchanged optional metadata', () => {
    expect(sameDeploymentContent(flow, { ...flow, description: undefined, tags: undefined, updatedAt: '2026-01-02T00:00:00.000Z', deployedAt: '2026-01-02T00:00:00.000Z' })).toBe(true);
    expect(sameDeploymentContent(flow, { ...flow, tags: ['production'] })).toBe(false);
    expect(sameDeploymentContent(flow, { ...flow, nodes: [{ ...flow.nodes[0], data: { ...flow.nodes[0].data, config: { complete: true } } }] })).toBe(false);
  });
});
