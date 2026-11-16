// Server bot - single file version
// Needs: npm i discord.js dotenv  (Node 18+)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, REST, Routes, Events, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelType, AttachmentBuilder,
} = require('discord.js');

const P = PermissionFlagsBits;
const Cmd = SlashCommandBuilder;
const EPH = MessageFlags.Ephemeral;
const unix = ms => Math.floor(ms / 1000);

// ======================================================
// Config (values come from .env)
// ======================================================

const env = process.env;

const min = n => n * 60 * 1000;

const cfg = {
  token: env.TOKEN,
  guildId: env.GUILD_ID,

  colors: { main: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, err: 0xed4245, dark: 0x2b2d31, orange: 0xe67e22 },

  channels: {
    welcome: env.WELCOME_CHANNEL_ID,
    rules: env.RULES_CHANNEL_ID,
    logs: env.LOG_CHANNEL_ID,
    modLog: env.MOD_LOG_CHANNEL_ID,     // falls back to logs
    ticketLog: env.TICKET_LOG_CHANNEL_ID, // falls back to logs
    prices: env.PRICE_CHANNEL_ID,
  },

  roles: { verified: env.VERIFIED_ROLE_ID, staff: env.STAFF_ROLE_ID },

  ticketCategory: env.TICKET_CATEGORY_ID,
  tickets: { maxOpen: 3 },

  // buttons in /rolepanel
  selfRoles: [
    { label: 'Updates', emoji: '🔔', id: env.UPDATES_ROLE_ID },
    { label: 'News', emoji: '📰', id: env.NEWS_ROLE_ID },
  ].filter(r => r.id),

  registerRoles: [1, 2, 3]
    .map(n => ({ name: env[`REGISTER_ROLE_${n}_NAME`], id: env[`REGISTER_ROLE_${n}_ID`] }))
    .filter(r => r.id),

  // keys handed out by /register - one per person, put your 10 keys here
  keys: [
    'REPLACE-KEY-1',
    'REPLACE-KEY-2',
    'REPLACE-KEY-3',
    'REPLACE-KEY-4',
    'REPLACE-KEY-5',
    'REPLACE-KEY-6',
    'REPLACE-KEY-7',
    'REPLACE-KEY-8',
    'REPLACE-KEY-9',
    'REPLACE-KEY-10',
  ],

  // price list message (refreshed every 15 minutes)
  priceList: {
    title: '💰 Price List',
    footer: 'Price list',
    color: 0xf0a30a,
    image: null, // optional banner url
    items: [
      { name: 'Script 2 week', price: '$4.99', emoji: '🟢' },
      { name: 'Script 1 month', price: '$9.99', emoji: '🟢' },
    ],
  },

  // rules message posted by /rulespanel
  rules: {
    title: '📜 SERVER RULES',
    items: [
      { title: 'Channel Usage', emoji: '🔗', text: 'Use channels only for their purpose.' },
      { title: 'Toxicity', emoji: '😡', text: 'Keep toxicity low. No targeting.' },
      { title: 'Spam', emoji: '🐷', text: 'No spam. 3 identical messages = warn/mute.' },
      { title: 'Staff', emoji: '🛠️', text: 'Staff decisions are final. No begging.' },
      { title: 'Profanity', emoji: '💢', text: 'Keep your language clean. Excess = punishment.' },
      { title: 'Discrimination', emoji: '❌', text: 'Not tolerated. Any form = ban.' },
      { title: 'NSFW', emoji: '🔞', text: 'Forbidden in any form.' },
      { title: 'Personal Info', emoji: '🕵️', text: 'No doxing or sharing without consent.' },
      { title: 'Ads', emoji: '📢', text: 'No advertising.' },
      { title: 'Illegal Activity', emoji: '👮', text: 'Strictly forbidden.' },
      { title: 'Respect', emoji: '💖', text: 'Be polite and respectful.' },
    ],
  },

  // what happens when someone piles up warnings
  moderation: {
    muteAt: 3,
    muteDuration: min(60),
    kickAt: 5,
  },

  automod: {
    ignoredChannels: [],
    spam: { messages: 5, seconds: 5, muteDuration: min(10) },
    duplicates: 3, // same message this many times in 30s
    mentions: 5,
    emojis: 10,
    caps: { percent: 70, minLetters: 10 },
    blockInvites: true,
    blockLinks: true,
    allowedDomains: ['youtube.com', 'youtu.be', 'tenor.com', 'giphy.com'],
    badWords: ['fuck', 'shit', 'bitch', 'cunt', 'faggot', 'nigger'],
  },

  prices: { intervalMin: 15 },
};

// ======================================================
// Storage
// ======================================================

const FILE = path.join(__dirname, 'data.json');

let data = {
  cases: [], caseCount: 0,
  tickets: {}, ticketCount: 0,
  giveaways: {},
  verify: null,
  prices: null,
  registered: {}, // userId -> { key, at, revoked }
};

try {
  data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  // first run, nothing saved yet
}

const save = () => fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

// ======================================================
// Helpers
// ======================================================

const ok = text => new EmbedBuilder().setColor(cfg.colors.ok).setDescription(`✅ ${text}`);
const fail = text => new EmbedBuilder().setColor(cfg.colors.err).setDescription(`❌ ${text}`);

async function send(client, channelId, payload) {
  if (!channelId) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (ch) await ch.send(payload).catch(() => {});
}

const log = (client, embed) => send(client, cfg.channels.logs, { embeds: [embed] });
const modLog = (client, embed) => send(client, cfg.channels.modLog || cfg.channels.logs, { embeds: [embed] });
const ticketLog = (client, embed, files = []) =>
  send(client, cfg.channels.ticketLog || cfg.channels.logs, { embeds: [embed], files });

function isStaff(member) {
  return member.permissions.has('ManageMessages') ||
    Boolean(cfg.roles.staff && member.roles.cache.has(cfg.roles.staff));
}

const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

// "10m", "2h", "1d12h" -> ms
function parseDuration(str) {
  if (!str) return null;
  const clean = str.toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(clean)) return null;
  let total = 0;
  for (const [, n, u] of clean.matchAll(/(\d+)([smhdw])/g)) total += Number(n) * UNITS[u];
  return total;
}

function formatDuration(ms) {
  const out = [];
  for (const [label, size] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3]]) {
    const n = Math.floor(ms / size);
    ms %= size;
    if (n) out.push(n + label);
  }
  return out.join(' ') || '0s';
}

// ======================================================
// Moderation cases
// ======================================================

// Case tracking shared by the moderation commands and automod.

const TYPES = {
  warn:   { label: 'Warn',   color: cfg.colors.warn,   dm: 'warned in' },
  mute:   { label: 'Mute',   color: cfg.colors.orange, dm: 'muted in' },
  unmute: { label: 'Unmute', color: cfg.colors.ok,     dm: 'unmuted in' },
  kick:   { label: 'Kick',   color: cfg.colors.orange, dm: 'kicked from' },
  ban:    { label: 'Ban',    color: cfg.colors.err,    dm: 'banned from' },
  unban:  { label: 'Unban',  color: cfg.colors.ok,     dm: 'unbanned from' },
};

async function notifyUser(user, guild, type, reason, duration) {
  const t = TYPES[type];
  const embed = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`You were ${t.dm} ${guild.name}`)
    .addFields({ name: 'Reason', value: reason || 'No reason provided' });
  if (duration) embed.addFields({ name: 'Duration', value: formatDuration(duration) });
  await user.send({ embeds: [embed] }).catch(() => {});
}

async function createCase(client, { type, user, moderator, reason, duration }) {
  data.caseCount += 1;
  const c = {
    id: data.caseCount, type, userId: user.id, modId: moderator.id,
    reason: reason || 'No reason provided', duration: duration || null, at: Date.now(),
  };
  data.cases.push(c);
  save();

  const t = TYPES[type];
  const embed = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`Case #${c.id} • ${t.label}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user} (${user.id})`, inline: true },
      { name: 'Moderator', value: `<@${moderator.id}>`, inline: true },
      { name: 'Reason', value: c.reason },
    )
    .setTimestamp();
  if (duration) embed.addFields({ name: 'Duration', value: formatDuration(duration), inline: true });
  modLog(client, embed);
  return c;
}

const activeWarns = userId =>
  data.cases.filter(c => c.type === 'warn' && c.userId === userId && !c.removed).length;

async function addWarn(client, guild, member, moderator, reason) {
  await notifyUser(member.user, guild, 'warn', reason);
  const warnCase = await createCase(client, { type: 'warn', user: member.user, moderator, reason });
  const total = activeWarns(member.id);
  const rules = cfg.moderation;
  let escalation = null;

  if (total >= rules.kickAt && member.kickable) {
    const why = `Reached ${total} warnings`;
    await notifyUser(member.user, guild, 'kick', why);
    await member.kick(why).catch(() => {});
    await createCase(client, { type: 'kick', user: member.user, moderator: client.user, reason: why });
    escalation = 'kick';
  } else if (total >= rules.muteAt && member.moderatable) {
    const why = `Reached ${total} warnings`;
    await member.timeout(rules.muteDuration, why).catch(() => {});
    await createCase(client, { type: 'mute', user: member.user, moderator: client.user, reason: why, duration: rules.muteDuration });
    escalation = 'mute';
  }
  return { case: warnCase, total, escalation };
}

// ======================================================
// Welcome / goodbye
// ======================================================

const welcome = {
  init(client) {
    client.on(Events.GuildMemberAdd, async member => {
      const channel = cfg.channels.welcome && await client.channels.fetch(cfg.channels.welcome).catch(() => null);

      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.main)
          .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL() })
          .setTitle(`Welcome, ${member.user.username}!`)
          .setDescription(
            `Glad to have you here, ${member}.\n` +
            `Verify yourself, pick your roles and have a look around.`)
          .setThumbnail(member.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: 'Member', value: `#${member.guild.memberCount}`, inline: true },
            { name: 'Account created', value: `<t:${unix(member.user.createdTimestamp)}:R>`, inline: true },
          )
          .setFooter({ text: member.guild.name })
          .setTimestamp();

        const components = [];
        if (cfg.channels.rules) {
          components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Read the rules').setEmoji('📜').setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${member.guild.id}/${cfg.channels.rules}`)));
        }
        channel.send({ content: `${member}`, embeds: [embed], components });
      }

      log(client, new EmbedBuilder()
        .setColor(cfg.colors.ok)
        .setTitle('Member joined')
        .setDescription(`${member} (${member.id})\nAccount created <t:${unix(member.user.createdTimestamp)}:R>`)
        .setThumbnail(member.displayAvatarURL())
        .setTimestamp());
    });

    client.on(Events.GuildMemberRemove, member => {
      log(client, new EmbedBuilder()
        .setColor(cfg.colors.err)
        .setTitle('Member left')
        .setDescription(`**${member.user.tag}** (${member.id})`)
        .setThumbnail(member.displayAvatarURL())
        .setTimestamp());
    });
  },
};

// ======================================================
// Self roles (buttons)
// ======================================================

const roles = {
  commands: [
    new SlashCommandBuilder()
      .setName('rolepanel')
      .setDescription('Post the self-role panel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ],

  async onCommand(i) {
    if (!cfg.selfRoles.length) {
      return i.reply({ embeds: [fail('No roles configured. Set UPDATES_ROLE_ID / NEWS_ROLE_ID in your .env.')], flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setColor(cfg.colors.main)
      .setTitle('Notification roles')
      .setDescription(
        'Pick what you want to be pinged for. Click a button to get the role, click again to remove it.\n\n' +
        cfg.selfRoles.map(r => `${r.emoji}  <@&${r.id}>`).join('\n'))
      .setFooter({ text: i.guild.name });

    const row = new ActionRowBuilder().addComponents(
      cfg.selfRoles.map(r => new ButtonBuilder()
        .setCustomId(`role:${r.id}`).setLabel(r.label).setEmoji(r.emoji).setStyle(ButtonStyle.Secondary)));

    await i.channel.send({ embeds: [embed], components: [row] });
    i.reply({ embeds: [ok('Role panel posted.')], flags: MessageFlags.Ephemeral });
  },

  async onComponent(i) {
    if (!i.isButton() || !i.customId.startsWith('role:')) return false;

    const roleId = i.customId.split(':')[1];
    const has = i.member.roles.cache.has(roleId);
    await (has ? i.member.roles.remove(roleId) : i.member.roles.add(roleId));

    i.reply({
      embeds: [ok(has ? `Removed <@&${roleId}>.` : `You now have <@&${roleId}>.`)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  },
};

// ======================================================
// AutoMod + anti link
// ======================================================

const INVITE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const LINK = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|ru|net|org|io|gg|xyz|me|tk|ly|to|co|info|site|online)\b\S*)/gi;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI = /\p{Extended_Pictographic}/gu;

const badWords = new RegExp(`\\b(?:${cfg.automod.badWords.join('|')})`, 'i');
const history = new Map(); // userId -> [{ t, text }]

function hostOf(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
}

const isAllowed = host => cfg.automod.allowedDomains.some(d => host === d || host.endsWith('.' + d));

async function flag(msg, reason) {
  await msg.delete().catch(() => {});
  const res = await addWarn(msg.client, msg.guild, msg.member, msg.client.user, `AutoMod: ${reason}`);

  let text = `${msg.author}, ${reason.toLowerCase()}.\nWarning **${res.total}** on record.`;
  if (res.escalation === 'mute') text += ' You have been muted.';
  if (res.escalation === 'kick') text += ' You have been kicked.';

  const notice = await msg.channel.send({
    embeds: [new EmbedBuilder().setColor(cfg.colors.warn).setTitle('AutoMod').setDescription(text)],
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 7000);
}

async function handleSpam(msg) {
  const rule = cfg.automod.spam;
  const now = Date.now();
  const list = (history.get(msg.author.id) || []).filter(e => now - e.t < 30000);
  list.push({ t: now, text: msg.content });
  history.set(msg.author.id, list);

  const burst = list.filter(e => now - e.t < rule.seconds * 1000).length;
  if (burst >= rule.messages) {
    history.delete(msg.author.id);
    if (msg.member.moderatable) {
      const reason = 'AutoMod: spam';
      await notifyUser(msg.author, msg.guild, 'mute', reason, rule.muteDuration);
      await msg.member.timeout(rule.muteDuration, reason).catch(() => {});
      await createCase(msg.client, { type: 'mute', user: msg.author, moderator: msg.client.user, reason, duration: rule.muteDuration });
    }
    const recent = await msg.channel.messages.fetch({ limit: 30 }).catch(() => null);
    if (recent) {
      const mine = recent.filter(m => m.author.id === msg.author.id);
      msg.channel.bulkDelete(mine, true).catch(() => {});
    }
    return true;
  }

  const same = list.filter(e => e.text && e.text === msg.content).length;
  if (same >= cfg.automod.duplicates) {
    history.delete(msg.author.id);
    await flag(msg, 'Duplicate messages');
    return true;
  }
  return false;
}

const automod = {
  init(client) {
    client.on(Events.MessageCreate, async msg => {
      if (!msg.guild || msg.author.bot || !msg.member) return;
      if (isStaff(msg.member)) return;
      if (cfg.automod.ignoredChannels.includes(msg.channelId)) return;

      const a = cfg.automod;
      const text = msg.content;

      if (await handleSpam(msg)) return;

      if (a.blockInvites && INVITE.test(text)) return flag(msg, 'Invite links are not allowed');

      if (a.blockLinks) {
        const links = text.match(LINK);
        if (links && links.some(l => !isAllowed(hostOf(l)))) return flag(msg, 'Links are not allowed');
      }

      if (badWords.test(text)) return flag(msg, 'Watch your language');

      if (msg.mentions.users.size + msg.mentions.roles.size >= a.mentions) return flag(msg, 'Too many mentions');

      const emojiCount = (text.match(CUSTOM_EMOJI)?.length || 0) + (text.match(UNICODE_EMOJI)?.length || 0);
      if (emojiCount >= a.emojis) return flag(msg, 'Too many emojis');

      const letters = text.replace(/[^a-z]/gi, '');
      if (letters.length >= a.caps.minLetters) {
        const upper = letters.replace(/[^A-Z]/g, '').length;
        if ((upper / letters.length) * 100 >= a.caps.percent) return flag(msg, 'Too many capital letters');
      }
    });
  },
};

// ======================================================
// Moderation commands
// ======================================================

const MAX_TIMEOUT = 28 * 864e5;

const userOpt = (o, desc = 'The member') => o.setName('user').setDescription(desc).setRequired(true);
const reasonOpt = o => o.setName('reason').setDescription('Reason').setMaxLength(500);

const done = (i, text, c) =>
  i.reply({ embeds: [ok(`${text}${c ? ` | Case #${c.id}` : ''}`)] });

const deny = (i, text) => i.reply({ embeds: [fail(text)], flags: EPH });

// returns an error string or null
function checkTarget(i, member, verb) {
  if (!member) return 'That user is not in this server.';
  if (member.id === i.user.id) return `You can't ${verb} yourself.`;
  if (member.id === i.client.user.id) return `I can't ${verb} myself.`;
  const mine = i.member.roles.highest;
  if (i.guild.ownerId !== i.user.id && mine.comparePositionTo(member.roles.highest) <= 0) {
    return 'That member has the same or a higher role than you.';
  }
  return null;
}

const handlers = {
  async warn(i) {
    const member = i.options.getMember('user');
    const problem = checkTarget(i, member, 'warn');
    if (problem) return deny(i, problem);

    const reason = i.options.getString('reason') || 'No reason provided';
    const res = await addWarn(i.client, i.guild, member, i.user, reason);

    let text = `**${member.user.tag}** has been warned (${res.total} on record).`;
    if (res.escalation === 'mute') text += ' They were muted automatically.';
    if (res.escalation === 'kick') text += ' They were kicked automatically.';
    done(i, text, res.case);
  },

  async warnings(i) {
    const user = i.options.getUser('user');
    const all = data.cases.filter(c => c.userId === user.id);
    const warns = all.filter(c => c.type === 'warn' && !c.removed);

    const embed = new EmbedBuilder()
      .setColor(cfg.colors.warn)
      .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
      .setTitle('Warnings')
      .setFooter({ text: `${warns.length} active warning(s) • ${all.length} case(s) in total` });

    embed.setDescription(warns.length
      ? warns.slice(-10).reverse().map(c =>
          `**Case #${c.id}** • <t:${Math.floor(c.at / 1000)}:d> • by <@${c.modId}>\n> ${c.reason}`).join('\n\n')
      : 'No active warnings.');
    i.reply({ embeds: [embed] });
  },

  async case(i) {
    const c = data.cases.find(x => x.id === i.options.getInteger('id'));
    if (!c) return deny(i, 'Case not found.');
    const t = TYPES[c.type];
    const embed = new EmbedBuilder()
      .setColor(t.color)
      .setTitle(`Case #${c.id} • ${t.label}${c.removed ? ' (removed)' : ''}`)
      .addFields(
        { name: 'User', value: `<@${c.userId}> (${c.userId})`, inline: true },
        { name: 'Moderator', value: `<@${c.modId}>`, inline: true },
        { name: 'Date', value: `<t:${Math.floor(c.at / 1000)}:f>`, inline: true },
        { name: 'Reason', value: c.reason })
      .setTimestamp(c.at);
    if (c.duration) embed.addFields({ name: 'Duration', value: formatDuration(c.duration), inline: true });
    i.reply({ embeds: [embed] });
  },

  async delwarn(i) {
    const c = data.cases.find(x => x.id === i.options.getInteger('id') && x.type === 'warn');
    if (!c) return deny(i, 'No warning found with that case number.');
    c.removed = true;
    save();
    done(i, `Warning #${c.id} removed. <@${c.userId}> now has ${activeWarns(c.userId)} active warning(s).`);
  },

  async mute(i) {
    const member = i.options.getMember('user');
    const problem = checkTarget(i, member, 'mute');
    if (problem) return deny(i, problem);
    if (!member.moderatable) return deny(i, "I can't mute that member. Check my role position.");

    const duration = parseDuration(i.options.getString('duration'));
    if (!duration) return deny(i, 'Invalid duration. Examples: `30m`, `2h`, `1d`.');
    if (duration > MAX_TIMEOUT) return deny(i, 'The maximum mute length is 28 days.');

    const reason = i.options.getString('reason') || 'No reason provided';
    await notifyUser(member.user, i.guild, 'mute', reason, duration);
    await member.timeout(duration, reason);
    const c = await createCase(i.client, { type: 'mute', user: member.user, moderator: i.user, reason, duration });
    done(i, `**${member.user.tag}** was muted for ${formatDuration(duration)}.`, c);
  },

  async unmute(i) {
    const member = i.options.getMember('user');
    if (!member) return deny(i, 'That user is not in this server.');
    if (!member.isCommunicationDisabled()) return deny(i, 'That member is not muted.');
    await member.timeout(null);
    const c = await createCase(i.client, { type: 'unmute', user: member.user, moderator: i.user, reason: i.options.getString('reason') });
    done(i, `**${member.user.tag}** was unmuted.`, c);
  },

  async kick(i) {
    const member = i.options.getMember('user');
    const problem = checkTarget(i, member, 'kick');
    if (problem) return deny(i, problem);
    if (!member.kickable) return deny(i, "I can't kick that member. Check my role position.");

    const reason = i.options.getString('reason') || 'No reason provided';
    await notifyUser(member.user, i.guild, 'kick', reason);
    await member.kick(reason);
    const c = await createCase(i.client, { type: 'kick', user: member.user, moderator: i.user, reason });
    done(i, `**${member.user.tag}** was kicked.`, c);
  },

  async ban(i) {
    const user = i.options.getUser('user');
    const member = i.options.getMember('user');
    if (member) {
      const problem = checkTarget(i, member, 'ban');
      if (problem) return deny(i, problem);
      if (!member.bannable) return deny(i, "I can't ban that member. Check my role position.");
    } else if (user.id === i.user.id) {
      return deny(i, "You can't ban yourself.");
    }

    const reason = i.options.getString('reason') || 'No reason provided';
    const days = i.options.getInteger('delete_days') ?? 0;
    await notifyUser(user, i.guild, 'ban', reason);
    await i.guild.members.ban(user, { reason, deleteMessageSeconds: days * 86400 });
    const c = await createCase(i.client, { type: 'ban', user, moderator: i.user, reason });
    done(i, `**${user.tag}** was banned.`, c);
  },

  async unban(i) {
    const id = i.options.getString('user_id').trim();
    const ban = await i.guild.bans.fetch(id).catch(() => null);
    if (!ban) return deny(i, 'That user is not banned (or the ID is invalid).');
    await i.guild.members.unban(id, i.options.getString('reason') || undefined);
    const c = await createCase(i.client, { type: 'unban', user: ban.user, moderator: i.user, reason: i.options.getString('reason') });
    done(i, `**${ban.user.tag}** was unbanned.`, c);
  },

  async purge(i) {
    const amount = i.options.getInteger('amount');
    const target = i.options.getUser('user');
    await i.deferReply({ flags: EPH });

    let toDelete = amount;
    if (target) {
      const fetched = await i.channel.messages.fetch({ limit: 100 });
      toDelete = [...fetched.filter(m => m.author.id === target.id).values()].slice(0, amount);
    }
    const deleted = await i.channel.bulkDelete(toDelete, true);

    i.editReply({ embeds: [ok(`Deleted **${deleted.size}** message(s).`)] });
    modLog(i.client, new EmbedBuilder()
      .setColor(cfg.colors.main)
      .setTitle('Messages purged')
      .setDescription(`${i.user} deleted **${deleted.size}** message(s) in ${i.channel}${target ? ` from ${target}` : ''}.`)
      .setTimestamp());
  },

  async slowmode(i) {
    const seconds = i.options.getInteger('seconds');
    await i.channel.setRateLimitPerUser(seconds);
    done(i, seconds ? `Slowmode set to **${seconds}s**.` : 'Slowmode disabled.');
  },

  async lock(i) {
    await i.channel.permissionOverwrites.edit(i.guild.id, { SendMessages: false });
    i.reply({ embeds: [new EmbedBuilder().setColor(cfg.colors.err).setDescription('🔒 This channel has been locked.')] });
  },

  async unlock(i) {
    await i.channel.permissionOverwrites.edit(i.guild.id, { SendMessages: null });
    i.reply({ embeds: [new EmbedBuilder().setColor(cfg.colors.ok).setDescription('🔓 This channel has been unlocked.')] });
  },
};

const moderation = {
  commands: [
    new Cmd().setName('warn').setDescription('Warn a member')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => userOpt(o)).addStringOption(reasonOpt),
    new Cmd().setName('warnings').setDescription('Show a member\'s warnings')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => userOpt(o)),
    new Cmd().setName('case').setDescription('Look up a moderation case')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addIntegerOption(o => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1)),
    new Cmd().setName('delwarn').setDescription('Remove a warning by case number')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addIntegerOption(o => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1)),
    new Cmd().setName('mute').setDescription('Timeout a member')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => userOpt(o))
      .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 1d').setRequired(true))
      .addStringOption(reasonOpt),
    new Cmd().setName('unmute').setDescription('Remove a timeout')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(o => userOpt(o)).addStringOption(reasonOpt),
    new Cmd().setName('kick').setDescription('Kick a member')
      .setDefaultMemberPermissions(P.KickMembers)
      .addUserOption(o => userOpt(o)).addStringOption(reasonOpt),
    new Cmd().setName('ban').setDescription('Ban a user')
      .setDefaultMemberPermissions(P.BanMembers)
      .addUserOption(o => userOpt(o, 'The user'))
      .addStringOption(reasonOpt)
      .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7)),
    new Cmd().setName('unban').setDescription('Unban a user')
      .setDefaultMemberPermissions(P.BanMembers)
      .addStringOption(o => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
      .addStringOption(reasonOpt),
    new Cmd().setName('purge').setDescription('Bulk delete messages')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addIntegerOption(o => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user')),
    new Cmd().setName('slowmode').setDescription('Set the channel slowmode')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addIntegerOption(o => o.setName('seconds').setDescription('0 turns it off').setRequired(true).setMinValue(0).setMaxValue(21600)),
    new Cmd().setName('lock').setDescription('Lock this channel')
      .setDefaultMemberPermissions(P.ManageChannels),
    new Cmd().setName('unlock').setDescription('Unlock this channel')
      .setDefaultMemberPermissions(P.ManageChannels),
  ],

  onCommand: i => handlers[i.commandName](i),
};

// ======================================================
// Tickets
// ======================================================

const pad = n => String(n).padStart(4, '0');
const MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

const btn = (id, label, emoji, style, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);

const openRow = claimed => new ActionRowBuilder().addComponents(
  btn('tk:close', 'Close', '🔒', ButtonStyle.Danger),
  btn('tk:claim', claimed ? 'Claimed' : 'Claim', '🙋', ButtonStyle.Success, claimed));

const closedRow = () => new ActionRowBuilder().addComponents(
  btn('tk:transcript', 'Transcript', '📄', ButtonStyle.Secondary),
  btn('tk:reopen', 'Reopen', '🔓', ButtonStyle.Success),
  btn('tk:delete', 'Delete', '⛔', ButtonStyle.Danger));

// ---------- transcript ----------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function buildTranscript(channel, ticket) {
  const all = [];
  let before;
  for (let n = 0; n < 10; n++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  all.reverse();

  const rows = all.map(m => {
    const embeds = m.embeds.map(e => `<div class="embed"><b>${esc(e.title || '')}</b> ${esc(e.description || '')}</div>`).join('');
    const files = m.attachments.map(a => `<div><a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join('');
    return `<div class="msg"><img src="${esc(m.author.displayAvatarURL({ extension: 'png', size: 64 }))}">` +
      `<div><span class="name">${esc(m.author.tag)}</span><span class="time">${new Date(m.createdTimestamp).toUTCString()}</span>` +
      `<div>${esc(m.content).replace(/\n/g, '<br>')}</div>${embeds}${files}</div></div>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${pad(ticket.number)}</title>
<style>
body{background:#313338;color:#dbdee1;font-family:Arial,sans-serif;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#949ba4;margin-bottom:20px;font-size:13px}
.msg{display:flex;gap:12px;margin-bottom:14px}.msg img{width:40px;height:40px;border-radius:50%}
.name{font-weight:bold;color:#fff;margin-right:8px}.time{color:#949ba4;font-size:11px}
.embed{border-left:4px solid #5865f2;background:#2b2d31;padding:6px 10px;margin-top:4px;border-radius:4px}
a{color:#00a8fc}
</style></head><body>
<h1>Ticket #${pad(ticket.number)}</h1>
<div class="sub">Opened by ${esc(ticket.userId)} • ${new Date(ticket.createdAt).toUTCString()} • ${all.length} messages</div>
${rows}
</body></html>`;

  return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${pad(ticket.number)}.html` });
}

const cloneFile = f => new AttachmentBuilder(f.attachment, { name: f.name });

// ---------- actions ----------
async function createTicket(i) {
  await i.deferReply({ flags: EPH });

  const owned = Object.values(data.tickets).filter(t => t.userId === i.user.id).length;
  if (owned >= cfg.tickets.maxOpen) {
    return i.editReply({ embeds: [fail(`You already have ${owned} open ticket(s). Close one before opening another.`)] });
  }

  const subject = i.fields.getTextInputValue('subject');
  const details = i.fields.getTextInputValue('details');

  data.ticketCount += 1;
  const number = data.ticketCount;

  const overwrites = [
    { id: i.guild.id, deny: [P.ViewChannel] },
    { id: i.user.id, allow: MEMBER_PERMS },
    { id: i.client.user.id, allow: [...MEMBER_PERMS, P.ManageChannels] },
  ];
  if (cfg.roles.staff) overwrites.push({ id: cfg.roles.staff, allow: MEMBER_PERMS });

  const channel = await i.guild.channels.create({
    name: `ticket-${pad(number)}`,
    type: ChannelType.GuildText,
    parent: cfg.ticketCategory || null,
    topic: `Ticket #${pad(number)} • opened by ${i.user.tag} • ${subject}`.slice(0, 1000),
    permissionOverwrites: overwrites,
  });

  data.tickets[channel.id] = {
    number, userId: i.user.id, subject, status: 'open',
    claimedBy: null, createdAt: Date.now(),
  };
  save();

  const embed = new EmbedBuilder()
    .setColor(cfg.colors.main)
    .setAuthor({ name: i.user.tag, iconURL: i.user.displayAvatarURL() })
    .setTitle(subject)
    .setDescription(details)
    .addFields({ name: '\u200b', value: 'Support will be with you shortly.\nTo close this ticket, press the button below.' })
    .setFooter({ text: `Ticket #${pad(number)}` })
    .setTimestamp();

  await channel.send({
    content: `${i.user}${cfg.roles.staff ? ` <@&${cfg.roles.staff}>` : ''}`,
    embeds: [embed],
    components: [openRow(false)],
  });

  i.editReply({ embeds: [ok(`Your ticket has been created: ${channel}`)] });
  ticketLog(i.client, new EmbedBuilder()
    .setColor(cfg.colors.ok)
    .setTitle(`Ticket #${pad(number)} opened`)
    .addFields(
      { name: 'Opened by', value: `${i.user}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Subject', value: subject })
    .setTimestamp());
}

async function closeTicket(channel, closer, reason) {
  const t = data.tickets[channel.id];
  t.status = 'closed';
  t.closedBy = closer.id;
  save();

  await channel.permissionOverwrites.edit(t.userId, { ViewChannel: false }).catch(() => {});
  await channel.setName(`closed-${pad(t.number)}`).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(cfg.colors.err)
    .setDescription(`🔒 Ticket closed by ${closer}`)
    .setTimestamp();
  if (reason) embed.addFields({ name: 'Reason', value: reason });
  await channel.send({ embeds: [embed], components: [closedRow()] });
}

async function reopenTicket(channel, user) {
  const t = data.tickets[channel.id];
  t.status = 'open';
  save();
  await channel.permissionOverwrites.edit(t.userId, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
  }).catch(() => {});
  await channel.setName(`ticket-${pad(t.number)}`).catch(() => {});
  await channel.send({
    content: `<@${t.userId}>`,
    embeds: [new EmbedBuilder().setColor(cfg.colors.ok).setDescription(`🔓 Ticket reopened by ${user}`)],
  });
}

async function deleteTicket(client, channel, user) {
  const t = data.tickets[channel.id];
  const file = await buildTranscript(channel, t);

  await ticketLog(client, new EmbedBuilder()
    .setColor(cfg.colors.err)
    .setTitle(`Ticket #${pad(t.number)} deleted`)
    .addFields(
      { name: 'Opened by', value: `<@${t.userId}>`, inline: true },
      { name: 'Closed by', value: `<@${t.closedBy || user.id}>`, inline: true },
      { name: 'Claimed by', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody', inline: true },
      { name: 'Opened', value: `<t:${unix(t.createdAt)}:f>`, inline: true },
      { name: 'Subject', value: t.subject || 'None' })
    .setTimestamp(), [cloneFile(file)]);

  const opener = await client.users.fetch(t.userId).catch(() => null);
  opener?.send({
    embeds: [new EmbedBuilder().setColor(cfg.colors.main)
      .setTitle('Your ticket was closed')
      .setDescription(`Here's the transcript for ticket **#${pad(t.number)}**.`)],
    files: [cloneFile(file)],
  }).catch(() => {});

  await channel.send({ embeds: [new EmbedBuilder().setColor(cfg.colors.err).setDescription('⛔ This ticket will be deleted in 5 seconds.')] });
  delete data.tickets[channel.id];
  save();
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ---------- slash command ----------
const ticketsCommand = new SlashCommandBuilder()
  .setName('ticket').setDescription('Ticket system')
  .addSubcommand(s => s.setName('panel').setDescription('Post the ticket panel (admins)')
    .addStringOption(o => o.setName('title').setDescription('Panel title'))
    .addStringOption(o => o.setName('description').setDescription('Panel description'))
    .addStringOption(o => o.setName('button').setDescription('Button label')))
  .addSubcommand(s => s.setName('close').setDescription('Close this ticket')
    .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(300)))
  .addSubcommand(s => s.setName('claim').setDescription('Claim this ticket'))
  .addSubcommand(s => s.setName('add').setDescription('Add a user to this ticket')
    .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a user from this ticket')
    .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)))
  .addSubcommand(s => s.setName('rename').setDescription('Rename this ticket')
    .addStringOption(o => o.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(60)));

const tickets = {
  commands: [ticketsCommand],

  async onCommand(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'panel') {
      if (!i.memberPermissions.has(P.Administrator)) {
        return i.reply({ embeds: [fail('Only administrators can post the panel.')], flags: EPH });
      }
      const embed = new EmbedBuilder()
        .setColor(cfg.colors.main)
        .setTitle(i.options.getString('title') || 'Support Tickets')
        .setDescription(i.options.getString('description') ||
          'Need help or have a question?\nPress the button below to open a private ticket and our team will get back to you.')
        .setFooter({ text: i.guild.name, iconURL: i.guild.iconURL() });
      const row = new ActionRowBuilder().addComponents(
        btn('tk:create', i.options.getString('button') || 'Create Ticket', '🎫', ButtonStyle.Primary));
      await i.channel.send({ embeds: [embed], components: [row] });
      return i.reply({ embeds: [ok('Ticket panel posted.')], flags: EPH });
    }

    const ticket = data.tickets[i.channelId];
    if (!ticket) return i.reply({ embeds: [fail('This command only works inside a ticket.')], flags: EPH });

    const staff = isStaff(i.member);
    if (sub === 'close') {
      if (!staff && i.user.id !== ticket.userId) return i.reply({ embeds: [fail('You cannot close this ticket.')], flags: EPH });
      if (ticket.status === 'closed') return i.reply({ embeds: [fail('This ticket is already closed.')], flags: EPH });
      await i.reply({ embeds: [ok('Closing ticket...')], flags: EPH });
      return closeTicket(i.channel, i.user, i.options.getString('reason'));
    }

    if (!staff) return i.reply({ embeds: [fail('Only staff can do that.')], flags: EPH });

    if (sub === 'claim') {
      if (ticket.claimedBy) return i.reply({ embeds: [fail(`Already claimed by <@${ticket.claimedBy}>.`)], flags: EPH });
      ticket.claimedBy = i.user.id;
      save();
      return i.reply({ embeds: [new EmbedBuilder().setColor(cfg.colors.ok).setDescription(`🙋 ${i.user} has claimed this ticket.`)] });
    }
    if (sub === 'add') {
      const user = i.options.getUser('user');
      await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return i.reply({ embeds: [ok(`Added ${user} to the ticket.`)] });
    }
    if (sub === 'remove') {
      const user = i.options.getUser('user');
      if (user.id === ticket.userId) return i.reply({ embeds: [fail('You cannot remove the ticket owner.')], flags: EPH });
      await i.channel.permissionOverwrites.delete(user.id);
      return i.reply({ embeds: [ok(`Removed ${user} from the ticket.`)] });
    }
    if (sub === 'rename') {
      await i.channel.setName(i.options.getString('name'));
      return i.reply({ embeds: [ok('Ticket renamed.')], flags: EPH });
    }
  },

  async onComponent(i) {
    if (i.isModalSubmit() && i.customId === 'tk:modal') {
      await createTicket(i);
      return true;
    }
    if (!i.isButton() || !i.customId.startsWith('tk:')) return false;

    const action = i.customId.slice(3);

    if (action === 'create') {
      const modal = new ModalBuilder().setCustomId('tk:modal').setTitle('Open a ticket').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short)
          .setPlaceholder('What do you need help with?').setMaxLength(100).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('details').setLabel('Details').setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Tell us more so we can help you faster.').setMaxLength(1000).setRequired(true)));
      await i.showModal(modal);
      return true;
    }

    const ticket = data.tickets[i.channelId];
    if (!ticket) {
      await i.reply({ embeds: [fail('This is not a ticket channel.')], flags: EPH });
      return true;
    }
    const staff = isStaff(i.member);
    const isOwner = i.user.id === ticket.userId;

    switch (action) {
      case 'close': {
        if (!staff && !isOwner) { await i.reply({ embeds: [fail('You cannot close this ticket.')], flags: EPH }); break; }
        const row = new ActionRowBuilder().addComponents(
          btn('tk:confirm', 'Close', '🔒', ButtonStyle.Danger),
          btn('tk:cancel', 'Cancel', '✖️', ButtonStyle.Secondary));
        await i.reply({
          embeds: [new EmbedBuilder().setColor(cfg.colors.warn).setDescription('Are you sure you want to close this ticket?')],
          components: [row],
        });
        break;
      }
      case 'confirm': {
        if (!staff && !isOwner) { await i.reply({ embeds: [fail('You cannot close this ticket.')], flags: EPH }); break; }
        await i.deferUpdate();
        await i.message.delete().catch(() => {});
        if (ticket.status !== 'closed') await closeTicket(i.channel, i.user);
        break;
      }
      case 'cancel': {
        await i.deferUpdate();
        await i.message.delete().catch(() => {});
        break;
      }
      case 'claim': {
        if (!staff) { await i.reply({ embeds: [fail('Only staff can claim tickets.')], flags: EPH }); break; }
        ticket.claimedBy = i.user.id;
        save();
        await i.update({ components: [openRow(true)] });
        await i.channel.send({ embeds: [new EmbedBuilder().setColor(cfg.colors.ok).setDescription(`🙋 ${i.user} has claimed this ticket and will be assisting you.`)] });
        break;
      }
      case 'transcript': {
        if (!staff) { await i.reply({ embeds: [fail('Only staff can do that.')], flags: EPH }); break; }
        await i.deferReply({ flags: EPH });
        await i.editReply({ files: [await buildTranscript(i.channel, ticket)] });
        break;
      }
      case 'reopen': {
        if (!staff) { await i.reply({ embeds: [fail('Only staff can do that.')], flags: EPH }); break; }
        await i.deferUpdate();
        await i.message.edit({ components: [] }).catch(() => {});
        await reopenTicket(i.channel, i.user);
        break;
      }
      case 'delete': {
        if (!staff) { await i.reply({ embeds: [fail('Only staff can do that.')], flags: EPH }); break; }
        await i.deferUpdate();
        await i.message.edit({ components: [] }).catch(() => {});
        await deleteTicket(i.client, i.channel, i.user);
        break;
      }
      default:
        return false;
    }
    return true;
  },

  init(client) {
    // channel removed by hand -> forget the ticket
    client.on(Events.ChannelDelete, ch => {
      if (data.tickets[ch.id]) {
        delete data.tickets[ch.id];
        save();
      }
    });
  },
};

// ======================================================
// Verification (reaction)
// ======================================================

const EMOJI = '✅';

function buildRulesEmbed() {
  const body = cfg.rules.items
    .map((r, n) => `#${n + 1} ${r.title} ➜ ${r.emoji}\n${r.text}`)
    .join('\n\n');
  return new EmbedBuilder()
    .setColor(cfg.colors.dark)
    .setTitle(cfg.rules.title)
    .setDescription('```\n' + body + '\n```');
}

const verify = {
  commands: [
    new SlashCommandBuilder()
      .setName('verifypanel')
      .setDescription('Post the verification message')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('rulespanel')
      .setDescription('Post the server rules')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addBooleanOption(o => o.setName('verify').setDescription('Verify members who react with ✅ (default: yes)')),
  ],

  async onCommand(i) {
    if (i.commandName === 'rulespanel') {
      const withVerify = i.options.getBoolean('verify') ?? true;
      if (withVerify && !cfg.roles.verified) {
        return i.reply({ embeds: [fail('Set VERIFIED_ROLE_ID in your .env first, or run this with verify: false.')], flags: EPH });
      }
      const msg = await i.channel.send({ embeds: [buildRulesEmbed()] });
      if (withVerify) {
        await msg.react(EMOJI);
        // keep: leave members' reactions in place so the counter shows how many verified
        data.verify = { messageId: msg.id, channelId: msg.channelId, keep: true };
        save();
      }
      return i.reply({ embeds: [ok('Rules posted.')], flags: EPH });
    }

    if (!cfg.roles.verified) {
      return i.reply({ embeds: [fail('Set VERIFIED_ROLE_ID in your .env first.')], flags: EPH });
    }

    const embed = new EmbedBuilder()
      .setColor(cfg.colors.ok)
      .setTitle('Verification')
      .setDescription(
        `React with ${EMOJI} below to get access to the rest of the server.\n\n` +
        'By verifying you agree to follow the server rules.')
      .setFooter({ text: i.guild.name, iconURL: i.guild.iconURL() });

    const msg = await i.channel.send({ embeds: [embed] });
    await msg.react(EMOJI);

    data.verify = { messageId: msg.id, channelId: msg.channelId, keep: false };
    save();
    i.reply({ embeds: [ok('Verification message posted.')], flags: EPH });
  },

  init(client) {
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch().catch(() => {});
      if (!data.verify || reaction.message.id !== data.verify.messageId) return;
      if (reaction.emoji.name !== EMOJI) return;

      const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      await member.roles.add(cfg.roles.verified).catch(console.error);
      if (!data.verify.keep) reaction.users.remove(user.id).catch(() => {});

      user.send({ embeds: [ok(`You're verified in **${reaction.message.guild.name}**. Welcome!`)] }).catch(() => {});
      log(client, new EmbedBuilder()
        .setColor(cfg.colors.ok).setTitle('Member verified').setDescription(`${member} (${member.id})`).setTimestamp());
    });
  },
};

// ======================================================
// /register
// ======================================================

// Special roles (REGISTER_ROLE_*_ID in .env) can run /register once and get a
// personal key in DMs. If the key ever shows up in a server channel it gets revoked.

const registerCommand = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Get your personal key (special roles only)');

const keysCommand = new SlashCommandBuilder()
  .setName('keys')
  .setDescription('Show key usage')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const mask = key => key.length > 6 ? `${key.slice(0, 3)}...${key.slice(-3)}` : '***';

const register = {
  commands: [registerCommand, keysCommand],

  async onCommand(i) {
    if (i.commandName === 'keys') {
      const entries = Object.entries(data.registered);
      const revoked = entries.filter(([, r]) => r.revoked).length;
      const lines = cfg.keys.map(key => {
        const hit = entries.find(([, r]) => r.key === key);
        if (!hit) return `\`${key}\` - free`;
        return `\`${key}\` - <@${hit[0]}>${hit[1].revoked ? ' (revoked)' : ''}`;
      });
      const embed = new EmbedBuilder()
        .setColor(cfg.colors.main)
        .setTitle('Registration keys')
        .setDescription(lines.join('\n') || 'No keys configured.')
        .setFooter({ text: `${entries.length}/${cfg.keys.length} claimed • ${revoked} revoked` });
      return i.reply({ embeds: [embed], flags: EPH });
    }

    // special role check
    const allowed = cfg.registerRoles.map(r => r.id);
    if (!allowed.length) {
      return i.reply({ embeds: [fail('No special roles are configured yet.')], flags: EPH });
    }
    if (!allowed.some(id => i.member.roles.cache.has(id))) {
      return i.reply({ embeds: [fail('Only members with a special role can use this command.')], flags: EPH });
    }

    if (data.registered[i.user.id]) {
      return i.reply({ embeds: [fail('You have already registered. Your key was sent to you before and cannot be sent again.')], flags: EPH });
    }

    const taken = new Set(Object.values(data.registered).map(r => r.key));
    const key = cfg.keys.find(k => !taken.has(k));
    if (!key) {
      return i.reply({ embeds: [fail('All keys have been claimed.')], flags: EPH });
    }

    // reserve it right away so a double click can't hand out the same key twice
    data.registered[i.user.id] = { key, at: Date.now(), revoked: false };
    await i.deferReply({ flags: EPH });

    const dm = new EmbedBuilder()
      .setColor(cfg.colors.main)
      .setTitle('Your registration key')
      .setDescription(
        `Here is your personal key:\n\`\`\`${key}\`\`\`\n` +
        'This key is **only for you**. If it gets shared, it will be revoked and you will not get a new one.')
      .setFooter({ text: i.guild.name })
      .setTimestamp();

    try {
      await i.user.send({ embeds: [dm] });
    } catch {
      delete data.registered[i.user.id]; // nothing was delivered, give the key back
      return i.editReply({ embeds: [fail('I could not DM you. Enable direct messages from server members and run `/register` again.')] });
    }

    save();
    i.editReply({ embeds: [ok('Your key has been sent to your DMs.')] });
    log(i.client, new EmbedBuilder()
      .setColor(cfg.colors.main)
      .setTitle('Key issued')
      .setDescription(`${i.user} received key \`${mask(key)}\` (${Object.keys(data.registered).length}/${cfg.keys.length})`)
      .setTimestamp());
  },

  init(client) {
    // a key posted in any server channel counts as shared
    client.on(Events.MessageCreate, async msg => {
      if (!msg.guild || msg.author.bot || !msg.content) return;
      const text = msg.content.toLowerCase();

      for (const [userId, entry] of Object.entries(data.registered)) {
        if (entry.revoked || !text.includes(entry.key.toLowerCase())) continue;

        entry.revoked = true;
        save();
        await msg.delete().catch(() => {});

        const owner = await client.users.fetch(userId).catch(() => null);
        owner?.send({
          embeds: [new EmbedBuilder()
            .setColor(cfg.colors.err)
            .setTitle('Key revoked')
            .setDescription('Your key was posted in the server, so it has been revoked.')],
        }).catch(() => {});

        log(client, new EmbedBuilder()
          .setColor(cfg.colors.err)
          .setTitle('Key revoked')
          .setDescription(`Key \`${mask(entry.key)}\` of <@${userId}> was posted in ${msg.channel} by ${msg.author}.`)
          .setTimestamp());
      }
    });
  },
};

// ======================================================
// Giveaways
// ======================================================

const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const link = g => `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
const mentions = ids => ids.map(id => `<@${id}>`).join(', ');

function pick(pool, count) {
  const copy = [...pool];
  const out = [];
  while (out.length < count && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function buildEmbed(g) {
  const lines = [
    g.ended ? `Ended: ${ts(g.endsAt)}` : `Ends: ${ts(g.endsAt)} (${ts(g.endsAt, 'f')})`,
    `Hosted by: <@${g.host}>`,
    `Entries: **${g.entries.length}**`,
    g.ended
      ? `Winners: ${g.winnerIds.length ? mentions(g.winnerIds) : 'No valid entrants'}`
      : `Winners: **${g.winners}**`,
  ];
  if (g.requiredRole) lines.push(`Required role: <@&${g.requiredRole}>`);

  return new EmbedBuilder()
    .setColor(g.ended ? cfg.colors.dark : cfg.colors.main)
    .setTitle(g.prize)
    .setDescription(lines.join('\n'))
    .setFooter({ text: g.ended ? 'Ended at' : `${g.winners} winner${g.winners > 1 ? 's' : ''} • Ends at` })
    .setTimestamp(g.endsAt);
}

const buildRow = g => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('gw:enter').setLabel('Enter').setEmoji('🎉')
    .setStyle(ButtonStyle.Primary).setDisabled(g.ended));

async function getMessage(client, g) {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  const msg = ch && await ch.messages.fetch(g.messageId).catch(() => null);
  return { ch, msg };
}

async function announce(client, g, text) {
  const { ch, msg } = await getMessage(client, g);
  if (!ch) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Giveaway').setStyle(ButtonStyle.Link).setURL(link(g)));
  const payload = { content: text, components: [row] };
  if (msg) msg.reply(payload).catch(() => ch.send(payload));
  else ch.send(payload);
}

async function finish(client, g) {
  g.ended = true;
  g.winnerIds = pick(g.entries, g.winners);
  save();

  const { msg } = await getMessage(client, g);
  if (msg) {
    await msg.edit({ content: '🎊 **GIVEAWAY ENDED** 🎊', embeds: [buildEmbed(g)], components: [buildRow(g)] }).catch(() => {});
  }
  await announce(client, g, g.winnerIds.length
    ? `🎉 Congratulations ${mentions(g.winnerIds)}! You won **${g.prize}**!`
    : `Nobody entered **${g.prize}**, so there is no winner this time.`);
}

const giveawayCommand = new SlashCommandBuilder()
  .setName('giveaway').setDescription('Manage giveaways')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 1d, 1w').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
    .addRoleOption(o => o.setName('required_role').setDescription('Role needed to enter'))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: here)')))
  .addSubcommand(s => s.setName('end').setDescription('End a giveaway now')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
  .addSubcommand(s => s.setName('reroll').setDescription('Pick new winner(s)')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
    .addIntegerOption(o => o.setName('count').setDescription('How many to pick (default 1)').setMinValue(1).setMaxValue(20)))
  .addSubcommand(s => s.setName('cancel').setDescription('Cancel and delete a giveaway')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('Show running giveaways'));

const giveaway = {
  commands: [giveawayCommand],

  async onCommand(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'start') {
      const ms = parseDuration(i.options.getString('duration'));
      if (!ms) return i.reply({ embeds: [fail('Invalid duration. Examples: `30m`, `2h`, `1d`.')], flags: EPH });

      const channel = i.options.getChannel('channel') || i.channel;
      if (!channel.isTextBased()) return i.reply({ embeds: [fail('Pick a text channel.')], flags: EPH });

      const g = {
        prize: i.options.getString('prize'),
        winners: i.options.getInteger('winners') || 1,
        requiredRole: i.options.getRole('required_role')?.id || null,
        host: i.user.id,
        endsAt: Date.now() + ms,
        entries: [], ended: false, winnerIds: [],
        guildId: i.guildId, channelId: channel.id,
      };

      const msg = await channel.send({ content: '🎉 **GIVEAWAY** 🎉', embeds: [buildEmbed(g)], components: [buildRow(g)] });
      g.messageId = msg.id;
      data.giveaways[msg.id] = g;
      save();
      return i.reply({ embeds: [ok(`Giveaway started in ${channel}.`)], flags: EPH });
    }

    if (sub === 'list') {
      const running = Object.values(data.giveaways).filter(g => !g.ended && g.guildId === i.guildId);
      const embed = new EmbedBuilder().setColor(cfg.colors.main).setTitle('Running giveaways')
        .setDescription(running.length
          ? running.map(g => `**${g.prize}**\nEnds ${ts(g.endsAt)} • ${g.entries.length} entries • [Jump](${link(g)})\nID: \`${g.messageId}\``).join('\n\n')
          : 'There are no running giveaways.');
      return i.reply({ embeds: [embed], flags: EPH });
    }

    const g = data.giveaways[i.options.getString('message_id').trim()];
    if (!g) return i.reply({ embeds: [fail('Giveaway not found. Use `/giveaway list` to see IDs.')], flags: EPH });

    if (sub === 'end') {
      if (g.ended) return i.reply({ embeds: [fail('That giveaway already ended.')], flags: EPH });
      await finish(i.client, g);
      return i.reply({ embeds: [ok('Giveaway ended.')], flags: EPH });
    }

    if (sub === 'cancel') {
      const { msg } = await getMessage(i.client, g);
      await msg?.delete().catch(() => {});
      delete data.giveaways[g.messageId];
      save();
      return i.reply({ embeds: [ok('Giveaway cancelled.')], flags: EPH });
    }

    if (sub === 'reroll') {
      if (!g.ended) return i.reply({ embeds: [fail('That giveaway is still running.')], flags: EPH });
      const pool = g.entries.filter(id => !g.winnerIds.includes(id));
      const fresh = pick(pool, i.options.getInteger('count') || 1);
      if (!fresh.length) return i.reply({ embeds: [fail('There is nobody left to pick.')], flags: EPH });
      g.winnerIds.push(...fresh);
      save();
      await i.reply({ embeds: [ok('Rerolled.')], flags: EPH });
      return announce(i.client, g, `🎉 New winner${fresh.length > 1 ? 's' : ''}: ${mentions(fresh)}! You won **${g.prize}**!`);
    }
  },

  async onComponent(i) {
    if (!i.isButton()) return false;

    if (i.customId === 'gw:enter') {
      const g = data.giveaways[i.message.id];
      if (!g || g.ended) {
        await i.reply({ embeds: [fail('This giveaway has already ended.')], flags: EPH });
        return true;
      }
      if (g.requiredRole && !i.member.roles.cache.has(g.requiredRole)) {
        await i.reply({ embeds: [fail(`You need the <@&${g.requiredRole}> role to enter.`)], flags: EPH });
        return true;
      }
      if (g.entries.includes(i.user.id)) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gw:leave:${g.messageId}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger));
        await i.reply({
          embeds: [new EmbedBuilder().setColor(cfg.colors.warn).setDescription('You are already entered in this giveaway.')],
          components: [row], flags: EPH,
        });
        return true;
      }
      g.entries.push(i.user.id);
      save();
      await i.update({ embeds: [buildEmbed(g)] });
      await i.followUp({ embeds: [ok('You have entered the giveaway. Good luck!')], flags: EPH });
      return true;
    }

    if (i.customId.startsWith('gw:leave:')) {
      const g = data.giveaways[i.customId.split(':')[2]];
      if (!g || g.ended) {
        await i.update({ embeds: [fail('This giveaway has already ended.')], components: [] });
        return true;
      }
      g.entries = g.entries.filter(id => id !== i.user.id);
      save();
      await i.update({ embeds: [ok('You left the giveaway.')], components: [] });
      const { msg } = await getMessage(i.client, g);
      msg?.edit({ embeds: [buildEmbed(g)] }).catch(() => {});
      return true;
    }

    return false;
  },

  init(client) {
    // check for expired giveaways every 10 seconds
    setInterval(() => {
      Object.values(data.giveaways)
        .filter(g => !g.ended && g.endsAt <= Date.now())
        .forEach(g => finish(client, g).catch(console.error));
    }, 10000);
  },
};

// ======================================================
// Price list
// ======================================================

// Items come from cfg.priceList.items. Want live data instead? Change getItems().
async function getItems() {
  return cfg.priceList.items;
}

function buildPriceEmbed(items) {
  const text = items
    .map(p => `${p.emoji || '🟢'} **${p.name}**\n└ Price: **${p.price}**`)
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(cfg.priceList.color)
    .setTitle(cfg.priceList.title)
    .setDescription(text)
    .setFooter({ text: `${cfg.priceList.footer} • updated` })
    .setTimestamp();
  if (cfg.priceList.image) embed.setImage(cfg.priceList.image);
  return embed;
}

async function updatePrices(client) {
  try {
    const items = await getItems();
    if (!items.length) return;

    const embed = buildPriceEmbed(items);
    const channel = await client.channels.fetch(cfg.channels.prices);
    const old = data.prices?.messageId && await channel.messages.fetch(data.prices.messageId).catch(() => null);

    if (old) {
      await old.edit({ embeds: [embed] });
    } else {
      const msg = await channel.send({ embeds: [embed] });
      data.prices = { messageId: msg.id };
      save();
    }
  } catch (err) {
    console.error('Price update failed:', err.message);
  }
}

const prices = {
  init(client) {
    if (!cfg.channels.prices) return;
    updatePrices(client);
    setInterval(() => updatePrices(client), cfg.prices.intervalMin * 60 * 1000);
  },
};

// ======================================================
// Client + interaction router
// ======================================================

const modules = [welcome, roles, automod, moderation, tickets, verify, register, giveaway, prices];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);

  const rest = new REST().setToken(cfg.token);
  const body = modules.flatMap(m => m.commands || []).map(cmd => cmd.toJSON());
  await rest.put(Routes.applicationGuildCommands(c.user.id, cfg.guildId), { body });
  console.log(`Registered ${body.length} commands`);

  modules.forEach(m => m.init?.(client));
});

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) {
      const mod = modules.find(m => m.commands?.some(c => c.name === i.commandName));
      return await mod?.onCommand(i);
    }
    for (const m of modules) {
      if (m.onComponent && (await m.onComponent(i))) return;
    }
  } catch (err) {
    console.error(err);
    const msg = { embeds: [fail('Something went wrong, please try again.')], flags: EPH };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', err => console.error(err));

client.login(cfg.token);
