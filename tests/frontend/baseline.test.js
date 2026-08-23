// @vitest-environment node

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const indexDocument = new JSDOM(indexHtml).window.document;

describe('frontend production baseline', () => {
  it('provides an addressable loading-text element', () => {
    expect(indexDocument.querySelector('#loading-text')).not.toBeNull();
  });
});
