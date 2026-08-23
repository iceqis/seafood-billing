export const CUSTOMER_FIELDS = Object.freeze({
  name: '客户名称',
  phone: '联系电话',
  settlement: '结算方式',
  remark: '备注'
});

export const SUPPLIER_FIELDS = Object.freeze({
  name: '供应商名称',
  phone: '联系电话',
  remark: '备注'
});

export const PRODUCT_FIELDS = Object.freeze({
  name: '商品名称',
  specs: '规格'
});

export const ORDER_FIELDS = Object.freeze({
  id: '订单编号',
  date: '日期',
  customer: '客户',
  product: '商品',
  spec: '规格',
  orderWeight: '报货重量',
  actualWeight: '实际发货重量',
  price: '单价',
  amount: '金额',
  status: '状态',
  settled: '是否结算'
});

export const PURCHASE_FIELDS = Object.freeze({
  id: '进货单号',
  date: '日期',
  supplier: '供应商',
  product: '商品',
  spec: '规格',
  weight: '进货重量',
  price: '进货单价',
  amount: '金额'
});

export const FIELDS = Object.freeze({
  customers: CUSTOMER_FIELDS,
  suppliers: SUPPLIER_FIELDS,
  products: PRODUCT_FIELDS,
  orders: ORDER_FIELDS,
  purchases: PURCHASE_FIELDS
});

export const STATUS_TO_FEISHU = Object.freeze({
  pending_ship: '待发货',
  shipped: '已发货',
  pending_bill: '未开单',
  unsettled: '未结算',
  settled: '已结算'
});

export function statusToFeishu(status) {
  return STATUS_TO_FEISHU[status] ?? status;
}

export function statusFromFeishu(status) {
  return Object.entries(STATUS_TO_FEISHU).find(([, value]) => value === status)?.[0] ?? status;
}

export function customerFromFeishu(item) {
  const fields = item.fields ?? {};
  return {
    recordId: item.record_id,
    name: fields[CUSTOMER_FIELDS.name] || '',
    phone: fields[CUSTOMER_FIELDS.phone] || '',
    settlement: fields[CUSTOMER_FIELDS.settlement] || '',
    remark: fields[CUSTOMER_FIELDS.remark] || ''
  };
}

export function supplierFromFeishu(item) {
  const fields = item.fields ?? {};
  return {
    recordId: item.record_id,
    name: fields[SUPPLIER_FIELDS.name] || '',
    phone: fields[SUPPLIER_FIELDS.phone] || '',
    remark: fields[SUPPLIER_FIELDS.remark] || ''
  };
}

export function productFromFeishu(item) {
  const fields = item.fields ?? {};
  return {
    recordId: item.record_id,
    name: fields[PRODUCT_FIELDS.name] || '',
    specs: fields[PRODUCT_FIELDS.specs] || ''
  };
}

export function orderFromFeishu(item) {
  const fields = item.fields ?? {};
  const actualWeight = Number(fields[ORDER_FIELDS.actualWeight]) || 0;
  const price = Number(fields[ORDER_FIELDS.price]) || 0;
  return {
    recordId: item.record_id,
    id: fields[ORDER_FIELDS.id] ?? '',
    date: fields[ORDER_FIELDS.date] ?? '',
    customer: fields[ORDER_FIELDS.customer] ?? '',
    product: fields[ORDER_FIELDS.product] ?? '',
    spec: fields[ORDER_FIELDS.spec] ?? '',
    orderWeight: Number(fields[ORDER_FIELDS.orderWeight]) || 0,
    actualWeight,
    price,
    amount: Number(fields[ORDER_FIELDS.amount]) || Number((actualWeight * price).toFixed(2)),
    status: statusFromFeishu(fields[ORDER_FIELDS.status] ?? ''),
    settled: Boolean(fields[ORDER_FIELDS.settled])
  };
}

export function purchaseFromFeishu(item) {
  const fields = item.fields ?? {};
  const weight = Number(fields[PURCHASE_FIELDS.weight]) || 0;
  const price = Number(fields[PURCHASE_FIELDS.price]) || 0;
  return {
    recordId: item.record_id,
    id: fields[PURCHASE_FIELDS.id] ?? '',
    date: fields[PURCHASE_FIELDS.date] ?? '',
    supplier: fields[PURCHASE_FIELDS.supplier] ?? '',
    product: fields[PURCHASE_FIELDS.product] ?? '',
    spec: fields[PURCHASE_FIELDS.spec] ?? '',
    weight,
    price,
    amount: Number(fields[PURCHASE_FIELDS.amount]) || Number((weight * price).toFixed(2))
  };
}
