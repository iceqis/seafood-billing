import { createElement, setText, showLoading, hideLoading, showToast } from '../utils.js';

export function createPageFactory(deps) {
  const byId = (id) => document.getElementById(id);
  const clear = (node) => { while (node?.firstChild) node.removeChild(node.firstChild); };
  const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const money = (value) => `¥${safeNumber(value).toFixed(2)}`;

  function addButton(parent, label, className, handler) {
    const button = createElement('button', { className, type: 'button' }, label);
    let inFlight = false;
    button.addEventListener('click', () => {
      if (inFlight) return;
      inFlight = true; button.disabled = true;
      Promise.resolve().then(handler).catch(error).finally(() => { inFlight = false; button.disabled = false; });
    });
    parent.append(button);
    return button;
  }

  function showModal(title, body, actions = []) {
    setText(byId('modal-title'), title);
    const modalBody = byId('modal-body');
    const modalFooter = byId('modal-footer');
    clear(modalBody); clear(modalFooter);
    modalBody.append(body);
    actions.forEach(({ label, className, onClick }) => addButton(modalFooter, label, className, onClick));
    byId('modal-overlay').classList.add('show');
  }

  function closeModal() { byId('modal-overlay').classList.remove('show'); }
  function error(error) {
    if (error?.name === 'RequestCancelled' || error?.reported) return;
    (deps.showToast || showToast)(error?.message || '操作失败', 'error');
  }
  function run(task) {
    showLoading('加载中...');
    return Promise.resolve().then(task).catch((err) => { error(err); throw err; }).finally(hideLoading);
  }

  return { ...deps, byId, clear, safeNumber, money, addButton, showModal, closeModal, error, run, setText };
}

export function makeInput(label, type = 'text', value = '') {
  const wrapper = createElement('label', { className: 'form-group' });
  wrapper.append(createElement('span', { className: 'form-label' }, label));
  wrapper.append(createElement('input', { className: 'form-input', type, value }));
  return { wrapper, input: wrapper.querySelector('input') };
}
