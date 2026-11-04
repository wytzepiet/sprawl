#!/bin/bash
# What the GPU VM does on boot (bench.yml fills in BENCH_URL and TAB): Chrome,
# headless, on the machine's NVIDIA GPU through Vulkan, on the game's
# `?bench`; then it powers off, and so is gone (it was started to terminate
# on shutdown). Whatever happens, it is gone in twenty minutes.
shutdown -h +20
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
apt-get update -q && apt-get install -yq /tmp/chrome.deb libvulkan1 vulkan-tools xvfb
nvidia-smi -L
vulkaninfo --summary 2>&1 | head -30
# A screen of its own: headless Chrome's own GPU path is not the one players get.
xvfb-run -s "-screen 0 1600x1000x24" google-chrome --no-sandbox --no-first-run --user-data-dir=/tmp/c \
  --enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE --use-angle=vulkan --ignore-gpu-blocklist \
  --window-size=1600,1000 "BENCH_URL&tab=TAB" &
sleep 120
shutdown -h now
