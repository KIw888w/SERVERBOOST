'use strict';
/**
 * customerShop.js — หน้าร้านสำหรับ "ลูกค้า" สั่งบูสต์เองแบบออโต้ (ไม่ต้องพิมพ์คำสั่ง ไม่ต้องรอแอดมิน)
 *
 * ภาพรวม:
 *  1) ลูกค้ากด "เติมเครดิต" -> กรอกยอดโอนในฟอร์ม -> โอนเงินจริง -> แนบรูปสลิปในแชท
 *     บอทส่งสลิปไปตรวจกับ SlipOK (ยอด + ผู้รับ + กันสลิปซ้ำ) ผ่านแล้วเติมเครดิตเข้ากระเป๋าลูกค้าทันที
 *  2) ลูกค้าเลือกแพ็กจาก dropdown -> กรอกลิงก์เซิร์ฟเวอร์ + จำนวนในฟอร์ม (modal) กดส่ง
 *     ระบบคำนวณราคา เช็คเครดิต หักเครดิตทันที แล้วยิงคำสั่งบูสต์ไปที่ Melody โดยอัตโนมัติ ไม่มีปุ่มยืนยันซ้ำ
 *  3) ถ้าออเดอร์ถูกปฏิเสธตั้งแต่ต้น (ไม่เกิดออเดอร์จริง) คืนเครดิตเต็มจำนวนอัตโนมัติ
 *     ถ้าบูสต์ไม่ครบ/ผู้ให้บริการคืนเครดิตร้านบางส่วน จะคืนเครดิตลูกค้าตามสัดส่วนเดียวกัน
 *     ถ้ายังไม่ทราบผลแน่ชัด (timeout/เชื่อมต่อไม่ได้) จะ "ไม่คืนเครดิตเอง" และบอกให้ติดต่อแอดมินพร้อม client_reference
 *
 * ต้องเรียกคู่กับ melodyBoost.js: เอา `service` ที่ setupMelodyBoost() คืนมา ส่งเป็น melodyService ที่นี่
 *
 * ENV ที่ต้องตั้งเพิ่ม:
 *   SLIPOK_API_KEY, SLIPOK_BRANCH_ID   — จาก SlipOK (ต้องตั้งค่าบัญชีผู้รับใน LINE LIFF dashboard ด้วย)
 *   CUSTOMER_PRICE_1M, CUSTOMER_PRICE_3M — ราคาขายต่อลูกบูสต์ (บาท) ดีฟอลต์ 9 / 24
 *   CUSTOMER_WALLET_FILE               — ไฟล์เก็บเครดิตลูกค้า ดีฟอลต์ customer_wallet.json
 *   BOOST_PROMPTPAY_NUMBER             — เลขพร้อมเพย์ที่ใช้แสดงให้ลูกค้าโอน (ใช้ตัวเดียวกับ melodyBoost.js ได้)
 *   BOOST_TRUEMONEY_NUMBER             — เบอร์ TrueMoney ของร้าน ใช้รับ "ซองของขวัญ (อังเปา)" ของลูกค้า
 *   BOOST_SHOP_BANNER_URL / BOOST_SHOP_THUMB_URL / BOOST_SHOP_FOOTER_ICON / BOOST_RAINBOW_BAR_URL — รูปตกแต่ง embed (ไม่บังคับ)
 *
 * โพสต์หน้าร้านด้วย !boostshop หรือ !customershop (เฉพาะแอดมิน)
 *
 * เติมเครดิต 2 ช่องทาง:
 *   💳 พร้อมเพย์ — เลือกยอด → โอน → แนบสลิป → ตรวจด้วย SlipOK → เติมอัตโนมัติ
 *   🧧 TrueMoney — กดปุ่ม → วางลิงก์ซองของขวัญ → บอทรับซองเข้าเบอร์ร้าน → เติมอัตโนมัติ
 */
const path = require('path');
const { WalletStore } = require('./wallet');
const { verifySlip } = require('./slipok');
const { promptPayQrPng } = require('./promptpayQr');
const { redeemVoucher, extractVoucherCode } = require('./truemoney');

const CUSTOMER_TIERS = ['1m', '3m'];
const TIER_LABEL = { '1m': '1 เดือน', '3m': '3 เดือน' };
const MAX_NICK_LENGTH = 32;
const NO_REFUND_FAILURE_REASONS = new Set(['join_failed', 'guild_not_found', 'kicked_after_join']);
const TOPUP_WAIT_MS = 3 * 60_000;
const TOPUP_PRESETS = [50, 100, 200, 300, 500, 1000];
const SHOP_FOOTER = '⇢ ˗ˏˋ ℂ𝕆𝕄𝔼𝕋 ℕ𝔼𝕎 ࿐ྂ';
/** Custom emoji สำหรับ embed/ปุ่ม — อย่าใส่ใน modal title (ลิมิต Discord 45 ตัวอักษร) */
const EMOJI = {
  BOOST_AUTO: '<:1432612004434284626:1564569526492991569>',
  SPARKLE: '<a:1394253573344329778:1564675042829271060>',
  WARN: '<a:Warnflash:1561005772597493930>',
  PROMPTPAY: '<:1285430053815189596:1564674903922311218>',
  TRUEMONEY: '<:1395398692537761924:1564674762335195178>',
  PRICE: '<a:1393835504855679127:1565030940718145666>',
  MEALS: '<a:Meals:1557406252789792878>',
  TOPUP: '<a:1394253628729987074:1565030898917707967>',
  WALLET: '<:1398290306914320555:1564569543186186281>',
  PAY: '<a:1427603143377551381:1561657371288150086>',
  LOADING: '<a:Loading:1561005733577752586>',
  SUCCESS: '<a:99_1right_melody:1486114861787254874>',
};

// ---------- helpers ----------
function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}
const looksLikeInvite = (s) => /(discord\.gg\/|discord(app)?\.com\/invite\/)/i.test(s);

function validateOrderInput(server, tier, amount, nick = '') {
  const srv = typeof server === 'string' ? server.trim() : '';
  if (!srv) throw new Error('ต้องใส่ลิงก์เชิญเซิร์ฟเวอร์ Discord');
  if (/\s/.test(srv)) throw new Error('ลิงก์เชิญต้องไม่มีช่องว่าง');
  if (!looksLikeInvite(srv)) throw new Error('ลิงก์ที่ใส่ไม่เหมือนลิงก์เชิญ Discord เช่น https://discord.gg/xxxx');
  const t = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  if (!CUSTOMER_TIERS.includes(t)) throw new Error('แพ็กต้องเป็น 1m หรือ 3m เท่านั้น');
  let n = amount;
  if (typeof n === 'string') {
    if (!/^\d+$/.test(n.trim())) throw new Error('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
    n = parseInt(n.trim(), 10);
  }
  if (!Number.isInteger(n)) throw new Error('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
  if (n < 2) throw new Error('จำนวนบูสต์ต้องไม่น้อยกว่า 2');
  if (n % 2 !== 0) throw new Error('จำนวนบูสต์ต้องเป็นเลขคู่');
  const nk = typeof nick === 'string' ? nick.trim() : '';
  if (nk.length > MAX_NICK_LENGTH) throw new Error(`nick ยาวได้ไม่เกิน ${MAX_NICK_LENGTH} ตัวอักษร`);
  return { server: srv, tier: t, amount: n, nick: nk };
}

/**
 * @param discordClient discord.js Client (ต้องมี intents: Guilds, GuildMessages, MessageContent)
 * @param melodyService service ที่ได้จาก setupMelodyBoost() ใน melodyBoost.js
 * @param options { price1m?, price3m?, slipokApiKey?, slipokBranchId?, promptpayNumber?, truemoneyNumber?, shopBannerUrl?, shopThumbUrl?, shopFooterIconUrl?, rainbowBarUrl?, adminIds?, adminRoleIds? }
 */
function setupCustomerShop(discordClient, melodyService, options = {}) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    PermissionFlagsBits,
    AttachmentBuilder,
  } = require('discord.js');

  if (!melodyService) {
    console.error('[customer-shop] ปิดใช้งาน: ไม่ได้ส่ง melodyService (ผลลัพธ์จาก setupMelodyBoost) มาให้');
    return null;
  }

  const price1m = toNumber(options.price1m ?? process.env.CUSTOMER_PRICE_1M) ?? 9;
  const price3m = toNumber(options.price3m ?? process.env.CUSTOMER_PRICE_3M) ?? 24;
  const CUSTOMER_PRICE = { '1m': price1m, '3m': price3m };

  const slipokApiKey = (options.slipokApiKey || process.env.SLIPOK_API_KEY || '').trim();
  const slipokBranchId = (options.slipokBranchId || process.env.SLIPOK_BRANCH_ID || '').trim();
  if (!slipokApiKey || !slipokBranchId) {
    console.error('[customer-shop] คำเตือน: ไม่พบ SLIPOK_API_KEY/SLIPOK_BRANCH_ID — ปุ่มเติมเครดิตจะใช้งานไม่ได้จนกว่าจะตั้งค่า');
  }
  const promptpayNumber = (options.promptpayNumber || process.env.BOOST_PROMPTPAY_NUMBER || '').trim();
  const truemoneyNumber = (options.truemoneyNumber || process.env.BOOST_TRUEMONEY_NUMBER || '').trim();
  const cleanUrl = (name, value) => {
    const v = String(value || '').trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') return v;
    } catch {
      /* ไม่ใช่ URL */
    }
    console.warn(`[customer-shop] ข้าม ${name}: ไม่ใช่ลิงก์ http(s) ที่ถูกต้อง`);
    return null;
  };
  const shopBannerUrl = cleanUrl('BOOST_SHOP_BANNER_URL', options.shopBannerUrl || process.env.BOOST_SHOP_BANNER_URL);
  const shopThumbUrl = cleanUrl('BOOST_SHOP_THUMB_URL', options.shopThumbUrl || process.env.BOOST_SHOP_THUMB_URL);
  const shopFooterIconUrl = cleanUrl('BOOST_SHOP_FOOTER_ICON', options.shopFooterIconUrl || process.env.BOOST_SHOP_FOOTER_ICON);
  const rainbowBarUrl = cleanUrl('BOOST_RAINBOW_BAR_URL', options.rainbowBarUrl || process.env.BOOST_RAINBOW_BAR_URL);

  const adminIds = new Set(
    (options.adminIds || String(process.env.BOOST_ADMIN_IDS || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  const adminRoleIds = new Set(
    (options.adminRoleIds || String(process.env.BOOST_ADMIN_ROLE_IDS || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  const isAdmin = (member, userId) => {
    if (adminIds.has(userId)) return true;
    if (member && member.roles && adminRoleIds.size > 0) {
      if (member.roles.cache) return member.roles.cache.some((_, id) => adminRoleIds.has(id));
      if (Array.isArray(member.roles)) return member.roles.some((id) => adminRoleIds.has(id));
    }
    if (adminIds.size === 0 && adminRoleIds.size === 0) {
      return Boolean(member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator));
    }
    return false;
  };

  const walletFile = path.resolve((process.env.CUSTOMER_WALLET_FILE || '').trim() || 'customer_wallet.json');
  const wallet = new WalletStore(walletFile);
  // mutex ง่าย ๆ กันเขียนไฟล์ชนกันตอนมีหลายคำสั่งเข้ามาพร้อมกัน
  let walletChain = Promise.resolve();
  const withWalletLock = (fn) => {
    const run = walletChain.then(fn);
    walletChain = run.catch(() => {});
    return run;
  };

  const logChannelId = (options.logChannelId || process.env.BOOST_LOG_CHANNEL_ID || '').trim() || null;
  // ห้องที่ให้ส่งสลิป (ตั้งใน .env: BOOST_SLIP_CHANNEL_ID) ไม่ตั้งจะใช้ห้องเดิมที่ระบุในข้อความ
  const slipChannelId = (options.slipChannelId || process.env.BOOST_SLIP_CHANNEL_ID || '').trim() || '1555927974455418900';

  const fmtBaht = (v) => `${Number(v).toLocaleString('th-TH')} บาท`;
  const pendingTopups = new Map(); // userId -> { amount, expiresAt }

  // ---------- หน้าร้าน (Embed ใหญ่ + dropdown + ปุ่มยาว กดง่าย) ----------
  const block = (text) => `\`\`\`${text}\`\`\``;
  const withUnit = (v, unit) => (v === null || v === undefined ? 'ไม่ทราบ' : `${Number(v).toLocaleString('th-TH')} ${unit}`);

  async function fetchStock() {
    try {
      const stock = await melodyService.client.stock();
      return stock && typeof stock === 'object' ? stock : {};
    } catch (err) {
      console.error('[customer-shop] ดึงสต็อกไม่ได้:', err && err.message);
      return {};
    }
  }

  async function buildShopPayload() {
    const stock = await fetchStock();
    const info = {};
    for (const t of CUSTOMER_TIERS) {
      info[t] = {
        left: toInt(stock[`boosts_${t}_available`]),
        total: toInt(stock[`boosts_${t}_total`]),
      };
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setDescription(
        [
          `# ${EMOJI.BOOST_AUTO}  BOOST - AUTO`,
          `### ${EMOJI.SPARKLE}  Boost Discord Server Auto ${EMOJI.SPARKLE}`,
          '',
          `## ${EMOJI.WARN}  อ่านก่อนสั่งซื้อ  ${EMOJI.WARN}`,
          'อ่านรายละเอียดให้ครบก่อนสั่งซื้อ หากไม่เข้าใจหรือไม่แน่ใจ ให้สอบถามแอดมินก่อนสั่งซื้อ ',
          '<#1565033235757404381>',
          '',
          `${EMOJI.PROMPTPAY}  **พร้อมเพย์**   | ${EMOJI.TRUEMONEY}  **TrueMoney**`,
          '',
          `${EMOJI.PRICE}   **บูสต์ ${TIER_LABEL['1m']}** — ${fmtBaht(CUSTOMER_PRICE['1m'])} / บูสต์`,
          `${EMOJI.PRICE}   **บูสต์ ${TIER_LABEL['3m']}** — ${fmtBaht(CUSTOMER_PRICE['3m'])} / บูสต์`,
        ].join('\n'),
      );
    for (const t of CUSTOMER_TIERS) {
      embed.addFields(
        { name: `${EMOJI.MEALS} บูสต์ ${TIER_LABEL[t]}`, value: block(`${fmtBaht(CUSTOMER_PRICE[t])} / บูสต์`), inline: true },
        { name: '⌛ เหลือจำนวน', value: block(withUnit(info[t].left, 'บูสต์')), inline: true },
        { name: '📦 บูสต์แล้วทั้งหมด', value: block(withUnit(info[t].total, 'บูสต์')), inline: true },
      );
    }
    if (shopBannerUrl) embed.setImage(shopBannerUrl);
    if (shopThumbUrl) embed.setThumbnail(shopThumbUrl);
    const footer = { text: SHOP_FOOTER };
    if (shopFooterIconUrl) footer.iconURL = shopFooterIconUrl;
    embed.setFooter(footer);

    const select = new StringSelectMenuBuilder()
      .setCustomId('cs:tier')
      .setPlaceholder('📦 เลือกแพ็กบูสต์')
      .addOptions(
        CUSTOMER_TIERS.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`บูสต์เซิร์ฟเวอร์ ${TIER_LABEL[t]}`)
            .setDescription(`ราคา ${fmtBaht(CUSTOMER_PRICE[t])} / บูสต์ | คงเหลือ ${info[t].left ?? 'ไม่ทราบ'}`)
            .setValue(t)
            .setEmoji(EMOJI.MEALS),
        ),
      );
    // ปุ่มเติมเงิน + เช็คยอด อยู่แถวเดียวกัน
    const rowActions = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('cs:topup')
        .setLabel('เติมเงิน')
        .setStyle(ButtonStyle.Success)
        .setEmoji(EMOJI.TOPUP),
      new ButtonBuilder()
        .setCustomId('cs:balance')
        .setLabel('เช็คยอดเงิน')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(EMOJI.WALLET),
    );
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), rowActions] };
  }
  async function postShop(channel) {
    return channel.send(await buildShopPayload());
  }

  // ---------- โพสต์หน้าร้าน (เฉพาะแอดมิน) ----------
  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const text = message.content.trim().toLowerCase();
    if (text !== '!customershop' && text !== '!boostshop') return;
    if (!isAdmin(message.member, message.author.id)) return;
    await postShop(message.channel).catch((e) => console.error('[customer-shop] postShop error:', e && e.message));
    message.delete().catch(() => {}); // ลบข้อความคำสั่ง (ต้องมีสิทธิ์ Manage Messages ถ้าไม่มีจะข้าม)
  });

  // ---------- เติมเครดิต: เลือกช่องทาง ----------
  const slipReady = Boolean(slipokApiKey && slipokBranchId);
  const truemoneyReady = Boolean(truemoneyNumber);

  function payMenuPayload() {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(
        [
          `# ${EMOJI.PAY}  เลือกช่องทางเติมเงิน`,
          `## ${EMOJI.PROMPTPAY} พร้อมเพย์`,
          `## ${EMOJI.TRUEMONEY} TrueMoney Wallet`,
        ].join('\n'),
      );
    if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cs:pay:promptpay')
          .setLabel('พร้อมเพย์')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💳'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cs:pay:truemoney')
          .setLabel('TrueMoney  (ส่งซองของขวัญ)')
          .setStyle(ButtonStyle.Success)
          .setEmoji(EMOJI.TRUEMONEY),
      ),
    ];
    return { content: '', embeds: [embed], components: rows };
  }

  // ---------- เติมเครดิต: พร้อมเพย์ (SlipOK) ----------
  function amountPickerPayload() {
    const embed = new EmbedBuilder()
      .setColor(0x1e88e5)
      .setDescription(
        [
          `# ${EMOJI.PROMPTPAY} เติมเครดิตด้วยพร้อมเพย์`,
          '## เลือกยอดที่ต้องการเติม',
          'กดปุ่มจำนวนเงินด้านล่าง หรือกด **✏️ ระบุจำนวนเอง**',
          '*ระบบตรวจสลิปอัตโนมัติด้วย SlipOK*',
        ].join('\n'),
      );
    const presetButtons = TOPUP_PRESETS.map((n) =>
      new ButtonBuilder().setCustomId(`cs:amt:${n}`).setLabel(`${n.toLocaleString('th-TH')} บาท`).setStyle(ButtonStyle.Primary).setEmoji('💵'),
    );
    const rows = [
      new ActionRowBuilder().addComponents(presetButtons.slice(0, 3)),
      new ActionRowBuilder().addComponents(presetButtons.slice(3, 6)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cs:amt:custom').setLabel('ระบุจำนวนเอง').setStyle(ButtonStyle.Success).setEmoji('✏️'),
        new ButtonBuilder().setCustomId('cs:pay:menu').setLabel('ย้อนกลับ').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
      ),
    ];
    return { content: '', embeds: [embed], components: rows };
  }

  function topupAmountModal() {
    return new ModalBuilder()
      .setCustomId('cs:topupmodal')
      .setTitle('💳 เติมเครดิต — ระบุจำนวนเงิน')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('จำนวนเงินที่จะโอน (บาท)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('เช่น 100')
            .setRequired(true)
            .setMaxLength(10),
        ),
      );
  }

  function startTopup(userId, amount) {
    pendingTopups.set(userId, { amount, expiresAt: Date.now() + TOPUP_WAIT_MS });
    setTimeout(() => {
      const p = pendingTopups.get(userId);
      if (p && p.expiresAt <= Date.now()) pendingTopups.delete(userId);
    }, TOPUP_WAIT_MS + 2000).unref();
  }

  async function transferPayload(amount) {
    // สร้าง QR พร้อมเพย์ล็อกยอด (ถ้าสร้างไม่ได้ จะถอยกลับไปแสดงเลขพร้อมเพย์เฉย ๆ)
    let files = [];
    let qrOk = false;
    if (promptpayNumber) {
      try {
        const png = await promptPayQrPng(promptpayNumber, amount);
        files = [new AttachmentBuilder(png, { name: 'promptpay-qr.png' })];
        qrOk = true;
      } catch (err) {
        console.error('[customer-shop] สร้าง QR พร้อมเพย์ไม่สำเร็จ:', err.message);
      }
    }
    const embed = new EmbedBuilder()
      .setColor(0x1e88e5)
      .setDescription(
        [
          '# 💳 โอนเงินผ่านพร้อมเพย์',
          qrOk ? '## 1️⃣ สแกน QR ด้านล่าง (ยอดถูกล็อกให้แล้ว)' : '## 1️⃣ โอนเงินให้ตรงยอดเป๊ะ',
          `## 2️⃣ แนบรูปสลิปส่งในห้องนี้ <#${slipChannelId}> ภายใน 3 นาที`,
          '## 3️⃣ ระบบตรวจสลิปด้วย SlipOK แล้วเติมเครดิตให้เอง',
        ].join('\n'),
      )
      .addFields(
        { name: '💵 ยอดที่ต้องโอน', value: block(fmtBaht(amount)), inline: true },
        { name: '🏦 พร้อมเพย์', value: block(promptpayNumber || 'ยังไม่ได้ตั้งค่า — ติดต่อแอดมิน'), inline: true },
      )
      .setFooter({ text: 'ยอดในสลิปต้องตรงกับที่เลือกไว้พอดี | สลิปใช้ซ้ำไม่ได้' });
    if (qrOk) embed.setImage('attachment://promptpay-qr.png');
    else if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    return { content: '', embeds: [embed], components: [], files };
  }

  // ---------- เติมเครดิต: TrueMoney ซองของขวัญ ----------
  const redeemingNow = new Set(); // กันกดส่งโค้ดเดิมซ้ำพร้อมกัน
  function truemoneyModal() {
    return new ModalBuilder()
      .setCustomId('cs:tmmodal')
      .setTitle('🧧 เติมเครดิตด้วยซองทรูมันนี่')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link')
            .setLabel('วางลิงก์ซองของขวัญ (อังเปา) ที่นี่')
            .setStyle(TextInputStyle.Paragraph) // กล่องสูง วางลิงก์ยาวได้สบาย
            .setPlaceholder('https://gift.truemoney.com/campaign/?v=xxxxxxxxxxxxxxxx')
            .setRequired(true)
            .setMinLength(10)
            .setMaxLength(300),
        ),
      );
  }

  async function handleTruemoneySubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    const code = extractVoucherCode(interaction.fields.getTextInputValue('link'));
    if (!code) {
      await interaction.editReply('⚠️ ลิงก์ไม่ถูกต้อง ต้องเป็นลิงก์ซองของขวัญ เช่น `https://gift.truemoney.com/campaign/?v=xxxx`');
      return;
    }
    if (redeemingNow.has(code)) {
      await interaction.editReply('⏳ ซองนี้กำลังถูกตรวจสอบอยู่ รอสักครู่ อย่ากดซ้ำ');
      return;
    }
    redeemingNow.add(code);
    try {
      let voucher;
      try {
        voucher = await redeemVoucher({ code, phone: truemoneyNumber });
      } catch (err) {
        if (err.uncertain) {
          // ไม่รู้ว่าเงินเข้าหรือยัง — ห้ามบอกว่าซองใช้ไม่ได้ และห้ามเติมเอง
          console.error(`[customer-shop] truemoney ผลไม่แน่ชัด user=${userId} code=${code}:`, err.message);
          await interaction.editReply(
            `🕒 ยังไม่ทราบผลการรับซอง (${err.message})\nถ้าเงินถูกตัดจากซองแล้วแต่เครดิตไม่เข้า ติดต่อแอดมินพร้อมลิงก์ซองนี้`,
          );
        } else {
          await interaction.editReply(`⚠️ ${err.message}`);
        }
        return;
      }

      let newBalance;
      try {
        newBalance = await withWalletLock(() =>
          wallet.credit(userId, voucher.amount, { transRef: `truemoney:${code}`, source: 'truemoney', from: voucher.ownerName }),
        );
      } catch (err) {
        // รับซองเข้าเบอร์ร้านแล้วแต่เติมเครดิตไม่สำเร็จ — ต้องให้แอดมินเติมมือ
        console.error(`[customer-shop] ⚠️ รับซองแล้วแต่เติมเครดิตพลาด user=${userId} amount=${voucher.amount} code=${code}:`, err.message);
        await interaction.editReply(
          `⚠️ รับซองสำเร็จ ${fmtBaht(voucher.amount)} แต่เติมเครดิตไม่สำเร็จ (${err.message}) — ติดต่อแอดมินพร้อมลิงก์ซองนี้`,
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(['# ✅ เติมเครดิตสำเร็จ', `## +${fmtBaht(voucher.amount)}`, `เครดิตคงเหลือ: **${fmtBaht(newBalance)}**`].join('\n'));
      await interaction.editReply({ content: '', embeds: [embed] });
    } finally {
      redeemingNow.delete(code);
    }
  }

  // ---------- ปุ่ม/ฟอร์มเติมเครดิต + เช็คยอด ----------
  discordClient.on('interactionCreate', async (interaction) => {
    const cid = interaction.customId;
    if (typeof cid !== 'string' || !cid.startsWith('cs:')) return;
    try {
      // กด "เติมเครดิต" -> เลือกช่องทาง
      if (interaction.isButton() && cid === 'cs:topup') {
        await interaction.reply({ ...payMenuPayload(), ephemeral: true });
        return;
      }
      if (interaction.isButton() && cid === 'cs:pay:menu') {
        await interaction.update(payMenuPayload());
        return;
      }

      // เลือกพร้อมเพย์ -> เลือกยอด (ใช้ระบบตรวจสลิป SlipOK)
      if (interaction.isButton() && cid === 'cs:pay:promptpay') {
        if (!slipReady) {
          await interaction.reply({ content: '⛔ ระบบเติมเครดิตด้วยพร้อมเพย์ยังไม่ได้ตั้งค่า (SLIPOK_API_KEY/SLIPOK_BRANCH_ID) ติดต่อแอดมิน', ephemeral: true });
          return;
        }
        await interaction.showModal(topupAmountModal());
        return;
      }

      // เลือก TrueMoney -> เปิดฟอร์มวางลิงก์ซอง
      if (interaction.isButton() && cid === 'cs:pay:truemoney') {
        if (!truemoneyReady) {
          await interaction.reply({ content: '⛔ ระบบเติมเครดิตด้วย TrueMoney ยังไม่ได้ตั้งค่า (BOOST_TRUEMONEY_NUMBER) ติดต่อแอดมิน', ephemeral: true });
          return;
        }
        await interaction.showModal(truemoneyModal());
        return;
      }
      if (interaction.isModalSubmit() && cid === 'cs:tmmodal') {
        await handleTruemoneySubmit(interaction);
        return;
      }

      // เลือกยอดสำเร็จรูป
      if (interaction.isButton() && /^cs:amt:\d+$/.test(cid)) {
        const amount = Number(cid.slice('cs:amt:'.length));
        if (!TOPUP_PRESETS.includes(amount)) return;
        startTopup(interaction.user.id, amount);
        await interaction.update(await transferPayload(amount));
        return;
      }
      // ระบุยอดเอง
      if (interaction.isButton() && cid === 'cs:amt:custom') {
        await interaction.showModal(topupAmountModal());
        return;
      }
      if (interaction.isModalSubmit() && cid === 'cs:topupmodal') {
        const raw = toNumber(interaction.fields.getTextInputValue('amount').replace(/,/g, ''));
        const amount = raw === null ? null : Math.round(raw * 100) / 100;
        if (amount === null || amount <= 0) {
          await interaction.reply({ content: '⚠️ จำนวนเงินไม่ถูกต้อง', ephemeral: true });
          return;
        }
        startTopup(interaction.user.id, amount);
        await interaction.reply({ ...(await transferPayload(amount)), ephemeral: true });
        return;
      }

      if (interaction.isButton() && cid === 'cs:balance') {
        const bal = await withWalletLock(() => wallet.balance(interaction.user.id));
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription([`# ${EMOJI.TOPUP}  เครดิตคงเหลือของคุณ`, `## ${fmtBaht(bal)}`].join('\n'));
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      // เลือกแพ็ก -> กรอกฟอร์มสั่งซื้อ
      if (interaction.isStringSelectMenu() && cid === 'cs:tier') {
        const tier = interaction.values[0];
        if (!CUSTOMER_TIERS.includes(tier)) return;
        const modal = new ModalBuilder()
          .setCustomId(`cs:ordermodal:${tier}`)
          .setTitle(`📦 สั่งบูสต์ ${TIER_LABEL[tier]}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('server')
                .setLabel('ลิงก์เชิญเซิร์ฟเวอร์ (วางลิงก์ที่นี่)')
                .setStyle(TextInputStyle.Paragraph) // กล่องสูง วางลิงก์สบาย
                .setPlaceholder('https://discord.gg/xxxxx')
                .setRequired(true)
                .setMaxLength(200),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('จำนวนบูสต์ (เลขคู่ ตั้งแต่ 2 ขึ้นไป)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('เช่น 2, 4, 14')
                .setRequired(true)
                .setMaxLength(6),
            ),
          );
        await interaction.showModal(modal);
        // รีเซ็ตเมนูหน้าร้านให้กลับเป็นค่าเริ่มต้น + อัปเดตสต็อก (เบื้องหลัง ไม่กระทบ modal)
        buildShopPayload()
          .then((payload) => interaction.message.edit(payload))
          .catch(() => {});
        return;
      }

      if (interaction.isModalSubmit() && cid.startsWith('cs:ordermodal:')) {
        await handleOrderSubmit(interaction, cid.slice('cs:ordermodal:'.length));
        return;
      }
    } catch (err) {
      console.error('[customer-shop] interaction error:', err);
      try {
        const msg = { content: '⚠️ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
        else await interaction.reply(msg);
      } catch {
        /* ignore */
      }
    }
  });

  // ---------- รับรูปสลิปที่แนบมาหลังเลือกยอดพร้อมเพย์ ----------
  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channelId !== slipChannelId) return; // อ่านสลิปเฉพาะในห้องที่กำหนด
      const pending = pendingTopups.get(message.author.id);
      if (!pending) return;
      if (Date.now() > pending.expiresAt) {
        pendingTopups.delete(message.author.id);
        return;
      }
      const img = message.attachments.find((a) => (a.contentType || '').startsWith('image/'));
      if (!img) return;
      pendingTopups.delete(message.author.id); // ใช้ได้ครั้งเดียวต่อการเลือกยอดหนึ่งครั้ง

      const processingMsg = await message.reply(`${EMOJI.LOADING}  กำลังตรวจสอบสลิป...`).catch(() => null);
      const say = (text) => (processingMsg ? processingMsg.edit(text).catch(() => {}) : message.reply(text).catch(() => {}));
      try {
        const res = await fetch(img.url);
        const buf = Buffer.from(await res.arrayBuffer());
        const data = await verifySlip({ apiKey: slipokApiKey, branchId: slipokBranchId, imageBuffer: buf, amount: pending.amount });
        const creditedAmount = toNumber(data.amount) ?? pending.amount;
        const transRef = data.transRef || null;
        let newBalance;
        try {
          newBalance = await withWalletLock(() => wallet.credit(message.author.id, creditedAmount, { transRef, source: 'slipok' }));
        } catch (e) {
          await say(`⚠️ ${e.message}`);
          return;
        }
        await say(`## ${EMOJI.SUCCESS}  เติมเครดิตสำเร็จ +${fmtBaht(creditedAmount)}\nยอดคงเหลือ: **${fmtBaht(newBalance)}**`);
      } catch (err) {
        await say(`⚠️ ตรวจสลิปไม่สำเร็จ: ${err.message}`);
      }
    } catch (err) {
      console.error('[customer-shop] slip handling error:', err);
    }
  });

  // ---------- กดส่งฟอร์มสั่งบูสต์ ----------
  async function handleOrderSubmit(interaction, tier) {
    await interaction.deferReply();
    const userId = interaction.user.id;
    try {
      const input = validateOrderInput(
        interaction.fields.getTextInputValue('server'),
        tier,
        interaction.fields.getTextInputValue('amount'),
      );
      const unitPrice = CUSTOMER_PRICE[input.tier];
      const totalPrice = unitPrice * input.amount;

      // เตรียมออเดอร์ก่อน (อ่านอย่างเดียว ยังไม่แตะเครดิตใคร) — กันสั่งซ้ำพารามิเตอร์เดิมด้วย
      const draft = await melodyService.prepare(input.server, input.tier, input.amount, input.nick);

      const currentBalance = await withWalletLock(() => wallet.balance(userId));
      if (currentBalance < totalPrice) {
        await interaction.editReply(
          `⛔ เครดิตไม่พอ ต้องใช้ **${fmtBaht(totalPrice)}** (${input.amount} × ${fmtBaht(unitPrice)}) แต่คุณมี **${fmtBaht(currentBalance)}** — กด "เติมเครดิต" ที่หน้าร้านก่อนนะ`,
        );
        return;
      }

      // หักเครดิตลูกค้าแบบ atomic ก่อนยิงบูสต์จริง (กันกดซ้ำ/race)
      const debitRes = await withWalletLock(() =>
        wallet.debit(userId, totalPrice, { tier: input.tier, amount: input.amount, server: input.server }),
      );
      if (!debitRes.ok) {
        await interaction.editReply('⛔ เครดิตไม่พอ (ยอดเปลี่ยนไประหว่างตรวจสอบ) ลองใหม่อีกครั้ง');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setDescription([`# ${EMOJI.LOADING} กำลังสั่งบูสต์อัตโนมัติ`, 'โปรดรอสักครู่ ระบบกำลังดำเนินการให้'].join('\n'))
        .addFields(
          { name: 'เซิร์ฟเวอร์', value: input.server.slice(0, 1000) },
          { name: 'แพ็ก', value: TIER_LABEL[input.tier], inline: true },
          { name: 'จำนวน', value: String(input.amount), inline: true },
          { name: 'ยอดที่หัก', value: fmtBaht(totalPrice), inline: true },
          { name: 'เครดิตคงเหลือ', value: fmtBaht(debitRes.balance), inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
      const resultMsg = await interaction.fetchReply();
      runCustomerOrder({ userId, draft, totalPrice, resultMsg, amount: input.amount, interaction });
    } catch (err) {
      await interaction.editReply(`⚠️ ${(err && err.message) || 'เกิดข้อผิดพลาด'}`);
    }
  }

  // ---------- ยิงออเดอร์จริง + คืนเครดิตตามผลลัพธ์ + แจ้งผล ----------
  async function sendCompletionNotices({ interaction, snap, record, applied, requested, complete, refundAmount, refundNote, newBal, totalPrice, userId }) {
    const { EmbedBuilder } = require('discord.js');
    const statusEmoji = complete ? '✅' : snap.status === 'partial' ? '⚠️' : '❌';
    const statusLabel = complete ? 'สำเร็จ' : snap.status === 'partial' ? 'สำเร็จบางส่วน' : 'ไม่สำเร็จ';
    const color = complete ? 0x57f287 : snap.status === 'partial' ? 0xe67e22 : 0xed4245;

    // 1) Ephemeral ที่ห้องกดบูส (เห็นเฉพาะคนกด)
    try {
      const ephemeralEmbed = new EmbedBuilder()
        .setColor(color)
        .setDescription([
          `# ${statusEmoji} บูสต์เสร็จสิ้น`,
          `## สถานะ: **${statusLabel}** (${snap.status})`,
          `บูสต์สำเร็จ: **${applied}/${requested}**`,
          refundNote,
          refundAmount > 0 ? `คืนเครดิต: **${fmtBaht(refundAmount)}** (คงเหลือ: **${fmtBaht(newBal)}**)` : '',
          `\`client_reference: ${record.client_reference}\``,
        ].filter(Boolean).join('\n'));
      await interaction.followUp({ embeds: [ephemeralEmbed], ephemeral: true });
    } catch (err) {
      console.error('[customer-shop] ส่ง ephemeral ไม่ได้:', err && err.message);
    }

    // 2) Log สรุปที่ห้อง BOOST_LOG_CHANNEL_ID (ทุกคนเห็น)
    if (logChannelId) {
      try {
        const logChannel = await discordClient.channels.fetch(logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          const logEmbed = new EmbedBuilder()
            .setColor(color)
            .setDescription([
              `# ${statusEmoji} สรุปออเดอร์ลูกค้า`,
              `**ผู้สั่ง:** <@${userId}>`,
              `**สถานะ:** ${statusLabel} (${snap.status})`,
            ].join('\n'))
            .addFields(
              { name: 'บูสต์', value: `${applied}/${requested}`, inline: true },
              { name: 'ยอดที่หัก', value: fmtBaht(totalPrice), inline: true },
              { name: 'คืนเครดิต', value: refundAmount > 0 ? fmtBaht(refundAmount) : 'ไม่มี', inline: true },
              { name: 'client_reference', value: `\`${record.client_reference}\`` },
            )
            .setFooter({ text: SHOP_FOOTER })
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }
      } catch (err) {
        console.error('[customer-shop] ส่ง log ไม่ได้:', err && err.message);
      }
    }
  }

  async function runCustomerOrder({ userId, draft, totalPrice, resultMsg, amount, interaction }) {
    const edit = (text) => resultMsg.edit(text).catch((e) => console.error('[customer-shop] แก้ข้อความไม่ได้:', e && e.message));
    let record;
    try {
      record = await melodyService.submit(draft);
    } catch (err) {
      console.error('[customer-shop] submit error:', err && err.message);
      await edit(`⚠️ เกิดข้อผิดพลาดระหว่างสั่งออเดอร์ (${err.message}) — ออเดอร์อาจค้างอยู่ ยอดที่หักไป ${fmtBaht(totalPrice)} ยังไม่คืน ติดต่อแอดมิน`);
      return;
    }

    if (record.state === 'rejected') {
      // Server ปฏิเสธคำขอ ไม่เกิดออเดอร์จริง -> คืนเครดิตลูกค้าเต็มจำนวน
      const newBal = await withWalletLock(() => wallet.refund(userId, totalPrice, { reason: 'rejected', ref: record.client_reference }));
      await edit(`❌ ระบบปฏิเสธคำขอ: ${record.note || ''}\n\nคืนเครดิตเต็มจำนวน ${fmtBaht(totalPrice)} แล้ว (คงเหลือ: ${fmtBaht(newBal)})`);
      return;
    }

    if (!['posting', 'tracking', 'unconfirmed'].includes(record.state) && record.state !== 'final') {
      await edit(
        `🕒 ยังไม่ทราบผลคำสั่งซื้อแน่ชัด (${record.note || record.state}) — ยอดที่หัก ${fmtBaht(totalPrice)} ยังไม่คืน จนกว่าจะทราบผล ติดต่อแอดมินพร้อม client_reference: \`${record.client_reference}\``,
      );
      return;
    }

    await edit(`⏳ บูสต์กำลังดำเนินการ (client_reference: \`${record.client_reference}\`) โปรดรอ...`);

    let final;
    try {
      final = await melodyService.track(record.client_reference, async (rec, snap) => {
        if (snap) await edit(`⏳ สถานะ: ${snap.status} (${snap.boosts_applied ?? 0}/${snap.boosts_requested ?? amount})`);
      });
    } catch (err) {
      await edit(
        `⚠️ ติดตามผลไม่สำเร็จ (${err.message}) — ยอดที่หัก ${fmtBaht(totalPrice)} ยังไม่คืน ติดต่อแอดมินพร้อม client_reference: \`${record.client_reference}\``,
      );
      return;
    }

    if (final.state === 'pending_review') {
      await edit(
        `🕒 ยังไม่ทราบผลสุดท้าย (ระบบตั้งเป็น "รอตรวจสอบ") — ยอดที่หัก ${fmtBaht(totalPrice)} ยังไม่คืน จนกว่าจะทราบผล ติดต่อแอดมินพร้อม client_reference: \`${record.client_reference}\` ถ้ารอนานเกินไป`,
      );
      return;
    }

    const snap = final.last_snapshot;
    if (!snap) {
      await edit(`⚠️ ไม่พบผลลัพธ์ออเดอร์ — ติดต่อแอดมินพร้อม client_reference: \`${record.client_reference}\``);
      return;
    }

    const requested = snap.boosts_requested ?? amount;
    const applied = snap.boosts_applied ?? 0;
    const complete = snap.status === 'completed' || (requested > 0 && applied >= requested);

    let refundAmount = 0;
    let refundNote;
    if (complete) {
      refundNote = 'บูสต์ส่งครบตามจำนวนที่สั่ง ไม่มีการคืนเครดิต';
    } else if (snap.failure_reason && NO_REFUND_FAILURE_REASONS.has(snap.failure_reason)) {
      refundNote = `ออเดอร์ไม่สำเร็จด้วยเหตุ "${snap.failure_reason}" — ตามนโยบายของผู้ให้บริการจะไม่คืนเครดิตของออเดอร์นี้`;
    } else if (snap.price_charged && snap.refunded !== null && snap.refunded > 0) {
      const ratio = Math.min(1, snap.refunded / snap.price_charged);
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = `ผู้ให้บริการคืนเครดิตร้าน ${(ratio * 100).toFixed(0)}% ของออเดอร์นี้ จึงคืนเครดิตคุณตามสัดส่วนเดียวกัน`;
    } else if (requested > 0 && applied < requested) {
      const ratio = (requested - applied) / requested;
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = `บูสต์ไม่ครบจำนวน คืนเครดิตตามสัดส่วนที่ขาด (${applied}/${requested})`;
    } else {
      refundNote = 'ไม่มีส่วนที่ต้องคืนตามข้อมูลที่ Server ส่งกลับ';
    }

    let newBal = null;
    if (refundAmount > 0) {
      newBal = await withWalletLock(() => wallet.refund(userId, refundAmount, { reason: 'order_shortfall', ref: record.client_reference }));
    }

    const lines = [`📦 ผลออเดอร์: **${snap.status}**`, `บูสต์สำเร็จ: ${applied}/${requested}`, refundNote];
    if (refundAmount > 0) lines.push(`คืนเครดิต: ${fmtBaht(refundAmount)} (คงเหลือ: ${fmtBaht(newBal)})`);
    lines.push(`client_reference: \`${record.client_reference}\``);
    await edit(lines.join('\n'));

    // ส่ง ephemeral ที่ห้องกดบูส + log ที่ห้อง log
    await sendCompletionNotices({ interaction, snap, record, applied, requested, complete, refundAmount, refundNote, newBal, totalPrice, userId });
  }

  console.log(`[customer-shop] พร้อมใช้งาน (ไฟล์กระเป๋าเครดิต: ${walletFile}, ราคา 1m=${price1m}บาท/ลูก 3m=${price3m}บาท/ลูก)`);
  return { wallet, CUSTOMER_PRICE, postShop };
}

module.exports = { setupCustomerShop, validateOrderInput };
