# ============================================================
# main 组件构建配置
# ============================================================
idf_component_register(SRCS "main.c" "display.c" "sprites.c" "animation.c" "audio.c" "network.c" "wifi.c"
                       INCLUDE_DIRS "."
                       REQUIRES driver esp_http_client esp_wifi esp_timer nvs_flash esp_event esp_netif json)
