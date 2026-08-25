export function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatMoney(value) {
  const number = Number(value);
  return `¥${(Number.isFinite(number) ? number : 0).toFixed(2)}`;
}

export function setText(element, value) {
  element.textContent = String(value ?? '');
  return element;
}

export function createElement(tagName, attributes = {}, text = undefined) {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (name === 'className') element.className = String(value);
    else if (name === 'textContent') element.textContent = String(value);
    else if (/^(id|title|type|name|value|aria-[\w-]+|data-[\w-]+)$/.test(name)) {
      element.setAttribute(name, String(value));
    }
  }
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

export function showLoading(text = '正在处理...') {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('show');
  overlay.setAttribute('aria-busy', 'true');
  const label = document.getElementById('loading-text');
  if (label) setText(label, text);
}

export function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-busy', 'false');
  overlay.classList.remove('show');
}

let toastTimer = null;

export function showToast(message, type = 'success', durationMs = 2500) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer !== null) clearTimeout(toastTimer);
  setText(toast, message);
  toast.className = `toast show toast-${type}`;
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toastTimer = null;
  }, durationMs);
}
