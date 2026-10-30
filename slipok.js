'use strict';
/**
 * slipok.js — ตรวจสลิปโอนเงินด้วย SlipOK API v1
 * Endpoint: POST https://api.slipok.com/api/line/apicheck/{branch_id}
 * ส่งรูปสลิปเป็น multipart/form-data (field "files")
 * Header: x-authorization: {api_key}
 */


/** ข้อความภาษาไทยที่ลูกค้าอ่านได้ (ไม่เผยชื่อผู้ให้บริการ/โค้ดเทคนิค) */
function friendlySlipError(code, status, rawMsg) {
  const c = Number(code);
  const map = {
    1012: 'สลิปนี้ถูกใช้ไปแล้ว',
    1013: 'ยอดในสลิปไม่ตรงกับยอดที่เลือก',
    1014: 'บัญชีผู้รับในสลิปไม่ใช่บัญชีของร้าน',
    1007: 'ไม่พบ QR ในรูป กรุณาส่งรูปสลิปเต็มใบที่เห็น QR ชัดเจน',
    1008: 'ไม่พบ QR ของสลิปในรูป กรุณาส่งรูปสลิปเต็มใบที่เห็น QR ชัดเจน',
    1009: 'ธนาคารยังไม่ตอบกลับ รอสักครู่แล้วส่งสลิปใหม่อีกครั้ง',
    1010: 'ธนาคารยังไม่ตอบกลับ รอสักครู่แล้วส่งสลิปใหม่อีกครั้ง',
    1011: 'ไม่พบรายการโอนนี้ในระบบ ตรวจสอบว่าโอนสำเร็จแล้ว หรือรอสักครู่แล้วลองใหม่',
  };
  if (map[c]) return map[c];
  if (status === 404 || /not\s*found/i.test(String(rawMsg || ''))) {
    return 'ระบบหาข้อมูลสลิปนี้ไม่เจอ (อาจเป็นสลิปประเภทที่ระบบยังตรวจอัตโนมัติไม่ได้) กรุณาติดต่อแอดมินเพื่อให้เติมเครดิตให้';
  }
  return 'ตรวจสลิปไม่ผ่าน กรุณาตรวจสอบว่าเป็นสลิปที่โอนสำเร็จจริง รูปชัดเจนเห็น QR ครบ แล้วส่งใหม่ หากยังไม่ได้ให้ติดต่อแอดมิน';
}

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
  if (!apiKey || !branchId) {
    const e = new Error('ยังไม่ได้ตั้งค่า SLIPOK_API_KEY / SLIPOK_BRANCH_ID');
    e.userMessage = 'ระบบตรวจสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน';
    throw e;
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) throw new Error('ต้องส่งรูปสลิป (Buffer)');

  const url = `https://api.slipok.com/api/line/apicheck/${encodeURIComponent(branchId)}`;

  // สร้าง multipart/form-data ด้วย native FormData (Node 18+)
  const { Blob } = require('buffer');
  // แปลงเป็น PNG ก่อนส่ง (สลิปจากแอปบางตัว เช่น TrueMoney อาจเป็น webp/jpg/ขนาดใหญ่ ทำให้ SlipOK อ่าน QR ไม่ได้)
  let pngBuffer = imageBuffer;
  try {
    const sharp = require('sharp');
    pngBuffer = await sharp(imageBuffer).rotate().flatten({ background: '#ffffff' }).png().toBuffer();
  } catch (err) {
    console.error('[slipok] แปลงรูปเป็น PNG ไม่สำเร็จ ใช้ไฟล์เดิม:', err.message);
  }
  const blob = new Blob([pngBuffer], { type: 'image/png' });

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
      const e = new Error('หมดเวลาเชื่อมต่อ SlipOK');
      e.userMessage = 'ระบบตรวจสลิปตอบช้า ลองส่งสลิปใหม่อีกครั้ง';
      throw e;
    }
    const e = new Error(`เชื่อมต่อ SlipOK ไม่สำเร็จ (${err.message})`);
    e.userMessage = 'ระบบตรวจสลิปขัดข้องชั่วคราว ลองส่งสลิปใหม่อีกครั้ง หรือติดต่อแอดมิน';
    throw e;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    const e = new Error(`SlipOK ตอบกลับไม่เป็น JSON (HTTP ${res.status})`);
    e.userMessage = 'ระบบตรวจสลิปขัดข้องชั่วคราว ลองส่งสลิปใหม่อีกครั้ง หรือติดต่อแอดมิน';
    throw e;
  }

  if (!res.ok || !body.success) {
    const msg = body.message || body.msg || body.error || `HTTP ${res.status}`;
    console.error('[slipok] ตอบกลับผิดพลาด:', res.status, JSON.stringify(body));
    const e = new Error(`SlipOK: ${msg}${body.code ? ` (code ${body.code})` : ''}`);
    e.userMessage = friendlySlipError(body.code, res.status, msg);
    throw e;
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
