/**
 * @file wifi.h
 * @brief WiFi connection management — STA mode + AP provisioning mode
 *
 * ESP32-S3 WiFi with auto-reconnect and AP provisioning support.
 */
#ifndef WIFI_H
#define WIFI_H

#include <stdint.h>
#include <stdbool.h>

/**
 * @brief Connect to WiFi in STA mode
 *
 * Initializes NVS, netif, event loop, event group, and WiFi driver,
 * then connects to the specified network. Blocks until connected or
 * timeout (15 seconds).
 *
 * @param ssid WiFi network name
 * @param password WiFi password (empty string for open networks)
 */
void wifi_init(const char *ssid, const char *password);

/**
 * @brief Check if WiFi is connected
 * @return true if connected, false otherwise
 */
bool wifi_is_connected(void);

/**
 * @brief Start AP mode for provisioning
 *
 * Starts a softAP with the given SSID for captive portal provisioning.
 * Clients can connect to configure WiFi credentials.
 *
 * @param ssid AP hotspot name
 */
void wifi_start_ap(const char *ssid);

#endif /* WIFI_H */
