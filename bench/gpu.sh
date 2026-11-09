#!/bin/bash
# What the GPU machine does when it starts (bench.yml hands it the page as
# PAGE): Chrome on its NVIDIA GPU through Vulkan, on the game's `?bench`,
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
# SCREEN: the window in CSS pixels and the device's pixel ratio, 1600x1000@1
# a laptop's, 412x915@2.625 a phone's.
size=${SCREEN:-1600x1000@1}; dpr=${size#*@}; size=${size%@*}; w=${size%x*}; h=${size#*x}
xw=$(awk "BEGIN { print int($w * $dpr) }"); xh=$(awk "BEGIN { print int($h * $dpr) }")
# CPU: the tab's main thread slowed that many times, as DevTools does it
# (Emulation.setCPUThrottlingRate), for a phone's JavaScript on a desktop's
# GPU. The throttle lasts as long as the session that set it: held open.
[ -n "${CPU:-}" ] && apt-get install -yq python3 python3-websocket >/dev/null
xvfb-run -s "-screen 0 ${xw}x${xh}x24" google-chrome --no-sandbox --no-first-run --user-data-dir=/tmp/c \
  --enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE --use-angle=vulkan --ignore-gpu-blocklist \
  ${CPU:+--remote-debugging-port=9222 --remote-allow-origins=*} \
  --force-device-scale-factor=$dpr --window-size=$w,$h "$PAGE" &
[ -n "${CPU:-}" ] && python3 - <<'PY'
import json, os, time, urllib.request, websocket
while True:
    try:
        pages = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:9222/json")) if t["type"] == "page"]
        if pages: break
    except Exception: pass
    time.sleep(1)
ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"])
ws.send(json.dumps({"id": 1, "method": "Emulation.setCPUThrottlingRate", "params": {"rate": float(os.environ["CPU"])}}))
print("CPU throttled", os.environ["CPU"], ws.recv(), flush=True)
while True: ws.recv()
PY
sleep infinity
