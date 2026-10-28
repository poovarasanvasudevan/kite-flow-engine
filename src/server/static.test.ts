import { describe, expect, test } from 'bun:test';
import { resolve, sep } from 'node:path';

describe('static asset resolution', () => {
  const root = process.cwd();
  const dist = resolve(root, 'dist');

  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };

  test('validates asset paths inside dist using cross-platform separator', () => {
    const assetPath = '/assets/index.js';
    const filePath = resolve(dist, `.${assetPath}`);
    const isInsideDist = filePath.startsWith(dist + sep) || filePath === dist;
    expect(isInsideDist).toBe(true);
  });

  test('detects path traversal attempts', () => {
    const maliciousPath = '/../../package.json';
    const filePath = resolve(dist, `.${maliciousPath}`);
    const isInsideDist = filePath.startsWith(dist + sep) || filePath === dist;
    expect(isInsideDist).toBe(false);
  });

  test('provides correct javascript and wasm module mime types', () => {
    expect(mime['.js']).toContain('text/javascript');
    expect(mime['.mjs']).toContain('text/javascript');
    expect(mime['.wasm']).toBe('application/wasm');
    expect(mime['.css']).toContain('text/css');
  });
});
