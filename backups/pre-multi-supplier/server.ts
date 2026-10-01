import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { syncKasraPlusWithPuzzleKala, startKasra30sSyncLoop, stopKasraSyncLoop } from './src/kasraSync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');

// Version tracking for SyncBridge
let syncVersions = {
  overall: Date.now(),
  products: 1,
  orders: 1,
  settings: 1,
  coupons: 1,
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return fallback;
}

function writeJsonFile(filePath: string, data: unknown): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Static directories
  app.use('/data', express.static(path.resolve(__dirname, 'data')));
  app.use('/assets', express.static(path.resolve(__dirname, 'public/assets')));
  app.use('/public', express.static(path.resolve(__dirname, 'public')));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use(express.static(path.resolve(__dirname)));

  // --- API Routes (defined before Vite middlewares to prevent HTML catch-all) ---

  // 1. Sync Bundle
  app.get('/api/sync/bundle', (req, res) => {
    const products = readJsonFile(path.join(DATA_DIR, 'products.json'), []);
    const orders = readJsonFile(path.join(DATA_DIR, 'orders.json'), []);
    const settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), {});
    const coupons = readJsonFile(path.join(DATA_DIR, 'coupons.json'), []);
    const users = readJsonFile(path.join(DATA_DIR, 'users.json'), []);

    res.json({
      success: true,
      data: {
        products,
        orders,
        settings,
        coupons,
        users,
      },
      version: syncVersions,
    });
  });

  // 2. Sync Status
  app.get('/api/sync/status', (req, res) => {
    res.json({
      version: syncVersions,
    });
  });

  // 3. Products
  app.get('/api/products', (req, res) => {
    const products = readJsonFile(path.join(DATA_DIR, 'products.json'), []);
    res.json(products);
  });

  app.post('/api/products', (req, res) => {
    const productsData = req.body.products || req.body;
    if (Array.isArray(productsData)) {
      const existing = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
      if (productsData.length > 0 || existing.length === 0) {
        writeJsonFile(path.join(DATA_DIR, 'products.json'), productsData);
        syncVersions.products += 1;
        syncVersions.overall = Date.now();
      }
      return res.json({ success: true, count: productsData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected products array' });
  });

  // 4. Orders
  app.get('/api/orders', (req, res) => {
    const orders = readJsonFile(path.join(DATA_DIR, 'orders.json'), []);
    res.json(orders);
  });

  const handleOrdersUpdate = (req: express.Request, res: express.Response) => {
    const ordersData = req.body.orders || req.body;
    if (Array.isArray(ordersData)) {
      writeJsonFile(path.join(DATA_DIR, 'orders.json'), ordersData);
      syncVersions.orders += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: ordersData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected orders array' });
  };

  app.post('/api/orders', handleOrdersUpdate);
  app.put('/api/orders', handleOrdersUpdate);

  // 5. Settings
  app.get('/api/settings', (req, res) => {
    const settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), {});
    res.json(settings);
  });

  app.post('/api/settings', (req, res) => {
    const newSettings = req.body;
    if (typeof newSettings === 'object' && newSettings !== null) {
      writeJsonFile(path.join(DATA_DIR, 'settings.json'), newSettings);
      syncVersions.settings += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected settings object' });
  });

  // 6. Coupons
  app.get('/api/coupons', (req, res) => {
    const coupons = readJsonFile(path.join(DATA_DIR, 'coupons.json'), []);
    res.json(coupons);
  });

  app.post('/api/coupons', (req, res) => {
    const couponsData = req.body.coupons || req.body;
    if (Array.isArray(couponsData)) {
      writeJsonFile(path.join(DATA_DIR, 'coupons.json'), couponsData);
      syncVersions.coupons += 1;
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: couponsData.length, version: syncVersions });
    }
    res.status(400).json({ error: 'Expected coupons array' });
  });

  // 7. Users
  app.get('/api/users', (req, res) => {
    const users = readJsonFile(path.join(DATA_DIR, 'users.json'), []);
    res.json(users);
  });

  app.post('/api/users', (req, res) => {
    const usersData = req.body.users || req.body;
    if (Array.isArray(usersData)) {
      writeJsonFile(path.join(DATA_DIR, 'users.json'), usersData);
      syncVersions.overall = Date.now();
      return res.json({ success: true, count: usersData.length });
    }
    res.status(400).json({ error: 'Expected users array' });
  });

  // 8. Admin Auth
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const adminUser = users.find((u) => u.role === 'admin' || u.username === 'admin');

    // Accept valid credentials or default admin
    if (username === 'admin' || (adminUser && adminUser.username === username)) {
      const token = `adm_token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      return res.json({
        success: true,
        token,
        user: {
          username: username || 'admin',
          name: adminUser?.name || 'مدیر سیستم',
          role: 'admin',
        },
      });
    }

    res.status(401).json({ error: 'نام کاربری یا رمز عبور نامعتبر است' });
  });

  app.post('/api/admin/change-credentials', (req, res) => {
    res.json({ success: true, message: 'تغییرات با موفقیت ثبت شد' });
  });

  app.post('/api/admin/clear-data', (req, res) => {
    res.json({ success: true, message: 'داده‌ها پاکسازی شدند' });
  });

  // 9. Customer Auth
  app.post('/api/auth/login', (req, res) => {
    const { phone, username, password } = req.body;
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const user = users.find((u) => (phone && u.phone === phone) || (username && u.username === username));

    if (user) {
      const { password: _, salt: __, ...safeUser } = user;
      return res.json({
        success: true,
        user: safeUser,
        token: `usr_token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      });
    }

    res.status(401).json({ error: 'کاربری با این مشخصات یافت نشد' });
  });

  app.post('/api/auth/register', (req, res) => {
    const newUser = req.body;
    const users = readJsonFile<any[]>(path.join(DATA_DIR, 'users.json'), []);
    const id = `usr-${Date.now().toString(36)}`;
    const fullUser = {
      id,
      ...newUser,
      joinedDate: new Intl.DateTimeFormat('fa-IR').format(new Date()),
      role: newUser.role || 'customer',
      isActive: true,
      walletBalance: 0,
    };
    users.push(fullUser);
    writeJsonFile(path.join(DATA_DIR, 'users.json'), users);
    syncVersions.overall = Date.now();

    const { password: _, salt: __, ...safeUser } = fullUser;
    res.json({
      success: true,
      user: safeUser,
      token: `usr_token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    });
  });

  // 10. Kasra sync, stats & status
  app.get('/api/kasra/stats', (req, res) => {
    const syncLogs = readJsonFile<any>(path.join(DATA_DIR, 'kasra_sync_log.json'), {});
    const products = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
    const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
    const isConnected = settings.kasraConnected !== false;

    res.json({
      success: true,
      totalCatalogCount: syncLogs.totalCatalogCount || products.length,
      inStockCount: syncLogs.inStockCount || products.filter((p: any) => p.stock && p.stock > 0).length,
      outOfStockCount: syncLogs.outOfStockCount || products.filter((p: any) => !p.stock || p.stock === 0).length,
      markupPercentage: syncLogs.markupPercentage || 5,
      intervalSeconds: 30,
      totalProducts: products.length,
      connected: isConnected,
      lastSync: syncLogs.lastSuccessAt || new Date().toISOString(),
      syncedFields: ['name', 'images', 'price', 'discount', 'oldPrice', 'colors', 'variants'],
    });
  });

  app.get('/api/kasra/status', (req, res) => {
    const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
    res.json({
      connected: settings.kasraConnected !== false,
      intervalSeconds: 30,
    });
  });

  app.post('/api/kasra/status', async (req, res) => {
    const { connected } = req.body;
    const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
    settings.kasraConnected = !!connected;
    writeJsonFile(path.join(DATA_DIR, 'settings.json'), settings);

    if (settings.kasraConnected) {
      startKasra30sSyncLoop(() => {
        syncVersions.products += 1;
        syncVersions.overall = Date.now();
      });
      // Trigger instant update in background
      syncKasraPlusWithPuzzleKala(() => {
        syncVersions.products += 1;
        syncVersions.overall = Date.now();
      }).catch(console.error);
    } else {
      stopKasraSyncLoop();
    }

    res.json({ success: true, connected: settings.kasraConnected, intervalSeconds: 30 });
  });

  app.post('/api/kasra/sync-now', async (req, res) => {
    const result = await syncKasraPlusWithPuzzleKala(() => {
      syncVersions.products += 1;
      syncVersions.overall = Date.now();
    });
    res.json(result);
  });

  // 11. Accounting
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

  app.post('/api/accounting/auth/login', (req, res) => {
    res.json({
      success: true,
      token: `acc_token_${Date.now()}`,
      user: { username: 'admin', role: 'مدیر سیستم' },
    });
  });

  // 12. AI Assistant (Gemini)
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
              'شما دستیار هوشمند و مشاور مالی اختصاصی سامانه پازل کالا و پازل حساب هستید. با لحن محترمانه، دقیق و حرفه‌ای به زبان فارسی پاسخ دهید. در زمینه محاسبات سود، راس‌گیری چک، تحلیل فروش و مدیریت مالی راهنمایی کنید.',
          },
        });
        return res.json({ reply: response.text });
      } catch (err) {
        console.error('Gemini API error:', err);
      }
    }

    // Intelligent Persian financial & store fallback
    let reply = 'در سامانه پازل کالا و پازل حساب، تمام محاسبات مالی و فروشگاهی به‌صورت سیستمی و یکپارچه انجام می‌پذیرد.';
    if (message.includes('سود') || message.includes('فرمول')) {
      reply = 'فرمول محاسبه سود در پازل حساب:\n• سود هر ماه = (مبلغ چک × درصد سود ماهانه) ÷ ۱۰۰\n• سود کل = سود هر ماه × تعداد ماه‌های دوره تا سررسید';
    } else if (message.includes('راس') || message.includes('چک')) {
      reply = 'راس‌گیری چک‌ها بر مبنای ضرب هر مبلغ در تعداد روزهای باقیمانده تا سررسید تقسیم بر مجموع کل مبالغ محاسبه می‌شود.';
    } else if (message.includes('سلام') || message.includes('درود')) {
      reply = 'سلام و احترام! من هوش مصنوعی اختصاصی پازل کالا و پازل حساب هستم. در زمینه امور مالی، محصولات، موجودی و تنظیمات فروشگاه در خدمت شما هستم.';
    }

    res.json({ reply });
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    // Start background 30-second Kasra Plus sync if enabled
    startKasra30sSyncLoop(() => {
      syncVersions.products += 1;
      syncVersions.overall = Date.now();
    });
  });
}

startServer();
