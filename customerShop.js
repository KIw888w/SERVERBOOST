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
// ห้องตรวจสลิป (ตรวจเฉพาะห้องนี้เท่านั้น) และห้องแสดงหน้าสรุปสถานะบูสต์
const SLIP_CHANNEL_ID = '1555927974455418900';
const STATUS_CHANNEL_ID = '1565009038733877369';
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

  const fmtBaht = (v) => `${Number(v).toLocaleString('th-TH')} บาท`;
  const pendingTopups = new Map(); // userId -> { amount, expiresAt }
  const slipChannelId = SLIP_CHANNEL_ID;
  const statusChannelId = (options.statusChannelId || process.env.BOOST_STATUS_CHANNEL_ID || '').trim() || STATUS_CHANNEL_ID;

  // ---------- หน้าสรุปสถานะบูสต์ (ขึ้นห้องสถานะ ไม่โชว์ข้อมูลเทคนิค/เลขออเดอร์) ----------
  const mono = (v) => `\`${String(v ?? '-').replace(/`/g, "'")}\``;
  function buildStatusEmbed({ username, tier, requested, guildName, guildIcon, state, applied = null, before = null, after = null }) {
    const colors = { processing: 0xfee75c, completed: 0x57f287, partial: 0xe67e22, failed: 0xed4245, review: 0x3498db };
    const done = applied ?? 0;
    const statusText = {
      processing: `กำลังบูสต์ ${done} | ${requested} บูสต์`,
      completed: `สำเร็จ ${done} | ${requested} บูสต์`,
      partial: `สำเร็จบางส่วน ${done} | ${requested} บูสต์`,
      failed: `ไม่สำเร็จ ${done} | ${requested} บูสต์`,
      review: 'รอแอดมินตรวจสอบ',
    }[state];
    let boostLine;
    if (state === 'processing') boostLine = 'กำลังดำเนินการ...';
    else if (state === 'review') boostLine = 'รอตรวจสอบ';
    else boostLine = before !== null && after !== null ? `เพิ่ม ${done} (ก่อน ${before} | หลัง ${after})` : `เพิ่ม ${done}`;
    const embed = new EmbedBuilder()
      .setColor(colors[state] || 0x5865f2)
      .setDescription(
        [
          `### ── ○ • ${mono('  STATUS BOOST  ')}`,
          '',
          `• **ผู้ใช้ :** ${mono(username)}`,
          `• **ประเภทบูสต์ :** ${mono(`${TIER_LABEL[tier] || tier} | ${requested} บูสต์`)}`,
          `• **บูสต์เซิร์ฟเวอร์ :** ${mono(boostLine)}`,
          '',
          `• **เซิร์ฟเวอร์ :** ${mono(guildName || 'ไม่ทราบ')}`,
          `• **สถานะบูสต์ :** ${mono(statusText)}`,
        ].join('\n'),
      )
      .setFooter({ text: SHOP_FOOTER, iconURL: shopFooterIconUrl || undefined });
    const thumb = guildIcon || shopThumbUrl;
    if (thumb) embed.setThumbnail(thumb);
    if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    return embed;
  }
  async function resolveInviteGuild(server) {
    const m = String(server).match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i);
    if (!m) return { name: null, icon: null };
    try {
      const inv = await Promise.race([
        discordClient.fetchInvite(m[1]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      const g = inv && inv.guild;
      return {
        name: (g && g.name) || null,
        icon: g && typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 256 }) : null,
      };
    } catch {
      return { name: null, icon: null };
    }
  }
  async function postStatus(payload) {
    try {
      const ch = await discordClient.channels.fetch(statusChannelId);
      if (ch && ch.isTextBased()) return await ch.send({ ...payload, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[customer-shop] ส่งหน้าสถานะไม่ได้:', err && err.message);
    }
    return null;
  }
  // แจ้งแอดมินที่ห้อง log (รายละเอียดเทคนิคอยู่ที่นี่ ไม่ส่งให้ลูกค้า)
  async function notifyAdmins(color, title, lines, fields = []) {
    if (!logChannelId || logChannelId === statusChannelId) return;
    try {
      const ch = await discordClient.channels.fetch(logChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const e = new EmbedBuilder().setColor(color).setDescription([`# ${title}`, ...lines].join('\n')).setFooter({ text: SHOP_FOOTER }).setTimestamp();
      if (fields.length) e.addFields(fields);
      await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[customer-shop] ส่ง log ไม่ได้:', err && err.message);
    }
  }
  // ข้อความ error ที่ลูกค้าเห็นได้ — ตัดคำเทคนิค/ชื่อผู้ให้บริการออก
  const TECH_RE = /client_reference|boosttrack|boostfind|boostpending|\bapi\b|api_|order_id|price_charged|refunded|stock_conflict|token|melody/i;
  function safeErr(err) {
    const m = (err && err.message) || '';
    if (!m || TECH_RE.test(m)) {
      console.error('[customer-shop] ซ่อน error จากลูกค้า:', m);
      return 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง หรือติดต่อแอดมิน';
    }
    return m;
  }

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

  // จำนวนบูสต์ที่บอทบูสต์สำเร็จจริงทั้งหมด แยกตามแพ็ก (รวมจากประวัติออเดอร์ที่จบแล้ว)
  function countBoostedTotals() {
    if (typeof melodyService.list !== 'function') return null;
    try {
      const totals = { '1m': 0, '3m': 0 };
      for (const r of melodyService.list()) {
        if (r.state !== 'final' || !r.last_snapshot || !(r.tier in totals)) continue;
        const n = toInt(r.last_snapshot.boosts_applied);
        if (n !== null && n > 0) totals[r.tier] += n;
      }
      return totals;
    } catch (err) {
      console.error('[customer-shop] นับบูสต์ทั้งหมดไม่ได้:', err && err.message);
      return null;
    }
  }

  async function buildShopPayload(preloadedStock) {
    const stock = preloadedStock || (await fetchStock());
    const boostedTotals = countBoostedTotals();
    const info = {};
    for (const t of CUSTOMER_TIERS) {
      info[t] = {
        left: toInt(stock[`boosts_${t}_available`]),
        total: boostedTotals ? boostedTotals[t] : toInt(stock[`boosts_${t}_total`]),
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
    const sent = await channel.send(await buildShopPayload());
    registerShopMessage(channel.id, sent.id);
    return sent;
  }

  // ---------- อัปเดตหน้าร้านอัตโนมัติ (สต็อกเปลี่ยน / มีคนบูสต์เสร็จ) ----------
  const shopMsgFile = path.join(path.dirname(walletFile), 'shop_messages.json');
  let shopMessages = [];
  try {
    const raw = JSON.parse(require('fs').readFileSync(shopMsgFile, 'utf8'));
    if (Array.isArray(raw)) shopMessages = raw.filter((x) => x && x.channelId && x.messageId);
  } catch {
    /* ยังไม่มีไฟล์ = ยังไม่เคยโพสต์หน้าร้าน */
  }
  function saveShopMessages() {
    try {
      const fs = require('fs');
      const tmp = `${shopMsgFile}.tmp`;
      fs.mkdirSync(path.dirname(shopMsgFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(shopMessages, null, 2));
      fs.renameSync(tmp, shopMsgFile);
    } catch (err) {
      console.error('[customer-shop] บันทึกรายการหน้าร้านไม่ได้:', err && err.message);
    }
  }
  function registerShopMessage(channelId, messageId) {
    if (!shopMessages.some((x) => x.messageId === messageId)) {
      shopMessages.push({ channelId, messageId });
      if (shopMessages.length > 20) shopMessages = shopMessages.slice(-20);
      saveShopMessages();
    }
    lastShopSig = null; // บังคับให้รอบถัดไปเทียบใหม่
  }

  let lastShopSig = null;
  let refreshingShop = false;
  async function refreshShops(reason) {
    if (refreshingShop || shopMessages.length === 0) return;
    refreshingShop = true;
    try {
      let stock;
      try {
        stock = await melodyService.client.stock();
      } catch (err) {
        console.error('[customer-shop] อัปเดตหน้าร้าน: ดึงสต็อกไม่ได้:', err && err.message);
        return; // ดึงไม่ได้ = ไม่แก้ข้อความ (กันขึ้น "ไม่ทราบ")
      }
      if (!stock || typeof stock !== 'object') return;
      const totals = countBoostedTotals();
      const sig = JSON.stringify([
        CUSTOMER_TIERS.map((t) => [toInt(stock[`boosts_${t}_available`]), toInt(stock[`boosts_${t}_total`])]),
        totals,
        CUSTOMER_PRICE,
      ]);
      if (sig === lastShopSig) return; // ไม่มีอะไรเปลี่ยน ไม่ต้องแก้ข้อความ
      const payload = await buildShopPayload(stock);
      let allOk = true;
      for (const entry of [...shopMessages]) {
        try {
          const ch = await discordClient.channels.fetch(entry.channelId);
          await ch.messages.edit(entry.messageId, payload);
        } catch (err) {
          const code = err && err.code;
          if (code === 10008 || code === 10003 || code === 50001) {
            // ข้อความ/ห้องถูกลบ หรือบอทเข้าไม่ได้ -> เลิกอัปเดตอันนี้
            shopMessages = shopMessages.filter((x) => x.messageId !== entry.messageId);
            saveShopMessages();
          } else {
            allOk = false;
            console.error('[customer-shop] แก้หน้าร้านไม่ได้:', err && err.message);
          }
        }
      }
      if (allOk) lastShopSig = sig;
      if (reason) console.log(`[customer-shop] อัปเดตหน้าร้านแล้ว (${reason})`);
    } finally {
      refreshingShop = false;
    }
  }
  const shopRefreshSec = Math.max(30, toInt(process.env.BOOST_SHOP_REFRESH_SEC) ?? 60);
  let shopTimerStarted = false;
  function startShopRefresh() {
    if (shopTimerStarted) return;
    shopTimerStarted = true;
    const timer = setInterval(() => refreshShops('สต็อก/ยอดบูสต์เปลี่ยน').catch(() => {}), shopRefreshSec * 1000);
    if (timer.unref) timer.unref();
    refreshShops().catch(() => {}); // เทียบครั้งแรกทันทีหลังบอทออนไลน์
  }
  if (typeof discordClient.isReady === 'function' && discordClient.isReady()) startShopRefresh();
  else {
    discordClient.once('ready', startShopRefresh);
    discordClient.once('clientReady', startShopRefresh);
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

  // ---------- แอดมินเติมเครดิตให้ลูกค้าเอง: !addcredit @คน 100 [หมายเหตุ] ----------
  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!/^!(addcredit|เติมเครดิต)(\s|$)/i.test(message.content.trim())) return;
      if (!isAdmin(message.member, message.author.id)) return;
      const m = message.content.trim().match(/^!(addcredit|เติมเครดิต)\s+(?:<@!?(\d{15,25})>|(\d{15,25}))\s+([\d,]+(?:\.\d{1,2})?)(?:\s+([\s\S]+))?$/i);
      if (!m) {
        await message.reply('⚠️ ใช้แบบนี้: `!addcredit @ลูกค้า 100 หมายเหตุ(ไม่ใส่ก็ได้)` หรือใช้ไอดีแทน @ ก็ได้').catch(() => {});
        return;
      }
      const targetId = m[2] || m[3];
      const amount = Math.round(Number(m[4].replace(/,/g, '')) * 100) / 100;
      const note = (m[5] || '').trim().slice(0, 200);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        await message.reply('⚠️ จำนวนเงินไม่ถูกต้อง (ต้องมากกว่า 0 และไม่เกิน 100,000)').catch(() => {});
        return;
      }
      let newBalance;
      try {
        newBalance = await withWalletLock(() =>
          wallet.credit(targetId, amount, { source: 'admin', by: message.author.id, note: note || undefined }),
        );
      } catch (err) {
        await message.reply(`⚠️ เติมเครดิตไม่สำเร็จ: ${err.message}`).catch(() => {});
        return;
      }
      await message
        .reply({
          content: `✅ เติมเครดิตให้ <@${targetId}> **+${fmtBaht(amount)}** แล้ว (คงเหลือ: **${fmtBaht(newBalance)}**)${note ? `\nหมายเหตุ: ${note}` : ''}`,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => {});
      await notifyAdmins(0x3498db, '🛠️ แอดมินเติมเครดิต', [
        `**ผู้เติม:** <@${message.author.id}>`,
        `**ผู้รับ:** <@${targetId}>`,
        `**จำนวน:** ${fmtBaht(amount)} (คงเหลือ ${fmtBaht(newBalance)})`,
        note ? `**หมายเหตุ:** ${note}` : '',
      ].filter(Boolean));
    } catch (err) {
      console.error('[customer-shop] addcredit error:', err);
    }
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

  // ---------- รับรูปสลิปที่แนบมาหลังเลือกยอดพร้อมเพย์ (ตรวจเฉพาะห้องสลิปเท่านั้น) ----------
  const slipBusy = new Set();
  const isImageAttachment = (a) =>
    (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|heic|heif|bmp|gif)$/i.test(a.name || '');
  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channelId !== slipChannelId) return;
      const uid = message.author.id;
      const pending = pendingTopups.get(uid);
      if (!pending) return;
      if (Date.now() > pending.expiresAt) {
        pendingTopups.delete(uid);
        return;
      }
      const img = message.attachments.find(isImageAttachment);
      if (!img) return;
      if (slipBusy.has(uid)) return; // กำลังตรวจสลิปก่อนหน้าอยู่
      slipBusy.add(uid);

      const processingMsg = await message.reply(`${EMOJI.LOADING}  กำลังตรวจสอบสลิป...`).catch(() => null);
      const say = (payload) => {
        const body = typeof payload === 'string' ? { content: payload, embeds: [] } : payload;
        return processingMsg ? processingMsg.edit(body).catch(() => {}) : message.reply(body).catch(() => {});
      };
      try {
        const res = await fetch(img.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`โหลดรูปสลิปไม่สำเร็จ (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const data = await verifySlip({ apiKey: slipokApiKey, branchId: slipokBranchId, imageBuffer: buf, amount: pending.amount });
        const creditedAmount = toNumber(data.amount) ?? pending.amount;
        const transRef = data.transRef || null;
        let newBalance;
        try {
          newBalance = await withWalletLock(() => wallet.credit(uid, creditedAmount, { transRef, source: 'slipok' }));
        } catch (e) {
          await say(`⚠️ ${String(e.message).replace(/\s*\(transRef:[^)]*\)/, '')}`);
          return;
        }
        pendingTopups.delete(uid); // เติมสำเร็จแล้ว ใช้ได้ครั้งเดียวต่อการเลือกยอด
        const done = new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription([`# ${EMOJI.SUCCESS}  เติมเครดิตเสร็จสิ้น`, `## +${fmtBaht(creditedAmount)}`, `เครดิตคงเหลือ: **${fmtBaht(newBalance)}**`].join('\n'));
        await say({ content: '', embeds: [done] });
      } catch (err) {
        console.error('[customer-shop] ตรวจสลิปไม่ผ่าน:', err && err.message);
        await say(`⚠️ ตรวจสลิปไม่สำเร็จ: ${(err && err.userMessage) || (err && err.message) || 'ลองใหม่อีกครั้ง'}\n-# ส่งสลิปใหม่ได้ในห้องนี้ภายในเวลาที่เหลือ หรือกดเลือกยอดใหม่`);
      } finally {
        slipBusy.delete(uid);
      }
    } catch (err) {
      console.error('[customer-shop] slip handling error:', err);
    }
  });

  // ---------- กดส่งฟอร์มสั่งบูสต์ ----------
  async function handleOrderSubmit(interaction, tier) {
    await interaction.deferReply({ ephemeral: true }); // ข้อความถึงลูกค้าเห็นเฉพาะคนสั่ง
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

      // โพสต์หน้าสรุปสถานะ "กำลังบูสต์" ขึ้นห้องสถานะทันที
      const guildInfo = await resolveInviteGuild(input.server);
      const view = {
        username: interaction.user.username,
        tier: input.tier,
        requested: input.amount,
        guildName: guildInfo.name,
        guildIcon: guildInfo.icon,
      };
      const statusMsg = await postStatus({ content: '', embeds: [buildStatusEmbed({ ...view, state: 'processing' })] });

      if (statusMsg) {
        const ack = new EmbedBuilder()
          .setColor(0xfee75c)
          .setDescription(
            [
              `# ${EMOJI.LOADING} รับออเดอร์แล้ว กำลังบูสต์`,
              `ดูหน้าสถานะได้ที่ ${statusMsg.url}`,
              '',
              `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`,
              `**เครดิตคงเหลือ:** ${fmtBaht(debitRes.balance)}`,
              '*โปรดรอสักครู่ อย่ากดสั่งซ้ำ*',
            ].join('\n'),
          );
        await interaction.editReply({ content: '', embeds: [ack] }).catch(() => {});
      } else {
        // ส่งเข้าห้องสถานะไม่ได้ (เช่นบอทไม่มีสิทธิ์) -> แสดงหน้าสถานะในข้อความของลูกค้าเองแทน
        await interaction
          .editReply({ content: '', embeds: [buildStatusEmbed({ ...view, state: 'processing' })] })
          .catch(() => {});
      }
      runCustomerOrder({ userId, draft, totalPrice, amount: input.amount, view, statusMsg, interaction });
    } catch (err) {
      await interaction.editReply(`⚠️ ${safeErr(err)}`).catch(() => {});
    }
  }

  // ---------- ยิงออเดอร์จริง + คืนเครดิตตามผลลัพธ์ + อัปเดตหน้าสถานะ ----------
  async function runCustomerOrder({ userId, draft, totalPrice, amount, view, statusMsg, interaction }) {
    const updateStatus = async (state, extra = {}) => {
      const payload = { content: '', embeds: [buildStatusEmbed({ ...view, state, ...extra })] };
      try {
        if (statusMsg) await statusMsg.edit(payload);
        else await interaction.editReply(payload);
      } catch (e) {
        console.error('[customer-shop] แก้หน้าสถานะไม่ได้:', e && e.message);
      }
    };
    const tell = (text) =>
      interaction.followUp({ content: text, ephemeral: true }).catch((e) => console.error('[customer-shop] ส่งข้อความหาลูกค้าไม่ได้:', e && e.message));
    const orderLines = () => [`**ผู้สั่ง:** <@${userId}>`, `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`];

    let record;
    try {
      record = await melodyService.submit(draft);
    } catch (err) {
      console.error('[customer-shop] submit error:', err && err.message);
      await updateStatus('review');
      await tell(`⚠️ เกิดข้อผิดพลาดระหว่างสั่งออเดอร์ ออเดอร์ของคุณถูกบันทึกไว้แล้ว ยอดที่หัก ${fmtBaht(totalPrice)} ยังไม่ถูกคืนจนกว่าแอดมินจะตรวจสอบ กรุณาติดต่อแอดมิน`);
      await notifyAdmins(0xe67e22, '⚠️ ออเดอร์ลูกค้า: ส่งคำสั่งไม่สำเร็จ', [...orderLines(), `**สาเหตุ:** ${(err && err.message) || 'ไม่ทราบ'}`]);
      return;
    }
    const refField = { name: 'client_reference', value: `\`${record.client_reference}\`` };

    if (record.state === 'rejected') {
      // ระบบปฏิเสธคำขอ ไม่เกิดออเดอร์จริง -> คืนเครดิตลูกค้าเต็มจำนวน
      const newBal = await withWalletLock(() => wallet.refund(userId, totalPrice, { reason: 'rejected', ref: record.client_reference }));
      await updateStatus('failed', { applied: 0 });
      await tell(`❌ ออเดอร์ไม่สำเร็จ ระบบคืนเครดิตเต็มจำนวน **${fmtBaht(totalPrice)}** แล้ว (คงเหลือ: **${fmtBaht(newBal)}**)\nตรวจสอบว่าลิงก์เชิญยังไม่หมดอายุและใช้ได้ไม่จำกัด แล้วลองใหม่อีกครั้ง`);
      await notifyAdmins(0xed4245, '❌ ออเดอร์ลูกค้าถูกปฏิเสธ (คืนเครดิตเต็มแล้ว)', [...orderLines(), `**หมายเหตุ:** ${record.note || '-'}`], [refField]);
      return;
    }

    const reviewNotice = async (title, why) => {
      await updateStatus('review');
      await tell(`🕒 ออเดอร์ของคุณอยู่ระหว่างตรวจสอบ ยอดที่หัก ${fmtBaht(totalPrice)} จะยังไม่ถูกคืนจนกว่าจะทราบผล กรุณาติดต่อแอดมิน`);
      await notifyAdmins(0xfee75c, title, [...orderLines(), `**รายละเอียด:** ${why}`, 'ติดตามด้วย `!boosttrack <client_reference>`'], [refField]);
    };

    if (!['posting', 'tracking', 'unconfirmed'].includes(record.state) && record.state !== 'final') {
      await reviewNotice('🕒 ออเดอร์ลูกค้า: ยังไม่ทราบผล', record.note || record.state);
      return;
    }

    let lastKey = null;
    let final;
    try {
      final = await melodyService.track(record.client_reference, async (rec, snap) => {
        if (!snap) return;
        if (['completed', 'partial', 'failed', 'api_failed'].includes(snap.status)) return; // ผลสุดท้ายแสดงตอนจบ
        const key = `${snap.status}|${snap.boosts_applied}`;
        if (key === lastKey) return;
        lastKey = key;
        await updateStatus('processing', { applied: snap.boosts_applied ?? 0 });
      });
    } catch (err) {
      await reviewNotice('⚠️ ออเดอร์ลูกค้า: ติดตามผลไม่สำเร็จ', (err && err.message) || 'ไม่ทราบ');
      return;
    }

    if (final.state === 'pending_review') {
      await reviewNotice('🕒 ออเดอร์ลูกค้า: รอตรวจสอบ (ติดตามเกินเวลา)', final.note || 'pending_review');
      return;
    }
    const snap = final.last_snapshot;
    if (!snap) {
      await reviewNotice('⚠️ ออเดอร์ลูกค้า: ไม่พบผลลัพธ์', 'ไม่มี snapshot');
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
      refundNote = 'ไม่สามารถบูสต์เซิร์ฟเวอร์นี้ได้ครบ (ตรวจสอบว่าลิงก์เชิญยังไม่หมดอายุและใช้ได้ไม่จำกัด) ตามเงื่อนไขของร้านจะไม่คืนเครดิตของออเดอร์นี้ หากมีข้อสงสัยติดต่อแอดมิน';
    } else if (snap.price_charged && snap.refunded !== null && snap.refunded > 0) {
      const ratio = Math.min(1, snap.refunded / snap.price_charged);
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = 'คืนเครดิตตามสัดส่วนบูสต์ที่ไม่สำเร็จ';
    } else if (requested > 0 && applied < requested) {
      const ratio = (requested - applied) / requested;
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = `บูสต์ไม่ครบจำนวน คืนเครดิตตามสัดส่วนที่ขาด (${applied}/${requested})`;
    } else {
      refundNote = 'ไม่มีส่วนที่ต้องคืน';
    }

    let newBal = null;
    if (refundAmount > 0) {
      newBal = await withWalletLock(() => wallet.refund(userId, refundAmount, { reason: 'order_shortfall', ref: record.client_reference }));
    }

    const state = complete ? 'completed' : applied > 0 ? 'partial' : 'failed';
    await updateStatus(state, { applied, requested, before: snap.boosts_before ?? null, after: snap.boosts_after ?? null });
    refreshShops('มีออเดอร์บูสต์เสร็จ').catch(() => {}); // หน้าร้านอัปเดตสต็อก/ยอดบูสต์ทันที

    // ข้อความถึงลูกค้า (เห็นเฉพาะคนสั่ง) — ไม่มีข้อมูลเทคนิค
    const statusLabel = { completed: 'สำเร็จ', partial: 'สำเร็จบางส่วน', failed: 'ไม่สำเร็จ' }[state];
    const color = { completed: 0x57f287, partial: 0xe67e22, failed: 0xed4245 }[state];
    const customerEmbed = new EmbedBuilder()
      .setColor(color)
      .setDescription(
        [
          `# ${{ completed: '✅', partial: '⚠️', failed: '❌' }[state]} บูสต์เสร็จสิ้น`,
          `## ผล: **${statusLabel}**`,
          `บูสต์สำเร็จ: **${applied}/${requested}**`,
          refundNote,
          refundAmount > 0 ? `คืนเครดิต: **${fmtBaht(refundAmount)}** (คงเหลือ: **${fmtBaht(newBal)}**)` : '',
        ].filter(Boolean).join('\n'),
      );
    await interaction.followUp({ embeds: [customerEmbed], ephemeral: true }).catch((err) => console.error('[customer-shop] ส่งผลให้ลูกค้าไม่ได้:', err && err.message));

    // log สำหรับแอดมิน (มี client_reference)
    await notifyAdmins(
      color,
      `${{ completed: '✅', partial: '⚠️', failed: '❌' }[state]} สรุปออเดอร์ลูกค้า`,
      [`**ผู้สั่ง:** <@${userId}>`, `**สถานะ:** ${statusLabel} (${snap.status})`],
      [
        { name: 'บูสต์', value: `${applied}/${requested}`, inline: true },
        { name: 'ยอดที่หัก', value: fmtBaht(totalPrice), inline: true },
        { name: 'คืนเครดิต', value: refundAmount > 0 ? fmtBaht(refundAmount) : 'ไม่มี', inline: true },
        refField,
      ],
    );
  }

  console.log(`[customer-shop] พร้อมใช้งาน (ไฟล์กระเป๋าเครดิต: ${walletFile}, ราคา 1m=${price1m}บาท/ลูก 3m=${price3m}บาท/ลูก)`);
  return { wallet, CUSTOMER_PRICE, postShop };
}

module.exports = { setupCustomerShop, validateOrderInput };
