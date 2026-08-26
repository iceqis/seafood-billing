import { createApiClient, RequestCancelled } from './api-client.js';
import { createAuthStore, login } from './auth.js';
import { APP_CONFIG } from './config.js';
import { state } from './state.js';
import { getLocalDate, hideLoading, setText, showToast } from './utils.js';
import { createHomePage } from './pages/home.js';
import { createPreorderPage } from './pages/preorder.js';
import { createOrdersPage } from './pages/orders.js';
import { createCustomersPage } from './pages/customers.js';
import { createPurchasesPage } from './pages/purchases.js';
import { createProductsPage } from './pages/products.js';
import { createProfilePage } from './pages/profile.js';

const apiBase = APP_CONFIG.apiBase;
function getStorage() { try { return globalThis.localStorage; } catch { return null; } }
const authStore = createAuthStore(getStorage());
let sessionVersion = 0; let loginInFlight = null; let pages;

function clearBusinessState() { state.customers = []; state.suppliers = []; state.products = []; state.orders = []; state.purchases = []; state.currentCustomer = ''; state.selectedOrderIds.clear(); }
function showLogin(message = '') { document.getElementById('app-container').hidden = true; document.getElementById('login-view').hidden = false; setText(document.getElementById('login-message'), message); document.getElementById('login-password').value = ''; }
function showApplication() { document.getElementById('login-view').hidden = true; document.getElementById('app-container').hidden = false; setText(document.getElementById('login-message'), ''); }
function invalidateSession(message = '') { sessionVersion += 1; apiClient.cancelAll(); authStore.clear(); clearBusinessState(); hideLoading(); showLogin(message); }
function activateSession(token) { sessionVersion += 1; apiClient.cancelAll(); authStore.saveToken(token); }
function handleUnauthorized(context) { if (context?.sessionVersion !== sessionVersion || context?.token !== authStore.getToken()) return; invalidateSession('登录已过期，请重新登录'); }

const apiClient = createApiClient({ apiBase, getToken: () => authStore.getToken(), getSessionVersion: () => sessionVersion, onUnauthorized: handleUnauthorized, timeoutMs: APP_CONFIG.requestTimeoutMs });
function validConfig() { return apiBase && !apiBase.includes('你的-worker地址'); }
async function apiRequest(request) { if (!validConfig()) { document.getElementById('api-config-tip').style.display = 'block'; throw new Error('请先配置 API_BASE'); } try { return await request(); } catch (error) { if (!(error instanceof RequestCancelled)) { try { Object.defineProperty(error, 'reported', { value: true, configurable: true }); } catch {} showToast(error.message || '网络错误', 'error'); } throw error; } }
const api = { get: (path) => apiRequest(() => apiClient.get(path)), post: (path, body) => apiRequest(() => apiClient.post(path, body)), put: (path, body) => apiRequest(() => apiClient.put(path, body)), delete: (path) => apiRequest(() => apiClient.delete(path)) };

function navigate(pageName) {
  document.querySelectorAll('.page-section').forEach((section) => section.classList.toggle('active', section.id === `page-${pageName}`));
  document.querySelectorAll('.nav-btn, .mobile-nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.page === pageName));
  document.getElementById('mobile-menu').classList.remove('show'); document.getElementById('mobile-menu-btn').setAttribute('aria-expanded', 'false'); window.scrollTo(0, 0);
  if (pages?.[pageName]) void pages[pageName].enter().catch(() => {});
}
const deps = { api, state, today: () => getLocalDate(), version: APP_CONFIG.version, navigate, logout: () => invalidateSession(), showToast, onStats: () => pages?.home?.enter() };
pages = { home: createHomePage(deps), preorder: createPreorderPage(deps), orders: createOrdersPage(deps), customers: createCustomersPage(deps), purchase: createPurchasesPage(deps), products: createProductsPage(deps), me: createProfilePage(deps) };

async function performLogin() {
  const input = document.getElementById('login-password'); const button = document.getElementById('login-submit'); const password = input.value; input.value = ''; button.disabled = true; setText(button, '正在安全验证…'); setText(document.getElementById('login-message'), ''); let saved = false;
  try { const token = await login(apiBase, password); activateSession(token); saved = true; showApplication(); await pages.home.enter(); } catch (error) { if (!saved) setText(document.getElementById('login-message'), error.message || '登录失败，请重试'); } finally { button.disabled = false; setText(button, '登录'); loginInFlight = null; }
}
function bindShell() {
  document.getElementById('login-form').addEventListener('submit', (event) => { event.preventDefault(); if (!loginInFlight) loginInFlight = performLogin(); });
  document.querySelectorAll('.nav-btn, .mobile-nav-btn').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  document.getElementById('mobile-menu-btn').addEventListener('click', (event) => { const open = document.getElementById('mobile-menu').classList.toggle('show'); event.currentTarget.setAttribute('aria-expanded', String(open)); });
  document.querySelector('.modal-close')?.addEventListener('click', () => document.getElementById('modal-overlay').classList.remove('show'));
}
async function bootstrap() { bindShell(); if (!authStore.getToken()) { showLogin(); return; } showApplication(); try { await pages.home.enter(); } catch { /* API errors are surfaced by the client. */ } }
export const appReady = bootstrap();
