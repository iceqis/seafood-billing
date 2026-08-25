import { createElement } from '../utils.js';
import { createPageFactory, makeInput } from './factory.js';

const STATUS = {
  pending_ship: ['待发货', 'status-pending_ship'],
  shipped: ['已发货', 'status-shipped'],
  pending_bill: ['未开单', 'status-pending_bill'],
  unsettled: ['未结算', 'status-unsettled'],
  settled: ['已结算', 'status-settled']
};

function textLine(className, value) { return createElement('div', { className }, value ?? ''); }

export function renderOrdersList(container, orders, handlers = {}) {
  while (container.firstChild) container.removeChild(container.firstChild);
  orders.filter((order) => order.status === 'pending_ship' || order.status === 'shipped').forEach((order) => {
    const card = createElement('div', { className: 'list-item order-card' });
    const content = createElement('div', { className: 'flex-1' });
    content.append(textLine('font-bold', order.customer));
    content.append(textLine('text-sm text-gray', `${order.product || ''} ${order.spec || ''}`));
    content.append(textLine('text-sm text-gray', `报货 ${order.orderWeight ?? 0}斤 · 实收 ${order.actualWeight ?? 0}斤`));
    const [statusText, statusClass] = STATUS[order.status] || [order.status || '未知', ''];
    content.append(createElement('span', { className: `status-tag ${statusClass}` }, statusText));
    card.append(content);
    const actions = createElement('div', { className: 'action-group' });
    if (order.status === 'pending_ship') {
      const button = createElement('button', { className: 'btn btn-orange btn-sm', type: 'button' }, '去发货');
      button.addEventListener('click', () => handlers.onShip?.(order));
      actions.append(button);
    } else if (order.status === 'shipped') {
      const button = createElement('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, '去定价');
      button.addEventListener('click', () => handlers.onPrice?.(order));
      actions.append(button);
    }
    card.append(actions);
    container.append(card);
  });
}

export function createOrdersPage(deps) {
  const page = createPageFactory(deps);
  let orders = [];
  let selectedDate = '';

  async function load() {
    const search = page.byId('order-search').value.trim();
    const query = new URLSearchParams();
    if (selectedDate) query.set('date', selectedDate);
    query.set('status', 'pending_ship,shipped');
    if (search) query.set('search', search);
    orders = await page.api.get(`/api/orders${query.toString() ? `?${query}` : ''}`) || [];
    render();
  }

  function render() {
    const search = page.byId('order-search').value.trim().toLowerCase();
    const filtered = orders.filter((order) => !search || `${order.customer} ${order.product}`.toLowerCase().includes(search));
    renderOrdersList(page.byId('orders-list'), filtered, { onShip: openShip, onPrice: openPrice });
  }

  function openShip(order) {
    const field = makeInput('实际重量(斤)', 'number', order.actualWeight || order.orderWeight || '');
    const input = field.input;
    const body = createElement('div'); body.append(field.wrapper);
    page.showModal('确认发货', body, [
      { label: '取消', className: 'btn btn-secondary', onClick: page.closeModal },
      { label: '确认发货', className: 'btn btn-primary', onClick: async () => {
        await page.api.put(`/api/orders/${encodeURIComponent(order.id)}/ship`, { actualWeight: Number(input.value) });
        page.closeModal(); await load(); await page.onStats?.();
      } }
    ]);
  }

  function openPrice(order) {
    const field = makeInput('单价(元/斤)', 'number', order.price || '');
    const input = field.input;
    const body = createElement('div'); body.append(field.wrapper);
    page.showModal('确认定价', body, [
      { label: '取消', className: 'btn btn-secondary', onClick: page.closeModal },
      { label: '确认定价', className: 'btn btn-primary', onClick: async () => {
        await page.api.put(`/api/orders/${encodeURIComponent(order.id)}/price`, { price: Number(input.value) });
        page.closeModal(); await load(); await page.onStats?.();
      } }
    ]);
  }

  function bind() {
    page.byId('order-search').addEventListener('input', render);
    page.byId('order-date').addEventListener('change', () => { selectedDate = page.byId('order-date').value; load(); });
    page.byId('page-orders').querySelector('.card-header .btn')?.addEventListener('click', () => page.navigate('preorder'));
  }

  bind();
  return { enter: async () => { selectedDate = page.byId('order-date').value || page.today(); page.byId('order-date').value = selectedDate; await page.run(load); }, render, load };
}
