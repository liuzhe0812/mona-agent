/**
 * @file display.h
 * @brief ST7789 SPI TFT display driver — 1.3" 240x240 RGB565
 *
 * Hardware connections (ESP32-S3-WROOM-1):
 *   MOSI (SDA) -> GPIO11
 *   SCLK       -> GPIO12
 *   CS         -> GPIO10
 *   DC         -> GPIO9
 *   RESET      -> GPIO14
 *   BLK (BL)   -> GPIO13
 *
 * SPI clock: 40 MHz.  Pixel format: RGB565 (16-bit).
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "driver/spi_master.h"
#include "sprites.h"          /* SCREEN_W, SCREEN_H */

/* ---- Pin assignments ---- */
#define LCD_MOSI    11
#define LCD_SCLK    12
#define LCD_CS      10
#define LCD_DC      9
#define LCD_RST     14
#define LCD_BL      13

/* ---- SPI configuration ---- */
#define LCD_SPI_HOST    SPI2_HOST
#define LCD_SPI_FREQ_HZ (40 * 1000 * 1000)  /* 40 MHz */

/* ---- Colour helpers ---- */

/** Pack an RGB888 triplet into a native uint16_t RGB565 value. */
#define COLOR565(r, g, b)  (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3))

/** Swap the two bytes of a 16-bit value (for ST7789 big-endian bus). */
#define BYTE_SWAP16(x) (uint16_t)(((uint16_t)(x) >> 8) | ((uint16_t)(x) << 8))

/* Common colours (native RGB565) */
#define COLOR_BLACK   0x0000
#define COLOR_WHITE   0xFFFF
#define COLOR_BG      COLOR565(26, 26, 58)     /* dark blue background */

/* ---- Public API ---- */

/**
 * @brief Initialise the SPI bus, GPIO pins, and ST7789 panel.
 *
 * Performs hardware reset, sends the ST7789 init sequence, turns on
 * the display and backlight, and clears the screen to black.
 *
 * @return ESP_OK on success.
 */
esp_err_t display_init(void);

/**
 * @brief Draw an RGB565 bitmap to the screen.
 *
 * The pixel data must be in big-endian (ST7789-native) byte order,
 * i.e. each uint16_t has already been passed through BYTE_SWAP16().
 * This allows the data to be transmitted directly via SPI DMA without
 * per-pixel swapping.
 *
 * Coordinates are clipped to the screen.
 *
 * @param x    Destination X (left).
 * @param y    Destination Y (top).
 * @param w    Bitmap width in pixels.
 * @param h    Bitmap height in pixels.
 * @param data Pointer to w*h RGB565 pixels (big-endian).
 */
void display_draw_bitmap(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                         const uint16_t *data);

/**
 * @brief Fill a rectangular area with a solid colour.
 * @param x     Top-left X.
 * @param y     Top-left Y.
 * @param w     Width.
 * @param h     Height.
 * @param color RGB565 colour (native endianness — swapped internally).
 */
void display_fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                       uint16_t color);

/**
 * @brief Fill an ellipse using the midpoint ellipse algorithm.
 *
 * The ellipse is centred at (cx, cy) with semi-axes rx and ry.
 * Boundary pixels are computed with the integer midpoint algorithm;
 * each scan-line span is then filled via display_fill_rect().
 *
 * @param cx    Centre X.
 * @param cy    Centre Y.
 * @param rx    Horizontal radius (semi-axis).
 * @param ry    Vertical radius (semi-axis).
 * @param color RGB565 colour (native endianness — swapped internally).
 */
void display_fill_ellipse(uint16_t cx, uint16_t cy, uint16_t rx, uint16_t ry,
                          uint16_t color);

/**
 * @brief Set the active drawing window (column / row address + RAM write).
 *
 * After calling this function, subsequent pixel data sent on the SPI
 * bus will be written into the specified rectangle, left-to-right,
 * top-to-bottom.
 *
 * @param x Top-left X.
 * @param y Top-left Y.
 * @param w Width.
 * @param h Height.
 */
void display_set_window(uint16_t x, uint16_t y, uint16_t w, uint16_t h);

/**
 * @brief Turn the backlight on or off.
 * @param on true = on, false = off.
 */
void display_set_backlight(bool on);
