# Интеграция заявок с Telegram и Google Calendar

## Как работает

1. Клиент отправляет форму на сайте.
2. Сервер принимает `POST /api/leads`.
3. Сервер проверяет выбранные дату и время через Google Calendar FreeBusy.
4. Если слот свободен и `LEAD_AUTO_BOOK=true`, сервер создает событие в Google Calendar.
5. В Telegram приходит заявка со статусом:
   - клиент записан;
   - время занято;
   - календарь не настроен;
   - ошибка проверки календаря.
6. Сайт сразу показывает клиенту понятный ответ.

## Что нужно настроить

### Telegram

- Создать бота через `@BotFather`.
- В `.env` указать `TELEGRAM_BOT_TOKEN`.
- Получить chat id личного чата/группы и указать `TELEGRAM_CHAT_ID`.

### Google Calendar

- В Google Cloud создать проект.
- Включить Google Calendar API.
- Создать Service Account.
- Скачать JSON-ключ или вынести `client_email` и `private_key` в `.env`.
- Открыть нужный календарь в Google Calendar и выдать email сервисного аккаунта права на внесение изменений.
- В `.env` указать `GOOGLE_CALENDAR_ID`.
- Оставить `LEAD_AUTO_BOOK=true`, если нужно автоматическое создание события при свободном слоте.

## Переменные окружения

```env
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=your-calendar-id@group.calendar.google.com
GOOGLE_CALENDAR_TIMEZONE=Europe/Moscow
GOOGLE_CALENDAR_TIMEZONE_OFFSET=+03:00
LEAD_MEETING_DURATION_MINUTES=30
LEAD_AUTO_BOOK=true

GOOGLE_CALENDAR_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_CALENDAR_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Альтернатива — положить JSON на сервер и указать:

```env
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./calendar-service-account.json
```

## Важный момент

Service Account не видит личный календарь сам по себе. Календарь нужно явно расшарить на email сервисного аккаунта с правом добавлять события.
