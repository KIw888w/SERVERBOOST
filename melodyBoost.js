'use strict';
/**
 * melodyBoost.js — คำสั่งสั่งบูสต์ผ่าน Melody Boost API สำหรับบอท discord.js (v14)
 * พอร์ตมาจาก melody-boost-cli (Python) โดยคงกฎความปลอดภัยเดิมไว้ครบ:
 *  - บันทึก client_reference ลงไฟล์ก่อนส่ง POST เสมอ
 *  - POST /api/v1/boost ส่งครั้งเดียว ไม่ retry (timeout 900 วินาที)
 *  - POST ไม่รู้ผล (timeout/หลุด/500/503) => ห้ามสร้างซ้ำ ให้ค้นด้วย client_reference
 *  - 404 ตอนค้น => รอแล้วค้นใหม่ ไม่สรุปว่าล้มเหลว
 *  - ติดตามผลทุก ~10 วินาที สูงสุด 15 นาที แล้วบันทึกเป็น "รอตรวจสอบ"
 *  - ไม่คำนวณ/ไม่เพิ่มเครดิตคืนเอง แสดงเฉพาะค่าที่ Server ส่งมา
 *
 * ต้องใช้ Node 18+ (มี fetch ในตัว) และ discord.js v14
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// ====================== ค่าคงที่ ======================
const TIERS = ['1m', '3m'];
const FINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'api_failed']);
const UNRESOLVED_STATES = new Set(['posting', 'unconfirmed', 'tracking', 'pending_review']);
const REJECTION_STATUSES = new Set([400, 401, 402, 403, 409, 422, 429]);
const FATAL_TRACK_STATUSES = new Set([400, 401, 403, 422]);
const POLL_INTERVAL_MS = 10_000;
const TRACK_TIMEOUT_MS = 15 * 60_000;
const GET_TIMEOUT_MS = 30_000;
const POST_TIMEOUT_MS = 900_000;
const MAX_NICK_LENGTH = 32;
const MAX_RETRY_AFTER_S = 600;
const BACKOFF_BASE_S = 1;
const BACKOFF_MAX_S = 30;
const DRAFT_TTL_MS = 5 * 60_000;
const DEFAULT_BASE_URL = 'https://melody191.shop/boost-bot-api';
const HTTP_ERRORS = {
  400: ['bad_request', 'ข้อมูลที่ส่งไม่ถูกต้อง เช่น จำนวนบูสต์เป็นเลขคี่ หรือลิงก์เชิญ Discord ใช้งานไม่ได้'],
  401: ['unauthorized', 'API Key ไม่ถูกต้อง หรือถูกปิดใช้งาน'],
  402: ['insufficient_credit', 'เครดิตไม่เพียงพอ'],
  403: ['forbidden', 'ไม่ได้รับอนุญาต (IP ไม่อยู่ในรายการ, key ไม่ใช่ประเภท Boost หรือออเดอร์ไม่ใช่ของ key นี้)'],
  404: ['not_found', 'ไม่พบออเดอร์ — อาจยังไม่ถูกบันทึก ห้ามสรุปว่าล้มเหลวจากการค้นครั้งเดียว'],
  409: ['stock_conflict', 'จอง Token จากสต็อกไม่ได้ในขณะนั้น (ตามเอกสาร ระบบจะคืนเครดิตของคำขอนี้ — ตรวจยอดจริงจาก Server)'],
  422: ['validation_error', 'รูปแบบข้อมูลไม่ตรงกับ schema เช่น tier ไม่ใช่ 1m/3m'],
  429: ['rate_limited', 'เรียก API ถี่เกินกำหนด'],
  500: ['internal_error', 'Server ประมวลผลผิดพลาด'],
  503: ['maintenance', 'ระบบบูสต์หรือสต็อกไม่พร้อมใช้งาน/ปิดชั่วคราว'],
};

const NO_REFUND_REASONS = {
  join_failed: 'Token เข้าเซิร์ฟเวอร์ Discord ไม่สำเร็จ เช่น เซิร์ฟเวอร์หรือลิงก์เชิญถูกจำกัด',
  guild_not_found: 'ไม่พบเซิร์ฟเวอร์',
  kicked_after_join: 'Token ถูกเตะหลังเข้าร่วมเซิร์ฟเวอร์โดยบอทป้องกันเตะ',
};
const REFUND_POLICY_TITLE = 'นโยบายการคืนเครดิต (สรุป — ไม่รับประกันการคืนเครดิตล่วงหน้า)';
const REFUND_POLICY_LINES = [
  'ระบบคำนวณยอดคืนเมื่อออเดอร์เข้าสถานะสุดท้ายแล้วเท่านั้น ระหว่าง api_processing ยอด price_charged เป็นยอดที่กันไว้ และ refunded ยังไม่ใช่ผลคืนเครดิตสุดท้าย',
  'completed หรือบูสต์ส่งครบตามจำนวนที่ซื้อ: ไม่มีส่วนที่ขาดให้คืน (refunded เป็น 0)',
  'ไม่คืนเครดิตของออเดอร์เมื่อ failure_reason เป็น join_failed, guild_not_found หรือ kicked_after_join (แม้มีบูสต์บางส่วนไม่สำเร็จ ก็ไม่คืนของออเดอร์นั้น)',
  'partial, failed และ api_failed ไม่ได้แปลว่าต้องได้คืนเครดิตเสมอไป ยอดจริงยึดตาม refunded, price_charged และ balance จาก Server เท่านั้น',
  'หากคิดว่าเป็นปัญหาจากฝั่งระบบแต่ยังไม่ได้รับเครดิตคืน ให้ติดต่อแอดมินพร้อม order_id / client_reference',
];
// ====================== Error classes ======================
class ConfigError extends Error {}
class OrderError extends Error {}
class ValidationError extends OrderError {}
class DuplicateSubmit extends OrderError {}
class PreSubmitError extends OrderError {} // ยังไม่ได้ส่ง POST (ไม่มีการหักเครดิต)
class StoreError extends Error {}
class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // http | timeout | network | bad_response | redirect
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.retryAfter = extra.retryAfter ?? null;
    this.body = extra.body ?? null;
  }
  get orderId() {
    const v = this.body && typeof this.body === 'object' ? this.body.order_id : null;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  get isRejection() {
    return this.kind === 'http' && REJECTION_STATUSES.has(this.status);
  }
  get retryableForGet() {
    if (['timeout', 'network', 'bad_response'].includes(this.kind)) return true;
    return this.kind === 'http' && this.status === 429;
  }
}
// ====================== helpers ======================
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
function toNumber(v) {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toInt(v) {
  const n = toNumber(v);
  return n !== null && Number.isInteger(n) ? n : null;
}
function toText(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function snapshotFromApi(d) {
  return {
    order_id: toText(d.order_id),
    status: toText(d.status),
    client_reference: toText(d.client_reference),
    tier: toText(d.tier),
    boosts_requested: toInt(d.boosts_requested),
    boosts_applied: toInt(d.boosts_applied),
    boosts_before: toInt(d.boosts_before),
    boosts_after: toInt(d.boosts_after),
    price_charged: toNumber(d.price_charged),
    refunded: toNumber(d.refunded),
    balance: toNumber(d.balance),
    failure_reason: toText(d.failure_reason),
  };
}
const isFinalSnapshot = (s) => FINAL_STATUSES.has(s.status);
const isUnresolved = (record) => UNRESOLVED_STATES.has(record.state);
function describeOutcome(s) {
  if (!isFinalSnapshot(s)) {
    return [
      'ยังไม่ทราบผลสุดท้ายของออเดอร์นี้ ยังไม่ควรถือว่าเสร็จสิ้น',
      'price_charged ที่เห็นตอนนี้เป็นยอดที่กันไว้ ยังไม่ใช่ยอดจริง และ refunded ยังไม่ใช่ผลคืนเครดิตสุดท้าย',
    ];
  }
  const complete =
    s.status === 'completed' ||
    (s.boosts_requested !== null && s.boosts_applied !== null && s.boosts_applied >= s.boosts_requested);
  if (complete) return ['บูสต์ส่งครบตามจำนวนที่ซื้อ ไม่มีส่วนที่ขาดให้คืน (refunded เป็น 0)'];
  if (s.failure_reason && NO_REFUND_REASONS[s.failure_reason]) {
    return [
      `ออเดอร์นี้มีเหตุที่ระบบไม่คืนเครดิตของออเดอร์: ${s.failure_reason} — ${NO_REFUND_REASONS[s.failure_reason]}`,
      'กรณีนี้แม้มีบูสต์บางส่วนไม่สำเร็จ ระบบก็ไม่คืนเครดิตของออเดอร์นั้น',
      'ตัวเลข refunded / price_charged / balance คือค่าที่ Server ส่งกลับ',
    ];
  }
  return [
    'สถานะนี้ไม่ได้แปลว่าต้องได้คืนเครดิตเสมอไป ยอดจริงยึดตาม refunded, price_charged และ balance ที่ Server ส่งกลับ',
    'หากคิดว่าเป็นปัญหาจากฝั่งระบบแต่ยังไม่ได้รับเครดิตคืน ให้ติดต่อแอดมินพร้อม order_id / client_reference',
  ];
}
// ====================== config ======================
function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError('MELODY_API_BASE_URL ต้องเป็น URL เต็ม เช่น https://melody191.shop/boost-bot-api');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ConfigError('MELODY_API_BASE_URL ต้องขึ้นต้นด้วย https://');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new ConfigError('MELODY_API_BASE_URL ต้องใช้ https:// (กัน API Key วิ่งแบบไม่เข้ารหัส)');
  }
  if (u.search || u.hash || u.username || u.password) {
    throw new ConfigError('MELODY_API_BASE_URL ต้องไม่มี query, fragment หรือ user:password');
  }
  if (u.pathname.replace(/\/+$/, '').endsWith('/api/v1')) {
    throw new ConfigError('MELODY_API_BASE_URL ไม่ต้องใส่ /api/v1 ท้ายสุด (โค้ดต่อ path ให้เอง)');
  }
  return value;
}
function loadConfig() {
  const apiKey = (process.env.MELODY_API_KEY || '').trim();
  if (!apiKey || apiKey.toUpperCase().startsWith('YOUR_')) {
    throw new ConfigError('ไม่พบ MELODY_API_KEY ในไฟล์ .env');
  }
  const baseUrl = normalizeBaseUrl(process.env.MELODY_API_BASE_URL || DEFAULT_BASE_URL);
  const ordersFile = path.resolve((process.env.MELODY_ORDERS_FILE || '').trim() || 'melody_orders.json');
  return { apiKey, baseUrl, ordersFile };
}
// ====================== API client ======================
function createClient(baseUrl, apiKey, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const sleep = opts.sleep || sleepMs;
  const maxGetAttempts = Math.max(1, opts.maxGetAttempts ?? 4);
  // Server ตรวจ Origin ต้องเป็น https://melody191.shop (ตั้งเปลี่ยนได้ด้วย MELODY_API_ORIGIN)
  const origin = opts.origin || process.env.MELODY_API_ORIGIN || 'https://melody191.shop';
  const redact = (t) => (apiKey ? String(t).split(apiKey).join('***') : String(t));
  function parseRetryAfter(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  async function send(method, apiPath, body, timeoutMs) {
    if (!apiPath.startsWith('/api/v1/')) throw new Error('path ต้องขึ้นต้นด้วย /api/v1/');
    const headers = { 'X-API-Key': apiKey, Accept: 'application/json', Origin: origin };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    let text;
    try {
      res = await fetchImpl(baseUrl + apiPath, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual', // ไม่ตามรีไดเรกต์ กัน X-API-Key ไปโฮสต์อื่น
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ApiError('timeout', 'หมดเวลารอการตอบกลับ');
      }
      throw new ApiError('network', redact(`เชื่อมต่อไม่สำเร็จ (${err && err.name}: ${String(err && err.message).slice(0, 200)})`));
    }
    const status = res.status;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const isObject = data !== null && typeof data === 'object' && !Array.isArray(data);

if (status >= 300 && status < 400) {
      throw new ApiError('redirect', `Server ตอบ redirect (HTTP ${status}) ซึ่งไม่ตรงสัญญา API จึงไม่ตามไป`, { status });
    }
    if (status >= 200 && status < 300) {
      if (!isObject) throw new ApiError('bad_response', `Server ตอบ HTTP ${status} แต่ไม่ใช่ JSON object`, { status });
      return data;
    }
    const [code, desc] = HTTP_ERRORS[status] || [null, 'ข้อผิดพลาดที่เอกสารไม่ได้ระบุ'];
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    let message = `HTTP ${status}${code ? ' ' + code : ''}: ${desc}`;
    if (isObject) {
      for (const key of ['message', 'detail', 'error']) {
        if (typeof data[key] === 'string' && data[key].trim()) {
          message += ` (Server แจ้ง: ${data[key].trim().slice(0, 200)})`;
          break;
        }
      }
    }
    if (retryAfter !== null) message += ` — รอ ${retryAfter} วินาทีก่อนส่งคำขอใหม่`;
    throw new ApiError('http', redact(message), { status, code, retryAfter, body: isObject ? data : null });
  }
  async function get(apiPath) {
    let delay = BACKOFF_BASE_S;
    for (let attempt = 1; attempt <= maxGetAttempts; attempt++) {
      try {
        return await send('GET', apiPath, null, GET_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof ApiError) || attempt === maxGetAttempts || !err.retryableForGet) throw err;
        let wait;
        if (err.status === 429 && err.retryAfter !== null) {
          if (err.retryAfter > MAX_RETRY_AFTER_S) throw err;
          wait = err.retryAfter;
        } else {
          wait = delay;
          delay = Math.min(delay * 2, BACKOFF_MAX_S);
        }
        await sleep(wait * 1000);
      }
    }
    throw new Error('unreachable');
  }
  return {
    health: () => get('/api/v1/health'),
    balance: () => get('/api/v1/balance'),
    stock: () => get('/api/v1/stock'),
    pricing: () => get('/api/v1/pricing'),
    getOrder: (id) => get(`/api/v1/order/${encodeURIComponent(String(id))}`),
    getOrderByReference: (ref) => get(`/api/v1/order-reference/${encodeURIComponent(String(ref))}`),
    // POST ส่งครั้งเดียวเสมอ ห้าม retry
    createBoost: (payload) => send('POST', '/api/v1/boost', { ...payload }, POST_TIMEOUT_MS),
  };
}
// ====================== ไฟล์ประวัติออเดอร์ ======================
class OrderStore {
  constructor(file) {
    this.file = file;
  }
  _read() {
    if (!fs.existsSync(this.file)) return { version: 1, orders: {} };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new StoreError(`อ่านไฟล์ประวัติออเดอร์ไม่ได้: ${this.file} — ไม่ได้ลบหรือเขียนทับไฟล์ ตรวจสอบ/กู้ไฟล์ก่อนใช้งานต่อ`);
    }
    if (!data || typeof data.orders !== 'object' || data.orders === null || Array.isArray(data.orders)) {
      throw new StoreError(`รูปแบบไฟล์ประวัติออเดอร์ไม่ถูกต้อง: ${this.file}`);
    }
    return data;
  }
  get(ref) {
    return this._read().orders[ref] || null;
  }
  list() {
    return Object.values(this._read().orders).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }
  put(record) {
    const data = this._read();
    data.orders[record.client_reference] = record;
    this._write(data);
  }
  _write(data) {
    const dir = path.dirname(this.file);
    const tmp = path.join(dir, `.orders-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file); // atomic
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw new StoreError(`บันทึกไฟล์ประวัติออเดอร์ไม่ได้ (${err && err.code ? err.code : err && err.name})`);
    }
  }
}
// ====================== ตรรกะออเดอร์ ======================
function validateRequest(server, tier, amount, nick = '') {
  const srv = typeof server === 'string' ? server.trim() : '';
  if (!srv) throw new ValidationError('ต้องใส่ลิงก์เชิญเซิร์ฟเวอร์ Discord');
  if (/\s/.test(srv)) throw new ValidationError('ลิงก์เชิญต้องไม่มีช่องว่าง');
  const t = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  if (!TIERS.includes(t)) throw new ValidationError('แพ็กต้องเป็น 1m หรือ 3m เท่านั้น');
  let n = amount;
  if (typeof n === 'string') {
    if (!/^\d+$/.test(n.trim())) throw new ValidationError('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
    n = parseInt(n.trim(), 10);
  }
  if (!Number.isInteger(n)) throw new ValidationError('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
  if (n < 2) throw new ValidationError('จำนวนบูสต์ต้องไม่น้อยกว่า 2');
  if (n % 2 !== 0) throw new ValidationError('จำนวนบูสต์ต้องเป็นเลขคู่');
  const nk = typeof nick === 'string' ? nick.trim() : '';
  if (nk.length > MAX_NICK_LENGTH) throw new ValidationError(`nick ต้องยาวไม่เกิน ${MAX_NICK_LENGTH} ตัวอักษร`);
  return { server: srv, tier: t, amount: n, nick: nk };
}
const looksLikeInvite = (s) => /(discord\.gg\/|discord(app)?\.com\/invite\/)/i.test(s);

function createService(client, store, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const trackTimeoutMs = opts.trackTimeoutMs ?? TRACK_TIMEOUT_MS;
  const sleep = opts.sleep || sleepMs;
  const trackingNow = new Set();
  let mutex = Promise.resolve();
  const withLock = (fn) => {
    const run = mutex.then(fn);
    mutex = run.catch(() => {});
    return run;
  };
  const requireRecord = (ref) => {
    const record = store.get(ref);
    if (!record) throw new OrderError(`ไม่พบออเดอร์ในไฟล์ประวัติ: ${ref}`);
    return record;
  };
  function save(record) {
    record.updated_at = nowIso();
    store.put(record);
  }
  function applySnapshot(record, snap) {
    if (snap.order_id && !record.order_id) record.order_id = snap.order_id;
    record.last_snapshot = snap; // เก็บตามที่ Server ส่ง ไม่แก้ตัวเลขเอง
    record.state = isFinalSnapshot(snap) ? 'final' : 'tracking';
    record.error_code = null;
    record.note = null;
    save(record);
  }
  async function fetchSnapshot(record) {
    const data = record.order_id
      ? await client.getOrder(record.order_id)
      : await client.getOrderByReference(record.client_reference);
    const snap = snapshotFromApi(data);
    if (snap.client_reference && snap.client_reference !== record.client_reference) {
      throw new ApiError('bad_response', 'client_reference ในผลลัพธ์ไม่ตรงกับที่บันทึกไว้ จึงไม่ใช้ผลนี้');
    }
    if (snap.order_id && record.order_id && snap.order_id !== record.order_id) {
      throw new ApiError('bad_response', 'order_id ในผลลัพธ์ไม่ตรงกับที่บันทึกไว้ จึงไม่ใช้ผลนี้');
    }
    return snap;
  }

// ---------- เตรียมออเดอร์ (อ่านอย่างเดียว ยังไม่หักเครดิต) ----------
  async function prepare(server, tier, amount, nick = '') {
    const request = validateRequest(server, tier, amount, nick);
    for (const r of store.list()) {
      if (isUnresolved(r) && r.server === request.server && r.tier === request.tier && r.amount === request.amount) {
        throw new OrderError(
          `มีออเดอร์พารามิเตอร์เดียวกันที่ยังไม่ทราบผลสุดท้าย (client_reference: ${r.client_reference}) — ให้ติดตามอันเดิมก่อนด้วย !boosttrack ไม่สร้างซ้ำ`,
        );
      }
    }
    const balance = toNumber((await client.balance()).balance);
    const stock = toInt((await client.stock())[`boosts_${request.tier}_available`]);
    const price = toNumber((await client.pricing())[`price_${request.tier}`]);
    const warnings = [];
    if (balance === null) warnings.push('ไม่ทราบเครดิตคงเหลือ (Server ไม่ได้ส่งฟิลด์ balance)');
    if (stock === null) warnings.push(`ไม่ทราบสต็อก (ไม่มีฟิลด์ boosts_${request.tier}_available)`);
    else if (request.amount > stock) {
      warnings.push(`จำนวนที่สั่ง (${request.amount}) มากกว่าสต็อกที่ Server แจ้ง (${stock}) — อาจโดนปฏิเสธด้วย 409 stock_conflict`);
    }
    if (price === null) warnings.push(`ไม่ทราบราคา (ไม่มีฟิลด์ price_${request.tier})`);
    if (!looksLikeInvite(request.server)) {
      warnings.push('ลิงก์ที่ใส่ไม่เหมือนลิงก์เชิญ Discord (เช่น https://discord.gg/xxxx) — ถ้าใช้ไม่ได้ Server จะตอบ 400');
    }
    return { request, quote: { balance, stock, price, warnings }, submitted: false };
  }
  function afterPostError(record, err) {
    const orderId = err.orderId;
    if (orderId) {
      record.order_id = orderId;
      record.state = 'tracking';
      record.note = `POST ได้ข้อผิดพลาด (${err.status}) แต่ Server แนบ order_id มา — ติดตามออเดอร์เดิมต่อ ห้ามสร้างซ้ำ`;
    } else if (err.isRejection) {
      record.state = 'rejected';
      record.error_code = err.code;
      record.note = err.message;
    } else {
      record.state = 'unconfirmed';
      record.note = `ยืนยันผล POST ไม่ได้ (${err.message}) — ห้ามสร้างซ้ำ ให้ค้นออเดอร์เดิมด้วย client_reference`;
    }
    save(record);
  }

// ---------- สร้างออเดอร์ (POST ครั้งเดียว) ----------
  function submit(draft) {
    return withLock(async () => {
      if (draft.submitted) throw new DuplicateSubmit('รายการนี้ถูกส่งไปแล้ว ไม่ส่งซ้ำ — ดูผลด้วย !boosttrack');
      draft.submitted = true; // ตั้งก่อนทำอย่างอื่น กันกดซ้ำ
      const t = nowIso();
      const req = draft.request;
      const record = {
        client_reference: `order-${crypto.randomUUID().replace(/-/g, '')}`,
        server: req.server,
        tier: req.tier,
        amount: req.amount,
        nick: req.nick,
        state: 'posting',
        created_at: t,
        updated_at: t,
        order_id: null,
        last_snapshot: null,
        error_code: null,
        note: null,
      };
      try {
        store.put(record); // บันทึกก่อนส่ง POST เสมอ — เก็บไม่ได้ = ไม่ส่ง
      } catch (err) {
        draft.submitted = false;
        throw new PreSubmitError(`${err.message} — จึงยังไม่ได้ส่งออเดอร์ (ไม่มีการหักเครดิต)`);
      }
      let data;
      try {
        data = await client.createBoost({
          server: req.server,
          tier: req.tier,
          amount: req.amount,
          nick: req.nick,
          client_reference: record.client_reference,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          afterPostError(record, err);
          return record;
        }
        throw err; // record ยัง "posting" => เปิดบอทใหม่แล้วค้นด้วย reference
      }
       const snap = snapshotFromApi(data);
      if (!snap.order_id) {
        record.state = 'unconfirmed';
        record.note = 'POST ตอบกลับแต่ไม่มี order_id จึงยืนยันผลไม่ได้ — ห้ามสร้างซ้ำ ให้ค้นด้วย client_reference';
        save(record);
        return record;
      }
      applySnapshot(record, snap);
      return record;
    });
  }
  // ---------- ติดตามออเดอร์ (ไม่ POST ในฟังก์ชันนี้เด็ดขาด) ----------
  async function track(ref, onUpdate) {
    const record = requireRecord(ref);
    if (!isUnresolved(record)) return record;
    if (trackingNow.has(ref)) throw new OrderError('กำลังติดตามออเดอร์นี้อยู่แล้ว');
    trackingNow.add(ref);
    try {
      const deadline = Date.now() + trackTimeoutMs;
      for (;;) {
        let snap = null;
        let problem = null;
        try {
          snap = await fetchSnapshot(record);
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          if (err.kind === 'http' && FATAL_TRACK_STATUSES.has(err.status)) throw err; // record ยังอยู่ในไฟล์
          problem = err; // 404 / 5xx / เครือข่าย => รอแล้วลองใหม่ ไม่สรุปผล
        }
        if (snap) applySnapshot(record, snap);
        if (onUpdate) {
          try {
            await onUpdate(record, snap, problem);
          } catch (e) {
            console.error('[melody-boost] onUpdate error:', e && e.message);
          }
        }
        if (record.state === 'final') return record;
        if (Date.now() >= deadline) {
          record.state = 'pending_review';
          record.note = `ติดตามเกิน ${Math.floor(trackTimeoutMs / 60000)} นาทีแล้วยังไม่ทราบผล — บันทึกเป็นรอตรวจสอบ ติดตามต่อได้ด้วย !boosttrack (ห้ามสร้างใหม่) หรือติดต่อแอดมินพร้อม order_id / client_reference`;
          save(record);
          return record;
        }
        await sleep(pollIntervalMs);
      }
    } finally {
      trackingNow.delete(ref);
    }
  }
  async function refresh(ref) {
    const record = requireRecord(ref);
    if (record.state === 'rejected') return record;
    applySnapshot(record, await fetchSnapshot(record));
    return record;
  }
  async function lookup(kind, value) {
    const v = (value || '').trim();
    if (!v) throw new ValidationError('ต้องระบุค่าที่จะค้นหา');
    if (kind === 'order_id') return snapshotFromApi(await client.getOrder(v));
    if (kind === 'client_reference') return snapshotFromApi(await client.getOrderByReference(v));
    throw new ValidationError('ชนิดการค้นหาไม่ถูกต้อง');
  }
  return {
    prepare,
    submit,
    track,
    refresh,
    lookup,
    get: (ref) => store.get(ref),
    unresolved: () => store.list().filter(isUnresolved),
    list: () => store.list(),
    isTracking: (ref) => trackingNow.has(ref),
    client,
  };
}

// ====================== ส่วนเชื่อม discord.js ======================
// หมายเหตุ: 'boostshop' ถูกย้ายไปให้ customerShop.js จัดการ (หน้าร้านออโต้ ราคา 9/24) จึงไม่อยู่ในรายการนี้แล้ว
const COMMANDS = new Set(['boost', 'boostinfo', 'boostpending', 'boosttrack', 'boostfind', 'boostpolicy', 'test']);
/**
 * @param discordClient  discord.js Client (ต้องเปิด intents: Guilds, GuildMessages, MessageContent)
 * @param options        { prefix?: '!', adminIds?: string[], logChannelId?: string }
 * @param options        {
 *   prefix?: string,           adminIds?: string[],        logChannelId?: string,
 *   shopBannerUrl?: string,     shopThumbUrl?: string,      shopFooterIconUrl?: string,
 *   rainbowBarUrl?: string,     promptpayNumber?: string,   truemoneyNumber?: string,
 * }
 *
 * ── แถบ RGB ขยับได้ ──────────────────────────────────────────────────────────
 *  ตั้ง rainbowBarUrl ให้ชี้ไปที่ไฟล์ .gif (animated) เพื่อให้ไฟวิ่ง
 *  ตัวอย่าง GIF สาธารณะที่ใช้ได้ทันที:
 *    https://i.imgur.com/wSTFkRM.gif   (rainbow bar เรืองแสงวิ่ง)
 *  หรืออัปโหลด GIF ของตัวเองไปที่ Discord CDN / Imgur แล้วใส่ URL นั้น
 * ──────────────────────────────────────────────────────────────────────────────
 */
function setupMelodyBoost(discordClient, options = {}) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
  } = require('discord.js');
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[melody-boost] ปิดใช้งานคำสั่งบูสต์: ${err.message}`);
    return null;
  }

   const prefix = options.prefix || '!';
  const adminIds = new Set(
    (options.adminIds || String(process.env.BOOST_ADMIN_IDS || '').split(',')).map((s) => String(s).trim()).filter(Boolean),
  );
  const cleanUrl = (name, value) => {
    const v = String(value || '').trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') return v;
    } catch {
      /* ไม่ใช่ URL */
    }
    console.warn(`[melody-boost] ข้าม ${name}: ไม่ใช่ลิงก์ http(s) ที่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return null;
  };
  const adminRoleIds = new Set(
    (options.adminRoleIds || String(process.env.BOOST_ADMIN_ROLE_IDS || '').split(',')).map((x) => String(x).trim()).filter(Boolean),
  );
  const logChannelId      = options.logChannelId     || (process.env.BOOST_LOG_CHANNEL_ID    || '').trim() || null;
  // ── Shop Embed ──
  const shopBannerUrl     = cleanUrl('shopBannerUrl', options.shopBannerUrl    || (process.env.BOOST_SHOP_BANNER_URL   || '').trim());
  const shopThumbUrl      = cleanUrl('shopThumbUrl', options.shopThumbUrl     || (process.env.BOOST_SHOP_THUMB_URL    || '').trim());
  const shopFooterIconUrl = cleanUrl('shopFooterIconUrl', options.shopFooterIconUrl|| (process.env.BOOST_SHOP_FOOTER_ICON  || '').trim());
  // ── เติมเครดิต (ใส่ .gif URL เพื่อให้ RGB วิ่ง) ──
  const rainbowBarUrl     = cleanUrl('rainbowBarUrl', options.rainbowBarUrl    || (process.env.BOOST_RAINBOW_BAR_URL   || '').trim());
  const promptpayNumber   = options.promptpayNumber  || (process.env.BOOST_PROMPTPAY_NUMBER  || '').trim();
  const truemoneyNumber   = options.truemoneyNumber  || (process.env.BOOST_TRUEMONEY_NUMBER  || '').trim();
  const store = new OrderStore(cfg.ordersFile);
  const service = createService(createClient(cfg.baseUrl, cfg.apiKey), store);
  const drafts = new Map(); // id -> { draft, userId }
  // ---------- สิทธิ์ ----------
  // ใช้ได้ถ้า: มี Role ใน BOOST_ADMIN_ROLE_IDS หรือ User ID อยู่ใน BOOST_ADMIN_IDS
  // ถ้าไม่ได้ตั้งทั้งสองอย่าง ใช้ได้เฉพาะคนที่มีสิทธิ์ Administrator
  const hasAdminRole = (member) => {
    if (!member || !member.roles || adminRoleIds.size === 0) return false;
    if (member.roles.cache) return member.roles.cache.some((_, id) => adminRoleIds.has(id));
    if (Array.isArray(member.roles)) return member.roles.some((id) => adminRoleIds.has(id));
    return false;
  };
  const isAdmin = (member, userId) => {
    if (adminIds.size > 0 || adminRoleIds.size > 0) return adminIds.has(userId) || hasAdminRole(member);
    return Boolean(member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator));
  };
  // ---------- ตัวช่วยแสดงผล ----------
  const fmt = (v) => (v === null || v === undefined ? 'ไม่ทราบ' : String(v));
  const cut = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));
  const mono = (v) => `\`${cut(fmt(v), 200)}\``;
  const friendly = (err) => {
    if (err instanceof ApiError || err instanceof OrderError || err instanceof StoreError || err instanceof ConfigError) {
      return err.message;
    }
    return 'เกิดข้อผิดพลาดภายในบอท (ดู log ในเทอร์มินัล)';
  };

const policyEmbed = () =>
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(REFUND_POLICY_TITLE)
      .setDescription(REFUND_POLICY_LINES.map((l) => `• ${l}`).join('\n'));
  const confirmPayload = (draft, id) => {
    const { request: r, quote: q } = draft;
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📋 ตรวจสอบออเดอร์ก่อนยืนยัน')
      .addFields(
        { name: 'เซิร์ฟเวอร์ (ลิงก์เชิญ)', value: cut(r.server, 1000) },
        { name: 'แพ็ก', value: r.tier, inline: true },
        { name: 'จำนวนบูสต์', value: String(r.amount), inline: true },
        { name: 'nick', value: r.nick || '-', inline: true },
        { name: 'เครดิตคงเหลือ', value: fmt(q.balance), inline: true },
        { name: `สต็อก ${r.tier}`, value: fmt(q.stock), inline: true },
        { name: `ราคา ${r.tier} (ตามที่ Server แจ้ง)`, value: fmt(q.price), inline: true },
      )
      .setFooter({ text: 'ไม่ระบุหน่วยราคา จึงไม่คำนวณยอดรวมให้ • กดยืนยันแล้วจะหักเครดิตจริง' });
    if (q.warnings.length) embed.setDescription(q.warnings.map((w) => `⚠️ ${w}`).join('\n'));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mb:ok:${id}`).setLabel('ยืนยันสั่งซื้อ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`mb:no:${id}`).setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed, policyEmbed()], components: [row], allowedMentions: { repliedUser: false } };
  };
  const snapshotFields = (record, s) => {
    const fields = [
      { name: 'client_reference', value: mono(record.client_reference) },
      { name: 'order_id', value: mono(record.order_id || (s && s.order_id)), inline: true },
      { name: 'สถานะ', value: fmt(s && s.status), inline: true },
      { name: 'บูสต์ (ส่งสำเร็จ / ที่สั่ง)', value: `${fmt(s && s.boosts_applied)} / ${fmt(s ? s.boosts_requested : record.amount)}`, inline: true },
    ];
    if (s) {
      fields.push(
        { name: 'price_charged', value: fmt(s.price_charged), inline: true },
        { name: 'refunded', value: fmt(s.refunded), inline: true },
        { name: 'balance', value: fmt(s.balance), inline: true },
      );
      if (s.failure_reason) fields.push({ name: 'failure_reason', value: mono(s.failure_reason) });
    }
    return fields;
  };

 const statusPayload = (record, snap, problem) => {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('⏳ กำลังติดตามออเดอร์')
      .addFields(snapshotFields(record, snap || record.last_snapshot));
    const lines = [];
    if (record.note) lines.push(cut(record.note, 800));
    if (problem) lines.push(`ติดต่อ API ไม่สำเร็จชั่วคราว จะลองใหม่อัตโนมัติ: ${cut(problem.message, 300)}`);
    lines.push('ยังไม่ทราบผลสุดท้าย — ห้ามสั่งซ้ำ');
    embed.setDescription(lines.join('\n'));
    return { content: '', embeds: [embed], components: [] };
  };
  const resultPayload = (record) => {
    if (record.state === 'rejected') {
      return {
        content: '',
        components: [],
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('❌ Server ปฏิเสธคำขอ (ไม่มีออเดอร์เกิดขึ้น)')
            .setDescription(cut(record.note || '', 1500))
            .addFields({ name: 'client_reference', value: mono(record.client_reference) }),
        ],
      };
    }
    const snap = record.last_snapshot;
    if (record.state === 'final' && snap) {
      const color = snap.status === 'completed' ? 0x57f287 : snap.status === 'partial' ? 0xe67e22 : 0xed4245;
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`📦 ผลออเดอร์: ${snap.status}`)
        .setDescription(describeOutcome(snap).map((l) => `• ${l}`).join('\n'))
        .addFields(snapshotFields(record, snap));
      return { content: '', embeds: [embed], components: [] };
    }
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🕒 ยังไม่ทราบผลสุดท้าย — รอตรวจสอบ')
      .setDescription(cut(`${record.note || ''}\n\nห้ามสั่งซ้ำ ติดตามต่อด้วย \`${prefix}boosttrack ${record.client_reference}\``, 1500))
      .addFields(snapshotFields(record, snap));
    return { content: '', embeds: [embed], components: [] };
  };

const errorPayload = (err, ref) => ({
    content: '',
    components: [],
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚠️ เกิดข้อผิดพลาด')
        .setDescription(
          cut(
            `${friendly(err)}${
              ref && !(err instanceof PreSubmitError)
                ? `\n\nออเดอร์ยังถูกบันทึกไว้ ห้ามสั่งซ้ำ ติดตามต่อด้วย \`${prefix}boosttrack ${ref}\``
                : ''
            }`,
            1800,
          ),
        ),
    ],
  });
  // ---------- ติดตามเบื้องหลัง ----------
  const makeEdit = (msg) => (payload) =>
    msg.edit(payload).catch((e) => console.error('[melody-boost] แก้ข้อความไม่ได้:', e && e.message));
  const makeOnUpdate = (edit) => {
    let lastKey = null;
    return async (record, snap, problem) => {
      const key = `${snap && snap.status}|${snap && snap.boosts_applied}|${problem ? problem.message : ''}`;
      if (key === lastKey) return;
      lastKey = key;
      if (record.state !== 'final') await edit(statusPayload(record, snap, problem));
    };
  };

 function trackInBackground(ref, msg) {
    const edit = makeEdit(msg);
    service
      .track(ref, makeOnUpdate(edit))
      .then((final) => edit(resultPayload(final)))
      .catch((err) => {
        console.error('[melody-boost] track error:', err && err.message);
        return edit(errorPayload(err, ref));
      });
  }
  async function runOrder(msg, draft) {
    const edit = makeEdit(msg);
    let ref = null;
    try {
      const record = await service.submit(draft);
      ref = record.client_reference;
      if (!isUnresolved(record)) {
        await edit(resultPayload(record));
        return;
      }
      await edit(statusPayload(record, null, null));
      const final = await service.track(ref, makeOnUpdate(edit));
      await edit(resultPayload(final));
    } catch (err) {
      console.error('[melody-boost] runOrder error:', err && err.message);
      await edit(errorPayload(err, ref));
    }
  }

  // ---------- หน้าร้านค้า (Shop Embed) ----------
  const PRICE_UNIT = 'บาท';
  const TIER_LABEL = { '1m': '1 เดือน', '3m': '3 เดือน' };
  const block = (text) => `\`\`\`${text}\`\`\``;
  const withUnit = (v, unit) => (v === null || v === undefined ? 'ไม่ทราบ' : `${v} ${unit}`);

  async function buildShopPayload() {
    const [stockR, priceR] = await Promise.allSettled([service.client.stock(), service.client.pricing()]);
    if (stockR.status === 'rejected') console.error('[melody-boost] shop: ดึงสต็อกไม่ได้:', stockR.reason && stockR.reason.message);
    if (priceR.status === 'rejected') console.error('[melody-boost] shop: ดึงราคาไม่ได้:', priceR.reason && priceR.reason.message);
    const stock = stockR.status === 'fulfilled' && stockR.value ? stockR.value : {};
    const pricing = priceR.status === 'fulfilled' && priceR.value ? priceR.value : {};
    const info = {};
    for (const t of TIERS) {
      info[t] = {
        price: toNumber(pricing[`price_${t}`]),
        left: toInt(stock[`boosts_${t}_available`]),
        total: toInt(stock[`boosts_${t}_total`]),
      };
    }
    const embed = new EmbedBuilder().setColor(0x5865f2);
    for (const t of TIERS) {
      embed.addFields(
        { name: `🔮 บูสต์ ${TIER_LABEL[t]}`, value: block(withUnit(info[t].price, PRICE_UNIT)), inline: true },
        { name: '⌛ เหลือจำนวน', value: block(withUnit(info[t].left, 'บูสต์')), inline: true },
        { name: '📦 บูสต์แล้วทั้งหมด', value: block(withUnit(info[t].total, 'บูสต์')), inline: true },
      );
    }
    if (shopBannerUrl) embed.setImage(shopBannerUrl);
    if (shopThumbUrl) embed.setThumbnail(shopThumbUrl);
    const footer = { text: '◟ 𝜀 © Melody Shop , All Rights Reserved ȝ ◞ ♡' };
    if (shopFooterIconUrl) footer.iconURL = shopFooterIconUrl;
    embed.setFooter(footer);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('mb:shop:tier')
      .setPlaceholder('📦 เลือกประเภทบูสต์เซิร์ฟเวอร์')
      .addOptions(
        ...TIERS.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`บูสต์เซิร์ฟเวอร์ ${TIER_LABEL[t]}`)
            .setDescription(cut(`ราคา ${withUnit(info[t].price, PRICE_UNIT)} | คงเหลือ ${fmt(info[t].left)}`, 100))
            .setValue(t)
            .setEmoji('🔮'),
        ),
        new StringSelectMenuOptionBuilder().setLabel('ยกเลิก').setDescription('ปิดเมนูนี้ ไม่สั่งซื้อ').setValue('cancel').setEmoji('❌'),
      );
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mb:shop:topup').setLabel('เติมเครดิต').setStyle(ButtonStyle.Secondary).setEmoji('💰'),
      new ButtonBuilder().setCustomId('mb:shop:check').setLabel('เช็คเครดิต').setStyle(ButtonStyle.Secondary).setEmoji('💳'),
    );
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), buttons] };
  }

  const PAY_CHANNELS = {
    promptpay: { label: 'พร้อมเพย์', emoji: '💳', color: 0x1e88e5, number: () => promptpayNumber },
    truemoney: { label: 'TrueMoney Wallet', emoji: '🧧', color: 0xff6a00, number: () => truemoneyNumber },
  };
  const payPayload = (selected) => {
    const embed = new EmbedBuilder()
      .setColor(selected ? PAY_CHANNELS[selected].color : 0x5865f2)
      .setTitle('🏦 เลือกช่องทางการเติมเงิน');
    for (const [key, ch] of Object.entries(PAY_CHANNELS)) {
      const on = key === selected;
      embed.addFields({
        name: `${on ? '✨ ' : ''}${ch.emoji} ${ch.label}${on ? '  ◀ เลือกอยู่' : ''}`,
        value: block(ch.number() || 'ยังไม่ได้ตั้งค่า'),
      });
    }
    embed.setFooter({ text: 'โอนแล้วแจ้งแอดมินพร้อมสลิป' });
    if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('mb:pay:select')
      .setPlaceholder('เลือกช่องทางการเติมเงิน')
      .addOptions(
        ...Object.entries(PAY_CHANNELS).map(([key, ch]) =>
          new StringSelectMenuOptionBuilder().setLabel(ch.label).setValue(key).setEmoji(ch.emoji).setDefault(key === selected),
        ),
        new StringSelectMenuOptionBuilder().setLabel('ยกเลิก').setValue('cancel').setEmoji('❌'),
      );
    return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
  };

 // ---------- คำสั่งข้อความ ----------
  const reply = (message, payload) =>
    message.reply(typeof payload === 'string' ? { content: payload, allowedMentions: { repliedUser: false } } : { allowedMentions: { repliedUser: false }, ...payload });
  async function handleCommand(message, cmd, args) {
    if (cmd === 'boostshop') {
      const payload = await buildShopPayload();
      await message.channel.send(payload);
      message.delete().catch(() => {}); // ลบข้อความคำสั่ง (ต้องมีสิทธิ์ Manage Messages ถ้าไม่มีจะข้ามไป)
      return;
    }
    if (cmd === 'boost') {
      const [server, tier, amount, ...nick] = args;
      if (!server || !tier || !amount) {
        await reply(message, `วิธีใช้: \`${prefix}boost <ลิงก์เชิญ> <1m|3m> <จำนวนบูสต์ (เลขคู่ ≥ 2)> [nick]\``);
        return;
      }
      const draft = await service.prepare(server, tier, amount, nick.join(' '));
      const id = crypto.randomBytes(6).toString('hex');
      drafts.set(id, { draft, userId: message.author.id });
      setTimeout(() => drafts.delete(id), DRAFT_TTL_MS).unref();
      await reply(message, confirmPayload(draft, id));
      return;
    }
    if (cmd === 'boostinfo') {
      const [bal, stock, pricing] = await Promise.all([
        service.client.balance(),
        service.client.stock(),
        service.client.pricing(),
      ]);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('ℹ️ ข้อมูล Melody Boost (ตามที่ Server แจ้ง)')
        .addFields(
          { name: 'เครดิตคงเหลือ', value: fmt(toNumber(bal.balance)), inline: true },
          { name: 'สต็อก 1m', value: fmt(toInt(stock.boosts_1m_available)), inline: true },
          { name: 'สต็อก 3m', value: fmt(toInt(stock.boosts_3m_available)), inline: true },
          { name: 'ราคา 1m', value: fmt(toNumber(pricing.price_1m)), inline: true },
          { name: 'ราคา 3m', value: fmt(toNumber(pricing.price_3m)), inline: true },
        )
        .setFooter({ text: 'ไม่ระบุหน่วยราคา จึงแสดงตามค่าที่ Server ส่งมา' });
      await reply(message, { embeds: [embed] });
      return;
    }
    if (cmd === 'boostpolicy') {
      await reply(message, { embeds: [policyEmbed()] });
      return;
    }

if (cmd === 'boostpending') {
      const list = service.unresolved();
      if (!list.length) {
        await reply(message, '✅ ไม่มีออเดอร์ค้าง');
        return;
      }
      const lines = list.slice(0, 10).map(
        (r) => `• \`${r.client_reference}\` — ${r.state} — ${r.tier} x${r.amount} — ${cut(r.server, 60)}`,
      );
      await reply(message, { embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`ออเดอร์ที่ยังไม่ทราบผล (${list.length})`).setDescription(lines.join('\n'))] });
      return;
    }
    if (cmd === 'boosttrack') {
      const ref = args[0];
      if (!ref) {
        await reply(message, `วิธีใช้: \`${prefix}boosttrack <client_reference>\` (ดูรายการด้วย \`${prefix}boostpending\`)`);
        return;
      }
      const record = service.get(ref);
      if (!record) {
        await reply(message, `ไม่พบออเดอร์ในไฟล์ประวัติ — ลอง \`${prefix}boostfind\` เพื่อค้นจาก Server`);
        return;
      }
      if (!isUnresolved(record)) {
        await reply(message, resultPayload(await service.refresh(ref)));
        return;
      }
      if (service.isTracking(ref)) {
        await reply(message, 'กำลังติดตามออเดอร์นี้อยู่แล้ว');
        return;
      }
      const msg = await reply(message, statusPayload(record, null, null));
      trackInBackground(ref, msg);
      return;
    }
    if (cmd === 'boostfind') {
      const value = args[0];
      if (!value) {
        await reply(message, `วิธีใช้: \`${prefix}boostfind <order_id หรือ client_reference>\` (อ่านอย่างเดียว ไม่สร้างออเดอร์)`);
        return;
      }
       const kind = value.startsWith('order-') ? 'client_reference' : 'order_id';
      const snap = await service.lookup(kind, value);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔎 พบออเดอร์: ${fmt(snap.status)}`)
        .setDescription(describeOutcome(snap).map((l) => `• ${l}`).join('\n'))
        .addFields(snapshotFields({ client_reference: snap.client_reference, order_id: snap.order_id, amount: snap.boosts_requested }, snap));
      await reply(message, { embeds: [embed] });
    }
  }

  // ---------- !test — จำลองบูสต์ทั้งขั้นตอน ไม่เรียก Melody จริง ไม่หักเครดิต ----------
  const TEST_ROLE_ID = '1563463222814838824';
  const hasTestRole = (member) => {
    if (!member || !member.roles) return false;
    if (member.roles.cache) return member.roles.cache.has(TEST_ROLE_ID);
    if (Array.isArray(member.roles)) return member.roles.includes(TEST_ROLE_ID);
    return false;
  };

  async function handleTestCommand(message, args) {
    // เช็คสิทธิ์: ต้องมี role TEST_ROLE_ID
    if (!hasTestRole(message.member)) {
      await reply(message, `⛔ คำสั่ง \`${prefix}test\` ใช้ได้เฉพาะยศ <@&${TEST_ROLE_ID}> เท่านั้น`);
      return;
    }

    const [server, tier, amount] = args;
    if (!server || !tier || !amount) {
      await reply(message, `วิธีใช้: \`${prefix}test <ลิงก์เชิญ> <1m|3m> <จำนวนบูสต์ (เลขคู่ ≥ 2)>\`\n⚠️ โหมดทดสอบ: ไม่เรียก Melody จริง ไม่หักเครดิต`);
      return;
    }

    // Validate input (ใช้ validateRequest เดิม)
    let request;
    try {
      request = validateRequest(server, tier, amount);
    } catch (err) {
      await reply(message, `⚠️ ${err.message}`);
      return;
    }

    const mockRef = `test-${crypto.randomBytes(6).toString('hex')}`;

    // ขั้นตอน 1: แสดงหน้ายืนยัน (จำลอง)
    const prepEmbed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🧪 [TEST MODE] ตรวจสอบออเดอร์')
      .setDescription('⚠️ **โหมดทดสอบ** — ไม่เรียก Melody API จริง ไม่หักเครดิต')
      .addFields(
        { name: 'เซิร์ฟเวอร์', value: cut(request.server, 1000) },
        { name: 'แพ็ก', value: request.tier, inline: true },
        { name: 'จำนวนบูสต์', value: String(request.amount), inline: true },
        { name: 'client_reference', value: `\`${mockRef}\`` },
      )
      .setFooter({ text: 'กด ✅ เพื่อจำลองส่งออเดอร์ หรือ ❌ ยกเลิก' });

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const testRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mb:testok:${mockRef}`).setLabel('จำลองส่งออเดอร์').setStyle(ButtonStyle.Success).setEmoji('🧪'),
      new ButtonBuilder().setCustomId(`mb:testno:${mockRef}`).setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
    );

    const msg = await reply(message, { embeds: [prepEmbed], components: [testRow] });

    // เก็บข้อมูลสำหรับ button handler
    testDrafts.set(mockRef, { request, userId: message.author.id, msg });
    setTimeout(() => testDrafts.delete(mockRef), 5 * 60_000).unref();
  }

  const testDrafts = new Map();

  // Button handler สำหรับ test
  discordClient.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      const cid = interaction.customId;
      if (!cid.startsWith('mb:testok:') && !cid.startsWith('mb:testno:')) return;

      const ref = cid.replace(/^mb:test(ok|no):/, '');
      const entry = testDrafts.get(ref);
      if (!entry) {
        await interaction.reply({ content: 'รายการทดสอบนี้หมดอายุแล้ว', ephemeral: true });
        return;
      }
      if (interaction.user.id !== entry.userId) {
        await interaction.reply({ content: 'เฉพาะคนที่สั่ง test เท่านั้นที่กดได้', ephemeral: true });
        return;
      }
      testDrafts.delete(ref);

      if (cid.startsWith('mb:testno:')) {
        await interaction.update({ content: '🧪 [TEST] ยกเลิกแล้ว', embeds: [], components: [] });
        return;
      }

      // จำลองขั้นตอน
      await interaction.update({ content: '🧪 [TEST] ⏳ กำลังจำลองสร้างออเดอร์...', embeds: [], components: [] });
      const editMsg = interaction.message;
      const editFn = (p) => editMsg.edit(p).catch(() => {});

      // Step 1: จำลอง POST (รอ 2 วิ)
      await sleepMs(2000);
      await editFn({
        content: '',
        embeds: [new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('🧪 [TEST] ⏳ กำลังติดตามออเดอร์')
          .setDescription(`จำลอง: บูสต์ 0/${entry.request.amount}`)
          .addFields(
            { name: 'client_reference', value: `\`${ref}\`` },
            { name: 'สถานะ', value: 'api_processing', inline: true },
          )],
      });

      // Step 2: จำลอง progress (0 → partial → complete)
      const steps = Math.min(entry.request.amount / 2, 5);
      const perStep = Math.ceil(entry.request.amount / steps);
      let applied = 0;

      for (let i = 0; i < steps; i++) {
        await sleepMs(1500);
        applied = Math.min(applied + perStep, entry.request.amount);
        const status = applied >= entry.request.amount ? 'completed' : 'api_processing';
        await editFn({
          content: '',
          embeds: [new EmbedBuilder()
            .setColor(status === 'completed' ? 0x57f287 : 0x3498db)
            .setTitle(`🧪 [TEST] ${status === 'completed' ? '✅ เสร็จสิ้น' : '⏳ กำลังบูสต์'}`)
            .setDescription(`จำลอง: บูสต์ ${applied}/${entry.request.amount}`)
            .addFields(
              { name: 'client_reference', value: `\`${ref}\`` },
              { name: 'สถานะ', value: status, inline: true },
              { name: 'บูสต์', value: `${applied}/${entry.request.amount}`, inline: true },
            )],
        });
      }

      // Step 3: ผลสุดท้าย
      await sleepMs(1000);
      await editFn({
        content: '',
        embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🧪 [TEST] ✅ จำลองบูสต์สำเร็จ')
          .setDescription([
            '**โหมดทดสอบ** — ไม่มีการเรียก Melody API จริง ไม่มีการหักเครดิต',
            `บูสต์สำเร็จ (จำลอง): ${entry.request.amount}/${entry.request.amount}`,
            `client_reference: \`${ref}\``,
            '',
            '✅ ระบบทำงานปกติ พร้อมใช้งานจริง',
          ].join('\n'))
          .setFooter({ text: 'TEST MODE — ไม่มีผลกระทบใด ๆ กับระบบจริง' })],
      });
    } catch (err) {
      console.error('[melody-boost] test interaction error:', err);
    }
  });

  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;
      if (!message.content.startsWith(prefix)) return;
      const [rawCmd, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
      const cmd = (rawCmd || '').toLowerCase();
      if (!COMMANDS.has(cmd)) return;

      // !test ใช้ role เฉพาะ ไม่ต้องเป็น admin
      if (cmd === 'test') {
        await handleTestCommand(message, args);
        return;
      }

      if (!isAdmin(message.member, message.author.id)) {
        await reply(message, '⛔ คำสั่งนี้ใช้ได้เฉพาะแอดมิน');
        return;
      }
      await handleCommand(message, cmd, args);
    } catch (err) {
      console.error('[melody-boost]', err);
      try {
        await reply(message, `⚠️ ${friendly(err)}`);
      } catch {
        /* ignore */
      }
    }
  });

// ---------- ปุ่มยืนยัน/ยกเลิก ----------
  discordClient.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton() || !/^mb:(ok|no):/.test(interaction.customId)) return;
      const [, action, id] = interaction.customId.split(':');
      const entry = drafts.get(id);
      if (!entry) {
        await interaction.reply({ content: 'รายการนี้หมดอายุหรือถูกใช้ไปแล้ว — สั่งใหม่ด้วยคำสั่ง boost', ephemeral: true });
        return;
      }
      if (interaction.user.id !== entry.userId || !isAdmin(interaction.member, interaction.user.id)) {
        await interaction.reply({ content: 'เฉพาะแอดมินที่สั่งรายการนี้เท่านั้นที่กดได้', ephemeral: true });
        return;
      }
      drafts.delete(id); // ใช้ได้ครั้งเดียว กันกดซ้ำ
      if (action === 'no') {
        await interaction.update({ content: 'ยกเลิกแล้ว ไม่มีการหักเครดิต', embeds: [], components: [] });
        return;
      }
      await interaction.update({ content: '⏳ กำลังสร้างออเดอร์ (อาจใช้เวลานาน) อย่าสั่งซ้ำ', embeds: [], components: [] });
      runOrder(interaction.message, entry.draft); // เบื้องหลัง ไม่ block บอท
    } catch (err) {
      console.error('[melody-boost] interaction error:', err);
    }
  });

// ---------- หน้าร้านค้า: dropdown / modal / ปุ่ม ----------
  discordClient.on('interactionCreate', async (interaction) => {
    const cid = interaction.customId;
    if (typeof cid !== 'string' || !cid.startsWith('mb:')) return;
    const denied = () =>
      interaction.reply({ content: '⛔ ใช้ได้เฉพาะแอดมิน (การสั่งบูสต์ใช้เครดิต API ของร้าน)', ephemeral: true });
    try {
      // เลือกแพ็กจากหน้าร้าน -> เปิด modal กรอกข้อมูล
      if (interaction.isStringSelectMenu() && cid === 'mb:shop:tier') {
        const choice = interaction.values[0];
        if (choice === 'cancel') {
          await interaction.deferUpdate();
          await interaction.editReply(await buildShopPayload()); // รีเซ็ตเมนู + อัปเดตสต็อก
          return;
        }
        if (!TIERS.includes(choice)) return;
        if (!isAdmin(interaction.member, interaction.user.id)) {
          await denied();
          return;
        }
        const modal = new ModalBuilder()
          .setCustomId(`mb:modal:${choice}`)
          .setTitle(`บูสต์เซิร์ฟเวอร์ ${TIER_LABEL[choice]}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('server')
                .setLabel('ลิงก์เซิร์ฟเวอร์')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://discord.gg/xxxxx')
                .setRequired(true)
                .setMaxLength(200),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('จำนวนบูสต์ (เลขคู่ ≥ 2)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('เช่น 2, 4, 14')
                .setRequired(true)
                .setMaxLength(6),
            ),
          );
        await interaction.showModal(modal);
        // รีเซ็ตเมนูหน้าร้านให้กลับเป็นค่าเริ่มต้น (ทำเบื้องหลัง ไม่กระทบ modal)
        buildShopPayload()
          .then((payload) => interaction.message.edit(payload))
          .catch(() => {});
        return;
      }

      // กดส่งฟอร์ม -> เตรียมออเดอร์ แล้วแสดงหน้ายืนยัน
      if (interaction.isModalSubmit() && cid.startsWith('mb:modal:')) {
        if (!isAdmin(interaction.member, interaction.user.id)) {
          await denied();
          return;
        }
        const tier = cid.slice('mb:modal:'.length);
        await interaction.deferReply();
        try {
          const draft = await service.prepare(
            interaction.fields.getTextInputValue('server'),
            tier,
            interaction.fields.getTextInputValue('amount'),
          );
          const id = crypto.randomBytes(6).toString('hex');
          drafts.set(id, { draft, userId: interaction.user.id });
          setTimeout(() => drafts.delete(id), DRAFT_TTL_MS).unref();
          await interaction.editReply(confirmPayload(draft, id));
        } catch (err) {
          console.error('[melody-boost] modal error:', err && err.message);
          await interaction.editReply({ content: `⚠️ ${friendly(err)}`, embeds: [], components: [] });
        }
        return;
      }

      // ปุ่มเติมเครดิต (ใครก็กดดูเลขช่องทางได้)
      if (interaction.isButton() && cid === 'mb:shop:topup') {
        await interaction.reply({ ...payPayload(null), ephemeral: true });
        return;
      }

      // เลือกช่องทางเติมเงิน -> ไฮไลต์ตัวที่เลือก
      if (interaction.isStringSelectMenu() && cid === 'mb:pay:select') {
        const choice = interaction.values[0];
        if (choice === 'cancel' || !PAY_CHANNELS[choice]) {
          await interaction.update({ content: 'ยกเลิกแล้ว', embeds: [], components: [] });
          return;
        }
        await interaction.update(payPayload(choice));
        return;
      }

      // ปุ่มเช็คเครดิต
      if (interaction.isButton() && cid === 'mb:shop:check') {
        if (!isAdmin(interaction.member, interaction.user.id)) {
          await denied();
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const bal = await service.client.balance();
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('💳 เครดิตคงเหลือ')
          .setDescription(block(fmt(toNumber(bal.balance))))
          .setFooter({ text: 'ตามที่ Server แจ้ง' });
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[melody-boost] shop interaction error:', err);
      try {
        const msg = { content: `⚠️ ${friendly(err)}`, ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
        else await interaction.reply(msg);
      } catch {
        /* ignore */
      }
    }
  });

// ---------- กลับมาติดตามออเดอร์ค้างหลังบอทรีสตาร์ท ----------
  let resumed = false;
  const resume = async () => {
    if (resumed) return;
    resumed = true;
    let records;
    try {
      records = service.unresolved();
    } catch (err) {
      console.error('[melody-boost] อ่านไฟล์ประวัติไม่ได้:', err.message);
      return;
    }
    if (!records.length) return;
    const channel = logChannelId ? await discordClient.channels.fetch(logChannelId).catch(() => null) : null;
    for (const r of records) {
      console.log(`[melody-boost] กลับมาติดตามออเดอร์ค้าง ${r.client_reference} (${r.state})`);
      let msg = null;
      if (channel && channel.isTextBased()) {
        msg = await channel.send(statusPayload(r, null, null)).catch(() => null);
      }
      const edit = msg ? makeEdit(msg) : async () => {};
      service
        .track(r.client_reference, makeOnUpdate(edit))
        .then((final) => edit(resultPayload(final)))
        .catch((err) => console.error('[melody-boost] resume error:', err && err.message));
    }
  };
  discordClient.once('ready', resume);
  discordClient.once('clientReady', resume);
  if (typeof discordClient.isReady === 'function' && discordClient.isReady()) resume();
  console.log(`[melody-boost] พร้อมใช้งาน (prefix "${prefix}", ไฟล์ประวัติ: ${cfg.ordersFile})`);
  return service;
}
module.exports = {
  setupMelodyBoost,
};
