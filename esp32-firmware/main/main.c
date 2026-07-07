/**
 * @file main.c
 * @brief ESP32-S3 AI Character Device — Main entry point
 *
 * Startup sequence:
 *   1. Initialize NVS
 *   2. Connect WiFi (wait for connection)
 *   3. Initialize display (ST7789 SPI TFT)
 *   4. Initialize sprites (5 state sprite sheets in PSRAM)
 *   5. Initialize audio (I2S mic + speaker)
 *   6. Initialize network (Mona API client)
 *   7. Set initial animation state to IDLE
 *   8. Start animation render task (20fps, handled by animation_start)
 *   9. Create dialogue task (8192 stack, priority 4)
 *
 * Dialogue flow:
 *   Wait for wake (GPIO0 button) → LISTENING → record audio →
 *   THINKING → STT → Chat → SPEAKING → TTS → play audio →
 *   HAPPY → delay 2s → IDLE → loop
 */
#include <string.h>

#include "esp_log.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#include "wifi.h"
#include "display.h"
#include "sprites.h"
#include "animation.h"
#include "audio.h"
#include "network.h"

static const char *TAG = "MAIN";

/* ---- Configuration (change these for your network) ---- */
#define WIFI_SSID       "YourWiFiSSID"
#define WIFI_PASS       "YourWiFiPassword"
#define MONA_API_URL    "http://192.168.1.100:17173"

/* ---- Wake button ---- */
#define WAKE_BUTTON_GPIO    0   /* BOOT button (active low) */

/* ---- Task parameters ---- */
#define DIALOGUE_TASK_STACK     8192
#define DIALOGUE_TASK_PRIORITY  4

/* ---- Recording timeout ---- */
#define RECORD_TIMEOUT_MS       10000   /* 10 seconds max recording */

/* ---- Static buffers ---- */
static uint8_t *s_record_buffer = NULL;  /* Recording buffer (PSRAM) */

/* ------------------------------------------------------------------ */
/*  Wake button                                                        */
/* ------------------------------------------------------------------ */

static void button_init(void)
{
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << WAKE_BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    ESP_LOGI(TAG, "Wake button initialized (GPIO%d)", WAKE_BUTTON_GPIO);
}

/**
 * @brief Wait for wake trigger (GPIO0 button press)
 *
 * Placeholder for wake word detection. Currently uses the BOOT button.
 */
static void wait_for_wake(void)
{
    /* Wait for button press (active low) */
    while (gpio_get_level(WAKE_BUTTON_GPIO) == 1) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    /* Wait for button release (debounce) */
    while (gpio_get_level(WAKE_BUTTON_GPIO) == 0) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    vTaskDelay(pdMS_TO_TICKS(50));  /* Additional debounce */

    ESP_LOGI(TAG, "Wake triggered (button press)");
}

/* ------------------------------------------------------------------ */
/*  Dialogue task                                                     */
/* ------------------------------------------------------------------ */

/**
 * @brief Main dialogue task — handles the conversation flow
 *
 * Flow: wait for wake → listen → record → think → STT → chat →
 *       speak → TTS → play → happy → idle → loop
 */
static void dialogue_task(void *arg)
{
    ESP_LOGI(TAG, "Dialogue task started");

    while (1) {
        /* 1. Wait for wake word (placeholder: button press) */
        ESP_LOGI(TAG, "Waiting for wake trigger...");
        wait_for_wake();

        /* 2. Set LISTENING state */
        ESP_LOGI(TAG, "=== Dialogue start ===");
        ESP_LOGI(TAG, "State: LISTENING");
        animation_set_state(LISTENING);
        vTaskDelay(pdMS_TO_TICKS(200));  /* Brief pause for UI */

        /* 3. Record audio with VAD */
        ESP_LOGI(TAG, "Recording audio...");
        size_t record_len = audio_record(s_record_buffer,
                                          AUDIO_RECORD_MAX_BYTES,
                                          RECORD_TIMEOUT_MS);
        if (record_len == 0) {
            ESP_LOGW(TAG, "No audio recorded, returning to idle");
            animation_set_state(IDLE);
            continue;
        }
        ESP_LOGI(TAG, "Recorded %zu bytes", record_len);

        /* 4. Set THINKING state */
        ESP_LOGI(TAG, "State: THINKING");
        animation_set_state(THINKING);

        /* 5. Speech to text */
        ESP_LOGI(TAG, "Sending audio to STT...");
        stt_result_t stt = network_stt(s_record_buffer, record_len);
        if (!stt.success || strlen(stt.text) == 0) {
            ESP_LOGW(TAG, "STT failed, returning to idle");
            animation_set_state(IDLE);
            continue;
        }
        ESP_LOGI(TAG, "User said: %s", stt.text);

        /* 6. Chat completion */
        ESP_LOGI(TAG, "Sending to chat...");
        chat_result_t chat = network_chat(stt.text);
        if (!chat.success || strlen(chat.text) == 0) {
            ESP_LOGW(TAG, "Chat failed, returning to idle");
            animation_set_state(IDLE);
            continue;
        }
        ESP_LOGI(TAG, "AI replied: %s", chat.text);

        /* 7. Set SPEAKING state */
        ESP_LOGI(TAG, "State: SPEAKING");
        animation_set_state(SPEAKING);

        /* 8. Text to speech */
        ESP_LOGI(TAG, "Synthesizing speech...");
        tts_result_t tts = network_tts(chat.text);
        if (!tts.success || tts.len == 0) {
            ESP_LOGW(TAG, "TTS failed, returning to idle");
            animation_set_state(IDLE);
            continue;
        }
        ESP_LOGI(TAG, "TTS returned %zu bytes of audio", tts.len);

        /* 9. Play audio */
        ESP_LOGI(TAG, "Playing audio...");
        audio_play(tts.data, tts.len);

        /* Free TTS audio buffer (allocated from PSRAM in network.c) */
        free(tts.data);
        tts.data = NULL;

        /* 10. Set HAPPY state */
        ESP_LOGI(TAG, "State: HAPPY");
        animation_set_state(HAPPY);

        /* 11. Hold happy expression for 2 seconds */
        vTaskDelay(pdMS_TO_TICKS(2000));

        /* 12. Return to IDLE */
        ESP_LOGI(TAG, "State: IDLE");
        animation_set_state(IDLE);

        ESP_LOGI(TAG, "=== Dialogue end ===");
    }
}

/* ------------------------------------------------------------------ */
/*  Application entry point                                            */
/* ------------------------------------------------------------------ */

void app_main(void)
{
    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "ESP32-S3 AI Character Device");
    ESP_LOGI(TAG, "Mona API: %s", MONA_API_URL);
    ESP_LOGI(TAG, "========================================");

    /* 1. Initialize NVS */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_LOGI(TAG, "NVS initialized");

    /* 2. Connect WiFi (wait for connection) */
    ESP_LOGI(TAG, "Connecting to WiFi: %s", WIFI_SSID);
    wifi_init(WIFI_SSID, WIFI_PASS);
    if (!wifi_is_connected()) {
        ESP_LOGW(TAG, "WiFi not connected, continuing anyway...");
    }

    /* 3. Initialize display */
    ESP_LOGI(TAG, "Initializing display...");
    ESP_ERROR_CHECK(display_init());

    /* 4. Initialize sprites */
    ESP_LOGI(TAG, "Initializing sprites...");
    if (!sprite_init()) {
        ESP_LOGE(TAG, "Failed to initialize sprites!");
        /* Show red screen on error */
        display_fill_rect(0, 0, SCREEN_W, SCREEN_H, COLOR565(255, 0, 0));
        while (1) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    /* 5. Initialize audio */
    ESP_LOGI(TAG, "Initializing audio...");
    audio_init();

    /* 6. Initialize network */
    ESP_LOGI(TAG, "Initializing network...");
    network_init(MONA_API_URL);

    /* 7. Initialize animation and set IDLE state */
    ESP_LOGI(TAG, "Initializing animation...");
    animation_init();
    animation_set_state(IDLE);

    /* Initialize wake button */
    button_init();

    /* Allocate recording buffer from PSRAM */
    s_record_buffer = (uint8_t *)heap_caps_malloc(AUDIO_RECORD_MAX_BYTES,
                                                   MALLOC_CAP_SPIRAM);
    if (!s_record_buffer) {
        ESP_LOGE(TAG, "Failed to allocate recording buffer (%d bytes)",
                 AUDIO_RECORD_MAX_BYTES);
        while (1) vTaskDelay(pdMS_TO_TICKS(1000));
    }
    ESP_LOGI(TAG, "Recording buffer allocated: %d bytes (PSRAM)",
             AUDIO_RECORD_MAX_BYTES);

    /* 8. Start animation render task (FreeRTOS task at 20fps) */
    animation_start();

    /* 9. Create dialogue task */
    xTaskCreate(dialogue_task, "dialogue_task",
                DIALOGUE_TASK_STACK, NULL,
                DIALOGUE_TASK_PRIORITY, NULL);

    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "System ready! Press BOOT button to talk");
    ESP_LOGI(TAG, "========================================");
}
