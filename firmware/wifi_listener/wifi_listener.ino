// AFTERGLOW WIFI board: passive Wi-Fi probe-request listener (Seeed XIAO ESP32S3 #2).
//
// Hops channels 1, 6 and 11 every 250 ms and prints one JSON line per probe request
// to the Pi on Serial1:
//   {"type":"wifi","addr":"da:a1:19:00:00:01","rand":true,"rssi":-80,"ch":6}
// rand = the address is randomized (locally administered bit set).
// Formats: docs/CONTRACTS.md, "Serial lines from the ESP32 boards". Rules: firmware/README.md.
//
// Privacy (CLAUDE.md): receive only, nothing is transmitted; only the frame type, the source
// address and the RSSI are read. The raw address goes ONLY to the Pi's UART; the USB debug
// output never shows it.
//
// sos_page (tier 2) is not in this sketch yet. {"cmd":"sos_on"} / {"cmd":"sos_off"} lines
// from the Pi are read and acknowledged on USB only.
//
// Arduino IDE: board "XIAO_ESP32S3", USB CDC On Boot: Enabled (Serial = USB debug,
// Serial1 = the Pi's UART3 on D9 (RX) / D10 (TX)).
// Unplug the 5 V wire from the Pi before plugging in USB-C to flash.

#include <WiFi.h>
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#define PI_BAUD 921600
#define HOP_MS 250
#define SUMMARY_MS 5000

static const uint8_t CHANNELS[] = {1, 6, 11};
static uint8_t chIdx = 0;

struct Probe {
  uint8_t addr[6];
  int8_t rssi;
  uint8_t ch;
};
static QueueHandle_t q;
static volatile uint32_t heard = 0, dropped = 0, randCount = 0;

// Runs in the Wi-Fi task: keep it tiny, just queue the probe.
static void onPacket(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  const wifi_promiscuous_pkt_t *p = (const wifi_promiscuous_pkt_t *)buf;
  if (p->rx_ctrl.sig_len < 24) return;   // shorter than a management header
  if (p->payload[0] != 0x40) return;     // frame control: management, subtype 4 = probe request
  Probe pr;
  memcpy(pr.addr, p->payload + 10, 6);   // address 2 = the sender
  pr.rssi = p->rx_ctrl.rssi;
  pr.ch = p->rx_ctrl.channel;
  if (xQueueSend(q, &pr, 0) != pdTRUE) dropped++;  // full: drop rather than block the Wi-Fi task
}

static void readPi() {
  // Commands from the Pi, one JSON line each. Only logged for now (sos_page is tier 2).
  static char line[96];
  static size_t n = 0;
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\n') {
      line[n] = 0;
      if (strstr(line, "\"sos_on\"")) Serial.println("Pi: sos_on (sos_page not built yet)");
      else if (strstr(line, "\"sos_off\"")) Serial.println("Pi: sos_off");
      n = 0;
    } else if (n < sizeof(line) - 1) {
      line[n++] = c;
    }
  }
}

void setup() {
  Serial.begin(115200);       // USB debug; the baud rate is ignored
  Serial.setTxTimeoutMs(0);   // don't stall when no computer is listening on USB
  Serial1.setTxBufferSize(4096);
  Serial1.begin(PI_BAUD, SERIAL_8N1, D9, D10);  // baud, format, RX pin, TX pin

  q = xQueueCreate(64, sizeof(Probe));

  WiFi.mode(WIFI_STA);   // no network is joined and nothing is sent
  WiFi.disconnect();
  wifi_promiscuous_filter_t filt;
  filt.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT;
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&onPacket);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CHANNELS[chIdx], WIFI_SECOND_CHAN_NONE);
  Serial.println("AFTERGLOW wifi_listener: probe requests on ch 1/6/11, lines to Serial1 (D9/D10) at 921600");
}

void loop() {
  Probe pr;
  while (xQueueReceive(q, &pr, 0) == pdTRUE) {
    bool rnd = pr.addr[0] & 0x02;  // locally administered = randomized
    heard++;
    if (rnd) randCount++;
    Serial1.printf("{\"type\":\"wifi\",\"addr\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"rand\":%s,\"rssi\":%d,\"ch\":%u}\n",
                   pr.addr[0], pr.addr[1], pr.addr[2], pr.addr[3], pr.addr[4], pr.addr[5],
                   rnd ? "true" : "false", pr.rssi, pr.ch);
  }

  static uint32_t lastHop = 0;
  if (millis() - lastHop >= HOP_MS) {
    lastHop = millis();
    chIdx = (chIdx + 1) % sizeof(CHANNELS);
    esp_wifi_set_channel(CHANNELS[chIdx], WIFI_SECOND_CHAN_NONE);
  }

  readPi();

  static uint32_t lastSum = 0;
  if (millis() - lastSum >= SUMMARY_MS) {
    lastSum = millis();
    Serial.printf("[%lus] probes=%lu randomized=%lu dropped=%lu\n", (unsigned long)(millis() / 1000),
                  (unsigned long)heard, (unsigned long)randCount, (unsigned long)dropped);
  }
  delay(1);
}
