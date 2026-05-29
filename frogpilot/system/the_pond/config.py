#!/usr/bin/env python3

# The Pond serves on 8082 on-device and 8083 in PC/debug mode (REWRITE_PLAN §2, §5.1).
DEBUG_PORT = 8083
DEVICE_PORT = 8082

# Endpoints that stay reachable while the car is onroad, so the browser can still load the app shell
# and poll for the driving state; the onroad gate rejects every other endpoint (REWRITE_PLAN §6).
ESSENTIAL_ENDPOINTS = frozenset({"health.read_status", "index", "static"})

# The hevc file each camera angle records to inside a route segment (REWRITE_PLAN §4.3, §12.3). One
# source of truth shared by the recordings views and the dashcam video feature.
CAMERA_FILES = {
  "driver": "dcamera.hevc",
  "forward": "fcamera.hevc",
  "wide": "ecamera.hevc",
}

GIF_EXTENSION = ".gif"
THUMBNAIL_EXTENSION = ".png"
VIDEO_EXTENSION = ".mp4"

# preview.gif plays the clip back sped up so several seconds loop into one glanceable hover thumbnail.
# 35x carries over the original pipeline's setpts=PTS/35 (REWRITE_PLAN §12.3): the proven factor that
# turns a multi-second segment into roughly a one-second loop while keeping enough frames for the motion
# to stay readable.
PREVIEW_GIF_SPEEDUP = 35
