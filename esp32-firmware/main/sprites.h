/**
 * @file sprites.h
 * @brief Sprite data management for 5 character states (240x240 RGB565)
 *
 * Each sprite is 240x240 RGB565 = 115,200 bytes, allocated in PSRAM at
 * startup by sprite_init().  Placeholder sprites with simple face shapes
 * are generated programmatically; replace with converted JPG data later.
 *
 * State / region definitions match the Mona simulator defaults so that
 * eye-blink and mouth-open overlays align with the sprite artwork.
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>

/* ---- Screen dimensions ---- */
#define SCREEN_W 240
#define SCREEN_H 240

/* Total pixels and bytes per sprite */
#define SPRITE_PIXELS (SCREEN_W * SCREEN_H)
#define SPRITE_BYTES  (SPRITE_PIXELS * 2)

/* ---- Character states ---- */
typedef enum {
    IDLE = 0,
    LISTENING,
    THINKING,
    SPEAKING,
    HAPPY,
    STATE_COUNT
} state_t;

/* ---- Region descriptor (eyes, mouth) ---- */
typedef struct {
    uint16_t x;  /* top-left X */
    uint16_t y;  /* top-left Y */
    uint16_t w;  /* width      */
    uint16_t h;  /* height     */
} region_t;

/*
 * Eye and mouth regions for each state.
 * eye_regions[]        — left eye bounding box
 * right_eye_regions[]  — right eye bounding box
 * mouth_regions[]      — mouth bounding box
 *
 * Values match the simulator defaults:
 *   idle:      L(78,88,24,16)  R(138,88,24,16)  M(108,142,24,12)
 *   listening: L(78,85,24,18)  R(138,85,24,18)  M(108,140,26,14)
 *   thinking:  L(82,88,24,16)  R(142,88,24,16)  M(110,144,22,10)
 *   speaking:  L(78,88,24,16)  R(138,88,24,16)  M(108,140,26,16)
 *   happy:     L(78,85,24,12)  R(138,85,24,12)  M(106,138,28,18)
 */
extern const region_t eye_regions[STATE_COUNT];
extern const region_t right_eye_regions[STATE_COUNT];
extern const region_t mouth_regions[STATE_COUNT];

/**
 * @brief Initialise sprites — allocate PSRAM buffers and generate
 *        placeholder face images.
 * @return true on success, false if PSRAM allocation fails.
 */
bool sprite_init(void);

/**
 * @brief Get a pointer to the RGB565 pixel data for a given state.
 *
 * Data is stored in big-endian (ST7789-native) byte order so it can
 * be sent directly to the display via SPI without swapping.
 *
 * @param state  Character state (IDLE … HAPPY).
 * @return Pointer to 240*240 uint16_t pixels, or NULL if not initialised.
 */
const uint16_t *sprite_get(state_t state);
