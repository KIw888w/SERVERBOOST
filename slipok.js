'use strict';
/**
 * slipok.js — ตรวจสลิปโอนเงินด้วย SlipOK API v1
 * Endpoint: POST https://api.slipok.com/api/line/apicheck/{branch_id}
 * ส่งรูปสลิปเป็น multipart/form-data (field "files")
 * Header: x-authorization: {api_key}
 */

/**
 * ตรวจสลิปโอนเงิน
 * @param {object} opts
 * @param {string} opts.apiKey — SlipOK API Key
 * @param {string} opts.branchId — SlipOK Branch ID
 * @param {Buffer} opts.imageBuffer — รูปสลิป (PNG/JPG)
 * @param {number} opts.amount — ยอดที่ต้องตรงกัน (บาท)
 * @returns {Promise<{ amount: number, transRef: string }>}
 */
async function verifySlip({ apiKey, branchId, imageBuffer, amount }) {
  if (!apiKey || !branchId) throw new Error('ยังไม่ได้ตั้งค่า SLIPOK_API_KEY / SLIPOK_BRANCH_ID');
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) throw new Error('ต้องส่งรูปสลิป (Buffer)');

  const url = `https://api.slipok.com/api/line/apicheck/${encodeURIComponent(branchId)}`;

  // สร้าง multipart/form-data ด้วย native FormData (Node 18+)
  const { Blob } = require('buffer');
  const blob = new Blob([imageBuffer], { type: 'image/png' });

  const form = new FormData();
  form.append('files', blob, 'slip.png');
  if (amount != null) form.append('amount', String(amount));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'x-authorization': apiKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('หมดเวลาเชื่อมต่อ SlipOK');
    }
    throw new Error(`เชื่อมต่อ SlipOK ไม่สำเร็จ (${err.message})`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`SlipOK ตอบกลับไม่เป็น JSON (HTTP ${res.status})`);
  }

  if (!res.ok || !body.success) {
    const msg = body.message || body.msg || body.error || `HTTP ${res.status}`;
    throw new Error(`SlipOK: ${msg}`);
  }

  const data = body.data || body;
  const transRef = data.transRef || data.transactionId || null;
  const verifiedAmount =
    typeof data.amount === 'number'
      ? data.amount
      : typeof data.amount === 'string'
        ? parseFloat(data.amount)
        : null;

  // ตรวจยอดเงิน
  if (amount != null && verifiedAmount != null && Math.abs(verifiedAmount - amount) > 0.01) {
    throw new Error(`ยอดในสลิป (${verifiedAmount} บาท) ไม่ตรงกับยอดที่เลือก (${amount} บาท)`);
  }

  return { amount: verifiedAmount ?? amount, transRef };
}

module.exports = { verifySlip };
