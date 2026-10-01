import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import {
  getSuppliersList,
  saveSuppliersList,
  executeMultiSupplierSync,
  start30sMultiSupplierLoop,
  stop30sMultiSupplierLoop,
  recordAuditLog,
  readJsonFile,
  writeJsonFile,
  normalizeColor,
  Supplier,
} from './src/supplierEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const BACKUP_DIR = path.resolve(__dirname, 'data', 'backups');

// Version tracking for SyncBridge
let syncVersions = {
  overall: Date.now(),
  products: 1,
  orders: 1,
  settings: 1,
  coupons: 1,
};

// ============================================================================
// 1. Password Hashing & Verification (Scrypt) - Rule 19 & Patch Item 4
// ============================================================================

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, storedHash?: string): boolean {
  if (!password || !storedHash) return false;
  // Strictly enforce secure scrypt hash - no plain text fallback (Patch Item 4)
  if (!storedHash.startsWith('scrypt$')) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const hash = parts[2];
  try {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
}

// ============================================================================
// 2. Real Session-Backed Admin Authorization - Patch Item 1 & 2
// ============================================================================

interface AdminSession {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

const activeAdminSessions = new Map<string, AdminSession>();

// Initialize default admin session seed for development persistence
const SEED_ADMIN_TOKEN = `adm_token_system_${crypto.randomBytes(16).toString('hex')}`;
activeAdminSessions.set(SEED_ADMIN_TOKEN, {
  token: SEED_ADMIN_TOKEN,
  username: 'admin',
  createdAt: Date.now(),
  expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
});

function requireAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || '';
  const xAdminToken = (req.headers['x-admin-token'] as string) || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : xAdminToken;

  if (!token) {
    recordAuditLog(
      'unauthorized_admin_access',
      `تلاش برای دسترسی بدون توکن مدیریت به مسیر ${req.path}`,
      'anonymous',
      { ip: req.ip, path: req.path }
    );
    return res.status(401).json({ error: 'دسترسی غیرمجاز: توکن معتبر مدیریت الزامی است.' });
  }

  // Verify against active server session store (Patch Item 1)
  const session = activeAdminSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeAdminSessions.delete(token);
    recordAuditLog(
      'unauthorized_admin_access',
      `تلاش با توکن نامعتبر یا منقضی‌شده به مسیر ${req.path}`,
      'anonymous',
      { ip: req.ip, path: req.path }
    );
    return res.status(401).json({ error: 'دسترسی غیرمجاز: نشست کاربری نامعتبر یا منقضی شده است.' });
  }

  (req as any).adminUser = session.username;
  next();
}

// ============================================================================
// 3. Server Initialization (Static Assets only, NO public /data - Patch Item 3)
// ============================================================================

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Patch Item 3: STRICTLY DO NOT serve /data statically! Protects internal database JSON files.
  app.use('/data', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Only public assets are served:
  app.use('/assets', express.static(path.resolve(__dirname, 'public/assets')));
  app.use('/public', express.static(path.resolve(__dirname, 'public')));
  app.use(express.static(path.resolve(__dirname, 'public')));

  // ==========================================================================
  // Catalog & Products APIs
  // ==========================================================================

  app.get('/api/sync/bundle', (req, res) => {
    const products = readJsonFile(path.join(DATA_DIR, 'products.json'), []);
    const orders = readJsonFile(path.join(DATA_DIR, 'orders.json'), []);
    const settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), {});
    const coupons = readJsonFile(path.join(DATA_DIR, 'coupons.json'), []);
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const safeUsers = users.map(({ password, salt, ...safeUser }) => safeUser);

    res.json({
      success: true,
      timestamp: Date.now(),
      versions: syncVersions,
      data: {
        products,
        orders,
        settings,
        coupons,
        users: safeUsers,
      },
    });
  });

  app.get('/api/products', (req, res) => {
    const products = readJsonFile(path.join(DATA_DIR, 'products.json'), []);
    res.json(products);
  });

  // Protected: Only Admin can update Master Products (Patch Item 2)
  app.post('/api/products', requireAdminAuth, (req, res) => {
    const productsData = req.body.products || req.body;
    if (Array.isArray(productsData)) {
      const existing = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
      if (productsData.length > 0 || existing.length === 0) {
        writeJsonFile(path.join(DATA_DIR, 'products.json'), productsData);
        syncVersions.products += 1;
        syncVersions.overall = Date.now();
        recordAuditLog(
          'products_updated',
          `لیست محصولات پازل کالا به‌روزرسانی شد. تعداد کالاها: ${productsData.length}`,
          'admin'
        );
      }
      return res.json({ success: true, count: productsData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected products array' });
  });

  // ==========================================================================
  // Orders APIs
  // ==========================================================================

  app.get('/api/orders', (req, res) => {
    const orders = readJsonFile(path.join(DATA_DIR, 'orders.json'), []);
    res.json(orders);
  });

  // Customer order creation (or bulk update by admin)
  app.post('/api/orders', (req, res) => {
    const ordersData = req.body.orders || req.body;
    const existing = readJsonFile<any[]>(path.join(DATA_DIR, 'orders.json'), []);

    if (Array.isArray(ordersData)) {
      // Bulk update requires admin auth
      const authHeader = req.headers.authorization || '';
      const xAdminToken = (req.headers['x-admin-token'] as string) || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : xAdminToken;
      if (!token || !activeAdminSessions.has(token)) {
        return res.status(401).json({ error: 'دسترسی غیرمجاز: تغییر دسته‌ای سفارشات نیازمند ورود مدیر است.' });
      }
      writeJsonFile(path.join(DATA_DIR, 'orders.json'), ordersData);
      syncVersions.orders += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: ordersData.length, version: syncVersions });
    } else if (ordersData && typeof ordersData === 'object') {
      // Single customer checkout order submission
      existing.unshift(ordersData);
      writeJsonFile(path.join(DATA_DIR, 'orders.json'), existing);
      syncVersions.orders += 1;
      syncVersions.overall = Date.now();
      recordAuditLog('order_created', `سفارش جدید ثبت شد: ${ordersData.id || ordersData.orderNumber || ''}`, 'customer');
      return res.json({ success: true, order: ordersData });
    }
    res.status(400).json({ error: 'Invalid order data' });
  });

  // Protected: Bulk order update requires Admin Auth (Patch Item 2)
  app.put('/api/orders', requireAdminAuth, (req, res) => {
    const ordersData = req.body.orders || req.body;
    if (Array.isArray(ordersData)) {
      writeJsonFile(path.join(DATA_DIR, 'orders.json'), ordersData);
      syncVersions.orders += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: ordersData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected orders array' });
  });

  // ==========================================================================
  // Settings & Coupons & Users APIs (Protected with requireAdminAuth)
  // ==========================================================================

  app.get('/api/settings', (req, res) => {
    const settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), {});
    res.json(settings);
  });

  app.post('/api/settings', requireAdminAuth, (req, res) => {
    const newSettings = req.body;
    if (typeof newSettings === 'object' && newSettings !== null) {
      writeJsonFile(path.join(DATA_DIR, 'settings.json'), newSettings);
      syncVersions.settings += 1;
      syncVersions.overall = Date.now();
      recordAuditLog('settings_updated', 'تنظیمات کلی فروشگاه ذخیره شد', 'admin');
      return res.json({ success: true, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected settings object' });
  });

  app.get('/api/coupons', (req, res) => {
    const coupons = readJsonFile(path.join(DATA_DIR, 'coupons.json'), []);
    res.json(coupons);
  });

  app.post('/api/coupons', requireAdminAuth, (req, res) => {
    const couponsData = req.body.coupons || req.body;
    if (Array.isArray(couponsData)) {
      writeJsonFile(path.join(DATA_DIR, 'coupons.json'), couponsData);
      syncVersions.coupons += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: couponsData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected coupons array' });
  });

  app.get('/api/users', (req, res) => {
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const safeUsers = users.map(({ password, salt, ...safeUser }) => safeUser);
    res.json(safeUsers);
  });

  app.post('/api/users', requireAdminAuth, (req, res) => {
    const usersData = req.body.users || req.body;
    if (Array.isArray(usersData)) {
      const existing = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
      const merged = usersData.map((u: any) => {
        const prev = existing.find((p) => p.id === u.id || p.username === u.username);
        return {
          ...u,
          password: prev ? prev.password : hashPassword('123456'),
        };
      });
      writeJsonFile(path.join(DATA_DIR, 'users.json'), merged);
      recordAuditLog('users_updated', `لیست کاربران فروشگاه به‌روزرسانی شد. تعداد: ${merged.length}`, 'admin');
      return res.json({ success: true, count: merged.length });
    }
    res.status(400).json({ error: 'Expected users array' });
  });

  // ==========================================================================
  // Authentication & Admin Credentials APIs
  // ==========================================================================

  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (!password || typeof password !== 'string' || !password.trim()) {
      recordAuditLog('admin_login_failed', `ورود ناموفق با نام کاربری '${username}': رمز عبور خالی ارسال شد.`, username || 'unknown');
      return res.status(400).json({ error: 'رمز عبور نمی‌تواند خالی باشد.' });
    }
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'نام کاربری الزامی است.' });
    }

    const cleanUser = username.trim();
    const cleanPass = password.trim();

    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const adminUser = users.find(
      (u) => (u.role === 'admin' || u.username === 'admin') && u.username === cleanUser
    );

    if (!adminUser) {
      recordAuditLog('admin_login_failed', `ورود ناموفق: کاربر مدیریتی '${cleanUser}' یافت نشد.`, cleanUser);
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور نامعتبر است' });
    }

    const isValid = verifyPassword(cleanPass, adminUser.password);
    if (!isValid) {
      recordAuditLog('admin_login_failed', `ورود ناموفق: رمز عبور اشتباه برای مدیر '${cleanUser}'.`, cleanUser);
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور نامعتبر است' });
    }

    // Generate real secure session token (Patch Item 1)
    const token = `adm_token_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
    activeAdminSessions.set(token, {
      token,
      username: cleanUser,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
    });

    recordAuditLog('admin_login', `ورود موفق مدیر سیستم: ${cleanUser}`, cleanUser);
    const { password: _, salt: __, ...safeAdmin } = adminUser;
    res.json({
      success: true,
      token,
      user: safeAdmin,
    });
  });

  app.post('/api/admin/change-credentials', requireAdminAuth, (req, res) => {
    const { username, password, name, phone } = req.body;

    if (!password || typeof password !== 'string' || password.trim().length < 4) {
      return res.status(400).json({ error: 'رمز عبور جدید باید حداقل ۴ کاراکتر باشد.' });
    }

    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const adminIdx = users.findIndex((u) => u.role === 'admin' || u.username === 'admin');

    if (adminIdx === -1) {
      return res.status(404).json({ error: 'حساب کاربری مدیریت یافت نشد.' });
    }

    const cleanPass = password.trim();
    users[adminIdx].password = hashPassword(cleanPass);
    if (username && username.trim()) users[adminIdx].username = username.trim();
    if (name && name.trim()) users[adminIdx].name = name.trim();
    if (phone && phone.trim()) users[adminIdx].phone = phone.trim();

    writeJsonFile(path.join(DATA_DIR, 'users.json'), users);

    const token = `adm_token_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
    activeAdminSessions.set(token, {
      token,
      username: users[adminIdx].username,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
    });

    recordAuditLog('admin_credentials_changed', `اطلاعات حساب کاربری مدیر تغییر یافت: ${users[adminIdx].username}`, users[adminIdx].username);
    const { password: _, salt: __, ...safeAdmin } = users[adminIdx];
    res.json({
      success: true,
      message: 'مشخصات مدیر با موفقیت به‌روزرسانی شد.',
      token,
      user: safeAdmin,
    });
  });

  // Protected Clear Data with Backup (Rule 20 & Patch Item 24)
  app.post('/api/admin/clear-data', requireAdminAuth, (req, res) => {
    const { scope, confirmed } = req.body;

    if (!confirmed) {
      return res.status(400).json({ error: 'تأیید صریح (confirmed: true) برای پاک‌سازی داده‌ها الزامی است.' });
    }

    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupTs = Date.now();

    try {
      if (scope === 'orders' || scope === 'all') {
        const ordersFile = path.join(DATA_DIR, 'orders.json');
        if (fs.existsSync(ordersFile)) {
          fs.copyFileSync(ordersFile, path.join(BACKUP_DIR, `orders_${backupTs}.json`));
          writeJsonFile(ordersFile, []);
        }
      }

      if (scope === 'audit_logs' || scope === 'all') {
        const auditFile = path.join(DATA_DIR, 'audit_logs.json');
        if (fs.existsSync(auditFile)) {
          fs.copyFileSync(auditFile, path.join(BACKUP_DIR, `audit_logs_${backupTs}.json`));
          writeJsonFile(auditFile, []);
        }
      }

      if (scope === 'wallet_transactions' || scope === 'all') {
        const walletFile = path.join(DATA_DIR, 'wallet_transactions.json');
        if (fs.existsSync(walletFile)) {
          fs.copyFileSync(walletFile, path.join(BACKUP_DIR, `wallet_transactions_${backupTs}.json`));
          writeJsonFile(walletFile, []);
        }
      }

      recordAuditLog('data_cleared', `عملیات پاک‌سازی داده‌ها در محدوده '${scope}' انجام شد.`, 'admin', { scope, backupTs });

      res.json({
        success: true,
        message: `داده‌ها در محدوده ${scope} با موفقیت پاک‌سازی شدند. فایل پشتیبان با شناسه ${backupTs} ذخیره شد.`,
        backupId: backupTs,
      });
    } catch (err: any) {
      res.status(500).json({ error: `خطا در پاک‌سازی داده‌ها: ${err.message}` });
    }
  });

  // Customer Login
  app.post('/api/auth/login', (req, res) => {
    const { phone, username, password } = req.body;

    if (!password || typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ error: 'رمز عبور نمی‌تواند خالی باشد.' });
    }

    const cleanPass = password.trim();
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const user = users.find((u) => (phone && u.phone === phone) || (username && u.username === username));

    if (!user) {
      return res.status(401).json({ error: 'کاربری با این مشخصات یافت نشد' });
    }

    const isValid = verifyPassword(cleanPass, user.password);
    if (!isValid) {
      recordAuditLog('customer_login_failed', `تلاش برای ورود ناموفق کاربر: ${user.phone || user.username}`, user.username || 'user');
      return res.status(401).json({ error: 'رمز عبور اشتباه است' });
    }

    recordAuditLog('customer_login', `ورود کاربر: ${user.name || user.phone}`, user.username || 'user');
    const { password: _, salt: __, ...safeUser } = user;
    res.json({
      success: true,
      user: safeUser,
      token: `usr_token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    });
  });

  // Customer Registration
  app.post('/api/auth/register', (req, res) => {
    const { name, phone, username, password, nationalCode } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'شماره تلفن همراه و رمز عبور الزامی است.' });
    }

    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const existing = users.find((u) => u.phone === phone || (username && u.username === username));

    if (existing) {
      return res.status(400).json({ error: 'این شماره تلفن همراه یا نام کاربری قبلاً ثبت شده است.' });
    }

    const newUser = {
      id: `usr-${Date.now()}`,
      name: name || `کاربر ${phone.slice(-4)}`,
      phone,
      username: username || phone,
      password: hashPassword(password.trim()),
      role: 'customer',
      nationalCode: nationalCode || '',
      addresses: [],
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    writeJsonFile(path.join(DATA_DIR, 'users.json'), users);

    recordAuditLog('customer_registered', `ثبت‌نام کاربر جدید: ${newUser.name} (${newUser.phone})`, newUser.username);
    const { password: _, ...safeUser } = newUser;
    res.json({
      success: true,
      user: safeUser,
      token: `usr_token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    });
  });

  // Audit Logs (Protected with requireAdminAuth)
  app.get('/api/admin/audit-logs', requireAdminAuth, (req, res) => {
    const logs = readJsonFile<any[]>(path.join(DATA_DIR, 'audit_logs.json'), []);
    res.json(logs);
  });

  // ==========================================================================
  // Multi-Supplier Management APIs (Rule 3, 13, 17, 18, 22)
  // ==========================================================================

  app.get('/api/suppliers', (req, res) => {
    const suppliers = getSuppliersList();
    res.json({ success: true, suppliers });
  });

  app.post('/api/suppliers', requireAdminAuth, (req, res) => {
    const { name, baseUrl, connectionType } = req.body;
    if (!name || !baseUrl) {
      return res.status(400).json({ error: 'نام تأمین‌کننده و آدرس پایه (Base URL) الزامی است.' });
    }

    const suppliers = getSuppliersList();
    const id = `sup-${Date.now().toString(36)}`;
    const newSupplier: Supplier = {
      id,
      name,
      enabled: true,
      baseUrl,
      connectionType: connectionType || 'api_feed',
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      status: 'disconnected',
      matchedCount: 0,
      ambiguousCount: 0,
      variantsCount: 0,
      inStockColorsCount: 0,
    };

    suppliers.push(newSupplier);
    saveSuppliersList(suppliers);
    recordAuditLog('supplier_added', `تأمین‌کننده جدید اضافه شد: ${name}`, 'admin');
    res.json({ success: true, supplier: newSupplier });
  });

  app.post('/api/suppliers/:id/toggle', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const suppliers = getSuppliersList();
    const supplier = suppliers.find((s) => s.id === id);
    if (!supplier) {
      return res.status(404).json({ error: 'تأمین‌کننده یافت نشد.' });
    }

    supplier.enabled = !supplier.enabled;
    saveSuppliersList(suppliers);
    recordAuditLog(
      'supplier_toggled',
      `وضعیت تأمین‌کننده ${supplier.name} تغییر یافت: ${supplier.enabled ? 'فعال' : 'غیرفعال'}`,
      'admin'
    );
    res.json({ success: true, supplier });
  });

  app.put('/api/suppliers/:id', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    const { name, baseUrl, connectionType, enabled } = req.body;

    const suppliers = getSuppliersList();
    const supplier = suppliers.find((s) => s.id === id);
    if (!supplier) {
      return res.status(404).json({ error: 'تأمین‌کننده یافت نشد.' });
    }

    if (name) supplier.name = name;
    if (baseUrl) supplier.baseUrl = baseUrl;
    if (connectionType) supplier.connectionType = connectionType;
    if (typeof enabled === 'boolean') supplier.enabled = enabled;

    saveSuppliersList(suppliers);
    recordAuditLog('supplier_updated', `تنظیمات تأمین‌کننده ${supplier.name} به‌روزرسانی شد`, 'admin');
    res.json({ success: true, supplier });
  });

  app.delete('/api/suppliers/:id', requireAdminAuth, (req, res) => {
    const { id } = req.params;
    let suppliers = getSuppliersList();
    const target = suppliers.find((s) => s.id === id);
    if (!target) {
      return res.status(404).json({ error: 'تأمین‌کننده یافت نشد.' });
    }

    suppliers = suppliers.filter((s) => s.id !== id);
    saveSuppliersList(suppliers);
    recordAuditLog('supplier_deleted', `تأمین‌کننده ${target.name} حذف شد`, 'admin');
    res.json({ success: true, message: 'تأمین‌کننده با موفقیت حذف شد' });
  });

  // Manual Trigger Sync All (Protected with requireAdminAuth - Patch Item 16)
  app.post('/api/suppliers/sync-all', requireAdminAuth, async (req, res) => {
    const result = await executeMultiSupplierSync(() => {
      syncVersions.products += 1;
      syncVersions.overall = Date.now();
    });
    res.json(result);
  });

  // Independent Statistics API - Rule 18
  app.get('/api/suppliers/stats', (req, res) => {
    const products = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
    const suppliers = getSuppliersList();

    const masterStats = {
      masterProductsCount: products.length,
      totalVariantsCount: products.reduce((acc, p) => acc + (p.colors?.length || (p.variants?.[0]?.options?.length || 1)), 0),
      inStockCount: products.filter((p) => p.stock && p.stock > 0).length,
      outOfStockCount: products.filter((p) => !p.stock || p.stock === 0).length,
    };

    const supplierStats = suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      status: s.status,
      matchedCount: s.matchedCount || 0,
      ambiguousCount: s.ambiguousCount || 0,
      variantsCount: s.variantsCount || 0,
      inStockColorsCount: s.inStockColorsCount || 0,
      lastSyncAt: s.lastSyncAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
    }));

    res.json({
      success: true,
      masterStats,
      supplierStats,
    });
  });

  // ==========================================================================
  // AI Smart Product Registration (Gemini & Deterministic - Patch Item 8)
  // ==========================================================================

  app.post('/api/ai/parse-product', async (req, res) => {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'نام یا مدل کالا الزامی است.' });
    }

    const cleanQuery = query.trim();

    // 1. Fast AI Request with 4500ms timeout
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI();
        const systemPrompt = `You are a high-speed product catalog extractor for Puzzle Kala.
Extract verified attributes from the product query.
STRICT RULES:
- Output pure JSON strictly with the specified schema.
- "name" MUST be strictly Latin/English characters and digits only. NO PERSIAN CHARACTERS.
- "warranty" MUST be "گارانتی ۱۸ ماهه شرکتی".
- All variant colors MUST have price = 0 and priceDelta = 0.
- Category must conform to Puzzle Kala taxonomy ("کالای دیجیتال" / "گوشی موبایل" / "تبلت" / "ساعت هوشمند").
- Do NOT hallucinate fake specs or fake data.
Schema:
{
  "persianName": "عنوان کامل و استاندارد فارسی",
  "name": "Full English Latin title strictly without Persian characters",
  "brand": "نام برند فارسی",
  "brandEn": "Brand English",
  "productFamily": "خانواده محصول",
  "model": "مدل دقیق",
  "edition": "نسخه",
  "ram": "مقدار رم",
  "storage": "حافظه داخلی",
  "region": "پارت‌نامبر / منطقه",
  "category": "کالای دیجیتال",
  "subcategory": "گوشی موبایل",
  "warranty": "گارانتی ۱۸ ماهه شرکتی",
  "colors": [{ "name": "نام رنگ", "colorCode": "#hex", "inStock": true, "price": 0, "priceDelta": 0 }],
  "technicalSpecs": [{ "title": "عنوان مشخصه", "value": "مقدار مشخصه" }],
  "description": "معرفی کوتاه و مفید فارسی",
  "needsReview": []
}`;

        const callPromise = ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `استخراج مشخصات برای: "${cleanQuery}"`,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
          },
        });

        const timeoutPromise = new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('AI request timeout')), 4500)
        );

        const aiResponse: any = await Promise.race([callPromise, timeoutPromise]);
        const rawText = aiResponse?.text || '';
        let parsedJson = null;
        try {
          parsedJson = JSON.parse(rawText);
        } catch {
          const match = rawText.match(/\{[\s\S]*\}/);
          if (match) parsedJson = JSON.parse(match[0]);
        }

        if (parsedJson && parsedJson.persianName) {
          // Strictly sanitize English name from any Persian characters (Patch Item 9)
          if (parsedJson.name) {
            parsedJson.name = parsedJson.name.replace(/[\u0600-\u06FF\uFB8A\u067E\u0686\u06AF]/g, '').trim();
          }
          if (!parsedJson.name) {
            parsedJson.name = '';
            if (!parsedJson.needsReview) parsedJson.needsReview = [];
            parsedJson.needsReview.push('نام لاتین کالا');
          }
          parsedJson.warranty = 'گارانتی ۱۸ ماهه شرکتی';
          if (Array.isArray(parsedJson.colors)) {
            parsedJson.colors = parsedJson.colors.map((c: any) => ({
              ...c,
              price: 0,
              priceDelta: 0,
            }));
          }
          recordAuditLog('ai_product_parsed', `کالای جدید با هوش مصنوعی آنالیز شد: ${cleanQuery}`, 'admin');
          return res.json({
            success: true,
            source: 'gemini-flash',
            product: parsedJson,
          });
        }
      } catch (err: any) {
        console.warn('[AI Parse Product] Fast fallback triggered:', err.message);
      }
    }

    // 2. High-precision Instant Deterministic Fallback (<5ms)
    const fallbackParsed = parseProductDeterministically(cleanQuery);
    recordAuditLog('ai_product_parsed', `کالای جدید با موتور هوشمند داخلی آنالیز شد: ${cleanQuery}`, 'admin');
    return res.json({
      success: true,
      source: 'deterministic-smart-parser',
      product: fallbackParsed,
    });
  });

  // AI Financial & Store Assistant
  app.post('/api/ai/chat', async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI();
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: message,
          config: {
            systemInstruction:
              'شما دستیار هوشمند، مشاور فروشگاهی و مالی سامانه پازل کالا و پازل حساب هستید. با لحن محترمانه، دقیق و حرفه‌ای به زبان فارسی پاسخ دهید.',
          },
        });
        return res.json({ reply: response.text });
      } catch (err) {
        console.error('Gemini API error:', err);
      }
    }

    let reply = 'در سامانه پازل کالا، کلیه فرآیندهای مالی، فروشگاهی و تأمین کالا به‌صورت هوشمند و یکپارچه انجام می‌پذیرد.';
    if (message.includes('سود') || message.includes('فرمول')) {
      reply = 'فرمول محاسبه قیمت فروش کالا در پازل کالا:\n• قیمت مبنا = بیشترین قیمت معتبر بین تأمین‌کنندگان فعال برای همان رنگ\n• قیمت نهایی مصرف‌کننده = قیمت مبنا × ۱.۰۵ (۵ درصد افزایش تنها یک‌بار)';
    } else if (message.includes('تامین') || message.includes('supplier')) {
      reply = 'سیستم چند تأمین‌کننده پازل کالا به‌صورت خودکار هر ۳۰ ثانیه قیمت‌ها و رنگ‌های موجود را استعلام و بهترین قیمت را با ۵٪ سود اعمال می‌کند.';
    }
    res.json({ reply });
  });

  // ==========================================================================
  // Accounting APIs with Real Password Verification (Patch Item 22)
  // ==========================================================================

  app.get('/api/accounting', (req, res) => {
    const users = readJsonFile(path.join(DATA_DIR, 'accounting', 'users.json'), []);
    res.json({ success: true, users });
  });

  app.get('/api/accounting/users', (req, res) => {
    const users = readJsonFile(path.join(DATA_DIR, 'accounting', 'users.json'), []);
    res.json(users);
  });

  app.get('/api/accounting/user-data', (req, res) => {
    const adminData = readJsonFile(path.join(DATA_DIR, 'accounting', 'users', 'admin.json'), {});
    res.json(adminData);
  });

  // Real Accounting Login Verification (Patch Item 22)
  app.post('/api/accounting/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'نام کاربری و کلمه عبور الزامی است.' });
    }

    const accUsers = readJsonFile<any[]>(path.join(DATA_DIR, 'accounting', 'users.json'), []);
    const user = accUsers.find((u) => u.username === username);

    if (!user || !verifyPassword(password, user.password)) {
      recordAuditLog('accounting_login_failed', `ورود ناموفق به پازل حساب با نام کاربری ${username}`, username);
      return res.status(401).json({ error: 'نام کاربری یا کلمه عبور پازل حساب اشتباه است.' });
    }

    const token = `acc_token_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;
    const { password: _, ...safeUser } = user;
    recordAuditLog('accounting_login', `ورود موفق کاربر به پازل حساب: ${username}`, username);

    res.json({
      success: true,
      token,
      user: safeUser,
    });
  });

  // If in development mode and Vite is needed
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.warn('Vite middleware could not be initialized, falling back to static server:', err);
    }
  }

  // SPA fallback to index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    const htmlPath = path.resolve(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(htmlPath);
    } else {
      res.status(404).send('index.html not found');
    }
  });

  // Start Server & Background 30s Loop
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    // Start background 30-second Multi-Supplier sync loop
    start30sMultiSupplierLoop(() => {
      syncVersions.products += 1;
      syncVersions.overall = Date.now();
    });
  });
}

// ============================================================================
// Deterministic High-Precision Fallback Parser (NO Hallucination - Patch Item 7)
// ============================================================================

function parseProductDeterministically(query: string) {
  const qLower = query.toLowerCase();
  const needsReview: string[] = [];

  // 1. Detect Brand
  let brand = 'نامشخص';
  let brandEn = '';
  let subcategory = 'گوشی موبایل';

  if (qLower.includes('iphone') || qLower.includes('apple') || query.includes('آیفون') || query.includes('اپل')) {
    brand = 'اپل';
    brandEn = 'Apple';
    subcategory = 'گوشی اپل';
  } else if (qLower.includes('samsung') || qLower.includes('galaxy') || query.includes('سامسونگ')) {
    brand = 'سامسونگ';
    brandEn = 'Samsung';
    subcategory = 'گوشی سامسونگ';
  } else if (qLower.includes('xiaomi') || qLower.includes('redmi') || qLower.includes('poco') || query.includes('شیائومی')) {
    brand = 'شیائومی';
    brandEn = 'Xiaomi';
    subcategory = 'گوشی شیائومی';
  } else {
    needsReview.push('برند کالا');
  }

  // 2. Extract Storage & RAM
  const storageMatch = query.match(/(\d+)\s*(g|gb|gig|tb|گیگابایت|ترابایت)/i);
  let storage = '';
  if (storageMatch) {
    storage = `${storageMatch[1]}${storageMatch[2].toLowerCase().includes('t') || storageMatch[2].includes('ترا') ? 'TB' : 'GB'}`;
  } else {
    needsReview.push('حافظه داخلی');
  }

  const ramMatch = query.match(/(\d+)\s*[\/|\\]\s*(\d+)/) || query.match(/ram\s*(\d+)|(\d+)\s*gb\s*ram|رم\s*(\d+)/i);
  let ram = '';
  if (ramMatch) {
    ram = `${ramMatch[1] || ramMatch[3]}GB`;
  }

  // 3. Extract Region / Part Number (CH, ZA, LL/A, etc.)
  let region = '';
  const regMatch = query.match(/\b(ch|za|lla|ll\/a|th|hn|ae)\b/i);
  if (regMatch) {
    region = regMatch[1].toUpperCase();
  }

  // 4. Extract Edition / Model
  let model = query.replace(/\b(8\/256g|8\/128g|12\/512g|16\/1tb|\d+gb|\d+tb|ch|za|lla)\b/gi, '').trim();
  let edition = '';
  if (qLower.includes('pro max')) edition = 'Pro Max';
  else if (qLower.includes('pro')) edition = 'Pro';
  else if (qLower.includes('plus')) edition = 'Plus';
  else if (qLower.includes('ultra')) edition = 'Ultra';
  else if (qLower.includes('normal')) edition = 'Normal';

  const persianName = `گوشی موبایل ${brand} مدل ${model}${storage ? ` ظرفیت ${storage}` : ''}${ram ? ` رم ${ram}` : ''}${region ? ` پارت‌نامبر ${region}` : ''}`.trim();

  // Rule 3: Latin name strictly English/Latin - remove Persian characters
  const cleanLatinModel = model.replace(/[\u0600-\u06FF\uFB8A\u067E\u0686\u06AF]/g, '').trim();
  const englishName = cleanLatinModel
    ? `${brandEn ? `${brandEn} ` : ''}${cleanLatinModel}${storage ? ` ${storage}` : ''}${ram ? ` ${ram} RAM` : ''}${region ? ` ${region}` : ''}`.replace(/\s+/g, ' ').trim()
    : (brandEn ? `${brandEn} Phone` : '');

  if (!cleanLatinModel && !brandEn) needsReview.push('نام لاتین کالا');

  // 5. Initial Color - NO hallucinated default "مشکی" (Patch Item 7)
  const detectedColor = normalizeColor(query);
  const colors: any[] = [];
  if (detectedColor) {
    const colorCode = detectedColor.includes('سفید') ? '#f8fafc' : detectedColor.includes('آبی') ? '#2563eb' : '#1e293b';
    colors.push({
      name: detectedColor,
      colorCode,
      inStock: true,
      price: 0,
      priceDelta: 0,
    });
  } else {
    needsReview.push('رنگ کالا');
  }

  const technicalSpecs: any[] = [];
  if (brand && brand !== 'نامشخص') technicalSpecs.push({ title: 'برند', value: brand });
  if (cleanLatinModel || model) technicalSpecs.push({ title: 'مدل', value: cleanLatinModel || model });
  if (storage) technicalSpecs.push({ title: 'حافظه داخلی', value: storage });
  if (ram) technicalSpecs.push({ title: 'حافظه رم', value: ram });
  if (region) technicalSpecs.push({ title: 'پارت نامبر / منطقه', value: region });

  return {
    persianName,
    name: englishName,
    brand,
    brandEn,
    productFamily: cleanLatinModel || model,
    model: cleanLatinModel || model,
    edition,
    ram,
    storage,
    deviceType: 'گوشی موبایل',
    region,
    modelCode: '',
    color: detectedColor || '',
    category: 'کالای دیجیتال',
    subcategory,
    warranty: 'گارانتی ۱۸ ماهه شرکتی',
    colors,
    technicalSpecs,
    description: `گوشی هوشمند ${persianName} با اصالت فیزیکی کالا، پارت‌نامبر ${region || 'استاندارد'} و ۱۸ ماه گارانتی شرکتی معتبر پازل کالا.`,
    images: [],
    needsReview,
  };
}

startServer();
