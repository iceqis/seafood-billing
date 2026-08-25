import { describe, expect, it, vi } from 'vitest';
import {
  createElement,
  formatMoney,
  getLocalDate,
  hideLoading,
  setText,
  showLoading,
  showToast
} from '../../assets/js/utils.js';

describe('frontend utils', () => {
  it('formats finite money values consistently', () => {
    expect(formatMoney(5)).toBe('¥5.00');
    expect(formatMoney(5.126)).toBe('¥5.13');
    expect(formatMoney(Number.NaN)).toBe('¥0.00');
    expect(formatMoney(Infinity)).toBe('¥0.00');
  });

  it('uses the local calendar date', () => {
    expect(getLocalDate(new Date(2026, 7, 23, 1))).toBe('2026-08-23');
  });

  it('renders business text without interpreting HTML', () => {
    const element = document.createElement('div');
    setText(element, '<img src=x onerror=alert(1)>');
    expect(element.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(element.querySelector('img')).toBeNull();
  });

  it('creates safe elements and controls loading/toast text through textContent', () => {
    const element = createElement('button', {
      className: 'btn', type: 'button', textContent: '属性文本'
    });
    expect(element.tagName).toBe('BUTTON');
    expect(element.className).toBe('btn');
    expect(element.textContent).toBe('属性文本');
    expect(element.querySelector('b')).toBeNull();
    expect(createElement('div', { textContent: '属性文本' }, '<b>第三参数优先</b>').textContent)
      .toBe('<b>第三参数优先</b>');

    document.body.innerHTML = '<div id="loading-overlay"><span id="loading-text"></span></div><div id="toast"></div>';
    showLoading('<img>加载中');
    expect(document.getElementById('loading-text').textContent).toBe('<img>加载中');
    expect(document.getElementById('loading-overlay').classList.contains('show')).toBe(true);
    hideLoading();
    expect(document.getElementById('loading-overlay').classList.contains('show')).toBe(false);
    vi.useFakeTimers();
    showToast('第一条', 'success', 1000);
    vi.advanceTimersByTime(999);
    showToast('第二条', 'success', 2000);
    vi.advanceTimersByTime(1);
    expect(document.getElementById('toast').textContent).toBe('第二条');
    expect(document.getElementById('toast').classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(document.getElementById('toast').textContent).toBe('第二条');
    expect(document.getElementById('toast').classList.contains('show')).toBe(false);
    vi.useRealTimers();
  });
});
