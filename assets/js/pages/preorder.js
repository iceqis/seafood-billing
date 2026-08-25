import { createElement } from '../utils.js';
import { createPageFactory } from './factory.js';

export function createPreorderPage(deps) {
  const page = createPageFactory(deps);
  let customers = [];
  let products = [];
  let selectedSpec = '';
  async function load() {
    resetForm();
    [customers, products] = await Promise.all([page.api.get('/api/customers'), page.api.get('/api/products')]);
    fillSelect(page.byId('preorder-customer'), customers, '请选择客户');
    fillSelect(page.byId('preorder-product'), products, '请选择商品');
    renderCustomerChips(); renderSpecs(); updatePreview();
  }
  function fillSelect(select, values, placeholder) {
    page.clear(select); select.append(createElement('option', { value: '' }, placeholder));
    (values || []).forEach((item) => select.append(createElement('option', { value: item.name }, item.name)));
  }
  function renderCustomerChips() {
    const container = page.byId('preorder-customer-chips'); page.clear(container);
    customers.slice(0, 12).forEach((customer) => {
      const button = createElement('button', { className: 'chip', type: 'button' }, customer.name);
      button.addEventListener('click', () => { page.byId('preorder-customer').value = customer.name; updatePreview(); }); container.append(button);
    });
  }
  function renderSpecs() {
    const product = products.find((item) => item.name === page.byId('preorder-product').value);
    const specs = String(product?.specs || '').split(/[/,，]/).map((item) => item.trim()).filter(Boolean);
    const container = page.byId('preorder-spec-chips'); page.clear(container);
    specs.forEach((spec) => { const button = createElement('button', { className: `chip${selectedSpec === spec ? ' active' : ''}`, type: 'button' }, spec); button.addEventListener('click', () => { selectedSpec = spec; renderSpecs(); updatePreview(); }); container.append(button); });
  }
  function updatePreview() {
    const customer = page.byId('preorder-customer').value;
    const product = page.byId('preorder-product').value;
    page.setText(page.byId('preview-customer'), customer || '-'); page.setText(page.byId('preview-product'), product || '-');
    page.setText(page.byId('preview-spec'), selectedSpec || '-'); page.setText(page.byId('preview-weight'), page.byId('preorder-weight').value || '-');
    const found = customers.find((item) => item.name === customer); page.byId('preorder-customer-info').style.display = found ? 'grid' : 'none';
    page.setText(page.byId('preorder-customer-phone'), found?.phone || ''); page.setText(page.byId('preorder-customer-settlement'), found?.settlement || '');
  }
  async function save() {
    const payload = { date: page.byId('preorder-date').value || page.today(), customer: page.byId('preorder-customer').value, product: page.byId('preorder-product').value, spec: selectedSpec, orderWeight: Number(page.byId('preorder-weight').value) };
    if (!payload.customer || !payload.product || !payload.spec || !Number.isFinite(payload.orderWeight) || payload.orderWeight <= 0) throw new Error('请完整填写预订单信息');
    await page.api.post('/api/orders', payload);
    resetForm();
    page.navigate('orders');
  }
  function resetForm() { page.byId('preorder-date').value = page.today(); page.byId('preorder-customer').value = ''; page.byId('preorder-product').value = ''; page.byId('preorder-weight').value = ''; selectedSpec = ''; page.clear(page.byId('preorder-spec-chips')); updatePreview(); }
  function bind() {
    page.byId('preorder-customer').addEventListener('change', updatePreview);
    page.byId('preorder-product').addEventListener('change', () => { selectedSpec = ''; renderSpecs(); updatePreview(); });
    page.byId('preorder-weight').addEventListener('input', updatePreview);
    document.querySelector('#page-preorder .sticky-sidebar button')?.addEventListener('click', () => page.run(save));
  }
  bind();
  return { enter: () => page.run(load), save };
}
