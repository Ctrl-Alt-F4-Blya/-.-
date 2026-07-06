"use strict";

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

app.set("trust proxy", 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Слишком много заявок. Попробуйте повторить через 10 минут." }
});

const contactConfigPath = path.join(__dirname, "data", "contact-info.txt");

function loadContactConfig() {
  const defaults = {
    phone: "+7 (999) 123-45-67",
    email: "info@newdom.ru",
    workingHours: "Ежедневно, 09:00–21:00 МСК",
    telegram: "",
    address: "Новосибирск · работаем дистанционно и на объектах"
  };

  try {
    const raw = fs.readFileSync(contactConfigPath, "utf8");
    const rows = raw.split(/\r?\n/);
    const data = { ...defaults };

    rows.forEach((row) => {
      const line = row.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) return;
      const [key, ...rest] = line.split("=");
      const value = rest.join("=").trim();
      if (!value) return;

      const map = {
        PHONE: "phone",
        EMAIL: "email",
        WORKING_HOURS: "workingHours",
        TELEGRAM: "telegram",
        ADDRESS: "address"
      };

      if (map[key.trim()]) data[map[key.trim()]] = value;
    });

    data.phoneHref = data.phone.replace(/[^+\d]/g, "");
    return data;
  } catch (_) {
    return { ...defaults, phoneHref: defaults.phone.replace(/[^+\d]/g, "") };
  }
}

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const leadsFile = path.join(dataDir, "leads.json");

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(leadsFile)) fs.writeFileSync(leadsFile, "[]", "utf8");

app.use(express.json({ limit: "200kb" }));
app.get("/api/site-config", (_req, res) => res.json(loadContactConfig()));
app.get("/downloads/contact-info.txt", (_req, res) => res.download(contactConfigPath, "contact-info.txt"));
app.use(express.static(publicDir, { extensions: ["html"] }));

const clean = (value, max = 500) => String(value || "").trim().replace(/[<>]/g, "").slice(0, max);
const requiredFields = ["name", "phone", "email", "preferredDate", "preferredTime"];

const getLeads = () => {
  try { return JSON.parse(fs.readFileSync(leadsFile, "utf8")); }
  catch { return []; }
};
const saveLeads = (leads) => fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2), "utf8");
const findLead = (id) => getLeads().find((lead) => lead.id === id);
const updateLead = (id, patch) => {
  const leads = getLeads();
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;
  leads[index] = { ...leads[index], ...patch, updatedAt: new Date().toISOString() };
  saveLeads(leads);
  return leads[index];
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = token ? new TelegramBot(token, { polling: true }) : null;
const waitingForNewTime = new Map();

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

// -----------------------------------------------------------------------------
// Google Calendar integration
// -----------------------------------------------------------------------------
// Работает без дополнительных npm-зависимостей: Node.js сам подписывает JWT
// сервисного аккаунта и ходит в Google Calendar REST API.
// -----------------------------------------------------------------------------

const calendarTokenCache = { accessToken: "", expiresAt: 0 };

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return {
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key
      };
    } catch (error) {
      console.error("GOOGLE_SERVICE_ACCOUNT_JSON parse error:", error.message);
    }
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    try {
      const file = path.resolve(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key
      };
    } catch (error) {
      console.error("GOOGLE_SERVICE_ACCOUNT_KEY_FILE error:", error.message);
    }
  }

  const clientEmail = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL;
  const rawPrivateKey = process.env.GOOGLE_CALENDAR_PRIVATE_KEY_BASE64
    ? Buffer.from(process.env.GOOGLE_CALENDAR_PRIVATE_KEY_BASE64, "base64").toString("utf8")
    : process.env.GOOGLE_CALENDAR_PRIVATE_KEY;

  const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, "\n") : "";

  return { clientEmail, privateKey };
}

function getCalendarConfig() {
  const { clientEmail, privateKey } = getServiceAccountCredentials();

  return {
    enabled: String(process.env.GOOGLE_CALENDAR_ENABLED || "true") !== "false",
    calendarId: process.env.GOOGLE_CALENDAR_ID || "",
    clientEmail,
    privateKey,
    timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Europe/Moscow",
    timezoneOffset: process.env.GOOGLE_CALENDAR_TIMEZONE_OFFSET || "+03:00",
    durationMinutes: Math.max(15, Number(process.env.LEAD_MEETING_DURATION_MINUTES || 30)),
    autoBook: String(process.env.LEAD_AUTO_BOOK || "true") !== "false"
  };
}

function isCalendarConfigured() {
  const cfg = getCalendarConfig();
  return Boolean(cfg.enabled && cfg.calendarId && cfg.clientEmail && cfg.privateKey);
}

async function getGoogleAccessToken() {
  const cfg = getCalendarConfig();
  const now = Math.floor(Date.now() / 1000);

  if (calendarTokenCache.accessToken && calendarTokenCache.expiresAt - 60 > now) {
    return calendarTokenCache.accessToken;
  }

  if (!cfg.clientEmail || !cfg.privateKey) {
    throw new Error("Google Calendar credentials are not configured.");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: cfg.clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(cfg.privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google OAuth token error.");
  }

  calendarTokenCache.accessToken = data.access_token;
  calendarTokenCache.expiresAt = now + Number(data.expires_in || 3600);
  return calendarTokenCache.accessToken;
}

function buildDateRange(date, time) {
  const cfg = getCalendarConfig();
  const safeDate = String(date || "").trim();
  const safeTime = String(time || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate) || !/^\d{2}:\d{2}$/.test(safeTime)) {
    throw new Error("Invalid date/time format.");
  }

  const start = new Date(`${safeDate}T${safeTime}:00${cfg.timezoneOffset}`);
  const end = new Date(start.getTime() + cfg.durationMinutes * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date/time value.");
  }

  return {
    start,
    end,
    timeMin: start.toISOString(),
    timeMax: end.toISOString()
  };
}

async function googleCalendarFetch(endpoint, options = {}) {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(`https://www.googleapis.com/calendar/v3${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || `Google Calendar API error ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function checkCalendarAvailability(lead) {
  const cfg = getCalendarConfig();

  if (!isCalendarConfigured()) {
    return {
      configured: false,
      available: null,
      message: "Google Calendar не настроен. Заявка отправлена в Telegram без автоматической брони."
    };
  }

  const range = buildDateRange(lead.preferredDate, lead.preferredTime);

  const data = await googleCalendarFetch("/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: cfg.timeZone,
      items: [{ id: cfg.calendarId }]
    })
  });

  const busy = data?.calendars?.[cfg.calendarId]?.busy || [];

  return {
    configured: true,
    available: busy.length === 0,
    range,
    busy,
    message: busy.length === 0
      ? "Время свободно."
      : "На выбранное время уже есть событие в календаре."
  };
}

async function createCalendarEvent(lead, range) {
  const cfg = getCalendarConfig();

  const event = {
    summary: `НовоДом · созвон: ${lead.name}`,
    description: [
      "Заявка с сайта «Новый дом»",
      "",
      `ID заявки: ${lead.id}`,
      `Имя: ${lead.name}`,
      `Телефон: ${lead.phone}`,
      `Email: ${lead.email}`,
      `Страница: ${lead.page || "Сайт"}`,
      `Источник: ${lead.source || "Форма"}`,
      lead.message ? `Комментарий: ${lead.message}` : ""
    ].filter(Boolean).join("\n"),
    start: {
      dateTime: range.start.toISOString(),
      timeZone: cfg.timeZone
    },
    end: {
      dateTime: range.end.toISOString(),
      timeZone: cfg.timeZone
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 30 }
      ]
    }
  };

  return googleCalendarFetch(`/calendars/${encodeURIComponent(cfg.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(event)
  });
}

async function processLeadCalendar(lead) {
  const cfg = getCalendarConfig();

  try {
    const availability = await checkCalendarAvailability(lead);

    if (!availability.configured) {
      return {
        bookingStatus: "calendar_not_configured",
        booked: false,
        calendarMessage: availability.message,
        clientMessage: "Заявка отправлена. Команда проверит время и вернется с подтверждением."
      };
    }

    if (!availability.available) {
      return {
        bookingStatus: "busy",
        booked: false,
        calendarMessage: availability.message,
        clientMessage: "Заявка отправлена, но выбранное время занято. Команда предложит ближайший свободный слот."
      };
    }

    if (!cfg.autoBook) {
      return {
        bookingStatus: "free_not_booked",
        booked: false,
        calendarMessage: "Время свободно, автобронь выключена.",
        clientMessage: "Заявка отправлена. Выбранное время свободно, команда подтвердит его вручную."
      };
    }

    const event = await createCalendarEvent(lead, availability.range);

    return {
      bookingStatus: "booked",
      booked: true,
      calendarEventId: event.id,
      calendarHtmlLink: event.htmlLink,
      calendarMessage: "Время свободно — событие создано в Google Calendar.",
      clientMessage: "Готово. Мы забронировали выбранное время и передали заявку команде."
    };
  } catch (error) {
    console.error("Google Calendar error:", error.message);

    return {
      bookingStatus: "calendar_error",
      booked: false,
      calendarMessage: `Ошибка Google Calendar: ${error.message}`,
      clientMessage: "Заявка отправлена. Календарь не ответил, поэтому команда проверит время вручную."
    };
  }
}

function calendarStatusLine(lead) {
  if (lead.bookingStatus === "booked") return "✅ Google Calendar: время свободно, клиент записан.";
  if (lead.bookingStatus === "busy") return "⚠️ Google Calendar: время занято, клиенту нужен другой слот.";
  if (lead.bookingStatus === "free_not_booked") return "🟡 Google Calendar: время свободно, автобронь выключена.";
  if (lead.bookingStatus === "calendar_not_configured") return "⚪ Google Calendar: не настроен.";
  if (lead.bookingStatus === "calendar_error") return `🔴 Google Calendar: ошибка проверки.`;
  return "⚪ Google Calendar: статус не проверен.";
}

// -----------------------------------------------------------------------------
// Telegram + email
// -----------------------------------------------------------------------------

const telegramMessage = (lead) => [
  "📩 Новая заявка с сайта «Новый дом»",
  "",
  `Имя: ${lead.name}`,
  `Телефон: ${lead.phone}`,
  `Email: ${lead.email}`,
  `Удобное время: ${lead.preferredDate}, ${lead.preferredTime} МСК`,
  `Страница: ${lead.page || "Сайт"}`,
  `Источник: ${lead.source || "Форма"}`,
  lead.message ? `Комментарий: ${lead.message}` : "",
  "",
  calendarStatusLine(lead),
  lead.calendarMessage ? `Комментарий календаря: ${lead.calendarMessage}` : "",
  lead.calendarHtmlLink ? `Событие: ${lead.calendarHtmlLink}` : "",
  "",
  `ID заявки: ${lead.id}`
].filter(Boolean).join("\n");

async function sendLeadToTelegram(lead) {
  if (!bot || !chatId) return;

  const keyboard = lead.bookingStatus === "booked"
    ? [[{ text: "✓ Запись уже создана", callback_data: `confirm:${lead.id}` }]]
    : [[
        { text: "✓ Подтвердить вручную", callback_data: `confirm:${lead.id}` },
        { text: "↻ Предложить другое время", callback_data: `reschedule:${lead.id}` }
      ]];

  await bot.sendMessage(chatId, telegramMessage(lead), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendRescheduleEmail(lead, proposedTime) {
  if (!mailer || !lead.email) return false;

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  await mailer.sendMail({
    from,
    to: lead.email,
    subject: "Новый дом — предлагаем другое время созвона",
    text: [
      `Здравствуйте, ${lead.name}!`,
      "",
      "Спасибо за вашу заявку в Новый дом.",
      `Предлагаем перенести созвон на: ${proposedTime}.`,
      "",
      "Если время не подходит, ответьте на это письмо или оставьте новую заявку на сайте.",
      "",
      "С уважением, команда Новый дом."
    ].join("\n"),
    html: `<p>Здравствуйте, <b>${lead.name}</b>!</p><p>Спасибо за вашу заявку в «Новый дом».</p><p>Предлагаем перенести созвон на: <b>${proposedTime}</b>.</p><p>Если время не подходит, ответьте на это письмо или оставьте новую заявку на сайте.</p><p>С уважением,<br>команда Новый дом.</p>`
  });

  return true;
}

app.post("/api/leads", leadLimiter, async (req, res) => {
  const raw = req.body || {};
  if (raw.website) return res.status(400).json({ message: "Запрос отклонен." });

  const lead = {
    id: crypto.randomUUID().slice(0, 8),
    name: clean(raw.name, 120),
    phone: clean(raw.phone, 40),
    email: clean(raw.email, 160),
    preferredDate: clean(raw.preferredDate, 30),
    preferredTime: clean(raw.preferredTime, 30),
    message: clean(raw.message, 1000),
    page: clean(raw.page, 90),
    source: clean(raw.source, 140),
    createdAt: new Date().toISOString(),
    status: "new"
  };

  const missing = requiredFields.filter((field) => !lead[field]);
  if (missing.length) return res.status(400).json({ message: "Заполните имя, телефон, email, дату и время." });
  if (!/^\S+@\S+\.\S+$/.test(lead.email)) return res.status(400).json({ message: "Проверьте email." });

  const calendarResult = await processLeadCalendar(lead);

  Object.assign(lead, {
    status: calendarResult.booked ? "booked" : "new",
    bookingStatus: calendarResult.bookingStatus,
    booked: calendarResult.booked,
    calendarMessage: calendarResult.calendarMessage,
    calendarEventId: calendarResult.calendarEventId || "",
    calendarHtmlLink: calendarResult.calendarHtmlLink || ""
  });

  const leads = getLeads();
  leads.unshift(lead);
  saveLeads(leads);

  try {
    await sendLeadToTelegram(lead);
  } catch (error) {
    console.error("Telegram error:", error.message);
  }

  return res.status(201).json({
    ok: true,
    leadId: lead.id,
    booked: lead.booked,
    bookingStatus: lead.bookingStatus,
    message: calendarResult.clientMessage
  });
});

if (bot) {
  bot.on("callback_query", async (query) => {
    const [action, id] = String(query.data || "").split(":");
    const lead = findLead(id);

    if (!lead) return bot.answerCallbackQuery(query.id, { text: "Заявка не найдена." });

    try {
      if (action === "confirm") {
        updateLead(id, { status: "confirmed" });
        await bot.answerCallbackQuery(query.id, { text: "Время подтверждено." });
        await bot.sendMessage(query.message.chat.id, `✅ Время подтверждено для заявки ${id}.\n${lead.name}: ${lead.preferredDate}, ${lead.preferredTime} МСК.`);
      }

      if (action === "reschedule") {
        waitingForNewTime.set(String(query.message.chat.id), id);
        await bot.answerCallbackQuery(query.id, { text: "Напишите новое время следующим сообщением." });
        await bot.sendMessage(query.message.chat.id, `Для заявки ${id} напишите новое время одним сообщением.\nНапример: «12 июля, 16:00 МСК»`);
      }
    } catch (error) {
      console.error("Telegram callback error:", error.message);
    }
  });

  bot.on("message", async (message) => {
    const id = waitingForNewTime.get(String(message.chat.id));
    if (!id || !message.text || message.text.startsWith("/")) return;

    const lead = findLead(id);
    if (!lead) {
      waitingForNewTime.delete(String(message.chat.id));
      return;
    }

    const proposedTime = clean(message.text, 180);

    try {
      const emailSent = await sendRescheduleEmail(lead, proposedTime);
      updateLead(id, { status: "reschedule_proposed", proposedTime, emailSent });
      waitingForNewTime.delete(String(message.chat.id));

      await bot.sendMessage(message.chat.id, emailSent
        ? `📧 Новое время отправлено клиенту на ${lead.email}.`
        : `⚠️ Новое время сохранено, но письмо не отправлено. Проверьте SMTP в .env.\nКлиент: ${lead.email}\nНовое время: ${proposedTime}`);
    } catch (error) {
      console.error("Reschedule error:", error.message);
    }
  });

  bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
}

app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.listen(port, () => {
  console.log(`Новый дом запущен: http://localhost:${port}`);
  if (!bot) console.log("Telegram не настроен: заполните TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env");
  if (!mailer) console.log("SMTP не настроен: перенос времени будет сохранен, но письмо клиенту не отправится.");
  if (!isCalendarConfigured()) console.log("Google Calendar не настроен: заполните GOOGLE_CALENDAR_* в .env");
});
