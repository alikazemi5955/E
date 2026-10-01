import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const DATA_DIR = path.resolve(process.cwd(), 'data');

// ============================================================================
// 1. Types & Interfaces (Multi-Supplier Architecture)
// ============================================================================

export interface Supplier {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  connectionType: 'api_feed' | 'rest_api' | 'json_feed';
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  status: 'connected' | 'disconnected' | 'error' | 'unavailable';
  matchedCount: number;
  ambiguousCount: number;
  variantsCount: number;
  inStockColorsCount: number;
}

export interface SupplierVariant {
  sourceVariantId?: string | number;
  colorName: string;
  normalizedColorName: string;
  sourcePrice: number;
  inStock: boolean;
  sourceUpdatedAt?: string;
}

export interface SupplierProductMatch {
  supplierId: string;
  supplierProductId?: string | number;
  sku?: string;
  barcode?: string;
  modelCode?: string;
  normalizedIdentity: string;
  variants: SupplierVariant[];
  confidence: 'exact' | 'high' | 'ambiguous' | 'none';
}

export interface SupplierAdapter {
  id: string;
  name: string;
  fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }>;
  matchProduct(masterProduct: any, supplierItems: any[], index?: SupplierCatalogIndex): SupplierProductMatch | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  details: string;
  actor: string;
  metadata?: any;
  timestamp: string;
}

export interface SupplierCatalogIndex {
  barcodeMap: Map<string, any>;
  skuMap: Map<string, any>;
  idMap: Map<string, any>;
  brandModelMap: Map<string, any[]>;
  items: any[];
}

// ============================================================================
// 2. Safe JSON Helpers & Audit Log (Rule 20, 21 - Max 1000 Records, No Secrets)
// ============================================================================

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return fallback;
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(filePath: string, data: T): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempFile = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
    return true;
  } catch (err) {
    console.error(`[SupplierEngine] Failed to write JSON to ${filePath}:`, err);
    return false;
  }
}

export function recordAuditLog(
  action: string,
  details: string,
  actor: string = 'system',
  metadata?: any
): void {
  try {
    const auditFile = path.join(DATA_DIR, 'audit_logs.json');
    const logs = readJsonFile<AuditLogEntry[]>(auditFile, []);

    // Filter out any sensitive keys from metadata (Rule 21)
    let sanitizedMeta = metadata;
    if (metadata && typeof metadata === 'object') {
      const copy = { ...metadata };
      delete copy.password;
      delete copy.token;
      delete copy.secret;
      delete copy.apiKey;
      delete copy.authorization;
      sanitizedMeta = copy;
    }

    const entry: AuditLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      action,
      details,
      actor,
      metadata: sanitizedMeta,
      timestamp: new Date().toISOString(),
    };

    logs.unshift(entry);

    // Rule 21: Strictly maintain at most 1000 records
    if (logs.length > 1000) {
      logs.splice(1000);
    }

    writeJsonFile(auditFile, logs);
  } catch {
    // Non-blocking
  }
}

// ============================================================================
// 3. High-Precision Normalizers (Text & Colors - Section 5 & 7)
// ============================================================================

export function normalizeText(text?: string | null): string {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[\/\-_,.:;+()\[\]{}|\\!@#$%^&*~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COLOR_CANONICAL_MAP: Record<string, string> = {
  // Black
  'black': 'مشکی (Black)',
  'مشکی': 'مشکی (Black)',
  'سیاه': 'مشکی (Black)',
  'dark': 'مشکی (Black)',
  'phantom black': 'مشکی (Black)',
  'titanium black': 'مشکی (Black)',
  'midnight': 'مشکی (Black)',
  'space black': 'مشکی (Black)',
  'space gray': 'خاکستری فضایی (Space Gray)',
  'gray': 'خاکستری (Gray)',
  'grey': 'خاکستری (Gray)',
  'طوسی': 'خاکستری (Gray)',
  'خاکستری': 'خاکستری (Gray)',
  // White & Silver
  'white': 'سفید (White)',
  'سفید': 'سفید (White)',
  'starlight': 'سفید استارلایت (Starlight)',
  'silver': 'نقره‌ای (Silver)',
  'نقره ای': 'نقره‌ای (Silver)',
  'نقره‌ای': 'نقره‌ای (Silver)',
  'titanium silver': 'نقره‌ای (Silver)',
  'titanium white': 'سفید تیتانیوم (White Titanium)',
  // Blue
  'blue': 'آبی (Blue)',
  'ابی': 'آبی (Blue)',
  'آبی': 'آبی (Blue)',
  'dark blue': 'آبی تیره (Dark Blue)',
  'deep blue': 'آبی عمیق (Deep Blue)',
  'titanium blue': 'آبی تیتانیوم (Blue Titanium)',
  'sky blue': 'آبی آسمانی (Sky Blue)',
  'sierra blue': 'آبی سیرا (Sierra Blue)',
  'pacific blue': 'آبی پاسیفیک (Pacific Blue)',
  // Gold & Desert
  'gold': 'طلایی (Gold)',
  'طلایی': 'طلایی (Gold)',
  'طلا': 'طلایی (Gold)',
  'desert titanium': 'تیتانیوم صحرایی (Desert Titanium)',
  'desert': 'تیتانیوم صحرایی (Desert Titanium)',
  'صحرایی': 'تیتانیوم صحرایی (Desert Titanium)',
  'رزگلد': 'رز گلد (Rose Gold)',
  'rose gold': 'رز گلد (Rose Gold)',
  // Green
  'green': 'سبز (Green)',
  'سبز': 'سبز (Green)',
  'midnight green': 'سبز نیمه‌شب (Midnight Green)',
  'alpine green': 'سبز آلپاین (Alpine Green)',
  // Purple & Pink & Red & Yellow
  'purple': 'بنفش (Purple)',
  'بنفش': 'بنفش (Purple)',
  'pink': 'صورتی (Pink)',
  'صورتی': 'صورتی (Pink)',
  'red': 'قرمز (Red)',
  'قرمز': 'قرمز (Red)',
  'yellow': 'زرد (Yellow)',
  'زرد': 'زرد (Yellow)',
  'orange': 'نارنجی (Orange)',
  'نارنجی': 'نارنجی (Orange)',
};

export function normalizeColor(rawColor?: string | null): string {
  if (!rawColor) return '';
  const clean = normalizeText(rawColor);
  for (const [key, canonical] of Object.entries(COLOR_CANONICAL_MAP)) {
    if (clean === key || clean.includes(key)) {
      return canonical;
    }
  }
  return rawColor.trim();
}

// ============================================================================
// 4. HTTP Fetcher with Independent Timeout (Rule 26)
// ============================================================================

function fetchJson<T>(url: string, timeoutMs: number = 5000): Promise<{ data: T | null; error?: string }> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            res.resume();
            return resolve({
              data: null,
              error: `HTTP ${res.statusCode} ${res.statusMessage || ''}`,
            });
          }

          let raw = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              resolve({ data: parsed });
            } catch (err: any) {
              resolve({ data: null, error: `پاسخ نامعتبر JSON: ${err.message}` });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ data: null, error: `اتصال به تأمین‌کننده به پایان مهلت (${timeoutMs}ms) رسید` });
      });

      req.on('error', (err) => {
        resolve({ data: null, error: err.message || 'خطا در ارتباط شبکه' });
      });
    } catch (err: any) {
      resolve({ data: null, error: err.message || 'نشانی نامعتبر' });
    }
  });
}

// ============================================================================
// 5. Suppliers Management (Rule 3 & 13)
// ============================================================================

const DEFAULT_SUPPLIERS: Supplier[] = [
  {
    id: 'kasra',
    name: 'کسری پلاس (Kasra Plus)',
    enabled: true,
    baseUrl: 'https://api.kasrapars.ir/api/web/v10/product/index?per-page=100',
    connectionType: 'api_feed',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    status: 'connected',
    matchedCount: 0,
    ambiguousCount: 0,
    variantsCount: 0,
    inStockColorsCount: 0,
  },
  {
    id: 'hamrahtel',
    name: 'همراه تل (Hamrah Tel)',
    enabled: false,
    baseUrl: 'https://api.hamrahtel.com/feed/products',
    connectionType: 'api_feed',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    status: 'disconnected',
    matchedCount: 0,
    ambiguousCount: 0,
    variantsCount: 0,
    inStockColorsCount: 0,
  },
];

export function getSuppliersList(): Supplier[] {
  const filePath = path.join(DATA_DIR, 'suppliers.json');
  const sups = readJsonFile<Supplier[]>(filePath, []);
  if (sups.length === 0) {
    saveSuppliersList(DEFAULT_SUPPLIERS);
    return DEFAULT_SUPPLIERS;
  }
  return sups;
}

export function saveSuppliersList(suppliers: Supplier[]): void {
  const filePath = path.join(DATA_DIR, 'suppliers.json');
  writeJsonFile(filePath, suppliers);
}

// ============================================================================
// 6. Universal Supplier Adapter (No special privileges for any supplier)
// ============================================================================

function extractStorage(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/(\d+)\s*(gb|gig|tb|گیگابایت|ترابایت)/i);
  if (match) {
    const num = match[1];
    const unit = match[2].toLowerCase().includes('t') || match[2].includes('ترا') ? 'TB' : 'GB';
    return `${num}${unit}`;
  }
  return null;
}

function extractRam(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/ram\s*(\d+)|(\d+)\s*(gig|gb)\s*ram|رم\s*(\d+)/i);
  if (match) {
    const num = match[1] || match[2] || match[4];
    return `${num}GB`;
  }
  return null;
}

function buildMatch(
  masterProduct: any,
  sourceItem: any,
  supplierId: string,
  confidence: 'exact' | 'high' | 'ambiguous'
): SupplierProductMatch {
  const variants: SupplierVariant[] = [];

  const rawPrice = Number(
    sourceItem.price ||
      sourceItem.sell_price ||
      sourceItem.sourcePrice ||
      (sourceItem.product_variants && sourceItem.product_variants[0]?.price) ||
      0
  );

  // If item has structured color variants
  if (Array.isArray(sourceItem.variants) && sourceItem.variants.length > 0) {
    for (const v of sourceItem.variants) {
      const colName = v.color || v.color_name || v.name;
      if (!colName) continue; // Rule 7: Do not invent colors
      const colPrice = Number(v.price || rawPrice);
      const isStock = v.stock !== undefined ? Number(v.stock) > 0 : (v.inStock !== undefined ? Boolean(v.inStock) : true);
      variants.push({
        sourceVariantId: v.id,
        colorName: colName,
        normalizedColorName: normalizeColor(colName),
        sourcePrice: colPrice,
        inStock: isStock,
        sourceUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (Array.isArray(sourceItem.colors) && sourceItem.colors.length > 0) {
    for (const col of sourceItem.colors) {
      const colName = typeof col === 'string' ? col : col.name || col.title;
      if (!colName) continue;
      const colPrice = typeof col === 'object' && col.price ? Number(col.price) : rawPrice;
      const isStock = typeof col === 'object' && col.stock !== undefined ? Number(col.stock) > 0 : true;
      variants.push({
        colorName: colName,
        normalizedColorName: normalizeColor(colName),
        sourcePrice: colPrice,
        inStock: isStock,
        sourceUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (rawPrice > 0) {
    // Single color or title color
    const detected = normalizeColor(sourceItem.title || sourceItem.name || sourceItem.persianName);
    if (detected) {
      variants.push({
        colorName: detected,
        normalizedColorName: detected,
        sourcePrice: rawPrice,
        inStock: sourceItem.stock !== undefined ? Number(sourceItem.stock) > 0 : true,
        sourceUpdatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    supplierId,
    supplierProductId: sourceItem.id || sourceItem.product_id,
    sku: sourceItem.sku,
    barcode: sourceItem.barcode || sourceItem.gtin,
    modelCode: sourceItem.model_code,
    normalizedIdentity: normalizeText(sourceItem.title || sourceItem.name),
    variants,
    confidence,
  };
}

export const UniversalSupplierAdapter: SupplierAdapter = {
  id: 'universal',
  name: 'تأمین‌کننده عمومی استاندارد',

  async fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }> {
    if (!supplier.enabled) {
      return { success: false, items: [], error: 'تأمین‌کننده غیرفعال است' };
    }
    const res = await fetchJson<any>(supplier.baseUrl, 5000);
    if (!res.data) {
      return { success: false, items: [], error: res.error || `خطا در استعلام از ${supplier.name}` };
    }

    let items: any[] = [];
    if (res.data.dataProvider && Array.isArray(res.data.dataProvider.items)) {
      items = res.data.dataProvider.items;
    } else if (Array.isArray(res.data.items)) {
      items = res.data.items;
    } else if (Array.isArray(res.data.products)) {
      items = res.data.products;
    } else if (Array.isArray(res.data.data)) {
      items = res.data.data;
    } else if (Array.isArray(res.data)) {
      items = res.data;
    }

    return { success: true, items };
  },

  matchProduct(
    masterProduct: any,
    supplierItems: any[],
    index?: SupplierCatalogIndex
  ): SupplierProductMatch | null {
    if (!masterProduct || !supplierItems || supplierItems.length === 0) return null;

    const masterBarcode = masterProduct.barcode || masterProduct.gtin || masterProduct.ean;
    const masterSku = masterProduct.sku || masterProduct.modelCode;

    // 1. Direct Barcode Match from Index O(1)
    if (index && masterBarcode) {
      const match = index.barcodeMap.get(String(masterBarcode).trim());
      if (match) return buildMatch(masterProduct, match, this.id, 'exact');
    }

    // 2. Direct SKU Match from Index O(1)
    if (index && masterSku) {
      const match = index.skuMap.get(String(masterSku).trim().toLowerCase());
      if (match) return buildMatch(masterProduct, match, this.id, 'exact');
    }

    // 3. Mapped Supplier Product ID O(1)
    const mappedSupId = masterProduct.supplierMatches?.[this.id]?.supplierProductId || masterProduct.sourceProductId;
    if (index && mappedSupId) {
      const match = index.idMap.get(String(mappedSupId).trim());
      if (match) return buildMatch(masterProduct, match, this.id, 'exact');
    }

    // 4. Brand + Exact Model + Storage Matching
    const masterBrand = normalizeText(masterProduct.brand || masterProduct.brandEn || '');
    const masterName = normalizeText(masterProduct.name || masterProduct.persianName || '');
    const masterStorage = extractStorage(masterName);
    const masterRam = extractRam(masterName);

    if (index && masterBrand) {
      // Find candidate matches by brand
      const candidates: any[] = [];
      for (const [key, items] of index.brandModelMap.entries()) {
        if (key.startsWith(masterBrand + ':::')) {
          for (const item of items) {
            const itemTitle = normalizeText(item.title || item.name || '');
            if (masterStorage && !itemTitle.includes(masterStorage.toLowerCase())) continue;
            if (masterRam && !itemTitle.includes(masterRam.toLowerCase())) continue;
            candidates.push(item);
          }
        }
      }

      if (candidates.length === 1) {
        return buildMatch(masterProduct, candidates[0], this.id, 'high');
      } else if (candidates.length > 1) {
        // Check for exact model match
        const exactMatch = candidates.filter((c) => {
          const cTitle = normalizeText(c.title || c.name || '');
          return masterProduct.model && cTitle.includes(normalizeText(masterProduct.model));
        });
        if (exactMatch.length === 1) {
          return buildMatch(masterProduct, exactMatch[0], this.id, 'high');
        } else if (exactMatch.length > 1) {
          // Rule 5: Ambiguous match - report ambiguous, DO NOT apply price
          return buildMatch(masterProduct, exactMatch[0], this.id, 'ambiguous');
        }
      }
    }

    // Fallback: If not indexed, fallback to direct search
    if (!index) {
      const found = supplierItems.find((s) => {
        const sName = normalizeText(s.title || s.name || '');
        return sName.length > 5 && (masterName.includes(sName) || sName.includes(masterName));
      });
      if (found) return buildMatch(masterProduct, found, this.id, 'high');
    }

    return null;
  },
};

// All suppliers use the universal adapter standard
export const KasraAdapter: SupplierAdapter = { ...UniversalSupplierAdapter, id: 'kasra', name: 'کسری پلاس (Kasra Plus)' };
export const HamrahTelAdapter: SupplierAdapter = { ...UniversalSupplierAdapter, id: 'hamrahtel', name: 'همراه تل (Hamrah Tel)' };

const ADAPTERS: Record<string, SupplierAdapter> = {
  kasra: KasraAdapter,
  hamrahtel: HamrahTelAdapter,
};

export function registerSupplierAdapter(adapter: SupplierAdapter) {
  ADAPTERS[adapter.id] = adapter;
}

// ============================================================================
// 7. Core Multi-Supplier Sync Engine (Rule 8, 10, 11, 12, 13, 14, 15, 16)
// ============================================================================

let isSyncRunning = false;

export async function executeMultiSupplierSync(
  onUpdateNotify?: () => void
): Promise<{
  success: boolean;
  message: string;
  updatedMasterProducts: number;
  supplierStats: Record<string, any>;
  timestamp: string;
}> {
  // Concurrency Guard: Mutex Lock (Rule 12)
  if (isSyncRunning) {
    return {
      success: false,
      message: 'همگام‌سازی تأمین‌کنندگان در حال حاضر در حال اجراست؛ لطفاً شکیبا باشید.',
      updatedMasterProducts: 0,
      supplierStats: {},
      timestamp: new Date().toISOString(),
    };
  }

  isSyncRunning = true;
  const nowIso = new Date().toISOString();

  try {
    const suppliers = getSuppliersList();
    const enabledSuppliers = suppliers.filter((s) => s.enabled);
    const productsPath = path.join(DATA_DIR, 'products.json');
    const masterProducts: any[] = readJsonFile<any[]>(productsPath, []);

    const supplierCatalogs: Record<string, any[]> = {};
    const supplierStats: Record<string, any> = {};

    // 1. Fetch catalogs from all enabled suppliers in PARALLEL with Promise.all (Patch Item 13)
    await Promise.all(
      enabledSuppliers.map(async (sup) => {
        const adapter = ADAPTERS[sup.id] || { ...UniversalSupplierAdapter, id: sup.id, name: sup.name };
        sup.lastSyncAt = nowIso;

        try {
          const fetchRes = await adapter.fetchCatalog(sup);
          if (fetchRes.success && Array.isArray(fetchRes.items)) {
            sup.status = 'connected';
            sup.lastSuccessAt = nowIso;
            sup.lastError = null;
            supplierCatalogs[sup.id] = fetchRes.items;
          } else {
            // Rule 14 & 26: Mark unavailable, DO NOT zero master, DO NOT fabricate fake data
            sup.status = 'unavailable';
            sup.lastError = fetchRes.error || 'پاسخ نامعتبر از تأمین‌کننده';
            supplierCatalogs[sup.id] = [];
          }
        } catch (err: any) {
          sup.status = 'error';
          sup.lastError = err.message || 'خطا در برقراری ارتباط';
          supplierCatalogs[sup.id] = [];
        }

        supplierStats[sup.id] = {
          name: sup.name,
          enabled: sup.enabled,
          status: sup.status,
          lastError: sup.lastError,
          matchedCount: 0,
          ambiguousCount: 0,
          variantsCount: 0,
          inStockColorsCount: 0,
        };
      })
    );

    // 2. Build Fast Lookup Indexes for each connected supplier (Patch Item 14)
    const supplierIndexes: Record<string, SupplierCatalogIndex> = {};
    for (const sup of enabledSuppliers) {
      const items = supplierCatalogs[sup.id] || [];
      if (items.length === 0) continue;

      const index: SupplierCatalogIndex = {
        barcodeMap: new Map(),
        skuMap: new Map(),
        idMap: new Map(),
        brandModelMap: new Map(),
        items,
      };

      for (const item of items) {
        if (item.barcode) index.barcodeMap.set(String(item.barcode).trim(), item);
        if (item.gtin) index.barcodeMap.set(String(item.gtin).trim(), item);
        if (item.ean) index.barcodeMap.set(String(item.ean).trim(), item);
        if (item.sku) index.skuMap.set(String(item.sku).trim().toLowerCase(), item);
        if (item.model_code) index.skuMap.set(String(item.model_code).trim().toLowerCase(), item);
        if (item.id !== undefined) index.idMap.set(String(item.id).trim(), item);

        const b = normalizeText(item.brand || item.brand_name || '');
        const m = normalizeText(item.model || item.title || item.name || '');
        if (b && m) {
          const key = `${b}:::${m}`;
          if (!index.brandModelMap.has(key)) index.brandModelMap.set(key, []);
          index.brandModelMap.get(key)!.push(item);
        }
      }
      supplierIndexes[sup.id] = index;
    }

    let updatedProductsCount = 0;

    // 3. Match Master Products and Apply Multi-Supplier Pricing
    for (let pIdx = 0; pIdx < masterProducts.length; pIdx++) {
      const product = masterProducts[pIdx];

      // Patch Item 5: Master products have genuine Puzzle Kala IDs and source
      if (String(product.id).startsWith('kasra-')) {
        const numId = String(product.id).replace(/\D+/g, '');
        product.id = `pk-${numId}`;
        if (!product.supplierMatches) product.supplierMatches = {};
        product.supplierMatches.kasra = { supplierProductId: numId };
      }
      product.source = 'puzzlekala';

      const productMatches: SupplierProductMatch[] = [];

      for (const sup of enabledSuppliers) {
        const items = supplierCatalogs[sup.id] || [];
        const index = supplierIndexes[sup.id];
        const adapter = ADAPTERS[sup.id] || { ...UniversalSupplierAdapter, id: sup.id, name: sup.name };
        if (!adapter || items.length === 0) continue;

        const match = adapter.matchProduct(product, items, index);
        if (match) {
          if (match.confidence === 'ambiguous') {
            sup.ambiguousCount = (sup.ambiguousCount || 0) + 1;
            supplierStats[sup.id].ambiguousCount += 1;
            recordAuditLog(
              'sync_ambiguous_match',
              `تطبیق مبهم برای کالای ${product.persianName || product.name} در ${sup.name}`,
              'multi-supplier-sync',
              { productId: product.id, supplierId: sup.id }
            );
          } else {
            productMatches.push(match);
            sup.matchedCount = (sup.matchedCount || 0) + 1;
            supplierStats[sup.id].matchedCount += 1;
          }
        }
      }

      if (productMatches.length === 0) continue;

      // 4. Apply Section 8 & 10 Pricing:
      // selectedSourcePrice(color) = MAX(valid source prices for exact color from enabled suppliers)
      // finalPrice(color) = selectedSourcePrice(color) * 1.05
      // 5% Markup applied strictly ONCE
      interface ColorPriceEntry {
        price: number;
        supplierId: string;
        supplierName: string;
      }
      const colorPriceMap = new Map<string, ColorPriceEntry[]>();
      for (const match of productMatches) {
        const supInfo = enabledSuppliers.find((s) => s.id === match.supplierId);
        const supName = supInfo ? supInfo.name : (match.supplierId === 'kasra' ? 'کسری پلاس' : match.supplierId);
        for (const v of match.variants) {
          if (v.sourcePrice && Number(v.sourcePrice) > 0 && v.inStock) {
            const canonicalColor = v.normalizedColorName || normalizeColor(v.colorName);
            if (!colorPriceMap.has(canonicalColor)) {
              colorPriceMap.set(canonicalColor, []);
            }
            colorPriceMap.get(canonicalColor)!.push({
              price: Number(v.sourcePrice),
              supplierId: match.supplierId,
              supplierName: supName,
            });
          }
        }
      }

      let productChanged = false;

      if (colorPriceMap.size > 0) {
        for (const match of productMatches) {
          supplierStats[match.supplierId].variantsCount += match.variants.length;
          supplierStats[match.supplierId].inStockColorsCount += match.variants.filter((v) => v.inStock).length;
        }

        let lowestOverallFinalPrice = Infinity;
        let selectedReferenceSupplierId = '';
        let selectedReferenceSupplierName = '';

        if (!Array.isArray(product.variants) || product.variants.length === 0) {
          product.variants = [
            {
              id: 'var-color',
              name: 'رنگ',
              type: 'color',
              options: [],
            },
          ];
        }

        const colorGroup =
          product.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ') || product.variants[0];

        if (colorGroup && Array.isArray(colorGroup.options)) {
          for (const [colName, entries] of colorPriceMap.entries()) {
            // Find entry with maximum valid source price
            let bestEntry = entries[0];
            for (const ent of entries) {
              if (ent.price > bestEntry.price) {
                bestEntry = ent;
              }
            }

            const maxSourcePrice = bestEntry.price;
            const finalVariantPrice = Math.round(maxSourcePrice * 1.05);

            if (finalVariantPrice < lowestOverallFinalPrice) {
              lowestOverallFinalPrice = finalVariantPrice;
              selectedReferenceSupplierId = bestEntry.supplierId;
              selectedReferenceSupplierName = bestEntry.supplierName;
            }

            let existingOption = colorGroup.options.find(
              (opt: any) => normalizeColor(opt.name) === colName || opt.name === colName
            );

            if (existingOption) {
              if (
                existingOption.sourcePrice !== maxSourcePrice ||
                existingOption.price !== finalVariantPrice ||
                existingOption.referenceSupplierId !== bestEntry.supplierId
              ) {
                existingOption.sourcePrice = maxSourcePrice;
                existingOption.markupRate = 0.05;
                existingOption.price = finalVariantPrice;
                existingOption.referenceSupplierId = bestEntry.supplierId;
                existingOption.referenceSupplierName = bestEntry.supplierName;
                existingOption.inStock = true;
                productChanged = true;
              }
            } else {
              colorGroup.options.push({
                id: `opt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                name: colName,
                sourcePrice: maxSourcePrice,
                markupRate: 0.05,
                price: finalVariantPrice,
                referenceSupplierId: bestEntry.supplierId,
                referenceSupplierName: bestEntry.supplierName,
                inStock: true,
              });
              productChanged = true;
            }
          }
        }

        if (lowestOverallFinalPrice < Infinity && product.price !== lowestOverallFinalPrice) {
          product.price = lowestOverallFinalPrice;
          product.sourcePrice = Math.round(lowestOverallFinalPrice / 1.05);
          product.syncedPrice = lowestOverallFinalPrice;
          product.inStock = true;
          productChanged = true;
        }

        // Set dominant reference supplier on Master Product in real time
        if (selectedReferenceSupplierName && product.referenceSupplierName !== selectedReferenceSupplierName) {
          product.referenceSupplierId = selectedReferenceSupplierId;
          product.referenceSupplierName = selectedReferenceSupplierName;
          product.supplierName = selectedReferenceSupplierName;
          productChanged = true;
        }

        product.lastSyncedAt = nowIso;
        product.syncStatus = 'synced';

        if (productChanged) {
          updatedProductsCount++;
        }
      }
    }

    // Save updated Master Products and Supplier stats
    if (updatedProductsCount > 0) {
      writeJsonFile(productsPath, masterProducts);
    }
    saveSuppliersList(suppliers);

    // Notify listeners (SyncBridge)
    if (onUpdateNotify && updatedProductsCount > 0) {
      onUpdateNotify();
    }

    const connectedCount = enabledSuppliers.filter((s) => s.status === 'connected').length;
    const totalMatched = Object.values(supplierStats).reduce((a, s: any) => a + (s.matchedCount || 0), 0);

    const message =
      enabledSuppliers.length === 0
        ? 'هیچ تأمین‌کننده فعال و قابل دسترسی برای همگام‌سازی پیدا نشد.'
        : `همگام‌سازی انجام شد — ${enabledSuppliers.length} تأمین‌کننده بررسی شدند (${connectedCount} متصل)، ${totalMatched} کالا تطبیق داده شد، ${updatedProductsCount} کالا به‌روزرسانی شد.`;

    recordAuditLog(
      'multi_supplier_sync',
      message,
      'admin',
      {
        enabledCount: enabledSuppliers.length,
        connectedCount,
        totalMatched,
        updatedProductsCount,
      }
    );

    return {
      success: true,
      message,
      updatedMasterProducts: updatedProductsCount,
      supplierStats,
      timestamp: nowIso,
    };
  } finally {
    isSyncRunning = false;
  }
}

// ============================================================================
// 8. Background 30-Second Single-Loop Timer (Rule 11 & 12)
// ============================================================================

let loopInterval: NodeJS.Timeout | null = null;

export function start30sMultiSupplierLoop(onUpdateNotify?: () => void) {
  if (loopInterval) {
    return; // Enforce single loop across server lifecycle
  }

  // Initial sync after 3 seconds
  setTimeout(() => {
    executeMultiSupplierSync(onUpdateNotify).catch((err) => {
      console.error('[SupplierEngine] Error in initial sync:', err);
    });
  }, 3000);

  // Every 30 seconds
  loopInterval = setInterval(() => {
    executeMultiSupplierSync(onUpdateNotify).catch((err) => {
      console.error('[SupplierEngine] Error in 30s background sync:', err);
    });
  }, 30000);

  console.log('[SupplierEngine] Multi-Supplier 30-second sync loop activated.');
}

export function stop30sMultiSupplierLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
    console.log('[SupplierEngine] Multi-Supplier 30-second sync loop stopped.');
  }
}
