import { createApiClient, RequestCancelled } from './api-client.js';
import { createAuthStore, login } from './auth.js';
import { APP_CONFIG } from './config.js';
import { state } from './state.js';
import { getLocalDate, hideLoading, setText, showLoading, showToast } from './utils.js';

        const API_BASE = APP_CONFIG.apiBase;
        function getSessionStorage() {
            try {
                return globalThis.localStorage;
            } catch {
                return null;
            }
        }
        const authStore = createAuthStore(getSessionStorage());
        let sessionVersion = 0;

        // 状态中文映射
        const statusMap = {
            pending_ship: { text: '待发货', class: 'status-pending_ship' },
            shipped: { text: '已发货', class: 'status-shipped' },
            pending_bill: { text: '未开单', class: 'status-pending_bill' },
            unsettled: { text: '未结算', class: 'status-unsettled' },
            settled: { text: '已结算', class: 'status-settled' }
        };

        let preorderCustomer = '';
        let preorderSpec = '';
        let selectedPreorderProduct = '';
        let selectedPurchaseProduct = '';
        let selectedPurchaseSpec = '';

        // ==================== 工具函数 ====================

        const getToday = getLocalDate;

        function isConfigValid() {
            return API_BASE && !API_BASE.includes('你的-worker地址');
        }

        function clearBusinessState() {
            state.customers = [];
            state.suppliers = [];
            state.products = [];
            state.orders = [];
            state.purchases = [];
            state.currentCustomer = '';
            state.selectedOrderIds.clear();
        }

        function showLogin(message = '') {
            document.getElementById('app-container').hidden = true;
            document.getElementById('login-view').hidden = false;
            setText(document.getElementById('login-message'), message);
            document.getElementById('login-password').value = '';
        }

        function showApplication() {
            document.getElementById('login-view').hidden = true;
            document.getElementById('app-container').hidden = false;
            setText(document.getElementById('login-message'), '');
        }

        // ==================== API 请求封装 ====================

        function invalidateSession(message = '') {
            sessionVersion += 1;
            apiClient.cancelAll();
            authStore.clear();
            clearBusinessState();
            hideLoading();
            showLogin(message);
        }

        function activateSession(token) {
            sessionVersion += 1;
            apiClient.cancelAll();
            authStore.saveToken(token);
        }

        function handleUnauthorized(requestContext) {
            if (requestContext.sessionVersion !== sessionVersion) return;
            if (requestContext.token !== authStore.getToken()) return;
            invalidateSession('登录已过期，请重新登录');
        }

        const apiClient = createApiClient({
            apiBase: API_BASE,
            getToken: () => authStore.getToken(),
            getSessionVersion: () => sessionVersion,
            onUnauthorized: handleUnauthorized,
            timeoutMs: APP_CONFIG.requestTimeoutMs
        });

        async function apiRequest(request) {
            if (!isConfigValid()) {
                document.getElementById('api-config-tip').style.display = 'block';
                throw new Error('请先配置 API_BASE');
            }

            try {
                return await request();
            } catch (err) {
                if (err instanceof RequestCancelled || err?.name === 'RequestCancelled') throw err;
                showToast(err.message || '网络错误，请检查 API_BASE 配置', 'error');
                throw err;
            }
        }

        function apiGet(url) {
            return apiRequest(() => apiClient.get(url));
        }

        function apiPost(url, body) {
            return apiRequest(() => apiClient.post(url, body));
        }

        function apiPut(url, body) {
            return apiRequest(() => apiClient.put(url, body));
        }

        function apiDelete(url) {
            return apiRequest(() => apiClient.delete(url));
        }

        let loginInFlight = null;

        function submitLogin(event) {
            event.preventDefault();
            if (loginInFlight) return loginInFlight;
            loginInFlight = performLogin();
            return loginInFlight;
        }

        async function performLogin() {
            const passwordInput = document.getElementById('login-password');
            const password = passwordInput.value;
            passwordInput.value = '';
            const button = document.getElementById('login-submit');
            const message = document.getElementById('login-message');
            button.disabled = true;
            setText(message, '');
            let tokenSaved = false;
            try {
                const token = await login(API_BASE, password);
                activateSession(token);
                tokenSaved = true;
                showApplication();
                await init();
            } catch (error) {
                if (!tokenSaved) setText(message, error.message || '登录失败，请重试');
            } finally {
                button.disabled = false;
                loginInFlight = null;
            }
        }

        document.getElementById('login-form').addEventListener('submit', submitLogin);
        document.getElementById('logout-button').addEventListener('click', () => {
            invalidateSession();
        });

        // ==================== 数据加载 ====================

        async function loadCustomers() {
            state.customers = await apiGet('/api/customers') || [];
        }

        async function loadSuppliers() {
            state.suppliers = await apiGet('/api/suppliers') || [];
        }

        async function loadProducts() {
            const raw = await apiGet('/api/products') || [];
            state.products = raw.map(p => ({
                ...p,
                specs: p.specs ? p.specs.split(/[/,，]/).map(s => s.trim()).filter(s => s) : []
            }));
        }

        async function loadOrders(params = {}) {
            const query = new URLSearchParams();
            if (params.date) query.append('date', params.date);
            if (params.status) query.append('status', params.status);
            if (params.customer) query.append('customer', params.customer);
            const url = '/api/orders' + (query.toString() ? '?' + query.toString() : '');
            state.orders = await apiGet(url) || [];
        }

        async function loadPurchases(date) {
            const url = date ? '/api/purchases?date=' + date : '/api/purchases';
            state.purchases = await apiGet(url) || [];
        }

        async function loadHomeStats() {
            const stats = await apiGet('/api/stats/home?date=' + getToday());
            document.getElementById('home-today-sales').textContent = '¥' + (stats.todaySales || 0).toFixed(2);
            document.getElementById('home-deal-count').textContent = stats.todayDealCount || 0;
            document.getElementById('home-today-purchase').textContent = '¥' + (stats.todayPurchase || 0).toFixed(2);
            document.getElementById('home-month-sales').textContent = '¥' + (stats.monthSales || 0).toFixed(2);
        }

        // ==================== 页面切换 ====================

        async function goPage(pageName) {
            document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
            document.getElementById('page-' + pageName).classList.add('active');

            document.querySelectorAll('.nav-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.page === pageName) btn.classList.add('active');
            });

            document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.page === pageName) btn.classList.add('active');
            });

            document.getElementById('mobile-menu').classList.remove('show');
            window.scrollTo(0, 0);

            if (!isConfigValid()) {
                document.getElementById('api-config-tip').style.display = 'block';
                return;
            }

            try {
                showLoading('加载中...');
                if (pageName === 'orders') {
                    document.getElementById('order-date').value = getToday();
                    await loadOrders({ date: getToday(), status: 'pending_ship,shipped' });
                    renderOrders();
                }
                else if (pageName === 'customers') {
                    await loadCustomers();
                    await loadOrders();
                    renderCustomers();
                }
                else if (pageName === 'purchase') {
                    await loadSuppliers();
                    await loadProducts();
                    await loadPurchases(getToday());
                    renderPurchasePage();
                }
                else if (pageName === 'preorder') {
                    await loadCustomers();
                    await loadProducts();
                    document.getElementById('preorder-date').value = getToday();
                    renderPreorderCustomers();
                    renderPreorderProducts();
                }
                else if (pageName === 'products') {
                    await loadProducts();
                    renderProducts();
                }
                else if (pageName === 'home') {
                    await loadHomeStats();
                }
            } catch (err) {
                // 错误已在 apiRequest 中提示
            } finally {
                hideLoading();
            }
        }

        // 桌面导航点击
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => goPage(btn.dataset.page));
        });

        // 手机导航点击
        document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => goPage(btn.dataset.page));
        });

        // 手机菜单切换
        document.getElementById('mobile-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('mobile-menu').classList.toggle('show');
        });

        // 点击页面其他地方关闭手机菜单
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#mobile-menu') && !e.target.closest('#mobile-menu-btn')) {
                document.getElementById('mobile-menu').classList.remove('show');
            }
        });

        // 导航栏滚动阴影
        window.addEventListener('scroll', () => {
            const nav = document.getElementById('navbar');
            if (window.scrollY > 10) {
                nav.classList.add('scrolled');
            } else {
                nav.classList.remove('scrolled');
            }
        });

        // 点击遮罩关闭模态框
        document.getElementById('modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'modal-overlay') closeModal();
        });

        // ==================== 预订单 ====================

        function renderPreorderCustomers() {
            const selectEl = document.getElementById('preorder-customer');
            const chipsEl = document.getElementById('preorder-customer-chips');
            const currentVal = selectEl.value;

            selectEl.innerHTML = '<option value="">请选择客户</option>' +
                state.customers.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
            if (state.customers.some(c => c.name === currentVal)) {
                selectEl.value = currentVal;
            }

            chipsEl.innerHTML = state.customers.map(c => `
                <button class="chip ${preorderCustomer === c.name ? 'chip-primary' : 'chip-default'}"
                        onclick="selectCustomer('${c.name}')">${c.name}</button>
            `).join('');
        }

        function selectCustomer(name) {
            preorderCustomer = name;
            document.getElementById('preorder-customer').value = name;
            document.getElementById('preview-customer').textContent = name;
            updatePreorderCustomerInfo(name);
            renderPreorderCustomers();
        }

        function updatePreorderCustomerInfo(name) {
            const infoRow = document.getElementById('preorder-customer-info');
            const customer = state.customers.find(c => c.name === name);
            if (customer) {
                document.getElementById('preorder-customer-phone').value = customer.phone || '-';
                document.getElementById('preorder-customer-settlement').value = customer.settlement || '-';
                infoRow.style.display = 'grid';
            } else {
                infoRow.style.display = 'none';
            }
        }

        document.getElementById('preorder-customer').addEventListener('change', (e) => {
            preorderCustomer = e.target.value;
            document.getElementById('preview-customer').textContent = e.target.value || '-';
            updatePreorderCustomerInfo(e.target.value);
            renderPreorderCustomers();
        });

        function renderPreorderProducts() {
            const selectEl = document.getElementById('preorder-product');
            const currentVal = selectEl.value;
            selectEl.innerHTML = '<option value="">请选择商品</option>' +
                state.products.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
            if (state.products.some(p => p.name === currentVal)) {
                selectEl.value = currentVal;
            }
            renderPreorderSpecs();
        }

        document.getElementById('preorder-product').addEventListener('change', (e) => {
            selectedPreorderProduct = e.target.value;
            preorderSpec = '';
            document.getElementById('preview-product').textContent = e.target.value || '-';
            document.getElementById('preview-spec').textContent = '-';
            renderPreorderSpecs();
        });

        function renderPreorderSpecs() {
            const chipsEl = document.getElementById('preorder-spec-chips');
            const productName = selectedPreorderProduct || document.getElementById('preorder-product').value;
            const product = state.products.find(p => p.name === productName);

            if (!product) {
                chipsEl.innerHTML = '<div class="text-sm text-gray">请先选择商品</div>';
                return;
            }

            chipsEl.innerHTML = product.specs.map(spec => `
                <button class="chip ${preorderSpec === spec ? 'chip-primary' : 'chip-default'}"
                        onclick="selectPreorderSpec('${spec}')">${spec}</button>
            `).join('');
        }

        function selectPreorderSpec(spec) {
            preorderSpec = spec;
            document.getElementById('preview-spec').textContent = spec;
            renderPreorderSpecs();
        }

        document.getElementById('preorder-weight').addEventListener('input', (e) => {
            document.getElementById('preview-weight').textContent = e.target.value ? e.target.value + '斤' : '-';
        });

        async function savePreorder() {
            const customer = document.getElementById('preorder-customer').value.trim();
            const product = document.getElementById('preorder-product').value.trim();
            const weight = parseFloat(document.getElementById('preorder-weight').value);
            const date = document.getElementById('preorder-date').value;

            if (!customer || !product || !weight || !preorderSpec) {
                showToast('请填写完整信息', 'error');
                return;
            }

            try {
                showLoading('保存中...');
                await apiPost('/api/orders', {
                    date: date,
                    customer: customer,
                    product: product,
                    spec: preorderSpec,
                    orderWeight: weight
                });

                // 重置表单
                document.getElementById('preorder-customer').value = '';
                document.getElementById('preorder-product').value = '';
                document.getElementById('preorder-weight').value = '';
                preorderCustomer = '';
                selectedPreorderProduct = '';
                preorderSpec = '';
                document.getElementById('preview-customer').textContent = '-';
                document.getElementById('preview-product').textContent = '-';
                document.getElementById('preview-spec').textContent = '-';
                document.getElementById('preview-weight').textContent = '-';
                document.getElementById('preorder-customer-info').style.display = 'none';
                renderPreorderCustomers();
                renderPreorderProducts();

                showToast('预订单保存成功！');
                goPage('orders');
            } catch (err) {
                // 错误已提示
            } finally {
                hideLoading();
            }
        }

        // ==================== 进货单 ====================

        function renderPurchasePage() {
            document.getElementById('purchase-date').value = getToday();
            renderSuppliers();
            renderPurchaseProducts();
            updatePurchaseAmount();
            renderPurchaseRecords();
        }

        function renderSuppliers() {
            const listEl = document.getElementById('supplier-list');
            const selectEl = document.getElementById('purchase-supplier');

            if (state.suppliers.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state" style="padding: 24px 0;">
                        <div class="icon">🏭</div>
                        <div>暂无供应商</div>
                        <div class="text-sm">点击右上角添加</div>
                    </div>
                `;
            } else {
                listEl.innerHTML = state.suppliers.map((s, index) => `
                    <div class="list-item" style="margin-bottom: 8px; padding: 12px 14px;">
                        <div class="flex items-center gap-3">
                            <span style="font-size: 22px;">🏭</span>
                            <div>
                                <div class="font-semibold">${s.name}</div>
                                ${s.phone ? `<div class="text-xs text-gray-light mt-1">${s.phone}</div>` : ''}
                            </div>
                        </div>
                        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteSupplier('${s.name}')">删除</button>
                    </div>
                `).join('');
            }

            const currentVal = selectEl.value;
            selectEl.innerHTML = '<option value="">请选择供应商</option>' +
                state.suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
            if (state.suppliers.some(s => s.name === currentVal)) {
                selectEl.value = currentVal;
            }
        }

        function openAddSupplierModal() {
            document.getElementById('modal-title').textContent = '添加供应商';
            document.getElementById('modal-body').innerHTML = `
                <div class="form-group">
                    <label class="form-label">供应商名称</label>
                    <input type="text" class="form-input" id="new-supplier-name" placeholder="请输入供应商名称" autofocus>
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">联系电话</label>
                    <input type="text" class="form-input" id="new-supplier-phone" placeholder="选填">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmAddSupplier()">确认添加</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
            setTimeout(() => document.getElementById('new-supplier-name').focus(), 100);
        }

        async function confirmAddSupplier() {
            const name = document.getElementById('new-supplier-name').value.trim();
            const phone = document.getElementById('new-supplier-phone').value.trim();
            if (!name) {
                showToast('请输入供应商名称', 'error');
                return;
            }
            try {
                showLoading('添加中...');
                await apiPost('/api/suppliers', { name, phone });
                await loadSuppliers();
                closeModal();
                renderSuppliers();
                document.getElementById('purchase-supplier').value = name;
                showToast('供应商添加成功！');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        async function deleteSupplier(name) {
            if (!confirm('确认删除该供应商？')) return;
            try {
                showLoading('删除中...');
                await apiDelete('/api/suppliers/' + encodeURIComponent(name));
                await loadSuppliers();
                renderSuppliers();
                renderPurchaseRecords();
                showToast('供应商已删除');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        function renderPurchaseProducts() {
            const selectEl = document.getElementById('purchase-product');
            const currentVal = selectEl.value;
            selectEl.innerHTML = '<option value="">请选择商品</option>' +
                state.products.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
            if (state.products.some(p => p.name === currentVal)) {
                selectEl.value = currentVal;
            }
            renderPurchaseSpecs();
        }

        document.getElementById('purchase-product').addEventListener('change', (e) => {
            selectedPurchaseProduct = e.target.value;
            selectedPurchaseSpec = '';
            renderPurchaseSpecs();
        });

        function renderPurchaseSpecs() {
            const chipsEl = document.getElementById('purchase-spec-chips');
            const productName = selectedPurchaseProduct || document.getElementById('purchase-product').value;
            const product = state.products.find(p => p.name === productName);

            if (!product) {
                chipsEl.innerHTML = '<div class="text-sm text-gray">请先选择商品</div>';
                return;
            }

            chipsEl.innerHTML = product.specs.map(spec => `
                <button class="chip ${selectedPurchaseSpec === spec ? 'chip-primary' : 'chip-default'}"
                        onclick="selectPurchaseSpec('${spec}')">${spec}</button>
            `).join('');
        }

        function selectPurchaseSpec(spec) {
            selectedPurchaseSpec = spec;
            renderPurchaseSpecs();
        }

        function updatePurchaseAmount() {
            const weight = parseFloat(document.getElementById('purchase-weight').value) || 0;
            const price = parseFloat(document.getElementById('purchase-price').value) || 0;
            const amount = weight * price;
            document.getElementById('purchase-amount').value = amount.toFixed(2);
            document.getElementById('purchase-summary-weight').textContent = weight.toFixed(1) + '斤';
            document.getElementById('purchase-summary-total').textContent = '¥' + amount.toFixed(2);
        }

        document.getElementById('purchase-weight').addEventListener('input', updatePurchaseAmount);
        document.getElementById('purchase-price').addEventListener('input', updatePurchaseAmount);

        async function savePurchase() {
            const date = document.getElementById('purchase-date').value;
            const supplier = document.getElementById('purchase-supplier').value;
            const product = document.getElementById('purchase-product').value;
            const weight = parseFloat(document.getElementById('purchase-weight').value);
            const price = parseFloat(document.getElementById('purchase-price').value);

            if (!date) {
                showToast('请选择进货日期', 'error');
                return;
            }
            if (!supplier) {
                showToast('请选择供应商', 'error');
                return;
            }
            if (!product) {
                showToast('请选择商品', 'error');
                return;
            }
            if (!selectedPurchaseSpec) {
                showToast('请选择商品规格', 'error');
                return;
            }
            if (!weight || weight <= 0) {
                showToast('请输入有效的进货重量', 'error');
                return;
            }
            if (!price || price <= 0) {
                showToast('请输入有效的进货单价', 'error');
                return;
            }

            try {
                showLoading('保存中...');
                await apiPost('/api/purchases', {
                    date: date,
                    supplier: supplier,
                    product: product,
                    spec: selectedPurchaseSpec,
                    weight: weight,
                    price: price
                });

                document.getElementById('purchase-weight').value = '';
                document.getElementById('purchase-price').value = '';
                selectedPurchaseSpec = '';
                renderPurchaseProducts();
                updatePurchaseAmount();
                await loadPurchases(getToday());
                renderPurchaseRecords();
                await loadHomeStats();

                showToast('进货单保存成功！');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        function renderPurchaseRecords() {
            const listEl = document.getElementById('purchase-records-list');
            const today = getToday();
            const todayPurchases = state.purchases.filter(p => p.date === today);

            if (todayPurchases.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state" style="padding: 16px 0;">
                        <div class="text-sm">今日暂无进货记录</div>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = todayPurchases.map(p => `
                <div class="list-item" style="margin-bottom: 8px; padding: 12px 14px;">
                    <div>
                        <div class="font-bold">${p.product} ${p.spec}</div>
                        <div class="text-sm text-gray">${p.supplier}</div>
                        <div class="text-xs text-gray-light mt-1">${p.weight}斤 × ¥${p.price}/斤</div>
                    </div>
                    <div class="text-right">
                        <div class="font-bold text-blue">¥${p.amount.toFixed(2)}</div>
                        <button class="btn btn-danger btn-sm" style="margin-top: 6px;" onclick="event.stopPropagation(); deletePurchase('${p.id}')">删除</button>
                    </div>
                </div>
            `).join('');
        }

        async function deletePurchase(id) {
            if (!confirm('确认删除该进货记录？')) return;
            try {
                showLoading('删除中...');
                await apiDelete('/api/purchases/' + id);
                await loadPurchases(getToday());
                renderPurchaseRecords();
                await loadHomeStats();
                showToast('进货记录已删除');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // ==================== 订单 ====================

        async function renderOrders() {
            const search = document.getElementById('order-search').value.toLowerCase();
            const date = document.getElementById('order-date').value;
            const listEl = document.getElementById('orders-list');

            document.getElementById('order-date-tip').textContent = `展示 ${date} 的订单`;

            // 如果日期变化，重新加载
            if (state.orders.length === 0 || state.orders[0]?.date !== date) {
                try {
                    showLoading('加载中...');
                    await loadOrders({ date: date, status: 'pending_ship,shipped' });
                } catch (err) {
                } finally {
                    hideLoading();
                }
            }

            let filtered = state.orders.filter(o => {
                const inOrderModule = o.status === 'pending_ship' || o.status === 'shipped';
                const matchSearch = o.customer.toLowerCase().includes(search) ||
                                   o.product.includes(search) ||
                                   o.spec.includes(search);
                return inOrderModule && matchSearch;
            });

            if (filtered.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state">
                        <div class="icon">📋</div>
                        <div>该日期暂无待处理订单</div>
                        <div class="text-sm">去"预订单"添加新订单</div>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = filtered.map(order => {
                const status = statusMap[order.status];
                let actionHtml = '';

                if (order.status === 'pending_ship') {
                    actionHtml = `<button class="btn btn-orange btn-sm" onclick="event.stopPropagation(); openShipModal('${order.id}')">去发货</button>`;
                } else if (order.status === 'shipped') {
                    actionHtml = `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openPriceModal('${order.id}')">去定价</button>`;
                }

                return `
                    <div class="list-item">
                        <div style="flex: 1; min-width: 0;">
                            <div class="flex items-center gap-2 mb-1" style="flex-wrap: wrap;">
                                <span class="font-bold text-lg">${order.customer}</span>
                                <span class="status-tag ${status.class}">${status.text}</span>
                            </div>
                            <div class="text-gray">🦐 ${order.product} ${order.spec} × ${order.orderWeight}斤</div>
                            ${order.actualWeight ? `<div class="text-sm text-gray-light mt-1">实际发货：${order.actualWeight}斤</div>` : ''}
                            <div class="text-xs text-gray-light mt-1">单号：${order.id}</div>
                        </div>
                        <div class="text-right" style="flex-shrink: 0; margin-left: 12px;">
                            <div>${actionHtml}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function openShipModal(orderId) {
            const order = state.orders.find(o => o.id === orderId);
            if (!order) return;

            document.getElementById('modal-title').textContent = '发货确认';
            document.getElementById('modal-body').innerHTML = `
                <div class="order-info">
                    <div class="order-info-row">
                        <span class="text-gray">客户</span>
                        <span class="font-semibold">${order.customer}</span>
                    </div>
                    <div class="order-info-row">
                        <span class="text-gray">商品</span>
                        <span class="font-semibold">${order.product} ${order.spec}</span>
                    </div>
                    <div class="order-info-row">
                        <span class="text-gray">报货重量</span>
                        <span class="font-semibold">${order.orderWeight}斤</span>
                    </div>
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">实际发货重量（斤）</label>
                    <input type="number" class="form-input" id="ship-weight" placeholder="请输入实际发货重量" step="0.1" value="${order.orderWeight}">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmShip('${orderId}')">确认发货</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
        }

        async function confirmShip(orderId) {
            const weight = parseFloat(document.getElementById('ship-weight').value);
            if (!weight || weight <= 0) {
                showToast('请输入有效的发货重量', 'error');
                return;
            }
            try {
                showLoading('保存中...');
                await apiPut('/api/orders/' + orderId, { actualWeight: weight, status: 'shipped' });
                await loadOrders({ date: document.getElementById('order-date').value, status: 'pending_ship,shipped' });
                closeModal();
                renderOrders();
                await loadHomeStats();
                showToast('发货成功，状态已更新为：已发货');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        function openPriceModal(orderId) {
            const order = state.orders.find(o => o.id === orderId);
            if (!order) return;

            document.getElementById('modal-title').textContent = '输入单价';
            document.getElementById('modal-body').innerHTML = `
                <div class="order-info">
                    <div class="order-info-row">
                        <span class="text-gray">客户</span>
                        <span class="font-semibold">${order.customer}</span>
                    </div>
                    <div class="order-info-row">
                        <span class="text-gray">商品</span>
                        <span class="font-semibold">${order.product} ${order.spec}</span>
                    </div>
                    <div class="order-info-row">
                        <span class="text-gray">实际发货</span>
                        <span class="font-semibold">${order.actualWeight}斤</span>
                    </div>
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">单价（元/斤）</label>
                    <input type="number" class="form-input" id="order-price" placeholder="请输入单价" step="0.1">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmPrice('${orderId}')">确认定价</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
        }

        async function confirmPrice(orderId) {
            const price = parseFloat(document.getElementById('order-price').value);
            if (!price || price <= 0) {
                showToast('请输入有效的单价', 'error');
                return;
            }
            try {
                showLoading('保存中...');
                const result = await apiPut('/api/orders/' + orderId, { price: price, status: 'pending_bill' });
                await loadOrders({ date: document.getElementById('order-date').value, status: 'pending_ship,shipped' });
                closeModal();
                renderOrders();
                await loadHomeStats();
                showToast(`定价成功，该订单已自动转入客户模块。金额：¥${(result.amount || 0).toFixed(2)}`);
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // ==================== 客户 ====================

        function renderCustomers() {
            const listEl = document.getElementById('customers-list');
            const search = document.getElementById('customer-search')?.value?.toLowerCase() || '';

            let displayCustomers = state.customers;
            if (search) {
                displayCustomers = state.customers.filter(c => c.name.toLowerCase().includes(search));
            }

            if (displayCustomers.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state">
                        <div class="icon">👥</div>
                        <div>暂无客户</div>
                        <div class="text-sm">点击右上角添加</div>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = displayCustomers.map(c => {
                const customerOrders = state.orders.filter(o => o.customer === c.name);
                const pendingBillCount = customerOrders.filter(o => o.status === 'pending_bill').length;
                const unsettledAmount = customerOrders
                    .filter(o => o.status === 'unsettled' && !o.settled)
                    .reduce((sum, o) => sum + (o.amount || 0), 0);
                const unsettledCount = customerOrders.filter(o => o.status === 'unsettled').length;

                return `
                    <div class="list-item" onclick="viewCustomerOrders('${c.name}')">
                        <div class="flex items-center gap-3">
                            <div class="avatar avatar-blue">👤</div>
                            <div>
                                <div class="font-bold text-lg">${c.name}</div>
                                <div class="text-sm text-gray mt-1">
                                    ${c.phone ? `<span class="text-xs text-gray-light">📞 ${c.phone}</span>` : ''}
                                    ${c.settlement ? `<span class="text-xs text-gray-light ml-2">💳 ${c.settlement}</span>` : ''}
                                </div>
                                <div class="text-sm text-gray mt-1">
                                    ${pendingBillCount > 0 ? `<span class="status-tag status-pending_bill">${pendingBillCount} 单待开单</span>` : ''}
                                    ${unsettledCount > 0 ? `<span class="status-tag status-unsettled mt-1">${unsettledCount} 单未结算</span>` : ''}
                                </div>
                            </div>
                        </div>
                        <div class="text-right" style="flex-shrink: 0; margin-left: 12px;">
                            <div class="text-xl font-bold ${unsettledAmount > 0 ? 'text-red' : 'text-gray'}">¥${unsettledAmount.toFixed(2)}</div>
                            <div class="text-sm text-gray-light">未结金额</div>
                            <button class="btn btn-danger btn-sm" style="margin-top: 6px;" onclick="event.stopPropagation(); deleteCustomer('${c.name}')">删除</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function openAddCustomerModal() {
            document.getElementById('modal-title').textContent = '添加客户';
            document.getElementById('modal-body').innerHTML = `
                <div class="form-group">
                    <label class="form-label">客户名称</label>
                    <input type="text" class="form-input" id="new-customer-name" placeholder="请输入客户名称" autofocus>
                </div>
                <div class="form-group">
                    <label class="form-label">联系电话</label>
                    <input type="text" class="form-input" id="new-customer-phone" placeholder="选填">
                </div>
                <div class="form-group">
                    <label class="form-label">结算方式</label>
                    <select class="form-input" id="new-customer-settlement">
                        <option value="">请选择</option>
                        <option value="现结">现结</option>
                        <option value="月结">月结</option>
                        <option value="周结">周结</option>
                        <option value="赊账">赊账</option>
                    </select>
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">备注</label>
                    <input type="text" class="form-input" id="new-customer-remark" placeholder="选填">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmAddCustomer()">确认添加</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
            setTimeout(() => document.getElementById('new-customer-name').focus(), 100);
        }

        async function confirmAddCustomer() {
            const name = document.getElementById('new-customer-name').value.trim();
            const phone = document.getElementById('new-customer-phone').value.trim();
            const settlement = document.getElementById('new-customer-settlement').value;
            const remark = document.getElementById('new-customer-remark').value.trim();
            if (!name) {
                showToast('请输入客户名称', 'error');
                return;
            }
            try {
                showLoading('添加中...');
                await apiPost('/api/customers', { name, phone, settlement, remark });
                await loadCustomers();
                closeModal();
                renderCustomers();
                showToast('客户添加成功！');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        async function deleteCustomer(name) {
            if (!confirm(`确认删除客户「${name}」？`)) return;
            try {
                showLoading('删除中...');
                await apiDelete('/api/customers/' + encodeURIComponent(name));
                await loadCustomers();
                renderCustomers();
                showToast('客户已删除');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // 商品管理
        function renderProducts() {
            const listEl = document.getElementById('products-list');
            if (state.products.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state">
                        <div class="icon">📦</div>
                        <div>暂无商品</div>
                        <div class="text-sm">点击右上角添加</div>
                    </div>
                `;
                return;
            }
            listEl.innerHTML = state.products.map(p => `
                <div class="list-item" style="margin-bottom: 10px;">
                    <div class="flex items-center gap-3">
                        <div class="avatar avatar-blue">🦐</div>
                        <div>
                            <div class="font-bold text-lg">${p.name}</div>
                            <div class="text-sm text-gray mt-1">规格：${p.specs.join(' / ')}</div>
                        </div>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteProduct('${p.name}')">删除</button>
                </div>
            `).join('');
        }

        function openAddProductModal() {
            document.getElementById('modal-title').textContent = '添加商品';
            document.getElementById('modal-body').innerHTML = `
                <div class="form-group">
                    <label class="form-label">商品名称</label>
                    <input type="text" class="form-input" id="new-product-name" placeholder="如：基围虾" autofocus>
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">规格（多个用 / 分隔）</label>
                    <input type="text" class="form-input" id="new-product-specs" placeholder="如：20头/30头/40头">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmAddProduct()">确认添加</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
            setTimeout(() => document.getElementById('new-product-name').focus(), 100);
        }

        async function confirmAddProduct() {
            const name = document.getElementById('new-product-name').value.trim();
            const specsStr = document.getElementById('new-product-specs').value.trim();
            if (!name) {
                showToast('请输入商品名称', 'error');
                return;
            }
            if (!specsStr) {
                showToast('请输入商品规格', 'error');
                return;
            }
            try {
                showLoading('添加中...');
                await apiPost('/api/products', { name, specs: specsStr });
                await loadProducts();
                closeModal();
                renderProducts();
                showToast('商品添加成功！');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        async function deleteProduct(name) {
            if (!confirm('确认删除该商品？')) return;
            try {
                showLoading('删除中...');
                await apiDelete('/api/products/' + encodeURIComponent(name));
                await loadProducts();
                renderProducts();
                showToast('商品已删除');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // 查看客户订单
        async function viewCustomerOrders(customerName) {
            state.currentCustomer = customerName;
            state.selectedOrderIds.clear();
            document.getElementById('customer-orders-name').textContent = customerName + ' 的订单';
            try {
                showLoading('加载中...');
                await loadOrders({ customer: customerName });
                renderCustomerOrders();
                goPage('customer-orders');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        function renderCustomerOrders() {
            const listEl = document.getElementById('customer-orders-list');
            const customerOrders = state.orders.filter(o =>
                o.status === 'pending_bill' || o.status === 'unsettled' || o.status === 'settled'
            );

            if (customerOrders.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state">
                        <div class="icon">📋</div>
                        <div>该客户暂无订单</div>
                    </div>
                `;
                document.getElementById('billing-bar').style.display = 'none';
                return;
            }

            listEl.innerHTML = customerOrders.map(order => {
                const status = statusMap[order.status];
                const isSettled = order.status === 'settled';
                const checked = state.selectedOrderIds.has(order.id) ? 'checked' : '';
                const disabled = isSettled ? 'disabled' : '';
                const rowClass = isSettled ? 'opacity-60' : '';

                let actions = `
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openEditModal('${order.id}')">修改</button>
                `;

                return `
                    <div class="list-item ${rowClass}">
                        <div class="flex items-center gap-3" style="flex: 1; min-width: 0;">
                            <label class="checkbox-wrapper" onclick="event.stopPropagation(); toggleOrderSelect('${order.id}')">
                                <input type="checkbox" ${checked} ${disabled} onclick="event.stopPropagation(); toggleOrderSelect('${order.id}')">
                            </label>
                            <div>
                                <div class="flex items-center gap-2 mb-1" style="flex-wrap: wrap;">
                                    <span class="font-bold">${order.product} ${order.spec}</span>
                                    <span class="status-tag ${status.class}">${status.text}</span>
                                </div>
                                <div class="text-sm text-gray">${order.actualWeight}斤 × ¥${order.price}/斤</div>
                                <div class="text-xs text-gray-light mt-1">${order.date} · ${order.id}</div>
                            </div>
                        </div>
                        <div class="text-right" style="flex-shrink: 0; margin-left: 12px;">
                            <div class="text-xl font-bold text-blue">¥${(order.amount || 0).toFixed(2)}</div>
                            ${isSettled ? '<div class="text-sm text-gray-light">已结算</div>' : ''}
                            <div class="action-group" style="margin-top: 6px;">${actions}</div>
                        </div>
                    </div>
                `;
            }).join('');

            updateBillingBar();
        }

        function toggleOrderSelect(orderId) {
            const order = state.orders.find(o => o.id === orderId);
            if (order.status === 'settled') return;

            if (state.selectedOrderIds.has(orderId)) {
                state.selectedOrderIds.delete(orderId);
            } else {
                state.selectedOrderIds.add(orderId);
            }
            renderCustomerOrders();
        }

        function updateBillingBar() {
            const selectedOrders = state.orders.filter(o => state.selectedOrderIds.has(o.id));
            const count = selectedOrders.length;
            const amount = selectedOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

            const pendingBillCount = selectedOrders.filter(o => o.status === 'pending_bill').length;
            const unsettledCount = selectedOrders.filter(o => o.status === 'unsettled').length;

            document.getElementById('selected-count').textContent = count;
            document.getElementById('selected-amount').textContent = '¥' + amount.toFixed(2);
            document.getElementById('billing-bar').style.display = count > 0 ? 'flex' : 'none';

            const unifiedBtn = document.getElementById('btn-unified-bill');
            const settleBtn = document.getElementById('btn-settle-selected');

            unifiedBtn.textContent = pendingBillCount > 0 ? `统一开单（${pendingBillCount}单）` : '统一开单';
            unifiedBtn.disabled = pendingBillCount === 0;
            unifiedBtn.style.opacity = pendingBillCount === 0 ? '0.5' : '1';
            unifiedBtn.style.cursor = pendingBillCount === 0 ? 'not-allowed' : 'pointer';

            settleBtn.textContent = unsettledCount > 0 ? `结算选中（${unsettledCount}单）` : '结算选中';
            settleBtn.disabled = unsettledCount === 0;
            settleBtn.style.opacity = unsettledCount === 0 ? '0.5' : '1';
            settleBtn.style.cursor = unsettledCount === 0 ? 'not-allowed' : 'pointer';
        }

        // 修改订单
        function openEditModal(orderId) {
            const order = state.orders.find(o => o.id === orderId);
            if (!order) return;

            document.getElementById('modal-title').textContent = '修改订单';
            document.getElementById('modal-body').innerHTML = `
                <div class="order-info">
                    <div class="order-info-row">
                        <span class="text-gray">客户</span>
                        <span class="font-semibold">${order.customer}</span>
                    </div>
                    <div class="order-info-row">
                        <span class="text-gray">商品</span>
                        <span class="font-semibold">${order.product} ${order.spec}</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">实际发货重量（斤）</label>
                    <input type="number" class="form-input" id="edit-weight" value="${order.actualWeight || ''}" step="0.1">
                </div>
                <div class="form-group mb-0">
                    <label class="form-label">单价（元/斤）</label>
                    <input type="number" class="form-input" id="edit-price" value="${order.price || ''}" step="0.1">
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmEdit('${orderId}')">保存修改</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
        }

        async function confirmEdit(orderId) {
            const weight = parseFloat(document.getElementById('edit-weight').value);
            const price = parseFloat(document.getElementById('edit-price').value);

            if (!weight || weight <= 0 || !price || price <= 0) {
                showToast('请输入有效的重量和单价', 'error');
                return;
            }

            try {
                showLoading('保存中...');
                await apiPut('/api/orders/' + orderId, { actualWeight: weight, price: price, status: 'pending_bill' });
                await loadOrders({ customer: state.currentCustomer });
                state.selectedOrderIds.delete(orderId);
                closeModal();
                renderCustomerOrders();
                renderCustomers();
                await loadHomeStats();
                showToast('修改成功，订单状态已更新为：未开单');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // 统一开单
        function openUnifiedBillModal() {
            const selectedOrders = state.orders.filter(o => state.selectedOrderIds.has(o.id) && o.status === 'pending_bill');
            if (selectedOrders.length === 0) {
                showToast('请选择未开单的订单进行统一开单', 'error');
                return;
            }
            const totalAmount = selectedOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

            document.getElementById('modal-title').textContent = '统一开单';
            document.getElementById('modal-body').innerHTML = `
                <div class="mb-4">
                    <div class="text-sm text-gray mb-2">客户：${state.currentCustomer}</div>
                    <div class="text-sm text-gray mb-3">共 ${selectedOrders.length} 笔订单</div>
                    ${selectedOrders.map(order => `
                        <div class="bill-item">
                            <div>
                                <div class="font-semibold">${order.product} ${order.spec}</div>
                                <div class="text-sm text-gray">${order.actualWeight}斤 × ¥${order.price}/斤</div>
                            </div>
                            <div class="font-bold text-blue">¥${(order.amount || 0).toFixed(2)}</div>
                        </div>
                    `).join('')}
                    <div class="summary-total" style="margin-top: 16px;">
                        <span class="font-bold">合计金额</span>
                        <span class="summary-price">¥${totalAmount.toFixed(2)}</span>
                    </div>
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-yellow" onclick="confirmUnifiedBill()">确认开单</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
        }

        async function confirmUnifiedBill() {
            const ids = Array.from(state.selectedOrderIds).filter(id => {
                const order = state.orders.find(o => o.id === id);
                return order && order.status === 'pending_bill';
            });
            if (ids.length === 0) return;

            try {
                showLoading('开单中...');
                await apiPost('/api/orders/bill', { ids, customer: state.currentCustomer });
                await loadOrders({ customer: state.currentCustomer });
                state.selectedOrderIds.clear();
                closeModal();
                renderCustomerOrders();
                renderCustomers();
                await loadHomeStats();
                showToast('统一开单成功！订单状态已更新为：未结算');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // 结算选中订单
        function openSettleSelectedModal() {
            const selectedOrders = state.orders.filter(o => state.selectedOrderIds.has(o.id) && o.status === 'unsettled');
            if (selectedOrders.length === 0) {
                showToast('请选择未结算的订单进行结算', 'error');
                return;
            }
            const totalAmount = selectedOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

            document.getElementById('modal-title').textContent = '结算确认';
            document.getElementById('modal-body').innerHTML = `
                <div class="mb-4">
                    <div class="text-sm text-gray mb-2">客户：${state.currentCustomer}</div>
                    <div class="text-sm text-gray mb-3">共 ${selectedOrders.length} 笔未结算订单</div>
                    ${selectedOrders.map(order => `
                        <div class="bill-item">
                            <div>
                                <div class="font-semibold">${order.product} ${order.spec}</div>
                                <div class="text-sm text-gray">${order.actualWeight}斤 × ¥${order.price}/斤</div>
                            </div>
                            <div class="font-bold text-blue">¥${(order.amount || 0).toFixed(2)}</div>
                        </div>
                    `).join('')}
                    <div class="summary-total" style="margin-top: 16px;">
                        <span class="font-bold">结算金额</span>
                        <span class="summary-price">¥${totalAmount.toFixed(2)}</span>
                    </div>
                </div>
            `;
            document.getElementById('modal-footer').innerHTML = `
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="confirmSettleSelected()">确认结算</button>
            `;
            document.getElementById('modal-overlay').classList.add('show');
        }

        async function confirmSettleSelected() {
            const ids = Array.from(state.selectedOrderIds).filter(id => {
                const order = state.orders.find(o => o.id === id);
                return order && order.status === 'unsettled';
            });
            if (ids.length === 0) return;

            try {
                showLoading('结算中...');
                await apiPost('/api/orders/settle', { ids });
                await loadOrders({ customer: state.currentCustomer });
                state.selectedOrderIds.clear();
                closeModal();
                renderCustomerOrders();
                renderCustomers();
                await loadHomeStats();
                showToast('结算成功！');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        // 关闭模态框
        function closeModal() {
            document.getElementById('modal-overlay').classList.remove('show');
        }

        // ==================== 首页数据穿透 ====================

        async function showStatDetail(type) {
            if (!isConfigValid()) {
                showToast('请先配置 API_BASE', 'error');
                return;
            }

            const titleEl = document.getElementById('stat-detail-title');
            const iconEl = document.getElementById('stat-detail-icon');
            const summaryEl = document.getElementById('stat-detail-summary');
            const listEl = document.getElementById('stat-detail-list');

            let title = '';
            let icon = '';

            try {
                showLoading('加载中...');
                const today = getToday();
                let data;

                switch (type) {
                    case 'today-sales':
                        title = '今日销售额明细';
                        icon = '💰';
                        data = await apiGet('/api/details/today-sales?date=' + today);
                        summaryEl.textContent = `共 ${data.count} 笔，合计 ¥${(data.total || 0).toFixed(2)}`;
                        listEl.innerHTML = renderOrderDetailList(data.items || []);
                        break;
                    case 'today-deals':
                        title = '今日成交笔数明细';
                        icon = '🤝';
                        data = await apiGet('/api/details/today-deals?date=' + today);
                        summaryEl.textContent = `今日共成交 ${data.count} 笔`;
                        listEl.innerHTML = renderOrderDetailList(data.items || []);
                        break;
                    case 'today-purchase':
                        title = '今日进货金额明细';
                        icon = '🚚';
                        data = await apiGet('/api/details/today-purchase?date=' + today);
                        summaryEl.textContent = `共 ${data.count} 笔进货，合计 ¥${(data.total || 0).toFixed(2)}`;
                        listEl.innerHTML = renderPurchaseDetailList(data.items || []);
                        break;
                    case 'month-sales':
                        title = '本月销售额明细';
                        icon = '📅';
                        data = await apiGet('/api/details/month-sales?date=' + today);
                        summaryEl.textContent = `本月共 ${data.count} 笔，合计 ¥${(data.total || 0).toFixed(2)}`;
                        listEl.innerHTML = renderOrderDetailList(data.items || []);
                        break;
                }

                titleEl.textContent = title;
                iconEl.textContent = icon;
                goPage('stat-detail');
            } catch (err) {
            } finally {
                hideLoading();
            }
        }

        function renderOrderDetailList(items) {
            if (items.length === 0) {
                return `
                    <div class="empty-state">
                        <div class="icon">📋</div>
                        <div>暂无数据</div>
                    </div>
                `;
            }
            return items.map(order => {
                const status = statusMap[order.status];
                return `
                    <div class="list-item" style="margin-bottom: 10px;">
                        <div style="flex: 1; min-width: 0;">
                            <div class="flex items-center gap-2 mb-1" style="flex-wrap: wrap;">
                                <span class="font-bold">${order.customer}</span>
                                ${status ? `<span class="status-tag ${status.class}">${status.text}</span>` : ''}
                            </div>
                            <div class="text-sm text-gray">${order.product} ${order.spec} · ${order.actualWeight}斤 × ¥${order.price}/斤</div>
                            <div class="text-xs text-gray-light mt-1">${order.date}</div>
                        </div>
                        <div class="text-right" style="flex-shrink: 0; margin-left: 12px;">
                            <div class="text-xl font-bold text-blue">¥${(order.amount || 0).toFixed(2)}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderPurchaseDetailList(items) {
            if (items.length === 0) {
                return `
                    <div class="empty-state">
                        <div class="icon">🏭</div>
                        <div>暂无进货记录</div>
                    </div>
                `;
            }
            return items.map(p => `
                <div class="list-item" style="margin-bottom: 10px;">
                    <div style="flex: 1; min-width: 0;">
                        <div class="font-bold mb-1">${p.product} ${p.spec}</div>
                        <div class="text-sm text-gray">供应商：${p.supplier}</div>
                        <div class="text-sm text-gray">${p.weight}斤 × ¥${p.price}/斤</div>
                        <div class="text-xs text-gray-light mt-1">${p.date}</div>
                    </div>
                    <div class="text-right" style="flex-shrink: 0; margin-left: 12px;">
                        <div class="text-xl font-bold text-blue">¥${p.amount.toFixed(2)}</div>
                    </div>
                </div>
            `).join('');
        }

        // ==================== 数据导出 ====================

        function exportData() {
            showToast('数据导出功能开发中，请先在飞书多维表格中导出', 'error');
        }

        // ==================== 初始化 ====================

        async function init() {
            document.getElementById('preorder-date').value = getToday();

            if (!isConfigValid()) {
                document.getElementById('api-config-tip').style.display = 'block';
                showToast('请先配置 API_BASE 环境变量', 'error');
                return;
            }

            try {
                showLoading('初始化中...');
                await loadHomeStats();
                hideLoading();
            } catch (err) {
                hideLoading();
            }
        }

        const legacyHandlers = {
            closeModal,
            confirmAddCustomer,
            confirmAddProduct,
            confirmAddSupplier,
            confirmEdit,
            confirmPrice,
            confirmSettleSelected,
            confirmShip,
            confirmUnifiedBill,
            deleteCustomer,
            deleteProduct,
            deletePurchase,
            deleteSupplier,
            exportData,
            goPage,
            openAddCustomerModal,
            openAddProductModal,
            openAddSupplierModal,
            openEditModal,
            openPriceModal,
            openSettleSelectedModal,
            openShipModal,
            openUnifiedBillModal,
            renderCustomers,
            renderOrders,
            savePreorder,
            savePurchase,
            selectCustomer,
            selectPreorderSpec,
            selectPurchaseSpec,
            showStatDetail,
            toggleOrderSelect,
            viewCustomerOrders
        };
        Object.assign(globalThis, legacyHandlers);
        if (window !== globalThis) Object.assign(window, legacyHandlers);

        async function bootstrap() {
            if (!authStore.getToken()) {
                showLogin();
                return;
            }
            showApplication();
            await init();
        }

        export const appReady = bootstrap();
