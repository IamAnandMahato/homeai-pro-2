/* HomeAI Pro - ESP8266 / NodeMCU ESP-12E
   Four-relay controller with secure HTTPS command polling (NO MQTT broker).
   The ESP8266 polls the cloud backend every few seconds and acknowledges commands.
   Configure credentials and paste the CA certificate that validates your cloud host before flashing.
*/
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* AP_SSID = "HomeAI-Setup";
const char* AP_PASSWORD = "CHANGE_THIS_AP_PASSWORD"; // at least 8 characters
const char* WEB_USERNAME = "admin";
const char* WEB_PASSWORD = "CHANGE_THIS_LONG_LOCAL_PASSWORD";

// Render service hostname only: no https:// and no trailing slash.
const char* CLOUD_HOST = "YOUR-HOMEAI-SERVICE.onrender.com";
const uint16_t CLOUD_PORT = 443;
const char* DEVICE_TOKEN = "REPLACE_WITH_THE_SAME_LONG_DEVICE_TOKEN_AS_BACKEND";
const char* POLL_PATH = "/api/device/poll";
const char* ACK_PATH = "/api/device/ack";

// Paste the CA certificate that validates the TLS certificate for CLOUD_HOST.
// For a Render onrender.com hostname, inspect the certificate chain in your browser
// and use its trusted root CA. Do NOT use setInsecure() or disable certificate checks.
static const char CLOUD_ROOT_CA[] PROGMEM = R"CERT(
PASTE_CLOUD_HOST_ROOT_CA_PEM_HERE
)CERT";

const bool RELAY_ACTIVE_LOW = true;
const unsigned long AUTO_OFF_MINUTES = 30;
const uint8_t RELAY_COUNT = 4;
const uint8_t relayPins[RELAY_COUNT] = { D1, D2, D5, D6 };
const char* deviceNames[RELAY_COUNT] = { "Light 1", "Fan", "Light 2", "Appliance 4" };
const unsigned long POLL_INTERVAL_MS = 4000UL;
const unsigned long NETWORK_RETRY_MS = 5000UL;

ESP8266WebServer server(80);
BearSSL::WiFiClientSecure secureClient;
BearSSL::X509List* rootCA = nullptr;
bool relayState[RELAY_COUNT] = { false, false, false, false };
unsigned long relayStartedAt[RELAY_COUNT] = { 0, 0, 0, 0 };
unsigned long lastPollAt = 0;
unsigned long lastNetworkErrorAt = 0;

bool auth() {
  if (server.authenticate(WEB_USERNAME, WEB_PASSWORD)) return true;
  server.requestAuthentication(BASIC_AUTH, "HomeAI ESP8266");
  return false;
}
void writeRelay(uint8_t i, bool on) {
  if (i >= RELAY_COUNT) return;
  digitalWrite(relayPins[i], (RELAY_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
  relayState[i] = on;
  relayStartedAt[i] = on ? millis() : 0;
  Serial.printf("%s: %s\n", deviceNames[i], on ? "ON" : "OFF");
}
void allOff() { for (uint8_t i = 0; i < RELAY_COUNT; i++) writeRelay(i, false); }
void checkAutoOff() {
  const unsigned long timeout = AUTO_OFF_MINUTES * 60UL * 1000UL;
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    if (relayState[i] && (unsigned long)(millis() - relayStartedAt[i]) >= timeout) writeRelay(i, false);
  }
}
bool cloudConfigReady() {
  return strlen(CLOUD_HOST) > 5 && strstr(CLOUD_HOST, "YOUR-HOMEAI") == nullptr &&
         strlen(DEVICE_TOKEN) >= 32 && strstr(DEVICE_TOKEN, "REPLACE_") == nullptr &&
         strlen(CLOUD_ROOT_CA) > 100 && strstr(CLOUD_ROOT_CA, "PASTE_CLOUD") == nullptr;
}
String cloudUrl(const char* path) {
  return String("https://") + CLOUD_HOST + path;
}
void initCloudTls() {
  if (!rootCA) {
    rootCA = new BearSSL::X509List(CLOUD_ROOT_CA);
    secureClient.setTrustAnchors(rootCA);
  }
  secureClient.setTimeout(5000);
}
void acknowledgeCommand(const String& commandId) {
  if (commandId.length() == 0) return;
  HTTPClient https;
  if (!https.begin(secureClient, cloudUrl(ACK_PATH))) return;
  https.setTimeout(5000);
  https.addHeader("Content-Type", "application/json");
  https.addHeader("X-Device-Token", DEVICE_TOKEN);
  StaticJsonDocument<128> doc;
  doc["commandId"] = commandId;
  String body;
  serializeJson(doc, body);
  int code = https.POST(body);
  if (code >= 200 && code < 300) Serial.println("Cloud command acknowledged.");
  else Serial.printf("Command acknowledgement failed: HTTP %d\n", code);
  https.end();
}
bool applyCloudCommand(JsonObject command) {
  const char* action = command["action"] | "";
  if (strcmp(action, "alloff") == 0) {
    allOff();
    return true;
  }
  if (strcmp(action, "relay") != 0 || !command["id"].is<int>() || !command["state"].is<bool>()) return false;
  int id = command["id"].as<int>();
  if (id < 0 || id >= RELAY_COUNT) return false;
  writeRelay((uint8_t)id, command["state"].as<bool>());
  return true;
}
void pollCloud() {
  if (WiFi.status() != WL_CONNECTED || !cloudConfigReady()) return;
  initCloudTls();
  HTTPClient https;
  if (!https.begin(secureClient, cloudUrl(POLL_PATH))) {
    Serial.println("Could not initialize HTTPS poll.");
    return;
  }
  https.setTimeout(5000);
  https.addHeader("X-Device-Token", DEVICE_TOKEN);
  int code = https.GET();
  if (code != HTTP_CODE_OK) {
    if (millis() - lastNetworkErrorAt > 10000UL) {
      Serial.printf("Cloud poll failed: HTTP %d\n", code);
      lastNetworkErrorAt = millis();
    }
    https.end();
    return;
  }
  String response = https.getString();
  https.end();

  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.println("Cloud poll returned invalid JSON.");
    return;
  }
  if (doc["command"].isNull()) return;
  String commandId = doc["commandId"] | "";
  JsonObject command = doc["command"].as<JsonObject>();
  if (commandId.length() == 0 || command.isNull()) return;
  // Acknowledge only after applying a recognized, validated command.
  if (applyCloudCommand(command)) acknowledgeCommand(commandId);
  else Serial.println("Rejected malformed cloud command; not acknowledging it.");
}
void sendState() {
  if (!auth()) return;
  StaticJsonDocument<200> doc;
  JsonArray states = doc.createNestedArray("states");
  for (uint8_t i = 0; i < RELAY_COUNT; i++) states.add(relayState[i]);
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}
void handleRelay() {
  if (!auth()) return;
  if (!server.hasArg("id") || !server.hasArg("state")) { server.send(400, "text/plain", "Missing id/state"); return; }
  int id = server.arg("id").toInt();
  String s = server.arg("state");
  if (id < 0 || id >= RELAY_COUNT || (s != "0" && s != "1")) { server.send(400, "text/plain", "Invalid command"); return; }
  writeRelay((uint8_t)id, s == "1");
  server.send(200, "text/plain", "OK");
}
void handleAllOff() { if (!auth()) return; allOff(); server.send(200, "text/plain", "All relays OFF"); }
void handleRoot() {
  if (!auth()) return;
  server.send(200, "text/html", "<!doctype html><meta name='viewport' content='width=device-width'><h2>HomeAI ESP8266</h2><p>Local controller online. Remote commands use secure HTTPS polling.</p><p><a href='/api/state'>Relay state JSON</a></p>");
}
void setup() {
  Serial.begin(115200);
  delay(150);
  // Initialize relay outputs OFF before Wi-Fi/network setup.
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    digitalWrite(relayPins[i], RELAY_ACTIVE_LOW ? HIGH : LOW);
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], RELAY_ACTIVE_LOW ? HIGH : LOW);
  }
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 18000UL) {
    delay(250); yield(); Serial.print('.');
  }
  Serial.println();
  Serial.print("Setup AP IP: "); Serial.println(WiFi.softAPIP());
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("HomeAI local IP: "); Serial.println(WiFi.localIP());
  }
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/state", HTTP_GET, sendState);
  server.on("/api/relay", HTTP_POST, handleRelay);
  server.on("/api/alloff", HTTP_POST, handleAllOff);
  server.begin();
  Serial.println("Local HTTP server started.");
  if (!cloudConfigReady()) Serial.println("Cloud polling disabled: configure host, device token, and TLS root CA in firmware.");
  else Serial.println("Secure HTTPS polling configured; commands are checked every 4 seconds.");
}
void loop() {
  server.handleClient();
  checkAutoOff();
  if (WiFi.status() != WL_CONNECTED && millis() - lastNetworkErrorAt > NETWORK_RETRY_MS) {
    lastNetworkErrorAt = millis();
    WiFi.reconnect();
  }
  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = millis();
    pollCloud();
  }
  yield();
}
