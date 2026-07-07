/**
 * @file animation.h
 * @brief Character animation state machine — blink, mouth, breathing
 *
 * The animation subsystem drives the display at a fixed frame rate,
 * rendering the appropriate sprite for the current state and overlaying
 * real-time effects (eye blinks, mouth movement, breathing offset).
 *
 * States: IDLE, LISTENING, THINKING, SPEAKING, HAPPY
 *
 * Usage:
 *   animation_init();       // call once at startup
 *   animation_start();      // spawns the FreeRTOS render task
 *   animation_set_state(LISTENING);
 *
 * animation_tick() may also be called manually from a main loop instead
 * of using animation_start().
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "sprites.h"          /* state_t */

/**
 * @brief Initialise the animation subsystem.
 *
 * Must be called after display_init() and sprite_init().
 * Sets the initial state to IDLE and schedules the first blink.
 */
void animation_init(void);

/**
 * @brief Start the FreeRTOS animation render task.
 *
 * The task calls animation_tick() at ~20 fps.  After calling this
 * function, manual calls to animation_tick() are unnecessary.
 */
void animation_start(void);

/**
 * @brief Set the character state.
 *
 * Thread-safe — may be called from any task.  Triggers a full
 * sprite redraw on the next tick.
 *
 * @param state New state (IDLE, LISTENING, THINKING, SPEAKING, HAPPY).
 */
void animation_set_state(state_t state);

/**
 * @brief Get the current character state.
 * @return Current state_t value.
 */
state_t animation_get_state(void);

/**
 * @brief Advance the animation by one frame.
 *
 * Called automatically by the render task (via animation_start()),
 * or manually from a main loop.  Handles:
 *
 *   - Breathing: subtle vertical offset (±1 px) via sinf(), IDLE only
 *   - Blink:     150 ms closed, random 2.5–5 s interval, IDLE only
 *   - Mouth:     200 ms open/close cycle, SPEAKING only
 *   - Dirty-rectangle rendering for performance
 *
 * @param timestamp_ms Current time in milliseconds (e.g. from
 *                     esp_timer_get_time() / 1000 or
 *                     xTaskGetTickCount() * portTICK_PERIOD_MS).
 */
void animation_tick(uint32_t timestamp_ms);
