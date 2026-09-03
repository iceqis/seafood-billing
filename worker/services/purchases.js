import { FIELDS, purchaseFromFeishu, todayInShanghai } from '../field-mappers.js';
import {
  ValidationError,
  validateDate,
  validatePositiveNumber,
  validateRequiredText
} from '../validation.js';
import { createUniqueDocument } from './orders.js';

function condition(fieldName, value) {
  return { field_name: fieldName, operator: 'is', value: [value] };
}

export function createPurchasesService(feishu, env) {
  const tableId = env.TABLE_PURCHASES;

  async function list(filters = {}) {
    const purchases = (await feishu.listAllRecords(tableId)).map(purchaseFromFeishu);
    return filters.date
      ? purchases.filter((purchase) => purchase.date === filters.date)
      : purchases;
  }

  async function create(input) {
    if (!input?.supplier || !input?.spec || !input?.weight || !input?.price) {
      throw new ValidationError('供应商、规格、进货重量、进货单价不能为空');
    }
    const date = input.date ? validateDate(input.date) : todayInShanghai();
    const supplier = validateRequiredText(input.supplier, '供应商');
    const spec = validateRequiredText(input.spec, '规格');
    const weight = validatePositiveNumber(input.weight, '进货重量');
    const price = validatePositiveNumber(input.price, '进货单价');
    const record = await createUniqueDocument(
      feishu,
      tableId,
      'CGD',
      date,
      FIELDS.purchases.id,
      FIELDS.purchases.date,
      (id) => ({
        [FIELDS.purchases.id]: id,
        [FIELDS.purchases.date]: date,
        [FIELDS.purchases.supplier]: supplier,
        [FIELDS.purchases.product]: input.product || '基围虾',
        [FIELDS.purchases.spec]: spec,
        [FIELDS.purchases.weight]: weight,
        [FIELDS.purchases.price]: price,
        [FIELDS.purchases.amount]: Number((weight * price).toFixed(2))
      })
    );
    return purchaseFromFeishu(record);
  }

  async function remove(id) {
    const records = await feishu.listAllRecords(tableId, condition(FIELDS.purchases.id, id));
    const record = records.find((item) => item.fields?.[FIELDS.purchases.id] === id);
    if (!record) throw new ValidationError('进货记录不存在', 404);
    await feishu.deleteRecord(tableId, record.record_id);
    return null;
  }

  return { list, create, remove };
}
