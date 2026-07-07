/**
 * @file audio.h
 * @brief I2S audio driver — INMP441 microphone + MAX98357A speaker
 *
 * Hardware connections (ESP32-S3):
 *   I2S_BCLK     -> GPIO4  (shared bit clock)
 *   I2S_WS       -> GPIO5  (shared word select / LR clock)
 *   I2S_DATA_IN  -> GPIO6  (INMP441 microphone data out)
 *   I2S_DATA_OUT -> GPIO7  (MAX98357A speaker data in)
 *
 * Audio format: 16kHz, 16-bit, Mono
 * Full-duplex on I2S_NUM_0 (TX + RX channels share BCLK/WS)
 */
#ifndef AUDIO_H
#define AUDIO_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* ---- Pin assignments ---- */
#define I2S_BCLK      4   /* Bit clock (shared) */
#define I2S_WS        5   /* Word select / LR clock (shared) */
#define I2S_DATA_IN   6   /* Data in from INMP441 microphone */
#define I2S_DATA_OUT  7   /* Data out to MAX98357A speaker */

/* ---- Audio parameters ---- */
#define AUDIO_SAMPLE_RATE      16000   /* 16 kHz */
#define AUDIO_BITS_PER_SAMPLE  16      /* 16-bit */
#define AUDIO_CHANNELS         1       /* Mono */

/* Bytes per second: 16000 * 2 = 32000 bytes/s */
#define AUDIO_BYTES_PER_SEC  (AUDIO_SAMPLE_RATE * (AUDIO_BITS_PER_SAMPLE / 8))

/* ---- VAD (Voice Activity Detection) parameters ---- */
#define VAD_THRESHOLD          500     /* RMS energy threshold (0-32768) */
#define VAD_SILENCE_MS         500     /* Silence duration to stop recording (ms) */
#define VAD_CHUNK_BYTES        1024    /* VAD detection chunk size in bytes (512 samples) */

/* ---- Recording buffer ---- */
/* 5 seconds max: 16000 * 2 * 5 = 160000 bytes (~160 KB) */
#define AUDIO_RECORD_MAX_BYTES  (AUDIO_SAMPLE_RATE * (AUDIO_BITS_PER_SAMPLE / 8) * 5)

/* ---- Playback ---- */
#define AUDIO_PLAYBACK_CHUNK    1024   /* Playback chunk size in bytes */

/**
 * @brief Initialize I2S for both microphone and speaker
 *
 * Configures I2S_NUM_0 in full-duplex standard mode with the pin
 * assignments defined above. Both TX (speaker) and RX (microphone)
 * channels are enabled.
 */
void audio_init(void);

/**
 * @brief Record audio with VAD (voice activity detection)
 *
 * Reads I2S data from the microphone, applies simple energy-based VAD,
 * and stops recording after 500ms of continuous silence following speech.
 * Also stops when the buffer is full or the timeout expires.
 *
 * @param buffer Output buffer (should be allocated in PSRAM)
 * @param max_bytes Maximum number of bytes to record
 * @param timeout_ms Maximum recording time in milliseconds
 * @return Number of bytes actually recorded
 */
size_t audio_record(uint8_t *buffer, size_t max_bytes, uint32_t timeout_ms);

/**
 * @brief Play audio data through the speaker
 *
 * Writes PCM audio data to the I2S TX channel in 1024-byte chunks.
 *
 * @param data Audio data (PCM 16-bit, 16kHz, mono)
 * @param len Data length in bytes
 */
void audio_play(const uint8_t *data, size_t len);

#endif /* AUDIO_H */
