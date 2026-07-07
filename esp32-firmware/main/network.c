/**
 * @file network.c
 * @brief HTTP network communication implementation — Mona API
 *
 * Uses esp_http_client for all HTTP requests:
 *   - STT: multipart/form-data POST with WAV audio file
 *   - Chat: JSON POST (non-streaming), parse choices[0].message.content
 *   - TTS: JSON POST, return raw binary audio bytes
 *
 * Response buffers are allocated from PSRAM (heap_caps_malloc).
 * JSON parsing uses cJSON.
 */
#include "network.h"

#include <string.h>
#include <stdio.h>

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "cJSON.h"

#include "freertos/FreeRTOS.h"

static const char *TAG = "NETWORK";

/* ---- Constants ---- */
#define HTTP_TIMEOUT_MS         30000   /* 30 second timeout */
#define HTTP_BUFFER_SIZE        8192    /* HTTP client buffer */
#define HTTP_BUFFER_SIZE_TX     8192    /* HTTP client TX buffer */

#define MULTIPART_BOUNDARY      "MonaESP32Boundary"

/* WAV parameters (must match audio.h) */
#define WAV_SAMPLE_RATE         16000
#define WAV_BITS_PER_SAMPLE     16
#define WAV_CHANNELS            1
#define WAV_HEADER_SIZE         44

/* Response size limits */
#define STT_RESPONSE_MAX        4096
#define CHAT_RESPONSE_MAX       8192
#define TTS_RESPONSE_MAX        (320 * 1024)  /* 320 KB ~ 10s audio */
#define TTS_READ_CHUNK          4096

/* ---- Module state ---- */
static char s_base_url[256] = MONA_API_DEFAULT_URL;

/* ------------------------------------------------------------------ */
/*  WAV header construction                                            */
/* ------------------------------------------------------------------ */

/**
 * @brief Build a 44-byte WAV header for PCM audio
 * @param header Output buffer (at least 44 bytes)
 * @param data_len PCM data length in bytes
 */
static void build_wav_header(uint8_t *header, size_t data_len)
{
    uint32_t sample_rate = WAV_SAMPLE_RATE;
    uint16_t bits_per_sample = WAV_BITS_PER_SAMPLE;
    uint16_t channels = WAV_CHANNELS;
    uint32_t byte_rate = sample_rate * channels * bits_per_sample / 8;
    uint16_t block_align = channels * bits_per_sample / 8;
    uint32_t chunk_size = 36 + (uint32_t)data_len;
    uint32_t fmt_size = 16;
    uint16_t audio_format = 1;  /* PCM */

    memcpy(header + 0,  "RIFF", 4);
    memcpy(header + 4,  &chunk_size, 4);
    memcpy(header + 8,  "WAVE", 4);
    memcpy(header + 12, "fmt ", 4);
    memcpy(header + 16, &fmt_size, 4);
    memcpy(header + 20, &audio_format, 2);
    memcpy(header + 22, &channels, 2);
    memcpy(header + 24, &sample_rate, 4);
    memcpy(header + 28, &byte_rate, 4);
    memcpy(header + 32, &block_align, 2);
    memcpy(header + 34, &bits_per_sample, 2);
    memcpy(header + 36, "data", 4);
    memcpy(header + 40, &data_len, 4);
}

/* ------------------------------------------------------------------ */
/*  PSRAM allocation helper                                            */
/* ------------------------------------------------------------------ */

static void *psram_malloc(size_t size)
{
    void *ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM);
    if (!ptr) {
        /* Fall back to internal RAM if PSRAM is unavailable */
        ptr = malloc(size);
    }
    return ptr;
}

/* ------------------------------------------------------------------ */
/*  Response reader                                                    */
/* ------------------------------------------------------------------ */

/**
 * @brief Read the full HTTP response body into a buffer
 * @param client HTTP client handle
 * @param buf Output buffer
 * @param max_size Maximum bytes to read
 * @return Number of bytes read, or -1 on error
 */
static int read_response(esp_http_client_handle_t client,
                          char *buf, int max_size)
{
    int content_len = esp_http_client_fetch_headers(client);
    if (content_len <= 0) {
        content_len = max_size;  /* Unknown length, read until EOF */
    }
    if (content_len > max_size) {
        content_len = max_size;
    }

    int total_read = 0;
    while (total_read < content_len) {
        int read_len = esp_http_client_read(client,
                                             buf + total_read,
                                             content_len - total_read);
        if (read_len <= 0) break;
        total_read += read_len;
    }
    buf[total_read] = '\0';
    return total_read;
}

/* ------------------------------------------------------------------ */
/*  Public API: network_init                                           */
/* ------------------------------------------------------------------ */

void network_init(const char *base_url)
{
    if (base_url && strlen(base_url) > 0) {
        strncpy(s_base_url, base_url, sizeof(s_base_url) - 1);
        s_base_url[sizeof(s_base_url) - 1] = '\0';
    }
    ESP_LOGI(TAG, "Network initialized, base URL: %s", s_base_url);
}

/* ------------------------------------------------------------------ */
/*  Public API: network_stt                                            */
/* ------------------------------------------------------------------ */

stt_result_t network_stt(const uint8_t *audio_data, size_t audio_len)
{
    stt_result_t result = { .text = "", .success = false };

    if (!audio_data || audio_len == 0) {
        ESP_LOGE(TAG, "STT: no audio data");
        return result;
    }

    ESP_LOGI(TAG, "STT: sending %zu bytes of audio", audio_len);

    /* Construct full URL */
    char url[300];
    snprintf(url, sizeof(url), "%s/v1/audio/transcriptions", s_base_url);

    /* Build multipart part header */
    char part_header[256];
    int part_header_len = snprintf(part_header, sizeof(part_header),
        "--%s\r\n"
        "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n"
        "Content-Type: audio/wav\r\n"
        "\r\n",
        MULTIPART_BOUNDARY);

    /* Build multipart tail */
    char part_tail[64];
    int part_tail_len = snprintf(part_tail, sizeof(part_tail),
        "\r\n--%s--\r\n",
        MULTIPART_BOUNDARY);

    /* WAV header */
    uint8_t wav_header[WAV_HEADER_SIZE];
    build_wav_header(wav_header, audio_len);

    /* Total content length */
    size_t content_length = part_header_len + WAV_HEADER_SIZE + audio_len
                            + part_tail_len;

    /* Configure HTTP client */
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .buffer_size = HTTP_BUFFER_SIZE,
        .buffer_size_tx = HTTP_BUFFER_SIZE_TX,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "STT: failed to init HTTP client");
        return result;
    }

    /* Set Content-Type with boundary */
    char content_type[128];
    snprintf(content_type, sizeof(content_type),
             "multipart/form-data; boundary=%s", MULTIPART_BOUNDARY);
    esp_http_client_set_header(client, "Content-Type", content_type);

    /* Open connection with content length */
    esp_err_t err = esp_http_client_open(client, content_length);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "STT: HTTP open failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return result;
    }

    /* Write multipart body */
    esp_http_client_write(client, part_header, part_header_len);
    esp_http_client_write(client, (const char *)wav_header, WAV_HEADER_SIZE);

    /* Write audio data in chunks */
    size_t offset = 0;
    while (offset < audio_len) {
        size_t to_write = audio_len - offset;
        if (to_write > HTTP_BUFFER_SIZE_TX) {
            to_write = HTTP_BUFFER_SIZE_TX;
        }
        int written = esp_http_client_write(client,
                                             (const char *)(audio_data + offset),
                                             to_write);
        if (written < 0) {
            ESP_LOGE(TAG, "STT: failed to write audio data");
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return result;
        }
        offset += written;
    }

    esp_http_client_write(client, part_tail, part_tail_len);

    /* Read response */
    char *response = (char *)psram_malloc(STT_RESPONSE_MAX);
    if (!response) {
        ESP_LOGE(TAG, "STT: failed to allocate response buffer");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    int read_len = read_response(client, response, STT_RESPONSE_MAX - 1);
    int status = esp_http_client_get_status_code(client);

    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status != 200 || read_len <= 0) {
        ESP_LOGE(TAG, "STT: HTTP error %d, response: %s", status,
                 read_len > 0 ? response : "(empty)");
        free(response);
        return result;
    }

    /* Parse JSON response: {"text": "..."} */
    cJSON *json = cJSON_Parse(response);
    free(response);

    if (!json) {
        ESP_LOGE(TAG, "STT: JSON parse failed");
        return result;
    }

    cJSON *text_item = cJSON_GetObjectItem(json, "text");
    if (cJSON_IsString(text_item)) {
        strncpy(result.text, text_item->valuestring,
                sizeof(result.text) - 1);
        result.text[sizeof(result.text) - 1] = '\0';
        result.success = true;
        ESP_LOGI(TAG, "STT result: %s", result.text);
    } else {
        ESP_LOGE(TAG, "STT: no 'text' field in response");
    }

    cJSON_Delete(json);
    return result;
}

/* ------------------------------------------------------------------ */
/*  Public API: network_chat                                           */
/* ------------------------------------------------------------------ */

chat_result_t network_chat(const char *text)
{
    chat_result_t result = { .text = "", .success = false };

    if (!text || strlen(text) == 0) {
        ESP_LOGE(TAG, "Chat: empty text");
        return result;
    }

    ESP_LOGI(TAG, "Chat: sending text: %s", text);

    /* Construct full URL */
    char url[300];
    snprintf(url, sizeof(url), "%s/v1/chat/completions", s_base_url);

    /* Build JSON request body using cJSON */
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "model", "mona");
    cJSON_AddBoolToObject(body, "stream", false);

    cJSON *messages = cJSON_CreateArray();
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "role", "user");
    cJSON_AddStringToObject(msg, "content", text);
    cJSON_AddItemToArray(messages, msg);
    cJSON_AddItemToObject(body, "messages", messages);

    char *body_str = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);

    if (!body_str) {
        ESP_LOGE(TAG, "Chat: failed to build JSON body");
        return result;
    }

    size_t body_len = strlen(body_str);

    /* Configure HTTP client */
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .buffer_size = HTTP_BUFFER_SIZE,
        .buffer_size_tx = HTTP_BUFFER_SIZE_TX,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "Chat: failed to init HTTP client");
        free(body_str);
        return result;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");

    /* Open and write request body */
    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Chat: HTTP open failed: %s", esp_err_to_name(err));
        free(body_str);
        esp_http_client_cleanup(client);
        return result;
    }

    int written = esp_http_client_write(client, body_str, body_len);
    free(body_str);

    if (written < 0) {
        ESP_LOGE(TAG, "Chat: failed to write request body");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    /* Read response */
    char *response = (char *)psram_malloc(CHAT_RESPONSE_MAX);
    if (!response) {
        ESP_LOGE(TAG, "Chat: failed to allocate response buffer");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    int read_len = read_response(client, response, CHAT_RESPONSE_MAX - 1);
    int status = esp_http_client_get_status_code(client);

    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status != 200 || read_len <= 0) {
        ESP_LOGE(TAG, "Chat: HTTP error %d, response: %s", status,
                 read_len > 0 ? response : "(empty)");
        free(response);
        return result;
    }

    /* Parse JSON response: choices[0].message.content */
    cJSON *json = cJSON_Parse(response);
    free(response);

    if (!json) {
        ESP_LOGE(TAG, "Chat: JSON parse failed");
        return result;
    }

    cJSON *choices = cJSON_GetObjectItem(json, "choices");
    if (!cJSON_IsArray(choices) || cJSON_GetArraySize(choices) == 0) {
        ESP_LOGE(TAG, "Chat: no 'choices' array in response");
        cJSON_Delete(json);
        return result;
    }

    cJSON *first_choice = cJSON_GetArrayItem(choices, 0);
    cJSON *message = cJSON_GetObjectItem(first_choice, "message");
    if (!message) {
        /* Try delta format (streaming compatibility) */
        message = cJSON_GetObjectItem(first_choice, "delta");
    }

    cJSON *content_item = message ? cJSON_GetObjectItem(message, "content") : NULL;

    if (cJSON_IsString(content_item)) {
        strncpy(result.text, content_item->valuestring,
                sizeof(result.text) - 1);
        result.text[sizeof(result.text) - 1] = '\0';
        result.success = true;
        ESP_LOGI(TAG, "Chat reply: %s", result.text);
    } else {
        ESP_LOGE(TAG, "Chat: no 'content' field in response");
    }

    cJSON_Delete(json);
    return result;
}

/* ------------------------------------------------------------------ */
/*  Public API: network_tts                                            */
/* ------------------------------------------------------------------ */

tts_result_t network_tts(const char *text)
{
    tts_result_t result = { .data = NULL, .len = 0, .success = false };

    if (!text || strlen(text) == 0) {
        ESP_LOGE(TAG, "TTS: empty text");
        return result;
    }

    ESP_LOGI(TAG, "TTS: synthesizing speech for: %s", text);

    /* Construct full URL */
    char url[300];
    snprintf(url, sizeof(url), "%s/v1/audio/speech", s_base_url);

    /* Build JSON request body using cJSON */
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "input", text);
    cJSON_AddStringToObject(body, "voice", "zh-CN-XiaoyiNeural");

    char *body_str = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);

    if (!body_str) {
        ESP_LOGE(TAG, "TTS: failed to build JSON body");
        return result;
    }

    size_t body_len = strlen(body_str);

    /* Configure HTTP client */
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .buffer_size = HTTP_BUFFER_SIZE,
        .buffer_size_tx = HTTP_BUFFER_SIZE_TX,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "TTS: failed to init HTTP client");
        free(body_str);
        return result;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");

    /* Open and write request body */
    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "TTS: HTTP open failed: %s", esp_err_to_name(err));
        free(body_str);
        esp_http_client_cleanup(client);
        return result;
    }

    int written = esp_http_client_write(client, body_str, body_len);
    free(body_str);

    if (written < 0) {
        ESP_LOGE(TAG, "TTS: failed to write request body");
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    /* Fetch response headers to get content length */
    int content_len = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    if (status != 200) {
        ESP_LOGE(TAG, "TTS: HTTP error %d", status);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    /* Determine buffer size */
    size_t buf_size;
    if (content_len > 0 && content_len <= TTS_RESPONSE_MAX) {
        buf_size = content_len;
    } else {
        buf_size = TTS_RESPONSE_MAX;
    }

    /* Allocate response buffer from PSRAM */
    uint8_t *audio_buf = (uint8_t *)psram_malloc(buf_size);
    if (!audio_buf) {
        ESP_LOGE(TAG, "TTS: failed to allocate audio buffer (%zu bytes)",
                 buf_size);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return result;
    }

    /* Read binary audio response in chunks */
    size_t total_read = 0;
    while (total_read < buf_size) {
        size_t to_read = buf_size - total_read;
        if (to_read > TTS_READ_CHUNK) {
            to_read = TTS_READ_CHUNK;
        }
        int read_len = esp_http_client_read(client,
                                             (char *)(audio_buf + total_read),
                                             to_read);
        if (read_len <= 0) break;
        total_read += read_len;
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (total_read == 0) {
        ESP_LOGE(TAG, "TTS: no audio data received");
        free(audio_buf);
        return result;
    }

    result.data = audio_buf;
    result.len = total_read;
    result.success = true;

    ESP_LOGI(TAG, "TTS complete: %zu bytes of audio", total_read);
    return result;
}
