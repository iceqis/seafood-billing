import { FIELDS, productFromFeishu } from '../field-mappers.js';
import { ValidationError, validateRequiredText } from '../validation.js';

export function createProductsService(feishu, env) {
  const tableId = env.TABLE_PRODUCTS;

  async function list() {
    return (await feishu.listAllRecords(tableId)).map(productFromFeishu);
  }

  async function create(input) {
    const name = validateRequiredText(input?.name, '商品名称');
    return productFromFeishu(await feishu.createRecord(tableId, {
      [FIELDS.products.name]: name,
      [FIELDS.products.specs]: input.specs || ''
    }));
  }

  async function remove(name) {
    const records = await feishu.listAllRecords(tableId, {
      field_name: FIELDS.products.name,
      operator: 'is',
      value: [name]
    });
    const record = records.find((item) => item.fields?.[FIELDS.products.name] === name);
    if (!record) throw new ValidationError('商品不存在', 404);
    await feishu.deleteRecord(tableId, record.record_id);
    return null;
  }

  return { list, create, remove };
}
