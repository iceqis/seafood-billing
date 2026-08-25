import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(`${process.cwd()}/${path}`, 'utf8');

describe('frontend extracted assets', () => {
  it('loads the four stylesheets in cascade order without an inline style block', () => {
    const html = read('index.html');
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
    expect(links).toEqual([
      './assets/css/base.css',
      './assets/css/components.css',
      './assets/css/pages.css',
      './assets/css/responsive.css'
    ]);
    expect(html).not.toContain('<style>');
  });

  it('loads one external ES module entry without inline business scripts or page modules', () => {
    const html = read('index.html');
    expect(html.match(/<script\b/g) || []).toHaveLength(1);
    expect(html).toContain('<script type="module" src="./assets/js/app.js"></script>');
    expect(html).not.toMatch(/<script(?:\s[^>]*)?>[\s\S]*?function\s+\w+/);
    expect(() => read('assets/js/app.js')).not.toThrow();
    expect(() => read('assets/js/auth.js')).not.toThrow();
    expect(() => read('assets/js/pages/home.js')).toThrow();
  });

  it('keeps key rules in their extracted layers and isolates media queries', () => {
    const base = read('assets/css/base.css');
    const components = read('assets/css/components.css');
    const pages = read('assets/css/pages.css');
    const responsive = read('assets/css/responsive.css');

    expect(base).toContain('box-sizing: border-box');
    expect(base).toContain('/* 工具类 */');
    expect(base).toContain('.flex { display: flex; }');
    expect(base).toContain('.opacity-60 { opacity: 0.6; }');
    expect(components).not.toContain('/* 工具类 */');
    expect(components).not.toContain('.flex { display: flex; }');
    expect(components).not.toContain('.opacity-60 { opacity: 0.6; }');
    expect(components).toContain('.btn');
    expect(pages).toContain('.page-section');
    expect(responsive).toContain('@media');
    expect(base).not.toContain('@media');
    expect(components).not.toContain('@media');
    expect(pages).not.toContain('@media');
  });
});
