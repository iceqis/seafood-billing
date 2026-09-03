import { createElement } from '../utils.js';
import { createPageFactory, makeInput } from './factory.js';

export function getBillingSelection(orders, selectedIds) {
  const selected = orders.filter((order) => selectedIds.has(order.id) && (order.status === 'pending_bill' || order.status === 'unsettled'));
  return {
    selectedCount: selected.length,
    selectedAmount: selected.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    pendingBillIds: selected.filter((order) => order.status === 'pending_bill').map((order) => order.id),
    unsettledIds: selected.filter((order) => order.status === 'unsettled').map((order) => order.id)
  };
}

export function toggleSelectableOrder(selectedIds, order) {
  const next = new Set(selectedIds);
  if (order.status !== 'pending_bill' && order.status !== 'unsettled') return next;
  if (next.has(order.id)) next.delete(order.id); else next.add(order.id);
  return next;
}

export function formatBatchResult(result = {}) {
  const success = result.successCount ?? result.count ?? 0;
  const skipped = result.skippedCount ?? 0;
  const reasons = Array.isArray(result.reasons) && result.reasons.length
    ? `：${result.reasons.map((item) => typeof item === 'string' ? item : `${item.id}：${item.reason}`).join('、')}` : '';
  return `成功 ${success} 单，跳过 ${skipped} 单${reasons}`;
}

export function renderCustomerCard(customer, onOpen, onDelete) {
  const card = createElement('div', { className: 'list-item' });
  const info = createElement('div', { className: 'flex-1' });
  info.append(createElement('div', { className: 'font-bold' }, customer.name));
  info.append(createElement('div', { className: 'text-sm text-gray' }, customer.phone || ''));
  card.append(info);
  const actions = createElement('div', { className: 'action-group' });
  const open = createElement('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, '查看订单');
  open.addEventListener('click', () => onOpen(customer.name));
  const remove = createElement('button', { className: 'btn btn-danger btn-sm', type: 'button' }, '删除');
  remove.addEventListener('click', () => onDelete(customer.name));
  actions.append(open, remove); card.append(actions);
  return card;
}

export function renderCustomerList(container, customers, handlers = {}) {
  while (container.firstChild) container.removeChild(container.firstChild);
  (customers || []).forEach((customer) => container.append(renderCustomerCard(customer, handlers.onOpen, handlers.onDelete)));
}

export function createCustomersPage(deps) {
  const page = createPageFactory(deps);
  const statusText = { pending_bill: '未开单', unsettled: '未结算', settled: '已结算' };
  let customers = [];
  let customerOrders = [];
  let selectedIds = new Set();
  let currentCustomer = '';

  async function load() {
    const [customerData, orderData] = await Promise.all([
      page.api.get('/api/customers'), page.api.get('/api/orders?status=pending_bill,unsettled,settled')
    ]);
    customers = customerData || [];
    customerOrders = orderData || [];
    render();
  }
  function render() {
    const query = page.byId('customer-search').value.trim().toLowerCase();
    const list = page.byId('customers-list'); page.clear(list);
    customers.filter((customer) => !query || String(customer.name).toLowerCase().includes(query)).forEach((customer) => {
      const orders = customerOrders.filter((order) => order.customer === customer.name);
      const card = renderCustomerCard(customer, viewOrders, deleteCustomer);
      card.querySelector('.flex-1').append(createElement('div', { className: 'text-sm text-gray' }, `待开单 ${orders.filter((order) => order.status === 'pending_bill').length} · 未结算 ${orders.filter((order) => order.status === 'unsettled').length} · 未结金额 ${page.money(orders.filter((order) => order.status === 'unsettled').reduce((sum, order) => sum + Number(order.amount || 0), 0))}`));
      list.append(card);
    });
  }
  async function deleteCustomer(name) {
    if (!window.confirm(`确定删除客户“${name}”？`)) return;
    await page.api.delete(`/api/customers/${encodeURIComponent(name)}`); await load();
  }
  function addCustomer() {
    const name = makeInput('客户名称'); const phone = makeInput('联系电话'); const settlement = makeInput('结算方式'); const remark = makeInput('备注');
    const body = createElement('div'); body.append(name.wrapper, phone.wrapper, settlement.wrapper, remark.wrapper);
    page.showModal('添加客户', body, [
      { label: '取消', className: 'btn btn-secondary', onClick: page.closeModal },
      { label: '确认添加', className: 'btn btn-primary', onClick: async () => {
        await page.api.post('/api/customers', { name: name.input.value.trim(), phone: phone.input.value.trim(), settlement: settlement.input.value.trim(), remark: remark.input.value.trim() });
        page.closeModal();
        try {
          await load();
        } catch {
          page.showToast?.('客户已添加，但列表刷新失败，请刷新页面', 'warning');
        }
      } }
    ]);
  }
  async function viewOrders(name) {
    currentCustomer = name; page.byId('customer-orders-name').textContent = name;
    customerOrders = await page.api.get(`/api/orders?customer=${encodeURIComponent(name)}&status=pending_bill,unsettled,settled`) || [];
    selectedIds = new Set(); renderOrders(); page.navigate('customer-orders');
  }
  function renderOrders() {
    const list = page.byId('customer-orders-list'); page.clear(list);
    customerOrders.forEach((order) => {
      if (!['pending_bill', 'unsettled', 'settled'].includes(order.status)) return;
      const row = createElement('label', { className: 'list-item' });
      const checkbox = createElement('input', { type: 'checkbox' });
      checkbox.checked = selectedIds.has(order.id);
      checkbox.disabled = order.status === 'settled';
      checkbox.addEventListener('change', () => { selectedIds = toggleSelectableOrder(selectedIds, order); updateBar(); });
      const details = createElement('span', { className: 'flex-1' });
      details.append(createElement('div', {}, `客户 ${order.customer || ''} · ${order.product || ''} ${order.spec || ''}`));
      details.append(createElement('div', { className: 'text-sm text-gray' }, `${statusText[order.status] || ''} · 日期 ${order.date || ''} · 订单号 ${order.id || ''}`));
      details.append(createElement('div', { className: 'text-sm text-gray' }, `实际重量 ${order.actualWeight ?? 0}斤 · 单价 ${page.money(order.price)} · 金额 ${page.money(order.amount)}`));
      const edit = createElement('button', { className: 'btn btn-secondary btn-sm', type: 'button' }, '修改'); edit.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openEdit(order); }); details.append(edit);
      row.append(checkbox, details);
      row.append(createElement('span', { className: 'font-semibold' }, page.money(order.amount)));
      list.append(row);
    });
    updateBar();
  }
  function openEdit(order) {
    const weight = makeInput('实际重量(斤)', 'number', order.actualWeight || ''); const price = makeInput('单价(元/斤)', 'number', order.price || ''); const body = createElement('div'); body.append(weight.wrapper, price.wrapper);
    page.showModal('修改订单', body, [{ label: '取消', className: 'btn btn-secondary', onClick: page.closeModal }, { label: '保存修改', className: 'btn btn-primary', onClick: async () => { await page.api.put(`/api/orders/${encodeURIComponent(order.id)}`, { actualWeight: Number(weight.input.value), price: Number(price.input.value), status: 'pending_bill' }); page.closeModal(); await viewOrders(currentCustomer); await page.onStats?.(); } }]);
  }
  function updateBar() {
    const selection = getBillingSelection(customerOrders, selectedIds);
    page.byId('billing-bar').style.display = selection.selectedCount ? 'flex' : 'none';
    page.setText(page.byId('selected-count'), selection.selectedCount);
    page.setText(page.byId('selected-amount'), page.money(selection.selectedAmount));
  }
  async function batch(kind) {
    const selection = getBillingSelection(customerOrders, selectedIds);
    const ids = kind === 'bill' ? selection.pendingBillIds : selection.unsettledIds;
    if (!ids.length) return;
    const actionAmount = customerOrders.filter((order) => ids.includes(order.id)).reduce((sum, order) => sum + Number(order.amount || 0), 0);
    if (!window.confirm(`将处理 ${ids.length} 单，共 ${page.money(actionAmount)}，确定继续？`)) return;
    const result = await page.api.post(`/api/orders/${kind}`, kind === 'bill' ? { ids, customer: currentCustomer } : { ids });
    page.showToast?.(formatBatchResult({ ...result, successCount: result?.successCount ?? result?.count ?? ids.length }));
    await viewOrders(currentCustomer);
  }
  function bind() {
    page.byId('customer-search').addEventListener('input', render);
    page.byId('page-customers').querySelector('.card-header .btn')?.addEventListener('click', addCustomer);
    page.byId('btn-unified-bill').addEventListener('click', () => batch('bill'));
    page.byId('btn-settle-selected').addEventListener('click', () => batch('settle'));
    page.byId('page-customer-orders').querySelector('.back-btn')?.addEventListener('click', () => page.navigate('customers'));
  }
  bind();
  return { enter: () => page.run(load), render, viewOrders, getBillingSelection };
}
