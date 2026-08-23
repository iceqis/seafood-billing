// Cloudflare Workers 后端代码
// 作用：代理前端请求，调用飞书多维表格 API，完整适配海鲜批发记账系统 5 张表

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

// 飞书表格字段名（中文，与表格字段名严格一致）
const FIELDS = {
    customers: {
        name: '客户名称',
        phone: '联系电话',
        settlement: '结算方式',
        remark: '备注'
    },
    suppliers: {
        name: '供应商名称',
        phone: '联系电话',
        remark: '备注'
    },
    products: {
        name: '商品名称',
        specs: '规格'
    },
    orders: {
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
    },
    purchases: {
        id: '进货单号',
        date: '日期',
        supplier: '供应商',
        product: '商品',
        spec: '规格',
        weight: '进货重量',
        price: '进货单价',
        amount: '金额'
    }
};

// 状态枚举值（中文，与飞书单选选项严格一致）
const ORDER_STATUS = {
    PENDING_SHIP: '待发货',
    SHIPPED: '已发货',
    PENDING_BILL: '未开单',
    UNSETTLED: '未结算',
    SETTLED: '已结算'
};

// 单号前缀
const ID_PREFIX = {
    order: 'XSD',
    purchase: 'CGD'
};

// ==================== 工具函数 ====================

// 统一 JSON 响应
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders()
        }
    });
}

// 错误响应
function errorResponse(message, status = 500) {
    return jsonResponse({ code: status, message, data: null }, status);
}

// CORS 响应头
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
}

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

// ==================== 记录格式化 ====================

function formatCustomer(item) {
    const f = item.fields || {};
    return {
        recordId: item.record_id,
        name: f[FIELDS.customers.name] || '',
        phone: f[FIELDS.customers.phone] || '',
        settlement: f[FIELDS.customers.settlement] || '',
        remark: f[FIELDS.customers.remark] || ''
    };
}

function formatSupplier(item) {
    const f = item.fields || {};
    return {
        recordId: item.record_id,
        name: f[FIELDS.suppliers.name] || '',
        phone: f[FIELDS.suppliers.phone] || '',
        remark: f[FIELDS.suppliers.remark] || ''
    };
}

function formatProduct(item) {
    const f = item.fields || {};
    return {
        recordId: item.record_id,
        name: f[FIELDS.products.name] || '',
        specs: f[FIELDS.products.specs] || ''
    };
}

function formatOrder(item) {
    const f = item.fields || {};
    const actualWeight = parseFloat(f[FIELDS.orders.actualWeight]) || 0;
    const price = parseFloat(f[FIELDS.orders.price]) || 0;
    return {
        recordId: item.record_id,
        id: f[FIELDS.orders.id] || '',
        date: f[FIELDS.orders.date] || '',
        customer: f[FIELDS.orders.customer] || '',
        product: f[FIELDS.orders.product] || '',
        spec: f[FIELDS.orders.spec] || '',
        orderWeight: parseFloat(f[FIELDS.orders.orderWeight]) || 0,
        actualWeight,
        price,
        amount: parseFloat(f[FIELDS.orders.amount]) || (actualWeight * price) || 0,
        status: f[FIELDS.orders.status] || '',
        settled: f[FIELDS.orders.settled] || false
    };
}

function formatPurchase(item) {
    const f = item.fields || {};
    const weight = parseFloat(f[FIELDS.purchases.weight]) || 0;
    const price = parseFloat(f[FIELDS.purchases.price]) || 0;
    return {
        recordId: item.record_id,
        id: f[FIELDS.purchases.id] || '',
        date: f[FIELDS.purchases.date] || '',
        supplier: f[FIELDS.purchases.supplier] || '',
        product: f[FIELDS.purchases.product] || '',
        spec: f[FIELDS.purchases.spec] || '',
        weight,
        price,
        amount: parseFloat(f[FIELDS.purchases.amount]) || (weight * price) || 0
    };
}

// 状态值转换：前端英文 -> 飞书中文
function statusToFeishu(status) {
    const map = {
        'pending_ship': ORDER_STATUS.PENDING_SHIP,
        'shipped': ORDER_STATUS.SHIPPED,
        'pending_bill': ORDER_STATUS.PENDING_BILL,
        'unsettled': ORDER_STATUS.UNSETTLED,
        'settled': ORDER_STATUS.SETTLED
    };
    return map[status] || status;
}

// 状态值转换：飞书中文 -> 前端英文
function statusFromFeishu(status) {
    const map = {
        [ORDER_STATUS.PENDING_SHIP]: 'pending_ship',
        [ORDER_STATUS.SHIPPED]: 'shipped',
        [ORDER_STATUS.PENDING_BILL]: 'pending_bill',
        [ORDER_STATUS.UNSETTLED]: 'unsettled',
        [ORDER_STATUS.SETTLED]: 'settled'
    };
    return map[status] || status;
}

// ==================== API 处理器 ====================

// 客户相关
async function handleCustomers(request, env, token, url) {
    const tableId = env.TABLE_CUSTOMERS;

    if (request.method === 'GET') {
        const items = await listRecords(env, token, tableId);
        return jsonResponse({ code: 0, message: 'success', data: items.map(formatCustomer) });
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
        return jsonResponse({ code: 0, message: 'success', data: formatCustomer(record) });
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
        return jsonResponse({ code: 0, message: 'success', data: items.map(formatSupplier) });
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
        return jsonResponse({ code: 0, message: 'success', data: formatSupplier(record) });
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
        return jsonResponse({ code: 0, message: 'success', data: items.map(formatProduct) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.name) return errorResponse('商品名称不能为空', 400);
        const fields = {
            [FIELDS.products.name]: body.name,
            [FIELDS.products.specs]: body.specs || ''
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: formatProduct(record) });
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
        return jsonResponse({ code: 0, message: 'success', data: items.map(formatOrder) });
    }

    // POST /api/orders - 创建预订单
    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.customer || !body.spec || !body.orderWeight) {
            return errorResponse('客户、规格、报货重量不能为空', 400);
        }

        const orderId = await generateId(ID_PREFIX.order, tableId, env, token);
        const fields = {
            [FIELDS.orders.id]: orderId,
            [FIELDS.orders.date]: body.date || getToday(),
            [FIELDS.orders.customer]: body.customer,
            [FIELDS.orders.product]: body.product || '基围虾',
            [FIELDS.orders.spec]: body.spec,
            [FIELDS.orders.orderWeight]: parseFloat(body.orderWeight),
            [FIELDS.orders.actualWeight]: '',
            [FIELDS.orders.price]: '',
            [FIELDS.orders.amount]: '',
            [FIELDS.orders.status]: ORDER_STATUS.PENDING_SHIP,
            [FIELDS.orders.settled]: false
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: formatOrder(record) });
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
        const current = formatOrder(record);
        const updateFields = {};

        if (body.actualWeight !== undefined) {
            updateFields[FIELDS.orders.actualWeight] = parseFloat(body.actualWeight) || 0;
        }
        if (body.price !== undefined) {
            updateFields[FIELDS.orders.price] = parseFloat(body.price) || 0;
        }
        if (body.status !== undefined) {
            updateFields[FIELDS.orders.status] = statusToFeishu(body.status);
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
        if (body.status === 'pending_bill' && current.status === ORDER_STATUS.SETTLED) {
            updateFields[FIELDS.orders.settled] = false;
        }

        const updated = await updateRecord(env, token, tableId, record.record_id, updateFields);
        return jsonResponse({ code: 0, message: 'success', data: formatOrder(updated) });
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

        const order = formatOrder(items[0]);
        if (order.status !== ORDER_STATUS.PENDING_BILL) continue;

        const updated = await updateRecord(env, token, tableId, items[0].record_id, {
            [FIELDS.orders.status]: ORDER_STATUS.UNSETTLED
        });
        const formatted = formatOrder(updated);
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

        const order = formatOrder(items[0]);
        if (order.status !== ORDER_STATUS.UNSETTLED) continue;

        const updated = await updateRecord(env, token, tableId, items[0].record_id, {
            [FIELDS.orders.status]: ORDER_STATUS.SETTLED,
            [FIELDS.orders.settled]: true
        });
        const formatted = formatOrder(updated);
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
        return jsonResponse({ code: 0, message: 'success', data: items.map(formatPurchase) });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        if (!body.supplier || !body.spec || !body.weight || !body.price) {
            return errorResponse('供应商、规格、进货重量、进货单价不能为空', 400);
        }

        const purchaseId = await generateId(ID_PREFIX.purchase, tableId, env, token);
        const weight = parseFloat(body.weight);
        const price = parseFloat(body.price);
        const fields = {
            [FIELDS.purchases.id]: purchaseId,
            [FIELDS.purchases.date]: body.date || getToday(),
            [FIELDS.purchases.supplier]: body.supplier,
            [FIELDS.purchases.product]: body.product || '基围虾',
            [FIELDS.purchases.spec]: body.spec,
            [FIELDS.purchases.weight]: weight,
            [FIELDS.purchases.price]: price,
            [FIELDS.purchases.amount]: parseFloat((weight * price).toFixed(2))
        };
        const record = await createRecord(env, token, tableId, fields);
        return jsonResponse({ code: 0, message: 'success', data: formatPurchase(record) });
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
        { field_name: FIELDS.orders.status, operator: 'isAnyOf', value: [ORDER_STATUS.UNSETTLED, ORDER_STATUS.SETTLED] }
    ];
    const todaySalesItems = await listRecords(env, token, ordersTable, andFilter(todaySalesConditions));
    const todaySales = todaySalesItems.reduce((sum, item) => sum + formatOrder(item).amount, 0);
    const todayDealCount = todaySalesItems.length;

    // 今日进货
    const todayPurchaseItems = await listRecords(env, token, purchasesTable, singleCondition(FIELDS.purchases.date, 'is', date));
    const todayPurchase = todayPurchaseItems.reduce((sum, item) => sum + formatPurchase(item).amount, 0);

    // 本月销售
    const monthSalesConditions = [
        singleCondition(FIELDS.orders.date, 'isGreaterThanOrEqualTo', month + '-01'),
        singleCondition(FIELDS.orders.date, 'isLessThanOrEqualTo', month + '-31'),
        { field_name: FIELDS.orders.status, operator: 'isAnyOf', value: [ORDER_STATUS.UNSETTLED, ORDER_STATUS.SETTLED] }
    ];
    const monthSalesItems = await listRecords(env, token, ordersTable, andFilter(monthSalesConditions));
    const monthSales = monthSalesItems.reduce((sum, item) => sum + formatOrder(item).amount, 0);

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
                { field_name: FIELDS.orders.status, operator: 'isAnyOf', value: [ORDER_STATUS.UNSETTLED, ORDER_STATUS.SETTLED] }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(formatOrder).map(o => ({ ...o, status: statusFromFeishu(o.status) }));
            total = data.reduce((sum, o) => sum + o.amount, 0);
            break;
        }
        case 'today-deals': {
            const filter = andFilter([
                singleCondition(FIELDS.orders.date, 'is', date),
                { field_name: FIELDS.orders.status, operator: 'isAnyOf', value: [ORDER_STATUS.UNSETTLED, ORDER_STATUS.SETTLED] }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(formatOrder).map(o => ({ ...o, status: statusFromFeishu(o.status) }));
            total = data.length;
            break;
        }
        case 'today-purchase': {
            const items = await listRecords(env, token, purchasesTable, singleCondition(FIELDS.purchases.date, 'is', date));
            data = items.map(formatPurchase);
            total = data.reduce((sum, p) => sum + p.amount, 0);
            break;
        }
        case 'month-sales': {
            const filter = andFilter([
                singleCondition(FIELDS.orders.date, 'isGreaterThanOrEqualTo', month + '-01'),
                singleCondition(FIELDS.orders.date, 'isLessThanOrEqualTo', month + '-31'),
                { field_name: FIELDS.orders.status, operator: 'isAnyOf', value: [ORDER_STATUS.UNSETTLED, ORDER_STATUS.SETTLED] }
            ]);
            const items = await listRecords(env, token, ordersTable, filter);
            data = items.map(formatOrder).map(o => ({ ...o, status: statusFromFeishu(o.status) }));
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

export default {
    async fetch(request, env, ctx) {
        // 处理 CORS 预检请求
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
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

            if (path === '/api/orders' || path.startsWith('/api/orders/')) {
                return await handleOrders(request, env, token, url);
            }

            if (path === '/api/orders/bill') {
                return await handleBillOrders(request, env, token);
            }

            if (path === '/api/orders/settle') {
                return await handleSettleOrders(request, env, token);
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

            // 健康检查
            if (path === '/api/health') {
                return jsonResponse({ code: 0, message: 'ok', data: { version: '1.0' } });
            }

            return errorResponse('Not Found', 404);
        } catch (err) {
            return errorResponse(err.message, 500);
        }
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
