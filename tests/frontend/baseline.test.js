// @vitest-environment node

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { hideLoading, showLoading } from '../../assets/js/utils.js';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function createLoadingHarness() {
  const dom = new JSDOM(indexHtml);
  const document = dom.window.document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  return { dom, document, showLoading, hideLoading };
}

describe('frontend production baseline', () => {
  it('updates and toggles the addressable loading overlay', () => {
    const { document, showLoading, hideLoading } = createLoadingHarness();
    const loadingText = document.querySelector('#loading-text');
    const loadingOverlay = document.querySelector('#loading-overlay');

    showLoading('正在开单...');
    expect(loadingText.textContent).toBe('正在开单...');
    expect(loadingOverlay.classList.contains('show')).toBe(true);
    expect(loadingOverlay.getAttribute('aria-busy')).toBe('true');

    hideLoading();
    expect(loadingOverlay.classList.contains('show')).toBe(false);
    expect(loadingOverlay.getAttribute('aria-busy')).toBe('false');
  });

  it('orders loading DOM mutations around the text update', () => {
    const { dom, document, showLoading, hideLoading } = createLoadingHarness();
    const loadingText = document.querySelector('#loading-text');
    const loadingOverlay = document.querySelector('#loading-overlay');
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(loadingOverlay, { attributes: true, childList: true, subtree: true });

    showLoading('正在开单...');
    const showMutations = observer.takeRecords().map((mutation) => {
      if (mutation.target === loadingText) return 'text';
      if (mutation.attributeName === 'class') return 'visible';
      if (mutation.attributeName === 'aria-busy') return 'busy';
      return 'unknown';
    });
    expect(showMutations).toEqual(['visible', 'busy', 'text']);

    hideLoading();
    const hideMutations = observer.takeRecords().map((mutation) => {
      if (mutation.attributeName === 'aria-busy') return 'idle';
      if (mutation.attributeName === 'class') return 'hidden';
      return 'unknown';
    });
    expect(hideMutations).toEqual(['idle', 'hidden']);
    observer.disconnect();
  });
});
