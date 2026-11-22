/**
 * @vitest-environment node
 */
import { resolve } from 'node:path';

import { type Browser, chromium, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type * as classicMermaid from './classic-mermaid';

let server: ViteDevServer;
let serverUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve('.'),
    cacheDir: '.local/mermaid-integration-cache',
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
    plugins: [
      {
        name: 'mermaid-test-page',
        configureServer(server) {
          server.middlewares.use('/mermaid-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(
              '<!doctype html><html><body><main id="preview"></main></body></html>'
            );
          });
        },
      },
    ],
  });
  await server.listen();
  serverUrl = server.resolvedUrls!.local[0] + 'mermaid-test';
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function render(page: Page, theme: 'default' | 'dark', code: string) {
  return page.evaluate(
    async ({ theme, code }) => {
      const browserImport = new Function('url', 'return import(url)') as <T>(
        url: string
      ) => Promise<T>;
      const { renderClassicMermaidSvg } = await browserImport<
        typeof classicMermaid
      >(
        '/packages/frontend/core/src/modules/code-block-preview-renderer/classic-mermaid.ts'
      );
      const { sanitizeSvg } = await browserImport<{
        sanitizeSvg(svg: string): string;
      }>('/blocksuite/affine/shared/src/utils/svg.ts');
      const { svg } = await renderClassicMermaidSvg({
        code,
        options: { theme },
      });
      const sanitized = sanitizeSvg(svg);
      const preview = document.querySelector('#preview')!;
      preview.innerHTML = sanitized;
      document.body.style.background = theme === 'dark' ? '#141414' : '#ffffff';
      const luminance = (color: string) => {
        const rgb = (color.match(/[\d.]+/g) ?? [])
          .slice(0, 3)
          .map(Number)
          .map(v => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const nodes = [...preview.querySelectorAll('.node')].map(node => {
        const shape = node.querySelector(
          'rect, polygon, circle, ellipse, path'
        )!;
        const label = [...node.querySelectorAll('text,tspan')].find(
          text => !!text.textContent?.trim()
        )!;
        const fill = getComputedStyle(shape).fill;
        const textFill = getComputedStyle(label).fill;
        const [dark, light] = [luminance(fill), luminance(textFill)].sort(
          (a, b) => a - b
        );
        return {
          label: label.textContent,
          fill,
          textFill,
          contrast: (light + 0.05) / (dark + 0.05),
        };
      });
      const edges = [...preview.querySelectorAll('.flowchart-link')].map(
        edge => getComputedStyle(edge).stroke
      );
      return { sanitized, nodes, edges };
    },
    { theme, code }
  );
}

describe('mermaid preview integration', () => {
  test('local SVG resources stay allowed while external and obscured CSS resources are removed', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(serverUrl);
      const results = await page.evaluate(async () => {
        const browserImport = new Function('url', 'return import(url)') as (
          url: string
        ) => Promise<{ sanitizeSvg(svg: string): string }>;
        const { sanitizeSvg } = await browserImport(
          '/blocksuite/affine/shared/src/utils/svg.ts'
        );
        return [
          'url(#gradient)',
          'url(https://example.com/track)',
          'url(//example.com/track)',
          'url(/api/private)',
          'url(data:image/svg+xml;base64,AAAA)',
          'url(#safe); stroke: url(https://example.com/track)',
          String.raw`u\72l(https://example.com/track)`,
          'url(/* disguised */#safe)',
          '@import "https://example.com/styles.css"',
        ].map(value =>
          sanitizeSvg(
            `<svg xmlns="http://www.w3.org/2000/svg"><style>.node {fill: ${value};}</style><rect class="node" style="fill: ${value.replaceAll('"', '&quot;')};" /></svg>`
          )
        );
      });
      expect(results[0]).toContain('<style>');
      expect(results[0]).toContain('style="');
      for (const unsafe of results.slice(1)) {
        expect(unsafe).not.toContain('<style');
        expect(unsafe).not.toContain('style=');
      }
    } finally {
      await page.close();
    }
  });

  test('actual renderer and sanitizer preserve readable nodes and edges across theme changes', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(serverUrl);
      // Ordinary Mermaid source, as stored by a fenced Markdown/MCP document.
      const code =
        'graph LR\n A[Capture] --> B[Evaluation]\n A --> C[Recognition]\n B --> D[Review]';
      for (const theme of ['default', 'dark', 'default'] as const) {
        const result = await render(page, theme, code);
        expect(result.sanitized).toContain('<style>');
        expect(result.nodes.map(node => node.label)).toEqual([
          'Capture',
          'Evaluation',
          'Recognition',
          'Review',
        ]);
        expect(result.nodes.every(node => node.contrast >= 4.5)).toBe(true);
        expect(result.edges).toHaveLength(3);
        expect(
          result.edges.every(
            stroke => stroke !== 'none' && stroke !== 'rgb(0, 0, 0)'
          )
        ).toBe(true);
        expect(result.nodes[0].fill).toBe(
          theme === 'dark' ? 'rgb(31, 32, 32)' : 'rgb(236, 236, 255)'
        );
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  test('explicit light-node styling retains dark text in dark mode', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(serverUrl);
      const result = await render(
        page,
        'dark',
        'graph LR\n A[Readable] --> B[Also readable]\n classDef light fill:#fff,color:#111,stroke:#777\n class A,B light'
      );
      expect(result.nodes.every(node => node.contrast >= 4.5)).toBe(true);
      expect(
        result.nodes.every(node => node.fill === 'rgb(255, 255, 255)')
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
