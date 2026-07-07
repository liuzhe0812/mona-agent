/**
 * @file network.h
 * @brief HTTP network communication — Mona API (STT / Chat / TTS)
 *
 * API endpoints (OpenAI-compatible):
 *   POST /v1/audio/transcriptions  — Speech to text
 *   POST /v1/chat/completions      — Chat (non-streaming)
 *   POST /v1/audio/speech          — Text to speech
 *
 * All functions are blocking and should be called from a FreeRTOS task.
 */
#ifndef NETWORK_H
#define NETWORK_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Default Mona API base URL */
#define MONA_API_DEFAULT_URL  "http://192.168.1.100:17173"

/* ---- Result types ---- */

/** Speech-to-text result */
typedef struct {
    char    text[1024];   /* Recognized text */
    bool    success;      /* true if request succeeded */
} stt_result_t;

/** Chat completion result */
typedef struct {
    char    text[2048];   /* AI reply text */
    bool    success;      /* true if request succeeded */
} chat_result_t;

/** Text-to-speech result */
typedef struct {
    uint8_t *data;        /* Audio data (PSRAM-allocated, caller must free) */
    size_t   len;         /* Audio data length in bytes */
    bool     success;     /* true if request succeeded */
} tts_result_t;

/**
 * @brief Initialize the network module
 * @param base_url Mona API base URL (e.g. "http://192.168.1.100:17173")
 *                 Pass NULL to use the default URL.
 */
void network_init(const char *base_url);

/**
 * @brief Speech to text — POST /v1/audio/transcriptions
 *
 * Sends raw PCM audio as a WAV file via multipart/form-data.
 *
 * @param audio_data PCM audio data (16-bit, 16kHz, mono)
 * @param audio_len  Audio data length in bytes
 * @return stt_result_t with recognized text
 */
stt_result_t network_stt(const uint8_t *audio_data, size_t audio_len);

/**
 * @brief Chat completion — POST /v1/chat/completions (non-streaming)
 *
 * Sends user text and returns the AI reply.
 *
 * @param text User input text
 * @return chat_result_t with AI reply
 */
chat_result_t network_chat(const char *text);

/**
 * @brief Text to speech — POST /v1/audio/speech
 *
 * Synthesizes speech from text and returns raw audio bytes.
 *
 * @param text Text to synthesize
 * @return tts_result_t with audio data (caller must free .data)
 */
tts_result_t network_tts(const char *text);

#endif /* NETWORK_H */
