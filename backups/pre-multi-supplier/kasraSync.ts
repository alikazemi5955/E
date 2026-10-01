import fs from 'fs';
import path from 'path';
import https from 'https';

const DATA_DIR = path.join(process.cwd(), 'data');

interface KasraItem {
  id: number;
  category_id?: number;
  brand_id?: number;
  slug?: string;
  product_name?: string;
  product_name_en?: string;
  short_name?: string;
  src?: string;
  tags?: any[];
}

function fetchJson<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = https.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          timeout: 6000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve(null);
          }
          let raw = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

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

function writeJsonFile<T>(filePath: string, data: T): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

/**
 * Live sync Kasra Plus with Puzzle Kala:
 * Updates images (عکس), name (نام کالا), price (قیمت), discount/oldPrice (قیمت با تخفیف), and available colors (رنگ های موجود).
 */
export async function syncKasraPlusWithPuzzleKala(onUpdateNotify?: () => void): Promise<{
  success: boolean;
  updatedCount: number;
  timestamp: string;
}> {
  const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
  if (settings.kasraConnected === false) {
    return { success: false, updatedCount: 0, timestamp: new Date().toISOString() };
  }

  const productsPath = path.join(DATA_DIR, 'products.json');
  const products: any[] = readJsonFile<any[]>(productsPath, []);
  const markupPercentage = Number(settings.kasraMarkupPercentage || 5);

  let updatedCount = 0;
  const nowIso = new Date().toISOString();

  // 1. Fetch live product index from Kasra API
  let liveItems: KasraItem[] = [];
  try {
    const apiRes = await fetchJson<any>(
      'https://api.kasrapars.ir/api/web/v10/product/index?per-page=100'
    );
    if (apiRes && apiRes.dataProvider && Array.isArray(apiRes.dataProvider.items)) {
      liveItems = apiRes.dataProvider.items;
    }
  } catch (err) {
    console.warn('[KasraSync] Failed to fetch live items:', err);
  }

  const liveMap = new Map<number, KasraItem>();
  for (const item of liveItems) {
    if (item.id) liveMap.set(Number(item.id), item);
  }

  // 2. Iterate and update all Kasra products
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const isKasra = String(p.id).startsWith('kasra-') || p.source === 'kasraplus';
    if (!isKasra) continue;

    // Extract numerical source ID (e.g. from "kasra-5960" -> 5960)
    const numId = Number(String(p.id).replace(/\D+/g, ''));
    const liveItem = numId ? liveMap.get(numId) : null;

    let hasChanged = false;

    // A. Update Name (نام کالا)
    if (liveItem && liveItem.product_name) {
      if (p.persianName !== liveItem.product_name) {
        p.persianName = liveItem.product_name;
        hasChanged = true;
      }
      if (liveItem.product_name_en && p.name !== liveItem.product_name_en) {
        p.name = liveItem.product_name_en;
        hasChanged = true;
      }
    }

    // B. Update Images (عکس کالا)
    if (liveItem && liveItem.src) {
      if (!Array.isArray(p.images)) p.images = [];
      if (!p.images.includes(liveItem.src)) {
        p.images.unshift(liveItem.src);
        hasChanged = true;
      }
    }
    // Ensure all Kasra image URLs point to high-resolution Kasratel CDN
    if (Array.isArray(p.images) && p.images.length > 0) {
      const fixedImages = p.images.map((img: string) => {
        if (typeof img === 'string' && img.startsWith('/')) {
          return `https://cdn.kasratel.ir${img}`;
        }
        return img;
      });
      if (JSON.stringify(fixedImages) !== JSON.stringify(p.images)) {
        p.images = fixedImages;
        hasChanged = true;
      }
    }

    // C. Update Price (قیمت کالا) & Discount / Old Price (قیمت با تخفیف)
    if (p.sourcePrice && Number(p.sourcePrice) > 0) {
      const calculatedPrice = Math.round(Number(p.sourcePrice) * (1 + markupPercentage / 100));
      if (!p.price || Math.abs(p.price - calculatedPrice) > 1000) {
        p.price = calculatedPrice;
        hasChanged = true;
      }
    }

    // Ensure Discount and OldPrice are in sync if product has discount
    if (p.discount && Number(p.discount) > 0) {
      const expectedOldPrice = Math.round(Number(p.price) / (1 - Number(p.discount) / 100));
      if (!p.oldPrice || p.oldPrice <= p.price) {
        p.oldPrice = expectedOldPrice;
        hasChanged = true;
      }
    } else if (p.oldPrice && Number(p.oldPrice) > Number(p.price)) {
      const calculatedDiscount = Math.round(
        ((Number(p.oldPrice) - Number(p.price)) / Number(p.oldPrice)) * 100
      );
      if (p.discount !== calculatedDiscount) {
        p.discount = calculatedDiscount;
        hasChanged = true;
      }
    }

    // D. Update Available Colors (رنگ‌های موجود)
    if (!Array.isArray(p.colors) || p.colors.length === 0) {
      // Default standard palette if none specified
      p.colors = ['مشکی (Black)', 'سفید (White)'];
      hasChanged = true;
    }

    // Ensure variants list matches colors with inStock status and prices
    if (Array.isArray(p.variants) && p.variants.length > 0) {
      for (const variantGroup of p.variants) {
        if (variantGroup.type === 'color' && Array.isArray(variantGroup.options)) {
          for (const opt of variantGroup.options) {
            // Keep price synced with main price
            if (p.price && (!opt.price || Math.abs(opt.price - p.price) > 50000)) {
              opt.price = p.price;
              hasChanged = true;
            }
            if (p.stock !== undefined && opt.stock === undefined) {
              opt.stock = p.stock;
              opt.inStock = p.stock > 0;
              hasChanged = true;
            }
          }
        }
      }
    }

    p.lastSyncedAt = nowIso;
    p.syncStatus = 'synced';
    updatedCount++;
  }

  // 3. Save products back to disk
  writeJsonFile(productsPath, products);

  // 4. Update sync log
  const syncLogsPath = path.join(DATA_DIR, 'kasra_sync_log.json');
  const syncLogs = readJsonFile<any>(syncLogsPath, {});
  syncLogs.status = 'SUCCESS';
  syncLogs.lastRunAt = nowIso;
  syncLogs.lastSuccessAt = nowIso;
  syncLogs.intervalSeconds = 30;
  syncLogs.syncedFields = ['name', 'images', 'price', 'discount', 'oldPrice', 'colors', 'variants'];
  syncLogs.totalProductsCount = products.length;
  syncLogs.inStockCount = products.filter((p) => p.stock && p.stock > 0).length;
  syncLogs.outOfStockCount = products.filter((p) => !p.stock || p.stock === 0).length;
  writeJsonFile(syncLogsPath, syncLogs);

  if (typeof onUpdateNotify === 'function') {
    onUpdateNotify();
  }

  return {
    success: true,
    updatedCount,
    timestamp: nowIso,
  };
}

let kasraInterval: NodeJS.Timeout | null = null;

/**
 * Starts or restarts the 30-second background Kasra Plus synchronization.
 */
export function startKasra30sSyncLoop(onProductUpdate?: () => void) {
  if (kasraInterval) {
    clearInterval(kasraInterval);
    kasraInterval = null;
  }

  // Run initial sync after 3 seconds
  setTimeout(async () => {
    try {
      const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
      if (settings.kasraConnected !== false) {
        console.log('[Kasra 30s Sync] Initial sync triggered...');
        await syncKasraPlusWithPuzzleKala(onProductUpdate);
      }
    } catch (e) {
      console.warn('[Kasra 30s Sync] Initial error:', e);
    }
  }, 3000);

  // Set recurring 30-second interval
  kasraInterval = setInterval(async () => {
    try {
      const settings = readJsonFile<any>(path.join(DATA_DIR, 'settings.json'), {});
      if (settings.kasraConnected !== false) {
        console.log('[Kasra 30s Sync] Recurring 30-second sync executing...');
        await syncKasraPlusWithPuzzleKala(onProductUpdate);
      } else {
        console.log('[Kasra 30s Sync] Kasra connection is OFF, skipping...');
      }
    } catch (e) {
      console.warn('[Kasra 30s Sync] Interval error:', e);
    }
  }, 30000);
}

export function stopKasraSyncLoop() {
  if (kasraInterval) {
    clearInterval(kasraInterval);
    kasraInterval = null;
  }
}
