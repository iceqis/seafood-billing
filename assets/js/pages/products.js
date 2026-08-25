import { createElement } from '../utils.js';
import { createPageFactory, makeInput } from './factory.js';

export function renderProductsList(container, products, onDelete) {
  while (container.firstChild) container.removeChild(container.firstChild);
  (products || []).forEach((product) => {
    const row = createElement('div', { className: 'list-item' }); const info = createElement('div', { className: 'flex-1' });
    info.append(createElement('div', { className: 'font-bold' }, product.name)); info.append(createElement('div', { className: 'text-sm text-gray' }, product.specs || ''));
    const remove = createElement('button', { className: 'btn btn-danger btn-sm', type: 'button' }, '删除'); remove.addEventListener('click', () => onDelete?.(product.name)); row.append(info, remove); container.append(row);
  });
}

export function createProductsPage(deps) {
  const page = createPageFactory(deps); let products = [];
  async function load() { products = await page.api.get('/api/products') || []; render(); }
  function render() {
    renderProductsList(page.byId('products-list'), products, removeProduct);
  }
  async function removeProduct(name) { if (!window.confirm(`确定删除商品“${name}”？`)) return; await page.api.delete(`/api/products/${encodeURIComponent(name)}`); await load(); }
  function addProduct() {
    const name = makeInput('商品名称'); const specs = makeInput('规格（用逗号分隔）'); const body = createElement('div'); body.append(name.wrapper, specs.wrapper);
    page.showModal('添加商品', body, [{ label: '取消', className: 'btn btn-secondary', onClick: page.closeModal }, { label: '确认添加', className: 'btn btn-primary', onClick: async () => { await page.api.post('/api/products', { name: name.input.value.trim(), specs: specs.input.value.trim() }); page.closeModal(); await load(); } }]);
  }
  page.byId('page-products').querySelector('.card-header .btn')?.addEventListener('click', addProduct);
  return { enter: () => page.run(load), render };
}
