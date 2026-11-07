#pragma once

// Copy this file to include/secrets.h. secrets.h is not committed.
//
// RELAY_HOST is the laptop address the badge can open on the LAN.
// The relay listens on 0.0.0.0 port 8787 (`npm start` in relay/).
// On WSL that socket is inside the VM until Windows forwards the port.
// Use the Windows LAN address the board can actually reach.

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"
#define RELAY_HOST "192.168.1.20"
#define RELAY_PORT 8787
