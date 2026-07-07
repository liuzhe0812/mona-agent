/**
 * @file display.c
 * @brief ST7789 SPI TFT display driver implementation — 240x240 RGB565
 *
 * Uses the ESP-IDF SPI Master driver in polling mode with DMA for
 * large pixel transfers.  All public drawing functions clip to the
 * 240x240 screen.
 *
 * Byte-order convention:
 *   The ST7789 expects 16-bit pixels big-endian (high byte first) on
 *   the SPI bus.  The ESP32-S3 is little-endian, so a native uint16_t
 *   value 0xFD59 is stored in memory as [0x59, 0xFD] and would be
 *   transmitted low-byte-first.
 *
 *   To avoid per-pixel swapping during bitmap transfers, sprite data
 *   in PSRAM is stored pre-swapped (BYTE_SWAP16).  display_draw_bitmap()
 *   sends the raw bytes directly.  display_fill_rect() and
 *   display_fill_ellipse() swap the colour once before filling their
 *   line buffers.
 */

#include "display.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <math.h>

static const char *TAG = "DISPLAY";

/* ===================================================================
 *  ST7789 command definitions
 * =================================================================== */

#define ST7789_SWRESET   0x01    /* Software reset             */
#define ST7789_SLPIN     0x10    /* Sleep in                   */
#define ST7789_SLPOUT    0x11    /* Sleep out                  */
#define ST7789_NORON     0x13    /* Normal display mode on     */
#define ST7789_INVOFF    0x20    /* Inversion off              */
#define ST7789_INVON     0x21    /* Inversion on               */
#define ST7789_DISPOFF   0x28    /* Display off                */
#define ST7789_DISPON    0x29    /* Display on                 */
#define ST7789_CASET     0x2A    /* Column address set         */
#define ST7789_RASET     0x2B    /* Row address set            */
#define ST7789_RAMWR     0x2C    /* Memory write               */
#define ST7789_MADCTL    0x36    /* Memory data access control */
#define ST7789_COLMOD    0x3A    /* Interface pixel format     */
#define ST7789_PORCTRL   0xB2    /* Porch setting              */
#define ST7789_GCTRL     0xB7    /* Gate control               */
#define ST7789_VCOMS     0xBB    /* VCOM setting               */
#define ST7789_LCMCTRL   0xC0    /* LCM control                */
#define ST7789_VDVVRHEN  0xC2    /* VDV and VRH command enable */
#define ST7789_VRHS      0xC3    /* VRH set                    */
#define ST7789_VDVSET    0xC4    /* VDV set                    */
#define ST7789_FRCTR2    0xC6    /* Frame rate control 2       */
#define ST7789_PWCTRL1   0xD0    /* Power control 1            */
#define ST7789_PVGAMCTRL 0xE0    /* Positive gamma correction  */
#define ST7789_NVGAMCTRL 0xE1    /* Negative gamma correction  */

/* SPI device handle */
static spi_device_handle_t s_spi;

/* ===================================================================
 *  Low-level SPI helpers
 * =================================================================== */

/** Send a single command byte (DC = 0). */
static void spi_send_cmd(uint8_t cmd)
{
    spi_transaction_t t = {};
    t.length    = 8;            /* 1 byte */
    t.tx_buffer = &cmd;
    gpio_set_level(LCD_DC, 0);  /* DC = 0 → command */
    spi_device_polling_transmit(s_spi, &t);
}

/** Send data bytes (DC = 1). */
static void spi_send_data(const uint8_t *data, int len)
{
    if (len <= 0) return;
    spi_transaction_t t = {};
    t.length    = len * 8;
    t.tx_buffer = data;
    gpio_set_level(LCD_DC, 1);  /* DC = 1 → data */
    spi_device_polling_transmit(s_spi, &t);
}

/** Send a command followed by parameter bytes. */
static void spi_send_cmd_data(uint8_t cmd, const uint8_t *data, int len)
{
    spi_send_cmd(cmd);
    spi_send_data(data, len);
}

/* ===================================================================
 *  ST7789 initialisation sequence
 * =================================================================== */

static void st7789_init(void)
{
    /* ---- Hardware reset ---- */
    gpio_set_level(LCD_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(100));
    gpio_set_level(LCD_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(100));

    /* ---- Software reset ---- */
    spi_send_cmd(ST7789_SWRESET);
    vTaskDelay(pdMS_TO_TICKS(150));

    /* ---- Sleep out ---- */
    spi_send_cmd(ST7789_SLPOUT);
    vTaskDelay(pdMS_TO_TICKS(500));

    /* ---- Porch control ---- */
    uint8_t porctrl[] = {0x0C, 0x0C, 0x00, 0x33, 0x33};
    spi_send_cmd_data(ST7789_PORCTRL, porctrl, sizeof(porctrl));

    /* ---- Gate control ---- */
    uint8_t gctrl[] = {0x35};
    spi_send_cmd_data(ST7789_GCTRL, gctrl, sizeof(gctrl));

    /* ---- VCOM setting ---- */
    uint8_t vcoms[] = {0x28};
    spi_send_cmd_data(ST7789_VCOMS, vcoms, sizeof(vcoms));

    /* ---- LCM control ---- */
    uint8_t lcmctrl[] = {0x0C};
    spi_send_cmd_data(ST7789_LCMCTRL, lcmctrl, sizeof(lcmctrl));

    /* ---- VDV and VRH command enable ---- */
    uint8_t vdvvrhen[] = {0x01};
    spi_send_cmd_data(ST7789_VDVVRHEN, vdvvrhen, sizeof(vdvvrhen));

    /* ---- VRH set ---- */
    uint8_t vrhs[] = {0x0B};
    spi_send_cmd_data(ST7789_VRHS, vrhs, sizeof(vrhs));

    /* ---- VDV set ---- */
    uint8_t vdvset[] = {0x20};
    spi_send_cmd_data(ST7789_VDVSET, vdvset, sizeof(vdvset));

    /* ---- Frame rate control ---- */
    uint8_t frctr2[] = {0x0F};
    spi_send_cmd_data(ST7789_FRCTR2, frctr2, sizeof(frctr2));

    /* ---- Power control 1 ---- */
    uint8_t pwctrl1[] = {0xA4, 0xA1};
    spi_send_cmd_data(ST7789_PWCTRL1, pwctrl1, sizeof(pwctrl1));

    /* ---- Positive gamma correction ---- */
    uint8_t pvgam[] = {
        0xD0, 0x08, 0x11, 0x08, 0x0C, 0x15, 0x39, 0x33,
        0x50, 0x36, 0x13, 0x14, 0x29, 0x2D
    };
    spi_send_cmd_data(ST7789_PVGAMCTRL, pvgam, sizeof(pvgam));

    /* ---- Negative gamma correction ---- */
    uint8_t nvgam[] = {
        0xD0, 0x08, 0x10, 0x08, 0x06, 0x06, 0x39, 0x44,
        0x51, 0x0B, 0x16, 0x14, 0x2F, 0x31
    };
    spi_send_cmd_data(ST7789_NVGAMCTRL, nvgam, sizeof(nvgam));

    /* ---- Inversion off ---- */
    spi_send_cmd(ST7789_INVOFF);

    /* ---- Memory access control (MADCTL) ----
     * MV=1, MX=0, MY=1 → 0xC0  (landscape orientation for 240x240)
     */
    uint8_t madctl[] = {0xC0};
    spi_send_cmd_data(ST7789_MADCTL, madctl, sizeof(madctl));

    /* ---- Pixel format: 16-bit RGB565 ---- */
    uint8_t colmod[] = {0x55};
    spi_send_cmd_data(ST7789_COLMOD, colmod, sizeof(colmod));

    /* ---- Normal display mode ---- */
    spi_send_cmd(ST7789_NORON);
    vTaskDelay(pdMS_TO_TICKS(10));

    /* ---- Display on ---- */
    spi_send_cmd(ST7789_DISPON);
    vTaskDelay(pdMS_TO_TICKS(10));

    ESP_LOGI(TAG, "ST7789 init sequence complete");
}

/* ===================================================================
 *  Public API
 * =================================================================== */

void display_set_window(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    /* Clamp to screen */
    if (x >= SCREEN_W || y >= SCREEN_H) return;
    if (x + w > SCREEN_W) w = SCREEN_W - x;
    if (y + h > SCREEN_H) h = SCREEN_H - y;
    if (w == 0 || h == 0) return;

    uint16_t x_end = x + w - 1;
    uint16_t y_end = y + h - 1;

    uint8_t xbuf[4] = {
        (uint8_t)((x >> 8) & 0xFF), (uint8_t)(x & 0xFF),
        (uint8_t)((x_end >> 8) & 0xFF), (uint8_t)(x_end & 0xFF),
    };
    uint8_t ybuf[4] = {
        (uint8_t)((y >> 8) & 0xFF), (uint8_t)(y & 0xFF),
        (uint8_t)((y_end >> 8) & 0xFF), (uint8_t)(y_end & 0xFF),
    };
    spi_send_cmd_data(ST7789_CASET, xbuf, 4);
    spi_send_cmd_data(ST7789_RASET, ybuf, 4);
    spi_send_cmd(ST7789_RAMWR);
}

esp_err_t display_init(void)
{
    ESP_LOGI(TAG, "Initialising SPI display (ST7789 240x240)...");

    /* ---- Configure control pins (DC, RST, BL) ---- */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << LCD_DC) | (1ULL << LCD_RST) | (1ULL << LCD_BL),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);

    /* ---- Initialise SPI bus ---- */
    spi_bus_config_t buscfg = {
        .mosi_io_num     = LCD_MOSI,
        .miso_io_num     = -1,
        .sclk_io_num     = LCD_SCLK,
        .quadwp_io_num   = -1,
        .quadhd_io_num   = -1,
        .max_transfer_sz = SCREEN_W * SCREEN_H * 2 + 8,
    };
    esp_err_t ret = spi_bus_initialize(LCD_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SPI bus init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* ---- Add SPI device ---- */
    spi_device_interface_config_t devcfg = {
        .clock_speed_hz = LCD_SPI_FREQ_HZ,
        .mode           = 0,                /* CPOL=0, CPHA=0 */
        .spics_io_num   = LCD_CS,
        .queue_size     = 6,
        .flags          = SPI_DEVICE_HALFDUPLEX,
    };
    ret = spi_bus_add_device(LCD_SPI_HOST, &devcfg, &s_spi);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SPI device add failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* ---- Backlight on ---- */
    display_set_backlight(true);

    /* ---- ST7789 init sequence ---- */
    st7789_init();

    /* ---- Clear screen ---- */
    display_fill_rect(0, 0, SCREEN_W, SCREEN_H, COLOR_BLACK);

    ESP_LOGI(TAG, "Display ready, SPI clock %d MHz", LCD_SPI_FREQ_HZ / 1000000);
    return ESP_OK;
}

void display_draw_bitmap(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                         const uint16_t *data)
{
    if (data == NULL) return;
    if (x >= SCREEN_W || y >= SCREEN_H) return;
    if (x + w > SCREEN_W) w = SCREEN_W - x;
    if (y + h > SCREEN_H) h = SCREEN_H - y;
    if (w == 0 || h == 0) return;

    display_set_window(x, y, w, h);

    /*
     * Transfer pixel data in chunks using a DMA-capable buffer.
     * The sprite data is already in big-endian format, so we copy
     * it verbatim — no per-pixel byte swap needed.
     */
    const int chunk_lines = 40;
    size_t chunk_bytes    = (size_t)w * chunk_lines * 2;
    uint8_t *dma_buf      = (uint8_t *)heap_caps_malloc(chunk_bytes,
                                                        MALLOC_CAP_DMA);

    if (dma_buf) {
        for (int row = 0; row < h; row += chunk_lines) {
            int lines = (row + chunk_lines <= h) ? chunk_lines : (h - row);
            size_t bytes = (size_t)w * lines * 2;
            memcpy(dma_buf, (const uint8_t *)(data + (size_t)row * w), bytes);

            spi_transaction_t t = {};
            t.length    = bytes * 8;
            t.tx_buffer = dma_buf;
            gpio_set_level(LCD_DC, 1);
            spi_device_polling_transmit(s_spi, &t);
        }
        free(dma_buf);
    } else {
        /*
         * Fallback: send directly from the source buffer.
         * The SPI driver will copy data to an internal DMA buffer.
         */
        size_t total_bytes = (size_t)w * h * 2;
        spi_transaction_t t = {};
        t.length    = total_bytes * 8;
        t.tx_buffer = data;
        gpio_set_level(LCD_DC, 1);
        spi_device_polling_transmit(s_spi, &t);
    }
}

void display_fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                       uint16_t color)
{
    if (x >= SCREEN_W || y >= SCREEN_H) return;
    if (x + w > SCREEN_W) w = SCREEN_W - x;
    if (y + h > SCREEN_H) h = SCREEN_H - y;
    if (w == 0 || h == 0) return;

    /* Allocate a single-line buffer (DMA-capable) */
    size_t line_bytes = (size_t)w * 2;
    uint16_t *line = (uint16_t *)heap_caps_malloc(line_bytes, MALLOC_CAP_DMA);
    if (!line) {
        line = (uint16_t *)malloc(line_bytes);
        if (!line) {
            ESP_LOGE(TAG, "fill_rect: malloc failed (%u bytes)", (unsigned)line_bytes);
            return;
        }
    }

    /* Fill the line with the byte-swapped colour */
    uint16_t swapped = BYTE_SWAP16(color);
    for (int i = 0; i < w; i++) {
        line[i] = swapped;
    }

    display_set_window(x, y, w, h);
    for (int row = 0; row < h; row++) {
        spi_transaction_t t = {};
        t.length    = line_bytes * 8;
        t.tx_buffer = line;
        gpio_set_level(LCD_DC, 1);
        spi_device_polling_transmit(s_spi, &t);
    }

    free(line);
}

void display_fill_ellipse(uint16_t cx, uint16_t cy, uint16_t rx, uint16_t ry,
                          uint16_t color)
{
    /* Degenerate cases */
    if (rx == 0 && ry == 0) {
        display_fill_rect(cx, cy, 1, 1, color);
        return;
    }
    if (rx == 0) {
        display_fill_rect(cx, (uint16_t)(cy > ry ? cy - ry : 0),
                          1, (uint16_t)(2 * ry + 1), color);
        return;
    }
    if (ry == 0) {
        display_fill_rect((uint16_t)(cx > rx ? cx - rx : 0), cy,
                          (uint16_t)(2 * rx + 1), 1, color);
        return;
    }

    /*
     * Midpoint ellipse algorithm.
     *
     * We compute the boundary in the first quadrant and record, for
     * each scan-line y ∈ [-ry, ry], the maximum |x| extent.  Then
     * each scan-line is filled as a single rectangle via
     * display_fill_rect().
     */

    int height = 2 * ry + 1;
    int *x_ext = (int *)malloc((size_t)height * sizeof(int));
    if (!x_ext) {
        ESP_LOGE(TAG, "fill_ellipse: malloc failed");
        return;
    }
    for (int i = 0; i < height; i++) x_ext[i] = -1;

    long rx2 = (long)rx * (long)rx;
    long ry2 = (long)ry * (long)ry;

    /* ---- Region 1 (upper portion, |slope| < 1) ---- */
    long x = 0;
    long y = (long)ry;
    long dx = 2 * ry2 * x;
    long dy = 2 * rx2 * y;
    long d1 = ry2 - rx2 * (long)ry + rx2 / 4;

    while (dx < dy) {
        /* Record x-extent for this y (and its mirror) */
        int yi_pos = (int)(y + ry);   /* index for +y */
        int yi_neg = (int)(-y + ry);  /* index for -y */
        if (yi_pos >= 0 && yi_pos < height && (int)x > x_ext[yi_pos])
            x_ext[yi_pos] = (int)x;
        if (yi_neg >= 0 && yi_neg < height && (int)x > x_ext[yi_neg])
            x_ext[yi_neg] = (int)x;

        if (d1 < 0) {
            x++;
            dx += 2 * ry2;
            d1 += dx + ry2;
        } else {
            x++;
            y--;
            dx += 2 * ry2;
            dy -= 2 * rx2;
            d1 += dx - dy + ry2;
        }
    }

    /* ---- Region 2 (lower portion, |slope| > 1) ---- */
    long d2 = (long)(ry2 * (x + 0.5) * (x + 0.5) +
                     rx2 * (y - 1) * (y - 1) - rx2 * ry2);

    while (y >= 0) {
        int yi_pos = (int)(y + ry);
        int yi_neg = (int)(-y + ry);
        if (yi_pos >= 0 && yi_pos < height && (int)x > x_ext[yi_pos])
            x_ext[yi_pos] = (int)x;
        if (yi_neg >= 0 && yi_neg < height && (int)x > x_ext[yi_neg])
            x_ext[yi_neg] = (int)x;

        if (d2 > 0) {
            y--;
            dy -= 2 * rx2;
            d2 += rx2 - dy;
        } else {
            y--;
            x++;
            dx += 2 * ry2;
            dy -= 2 * rx2;
            d2 += dx - dy + rx2;
        }
    }

    /* ---- Fill horizontal spans ---- */
    for (int yy = 0; yy < height; yy++) {
        if (x_ext[yy] < 0) continue;

        int py = (int)cy - (int)ry + yy;
        if (py < 0 || py >= SCREEN_H) continue;

        int half_w = x_ext[yy];
        int x0 = (int)cx - half_w;
        int x1 = (int)cx + half_w;
        if (x0 < 0) x0 = 0;
        if (x1 >= SCREEN_W) x1 = SCREEN_W - 1;
        int span_w = x1 - x0 + 1;
        if (span_w <= 0) continue;

        display_fill_rect((uint16_t)x0, (uint16_t)py,
                          (uint16_t)span_w, 1, color);
    }

    free(x_ext);
}

void display_set_backlight(bool on)
{
    gpio_set_level(LCD_BL, on ? 1 : 0);
}
