# HomeAI Pro — ESP-12E AI Voice Assistant & Smart-Home Controller

HomeAI Pro is a starter project for a browser-based voice/chat assistant and a four-relay ESP8266 controller. It supports Gemini chat, English/Hinglish replies, YouTube music search with an embedded player, and remote relay commands over **HTTPS polling**.

**This version does not use MQTT and does not require an MQTT broker.** The ESP8266 makes outbound HTTPS requests to the cloud backend to retrieve commands and acknowledge them.

## Features

- Responsive phone webpage for chat, voice input, and speech output.
- English or Hinglish (Roman-script Hindi + English) assistant replies.
- Browser-based “Hey HomeAI” wake-word style mode while the page is open and microphone access is allowed.
- Gemini API integration on the backend (API key never belongs in browser code).
- YouTube Data API search and official embedded YouTube playback.
- Safe, explicit command parser for four relay outputs and an all-off command.
- Cloud-to-device relay control using HTTPS polling with a separate device token.
- Relay outputs initialize OFF and have a 30-minute auto-off timer.
- Local authenticated ESP8266 status/control endpoints for troubleshooting.

## Project layout

```text
homeai-pro/
├── backend/
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── web/
│   └── index.html
├── esp8266/
│   └── HomeAI_ESP8266.ino
└── README.md
```

## Architecture

```text
Phone browser (HTTPS)
       |
       v
Cloud Node.js backend -----> Gemini API
       |                    YouTube Data API
       |
       | HTTPS command queue / polling
       v
ESP-12E / NodeMCU -----> Relay module (D1, D2, D5, D6)
```

No computer at home needs to remain running after deployment. The ESP8266 must remain powered and connected to Wi-Fi, and the cloud backend must remain available. The ESP8266 polls the backend every four seconds. Because this starter version uses an in-memory queue, pending commands are lost if the backend restarts, and commands expire after two minutes. Use a persistent database/queue before relying on this for important automation.

## 1. Create API keys

### Gemini API

1. Open [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Create an API key.
3. Store it as `GEMINI_API_KEY` in the backend environment.
4. The default model is `gemini-2.5-flash`; check current model availability and pricing/quotas in the [Gemini API pricing documentation](https://ai.google.dev/gemini-api/docs/pricing) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

### YouTube Data API

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create/select a project.
3. Open **APIs & Services → Library**, find **YouTube Data API v3**, and enable it.
4. Create an API key under **APIs & Services → Credentials**.
5. Restrict the key to YouTube Data API v3 and store it as `YOUTUBE_API_KEY` on the backend.
6. Search quota applies. Playback uses the official [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference); HomeAI does not download audio.

## 2. Configure the backend locally

Install a current Node.js LTS release from [nodejs.org](https://nodejs.org/).

Copy `backend/.env.example` to `backend/.env`, then fill in every value:

- `APP_USERNAME`: username for the HomeAI webpage.
- `APP_PASSWORD`: a long, unique password for the webpage.
- `DEVICE_TOKEN`: a separate random secret of at least 32 characters, identical in the backend environment and ESP8266 sketch.
- `GEMINI_API_KEY`: your Gemini key.
- `GEMINI_MODEL`: model name available to your project.
- `YOUTUBE_API_KEY`: your restricted YouTube API key.

Generate a token on macOS/Linux with:

```bash
openssl rand -hex 32
```

On Windows PowerShell, you can generate a random hex token with:

```powershell
-join (1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Do not commit `backend/.env` to GitHub. Do not put API keys in `web/index.html` or the ESP8266 sketch. The ESP sketch needs only the separate `DEVICE_TOKEN`, not the Gemini or YouTube API keys.

Run locally from the repository root:

```bash
cd backend
npm install
npm start
```

Open `http://localhost:3000`. Basic Auth protects the page and browser APIs. Local HTTP is only for development; use HTTPS for public deployment.

## 3. Deploy the cloud backend on Render

1. Push the repository contents to GitHub, preserving the `backend`, `web`, and `esp8266` folders.
2. Sign in at [Render](https://render.com/) and create **New → Web Service**.
3. Connect the repository.
4. Leave **Root Directory** blank so both `backend/` and `web/` are available.
5. Set **Build Command** to `cd backend && npm install`.
6. Set **Start Command** to `cd backend && npm start`.
7. Add the environment variables listed in Section 2 in Render's **Environment** settings. Do not upload a `.env` file.
8. Deploy and copy the public hostname, for example `your-service.onrender.com`.

Open `https://YOUR-HOSTNAME/api/health` in a browser after signing in. It reports whether Gemini, YouTube, and the device token are configured, and whether the ESP8266 has polled recently.

**Hosting note:** Free web-service plans may sleep or have usage limits. A device polling every four seconds may keep a service active and consume usage. Check your host's current plan rules and costs. The backend's command queue is in memory, not persistent storage.

## 4. Configure ESP-12E firmware

Open `esp8266/HomeAI_ESP8266.ino` in Arduino IDE.

### Libraries / board

1. Install the ESP8266 board package in Arduino IDE.
2. Install **ArduinoJson** by Benoit Blanchon from Library Manager.
3. `ESP8266WiFi`, `ESP8266WebServer`, `ESP8266HTTPClient`, and BearSSL are included with the ESP8266 core.
4. No MQTT library or broker is needed for this version.

### Edit these firmware settings

- `WIFI_SSID` and `WIFI_PASSWORD`: your home Wi-Fi credentials.
- `AP_PASSWORD`: change the setup access point password.
- `WEB_USERNAME` and `WEB_PASSWORD`: local controller credentials.
- `CLOUD_HOST`: your Render hostname only, with no `https://` or trailing slash.
- `DEVICE_TOKEN`: exactly the same secret configured in the backend.
- `CLOUD_ROOT_CA`: the trusted root CA certificate that validates the HTTPS certificate presented for `CLOUD_HOST`.

### Configure the TLS root certificate

The firmware deliberately refuses cloud polling while the certificate placeholder remains. It uses BearSSL certificate validation; **do not replace this with `setInsecure()`**.

To get the correct root CA:

1. Open your deployed `https://YOUR-HOSTNAME` URL in a desktop browser.
2. Open the site certificate details and inspect the certificate chain/issuer.
3. Obtain the trusted root CA PEM from the certificate authority's official website/documentation.
4. Paste the PEM including `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` into `CLOUD_ROOT_CA`.
5. Confirm the root CA actually chains to the certificate for your deployed host. If your hosting provider changes certificate authorities, update the root certificate accordingly.

### Upload and verify

1. Select the correct ESP8266 board (for example, NodeMCU 1.0) and COM port.
2. Upload the sketch.
3. Open Serial Monitor at **115200 baud**.
4. Confirm Wi-Fi connects and the log says secure HTTPS polling is configured.
5. After the ESP polls successfully, the health endpoint should eventually show `controllerOnline: true`.

If polling fails, check the host, token match, CA certificate, Wi-Fi connectivity, and Render service status. Do not post credentials or token values in public issue reports.

## 5. Relay mapping and safe testing

| Relay | ESP8266 pin | UI label |
|---|---|---|
| 1 | D1 | Light 1 |
| 2 | D2 | Fan |
| 3 | D5 | Light 2 |
| 4 | D6 | Appliance 4 |

The sketch assumes an active-low relay module; verify your actual relay board before changing `RELAY_ACTIVE_LOW`. Test with loads disconnected first. Use a properly rated isolated relay module, a safe enclosure, and a qualified electrician for mains wiring. Never handle mains wiring while powered. Relay outputs initialize OFF and active relays are switched OFF after 30 minutes.

The backend only queues commands matching the known appliance names and explicit ON/OFF wording. The device validates the command action and relay index before applying it. Commands expire after two minutes if not acknowledged.

## 6. Try HomeAI

- “Hey HomeAI, play Kesariya” → searches YouTube for that song.
- “Play trending romantic songs” → searches YouTube for relevant current results; it does not guarantee an official live chart.
- “Play music” → asks which song or mood you want.
- “Turn on the fan” → queues a command for the ESP8266.
- “Turn everything off” → queues an all-off command.
- Choose **English** or **Hinglish** in the webpage before chatting or speaking.

The wake-word style mode uses browser speech recognition, not a dedicated always-on wake-word chip. Keep the webpage open, allow microphone access, and note that browser/phone restrictions may stop listening when the page is backgrounded or the screen is locked. YouTube autoplay may also require a tap on Play.

## Security and reliability notes

- Keep the deployed webpage on HTTPS.
- Use a long random `DEVICE_TOKEN` and a different strong `APP_PASSWORD`.
- Keep Gemini and YouTube keys in server-side environment variables only.
- Never commit `.env` or real secrets to GitHub.
- Do not expose the ESP8266's local HTTP server directly to the public internet; its local Basic Auth endpoint is not encrypted over plain HTTP.
- The HTTPS polling queue is in-memory and intended as a starter design for one device. For reliable multi-device or production use, add a persistent database/queue, command audit logs, per-device credentials, and stronger user authentication/authorization.
- This code has not been verified on your physical relay board. Test with loads disconnected before connecting appliances.
