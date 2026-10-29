'use strict';
/**
 * promptpayQr.js — สร้าง QR PromptPay เป็น PNG พร้อมข้อตกแต่ง
 *
 *  ┌──────────────────────────────────────┐
 *  │  โปรดระวัง มิจฉาชีพหลอก  (วนรอบบน)   │
 *  │  ┌────────────────────────────────┐  │
 *  │  │                                │  │
 *  │  │           QR CODE              │  │
 *  │  │         (โลโก้กลาง)             │  │
 *  │  │                                │  │
 *  │  └────────────────────────────────┘  │
 *  │        ⇢ ˗ˏˋ ℂ𝕆𝕄𝔼𝕋 ℕ𝔼𝕎 ࿐ྂ       │
 *  └──────────────────────────────────────┘
 */
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const sharp = require('sharp');

const WARNING_TEXT = '⚠ โปรดระวัง มิจฉาชีพหลอก ⚠';
const FOOTER_TEXT = '⇢ ˗ˏˋ ℂ𝕆𝕄𝔼𝕋 ℕ𝔼𝕎 ࿐ྂ';

/**
 * สร้าง QR Code PromptPay เป็น PNG Buffer
 * @param {string} promptpayNumber — เลขพร้อมเพย์ (เบอร์โทร / เลขบัตรประชาชน)
 * @param {number} amount — จำนวนเงิน (บาท)
 * @param {object} [opts]
 * @param {string} [opts.logoUrl] — URL ของรูปโลโก้ร้านที่จะใส่ตรงกลาง QR (ถ้าไม่มีจะไม่ใส่)
 * @returns {Promise<Buffer>} — PNG buffer
 */
async function promptPayQrPng(promptpayNumber, amount, opts = {}) {
  const logoUrl = 'https://cdn.discordapp.com/attachments/1558800783133249708/1565230779942961234/logo-removebg-preview.png?ex=6ae42642&is=6ae2d4c2&hm=938a4989c89f9005e3ab9d45abcbaf2fb142bb69879a49aa4dafc954b2e062ba&'
  // 1) สร้าง PromptPay Payload
  const payload = generatePayload(promptpayNumber, { amount });

  // 2) สร้าง QR เป็น PNG buffer
  const qrSize = 400;
  const qrPng = await QRCode.toBuffer(payload, {
    type: 'png',
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: 'H', // High เพื่อรองรับโลโก้ตรงกลาง
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  // 3) ใส่โลโก้ตรงกลาง QR (ถ้ามี)
  let qrWithLogo = qrPng;
  if (logoUrl) {
    try {
      const logoRes = await fetch(logoUrl, { signal: AbortSignal.timeout(10_000) });
      if (logoRes.ok) {
        const logoBuf = Buffer.from(await logoRes.arrayBuffer());
        const logoSize = Math.round(qrSize * 0.22); // โลโก้ ~22% ของ QR
        const logoResized = await sharp(logoBuf)
  .resize(logoSize, logoSize, {
    fit: 'contain',
    background: { r: 255, g: 255, b: 255, alpha: 0 }, // โปร่งใส
  })
  .png()
  .toBuffer();

const offset = Math.round((qrSize - logoSize) / 2);

qrWithLogo = await sharp(qrPng)
  .composite([{ input: logoResized, left: offset, top: offset }])
  .png()
  .toBuffer();
        qrWithLogo = await sharp(qrPng)
          .composite([
            { input: whiteBg, left: bgOffset, top: bgOffset },
            { input: logoResized, left: offset, top: offset },
          ])
          .png()
          .toBuffer();
      }
    } catch (err) {
      console.error('[promptpayQr] โหลดโลโก้ไม่สำเร็จ:', err.message, '— สร้าง QR ไม่มีโลโก้');
    }
  }

  // 4) สร้างภาพรวม (QR + ข้อความเตือน + footer) ด้วย SVG overlay
  const canvasWidth = qrSize + 60;  // padding ซ้าย-ขวา
  const topBarHeight = 36;
  const bottomBarHeight = 32;
  const canvasHeight = topBarHeight + qrSize + bottomBarHeight + 20;

  const qrLeft = Math.round((canvasWidth - qrSize) / 2);
  const qrTop = topBarHeight + 6;

  // สร้าง SVG สำหรับข้อความ
  const svgOverlay = Buffer.from(`
    <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- พื้นหลัง -->
      <rect width="${canvasWidth}" height="${canvasHeight}" rx="12" fill="#1a1a2e"/>
      <!-- กรอบ QR -->
      <rect x="${qrLeft - 4}" y="${qrTop - 4}" width="${qrSize + 8}" height="${qrSize + 8}" rx="8" fill="none" stroke="#e94560" stroke-width="2.5"/>
      <!-- ข้อความเตือนด้านบน -->
      <text x="${canvasWidth / 2}" y="${topBarHeight - 8}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="#e94560">
        ${escapeXml(WARNING_TEXT)}
      </text>
      <!-- ข้อความด้านล่าง -->
      <text x="${canvasWidth / 2}" y="${canvasHeight - 8}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#a0a0c0">
        ${escapeXml(FOOTER_TEXT)}
      </text>
    </svg>
  `);

  const finalImage = await sharp(svgOverlay)
    .composite([
      { input: qrWithLogo, left: qrLeft, top: qrTop },
    ])
    .png()
    .toBuffer();

  return finalImage;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { promptPayQrPng };
