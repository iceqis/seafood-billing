import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FIELDS,
  FIELDS,
  ORDER_FIELDS,
  PRODUCT_FIELDS,
  PURCHASE_FIELDS,
  SUPPLIER_FIELDS,
  customerFromFeishu,
  orderFromFeishu,
  productFromFeishu,
  purchaseFromFeishu,
  statusFromFeishu,
  statusToFeishu,
  supplierFromFeishu
} from '../../worker/field-mappers.js';

describe('field mappers', () => {
  it.each([
    ['待发货', 'pending_ship'],
    ['已发货', 'shipped'],
    ['未开单', 'pending_bill'],
    ['未结算', 'unsettled'],
    ['已结算', 'settled']
  ])('maps %s to %s', (feishu, api) => {
    expect(statusFromFeishu(feishu)).toBe(api);
    expect(statusToFeishu(api)).toBe(feishu);
  });

  it('exports every existing Chinese field name for all five Feishu tables', () => {
    expect(CUSTOMER_FIELDS).toEqual({
      name: '客户名称',
      phone: '联系电话',
      settlement: '结算方式',
      remark: '备注'
    });
    expect(SUPPLIER_FIELDS).toEqual({
      name: '供应商名称',
      phone: '联系电话',
      remark: '备注'
    });
    expect(PRODUCT_FIELDS).toEqual({
      name: '商品名称',
      specs: '规格'
    });
    expect(ORDER_FIELDS).toEqual({
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
    expect(PURCHASE_FIELDS).toEqual({
      id: '进货单号',
      date: '日期',
      supplier: '供应商',
      product: '商品',
      spec: '规格',
      weight: '进货重量',
      price: '进货单价',
      amount: '金额'
    });
    expect(FIELDS).toEqual({
      customers: CUSTOMER_FIELDS,
      suppliers: SUPPLIER_FIELDS,
      products: PRODUCT_FIELDS,
      orders: ORDER_FIELDS,
      purchases: PURCHASE_FIELDS
    });
  });

  it('normalizes a Feishu order record', () => {
    const order = orderFromFeishu({
      record_id: 'rec1',
      fields: {
        订单编号: 'XSD20260823001',
        日期: '2026-08-23',
        客户: '测试客户',
        商品: '基围虾',
        规格: '30头',
        报货重量: 5,
        实际发货重量: 5.5,
        单价: 40,
        金额: 220,
        状态: '未结算',
        是否结算: false
      }
    });
    expect(order).toMatchObject({
      id: 'XSD20260823001',
      status: 'unsettled',
      amount: 220
    });
  });

  it('preserves existing customer, supplier and product API property names', () => {
    expect(customerFromFeishu({
      record_id: 'customer-record',
      fields: { 客户名称: '客户甲', 联系电话: '13800000000', 结算方式: '现结', 备注: '早上送' }
    })).toEqual({
      recordId: 'customer-record',
      name: '客户甲',
      phone: '13800000000',
      settlement: '现结',
      remark: '早上送'
    });
    expect(supplierFromFeishu({
      record_id: 'supplier-record',
      fields: { 供应商名称: '供应商甲', 联系电话: '13900000000', 备注: '码头' }
    })).toEqual({
      recordId: 'supplier-record',
      name: '供应商甲',
      phone: '13900000000',
      remark: '码头'
    });
    expect(productFromFeishu({
      record_id: 'product-record',
      fields: { 商品名称: '基围虾', 规格: '30头' }
    })).toEqual({ recordId: 'product-record', name: '基围虾', specs: '30头' });
  });

  it('preserves purchase API properties and calculates a missing amount', () => {
    expect(purchaseFromFeishu({
      record_id: 'purchase-record',
      fields: {
        进货单号: 'CGD20260823001',
        日期: '2026-08-23',
        供应商: '供应商甲',
        商品: '基围虾',
        规格: '30头',
        进货重量: 10,
        进货单价: 20,
        金额: ''
      }
    })).toEqual({
      recordId: 'purchase-record',
      id: 'CGD20260823001',
      date: '2026-08-23',
      supplier: '供应商甲',
      product: '基围虾',
      spec: '30头',
      weight: 10,
      price: 20,
      amount: 200
    });
  });
});
