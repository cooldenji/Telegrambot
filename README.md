# Telegram Digital Shop Bot

Two-bot system (User Bot + Admin Bot) for selling digital products on Telegram, written in JavaScript (Node.js).

## Features

**User Bot**
- `/start` welcome + force-channel-join gate before shop access
- Referral system (`?start=ref_<id>`), reward credited when the referred user verifies
- Product catalog with price (₹) and live stock
- Deposit flow: UPI (GPay / Fam Pay / Any UPI) or Binance Pay (USDT), with screenshot upload
- Profile: balance, total deposited, deposit count, referral count
- Leaderboard: top depositors + top referrers
- Support button

**Admin Bot**
- Password-gated admin panel (`/start` → password)
- Change join URL + display name
- Add / edit / delete products (name, price, stock, description)
- Change deposit settings per app (QR image + ID/name), delete QR/ID
- Approve / reject deposits and orders, with direct-message-to-user button
- Hire additional admins by Telegram user ID
- Feature toggle system (turn Buy/Deposit/Refer/Leaderboard/Support on or off)
- Cross-bot photo relay: QR codes (admin → user) and payment screenshots (user → admin) are re-uploaded through the receiving bot's own token, since a `file_id` from one bot is not valid on another bot. See `src/utils/relay.js`.

## Project structure

```
telegram-shop-bot/
├── package.json
├── .env.example        ← copy to .env and fill in
├── README.md
└── src/
    ├── config.js        ← loads and validates environment variables
    ├── db.js             ← SQLite schema + all data access helpers
    ├── userBot.js         ← customer-facing bot
    ├── adminBot.js        ← admin panel bot
    ├── index.js            ← starts both bots and wires them together
    └── utils/
        └── relay.js         ← cross-bot photo relay helper
```

## Setup

```bash
npm install
cp .env.example .env
# then edit .env with your real values (see below)
npm start
```

Both bots run in polling mode; no public URL or webhook is required.

## Environment variables — what to put in `.env`

| Variable | What it is | How to get it |
|---|---|---|
| `BOT_TOKEN` | Token for the bot your customers talk to | Create a bot with [@BotFather](https://t.me/BotFather), copy the token |
| `ADMIN_BOT_TOKEN` | Token for a **second, separate** bot used only by admins | Create a second bot with @BotFather |
| `OWNER_ID` | Your personal numeric Telegram user ID | Message [@userinfobot](https://t.me/userinfobot) |
| `ADMIN_IDS` | Comma-separated extra admin user IDs (optional, can be empty) | Same as above, one ID per admin |
| `ADMIN_PASSWORD` | Password required to unlock the admin panel | Pick your own strong password |
| `JOIN_URL` | Link to the channel users must join | Your channel's invite link |
| `JOIN_URL_NAME` | Display label for the join button | Any short text, e.g. `Our Channel` |
| `CHANNEL_ID` | Numeric ID of that channel, with `-100` prefix | Forward a channel message to [@userinfobot](https://t.me/userinfobot), or use `@RawDataBot` |
| `SUPPORT_USERNAME` | Telegram username shown on the Support button (no `@`) | Your support account's username |
| `USDT_TO_INR_RATE` | Conversion rate used only for displaying `$` alongside `₹` | Update manually whenever the rate changes |
| `REFERRAL_REWARD_INR` | ₹ amount credited to a referrer per successful referral | Your choice |
| `DATABASE_PATH` | Where the SQLite file is created | Default `./data/shop.db` is fine for most setups |

**Important:**
- The **admin bot must be made an administrator of the channel** in `CHANNEL_ID` so `getChatMember` works for the join-check.
- Keep `.env` out of version control (add it to `.gitignore`) — it holds both bot tokens and your admin password.
- `BOT_TOKEN` and `ADMIN_BOT_TOKEN` must be two **different** bots — this is what makes the cross-bot photo relay necessary and functional.

## Notes on the data model

All data lives in a local SQLite file (`better-sqlite3`, synchronous, zero external server needed):
`users`, `products`, `deposits`, `orders`, `referrals`, `settings`, `admins`, `feature_toggles`.

## Extending

- Add Telegram Stars (native in-app payments) as another deposit method by handling `sendInvoice` / `pre_checkout_query` / `successful_payment` in `userBot.js` — the product catalog and stock logic can be reused as-is.
- Swap SQLite for Postgres/MySQL later by replacing `src/db.js` — the rest of the app only calls the exported helper functions, not SQL directly.
