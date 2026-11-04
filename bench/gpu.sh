#!/bin/bash
# What the GPU machine does when it starts (bench.yml fills in BENCH_URL and
# TAB): Chrome on its NVIDIA GPU through Vulkan, on the game's `?bench`,
# drawing to a screen of its own (headless Chrome's GPU path is not the one
# players get). The run deletes the machine once the reports are in.
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -yq curl ca-certificates xvfb libvulkan1 vulkan-tools >/dev/null
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
apt-get install -yq /tmp/chrome.deb >/dev/null
# The container has the driver's libraries but not the loader's note of them.
[ -e /etc/vulkan/icd.d/nvidia_icd.json ] || { mkdir -p /etc/vulkan/icd.d; echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' > /etc/vulkan/icd.d/nvidia_icd.json; }
nvidia-smi -L
vulkaninfo --summary 2>&1 | grep -i devicename
xvfb-run -s "-screen 0 1600x1000x24" google-chrome --no-sandbox --no-first-run --user-data-dir=/tmp/c \
  --enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE --use-angle=vulkan --ignore-gpu-blocklist \
  --window-size=1600,1000 "BENCH_URL&tab=TAB"
sleep infinity
