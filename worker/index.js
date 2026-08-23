// Cloudflare Workers 后端代码
// 作用：代理前端请求，调用飞书多维表格 API，完整适配海鲜批发记账系统 5 张表

import {
    FIELDS,
    STATUS_TO_FEISHU,
    customerFromFeishu,
    orderFromFeishu,
    productFromFeishu,
    purchaseFromFeishu,
    statusFromFeishu,
    statusToFeishu,
    supplierFromFeishu
} from './field-mappers.js';
import { corsHeaders, errorResponse, jsonResponse } from './response.js';
import {
    ValidationError,
    validateDate,
    validateOrderTransition,
    validatePositiveNumber,
    validateRequiredText
} from './validation.js';

// ==================== 环境变量配置说明 ====================
// 在 Cloudflare Workers 控制台设置以下环境变量：
// FEISHU_APP_ID      - 飞书应用的 App ID
// FEISHU_APP_SECRET  - 飞书应用的 App Secret
// FEISHU_BASE_TOKEN  - 多维表格 URL 中 base/ 后面的字符串
// TABLE_CUSTOMERS    - 客户表 table_id
// TABLE_SUPPLIERS    - 供应商表 table_id
// TABLE_PRODUCTS     - 商品规格表 table_id
// TABLE_ORDERS       - 订单表 table_id
// TABLE_PURCHASES    - 进货表 table_id
// ===========================================================

// 单号前缀
const ID_PREFIX = {
    order: 'XSD',
    purchase: 'CGD'
};

// ==================== 工具函数 ====================

// 获取今天日期 YYYY-MM-DD
function getToday() {
    return new Date().toISOString().split('T')[0];
}

// 获取当前月份 YYYY-MM
function getCurrentMonth() {
    return getToday().substring(0, 7);
}

// 生成单号：前缀 + YYYYMMDD + 3位序号
async function generateId(prefix, tableId, env, token) {
    const date = getToday().replace(/-/g, '');
    const count = await getRecordCount(tableId, env, token);
    const seq = String(count + 1).padStart(3, '0');
    return `${prefix}${date}${seq}`;
}

// ==================== 飞书 API 基础封装 ====================

// 获取 tenant_access_token
async function getTenantToken(env) {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            app_id: env.FEISHU_APP_ID,
            app_secret: env.FEISHU_APP_SECRET
        })
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error('获取飞书 token 失败: ' + JSON.stringify(data));
    }
    return data.tenant_access_token;
}

// 构造表格 API URL
function getRecordsUrl(env, tableId) {
    return `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BASE_TOKEN}/tables/${tableId}/records`;
}

// 获取记录总数（用于生成单号）
async function getRecordCount(tableId, env, token) {
    const res = await fetch(`${getRecordsUrl(env, tableId)}?page_size=1`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return data.data?.total || 0;
}

// 列出记录
async function listRecords(env, token, tableId, filter = null, pageSize = 500) {
    let url = `${getRecordsUrl(env, tableId)}?page_size=${pageSize}`;
    if (filter) {
        url += `&filter=${encodeURIComponent(JSON.stringify(filter))}`;
    }
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error('查询飞书记录失败: ' + JSON.stringify(data));
    }
    return data.data?.items || [];
}

// 创建记录
async function createRecord(env, token, tableId, fields) {
    const res = await fetch(getRecordsUrl(env, tableId), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error('创建飞书记录失败: ' + JSON.stringify(data));
    }
    return data.data?.record;
}

// 更新记录
async function updateRecord(env, token, tableId, recordId, fields) {
    const res = await fetch(`${getRecordsUrl(env, tableId)}/${recordId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error('更新飞书记录失败: ' + JSON.stringify(data));
    }
    return data.data?.record;
}

// 删除记录
async function deleteRecord(env, token, tableId, recordId) {
    const res = await fetch(`${getRecordsUrl(env, tableId)}/${recordId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error('删除飞书记录失败: ' + JSON.stringify(data));
    }
    return data.data;
}

// 根据名称删除记录（用于客户/供应商/商品删除）
async function deleteRecordByName(env, token, tableId, fieldName, name) {
    const filter = { field_name: fieldName, operator: 'is', value: [name] };
    const items = await listRecords(env, token, tableId, filter);
    if (items.length === 0) {
        throw new Error('记录不存在');
    }
    await deleteRecord(env, token, tableId, items[0].record_id);
}

// 构造单一条件筛选
function singleCondition(fieldName, operator, value) {
    return { field_name: fieldName, operator, value: Array.isArray(value) ? value : [value] };
}

// 构造多条件 AND 筛选
function andFilter(conditions) {
    if (conditions.length === 0) return null;
    if (conditions.length === 1) return conditions[0];
    return { conjunction: 'and', conditions };
}

// ==================== API 处理器 ====================

// 客户相关
async function handleCustomers(request, env, token, url) {
    const tableId = env.TABLE_CUSTOMERS;

    if (request.method === 'GET') {
        const items = await listRecords(env, token, tableId);
        return jsonResponse({ code: 0, message: 'success', data: items.map(customerFromFeishu) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.name) return errorResponse('客户名称不能为空', 400);
        const fields = {
            [FIELDS.customers.name]: body.name,
            [FIELDS.customers.phone]: body.phone || '',
            [FIELDS.customers.settlement]: body.settlement || '',
            [FIELDS.customers.remark]: body.remark || ''
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: customerFromFeishu(record) });
    }

    if (request.method === 'DELETE') {
        const name = decodeURIComponent(url.pathname.split('/').pop());
        await deleteRecordByName(env, token, tableId, FIELDS.customers.name, name);
        return jsonResponse({ code: 0, message: 'success', data: null });
    }

    return errorResponse('Method Not Allowed', 405);
}

// 供应商相关
async function handleSuppliers(request, env, token, url) {
    const tableId = env.TABLE_SUPPLIERS;

    if (request.method === 'GET') {
        const items = await listRecords(env, token, tableId);
        return jsonResponse({ code: 0, message: 'success', data: items.map(supplierFromFeishu) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.name) return errorResponse('供应商名称不能为空', 400);
        const fields = {
            [FIELDS.suppliers.name]: body.name,
            [FIELDS.suppliers.phone]: body.phone || '',
            [FIELDS.suppliers.remark]: body.remark || ''
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: supplierFromFeishu(record) });
    }

    if (request.method === 'DELETE') {
        const name = decodeURIComponent(url.pathname.split('/').pop());
        await deleteRecordByName(env, token, tableId, FIELDS.suppliers.name, name);
        return jsonResponse({ code: 0, message: 'success', data: null });
    }

    return errorResponse('Method Not Allowed', 405);
}

// 商品相关
async function handleProducts(request, env, token, url) {
    const tableId = env.TABLE_PRODUCTS;

    if (request.method === 'GET') {
        const items = await listRecords(env, token, tableId);
        return jsonResponse({ code: 0, message: 'success', data: items.map(productFromFeishu) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.name) return errorResponse('商品名称不能为空', 400);
        const fields = {
            [FIELDS.products.name]: body.name,
            [FIELDS.products.specs]: body.specs || ''
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: productFromFeishu(record) });
    }

    if (request.method === 'DELETE') {
        const name = decodeURIComponent(url.pathname.split('/').pop());
        await deleteRecordByName(env, token, tableId, FIELDS.products.name, name);
        return jsonResponse({ code: 0, message: 'success', data: null });
    }

    return errorResponse('Method Not Allowed', 405);
}

// 订单相关
async function handleOrders(request, env, token, url) {
    const tableId = env.TABLE_ORDERS;

    // GET /api/orders
    if (request.method === 'GET') {
        const date = url.searchParams.get('date');
        const status = url.searchParams.get('status');
        const customer = url.searchParams.get('customer');
        const conditions = [];

        if (date) {
            conditions.push(singleCondition(FIELDS.orders.date, 'is', date));
        }
        if (status) {
            const statuses = status.split(',').map(s => statusToFeishu(s)).filter(Boolean);
            if (statuses.length === 1) {
                conditions.push(singleCondition(FIELDS.orders.status, 'is', statuses[0]));
            } else if (statuses.length > 1) {
                conditions.push({ field_name: FIELDS.orders.status, operator: 'isAnyOf', value: statuses });
            }
        }
        if (customer) {
            conditions.push(singleCondition(FIELDS.orders.customer, 'is', customer));
        }

        const filter = andFilter(conditions);
        const items = await listRecords(env, token, tableId, filter);
        const data = items.map(orderFromFeishu);
        return jsonResponse({ code: 0, message: 'success', data });
    }

    // POST /api/orders - 创建预订单
    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.customer || !body.spec || !body.orderWeight) {
            return errorResponse('客户、规格、报货重量不能为空', 400);
        }

        const customer = validateRequiredText(body.customer, '客户');
        const spec = validateRequiredText(body.spec, '规格');
        const orderWeight = validatePositiveNumber(body.orderWeight, '报货重量');
        const date = body.date ? validateDate(body.date) : getToday();

        const orderId = await generateId(ID_PREFIX.order, tableId, env, token);
        const fields = {
            [FIELDS.orders.id]: orderId,
            [FIELDS.orders.date]: date,
            [FIELDS.orders.customer]: customer,
            [FIELDS.orders.product]: body.product || '基围虾',
            [FIELDS.orders.spec]: spec,
            [FIELDS.orders.orderWeight]: orderWeight,
            [FIELDS.orders.actualWeight]: '',
            [FIELDS.orders.price]: '',
            [FIELDS.orders.amount]: '',
            [FIELDS.orders.status]: STATUS_TO_FEISHU.pending_ship,
            [FIELDS.orders.settled]: false
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: orderFromFeishu(record) });
    }

    // DELETE /api/orders/:id
    const deleteMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (deleteMatch && request.method === 'DELETE') {
        const id = deleteMatch[1];
        // 先查询 recordId
        const filter = singleCondition(FIELDS.orders.id, 'is', id);
        const items = await listRecords(env, token, tableId, filter);
        if (items.length === 0) return errorResponse('订单不存在', 404);
        await deleteRecord(env, token, tableId, items[0].record_id);
        return jsonResponse({ code: 0, message: 'success', data: null });
    }

    // PUT /api/orders/:id - 更新订单（发货/定价/修改）
    const updateMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (updateMatch && request.method === 'PUT') {
        const id = updateMatch[1];
        const body = await request.json();

        const filter = singleCondition(FIELDS.orders.id, 'is', id);
        const items = await listRecords(env, token, tableId, filter);
        if (items.length === 0) return errorResponse('订单不存在', 404);

        const record = items[0];
        const current = orderFromFeishu(record);
        const updateFields = {};
        const targetStatus = body.status === undefined ? undefined : statusFromFeishu(body.status);

        if (body.actualWeight !== undefined) {
            updateFields[FIELDS.orders.actualWeight] = validatePositiveNumber(body.actualWeight, '实际发货重量');
        }
        if (body.price !== undefined) {
            updateFields[FIELDS.orders.price] = validatePositiveNumber(body.price, '单价');
        }
        if (targetStatus !== undefined) {
            if (targetStatus !== current.status) {
                validateOrderTransition(current.status, targetStatus);
            }
            updateFields[FIELDS.orders.status] = statusToFeishu(targetStatus);
        }

        // 重新计算金额
        const newActualWeight = updateFields[FIELDS.orders.actualWeight] !== undefined
            ? updateFields[FIELDS.orders.actualWeight]
            : current.actualWeight;
        const newPrice = updateFields[FIELDS.orders.price] !== undefined
            ? updateFields[FIELDS.orders.price]
            : current.price;

        if (newActualWeight && newPrice) {
            updateFields[FIELDS.orders.amount] = parseFloat((newActualWeight * newPrice).toFixed(2));
        }

        // 如果是修改订单，状态重置为未开单
        if (targetStatus === 'pending_bill' && current.status === 'settled') {
            updateFields[FIELDS.orders.settled] = false;
        }

        const updated = await updateRecord(env, token, tableId, record.record_id, updateFields);
        return jsonResponse({ code: 0, message: 'success', data: orderFromFeishu(updated) });
    }

    return errorResponse('Method Not Allowed', 405);
}

// 统一开单
async function handleBillOrders(request, env, token) {
    const body = await request.json();
    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
        return errorResponse('订单ID列表不能为空', 400);
    }

    const tableId = env.TABLE_ORDERS;
    let totalAmount = 0;
    const results = [];

    for (const id of body.ids) {
        const filter = singleCondition(FIELDS.orders.id, 'is', id);
        const items = await listRecords(env, token, tableId, filter);
        if (items.length === 0) continue;

        const order = orderFromFeishu(items[0]);
        if (order.status !== 'pending_bill') continue;

        const updated = await updateRecord(env, token, tableId, items[0].record_id, {
            [FIELDS.orders.status]: STATUS_TO_FEISHU.unsettled
        });
        const formatted = orderFromFeishu(updated);
        totalAmount += formatted.amount;
        results.push(formatted);
    }

    return jsonResponse({
        code: 0,
        message: 'success',
        data: { count: results.length, totalAmount: parseFloat(totalAmount.toFixed(2)), orders: results }
    });
}

// 结算订单
async function handleSettleOrders(request, env, token) {
    const body = await request.json();
    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
        return errorResponse('订单ID列表不能为空', 400);
    }

    const tableId = env.TABLE_ORDERS;
    let totalAmount = 0;
    const results = [];

    for (const id of body.ids) {
        const filter = singleCondition(FIELDS.orders.id, 'is', id);
        const items = await listRecords(env, token, tableId, filter);
        if (items.length === 0) continue;

        const order = orderFromFeishu(items[0]);
        if (order.status !== 'unsettled') continue;

        const updated = await updateRecord(env, token, tableId, items[0].record_id, {
            [FIELDS.orders.status]: STATUS_TO_FEISHU.settled,
            [FIELDS.orders.settled]: true
        });
        const formatted = orderFromFeishu(updated);
        totalAmount += formatted.amount;
        results.push(formatted);
    }

    return jsonResponse({
        code: 0,
        message: 'success',
        data: { count: results.length, totalAmount: parseFloat(totalAmount.toFixed(2)), orders: results }
    });
}

// 进货相关
async function handlePurchases(request, env, token, url) {
    const tableId = env.TABLE_PURCHASES;

    if (request.method === 'GET') {
        const date = url.searchParams.get('date');
        const conditions = [];
        if (date) {
            conditions.push(singleCondition(FIELDS.purchases.date, 'is', date));
        }
        const filter = andFilter(conditions);
        const items = await listRecords(env, token, tableId, filter);
        return jsonResponse({ code: 0, message: 'success', data: items.map(purchaseFromFeishu) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.supplier || !body.spec || !body.weight || !body.price) {
            return errorResponse('供应商、规格、进货重量、进货单价不能为空', 400);
        }

        const supplier = validateRequiredText(body.supplier, '供应商');
        const spec = validateRequiredText(body.spec, '规格');
        const date = body.date ? validateDate(body.date) : getToday();
        const weight = validatePositiveNumber(body.weight, '进货重量');
        const price = validatePositiveNumber(body.price, '进货单价');
        const purchaseId = await generateId(ID_PREFIX.purchase, tableId, env, token);
        const fields = {
            [FIELDS.purchases.id]: purchaseId,
            [FIELDS.purchases.date]: date,
            [FIELDS.purchases.supplier]: supplier,
            [FIELDS.purchases.product]: body.product || '基围虾',
            [FIELDS.purchases.spec]: spec,
            [FIELDS.purchases.weight]: weight,
            [FIELDS.purchases.price]: price,
            [FIELDS.purchases.amount]: parseFloat((weight * price).toFixed(2))
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: purchaseFromFeishu(record) });
    }

    if (request.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        const filter = singleCondition(FIELDS.purchases.id, 'is', id);
        const items = await listRecords(env, token, tableId, filter);
        if (items.length === 0) return errorResponse('进货记录不存在', 404);
        await deleteRecord(env, token, tableId, items[0].record_id);
        return jsonResponse({ code: 0, message: 'success', data: null });
    }

    return errorResponse('Method Not Allowed', 405);
}

// 统计相关
async function handleStats(request, env, token, url) {
    const date = url.searchParams.get('date') || getToday();
    const month = date.substring(0, 7);
    const ordersTable = env.TABLE_ORDERS;
    const purchasesTable = env.TABLE_PURCHASES;

    // 今日销售：状态为未结算或已结算
    const todaySalesConditions = [
        singleCondition(FIELDS.orders.date, 'is', date),
        {
            field_name: FIELDS.orders.status,
            operator: 'isAnyOf',
            value: [STATUS_TO_FEISHU.unsettled, STATUS_TO_FEISHU.settled]
        }
    ];
    const todaySalesItems = await listRecords(env, token, ordersTable, andFilter(todaySalesConditions));
    const todaySales = todaySalesItems.reduce((sum, item) => sum + orderFromFeishu(item).amount, 0);
    const todayDealCount = todaySalesItems.length;

    // 今日进货
    const todayPurchaseItems = await listRecords(env, token, purchasesTable, singleCondition(FIELDS.purchases.date, 'is', date));
    const todayPurchase = todayPurchaseItems.reduce((sum, item) => sum + purchaseFromFeishu(item).amount, 0);

    // 本月销售
    const monthSalesConditions = [
        singleCondition(FIELDS.orders.date, 'isGreaterThanOrEqualTo', month + '-01'),
        singleCondition(FIELDS.orders.date, 'isLessThanOrEqualTo', month + '-31'),
        {
            field_name: FIELDS.orders.status,
            operator: 'isAnyOf',
            value: [STATUS_TO_FEISHU.unsettled, STATUS_TO_FEISHU.settled]
        }
    ];
    const monthSalesItems = await listRecords(env, token, ordersTable, andFilter(monthSalesConditions));
    const monthSales = monthSalesItems.reduce((sum, item) => sum + orderFromFeishu(item).amount, 0);

    return jsonResponse({
        code: 0,
        message: 'success',
        data: {
            todaySales: parseFloat(todaySales.toFixed(2)),
            todayDealCount,
            todayPurchase: parseFloat(todayPurchase.toFixed(2)),
            monthSales: parseFloat(monthSales.toFixed(2))
        }
    });
}

// 明细相关
async function handleDetails(request, env, token, url) {
    const type = url.pathname.split('/').pop();
    const date = url.searchParams.get('date') || getToday();
    const month = date.substring(0, 7);
    const ordersTable = env.TABLE_ORDERS;
    const purchasesTable = env.TABLE_PURCHASES;

    let data = [];
    let total = 0;

    switch (type) {
        case 'today-sales': {
            const filter = andFilter([
                singleCondition(FIELDS.orders.date, 'is', date),
                {
                    field_name: FIELDS.orders.status,
                    operator: 'isAnyOf',
                    value: [STATUS_TO_FEISHU.unsettled, STATUS_TO_FEISHU.settled]
                }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(orderFromFeishu);
            total = data.reduce((sum, o) => sum + o.amount, 0);
            break;
        }
        case 'today-deals': {
            const filter = andFilter([
                singleCondition(FIELDS.orders.date, 'is', date),
                {
                    field_name: FIELDS.orders.status,
                    operator: 'isAnyOf',
                    value: [STATUS_TO_FEISHU.unsettled, STATUS_TO_FEISHU.settled]
                }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(orderFromFeishu);
            total = data.length;
            break;
        }
        case 'today-purchase': {
            const items = await listRecords(env, token, purchasesTable, singleCondition(FIELDS.purchases.date, 'is', date));
            data = items.map(purchaseFromFeishu);
            total = data.reduce((sum, p) => sum + p.amount, 0);
            break;
        }
        case 'month-sales': {
            const filter = andFilter([
                singleCondition(FIELDS.orders.date, 'isGreaterThanOrEqualTo', month + '-01'),
                singleCondition(FIELDS.orders.date, 'isLessThanOrEqualTo', month + '-31'),
                {
                    field_name: FIELDS.orders.status,
                    operator: 'isAnyOf',
                    value: [STATUS_TO_FEISHU.unsettled, STATUS_TO_FEISHU.settled]
                }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(orderFromFeishu);
            total = data.reduce((sum, o) => sum + o.amount, 0);
            break;
        }
        default:
            return errorResponse('未知明细类型', 400);
    }

    return jsonResponse({
        code: 0,
        message: 'success',
        data: { count: data.length, total: parseFloat(total.toFixed(2)), items: data }
    });
}

// ==================== 主入口 ====================

async function routeRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
            // 健康检查不依赖飞书配置或令牌
            if (path === '/api/health') {
                return jsonResponse({
                    code: 0,
                    message: 'ok',
                    data: { version: '3.0.1', service: 'seafood-billing-api' }
                });
            }

            if (path === '/api/orders/bill' && request.method !== 'POST') {
                return errorResponse('Method Not Allowed', 405);
            }

            if (path === '/api/orders/settle' && request.method !== 'POST') {
                return errorResponse('Method Not Allowed', 405);
            }

            // 环境变量校验
            const requiredEnv = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_TOKEN',
                'TABLE_CUSTOMERS', 'TABLE_SUPPLIERS', 'TABLE_PRODUCTS', 'TABLE_ORDERS', 'TABLE_PURCHASES'];
            for (const key of requiredEnv) {
                if (!env[key]) {
                    return errorResponse(`缺少环境变量: ${key}`, 500);
                }
            }

            const token = await getTenantToken(env);

            // 路由分发
            if (path === '/api/customers' || path.startsWith('/api/customers/')) {
                return await handleCustomers(request, env, token, url);
            }

            if (path === '/api/suppliers' || path.startsWith('/api/suppliers/')) {
                return await handleSuppliers(request, env, token, url);
            }

            if (path === '/api/products' || path.startsWith('/api/products/')) {
                return await handleProducts(request, env, token, url);
            }

            if (path === '/api/orders/bill') {
                return await handleBillOrders(request, env, token);
            }

            if (path === '/api/orders/settle') {
                return await handleSettleOrders(request, env, token);
            }

            if (path === '/api/orders' || /^\/api\/orders\/[^/]+$/.test(path)) {
                return await handleOrders(request, env, token, url);
            }

            if (path === '/api/purchases' || path.startsWith('/api/purchases/')) {
                return await handlePurchases(request, env, token, url);
            }

            if (path === '/api/stats/home') {
                return await handleStats(request, env, token, url);
            }

            if (path.startsWith('/api/details/')) {
                return await handleDetails(request, env, token, url);
            }

        return errorResponse('Not Found', 404);
    } catch (err) {
        const status = err instanceof ValidationError ? err.status : 500;
        return errorResponse(err.message, status);
    }
}

function parseAllowedOrigins(value) {
    return String(value ?? '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function withCors(response, cors) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) {
        headers.set(name, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export default {
    async fetch(request, env, ctx) {
        const origin = request.headers.get('Origin') ?? '';
        const cors = corsHeaders(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS));

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: cors });
        }

        const response = await routeRequest(request, env);
        return withCors(response, cors);
    }
};

// ==================== 部署说明 ====================
// 1. 在 cloudflare.com 注册账号并登录
// 2. 进入 Workers & Pages
// 3. 创建新的 Worker
// 4. 把本代码完整粘贴进去
// 5. 在 Worker 设置中配置环境变量：
//    FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_TOKEN
//    TABLE_CUSTOMERS, TABLE_SUPPLIERS, TABLE_PRODUCTS, TABLE_ORDERS, TABLE_PURCHASES
// 6. 保存并部署
// 7. 复制 Worker 访问地址，填到前端 seafood_billing_web.html 的 API_BASE 中
// 8. 前端页面也需要修改 fetch 调用，适配本 API 的返回格式
