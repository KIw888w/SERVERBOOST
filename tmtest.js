// ทดสอบว่าโฮสต์นี้ถูก TrueMoney บล็อกหรือไม่ — ใช้โค้ดซองปลอม ไม่กระทบเงินใคร
// วิธีรัน (บนโฮสต์ ในโฟลเดอร์เดียวกับ truemoney.js):  node tmtest.js
(async () => {
  try {
    const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    console.log(`IP โฮสต์: ${j.ip} | ประเทศ: ${j.country} | ผู้ให้บริการ: ${j.org}`);
  } catch (e) { console.log('เช็ค IP ไม่ได้:', e.message); }

  const { redeemVoucher } = require('./truemoney');
  try {
    await redeemVoucher({ code: 'TESTCODE1234567890ABCDEFGHIJKLMNOP', phone: '0800000000' });
    console.log('ผลแปลก: ซองปลอมรับสำเร็จ?');
  } catch (e) {
    if (e.blocked) console.log(`❌ โดนบล็อก (HTTP ${e.httpStatus}) -> ต้องใช้ TRUEMONEY_PROXY หรือย้ายโฮสต์`);
    else if (e.uncertain) console.log('⚠️ ผลไม่ชัด:', e.message);
    else console.log('✅ ไม่โดนบล็อก (TrueMoney ตอบกลับปกติ):', e.message);
  }
})();
