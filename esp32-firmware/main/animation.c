/**
 * @file animation.c
 * @brief Character animation state machine implementation
 *
 * Drives the ST7789 display with per-state sprite rendering plus
 * real-time overlays:
 *
 *   Breathing  — subtle ±1 px vertical offset via sinf(), IDLE only.
 *                Period: 3 s.  Triggers a full redraw when the offset
 *                changes (≈ 4 times per period).
 *
 *   Blink      — 150 ms closed, random 2.5–5 s interval, IDLE only.
 *                Closed eye = skin-colour ellipse + arc drawn with
 *                display_fill_ellipse() + display_fill_rect().
 *
 *   Mouth      — 200 ms open/close cycle, SPEAKING only.
 *                Open mouth = display_fill_ellipse() with mouth colour.
 *
 * Rendering uses dirty-rectangle optimisation: a full sprite redraw
 * only occurs on state change or breathing-offset change; eye and
 * mouth overlays are applied/restored incrementally.
 *
 * A FreeRTOS task (animation_start) calls animation_tick() at 20 fps.
 * animation_set_state() is thread-safe via a mutex.
 */

#include "animation.h"
#include "display.h"
#include "sprites.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "ANIM";

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---- Animation colours (RGB565, native endianness) ---- */
#define COLOR_SKIN      0xFD59
#define COLOR_EYE_LINE  0x3186
#define COLOR_MOUTH     0xB152
#define COLOR_MOUTH_DK  0x7A32

/* ---- Timing parameters ---- */
#define BLINK_DURATION_MS    150     /* eyes closed duration         */
#define BLINK_MIN_INTERVAL   2500    /* min gap between blinks (ms)  */
#define BLINK_MAX_INTERVAL   5000    /* max gap between blinks (ms)  */
#define MOUTH_INTERVAL_MS    200     /* mouth toggle period (ms)     */
#define BREATH_PERIOD_MS     3000    /* breathing cycle (ms)         */
#define TARGET_FPS           20      /* render frame rate            */
#define ANIM_TASK_STACK      8192    /* FreeRTOS task stack (bytes)  */
#define ANIM_TASK_PRIORITY   5

/* ---- State ---- */
static SemaphoreHandle_t s_mutex         = NULL;
static state_t           s_current_state  = IDLE;
static state_t           s_rendered_state = STATE_COUNT;  /* force initial draw */
static uint32_t          s_state_start_ms = 0;

/* Blink */
static bool      s_blinking        = false;
static uint32_t  s_blink_start_ms  = 0;
static uint32_t  s_next_blink_ms   = 0;

/* Mouth */
static bool      s_mouth_open          = false;
static uint32_t  s_last_mouth_toggle_ms = 0;

/* Breathing */
static int       s_breath_offset  = 0;

/* Dirty flags */
static bool      s_full_redraw    = true;
static bool      s_eyes_dirty     = false;
static bool      s_mouth_dirty    = false;

/* ===================================================================
 *  Helpers
 * =================================================================== */

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static uint32_t random_range(uint32_t min_val, uint32_t max_val)
{
    return min_val + (esp_random() % (max_val - min_val + 1));
}

/* ===================================================================
 *  Rendering helpers
 * =================================================================== */

/**
 * Draw the full sprite for the given state, shifted vertically by
 * y_offset pixels (breathing).  Exposed rows are filled with the
 * background colour.
 */
static void render_full(state_t state, int y_offset)
{
    const uint16_t *sprite = sprite_get(state);
    if (!sprite) return;

    if (y_offset == 0) {
        display_draw_bitmap(0, 0, SCREEN_W, SCREEN_H, sprite);
    } else if (y_offset > 0) {
        /* Shift down: fill top strip, draw sprite below it */
        display_fill_rect(0, 0, SCREEN_W, (uint16_t)y_offset, COLOR_BG);
        display_draw_bitmap(0, (uint16_t)y_offset, SCREEN_W,
                            (uint16_t)(SCREEN_H - y_offset), sprite);
    } else {
        /* Shift up: skip first |offset| rows, fill bottom strip */
        int skip = -y_offset;
        display_draw_bitmap(0, 0, SCREEN_W,
                            (uint16_t)(SCREEN_H - skip),
                            sprite + (size_t)skip * SCREEN_W);
        display_fill_rect(0, (uint16_t)(SCREEN_H - skip), SCREEN_W,
                          (uint16_t)skip, COLOR_BG);
    }
}

/**
 * Draw a gentle arc (closed-eye curve) centred at (cx, cy).
 * The arc dips downward by ~1.5 px at the centre, simulating a
 * closed eyelid.
 */
static void draw_eye_arc(int cx, int cy, int w)
{
    int half = w / 2;
    for (int dx = -half; dx <= half; dx++) {
        int py = cy + (int)lroundf(
            1.5f * sinf((float)(dx + half) / (float)w * (float)M_PI));
        int px = cx + dx;
        if (px >= 0 && px < SCREEN_W && py >= 0 && py < SCREEN_H) {
            display_fill_rect((uint16_t)px, (uint16_t)py, 1, 1,
                              COLOR_EYE_LINE);
        }
    }
}

/**
 * Draw closed eyes for the given state: fill each eye region with
 * skin colour (to erase the open eye), then draw the arc on top.
 */
static void draw_closed_eyes(state_t state, int y_offset)
{
    region_t le = eye_regions[state];
    region_t re = right_eye_regions[state];

    int le_cx = le.x + le.w / 2;
    int le_cy = le.y + le.h / 2 + y_offset;
    int re_cx = re.x + re.w / 2;
    int re_cy = re.y + re.h / 2 + y_offset;

    /* Erase open eyes with skin colour */
    display_fill_ellipse((uint16_t)le_cx, (uint16_t)le_cy,
                         le.w / 2, le.h / 2, COLOR_SKIN);
    display_fill_ellipse((uint16_t)re_cx, (uint16_t)re_cy,
                         re.w / 2, re.h / 2, COLOR_SKIN);

    /* Draw closed-eye arcs */
    draw_eye_arc(le_cx, le_cy, le.w);
    draw_eye_arc(re_cx, re_cy, re.w);
}

/**
 * Draw an open mouth for the given state using display_fill_ellipse.
 */
static void draw_open_mouth(state_t state, int y_offset)
{
    region_t m = mouth_regions[state];
    int mx = m.x + m.w / 2;
    int my = m.y + m.h / 2 + y_offset;

    display_fill_ellipse((uint16_t)mx, (uint16_t)my,
                         m.w / 2, m.h / 2, COLOR_MOUTH);
}

/**
 * Restore a rectangular region from the sprite data back to the
 * display.  Used to undo blink / mouth overlays.
 *
 * The sprite data is already in big-endian format, so it can be
 * passed directly to display_draw_bitmap().
 */
static void restore_region(region_t r, int y_offset)
{
    const uint16_t *sprite = sprite_get(s_rendered_state);
    if (!sprite) return;

    int w = r.w;
    int h = r.h;

    /* Allocate a contiguous buffer for the sub-rectangle */
    uint16_t *buf = (uint16_t *)malloc((size_t)w * h * sizeof(uint16_t));
    if (!buf) {
        ESP_LOGE(TAG, "restore_region: malloc failed");
        return;
    }

    /* Copy rows from the sprite (stride = SCREEN_W) */
    for (int row = 0; row < h; row++) {
        int sy = r.y + row;
        if (sy < 0 || sy >= SCREEN_H) continue;
        memcpy(buf + (size_t)row * w,
               sprite + (size_t)sy * SCREEN_W + r.x,
               (size_t)w * sizeof(uint16_t));
    }

    /* Draw at the offset position */
    int draw_y = (int)r.y + y_offset;
    if (draw_y < 0) {
        int skip = -draw_y;
        if (skip < h) {
            display_draw_bitmap(r.x, 0, (uint16_t)w,
                                (uint16_t)(h - skip),
                                buf + (size_t)skip * w);
        }
    } else {
        display_draw_bitmap(r.x, (uint16_t)draw_y,
                            (uint16_t)w, (uint16_t)h, buf);
    }

    free(buf);
}

/** Restore both eyes from sprite data. */
static void restore_eyes(state_t state, int y_offset)
{
    restore_region(eye_regions[state], y_offset);
    restore_region(right_eye_regions[state], y_offset);
}

/** Restore the mouth from sprite data. */
static void restore_mouth(state_t state, int y_offset)
{
    restore_region(mouth_regions[state], y_offset);
}

/* ===================================================================
 *  Public API
 * =================================================================== */

void animation_init(void)
{
    s_mutex = xSemaphoreCreateMutex();
    s_current_state  = IDLE;
    s_rendered_state = STATE_COUNT;   /* force first-frame full redraw */
    s_state_start_ms = now_ms();
    s_blinking       = false;
    s_mouth_open     = false;
    s_breath_offset  = 0;
    s_full_redraw    = true;
    s_eyes_dirty     = false;
    s_mouth_dirty    = false;
    s_next_blink_ms      = s_state_start_ms +
                           random_range(BLINK_MIN_INTERVAL, BLINK_MAX_INTERVAL);
    s_last_mouth_toggle_ms = s_state_start_ms;

    ESP_LOGI(TAG, "Animation initialised (state=IDLE, %d fps)", TARGET_FPS);
}

void animation_set_state(state_t state)
{
    if (state < 0 || state >= STATE_COUNT) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (state != s_current_state) {
        ESP_LOGI(TAG, "State change: %d -> %d", s_current_state, state);
        s_current_state  = state;
        s_state_start_ms = now_ms();
    }
    xSemaphoreGive(s_mutex);
}

state_t animation_get_state(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    state_t s = s_current_state;
    xSemaphoreGive(s_mutex);
    return s;
}

void animation_tick(uint32_t timestamp_ms)
{
    /* ---- Read current state (thread-safe) ---- */
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    state_t state       = s_current_state;
    uint32_t state_start = s_state_start_ms;
    xSemaphoreGive(s_mutex);

    /* ---- Detect state change ---- */
    if (state != s_rendered_state) {
        s_full_redraw = true;
        /* Reset sub-state for the new state */
        s_blinking       = false;
        s_mouth_open     = false;
        s_breath_offset  = 0;
        s_eyes_dirty     = false;
        s_mouth_dirty    = false;
        s_next_blink_ms       = timestamp_ms +
                                random_range(BLINK_MIN_INTERVAL, BLINK_MAX_INTERVAL);
        s_last_mouth_toggle_ms = timestamp_ms;
    }

    /* ---- Breathing (IDLE only) ---- */
    int new_breath = 0;
    if (state == IDLE) {
        float phase = 2.0f * (float)M_PI *
                      (float)(timestamp_ms - state_start) /
                      (float)BREATH_PERIOD_MS;
        new_breath = (int)lroundf(sinf(phase));
    }
    if (new_breath != s_breath_offset) {
        s_breath_offset = new_breath;
        s_full_redraw   = true;
    }

    /* ---- Blink (IDLE only) ---- */
    if (state == IDLE) {
        if (s_blinking) {
            if (timestamp_ms - s_blink_start_ms >= BLINK_DURATION_MS) {
                s_blinking     = false;
                s_eyes_dirty   = true;
                s_next_blink_ms = timestamp_ms +
                                  random_range(BLINK_MIN_INTERVAL,
                                               BLINK_MAX_INTERVAL);
            }
        } else {
            if (timestamp_ms >= s_next_blink_ms) {
                s_blinking      = true;
                s_blink_start_ms = timestamp_ms;
                s_eyes_dirty    = true;
            }
        }
    } else {
        if (s_blinking) {
            s_blinking   = false;
            s_eyes_dirty = true;
        }
    }

    /* ---- Mouth (SPEAKING only) ---- */
    if (state == SPEAKING) {
        if (timestamp_ms - s_last_mouth_toggle_ms >= MOUTH_INTERVAL_MS) {
            s_last_mouth_toggle_ms = timestamp_ms;
            s_mouth_open = !s_mouth_open;
            s_mouth_dirty = true;
        }
    } else {
        if (s_mouth_open) {
            s_mouth_open  = false;
            s_mouth_dirty = true;
        }
    }

    /* ---- Render ---- */
    if (s_full_redraw) {
        /* Full sprite redraw with breathing offset */
        render_full(state, s_breath_offset);
        s_rendered_state = state;
        s_full_redraw    = false;

        /* Re-apply current overlays at the new offset */
        if (s_blinking) {
            draw_closed_eyes(state, s_breath_offset);
        }
        if (s_mouth_open) {
            draw_open_mouth(state, s_breath_offset);
        }
        s_eyes_dirty  = false;
        s_mouth_dirty = false;
    } else {
        /* Incremental updates (dirty rectangles) */
        if (s_eyes_dirty) {
            if (s_blinking) {
                draw_closed_eyes(state, s_breath_offset);
            } else {
                restore_eyes(state, s_breath_offset);
            }
            s_eyes_dirty = false;
        }
        if (s_mouth_dirty) {
            if (s_mouth_open) {
                draw_open_mouth(state, s_breath_offset);
            } else {
                restore_mouth(state, s_breath_offset);
            }
            s_mouth_dirty = false;
        }
    }
}

/* ===================================================================
 *  FreeRTOS render task
 * =================================================================== */

static void animation_task(void *arg)
{
    ESP_LOGI(TAG, "Animation task started (%d fps)", TARGET_FPS);
    while (1) {
        animation_tick(now_ms());
        vTaskDelay(pdMS_TO_TICKS(1000 / TARGET_FPS));
    }
}

void animation_start(void)
{
    xTaskCreate(animation_task, "anim", ANIM_TASK_STACK, NULL,
                ANIM_TASK_PRIORITY, NULL);
    ESP_LOGI(TAG, "Animation task created");
}
