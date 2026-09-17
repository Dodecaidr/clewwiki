import { CHART_EXAMPLES, chartExampleBlock } from '@clewwiki/content/chart';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';

import { renderMarkdown, sanitizeSchema } from '@/lib/pages/markdown';

describe('callouts', () => {
  it.each([
    ['NOTE', 'callout-note', 'Note'],
    ['TIP', 'callout-tip', 'Tip'],
    ['IMPORTANT', 'callout-important', 'Important'],
    ['WARNING', 'callout-warning', 'Warning'],
    ['CAUTION', 'callout-caution', 'Caution'],
  ])('renders > [!%s] as a styled callout', async (kind, className, title) => {
    const html = await renderMarkdown(`> [!${kind}]\n> Claims expire after **ten** minutes.`);
    expect(html).toContain(`<div class="callout ${className}">`);
    expect(html).toContain(`<p class="callout-title">${title}</p>`);
    expect(html).toContain('<p>Claims expire after <strong>ten</strong> minutes.</p>');
    expect(html).not.toContain('[!');
    expect(html).not.toContain('<blockquote>');
  });

  it('accepts the marker in any case and uses translated titles', async () => {
    const html = await renderMarkdown('> [!warning]\n> Осторожно', { callouts: { WARNING: 'Внимание' } });
    expect(html).toContain('<p class="callout-title">Внимание</p>');
  });

  it('leaves an ordinary quote, and an unknown marker, as a blockquote', async () => {
    expect(await renderMarkdown('> just a quote')).toContain('<blockquote>');
    expect(await renderMarkdown('> [!NOPE]\n> text')).toContain('<blockquote>');
    expect(await renderMarkdown('> [!NOTE] inline text')).toContain('<blockquote>');
  });
});

describe('chart blocks', () => {
  it('renders a valid chart as inline SVG with its title and description', async () => {
    const html = await renderMarkdown(chartExampleBlock('bar'));
    expect(html).toContain('<div class="chart-block"><svg class="chart chart-bar" viewBox="0 0 640 360" role="img">');
    expect(html).toContain(`<title>${CHART_EXAMPLES.bar.title}</title>`);
    expect(html).toContain('<desc>');
    expect(html).not.toContain('language-chart');
    // An inline SVG in HTML needs no namespace, and the export must reference nothing outside itself.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('keeps the presentation attributes and classes the stylesheet relies on', async () => {
    const html = await renderMarkdown(chartExampleBlock('line'));
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('stroke-linejoin="round"');
    expect(html).toContain('class="chart-stroke-1"');
    expect(html).toContain('text-anchor="end"');
  });

  it('shows an error box naming the problem for an invalid chart', async () => {
    const html = await renderMarkdown(
      '```chart\n{"type": "bar", "x": ["a", "b"], "series": [{"name": "s", "data": [1]}]}\n```',
      { chartInvalid: 'Диаграмма с ошибкой' },
    );
    expect(html).toContain('<div class="chart-error">');
    expect(html).toContain('<strong>Диаграмма с ошибкой</strong>');
    expect(html).toContain('<code>series.0.data</code>');
    expect(html).not.toContain('<svg');
  });

  it('escapes markup written into chart labels', async () => {
    const spec = { type: 'bar', title: '<img src=x onerror=alert(1)>', x: ['<script>alert(1)</script>'], series: [{ name: 's', data: [1] }] };
    const html = await renderMarkdown(`\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&#x3C;script>');
  });

  it('renders a chart nested in a list', async () => {
    const html = await renderMarkdown(`- item\n\n  ${chartExampleBlock('pie').split('\n').join('\n  ')}`);
    expect(html).toContain('<svg class="chart chart-pie"');
  });
});

describe('sanitiser allowlist for chart SVG', () => {
  function sanitize(tree: Root): string {
    const processor = unified().use(rehypeSanitize, sanitizeSchema).use(rehypeStringify);
    return processor.stringify(processor.runSync(tree) as Root);
  }

  function svgWith(...children: Element[]): Root {
    return {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'svg',
          properties: { className: ['chart'], viewBox: '0 0 10 10', role: 'img', onLoad: 'alert(1)' },
          children,
        },
      ],
    };
  }

  const element = (tagName: string, properties: Element['properties'], children: Element['children'] = []): Element => ({
    type: 'element',
    tagName,
    properties,
    children,
  });

  it('strips script, event handlers, foreignObject, style, animation and links', () => {
    const html = sanitize(
      svgWith(
        element('script', {}, [{ type: 'text', value: 'alert(1)' }]),
        element('rect', { width: '5', height: '5', onClick: 'alert(1)', onMouseOver: 'alert(1)' }),
        element('foreignObject', {}, [element('iframe', { src: 'https://evil.example' })]),
        element('style', {}, [{ type: 'text', value: 'rect { fill: red }' }]),
        element('animate', { attributeName: 'href', to: 'javascript:alert(1)' }),
        element('set', { attributeName: 'href', to: 'javascript:alert(1)' }),
        element('a', { href: 'javascript:alert(1)' }, [element('text', { x: '1' }, [{ type: 'text', value: 'x' }])]),
        element('use', { href: 'javascript:alert(1)', xLinkHref: 'javascript:alert(1)' }),
        element('image', { href: 'https://evil.example/x.png' }),
        element('path', { d: 'M0 0', style: 'fill: url(javascript:alert(1))', className: ['evil', 'chart-fill-1'] }),
      ),
    );
    expect(html).not.toMatch(/<script|alert\(1\)|onload|onclick|onmouseover|foreignobject|iframe|<style|<animate|<set|<use|<image|javascript:|style=|evil/i);
    expect(html).toContain('<svg class="chart" viewBox="0 0 10 10" role="img">');
    expect(html).toContain('<rect width="5" height="5"></rect>');
  });

  it('refuses class names that are not the renderer\'s own', () => {
    const html = sanitize(svgWith(element('g', { className: ['callout'] }), element('g', { className: ['chart-series'] })));
    expect(html).not.toContain('callout');
    expect(html).toContain('<g class="chart-series"></g>');
  });

  it('still drops raw HTML and SVG written directly into a body', async () => {
    const html = await renderMarkdown('<svg onload="alert(1)"><script>alert(1)</script></svg>\n\n<div class="chart-block">x</div>');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('chart-block');
  });
});
