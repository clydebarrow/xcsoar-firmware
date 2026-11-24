# XCSoar firmware

A web page that installs XCSoar firmware on an M5Stack Tab5 or a LilyGO T-Display-P4 from Chrome or Edge, over
USB: https://clydebarrow.github.io/xcsoar-firmware/

The page reads the device name from the firmware on the board, so it offers the image for that model, and writes
the new image without erasing the rest of the flash: settings and saved Wi-Fi networks stay.

The images in `firmware/` are built by `xcsoar-tests/publish-firmware.py` in the `xcsoar` branch of
https://github.com/clydebarrow/esphome, which also writes `firmware/manifest.json`. They contain no Wi-Fi
credentials: a device joins the networks saved in XCSoar's Wi-Fi settings, those in the `wifi` list of `club.json`
on its SD card, and the glider's own SkyEcho.

`vendor/esptool-js-0.7.1` is [esptool-js](https://github.com/espressif/esptool-js) 0.7.1, Apache License 2.0.
