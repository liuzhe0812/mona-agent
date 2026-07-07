/**
 * @file sprites.c
 * @brief Placeholder sprite data — generated into PSRAM at startup
 *
 * Since the actual sprite artwork exists as 1024x1024 JPGs that require
 * offline conversion to 240x240 RGB565, this file generates simple
 * placeholder images programmatically.  Each placeholder consists of:
 *
 *   - A filled circle for the face (skin colour)
 *   - Two filled ellipses for the eyes (dark colour)
 *   - A filled ellipse for the mouth (mouth colour)
 *
 * The eye and mouth positions/sizes vary per state to match the
 * region_t arrays defined below.
 *
 * All pixel data is stored in big-endian (ST7789-native) byte order
 * so it can be sent directly via SPI DMA without per-pixel swapping.
 */

#include "sprites.h"
#include "display.h"          /* COLOR565, BYTE_SWAP16 */
#include "esp_log.h"
#include "esp_heap_caps.h"
#include <math.h>
#include <string.h>

static const char *TAG = "SPRITES";

/* ---- Region data (matches simulator defaults) ---- */

const region_t eye_regions[STATE_COUNT] = {
    /* IDLE      */ { 78, 88, 24, 16 },
    /* LISTENING */ { 78, 85, 24, 18 },
    /* THINKING  */ { 82, 88, 24, 16 },
    /* SPEAKING  */ { 78, 88, 24, 16 },
    /* HAPPY     */ { 78, 85, 24, 12 },
};

const region_t right_eye_regions[STATE_COUNT] = {
    /* IDLE      */ { 138, 88, 24, 16 },
    /* LISTENING */ { 138, 85, 24, 18 },
    /* THINKING  */ { 142, 88, 24, 16 },
    /* SPEAKING  */ { 138, 88, 24, 16 },
    /* HAPPY     */ { 138, 85, 24, 12 },
};

const region_t mouth_regions[STATE_COUNT] = {
    /* IDLE      */ { 108, 142, 24, 12 },
    /* LISTENING */ { 108, 140, 26, 14 },
    /* THINKING  */ { 110, 144, 22, 10 },
    /* SPEAKING  */ { 108, 140, 26, 16 },
    /* HAPPY     */ { 106, 138, 28, 18 },
};

/* ---- PSRAM sprite buffers ---- */
static uint16_t *s_sprites[STATE_COUNT] = { NULL };

/* ---- Placeholder colours (native RGB565) ---- */
#define PH_BG_COLOR     COLOR565(26, 26, 58)       /* dark blue background */
#define PH_FACE_COLOR   COLOR565(255, 228, 220)    /* warm skin tone       */
#define PH_EYE_COLOR    COLOR565(50, 40, 60)       /* dark eye             */
#define PH_MOUTH_COLOR  COLOR565(154, 58, 74)      /* muted mouth red      */
#define PH_CHEEK_COLOR  COLOR565(255, 160, 140)    /* subtle cheek blush   */

/* Face geometry */
#define FACE_CX         120
#define FACE_CY         120
#define FACE_RADIUS     100

/* ===================================================================
 *  Helpers
 * =================================================================== */

/** Convert a native RGB565 colour to big-endian for ST7789. */
static inline uint16_t to_be(uint16_t color)
{
    return BYTE_SWAP16(color);
}

/**
 * Fill an ellipse in a sprite buffer (algebraic test).
 * Used only during placeholder generation — not performance-critical.
 */
static void fill_ellipse_in_sprite(uint16_t *sprite, int cx, int cy,
                                   int rx, int ry, uint16_t color_be)
{
    if (rx <= 0 || ry <= 0) return;
    for (int py = cy - ry; py <= cy + ry; py++) {
        if (py < 0 || py >= SCREEN_H) continue;
        for (int px = cx - rx; px <= cx + rx; px++) {
            if (px < 0 || px >= SCREEN_W) continue;
            float dx = (float)(px - cx) / rx;
            float dy = (float)(py - cy) / ry;
            if (dx * dx + dy * dy <= 1.0f) {
                sprite[py * SCREEN_W + px] = color_be;
            }
        }
    }
}

/**
 * Draw a horizontal arc (gentle downward curve) in a sprite buffer.
 * Used for closed-eye rendering in the HAPPY state.
 */
static void draw_arc_in_sprite(uint16_t *sprite, int cx, int cy,
                               int w, uint16_t color_be)
{
    int half = w / 2;
    for (int dx = -half; dx <= half; dx++) {
        int py = cy + (int)lroundf(2.0f * sinf((float)(dx + half) / w * M_PI));
        int px = cx + dx;
        if (px >= 0 && px < SCREEN_W && py >= 0 && py < SCREEN_H) {
            sprite[py * SCREEN_W + px] = color_be;
        }
    }
}

/* ===================================================================
 *  Per-state placeholder generation
 * =================================================================== */

/**
 * Generate one placeholder sprite for the given state.
 *
 * The base image (face circle + cheeks) is the same for all states;
 * only the eyes and mouth differ, using the region_t arrays.
 */
static void generate_sprite(state_t state)
{
    uint16_t *sprite = s_sprites[state];
    if (!sprite) return;

    uint16_t bg_be     = to_be(PH_BG_COLOR);
    uint16_t face_be   = to_be(PH_FACE_COLOR);
    uint16_t eye_be    = to_be(PH_EYE_COLOR);
    uint16_t mouth_be  = to_be(PH_MOUTH_COLOR);
    uint16_t cheek_be  = to_be(PH_CHEEK_COLOR);

    /* ---- Fill background ---- */
    for (int i = 0; i < SPRITE_PIXELS; i++) {
        sprite[i] = bg_be;
    }

    /* ---- Draw face circle ---- */
    for (int y = 0; y < SCREEN_H; y++) {
        for (int x = 0; x < SCREEN_W; x++) {
            int dx = x - FACE_CX;
            int dy = y - FACE_CY;
            if (dx * dx + dy * dy <= FACE_RADIUS * FACE_RADIUS) {
                sprite[y * SCREEN_W + x] = face_be;
            }
        }
    }

    /* ---- Cheek blush (two small ellipses) ---- */
    fill_ellipse_in_sprite(sprite, 72, 128, 12, 8, cheek_be);
    fill_ellipse_in_sprite(sprite, 168, 128, 12, 8, cheek_be);

    /* ---- Eyes ---- */
    region_t le = eye_regions[state];
    region_t re = right_eye_regions[state];

    if (state == HAPPY) {
        /* Happy: draw upward arcs (closed smiling eyes) */
        draw_arc_in_sprite(sprite, le.x + le.w / 2, le.y + le.h / 2,
                           le.w, eye_be);
        draw_arc_in_sprite(sprite, re.x + re.w / 2, re.y + re.h / 2,
                           re.w, eye_be);
    } else {
        /* Other states: filled ellipses for eyes */
        fill_ellipse_in_sprite(sprite,
                               le.x + le.w / 2, le.y + le.h / 2,
                               le.w / 2, le.h / 2, eye_be);
        fill_ellipse_in_sprite(sprite,
                               re.x + re.w / 2, re.y + re.h / 2,
                               re.w / 2, re.h / 2, eye_be);
    }

    /* ---- Mouth ---- */
    region_t m = mouth_regions[state];

    switch (state) {
    case IDLE:
        /* Small neutral mouth (thin ellipse) */
        fill_ellipse_in_sprite(sprite,
                               m.x + m.w / 2, m.y + m.h / 2,
                               m.w / 2, m.h / 4, mouth_be);
        break;

    case LISTENING:
        /* Slightly open, rounded mouth */
        fill_ellipse_in_sprite(sprite,
                               m.x + m.w / 2, m.y + m.h / 2,
                               m.w / 2, m.h / 2, mouth_be);
        break;

    case THINKING:
        /* Small pursed mouth (offset to one side) */
        fill_ellipse_in_sprite(sprite,
                               m.x + m.w / 2 + 2, m.y + m.h / 2,
                               m.w / 3, m.h / 3, mouth_be);
        break;

    case SPEAKING:
        /* Open mouth, ready for animation */
        fill_ellipse_in_sprite(sprite,
                               m.x + m.w / 2, m.y + m.h / 2,
                               m.w / 2, m.h / 2, mouth_be);
        break;

    case HAPPY:
        /* Wide smile (filled ellipse, wider than tall) */
        fill_ellipse_in_sprite(sprite,
                               m.x + m.w / 2, m.y + m.h / 2,
                               m.w / 2, m.h / 2, mouth_be);
        break;

    default:
        break;
    }
}

/* ===================================================================
 *  Public API
 * =================================================================== */

bool sprite_init(void)
{
    ESP_LOGI(TAG, "Allocating %d sprites in PSRAM (%d bytes each)...",
             STATE_COUNT, SPRITE_BYTES);

    for (int i = 0; i < STATE_COUNT; i++) {
        s_sprites[i] = (uint16_t *)heap_caps_malloc(SPRITE_BYTES,
                                                     MALLOC_CAP_SPIRAM);
        if (!s_sprites[i]) {
            ESP_LOGE(TAG, "PSRAM allocation failed for sprite %d", i);
            /* Free any already-allocated sprites */
            for (int j = 0; j < i; j++) {
                free(s_sprites[j]);
                s_sprites[j] = NULL;
            }
            return false;
        }
    }

    ESP_LOGI(TAG, "Generating placeholder sprite artwork...");
    for (int i = 0; i < STATE_COUNT; i++) {
        generate_sprite((state_t)i);
    }

    ESP_LOGI(TAG, "Sprites ready (%d states, %d KB total)",
             STATE_COUNT, STATE_COUNT * SPRITE_BYTES / 1024);
    return true;
}

const uint16_t *sprite_get(state_t state)
{
    if (state < 0 || state >= STATE_COUNT) return NULL;
    return s_sprites[state];
}
