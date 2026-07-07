/**
 * @file audio.c
 * @brief I2S audio driver implementation — INMP441 mic + MAX98357A speaker
 *
 * Uses ESP-IDF v5.x new I2S driver (driver/i2s_std.h) with:
 *   - Full-duplex on I2S_NUM_0 (TX + RX share BCLK/WS)
 *   - Standard Philips mode, 16kHz, 16-bit, mono
 *   - Energy-based VAD for recording (500ms silence detection)
 *   - Chunked playback (1024 bytes per write)
 *
 * Pin assignments:
 *   BCLK=GPIO4, WS=GPIO5, DIN=GPIO6 (mic), DOUT=GPIO7 (speaker)
 */
#include "audio.h"

#include <string.h>
#include <math.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "AUDIO";

/* ---- I2S channel handles ---- */
static i2s_chan_handle_t s_tx_handle = NULL;  /* Speaker (TX) */
static i2s_chan_handle_t s_rx_handle = NULL;  /* Microphone (RX) */

/* ---- DMA configuration ---- */
#define I2S_DMA_DESC_NUM    6       /* Number of DMA descriptors */
#define I2S_DMA_FRAME_NUM   512     /* Frames per DMA descriptor */

/* ------------------------------------------------------------------ */
/*  Initialization                                                     */
/* ------------------------------------------------------------------ */

void audio_init(void)
{
    ESP_LOGI(TAG, "Initializing I2S audio (16kHz, 16bit, Mono, full-duplex)...");

    /* Create I2S channel pair (TX + RX) on I2S_NUM_0 */
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0,
                                                             I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = I2S_DMA_DESC_NUM;
    chan_cfg.dma_frame_num = I2S_DMA_FRAME_NUM;
    chan_cfg.auto_clear = true;

    esp_err_t ret = i2s_new_channel(&chan_cfg, &s_tx_handle, &s_rx_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to create I2S channel: %s", esp_err_to_name(ret));
        return;
    }

    /* Standard mode configuration (shared by TX and RX) */
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .bclk = I2S_BCLK,
            .ws = I2S_WS,
            .dout = I2S_DATA_OUT,
            .din = I2S_DATA_IN,
            .mclk = I2S_GPIO_UNUSED,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };

    /* Initialize TX channel (speaker) */
    ret = i2s_channel_init_std_mode(s_tx_handle, &std_cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init TX channel: %s", esp_err_to_name(ret));
        return;
    }

    /* Initialize RX channel (microphone) */
    ret = i2s_channel_init_std_mode(s_rx_handle, &std_cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init RX channel: %s", esp_err_to_name(ret));
        return;
    }

    /* Enable both channels */
    ret = i2s_channel_enable(s_tx_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to enable TX channel: %s", esp_err_to_name(ret));
        return;
    }

    ret = i2s_channel_enable(s_rx_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to enable RX channel: %s", esp_err_to_name(ret));
        return;
    }

    ESP_LOGI(TAG, "I2S audio initialized (BCLK=%d, WS=%d, DIN=%d, DOUT=%d)",
             I2S_BCLK, I2S_WS, I2S_DATA_IN, I2S_DATA_OUT);
}

/* ------------------------------------------------------------------ */
/*  VAD: RMS energy calculation                                        */
/* ------------------------------------------------------------------ */

/**
 * @brief Calculate RMS energy of audio samples
 * @param samples 16-bit PCM samples
 * @param count Number of samples
 * @return RMS value (0-32768)
 */
static float calc_rms(const int16_t *samples, int count)
{
    if (count <= 0) return 0.0f;

    int64_t sum_sq = 0;
    for (int i = 0; i < count; i++) {
        int32_t val = samples[i];
        sum_sq += (int64_t)val * val;
    }

    return sqrtf((float)sum_sq / (float)count);
}

/* ------------------------------------------------------------------ */
/*  Recording with VAD                                                 */
/* ------------------------------------------------------------------ */

size_t audio_record(uint8_t *buffer, size_t max_bytes, uint32_t timeout_ms)
{
    if (!s_rx_handle || !buffer || max_bytes == 0) {
        ESP_LOGE(TAG, "audio_record: invalid arguments");
        return 0;
    }

    /* Discard initial I2S garbage data (3 chunks) */
    uint8_t discard_buf[VAD_CHUNK_BYTES];
    for (int i = 0; i < 3; i++) {
        size_t bytes_read = 0;
        i2s_channel_read(s_rx_handle, discard_buf, sizeof(discard_buf),
                         &bytes_read, pdMS_TO_TICKS(100));
    }

    size_t total_bytes = 0;
    uint32_t start_ms = (uint32_t)(esp_timer_get_time() / 1000);

    /* VAD state */
    bool speech_detected = false;
    uint32_t silence_start_ms = 0;

    uint8_t chunk[VAD_CHUNK_BYTES];

    ESP_LOGI(TAG, "Recording started (max %zu bytes, timeout %lu ms, "
             "VAD silence %d ms)...",
             max_bytes, (unsigned long)timeout_ms, VAD_SILENCE_MS);

    while (total_bytes < max_bytes) {
        /* Check timeout */
        uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);
        uint32_t elapsed = now_ms - start_ms;
        if (elapsed >= timeout_ms) {
            ESP_LOGI(TAG, "Recording timeout (%lu ms)", (unsigned long)timeout_ms);
            break;
        }

        /* Read a chunk from the microphone */
        size_t bytes_to_read = VAD_CHUNK_BYTES;
        if (bytes_to_read > max_bytes - total_bytes) {
            bytes_to_read = max_bytes - total_bytes;
        }

        size_t bytes_read = 0;
        esp_err_t ret = i2s_channel_read(s_rx_handle, chunk, bytes_to_read,
                                          &bytes_read, pdMS_TO_TICKS(200));
        if (ret != ESP_OK || bytes_read == 0) {
            ESP_LOGW(TAG, "I2S read failed: %s", esp_err_to_name(ret));
            continue;
        }

        /* Copy data to output buffer */
        memcpy(buffer + total_bytes, chunk, bytes_read);
        total_bytes += bytes_read;

        /* VAD: calculate RMS energy */
        int samples_read = bytes_read / 2;  /* 16-bit = 2 bytes/sample */
        float rms = calc_rms((const int16_t *)chunk, samples_read);

        now_ms = (uint32_t)(esp_timer_get_time() / 1000);

        if (rms > VAD_THRESHOLD) {
            /* Speech detected */
            if (!speech_detected) {
                speech_detected = true;
                ESP_LOGI(TAG, "VAD: speech detected (RMS=%.0f)", rms);
            }
            silence_start_ms = 0;
        } else if (speech_detected) {
            /* Silence after speech */
            if (silence_start_ms == 0) {
                silence_start_ms = now_ms;
            }
            uint32_t silence_duration = now_ms - silence_start_ms;
            if (silence_duration >= VAD_SILENCE_MS) {
                ESP_LOGI(TAG, "VAD: %d ms silence detected, stopping recording",
                         VAD_SILENCE_MS);
                break;
            }
        }
    }

    ESP_LOGI(TAG, "Recording complete: %zu bytes (%.1f s)",
             total_bytes, (float)total_bytes / AUDIO_BYTES_PER_SEC);

    return total_bytes;
}

/* ------------------------------------------------------------------ */
/*  Playback                                                           */
/* ------------------------------------------------------------------ */

void audio_play(const uint8_t *data, size_t len)
{
    if (!s_tx_handle || !data || len == 0) {
        ESP_LOGE(TAG, "audio_play: invalid arguments");
        return;
    }

    ESP_LOGI(TAG, "Playing audio: %zu bytes (%.1f s)",
             len, (float)len / AUDIO_BYTES_PER_SEC);

    size_t offset = 0;
    while (offset < len) {
        size_t to_write = len - offset;
        if (to_write > AUDIO_PLAYBACK_CHUNK) {
            to_write = AUDIO_PLAYBACK_CHUNK;
        }

        size_t bytes_written = 0;
        esp_err_t ret = i2s_channel_write(s_tx_handle,
                                           data + offset,
                                           to_write,
                                           &bytes_written,
                                           pdMS_TO_TICKS(1000));
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "I2S write failed: %s", esp_err_to_name(ret));
            return;
        }
        offset += bytes_written;
    }

    /* Wait for the last chunk to finish playing */
    vTaskDelay(pdMS_TO_TICKS(100));

    ESP_LOGI(TAG, "Playback complete");
}
