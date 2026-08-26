import server

# Test cache Hermes (prioritaire)
print("nemotron-3-super (double prefix):", server._fetch_model_specs("omni-route", "nvidia/nvidia/nemotron-3-super-120b-a12b"))
print("nemotron-3-ultra-550b (openrouter):", server._fetch_model_specs("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"))
print("poolside laguna (nous):", server._fetch_model_specs("nous", "poolside/laguna-s-2.1:free"))
print("hy3 (tencent):", server._fetch_model_specs("nous", "tencent/hy3:free"))
print("freellmapi glm (pas dans Hermes cache?):", server._fetch_model_specs("freellmapi", "glm-4.5-flash"))
