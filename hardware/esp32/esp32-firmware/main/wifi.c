/**
 * @file wifi.c
 * @brief WiFi connection management implementation
 *
 * Uses ESP-IDF WiFi component with:
 *   - NVS for credential storage
 *   - NETIF for network interface management
 *   - EventGroupHandle_t for connection state signaling
 *   - Auto-reconnect on disconnect (up to WIFI_MAX_RETRY)
 *   - AP mode for provisioning (softAP + captive portal placeholder)
 */
#include "wifi.h"

#include <string.h>

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

static const char *TAG = "WIFI";

/* ---- Event group bits ---- */
#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1

/* ---- Constants ---- */
#define WIFI_MAX_RETRY      10
#define WIFI_CONNECT_TIMEOUT_MS  15000

/* ---- Module state ---- */
static EventGroupHandle_t s_wifi_event_group = NULL;
static int s_retry_count = 0;
static bool s_wifi_initialized = false;
static bool s_nvs_initialized = false;
static bool s_netif_initialized = false;
static bool s_event_loop_created = false;

/* ------------------------------------------------------------------ */
/*  Event handler                                                      */
/* ------------------------------------------------------------------ */

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                                int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
        case WIFI_EVENT_STA_START:
            ESP_LOGI(TAG, "STA started, connecting...");
            esp_wifi_connect();
            break;

        case WIFI_EVENT_STA_DISCONNECTED:
            /* Auto-reconnect on disconnect */
            s_retry_count++;
            if (s_retry_count <= WIFI_MAX_RETRY) {
                ESP_LOGW(TAG, "Disconnected, retry %d/%d...",
                         s_retry_count, WIFI_MAX_RETRY);
                esp_wifi_connect();
            } else {
                ESP_LOGE(TAG, "Connection failed after %d retries", WIFI_MAX_RETRY);
                xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
            }
            break;

        case WIFI_EVENT_AP_STACONNECTED:
            ESP_LOGI(TAG, "Station connected to AP");
            break;

        case WIFI_EVENT_AP_STADISCONNECTED:
            ESP_LOGI(TAG, "Station disconnected from AP");
            break;

        default:
            break;
        }
    } else if (event_base == IP_EVENT) {
        if (event_id == IP_EVENT_STA_GOT_IP) {
            ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
            ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
            s_retry_count = 0;
            xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Initialization helpers (idempotent)                               */
/* ------------------------------------------------------------------ */

static void ensure_nvs_init(void)
{
    if (s_nvs_initialized) return;

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    s_nvs_initialized = true;
    ESP_LOGI(TAG, "NVS initialized");
}

static void ensure_netif_init(void)
{
    if (s_netif_initialized) return;

    ESP_ERROR_CHECK(esp_netif_init());
    s_netif_initialized = true;
    ESP_LOGI(TAG, "NETIF initialized");
}

static void ensure_event_loop(void)
{
    if (s_event_loop_created) return;

    esp_err_t ret = esp_event_loop_create_default();
    if (ret == ESP_ERR_INVALID_STATE) {
        /* Already created by another module */
        ESP_LOGI(TAG, "Event loop already created");
    } else {
        ESP_ERROR_CHECK(ret);
    }
    s_event_loop_created = true;
}

static void ensure_wifi_driver_init(void)
{
    if (s_wifi_initialized) return;

    /* Create event group */
    if (!s_wifi_event_group) {
        s_wifi_event_group = xEventGroupCreate();
    }

    /* Create default STA netif */
    esp_netif_create_default_wifi_sta();

    /* Initialize WiFi driver with default config */
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    /* Register event handlers */
    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                        &wifi_event_handler, NULL,
                                        &instance_any_id);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                        &wifi_event_handler, NULL,
                                        &instance_got_ip);

    s_wifi_initialized = true;
    ESP_LOGI(TAG, "WiFi driver initialized");
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

void wifi_init(const char *ssid, const char *password)
{
    /* Initialize subsystems (idempotent) */
    ensure_nvs_init();
    ensure_netif_init();
    ensure_event_loop();
    ensure_wifi_driver_init();

    /* Clear previous event bits and retry counter */
    xEventGroupClearBits(s_wifi_event_group,
                         WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);
    s_retry_count = 0;

    /* Configure STA */
    wifi_config_t sta_config = {0};
    strncpy((char *)sta_config.sta.ssid, ssid,
            sizeof(sta_config.sta.ssid) - 1);
    if (password && strlen(password) > 0) {
        strncpy((char *)sta_config.sta.password, password,
                sizeof(sta_config.sta.password) - 1);
    }
    sta_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Connecting to WiFi SSID: %s ...", ssid);

    /* Wait for connection or failure */
    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE,
        pdMS_TO_TICKS(WIFI_CONNECT_TIMEOUT_MS));

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Connected to WiFi: %s", ssid);
    } else {
        ESP_LOGW(TAG, "Failed to connect to WiFi (timeout or max retries)");
    }
}

bool wifi_is_connected(void)
{
    if (!s_wifi_event_group) return false;
    return (xEventGroupGetBits(s_wifi_event_group) & WIFI_CONNECTED_BIT) != 0;
}

void wifi_start_ap(const char *ssid)
{
    /* Initialize subsystems if not already done */
    ensure_nvs_init();
    ensure_netif_init();
    ensure_event_loop();

    /* Create event group if needed */
    if (!s_wifi_event_group) {
        s_wifi_event_group = xEventGroupCreate();
    }

    /* Initialize WiFi driver if not already done */
    if (!s_wifi_initialized) {
        /* Create default AP netif */
        esp_netif_create_default_wifi_ap();

        wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&cfg));

        /* Register event handler for AP events */
        esp_event_handler_instance_t instance_any_id;
        esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                            &wifi_event_handler, NULL,
                                            &instance_any_id);

        s_wifi_initialized = true;
    }

    /* Configure AP */
    wifi_config_t ap_config = {0};
    strncpy((char *)ap_config.ap.ssid, ssid,
            sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(ssid);
    ap_config.ap.max_connection = 2;
    ap_config.ap.authmode = WIFI_AUTH_OPEN;  /* Open for easy provisioning */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "AP mode started: SSID=%s", ssid);
    ESP_LOGI(TAG, "Captive portal placeholder — connect to '%s' and "
             "visit http://192.168.4.1 to configure", ssid);
}
