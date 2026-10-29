'use strict';
/**
 * truemoney.js — รับซองของขวัญ (อังเปา) TrueMoney Wallet
 * ใช้ API https://gift.truemoney.com/campaign/vouchers/{code}/redeem
 * ส่ง JSON body: { mobile: "0xxxxxxxxx", voucher_hash: "{code}" }
 */

const GIFT_URL_RE = /gift\.truemoney\.com\/campaign\/?\?v=([A-Za-z0-9]+)/i;
const VOUCHER_CODE_RE = /^[A-Za-z0-9]{10,60}$/;
const REDEEM_TIMEOUT_MS = 30_000;

/**
 * ดึงโค้ดซองจากลิงก์
 * @param {string} input — ลิงก์หรือโค้ดซอง
 * @returns {string|null}
 */
function extractVoucherCode(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // ลองจับจาก URL
  const m = trimmed.match(GIFT_URL_RE);
  if (m) return m[1];

  // ลองใช้เป็นโค้ดตรง ๆ
  if (VOUCHER_CODE_RE.test(trimmed)) return trimmed;

  return null;
}

/**
 * รับซองของขวัญ TrueMoney
 * @param {object} opts
 * @param {string} opts.code — โค้ดซอง
 * @param {string} opts.phone — เบอร์โทรร้านที่จะรับเงิน
 * @returns {Promise<{ amount: number, ownerName: string }>}
 * @throws {Error} — .uncertain = true ถ้าไม่แน่ใจว่าเงินเข้าหรือยัง
 */
async function redeemVoucher({ code, phone }) {
  if (!code) throw new Error('ไม่มีโค้ดซอง');
  if (!phone) throw new Error('ยังไม่ได้ตั้งค่าเบอร์ TrueMoney ร้าน (BOOST_TRUEMONEY_NUMBER)');

  const url = `https://gift.truemoney.com/campaign/vouchers/${encodeURIComponent(code)}/redeem`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ mobile: phone, voucher_hash: code }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch (err) {
    const uncertain = new Error(`เชื่อมต่อ TrueMoney ไม่สำเร็จ (${err.message})`);
    uncertain.uncertain = true;
    throw uncertain;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    const uncertain = new Error(`TrueMoney ตอบกลับไม่เป็น JSON (HTTP ${res.status})`);
    uncertain.uncertain = true;
    throw uncertain;
  }

  // สำเร็จ
  if (res.ok && body.status && body.status.code === 'SUCCESS') {
    const data = body.data || {};
    const voucher = data.voucher || data;
    const amount =
      typeof voucher.amount_baht === 'string'
        ? parseFloat(voucher.amount_baht)
        : typeof voucher.amount_baht === 'number'
          ? voucher.amount_baht
          : typeof voucher.redeemed_amount_baht === 'string'
            ? parseFloat(voucher.redeemed_amount_baht)
            : null;
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      const uncertain = new Error('รับซองสำเร็จแต่ไม่ทราบจำนวนเงิน — ติดต่อแอดมิน');
      uncertain.uncertain = true;
      throw uncertain;
    }
    const ownerName = voucher.owner_name || voucher.full_name || 'ไม่ทราบ';
    return { amount, ownerName };
  }

  // ล้มเหลว — ดู status code จาก API
  const statusCode = body.status ? body.status.code : null;
  const statusMsg = body.status ? body.status.message : null;

  // กรณีที่แน่ใจว่าไม่ถูกตัดเงิน
  const knownFail = [
    'VOUCHER_OUT_OF_STOCK',
    'VOUCHER_EXPIRED',
    'VOUCHER_ALREADY_REDEEMED',
    'VOUCHER_NOT_FOUND',
    'INVALID_INPUT',
    'TARGET_USER_NOT_FOUND',
    'CANNOT_GET_OWN_VOUCHER',
  ];
  if (knownFail.includes(statusCode)) {
    const msgs = {
      VOUCHER_OUT_OF_STOCK: 'ซองนี้ถูกรับไปหมดแล้ว',
      VOUCHER_EXPIRED: 'ซองนี้หมดอายุแล้ว',
      VOUCHER_ALREADY_REDEEMED: 'ซองนี้ถูกรับไปแล้ว',
      VOUCHER_NOT_FOUND: 'ไม่พบซองนี้ — ตรวจสอบลิงก์อีกครั้ง',
      INVALID_INPUT: 'ข้อมูลไม่ถูกต้อง',
      TARGET_USER_NOT_FOUND: 'ไม่พบหมายเลข TrueMoney ของร้าน',
      CANNOT_GET_OWN_VOUCHER: 'ไม่สามารถรับซองของตัวเองได้',
    };
    throw new Error(msgs[statusCode] || statusMsg || statusCode);
  }

  // กรณีอื่น — ไม่แน่ใจ
  const uncertain = new Error(statusMsg || `TrueMoney ตอบ HTTP ${res.status}: ${statusCode || 'unknown'}`);
  uncertain.uncertain = true;
  throw uncertain;
}

module.exports = { redeemVoucher, extractVoucherCode };
